//! Sync endpoints: the server side of offline-first replication.
//!
//! Clients push batches of [`WireOperation`]s and pull ops after a `server_seq` cursor. Pushed
//! ops are folded into LWW state (`entity_fields` + `entity_tombstones`) per user partition, and
//! fanned out to co-members of shared projects. Since protocol 7 an op names a wire kind, the
//! scope (project) whose key encrypted it and an opaque field tag
//! (`docs/decisions/0006-opaque-sync-metadata.md`); the server routes by scope and never learns
//! the real kind or field. Rows written before it (legacy kinds) stay readable, are refused on
//! push and are dropped by their clients through `POST /sync/legacy/drop` ([`legacy`]). All sync writes serialize on
//! [`SYNC_WRITE_LOCK`] so a cursor never skips an in-flight seq. Partition and lock design are
//! in `docs/architecture.md`.
//!
//! This module holds the routes, the protocol gate and what the parts share; the parts are:
//! - [`hub`]: per-user live channels, the open-socket registry and socket tickets.
//! - [`ws`]: `POST /sync/ws-ticket` and the `GET /sync/ws` live stream.
//! - [`push`]: `POST /sync/push`, its validation, authorization and fan-out.
//! - [`apply`]: the shared write path folding ops into partitions, and server-authored ops.
//! - [`pull`]: `GET /sync/pull` and the op-log pages the socket backfill reuses.
//! - [`snapshot`]: `GET /sync/snapshot` and the materialized-state reads behind the export.
//! - [`revoke`]: tombstoning a project out of a partition whose member left.
//! - [`backfill`]: copying a shared project into a new member's partition on accept.
//! - [`legacy`]: `GET /sync/legacy/keys` and `POST /sync/legacy/drop`, a client listing and dropping
//!   the rows it migrated.

use std::sync::PoisonError;
use std::time::{SystemTime, UNIX_EPOCH};

use atlas_core::{Hlc, WireKind, WireOperation};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

mod apply;
mod backfill;
mod hub;
mod legacy;
mod pull;
mod push;
mod revoke;
mod snapshot;
mod ws;

pub use hub::SyncHub;
pub use pull::PullQuery;
pub use push::{PushRequest, PushResponse};
pub use revoke::revoke_left_projects;
pub use snapshot::{SnapshotQuery, SnapshotResponse};
pub use ws::{close_code, WsParams, WsTicketResponse};

pub(crate) use apply::{
    apply_to_members, apply_to_partitions, deliver_to_members, member_delete_op, member_set_ops,
    publish_batches,
};
pub(crate) use backfill::{accept_backfill_ops, BackfillRead};
pub(crate) use revoke::revoke_project;
pub(crate) use snapshot::partition_ops;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sync/push", post(push::push))
        .route("/sync/pull", get(pull::pull))
        .route("/sync/snapshot", get(snapshot::snapshot))
        .route("/sync/ws-ticket", post(ws::ws_ticket))
        .route("/sync/ws", get(ws::ws_handler))
        .route("/sync/legacy/keys", get(legacy::keys))
        .route("/sync/legacy/drop", post(legacy::drop))
}

/// The oldest client sync protocol the server accepts; older builds are refused with 426.
/// Builds below 3 fork a project's encryption keys, below 4 cannot open `__enc: 2` fields,
/// below 5 put the access token in the socket URL, below 6 would keep writing under a key a
/// rotation retired, and below 7 send plaintext routing fields and field names. History in
/// `docs/architecture.md`.
pub const MIN_SYNC_PROTOCOL: u32 = 7;

/// The newest sync protocol this server speaks, announced by `GET /discovery` so a client can
/// tell a server too old for it before signing in. A server predating discovery counts as 1.
pub const SYNC_PROTOCOL: u32 = 7;

/// Header carrying the client's sync protocol version on every `/sync/*` HTTP request.
pub const SYNC_PROTOCOL_HEADER: &str = "x-atlas-sync-protocol";

/// Middleware answering `426 Upgrade Required` unless the client declares a protocol of at least
/// [`MIN_SYNC_PROTOCOL`]; a missing or unparsable version counts as outdated.
pub async fn require_sync_protocol(req: axum::extract::Request, next: Next) -> Response {
    match client_sync_protocol(req.headers(), req.uri()) {
        Some(v) if v >= MIN_SYNC_PROTOCOL => next.run(req).await,
        _ => (
            StatusCode::UPGRADE_REQUIRED,
            Json(json!({
                "error": "client update required",
                "code": "upgrade_required",
                "min_protocol": MIN_SYNC_PROTOCOL,
            })),
        )
            .into_response(),
    }
}

/// The declared protocol: the header, or on the WebSocket handshake the `protocol` query param
/// (browsers cannot set headers there).
fn client_sync_protocol(headers: &HeaderMap, uri: &Uri) -> Option<u32> {
    if let Some(v) = headers.get(SYNC_PROTOCOL_HEADER) {
        return v.to_str().ok()?.trim().parse().ok();
    }
    if uri.path().ends_with("/sync/ws") {
        return uri
            .query()?
            .split('&')
            .find_map(|kv| kv.strip_prefix("protocol="))?
            .parse()
            .ok();
    }
    None
}

/// A sync failure: an ordinary [`AppError`], or a coded answer a client branches on.
#[derive(Debug)]
pub enum SyncError {
    App(AppError),
    /// `410 {"code":"cursor_expired"}`: retention purged ops after the client's cursor; the
    /// client re-bootstraps from `GET /sync/snapshot`.
    CursorExpired,
    /// `400 {"code":"clock_skew","server_time":<ms>}`: an op's HLC wall clock is further ahead
    /// than [`MAX_FUTURE_SKEW_MS`]. Transient, so the batch must not be discarded.
    ClockSkew {
        server_time: i64,
    },
}

impl From<AppError> for SyncError {
    fn from(e: AppError) -> Self {
        SyncError::App(e)
    }
}

impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        SyncError::App(e.into())
    }
}

impl IntoResponse for SyncError {
    fn into_response(self) -> Response {
        match self {
            SyncError::App(e) => e.into_response(),
            SyncError::CursorExpired => (
                StatusCode::GONE,
                Json(json!({
                    "error": "cursor predates purged operations; bootstrap from the snapshot",
                    "code": "cursor_expired",
                })),
            )
                .into_response(),
            SyncError::ClockSkew { server_time } => (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "hlc wall_ms too far in the future",
                    "code": "clock_skew",
                    "server_time": server_time,
                })),
            )
                .into_response(),
        }
    }
}

type SyncResult<T> = Result<T, SyncError>;

/// Advisory-lock key serializing every sync-write transaction (pushes, server-authored
/// fan-out, retention's tombstone purge). Allocation order of `server_seq` must equal commit
/// order or a cursor can skip a seq; see `docs/architecture.md`. The halves spell `atla` /
/// `s_sy`. Reserved for this purpose.
const SYNC_WRITE_LOCK: (i32, i32) = (0x6174_6C61, 0x735F_7379);

/// Take [`SYNC_WRITE_LOCK`] for the rest of the transaction. Every transaction that inserts into
/// `operations` takes it before its first read of sync state (see `members::accept_invite`).
pub(crate) async fn take_sync_write_lock(tx: &mut Transaction<'_, Postgres>) -> AppResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(SYNC_WRITE_LOCK.0)
        .bind(SYNC_WRITE_LOCK.1)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// How long a sync write waits for its turn before it is refused with 429.
const SYNC_WRITE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// One in-process turn for [`SYNC_WRITE_LOCK`]. The advisory lock serializes sync writes
/// anyway; waiting for the turn here, before a pool connection is checked out, keeps waiters from
/// holding the pool's connections, which every other request needs.
fn sync_write_turns() -> &'static tokio::sync::Semaphore {
    static TURNS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    TURNS.get_or_init(|| tokio::sync::Semaphore::new(1))
}

type UserQueues = std::collections::HashMap<Uuid, std::sync::Arc<tokio::sync::Semaphore>>;

/// One queue per user with writes in flight, so one account's writes wait behind each other and
/// at most one of them competes for the turn: a busy account cannot crowd out the others.
fn user_queues() -> &'static std::sync::Mutex<UserQueues> {
    static QUEUES: std::sync::OnceLock<std::sync::Mutex<UserQueues>> = std::sync::OnceLock::new();
    QUEUES.get_or_init(Default::default)
}

fn lock_queues() -> std::sync::MutexGuard<'static, UserQueues> {
    user_queues()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A user's place at the head of their queue; released (and the queue dropped when idle) on drop.
struct UserSlot {
    user: Uuid,
    queue: std::sync::Arc<tokio::sync::Semaphore>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

impl UserSlot {
    async fn take(user: Uuid) -> AppResult<Self> {
        let queue = lock_queues()
            .entry(user)
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
            .clone();
        let mut slot = Self {
            user,
            queue,
            permit: None,
        };
        let permit = tokio::time::timeout(SYNC_WRITE_WAIT, slot.queue.clone().acquire_owned())
            .await
            .map_err(|_| AppError::TooManyRequests)?
            .map_err(|_| AppError::Internal)?;
        slot.permit = Some(permit);
        Ok(slot)
    }
}

impl Drop for UserSlot {
    fn drop(&mut self) {
        let mut queues = lock_queues();
        self.permit.take();
        // The map's handle plus ours: nobody else holds or waits in this queue.
        if std::sync::Arc::strong_count(&self.queue) == 2 {
            queues.remove(&self.user);
        }
    }
}

async fn take_turn() -> AppResult<tokio::sync::SemaphorePermit<'static>> {
    tokio::time::timeout(SYNC_WRITE_WAIT, sync_write_turns().acquire())
        .await
        .map_err(|_| AppError::TooManyRequests)?
        .map_err(|_| AppError::Internal)
}

/// A sync-write transaction together with its turn. It derefs to the transaction; the turn is
/// released when it commits or is dropped (rolled back), never earlier.
pub(crate) struct SyncTx {
    tx: Transaction<'static, Postgres>,
    // Dropped after `tx` (fields drop in order): the turn outlives the transaction.
    turn: Option<tokio::sync::SemaphorePermit<'static>>,
    _slot: Option<UserSlot>,
}

impl SyncTx {
    /// Begin a transaction that does not hold [`SYNC_WRITE_LOCK`] yet; [`SyncTx::lock`] takes it
    /// (and the turn) before its first read of sync state. `user` is the requester of a
    /// user-driven write (queued per user), `None` for server-side work.
    pub(crate) async fn begin_unlocked(pool: &sqlx::PgPool, user: Option<Uuid>) -> AppResult<Self> {
        let slot = match user {
            Some(user) => Some(UserSlot::take(user).await?),
            None => None,
        };
        Ok(Self {
            tx: pool.begin().await?,
            turn: None,
            _slot: slot,
        })
    }

    /// Take the turn (at most [`SYNC_WRITE_WAIT`]) and [`SYNC_WRITE_LOCK`].
    pub(crate) async fn lock(&mut self) -> AppResult<()> {
        if self.turn.is_none() {
            self.turn = Some(take_turn().await?);
        }
        take_sync_write_lock(&mut self.tx).await
    }

    pub(crate) async fn commit(self) -> AppResult<()> {
        let Self { tx, turn, _slot } = self;
        tx.commit().await?;
        drop(turn);
        Ok(())
    }
}

impl std::ops::Deref for SyncTx {
    type Target = Transaction<'static, Postgres>;
    fn deref(&self) -> &Self::Target {
        &self.tx
    }
}

impl std::ops::DerefMut for SyncTx {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.tx
    }
}

/// Begin a transaction that may insert into `operations`, holding [`SYNC_WRITE_LOCK`]. The turn
/// is taken before a pool connection is checked out. `user` as for [`SyncTx::begin_unlocked`].
pub(crate) async fn begin_sync_write(pool: &sqlx::PgPool, user: Option<Uuid>) -> AppResult<SyncTx> {
    let slot = match user {
        Some(user) => Some(UserSlot::take(user).await?),
        None => None,
    };
    let turn = take_turn().await?;
    let mut tx = pool.begin().await?;
    take_sync_write_lock(&mut tx).await?;
    Ok(SyncTx {
        tx,
        turn: Some(turn),
        _slot: slot,
    })
}

/// The pull-shaped payload of `/sync/pull`, every WebSocket message and every live push: all of
/// the partition's ops with `from < server_seq <= cursor`. A client whose cursor is at least
/// `from` applies it; one below `from` has a gap and pulls from its own cursor.
#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub operations: Vec<WireOperation>,
    /// Cursor to pass as `since` on the next pull.
    pub cursor: i64,
    /// The partition's newest `server_seq` before these ops.
    pub from: i64,
}

fn entity_str(kind: WireKind) -> &'static str {
    kind.as_str()
}

fn entity_from_str(s: &str) -> AppResult<WireKind> {
    WireKind::from_wire(s).ok_or_else(|| AppError::BadRequest(format!("unknown entity kind: {s}")))
}

type HlcKey = (i64, i32, Uuid);

fn hlc_key(ts: &Hlc) -> AppResult<HlcKey> {
    let wall = i64::try_from(ts.wall_ms)
        .map_err(|_| AppError::BadRequest("hlc wall_ms too large".into()))?;
    let counter = i32::try_from(ts.counter)
        .map_err(|_| AppError::BadRequest("hlc counter too large".into()))?;
    Ok((wall, counter, ts.node))
}

/// An `(entity, entity_id)` pair naming one entity in a partition.
type EntityKey = (String, Uuid);

/// Maximum future clock skew tolerated on a client HLC wall clock (5 minutes). Offline edits
/// carry past timestamps; an unbounded-future `wall_ms` would win field-level LWW permanently.
/// Server-authored ops observe stored stamps only up to it too ([`cap_future_skew`]).
const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

fn physical_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn server_ts(state: &AppState) -> Hlc {
    state
        .clock
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .now(physical_now_ms())
}

/// `ts`, or the latest instant [`MAX_FUTURE_SKEW_MS`] ahead of `now_ms` when `ts` is further out.
fn cap_future_skew(ts: Hlc, now_ms: u64) -> Hlc {
    let limit = now_ms.saturating_add(MAX_FUTURE_SKEW_MS as u64);
    if ts.wall_ms > limit {
        Hlc {
            wall_ms: limit,
            counter: 0,
            node: Uuid::nil(),
        }
    } else {
        ts
    }
}

fn observe_client_ts(state: &AppState, ts: Hlc) {
    state
        .clock
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .update(ts, physical_now_ms());
}

/// The smallest HLC above `ts`, the node read as a 128-bit integer (the client's `successorHlc`).
fn successor_hlc(ts: Hlc) -> Hlc {
    match ts.node.as_u128().checked_add(1) {
        Some(node) => Hlc {
            node: Uuid::from_u128(node),
            ..ts
        },
        None => Hlc {
            counter: ts.counter.saturating_add(1),
            node: Uuid::nil(),
            ..ts
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_protocol_is_read_from_the_header_or_the_ws_query() {
        let parse = |header: Option<&str>, uri: &str| {
            let mut headers = HeaderMap::new();
            if let Some(h) = header {
                headers.insert(SYNC_PROTOCOL_HEADER, h.parse().unwrap());
            }
            client_sync_protocol(&headers, &uri.parse().unwrap())
        };
        assert_eq!(parse(Some("2"), "/sync/push"), Some(2));
        assert_eq!(parse(Some("x"), "/sync/push"), None);
        assert_eq!(
            parse(None, "/sync/pull?protocol=2"),
            None,
            "query only on ws"
        );
        assert_eq!(parse(None, "/sync/ws?ticket=t&protocol=3"), Some(3));
        assert_eq!(parse(None, "/sync/ws?protocol=2&ticket=t"), Some(2));
        assert_eq!(parse(None, "/sync/ws?xprotocol=9&ticket=t"), None);
        assert_eq!(parse(None, "/sync/ws?ticket=t"), None);
        assert_eq!(parse(None, "/sync/ws"), None);
    }
}

#[cfg(test)]
mod sync_write_tests {
    use super::*;

    #[tokio::test]
    async fn one_users_writes_queue_behind_each_other_not_others() {
        let user = Uuid::now_v7();
        let first = UserSlot::take(user).await.unwrap();
        // The same user's next write waits; another user's does not.
        let waiting = tokio::spawn(UserSlot::take(user));
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        let _other = UserSlot::take(Uuid::now_v7()).await.unwrap();
        drop(first);
        let second = waiting.await.unwrap().unwrap();
        drop(second);
        // An idle user's queue is dropped.
        assert!(!lock_queues().contains_key(&user));
    }
}
