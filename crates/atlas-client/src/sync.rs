//! One sync cycle (`sync-client.ts`, without realtime or persistence): push the outbox, bootstrap
//! from the snapshot when there is no cursor, pull after the cursor, then write the repairs.

use atlas_core::Operation;
use uuid::Uuid;

use crate::api::{ApiClient, Page};
use crate::crypto::Keyring;
use crate::error::{Error, Result};
use crate::scope::{apply_repairs, confirm_repairs, Repair};
use crate::store::Store;

/// Ops per push request.
pub const MAX_PUSH_OPS: usize = 500;
/// Estimated bytes per push request (the server's cap is 2 MiB by default).
pub const MAX_PUSH_BYTES: usize = 1536 * 1024;

#[derive(Debug, Clone, Default)]
pub struct SyncResult {
    pub pushed: usize,
    pub pulled: usize,
    pub cursor: u64,
    pub deferred: usize,
    pub repaired: usize,
}

/// A local op the server refused for good, taken back (`onQuarantine`).
#[derive(Debug, Clone)]
pub struct Quarantined {
    pub op: Operation,
    pub error: String,
}

/// The context a cycle runs in: the API, the store and the keys, and whose session it is.
pub struct SyncContext<'a> {
    pub api: &'a ApiClient,
    pub store: &'a mut Store,
    pub keyring: &'a Keyring,
    pub user_id: Option<&'a str>,
}

pub struct SyncClient {
    cursor: u64,
    needs_bootstrap: bool,
    first_cycle_done: bool,
    deferred: Vec<Uuid>,
    cycle_repairs: Vec<Repair>,
    walk_repairs: Vec<Repair>,
    walk_finished: bool,
    clock_skew: Option<i64>,
    pub quarantined: Vec<Quarantined>,
}

fn estimate_wire_bytes(op: &Operation) -> usize {
    (serde_json::to_vec(op).map(|v| v.len()).unwrap_or(0) * 4).div_ceil(3) + 256
}

fn is_clock_skew(err: &Error) -> bool {
    err.status() == Some(400) && err.api_code() == Some("clock_skew")
}

fn is_permanent_push_error(err: &Error) -> bool {
    !is_clock_skew(err) && matches!(err.status(), Some(400 | 403 | 422))
}

fn is_cursor_expired(err: &Error) -> bool {
    err.status() == Some(410) && matches!(err.api_code(), None | Some("cursor_expired"))
}

impl SyncClient {
    pub fn new(cursor: u64) -> Self {
        Self {
            cursor,
            needs_bootstrap: cursor == 0,
            first_cycle_done: false,
            deferred: Vec::new(),
            cycle_repairs: Vec::new(),
            walk_repairs: Vec::new(),
            walk_finished: false,
            clock_skew: None,
            quarantined: Vec::new(),
        }
    }

    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn deferred_count(&self) -> usize {
        self.deferred.len()
    }

    pub fn clock_skew_ms(&self) -> Option<i64> {
        self.clock_skew
    }

    pub fn sync(&mut self, cx: &mut SyncContext<'_>) -> Result<SyncResult> {
        let unsynced = cx.store.unsynced_ops();
        self.cycle_repairs.clear();
        if !unsynced.is_empty() {
            self.push_outbox(cx, unsynced.clone())?;
        }
        let pulled = match self.pull_phase(cx) {
            Err(e) if is_cursor_expired(&e) => {
                // Ops this device never received were purged: rebuild from the snapshot.
                self.cursor = 0;
                self.needs_bootstrap = true;
                self.walk_repairs.clear();
                self.walk_finished = false;
                cx.store.reset_synced();
                self.pull_phase(cx)?
            }
            other => other?,
        };
        let repairs = if self.walk_finished {
            self.walk_finished = false;
            let mut all = std::mem::take(&mut self.walk_repairs);
            all.append(&mut self.cycle_repairs);
            all
        } else {
            std::mem::take(&mut self.cycle_repairs)
        };
        let repaired = self.apply_repairs(cx, repairs);
        if repaired > 0 {
            let ops = cx.store.unsynced_ops();
            self.push_outbox(cx, ops)?;
        }
        self.first_cycle_done = true;
        Ok(SyncResult {
            pushed: unsynced.len(),
            pulled,
            cursor: self.cursor,
            deferred: self.deferred.len(),
            repaired,
        })
    }

    fn apply_repairs(&self, cx: &mut SyncContext<'_>, repairs: Vec<Repair>) -> usize {
        if repairs.is_empty() || !cx.keyring.has_keys() {
            return 0;
        }
        let confirmed = confirm_repairs(cx.store, cx.keyring, cx.user_id, repairs);
        apply_repairs(cx.store, &confirmed)
    }

    fn pull_phase(&mut self, cx: &mut SyncContext<'_>) -> Result<usize> {
        if self.needs_bootstrap {
            if let Some(replayed) = self.bootstrap_from_snapshot(cx)? {
                return Ok(replayed);
            }
        }
        // After a bootstrap this is the overlap pass from the walk's pinned cursor: it re-delivers
        // what was committed while the pages streamed.
        let since = self.cursor;
        let (ops, cursor) = self.pull_all(cx, since)?;
        // An orphaned cursor (state lost, cursor kept): rebuild, on the first cycle only.
        if !self.first_cycle_done && since > 0 && ops.is_empty() && cx.store.is_empty() {
            if let Some(replayed) = self.bootstrap_from_snapshot(cx)? {
                return Ok(replayed);
            }
            let since = self.cursor;
            let (healed, cursor) = self.pull_all(cx, since)?;
            self.apply_remote_ops(cx, &healed, Some(since), cursor);
            return Ok(healed.len());
        }
        self.apply_remote_ops(cx, &ops, Some(since), cursor);
        Ok(ops.len())
    }

    /// Merge `ops` and move the cursor when they follow on from it.
    fn apply_remote_ops(
        &mut self,
        cx: &mut SyncContext<'_>,
        ops: &[Operation],
        from: Option<u64>,
        cursor: u64,
    ) -> bool {
        if !ops.is_empty() {
            cx.store.apply_remote_batch(ops);
        }
        match from {
            Some(from) if self.cursor >= from => {
                if cursor > self.cursor {
                    self.cursor = cursor;
                }
                true
            }
            _ => false,
        }
    }

    fn pull_all(&mut self, cx: &mut SyncContext<'_>, since: u64) -> Result<(Vec<Operation>, u64)> {
        let mut ops = Vec::new();
        let mut cursor = since;
        loop {
            let page = match cx.api.sync_pull(cx.store, cx.keyring, cursor) {
                Ok(p) => p,
                Err(e) => {
                    // Keep the pages that did arrive: the next cycle continues after them.
                    if !ops.is_empty() {
                        self.apply_remote_ops(cx, &ops, Some(since), cursor);
                    }
                    return Err(e);
                }
            };
            let Page {
                operations,
                cursor: next,
                repairs,
                ..
            } = page;
            let count = operations.len();
            ops.extend(operations);
            self.cycle_repairs.extend(repairs);
            let advanced = next != cursor;
            if advanced {
                cursor = next;
            }
            if count == 0 || !advanced {
                break;
            }
        }
        Ok((ops, cursor))
    }

    /// Walk the snapshot; the cursor moves to the walk's pinned cursor after the last page.
    /// `Some(n)` when the server has no snapshot and the whole log was replayed instead.
    fn bootstrap_from_snapshot(&mut self, cx: &mut SyncContext<'_>) -> Result<Option<usize>> {
        let mut next: Option<String> = None;
        let mut pinned: Option<u64> = None;
        loop {
            let page = match cx.api.sync_snapshot(cx.store, cx.keyring, next.as_deref()) {
                Ok(p) => p,
                Err(e) if e.status() == Some(404) => {
                    // A server without the snapshot: replay the whole log instead.
                    self.walk_repairs.clear();
                    let (ops, cursor) = self.pull_all(cx, 0)?;
                    cx.store.apply_remote_batch(&ops);
                    self.cursor = cursor;
                    self.needs_bootstrap = false;
                    return Ok(Some(ops.len()));
                }
                Err(e) if next.is_some() && e.status() == Some(400) => {
                    // The resume token went bad: start the walk over.
                    next = None;
                    pinned = None;
                    self.walk_repairs.clear();
                    continue;
                }
                Err(e) => return Err(e),
            };
            self.walk_repairs.extend(page.repairs);
            if !page.operations.is_empty() {
                cx.store.apply_remote_batch(&page.operations);
            }
            pinned = Some(pinned.map_or(page.cursor, |p| p.min(page.cursor)));
            match page.next {
                Some(n) => next = Some(n),
                None => break,
            }
        }
        self.cursor = pinned.unwrap_or(0);
        self.walk_finished = true;
        self.needs_bootstrap = false;
        Ok(None)
    }

    fn push_outbox(&mut self, cx: &mut SyncContext<'_>, mut ops: Vec<Operation>) -> Result<()> {
        self.deferred.clear();
        let mut retried = false;
        loop {
            match self.push_batches(cx, &ops) {
                Ok(()) => break,
                Err(e) if is_clock_skew(&e) => {
                    let server_time = match &e {
                        Error::Api { data: Some(d), .. } => {
                            d.get("server_time").and_then(|v| v.as_u64())
                        }
                        _ => None,
                    };
                    let Some(server_time) = server_time else {
                        return Ok(());
                    };
                    self.clock_skew = Some(cx.store.align_clock(server_time));
                    if retried || cx.store.restamp_ahead(server_time) == 0 {
                        return Ok(());
                    }
                    retried = true;
                    ops = cx
                        .store
                        .unsynced_ops()
                        .into_iter()
                        .filter(|o| !self.deferred.contains(&o.id))
                        .collect();
                }
                Err(e) => return Err(e),
            }
        }
        if !ops.is_empty() {
            self.clock_skew = None;
        }
        Ok(())
    }

    fn push_batches(&mut self, cx: &mut SyncContext<'_>, ops: &[Operation]) -> Result<()> {
        let mut batch: Vec<Operation> = Vec::new();
        let mut bytes = 0;
        for op in ops {
            let size = estimate_wire_bytes(op);
            if !batch.is_empty() && (batch.len() >= MAX_PUSH_OPS || bytes + size > MAX_PUSH_BYTES) {
                self.push_batch(cx, &std::mem::take(&mut batch))?;
                bytes = 0;
            }
            batch.push(op.clone());
            bytes += size;
        }
        self.push_batch(cx, &batch)
    }

    /// A permanent refusal or a 413 bisects the batch to isolate the op, which is taken back.
    fn push_batch(&mut self, cx: &mut SyncContext<'_>, ops: &[Operation]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        match cx.api.sync_push(cx.store, cx.keyring, ops) {
            Ok(res) => {
                self.deferred.extend(res.deferred.iter().copied());
                let done: Vec<Uuid> = ops
                    .iter()
                    .map(|o| o.id)
                    .filter(|id| !res.deferred.contains(id))
                    .collect();
                cx.store.mark_synced(&done);
                if let Some(from) = res.from {
                    if self.cursor >= from && res.cursor > self.cursor {
                        self.cursor = res.cursor;
                    }
                }
                Ok(())
            }
            Err(e) => {
                let too_large = e.status() == Some(413);
                if !too_large && !is_permanent_push_error(&e) {
                    return Err(e);
                }
                if ops.len() == 1 {
                    cx.store.discard(&[ops[0].id]);
                    self.quarantined.push(Quarantined {
                        op: ops[0].clone(),
                        error: e.to_string(),
                    });
                    return Ok(());
                }
                let mid = ops.len() / 2;
                self.push_batch(cx, &ops[..mid])?;
                self.push_batch(cx, &ops[mid..])
            }
        }
    }
}
