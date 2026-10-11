//! Sync endpoints: the server side of offline-first replication.
//!
//! Clients push batches of [`Operation`]s and pull ops after a `server_seq` cursor. Pushed ops
//! are folded into LWW state (`entity_fields` + `entity_tombstones`) per user partition, and
//! fanned out to co-members of shared projects. All sync writes serialize on
//! [`SYNC_WRITE_LOCK`] so a cursor never skips an in-flight seq. Partition and lock design are
//! in `docs/architecture.md`.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atlas_core::hlc::MAX_COUNTER;
use atlas_core::{Change, EntityKind, Hlc, Operation};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgConnection, Postgres, Transaction};
use tokio::sync::{broadcast, Notify};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::members::Role;
use crate::state::AppState;

/// How often the server pings an open sync socket.
const PING_INTERVAL: Duration = Duration::from_secs(30);

/// How long a socket ticket can be redeemed after issue.
const WS_TICKET_TTL: Duration = Duration::from_secs(30);

/// Unredeemed tickets one user may hold; issuing another drops that user's oldest.
const WS_TICKETS_PER_USER: usize = 8;

/// Unredeemed tickets across all users. They live in memory, so the map is bounded: when full
/// of live tickets, asking for another answers 429.
const MAX_WS_TICKETS: usize = 10_000;

/// Per-user broadcast fan-out for realtime op delivery, plus a registry of open sync sockets
/// (so ending a session can close them) and the single-use tickets sockets open with
/// ([`ws_ticket`]). Tickets live in this process's memory, which suffices for one instance.
pub struct SyncHub {
    channels: Mutex<HashMap<Uuid, broadcast::Sender<String>>>,
    sockets: Mutex<HashMap<Uuid, Vec<SocketEntry>>>,
    next_socket: AtomicU64,
    ping_interval: Duration,
    tickets: Mutex<WsTickets>,
}

/// The unredeemed socket tickets, and each user's in the order they were issued.
#[derive(Default)]
struct WsTickets {
    by_ticket: HashMap<String, WsTicket>,
    by_user: HashMap<Uuid, VecDeque<String>>,
}

impl WsTickets {
    fn remove(&mut self, ticket: &str) -> Option<WsTicket> {
        let found = self.by_ticket.remove(ticket)?;
        if let Entry::Occupied(mut mine) = self.by_user.entry(found.user) {
            mine.get_mut().retain(|t| t != ticket);
            if mine.get().is_empty() {
                mine.remove();
            }
        }
        Some(found)
    }

    fn sweep_expired(&mut self, now: Instant) {
        self.by_ticket
            .retain(|_, t| now.duration_since(t.issued) < WS_TICKET_TTL);
        let live = &self.by_ticket;
        self.by_user.retain(|_, mine| {
            mine.retain(|t| live.contains_key(t));
            !mine.is_empty()
        });
    }
}

/// What a socket ticket was issued for. Not `Debug`, so neither it nor the ticket reaches a log.
struct WsTicket {
    user: Uuid,
    device: Option<Uuid>,
    /// The access token's expiry (unix seconds).
    token_expires_at: i64,
    issued: Instant,
}

/// One open socket in the registry: its device (the token's `did`) and the handle that closes it.
struct SocketEntry {
    id: u64,
    device: Option<Uuid>,
    close: Arc<Notify>,
}

impl Default for SyncHub {
    fn default() -> Self {
        Self::with_ping_interval(PING_INTERVAL)
    }
}

impl SyncHub {
    /// A hub whose sockets are pinged every `ping_interval`.
    pub fn with_ping_interval(ping_interval: Duration) -> Self {
        Self {
            channels: Mutex::default(),
            sockets: Mutex::default(),
            next_socket: AtomicU64::new(0),
            ping_interval,
            tickets: Mutex::default(),
        }
    }

    /// Issue a ticket that opens one sync socket as `user`'s `device`: 256 random bits,
    /// hex-encoded. `None` while [`MAX_WS_TICKETS`] live tickets are out.
    fn issue_ticket(
        &self,
        user: Uuid,
        device: Option<Uuid>,
        token_expires_at: i64,
        now: Instant,
    ) -> Option<String> {
        let mut tickets = self.tickets.lock().expect("hub mutex");
        let oldest = tickets
            .by_user
            .get(&user)
            .filter(|mine| mine.len() >= WS_TICKETS_PER_USER)
            .and_then(|mine| mine.front().cloned());
        if let Some(oldest) = oldest {
            tickets.remove(&oldest);
        }
        if tickets.by_ticket.len() >= MAX_WS_TICKETS {
            tickets.sweep_expired(now);
            if tickets.by_ticket.len() >= MAX_WS_TICKETS {
                return None;
            }
        }
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let ticket = hex::encode(bytes);
        tickets.by_ticket.insert(
            ticket.clone(),
            WsTicket {
                user,
                device,
                token_expires_at,
                issued: now,
            },
        );
        tickets
            .by_user
            .entry(user)
            .or_default()
            .push_back(ticket.clone());
        Some(ticket)
    }

    /// Redeem a ticket; it is removed whether or not valid, so it opens one socket at most.
    fn redeem_ticket(&self, ticket: &str, now: Instant) -> Option<WsTicket> {
        let found = self.tickets.lock().expect("hub mutex").remove(ticket)?;
        (now.duration_since(found.issued) < WS_TICKET_TTL).then_some(found)
    }

    /// Close every open sync socket of `user` (code 4403, `session_revoked`); returns how many
    /// were open. Call after the session-ending change commits: the handshake re-checks the
    /// account, so a reconnecting device is refused.
    pub fn close_user_sockets(&self, user: Uuid) -> usize {
        self.close_sockets(user, |_| true)
    }

    /// Close the open sync sockets of one of `user`'s devices; returns how many were open.
    pub fn close_device_sockets(&self, user: Uuid, device: Uuid) -> usize {
        self.close_sockets(user, |entry| entry.device == Some(device))
    }

    fn close_sockets(&self, user: Uuid, matches: impl Fn(&SocketEntry) -> bool) -> usize {
        let sockets = self.sockets.lock().expect("hub mutex");
        let Some(entries) = sockets.get(&user) else {
            return 0;
        };
        let mut closed = 0;
        for entry in entries.iter().filter(|e| matches(e)) {
            // A stored permit, so a socket not yet waiting still sees it.
            entry.close.notify_one();
            closed += 1;
        }
        closed
    }

    fn register_socket(self: &Arc<Self>, user: Uuid, device: Option<Uuid>) -> SocketHandle {
        let id = self.next_socket.fetch_add(1, AtomicOrdering::Relaxed);
        let close = Arc::new(Notify::new());
        self.sockets
            .lock()
            .expect("hub mutex")
            .entry(user)
            .or_default()
            .push(SocketEntry {
                id,
                device,
                close: close.clone(),
            });
        SocketHandle {
            hub: self.clone(),
            user,
            id,
            close,
        }
    }

    pub fn subscribe(&self, user: Uuid) -> broadcast::Receiver<String> {
        let mut map = self.channels.lock().expect("hub mutex");
        let tx = map.entry(user).or_insert_with(|| broadcast::channel(256).0);
        tx.subscribe()
    }

    pub fn publish(&self, user: Uuid, payload: String) {
        let map = self.channels.lock().expect("hub mutex");
        if let Some(tx) = map.get(&user) {
            let _ = tx.send(payload);
        }
    }

    /// Drop a user's channel once their last subscriber is gone. Receiver liveness is checked
    /// under the lock so a concurrent re-subscribe is not lost.
    pub fn unsubscribe(&self, user: Uuid) {
        let mut map = self.channels.lock().expect("hub mutex");
        if let Some(tx) = map.get(&user) {
            if tx.receiver_count() == 0 {
                map.remove(&user);
            }
        }
    }
}

struct SocketHandle {
    hub: Arc<SyncHub>,
    user: Uuid,
    id: u64,
    close: Arc<Notify>,
}

impl Drop for SocketHandle {
    fn drop(&mut self) {
        let mut sockets = self.hub.sockets.lock().expect("hub mutex");
        if let Some(entries) = sockets.get_mut(&self.user) {
            entries.retain(|e| e.id != self.id);
            if entries.is_empty() {
                sockets.remove(&self.user);
            }
        }
    }
}

/// A live subscription that prunes the channel when dropped. Owned, so it can be taken before
/// the WebSocket upgrade; dropping it on any path cleans up.
struct Subscription {
    hub: Arc<SyncHub>,
    user: Uuid,
    rx: Option<broadcast::Receiver<String>>,
}

impl Subscription {
    fn new(hub: &Arc<SyncHub>, user: Uuid) -> Self {
        Self {
            hub: hub.clone(),
            user,
            rx: Some(hub.subscribe(user)),
        }
    }

    async fn recv(&mut self) -> Result<String, broadcast::error::RecvError> {
        match self.rx.as_mut() {
            Some(rx) => rx.recv().await,
            None => Err(broadcast::error::RecvError::Closed),
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // The receiver must be gone before the count check, or the last device keeps its channel.
        drop(self.rx.take());
        self.hub.unsubscribe(self.user);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sync/push", post(push))
        .route("/sync/pull", get(pull))
        .route("/sync/snapshot", get(snapshot))
        .route("/sync/ws-ticket", post(ws_ticket))
        .route("/sync/ws", get(ws_handler))
}

/// The oldest client sync protocol the server accepts; older builds are refused with 426.
/// Builds below 3 fork a project's encryption keys, below 4 cannot open `__enc: 2` fields,
/// below 5 put the access token in the socket URL, and below 6 would keep writing under a
/// key a rotation retired. History in `docs/architecture.md`.
pub const MIN_SYNC_PROTOCOL: u32 = 6;

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

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub operations: Vec<Operation>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    /// The caller partition's newest `server_seq` after this batch. A client may adopt it as
    /// its pull cursor only when its own cursor is at least `from`.
    pub cursor: i64,
    pub applied: usize,
    /// The caller partition's newest `server_seq` before this batch.
    pub from: i64,
}

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    #[serde(default)]
    pub since: i64,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    500
}

/// Maximum future clock skew tolerated on a client HLC wall clock (5 minutes). Offline edits
/// carry past timestamps; an unbounded-future `wall_ms` would win field-level LWW permanently.
const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

/// Cap on ops in one push batch; each op drives several DB round-trips.
const MAX_OPS_PER_PUSH: usize = 5000;

/// Cap on a single field value's serialized size, bounding row growth in the JSONB store.
const MAX_OP_VALUE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadFieldKind {
    Uuid,
    Sha256,
}

/// Every field whose value the server reads, per entity. Clients encrypt all other values, so
/// these must arrive as plaintext: an envelope here silently breaks fan-out or authorization.
/// `test-vectors/plaintext_fields.json` is the client's side of this contract.
pub(crate) const SERVER_READ_FIELDS: &[(&str, &[(&str, ReadFieldKind)])] = &[
    (
        "task",
        &[
            ("project_id", ReadFieldKind::Uuid),
            ("assignee_id", ReadFieldKind::Uuid),
        ],
    ),
    ("section", &[("project_id", ReadFieldKind::Uuid)]),
    ("comment", &[("task_id", ReadFieldKind::Uuid)]),
    (
        "activity",
        &[
            ("task_id", ReadFieldKind::Uuid),
            ("actor_id", ReadFieldKind::Uuid),
        ],
    ),
    (
        "attachment",
        &[
            ("task_id", ReadFieldKind::Uuid),
            ("blob_sha", ReadFieldKind::Sha256),
            ("thumb_sha", ReadFieldKind::Sha256),
        ],
    ),
];

fn server_read_field(entity: &str, field: &str) -> Option<ReadFieldKind> {
    SERVER_READ_FIELDS
        .iter()
        .find(|(e, _)| *e == entity)?
        .1
        .iter()
        .find(|(f, _)| *f == field)
        .map(|(_, kind)| *kind)
}

/// Reject a push whose value for a [`SERVER_READ_FIELDS`] field is not the expected plaintext
/// shape (or null, which clears a link).
fn validate_server_read_field(op: &Operation) -> AppResult<()> {
    let Change::Set { field, value } = &op.change else {
        return Ok(());
    };
    let entity = entity_str(op.entity);
    let Some(kind) = server_read_field(entity, field) else {
        return Ok(());
    };
    let ok = match value {
        Value::Null => true,
        Value::String(s) => match kind {
            ReadFieldKind::Uuid => Uuid::parse_str(s).is_ok(),
            // Lowercase only: blob rows, downloads and the GC compare the lowercase form.
            ReadFieldKind::Sha256 => {
                s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }
        },
        _ => false,
    };
    if ok {
        return Ok(());
    }
    let expected = match kind {
        ReadFieldKind::Uuid => "a plaintext UUID string",
        ReadFieldKind::Sha256 => "a plaintext lowercase 64-hex sha256 string",
    };
    Err(AppError::BadRequest(format!(
        "{entity}.{field} must be {expected} or null (the server reads it, so it cannot be encrypted)"
    )))
}

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

/// The pull-shaped payload of `/sync/pull`, every WebSocket message and every live push: all of
/// the partition's ops with `from < server_seq <= cursor`. A client whose cursor is at least
/// `from` applies it; one below `from` has a gap and pulls from its own cursor.
#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub operations: Vec<Operation>,
    /// Cursor to pass as `since` on the next pull.
    pub cursor: i64,
    /// The partition's newest `server_seq` before these ops.
    pub from: i64,
}

fn entity_str(kind: EntityKind) -> &'static str {
    match kind {
        EntityKind::Task => "task",
        EntityKind::Project => "project",
        EntityKind::Section => "section",
        EntityKind::Label => "label",
        EntityKind::Comment => "comment",
        EntityKind::Preference => "preference",
        EntityKind::SavedFilter => "saved_filter",
        EntityKind::Reminder => "reminder",
        EntityKind::ProjectMember => "project_member",
        EntityKind::Activity => "activity",
        EntityKind::FocusSession => "focus_session",
        EntityKind::Habit => "habit",
        EntityKind::HabitCheckin => "habit_checkin",
        EntityKind::Attachment => "attachment",
    }
}

fn entity_from_str(s: &str) -> AppResult<EntityKind> {
    Ok(match s {
        "task" => EntityKind::Task,
        "project" => EntityKind::Project,
        "section" => EntityKind::Section,
        "label" => EntityKind::Label,
        "comment" => EntityKind::Comment,
        "preference" => EntityKind::Preference,
        "saved_filter" => EntityKind::SavedFilter,
        "reminder" => EntityKind::Reminder,
        "project_member" => EntityKind::ProjectMember,
        "activity" => EntityKind::Activity,
        "focus_session" => EntityKind::FocusSession,
        "habit" => EntityKind::Habit,
        "habit_checkin" => EntityKind::HabitCheckin,
        "attachment" => EntityKind::Attachment,
        other => {
            return Err(AppError::BadRequest(format!(
                "unknown entity kind: {other}"
            )))
        }
    })
}

type HlcKey = (i64, i32, Uuid);

fn hlc_key(ts: &Hlc) -> AppResult<HlcKey> {
    let wall = i64::try_from(ts.wall_ms)
        .map_err(|_| AppError::BadRequest("hlc wall_ms too large".into()))?;
    let counter = i32::try_from(ts.counter)
        .map_err(|_| AppError::BadRequest("hlc counter too large".into()))?;
    Ok((wall, counter, ts.node))
}

/// Insert `(partition, op)` rows idempotently (on `(user_id, op_id)`) and fold the new ones into
/// each partition's LWW state. Returns each row's `server_seq`, or `None` for a duplicate.
/// Shared by push and the server-authored fan-out.
///
/// Callers hold [`SYNC_WRITE_LOCK`], so this is a few multi-row statements whatever the batch
/// size. Folding is order-independent, so new rows are pre-reduced to one winner per key (an
/// upsert may not touch a row twice). Seqs follow row order.
async fn apply_rows(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &Operation)],
) -> AppResult<Vec<Option<i64>>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let n = rows.len();
    let (mut users, mut op_ids, mut entities, mut entity_ids) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut fields, mut values, mut deletes) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut walls, mut counters, mut nodes) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    for (user, op) in rows {
        let (wall, counter, node) = hlc_key(&op.ts)?;
        users.push(*user);
        op_ids.push(op.id);
        entities.push(entity_str(op.entity));
        entity_ids.push(op.entity_id);
        match &op.change {
            Change::Set { field, value } => {
                fields.push(Some(field.as_str()));
                values.push(Some(value.clone()));
                deletes.push(false);
            }
            Change::Delete => {
                fields.push(None);
                values.push(None);
                deletes.push(true);
            }
        }
        walls.push(wall);
        counters.push(counter);
        nodes.push(node);
    }

    let inserted: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "INSERT INTO operations
            (op_id, user_id, entity, entity_id, field, value, is_delete,
             hlc_wall_ms, hlc_counter, hlc_node)
         SELECT op_id, user_id, entity, entity_id, field, value, is_delete, wall, counter, node
           FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::jsonb[],
                       $7::bool[], $8::int8[], $9::int4[], $10::uuid[])
                WITH ORDINALITY
                AS r(op_id, user_id, entity, entity_id, field, value, is_delete,
                     wall, counter, node, ord)
          ORDER BY ord
         ON CONFLICT (user_id, op_id) DO NOTHING
         RETURNING user_id, op_id, server_seq",
    )
    .bind(&op_ids)
    .bind(&users)
    .bind(&entities)
    .bind(&entity_ids)
    .bind(&fields)
    .bind(&values)
    .bind(&deletes)
    .bind(&walls)
    .bind(&counters)
    .bind(&nodes)
    .fetch_all(&mut **tx)
    .await?;

    let mut new_seqs: HashMap<(Uuid, Uuid), i64> = inserted
        .into_iter()
        .map(|(user, op_id, seq)| ((user, op_id), seq))
        .collect();
    let seqs: Vec<Option<i64>> = rows
        .iter()
        .map(|(user, op)| new_seqs.remove(&(*user, op.id)))
        .collect();

    type FieldKey<'a> = (Uuid, &'static str, Uuid, &'a str);
    let mut field_wins: HashMap<FieldKey, (HlcKey, &Value)> = HashMap::new();
    let mut tomb_wins: HashMap<(Uuid, &'static str, Uuid), HlcKey> = HashMap::new();
    for (i, (user, op)) in rows.iter().enumerate() {
        if seqs[i].is_none() {
            continue;
        }
        let ts = (walls[i], counters[i], nodes[i]);
        let entity = entity_str(op.entity);
        match &op.change {
            Change::Set { field, value } => {
                let key = (*user, entity, op.entity_id, field.as_str());
                match field_wins.get(&key) {
                    Some((best, _)) if *best >= ts => {}
                    _ => {
                        field_wins.insert(key, (ts, value));
                    }
                }
            }
            Change::Delete => {
                let key = (*user, entity, op.entity_id);
                match tomb_wins.get(&key) {
                    Some(best) if *best >= ts => {}
                    _ => {
                        tomb_wins.insert(key, ts);
                    }
                }
            }
        }
    }

    if !field_wins.is_empty() {
        let n = field_wins.len();
        let (mut u, mut e, mut id, mut f, mut v) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut w, mut c, mut nd) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for ((user, entity, entity_id, field), ((wall, counter, node), value)) in field_wins {
            u.push(user);
            e.push(entity);
            id.push(entity_id);
            f.push(field);
            v.push(value.clone());
            w.push(wall);
            c.push(counter);
            nd.push(node);
        }
        sqlx::query(
            "INSERT INTO entity_fields
                (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node)
             SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::jsonb[],
                                  $6::int8[], $7::int4[], $8::uuid[])
             ON CONFLICT (user_id, entity, entity_id, field) DO UPDATE
                SET value = EXCLUDED.value,
                    hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                    hlc_counter = EXCLUDED.hlc_counter,
                    hlc_node = EXCLUDED.hlc_node
              WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                  > (entity_fields.hlc_wall_ms, entity_fields.hlc_counter, entity_fields.hlc_node)",
        )
        .bind(&u)
        .bind(&e)
        .bind(&id)
        .bind(&f)
        .bind(&v)
        .bind(&w)
        .bind(&c)
        .bind(&nd)
        .execute(&mut **tx)
        .await?;
    }

    if !tomb_wins.is_empty() {
        let n = tomb_wins.len();
        let (mut u, mut e, mut id) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut w, mut c, mut nd) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for ((user, entity, entity_id), (wall, counter, node)) in tomb_wins {
            u.push(user);
            e.push(entity);
            id.push(entity_id);
            w.push(wall);
            c.push(counter);
            nd.push(node);
        }
        sqlx::query(
            "INSERT INTO entity_tombstones
                (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node)
             SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[],
                                  $4::int8[], $5::int4[], $6::uuid[])
             ON CONFLICT (user_id, entity, entity_id) DO UPDATE
                SET hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                    hlc_counter = EXCLUDED.hlc_counter,
                    hlc_node = EXCLUDED.hlc_node,
                    received_at = now()
              WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                  > (entity_tombstones.hlc_wall_ms, entity_tombstones.hlc_counter,
                     entity_tombstones.hlc_node)",
        )
        .bind(&u)
        .bind(&e)
        .bind(&id)
        .bind(&w)
        .bind(&c)
        .bind(&nd)
        .execute(&mut **tx)
        .await?;
    }
    Ok(seqs)
}

async fn field_value(
    conn: &mut PgConnection,
    user_id: Uuid,
    entity: &str,
    entity_id: Uuid,
    field: &str,
) -> AppResult<Option<Value>> {
    let v: Option<Value> = sqlx::query_scalar(
        "SELECT value FROM entity_fields
         WHERE user_id = $1 AND entity = $2 AND entity_id = $3 AND field = $4",
    )
    .bind(user_id)
    .bind(entity)
    .bind(entity_id)
    .bind(field)
    .fetch_optional(conn)
    .await?;
    Ok(v)
}

fn as_uuid(v: &Value) -> Option<Uuid> {
    v.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

/// Resolves the `project_id`/`task_id` links a push batch's ops depend on. A link set anywhere
/// in the batch counts for every op (last wins, null clears), so fan-out does not depend on
/// field order; otherwise the caller's stored value holds. Stored values are read once.
struct Links {
    caller: Uuid,
    batch: HashMap<(Uuid, &'static str), Option<Uuid>>,
    stored: HashMap<(Uuid, &'static str), Option<Uuid>>,
}

impl Links {
    fn new(caller: Uuid, ops: &[Operation]) -> Self {
        let mut batch = HashMap::new();
        for op in ops {
            if let Change::Set { field, value } = &op.change {
                let field = match field.as_str() {
                    "project_id" => "project_id",
                    "task_id" => "task_id",
                    _ => continue,
                };
                batch.insert((op.entity_id, field), as_uuid(value));
            }
        }
        Self {
            caller,
            batch,
            stored: HashMap::new(),
        }
    }

    async fn get(
        &mut self,
        conn: &mut PgConnection,
        entity: &str,
        entity_id: Uuid,
        field: &'static str,
    ) -> AppResult<Option<Uuid>> {
        if let Some(link) = self.batch.get(&(entity_id, field)) {
            return Ok(*link);
        }
        if let Some(link) = self.stored.get(&(entity_id, field)) {
            return Ok(*link);
        }
        let link = field_value(conn, self.caller, entity, entity_id, field)
            .await?
            .as_ref()
            .and_then(as_uuid);
        self.stored.insert((entity_id, field), link);
        Ok(link)
    }

    /// The uuid `op`'s entity links to through `field`: its own value, else as of batch end.
    async fn of_op(
        &mut self,
        conn: &mut PgConnection,
        op: &Operation,
        field: &'static str,
    ) -> AppResult<Option<Uuid>> {
        if let Change::Set { field: f, value } = &op.change {
            if f == field {
                return Ok(as_uuid(value));
            }
        }
        self.get(conn, entity_str(op.entity), op.entity_id, field)
            .await
    }
}

async fn stored_project_link(
    conn: &mut PgConnection,
    user: Uuid,
    task_id: Uuid,
) -> AppResult<Option<(Option<Uuid>, HlcKey)>> {
    let row: Option<(Value, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT value, hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
          WHERE user_id = $1 AND entity = 'task' AND entity_id = $2 AND field = 'project_id'",
    )
    .bind(user)
    .bind(task_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(value, wall, counter, node)| (as_uuid(&value), (wall, counter, node))))
}

async fn newest_task_field(
    conn: &mut PgConnection,
    partitions: &[Uuid],
    task_id: Uuid,
) -> AppResult<Option<HlcKey>> {
    Ok(sqlx::query_as(
        "SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
          WHERE user_id = ANY($1) AND entity = 'task' AND entity_id = $2
          ORDER BY hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC
          LIMIT 1",
    )
    .bind(partitions)
    .bind(task_id)
    .fetch_optional(conn)
    .await?)
}

fn project_moves(ops: &[Operation]) -> HashMap<Uuid, usize> {
    let mut winners: HashMap<Uuid, usize> = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        let sets_project = matches!(&op.change, Change::Set { field, .. } if field == "project_id");
        if op.entity != EntityKind::Task || !sets_project {
            continue;
        }
        match winners.get(&op.entity_id) {
            Some(&best) if ops[best].ts >= op.ts => {}
            _ => {
                winners.insert(op.entity_id, i);
            }
        }
    }
    winners
}

/// A task leaving a shared project for somewhere a member cannot follow: that member gets a
/// tombstone and a `revoked_tasks` row (see [`still_revoked`]).
struct Revocation {
    task_id: Uuid,
    members: Vec<Uuid>,
    after: Hlc,
}

async fn project_of(
    conn: &mut PgConnection,
    op: &Operation,
    links: &mut Links,
) -> AppResult<Option<Uuid>> {
    match op.entity {
        EntityKind::Project => Ok(Some(op.entity_id)),
        EntityKind::Task | EntityKind::Section => links.of_op(conn, op, "project_id").await,
        // Comments, activity and attachments follow their task's project (it may be created in
        // this batch).
        EntityKind::Comment | EntityKind::Activity | EntityKind::Attachment => {
            match links.of_op(conn, op, "task_id").await? {
                Some(task_id) => links.get(conn, "task", task_id, "project_id").await,
                None => Ok(None),
            }
        }
        // Private to their owner.
        _ => Ok(None),
    }
}

/// A project's membership rows as the push transaction sees them: `(user, role, active)`.
/// Read on the transaction's own connection: a second pool checkout would let pushes queued on
/// the lock pin every connection while the holder waits for one.
struct ProjectMembers(Vec<(Uuid, Role, bool)>);

impl ProjectMembers {
    async fn load(conn: &mut PgConnection, project_id: Uuid) -> AppResult<Self> {
        let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
            "SELECT user_id, role, state FROM project_members WHERE project_id = $1",
        )
        .bind(project_id)
        .fetch_all(conn)
        .await?;
        rows.into_iter()
            .map(|(user, role, state)| Ok((user, Role::parse(&role)?, state == "active")))
            .collect::<AppResult<_>>()
            .map(Self)
    }

    fn is_shared(&self) -> bool {
        !self.0.is_empty()
    }

    fn active_role(&self, user: Uuid) -> Option<Role> {
        self.0
            .iter()
            .find(|(id, _, active)| *id == user && *active)
            .map(|(_, role, _)| *role)
    }

    fn require_role(&self, user: Uuid, min: Role) -> AppResult<Role> {
        match self.active_role(user) {
            Some(role) if role >= min => Ok(role),
            _ => Err(AppError::Forbidden(format!(
                "requires {} role on this project",
                min.as_str()
            ))),
        }
    }

    fn active_ids(&self) -> Vec<Uuid> {
        self.0
            .iter()
            .filter(|(_, _, active)| *active)
            .map(|(id, _, _)| *id)
            .collect()
    }
}

/// The tasks the batch sets fields of that a move took away from `caller` ([`Revocation`]) and
/// that are still out of their reach. The tombstone alone would not keep them away (a later
/// field shows the task again, and retention purges it), so the caller may not write them while
/// their partition links them to no project or a private one. One back in a shared project the
/// caller is active in is theirs again, and its row is dropped.
async fn still_revoked(
    tx: &mut Transaction<'_, Postgres>,
    members_cache: &mut HashMap<Uuid, ProjectMembers>,
    caller: Uuid,
    ops: &[Operation],
) -> AppResult<HashSet<Uuid>> {
    let written: Vec<Uuid> = ops
        .iter()
        .filter(|op| op.entity == EntityKind::Task && matches!(op.change, Change::Set { .. }))
        .map(|op| op.entity_id)
        .collect();
    if written.is_empty() {
        return Ok(HashSet::new());
    }
    let recorded: Vec<Uuid> = sqlx::query_scalar(
        "SELECT task_id FROM revoked_tasks WHERE user_id = $1 AND task_id = ANY($2)",
    )
    .bind(caller)
    .bind(&written)
    .fetch_all(&mut **tx)
    .await?;
    let (mut revoked, mut returned) = (HashSet::new(), Vec::new());
    for task in recorded {
        let back = match stored_project_link(tx, caller, task).await? {
            Some((Some(pid), _)) => project_members(tx, members_cache, pid)
                .await?
                .active_role(caller)
                .is_some(),
            _ => false,
        };
        if back {
            returned.push(task);
        } else {
            revoked.insert(task);
        }
    }
    if !returned.is_empty() {
        sqlx::query("DELETE FROM revoked_tasks WHERE user_id = $1 AND task_id = ANY($2)")
            .bind(caller)
            .bind(&returned)
            .execute(&mut **tx)
            .await?;
    }
    Ok(revoked)
}

async fn project_members<'a>(
    tx: &mut Transaction<'_, Postgres>,
    cache: &'a mut HashMap<Uuid, ProjectMembers>,
    project_id: Uuid,
) -> AppResult<&'a ProjectMembers> {
    Ok(match cache.entry(project_id) {
        Entry::Occupied(e) => e.into_mut(),
        Entry::Vacant(e) => e.insert(ProjectMembers::load(tx, project_id).await?),
    })
}

/// The minimum role required to push this op onto a shared project.
///
/// Tasks, sections, comments and activity need only `Commenter` (any active member). Editing the
/// project entity's fields needs `Editor`. Deleting or archiving the project is owner-only, so
/// an editor cannot remove it from under its owner. Membership changes go through REST.
fn min_role_for_op(op: &Operation) -> Role {
    match op.entity {
        EntityKind::Task
        | EntityKind::Section
        | EntityKind::Comment
        | EntityKind::Activity
        | EntityKind::Attachment => Role::Commenter,
        EntityKind::Project => match &op.change {
            Change::Delete => Role::Owner,
            Change::Set { field, .. } if field == "deleted_at" || field == "archived_at" => {
                Role::Owner
            }
            Change::Set { .. } => Role::Editor,
        },
        _ => Role::Editor,
    }
}

/// `POST /sync/push`: persist a batch idempotently, fold it into LWW state, and fan out ops on
/// shared projects to every co-member's partition and live channel.
async fn push(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<PushRequest>,
) -> SyncResult<Json<PushResponse>> {
    let caller = user.user_id;
    if req.operations.len() > MAX_OPS_PER_PUSH {
        return Err(AppError::BadRequest("too many operations in one push".into()).into());
    }
    // Before the transaction, so a malformed batch never takes the global write lock.
    for op in &req.operations {
        validate_server_read_field(op)?;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut newest: Option<Hlc> = None;
    for op in &req.operations {
        // Membership is server-managed.
        if op.entity == EntityKind::ProjectMember {
            return Err(AppError::Forbidden("project_member is server-managed".into()).into());
        }

        // Reject a future HLC wall clock before it can win LWW (see MAX_FUTURE_SKEW_MS).
        let wall = i64::try_from(op.ts.wall_ms)
            .map_err(|_| AppError::BadRequest("hlc wall_ms too large".into()))?;
        if wall > now_ms.saturating_add(MAX_FUTURE_SKEW_MS) {
            return Err(SyncError::ClockSkew {
                server_time: now_ms,
            });
        }
        // Clocks carry past MAX_COUNTER, so a larger counter is forged; observing it would
        // push the server clock's counter past what `int4` holds.
        if op.ts.counter > MAX_COUNTER {
            return Err(AppError::BadRequest("hlc counter too large".into()).into());
        }
        newest = newest.max(Some(op.ts));

        // Bound a single field value's size.
        if let Change::Set { value, .. } = &op.change {
            if value.to_string().len() > MAX_OP_VALUE_BYTES {
                return Err(AppError::BadRequest("operation value too large".into()).into());
            }
        }
    }

    // Server-stamp an activity's `actor_id` to the caller so it cannot be forged.
    let mut ops = req.operations;
    for op in &mut ops {
        if let Change::Set { field, value } = &mut op.change {
            if op.entity == EntityKind::Activity && field == "actor_id" {
                *value = Value::String(caller.to_string());
            }
        }
    }

    let mut tx = state.pool.begin().await?;
    // Serialize all sync writes (see [`SYNC_WRITE_LOCK`]).
    take_sync_write_lock(&mut tx).await?;
    let mut members_cache: HashMap<Uuid, ProjectMembers> = HashMap::new();
    let mut links = Links::new(caller, &ops);

    // Authorize every op and resolve its fan-out before writing anything.
    let revoked = still_revoked(&mut tx, &mut members_cache, caller, &ops).await?;
    let moves = project_moves(&ops);
    let mut revocations: Vec<Revocation> = Vec::new();
    let mut fan_targets: Vec<Vec<Uuid>> = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let project = project_of(&mut tx, op, &mut links).await?;

        // A task a move took away stays away (see `still_revoked`); its comments are kept.
        if revoked.contains(&op.entity_id)
            && op.entity == EntityKind::Task
            && matches!(op.change, Change::Set { .. })
        {
            return Err(AppError::Forbidden(
                "this task was moved to a project you are not a member of".into(),
            )
            .into());
        }

        // An assignee must be an active member of the shared project (or the caller on a
        // private task); null (unassign) is always allowed.
        if op.entity == EntityKind::Task {
            if let Change::Set { field, value } = &op.change {
                if field == "assignee_id" {
                    if let Some(assignee) = as_uuid(value) {
                        let ok = match project {
                            Some(pid) => {
                                let members =
                                    project_members(&mut tx, &mut members_cache, pid).await?;
                                if members.is_shared() {
                                    members.active_role(assignee).is_some()
                                } else {
                                    assignee == caller
                                }
                            }
                            None => assignee == caller,
                        };
                        if !ok {
                            return Err(AppError::Forbidden(
                                "assignee must be a project member".into(),
                            )
                            .into());
                        }
                    }
                }
            }
        }

        let mut targets = Vec::new();
        if let Some(pid) = project {
            let members = project_members(&mut tx, &mut members_cache, pid).await?;
            if members.is_shared() {
                members.require_role(caller, min_role_for_op(op))?;
                targets = members.active_ids();
            }
        }

        // A task moving out of a shared project: the old project's members get the move too,
        // and those who cannot see the new project lose the task, which takes an editor.
        if moves.get(&op.entity_id) == Some(&i) {
            if let Some((Some(old), stored_ts)) =
                stored_project_link(&mut tx, caller, op.entity_id).await?
            {
                if old != project.unwrap_or(Uuid::nil()) && hlc_key(&op.ts)? > stored_ts {
                    let old_members = project_members(&mut tx, &mut members_cache, old).await?;
                    if old_members.is_shared() {
                        old_members.require_role(caller, Role::Editor)?;
                        let left_behind: Vec<Uuid> = old_members
                            .active_ids()
                            .into_iter()
                            .filter(|m| *m != caller && !targets.contains(m))
                            .collect();
                        targets.extend(&left_behind);
                        if !left_behind.is_empty() {
                            revocations.push(Revocation {
                                task_id: op.entity_id,
                                members: left_behind,
                                after: op.ts,
                            });
                        }
                    }
                }
            }
        }
        targets.retain(|member| *member != caller);
        fan_targets.push(targets);
    }

    // Each revocation's tombstone beats the move and every field its recipients hold; the
    // recorded revocation keeps it hidden from what they write later.
    let (revoked_users, revoked_tasks): (Vec<Uuid>, Vec<Uuid>) = revocations
        .iter()
        .flat_map(|rev| rev.members.iter().map(|member| (*member, rev.task_id)))
        .unzip();
    if !revoked_users.is_empty() {
        sqlx::query(
            "INSERT INTO revoked_tasks (user_id, task_id)
             SELECT * FROM UNNEST($1::uuid[], $2::uuid[])
             ON CONFLICT (user_id, task_id) DO NOTHING",
        )
        .bind(&revoked_users)
        .bind(&revoked_tasks)
        .execute(&mut *tx)
        .await?;
    }
    let mut revoke_ops: Vec<(Vec<Uuid>, Operation)> = Vec::with_capacity(revocations.len());
    for rev in revocations {
        let mut floor = rev.after;
        if let Some((wall, counter, node)) =
            newest_task_field(&mut tx, &rev.members, rev.task_id).await?
        {
            floor = floor.max(Hlc {
                wall_ms: wall as u64,
                counter: counter as u32,
                node,
            });
        }
        // The clock observes the floor only up to the skew a pushed op may carry, so a stored
        // far-future stamp cannot drag later server ops along. The tombstone still beats the floor.
        let now = physical_now_ms();
        let ts = state
            .clock
            .lock()
            .expect("server clock poisoned")
            .update(cap_future_skew(floor, now), now)
            .max(successor_hlc(floor));
        revoke_ops.push((
            rev.members,
            Operation::delete(EntityKind::Task, rev.task_id, ts),
        ));
    }

    let caller_rows: Vec<(Uuid, &Operation)> = ops.iter().map(|op| (caller, op)).collect();
    let (caller_seqs, mut batches) = apply_live(&mut tx, &caller_rows).await?;
    let applied = caller_seqs.iter().filter(|seq| seq.is_some()).count();
    let mut member_rows: Vec<(Uuid, &Operation)> = ops
        .iter()
        .zip(&fan_targets)
        .zip(&caller_seqs)
        .filter(|(_, seq)| seq.is_some())
        .flat_map(|((op, targets), _)| targets.iter().map(move |member| (*member, op)))
        .collect();
    for (members, tombstone) in &revoke_ops {
        member_rows.extend(members.iter().map(|member| (*member, tombstone)));
    }
    let (_, member_batches) = apply_live(&mut tx, &member_rows).await?;
    batches.extend(member_batches);

    // Keep each blob bound to the project its attachment lives in (`attachments::bind_blobs`).
    let attachment_ids: Vec<Uuid> = ops
        .iter()
        .filter(|op| op.entity == EntityKind::Attachment)
        .map(|op| op.entity_id)
        .collect();
    let moved_tasks: Vec<Uuid> = moves.keys().copied().collect();
    if !attachment_ids.is_empty() || !moved_tasks.is_empty() {
        crate::attachments::bind_blobs(&mut tx, caller, &attachment_ids, &moved_tasks, &[]).await?;
    }

    let cursor = partition_head(&mut tx, caller).await?;
    let from = batches.get(&caller).map_or(cursor, |batch| batch.from);

    tx.commit().await?;

    // Observe the accepted timestamps so later server-authored ops order after them.
    if let Some(newest) = newest {
        observe_client_ts(&state, newest);
    }

    for (user, batch) in batches {
        batch.publish(&state.hub, user);
    }

    Ok(Json(PushResponse {
        cursor,
        applied,
        from,
    }))
}

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
        .expect("server clock poisoned")
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
        .expect("server clock poisoned")
        .update(ts, physical_now_ms());
}

/// Deterministic entity id for a `(project, user)` membership, so re-authoring converges.
pub(crate) fn member_entity_id(project_id: Uuid, user_id: Uuid) -> Uuid {
    const MEMBER_NAMESPACE: Uuid = Uuid::from_u128(0x4d35_5f70_726f_6a5f_6d65_6d62_6572_0001);
    Uuid::new_v5(
        &MEMBER_NAMESPACE,
        format!("{project_id}:{user_id}").as_bytes(),
    )
}

/// The field-set ops describing one membership, for the client's collaborator list.
#[allow(clippy::too_many_arguments)]
pub(crate) fn member_set_ops(
    state: &AppState,
    project_id: Uuid,
    user_id: Uuid,
    email: &str,
    display_name: &str,
    role: &str,
    member_state: &str,
    deletion_scheduled: bool,
) -> Vec<Operation> {
    let eid = member_entity_id(project_id, user_id);
    let field = |name: &str, value: Value| {
        Operation::set(
            EntityKind::ProjectMember,
            eid,
            name,
            value,
            server_ts(state),
        )
    };
    vec![
        field("project_id", json!(project_id.to_string())),
        field("user_id", json!(user_id.to_string())),
        field("email", json!(email)),
        field("display_name", json!(display_name)),
        field("role", json!(role)),
        field("state", json!(member_state)),
        field("deletion_scheduled", json!(deletion_scheduled)),
    ]
}

pub(crate) fn member_delete_op(state: &AppState, project_id: Uuid, user_id: Uuid) -> Operation {
    Operation::delete(
        EntityKind::ProjectMember,
        member_entity_id(project_id, user_id),
        server_ts(state),
    )
}

/// The ops one transaction newly applied to one partition, as a live payload: exactly the
/// partition's seqs in `(from, cursor]` thanks to [`SYNC_WRITE_LOCK`].
#[derive(Debug)]
pub(crate) struct LiveBatch {
    pub ops: Vec<Operation>,
    pub from: i64,
    pub cursor: i64,
}

impl LiveBatch {
    fn publish(self, hub: &SyncHub, user: Uuid) {
        if let Ok(payload) = serde_json::to_string(&PullResponse {
            operations: self.ops,
            cursor: self.cursor,
            from: self.from,
        }) {
            hub.publish(user, payload);
        }
    }
}

pub(crate) type MemberBatches = HashMap<Uuid, LiveBatch>;

/// The heads of `users`' partitions, read before a write transaction touches them.
async fn partition_heads(conn: &mut PgConnection, users: &[Uuid]) -> AppResult<HashMap<Uuid, i64>> {
    let rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT u.id, COALESCE((SELECT MAX(server_seq) FROM operations WHERE user_id = u.id), 0)
           FROM UNNEST($1::uuid[]) AS u(id)",
    )
    .bind(users)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Apply `(partition, op)` rows and gather the new ones into per-partition live batches.
async fn apply_live(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &Operation)],
) -> AppResult<(Vec<Option<i64>>, MemberBatches)> {
    let mut users: Vec<Uuid> = rows.iter().map(|(user, _)| *user).collect();
    users.sort_unstable();
    users.dedup();
    let heads = partition_heads(tx, &users).await?;
    let seqs = apply_rows(tx, rows).await?;
    let mut batches = MemberBatches::new();
    for ((user, op), seq) in rows.iter().zip(&seqs) {
        let Some(seq) = seq else { continue };
        let from = heads.get(user).copied().unwrap_or(0);
        let batch = batches.entry(*user).or_insert_with(|| LiveBatch {
            ops: Vec::new(),
            from,
            cursor: from,
        });
        batch.ops.push((*op).clone());
        batch.cursor = batch.cursor.max(*seq);
    }
    Ok((seqs, batches))
}

/// Begin a transaction that may insert into `operations`, holding [`SYNC_WRITE_LOCK`].
pub(crate) async fn begin_sync_write(
    pool: &sqlx::PgPool,
) -> AppResult<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    take_sync_write_lock(&mut tx).await?;
    Ok(tx)
}

/// Apply server-authored ops to each member's partition; the caller publishes after commit.
pub(crate) async fn apply_to_members(
    tx: &mut Transaction<'_, Postgres>,
    members: &[Uuid],
    ops: &[Operation],
) -> AppResult<MemberBatches> {
    let rows: Vec<(Uuid, &Operation)> = members
        .iter()
        .flat_map(|member| ops.iter().map(move |op| (*member, op)))
        .collect();
    apply_to_partitions(tx, &rows).await
}

/// Like [`apply_to_members`], for callers whose partitions receive different ops.
pub(crate) async fn apply_to_partitions(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &Operation)],
) -> AppResult<MemberBatches> {
    Ok(apply_live(tx, rows).await?.1)
}

pub(crate) async fn deliver_to_members(
    state: &AppState,
    members: &[Uuid],
    ops: &[Operation],
) -> AppResult<()> {
    if members.is_empty() || ops.is_empty() {
        return Ok(());
    }
    // Same serialization as push: this inserts into `operations` and hands out cursors.
    let mut tx = begin_sync_write(&state.pool).await?;
    let batches = apply_to_members(&mut tx, members, ops).await?;
    tx.commit().await?;
    publish_batches(state, batches);
    Ok(())
}

pub(crate) fn publish_batches(state: &AppState, batches: MemberBatches) {
    for (member, batch) in batches {
        batch.publish(&state.hub, member);
    }
}

type EntityKey = (String, Uuid);

/// The entity keys that make up `project_id` in `owner`'s partition, in backfill order: the
/// project, sections, tasks, their comments/activity/attachments, and membership rows (with
/// tombstones, so a returning member drops collaborators who left).
async fn project_keys(
    conn: &mut PgConnection,
    owner: Uuid,
    project_id: Uuid,
) -> AppResult<Vec<EntityKey>> {
    let pid_json = Value::String(project_id.to_string());

    let task_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'task' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;
    let section_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'section' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;
    let member_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'project_member' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;

    let task_id_strs: Vec<String> = task_ids.iter().map(|u| u.to_string()).collect();
    let child_ids: Vec<EntityKey> = if task_id_strs.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT entity, entity_id FROM entity_fields
             WHERE user_id = $1 AND entity IN ('comment', 'activity', 'attachment') AND field = 'task_id'
               AND (value #>> '{}') = ANY($2)",
        )
        .bind(owner)
        .bind(&task_id_strs)
        .fetch_all(&mut *conn)
        .await?
    };

    let mut keys: Vec<EntityKey> = vec![("project".to_string(), project_id)];
    keys.extend(
        section_ids
            .into_iter()
            .map(|id| ("section".to_string(), id)),
    );
    keys.extend(task_ids.into_iter().map(|id| ("task".to_string(), id)));
    keys.extend(child_ids);
    keys.extend(
        member_ids
            .into_iter()
            .map(|id| ("project_member".to_string(), id)),
    );
    Ok(keys)
}

/// Tombstones for whatever of `project_id` `user`'s partition still shows, for a member who
/// left or was removed. Each beats the newest field and tombstone of its entity; an entity
/// already hidden gets none. Runs inside a [`begin_sync_write`] transaction.
pub(crate) async fn revoke_project_ops(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    user: Uuid,
    project_id: Uuid,
) -> AppResult<Vec<Operation>> {
    let keys = project_keys(tx, user, project_id).await?;
    let entities: Vec<&str> = keys.iter().map(|(e, _)| e.as_str()).collect();
    let ids: Vec<Uuid> = keys.iter().map(|(_, id)| *id).collect();
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        Uuid,
        Option<i64>,
        Option<i32>,
        Option<Uuid>,
        Option<i64>,
        Option<i32>,
        Option<Uuid>,
    )> = sqlx::query_as(
        "SELECT k.entity, k.entity_id, f.hlc_wall_ms, f.hlc_counter, f.hlc_node,
                    t.hlc_wall_ms, t.hlc_counter, t.hlc_node
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               LEFT JOIN LATERAL (
                    SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
                     WHERE user_id = $1 AND entity = k.entity AND entity_id = k.entity_id
                     ORDER BY hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC LIMIT 1
               ) f ON true
               LEFT JOIN entity_tombstones t
                 ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id",
    )
    .bind(user)
    .bind(&entities)
    .bind(&ids)
    .fetch_all(&mut **tx)
    .await?;
    let hlc = |wall: Option<i64>, counter: Option<i32>, node: Option<Uuid>| {
        Some(Hlc {
            wall_ms: wall? as u64,
            counter: counter? as u32,
            node: node?,
        })
    };
    let mut ops = Vec::new();
    for (entity, entity_id, fw, fc, fnode, tw, tc, tnode) in rows {
        let field = hlc(fw, fc, fnode);
        let tomb = hlc(tw, tc, tnode);
        if tomb.is_some() && tomb >= field {
            continue;
        }
        let ts = match field.max(tomb) {
            Some(floor) => {
                let now = physical_now_ms();
                state
                    .clock
                    .lock()
                    .expect("server clock poisoned")
                    .update(cap_future_skew(floor, now), now)
                    .max(successor_hlc(floor))
            }
            None => server_ts(state),
        };
        ops.push(Operation::delete(entity_from_str(&entity)?, entity_id, ts));
    }
    Ok(ops)
}

pub(crate) async fn revoke_project(
    state: &AppState,
    user: Uuid,
    project_id: Uuid,
) -> AppResult<usize> {
    let mut tx = begin_sync_write(&state.pool).await?;
    let ops = revoke_project_ops(&mut tx, state, user, project_id).await?;
    if ops.is_empty() {
        return Ok(0);
    }
    let batches = apply_to_members(&mut tx, &[user], &ops).await?;
    tx.commit().await?;
    publish_batches(state, batches);
    Ok(ops.len())
}

/// Once per start, revoke shared projects that earlier leavers' partitions still show. A
/// candidate has a project tombstone, is still shared, and has no membership for `user`.
/// Idempotent; returns how many candidates still needed tombstones, so a fully revoked one
/// does not count again on every start.
pub async fn revoke_left_projects(state: &AppState) -> AppResult<usize> {
    let candidates: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT t.user_id, t.entity_id FROM entity_tombstones t
          WHERE t.entity = 'project'
            AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = t.entity_id)
            AND NOT EXISTS (SELECT 1 FROM project_members m
                             WHERE m.project_id = t.entity_id AND m.user_id = t.user_id)",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut revoked = 0;
    for (user, project_id) in &candidates {
        if revoke_project(state, *user, *project_id).await? > 0 {
            revoked += 1;
        }
    }
    Ok(revoked)
}

async fn keys_ops_by_key(
    conn: &mut PgConnection,
    user: Uuid,
    keys: &[EntityKey],
) -> AppResult<HashMap<EntityKey, Vec<Operation>>> {
    let mut by_key: HashMap<EntityKey, Vec<Operation>> = HashMap::new();
    for op in keys_ops(conn, user, keys).await? {
        by_key
            .entry((entity_str(op.entity).to_string(), op.entity_id))
            .or_default()
            .push(op);
    }
    Ok(by_key)
}

/// The newest tombstone `member` holds for each of `keys`. The project's Delete ops are read
/// from the op log too, since retention may have purged the tombstone row a device still holds.
async fn member_floors(
    conn: &mut PgConnection,
    member: Uuid,
    project_id: Uuid,
    keys: &[EntityKey],
) -> AppResult<HashMap<EntityKey, Hlc>> {
    let entities: Vec<&str> = keys.iter().map(|(e, _)| e.as_str()).collect();
    let ids: Vec<Uuid> = keys.iter().map(|(_, id)| *id).collect();
    let project_key = ("project".to_string(), project_id);
    let rows: Vec<(String, Uuid, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT t.entity, t.entity_id, t.hlc_wall_ms, t.hlc_counter, t.hlc_node
           FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
           JOIN entity_tombstones t
             ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id
         UNION ALL
         SELECT entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node FROM operations
          WHERE $5 AND user_id = $1 AND entity = 'project' AND entity_id = $4 AND is_delete",
    )
    .bind(member)
    .bind(&entities)
    .bind(&ids)
    .bind(project_id)
    .bind(keys.contains(&project_key))
    .fetch_all(&mut *conn)
    .await?;
    let mut floors: HashMap<EntityKey, Hlc> = HashMap::new();
    for (entity, entity_id, wall, counter, node) in rows {
        let ts = Hlc {
            wall_ms: wall as u64,
            counter: counter as u32,
            node,
        };
        let floor = floors.entry((entity, entity_id)).or_insert(ts);
        *floor = (*floor).max(ts);
    }
    Ok(floors)
}

async fn keys_written_since(
    conn: &mut PgConnection,
    user: Uuid,
    head: i64,
) -> AppResult<HashSet<EntityKey>> {
    let rows: Vec<EntityKey> = sqlx::query_as(
        "SELECT DISTINCT entity, entity_id FROM operations WHERE user_id = $1 AND server_seq > $2",
    )
    .bind(user)
    .bind(head)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// What [`accept_backfill_ops`] builds from: `owner`'s copy of the project and `member`'s
/// tombstones for it.
pub(crate) struct BackfillRead {
    owner: Uuid,
    member: Uuid,
    project_id: Uuid,
    owner_head: i64,
    member_head: i64,
    keys: Vec<EntityKey>,
    ops: HashMap<EntityKey, Vec<Operation>>,
    floors: HashMap<EntityKey, Hlc>,
}

impl BackfillRead {
    /// Read on `conn`, whose transaction must see one snapshot, so the heads mark exactly what
    /// the read saw. Ops it missed have a higher seq than the head it read.
    pub(crate) async fn read(
        conn: &mut PgConnection,
        owner: Uuid,
        member: Uuid,
        project_id: Uuid,
    ) -> AppResult<Self> {
        let heads = partition_heads(conn, &[owner, member]).await?;
        let keys = project_keys(conn, owner, project_id).await?;
        let ops = keys_ops_by_key(conn, owner, &keys).await?;
        let floors = member_floors(conn, member, project_id, &keys).await?;
        Ok(Self {
            owner,
            member,
            project_id,
            owner_head: heads.get(&owner).copied().unwrap_or(0),
            member_head: heads.get(&member).copied().unwrap_or(0),
            keys,
            ops,
            floors,
        })
    }

    /// [`BackfillRead::read`] in its own read-only snapshot transaction without
    /// [`SYNC_WRITE_LOCK`], so copying a large project does not block pushes.
    pub(crate) async fn read_unlocked(
        pool: &sqlx::PgPool,
        owner: Uuid,
        member: Uuid,
        project_id: Uuid,
    ) -> AppResult<Self> {
        let mut tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        let read = Self::read(&mut tx, owner, member, project_id).await?;
        tx.commit().await?;
        Ok(read)
    }

    pub(crate) fn owner(&self) -> Uuid {
        self.owner
    }
}

/// The smallest HLC above `ts`, the node read as a 128-bit integer (the client's `successorHlc`).
fn successor_hlc(ts: Hlc) -> Hlc {
    match ts.node.as_u128().checked_add(1) {
        Some(node) => Hlc {
            node: Uuid::from_u128(node),
            ..ts
        },
        None => Hlc {
            counter: ts.counter + 1,
            node: Uuid::nil(),
            ..ts
        },
    }
}

/// The accept backfill for `member`: `owner`'s copy of the project, plus each field that copy
/// shows but a tombstone in `member`'s partition hides, rewritten just above that tombstone
/// ([`successor_hlc`]).
///
/// `read` may be older than `tx`, which holds [`SYNC_WRITE_LOCK`]: keys written since the
/// read's heads, and the key set itself when the owner's partition changed, are read again.
pub(crate) async fn accept_backfill_ops(
    tx: &mut Transaction<'_, Postgres>,
    read: BackfillRead,
) -> AppResult<Vec<Operation>> {
    let BackfillRead {
        owner,
        member,
        project_id,
        owner_head,
        member_head,
        keys,
        mut ops,
        mut floors,
    } = read;
    let owner_changed = keys_written_since(tx, owner, owner_head).await?;
    let member_changed = keys_written_since(tx, member, member_head).await?;
    let keys = if owner_changed.is_empty() && member_changed.is_empty() {
        keys
    } else {
        let read_keys: HashSet<EntityKey> = keys.iter().cloned().collect();
        let keys = if owner_changed.is_empty() {
            keys
        } else {
            project_keys(tx, owner, project_id).await?
        };
        let reread: Vec<EntityKey> = keys
            .iter()
            .filter(|k| owner_changed.contains(*k) || !read_keys.contains(*k))
            .cloned()
            .collect();
        if !reread.is_empty() {
            for key in &reread {
                ops.remove(key);
            }
            ops.extend(keys_ops_by_key(tx, owner, &reread).await?);
        }
        let reread: HashSet<EntityKey> = reread.into_iter().collect();
        let refloor: Vec<EntityKey> = keys
            .iter()
            .filter(|k| member_changed.contains(*k) || reread.contains(*k))
            .cloned()
            .collect();
        if !refloor.is_empty() {
            for key in &refloor {
                floors.remove(key);
            }
            floors.extend(member_floors(tx, member, project_id, &refloor).await?);
        }
        keys
    };

    let mut out: Vec<Operation> = Vec::new();
    for key in &keys {
        if let Some(key_ops) = ops.remove(key) {
            out.extend(key_ops);
        }
    }
    let owner_tombs: HashMap<EntityKey, Hlc> = out
        .iter()
        .filter(|op| matches!(op.change, Change::Delete))
        .map(|op| ((entity_str(op.entity).to_string(), op.entity_id), op.ts))
        .collect();
    let mut rewrites = Vec::new();
    for op in &out {
        let Change::Set { field, value } = &op.change else {
            continue;
        };
        let key = (entity_str(op.entity).to_string(), op.entity_id);
        let Some(&floor) = floors.get(&key) else {
            continue;
        };
        let shown = owner_tombs.get(&key).is_none_or(|tomb| op.ts > *tomb);
        if shown && op.ts <= floor {
            rewrites.push(Operation::set(
                op.entity,
                op.entity_id,
                field,
                value.clone(),
                successor_hlc(floor),
            ));
        }
    }
    out.extend(rewrites);
    Ok(out)
}

/// Materialize `(entity, entity_id)` keys from `user`'s partition as ops: every stored field
/// Set with its HLC plus the tombstone Delete. Folding them with field-level LWW reproduces the
/// server's view. Shared by the accept backfill, `GET /sync/snapshot` and the account export;
/// reads a bounded chunk of keys per query.
async fn keys_ops(
    conn: &mut PgConnection,
    user: Uuid,
    keys: &[(String, Uuid)],
) -> AppResult<Vec<Operation>> {
    type Key = (String, Uuid);
    let mut ops = Vec::new();
    for chunk in keys.chunks(MAX_SNAPSHOT_KEYS_PER_PAGE as usize) {
        let entities: Vec<&str> = chunk.iter().map(|(e, _)| e.as_str()).collect();
        let ids: Vec<Uuid> = chunk.iter().map(|(_, id)| *id).collect();
        let fields: Vec<(String, Uuid, String, Value, i64, i32, Uuid)> = sqlx::query_as(
            "SELECT f.entity, f.entity_id, f.field, f.value,
                    f.hlc_wall_ms, f.hlc_counter, f.hlc_node
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               JOIN entity_fields f
                 ON f.user_id = $1 AND f.entity = k.entity AND f.entity_id = k.entity_id
              ORDER BY f.entity, f.entity_id, f.field",
        )
        .bind(user)
        .bind(&entities)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
        let tombs: Vec<(String, Uuid, i64, i32, Uuid)> = sqlx::query_as(
            "SELECT t.entity, t.entity_id, t.hlc_wall_ms, t.hlc_counter, t.hlc_node
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               JOIN entity_tombstones t
                 ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id",
        )
        .bind(user)
        .bind(&entities)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;

        let hlc = |wall: i64, counter: i32, node: Uuid| Hlc {
            wall_ms: wall as u64,
            counter: counter as u32,
            node,
        };
        let mut by_key: HashMap<Key, Vec<Operation>> = HashMap::new();
        for (entity, entity_id, field, value, wall, counter, node) in fields {
            let op = Operation::set(
                entity_from_str(&entity)?,
                entity_id,
                &field,
                value,
                hlc(wall, counter, node),
            );
            by_key.entry((entity, entity_id)).or_default().push(op);
        }
        for (entity, entity_id, wall, counter, node) in tombs {
            let op = Operation::delete(
                entity_from_str(&entity)?,
                entity_id,
                hlc(wall, counter, node),
            );
            by_key.entry((entity, entity_id)).or_default().push(op);
        }
        for key in chunk {
            if let Some(key_ops) = by_key.remove(key) {
                ops.extend(key_ops);
            }
        }
    }
    Ok(ops)
}

#[derive(sqlx::FromRow)]
struct OpRow {
    server_seq: i64,
    op_id: Uuid,
    entity: String,
    entity_id: Uuid,
    field: Option<String>,
    value: Option<serde_json::Value>,
    is_delete: bool,
    hlc_wall_ms: i64,
    hlc_counter: i32,
    hlc_node: Uuid,
}

impl OpRow {
    fn into_operation(self) -> AppResult<Operation> {
        let change = if self.is_delete {
            Change::Delete
        } else {
            Change::Set {
                field: self.field.ok_or(AppError::Internal)?,
                value: self.value.unwrap_or(serde_json::Value::Null),
            }
        };
        Ok(Operation {
            id: self.op_id,
            entity: entity_from_str(&self.entity)?,
            entity_id: self.entity_id,
            change,
            ts: Hlc {
                wall_ms: self.hlc_wall_ms as u64,
                counter: self.hlc_counter as u32,
                node: self.hlc_node,
            },
        })
    }
}

async fn partition_head(conn: &mut PgConnection, user: Uuid) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(server_seq), 0) FROM operations WHERE user_id = $1",
        )
        .bind(user)
        .fetch_one(conn)
        .await?,
    )
}

/// Fetch a user's ops after `since` (ordered, bounded), for `/sync/pull` and WS backfill.
///
/// Answers [`SyncError::CursorExpired`] when retention purged ops above a non-zero `since`; the
/// watermark is read after the ops so any purge that thinned the page is visible.
async fn ops_page(
    pool: &sqlx::PgPool,
    user: Uuid,
    since: i64,
    limit: i64,
) -> SyncResult<PullResponse> {
    let limit = limit.clamp(1, MAX_PULL_LIMIT);
    let rows = sqlx::query_as::<_, OpRow>(
        "SELECT server_seq, op_id, entity, entity_id, field, value, is_delete,
                hlc_wall_ms, hlc_counter, hlc_node
         FROM operations
         WHERE user_id = $1 AND server_seq > $2
         ORDER BY server_seq
         LIMIT $3",
    )
    .bind(user)
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    if since > 0 {
        let watermark: Option<i64> =
            sqlx::query_scalar("SELECT purged_seq FROM sync_purge_watermarks WHERE user_id = $1")
                .bind(user)
                .fetch_optional(pool)
                .await?;
        if watermark.is_some_and(|w| since < w) {
            return Err(SyncError::CursorExpired);
        }
    }

    let cursor = rows.last().map(|r| r.server_seq).unwrap_or(since);
    let operations = rows
        .into_iter()
        .map(OpRow::into_operation)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(PullResponse {
        operations,
        cursor,
        from: since,
    })
}

const MAX_PULL_LIMIT: i64 = 1000;

/// `GET /sync/pull?since=<cursor>&limit=<n>`: ops committed after the cursor, in order.
async fn pull(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<PullQuery>,
) -> SyncResult<Json<PullResponse>> {
    Ok(Json(
        ops_page(&state.pool, user.user_id, q.since, q.limit).await?,
    ))
}

/// Entity keys per snapshot page (each expands to its fields plus at most one tombstone op).
const MAX_SNAPSHOT_KEYS_PER_PAGE: i64 = 1000;

fn default_snapshot_limit() -> i64 {
    100
}

#[derive(Debug, Deserialize)]
pub struct SnapshotQuery {
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default = "default_snapshot_limit")]
    pub limit: i64,
}

#[derive(Debug, Serialize)]
pub struct SnapshotResponse {
    pub operations: Vec<Operation>,
    /// Cursor to pass as `since` on the pull after the last page: the partition's max
    /// `server_seq` when the first page was served. Ops committed during the walk are
    /// re-delivered by that pull (idempotent), not skipped.
    pub cursor: i64,
    /// Opaque token for the next page; absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

struct SnapshotResume {
    entity: String,
    id: Uuid,
    cursor: i64,
}

impl SnapshotResume {
    fn token(entity: &str, id: Uuid, cursor: i64) -> String {
        format!("{entity}/{id}/{cursor}")
    }

    /// A token that does not parse answers 400; the client restarts from page one.
    fn parse(q: &SnapshotQuery) -> AppResult<Option<Self>> {
        let Some(token) = &q.next else {
            return Ok(None);
        };
        let bad = || AppError::BadRequest("malformed snapshot token".into());
        let (entity, rest) = token.split_once('/').ok_or_else(bad)?;
        let (id, cursor) = rest.split_once('/').ok_or_else(bad)?;
        let id = Uuid::parse_str(id).map_err(|_| bad())?;
        let cursor = cursor
            .parse::<i64>()
            .ok()
            .filter(|c| *c >= 0)
            .ok_or_else(bad)?;
        Ok(Some(Self {
            entity: entity.to_string(),
            id,
            cursor,
        }))
    }
}

/// `GET /sync/snapshot?next=<token>&limit=<keys>`: the caller's current materialized state plus
/// the cursor to resume from, so a fresh device folds one bounded snapshot instead of replaying
/// the op log. Same wire shape as pull; pagination is keyset-based and `limit` bounds entity keys
/// per page, clamped to [`MAX_SNAPSHOT_KEYS_PER_PAGE`].
async fn snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<SnapshotQuery>,
) -> AppResult<Json<SnapshotResponse>> {
    let caller = user.user_id;
    let limit = q.limit.clamp(1, MAX_SNAPSHOT_KEYS_PER_PAGE);
    let resume = SnapshotResume::parse(&q)?;

    // The walk's cursor, read on the first page before anything is materialized. Safe because
    // every seq up to this max is committed (SYNC_WRITE_LOCK).
    let cursor = match &resume {
        Some(r) => r.cursor,
        None => partition_head(&mut *state.pool.acquire().await?, caller).await?,
    };
    let (after_entity, after_id) = resume
        .as_ref()
        .map(|r| (r.entity.as_str(), r.id))
        .unwrap_or(("", Uuid::nil()));

    // One key past the page, to know whether a next page exists.
    let mut keys: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT entity, entity_id FROM entity_fields
          WHERE user_id = $1 AND (entity, entity_id) > ($2, $3)
         UNION
         SELECT entity, entity_id FROM entity_tombstones
          WHERE user_id = $1 AND (entity, entity_id) > ($2, $3)
         ORDER BY entity, entity_id
         LIMIT $4",
    )
    .bind(caller)
    .bind(after_entity)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&state.pool)
    .await?;
    let more = keys.len() as i64 > limit;
    keys.truncate(limit as usize);

    let operations = keys_ops(&mut *state.pool.acquire().await?, caller, &keys).await?;

    // The token names the last emitted key, not the peeked one, so nothing between pages is skipped.
    let next = if more {
        keys.last()
            .map(|(entity, id)| SnapshotResume::token(entity, *id, cursor))
    } else {
        None
    };
    Ok(Json(SnapshotResponse {
        operations,
        cursor,
        next,
    }))
}

/// The user's full materialized state as snapshot-shaped ops, unpaged, for `GET /auth/export`.
pub(crate) async fn partition_ops(pool: &sqlx::PgPool, user: Uuid) -> AppResult<Vec<Operation>> {
    let keys: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT entity, entity_id FROM entity_fields
          WHERE user_id = $1
         UNION
         SELECT entity, entity_id FROM entity_tombstones
          WHERE user_id = $1",
    )
    .bind(user)
    .fetch_all(pool)
    .await?;
    keys_ops(&mut *pool.acquire().await?, user, &keys).await
}

/// The socket handshake's query. Not `Debug`: the ticket must never reach a log.
#[derive(Deserialize)]
pub struct WsParams {
    /// The ticket from `POST /sync/ws-ticket` (browsers cannot set WebSocket headers).
    #[serde(default)]
    pub ticket: String,
    #[serde(default)]
    pub since: i64,
}

#[derive(Serialize)]
pub struct WsTicketResponse {
    pub ticket: String,
    pub expires_in: u64,
}

/// `POST /sync/ws-ticket`: a single-use ticket to open the realtime socket, valid for
/// [`WS_TICKET_TTL`]. An access token in the socket URL would sit in proxy logs. The ticket is
/// bound to the caller's user and device, the socket closes when the access token expires, and
/// each connect costs this request from the caller's read budget.
async fn ws_ticket(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<WsTicketResponse>> {
    let ticket = state
        .hub
        .issue_ticket(
            user.user_id,
            user.device_id,
            user.token_expires_at,
            Instant::now(),
        )
        .ok_or(AppError::TooManyRequests)?;
    Ok(Json(WsTicketResponse {
        ticket,
        expires_in: WS_TICKET_TTL.as_secs(),
    }))
}

pub mod close_code {
    /// The live stream overflowed this socket's buffer: reconnect; the backfill covers the gap.
    pub const LAGGED: u16 = 1013;
    pub const BACKFILL_FAILED: u16 = 1011;
    /// The access token expired: refresh it, then reconnect with a new ticket.
    pub const TOKEN_EXPIRED: u16 = 4401;
    /// The session was ended server-side; reconnecting is refused until the device signs in again.
    pub const SESSION_REVOKED: u16 = 4403;
    /// Retention purged ops above the cursor during backfill: bootstrap from the snapshot.
    pub const CURSOR_EXPIRED: u16 = 4410;
}

/// Refuse a socket for an account or session the HTTP API would refuse (missing, disabled,
/// deletion-scheduled, or a revoked device), so a closed socket cannot reconnect on its
/// still-unexpired access token.
async fn check_ws_session(pool: &sqlx::PgPool, user: Uuid, device: Option<Uuid>) -> AppResult<()> {
    let row: Option<(bool, bool, bool)> = sqlx::query_as(
        "SELECT disabled_at IS NOT NULL, deletion_scheduled_at IS NOT NULL,
                $2::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM refresh_tokens
                     WHERE user_id = $1 AND device_id = $2
                       AND revoked_at IS NULL AND expires_at > now())
           FROM users WHERE id = $1",
    )
    .bind(user)
    .bind(device)
    .fetch_optional(pool)
    .await?;
    match row {
        None | Some((_, _, false)) => Err(AppError::Unauthorized),
        Some((true, _, _)) => Err(AppError::AccountDisabled),
        Some((_, true, _)) => Err(AppError::Forbidden("account scheduled for deletion".into())),
        Some((false, false, true)) => Ok(()),
    }
}

struct WsSession {
    user: Uuid,
    expires_at: tokio::time::Instant,
    subscription: Subscription,
    handle: SocketHandle,
}

/// `GET /sync/ws?ticket=<ticket>&since=<cursor>`: authenticated live op stream.
///
/// Redeems a ticket from [`ws_ticket`] (401 if unknown, used or expired), checks the account
/// and session, and reads the first backfill page before upgrading, so a cursor below the purge
/// watermark answers `410 cursor_expired` rather than opening a socket that skipped ops. The
/// socket then receives backfill pages and live ops as [`PullResponse`]s, and closes when its
/// token expires or its session ends (see [`close_code`]).
async fn ws_handler(
    State(state): State<AppState>,
    Query(params): Query<WsParams>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(ticket) = state.hub.redeem_ticket(&params.ticket, Instant::now()) else {
        return AppError::Unauthorized.into_response();
    };
    let user = ticket.user;
    // Registered before the session check, so a session ended in between still closes it.
    let handle = state.hub.register_socket(user, ticket.device);
    if let Err(e) = check_ws_session(&state.pool, user, ticket.device).await {
        return e.into_response();
    }
    // Subscribe before the backfill read so nothing committed in between is missed.
    let subscription = Subscription::new(&state.hub, user);
    let first = match ops_page(&state.pool, user, params.since, MAX_PULL_LIMIT).await {
        Ok(page) => page,
        Err(e) => return e.into_response(),
    };
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let lifetime = Duration::from_secs(ticket.token_expires_at.saturating_sub(now).max(0) as u64);
    let session = WsSession {
        user,
        expires_at: tokio::time::Instant::now() + lifetime,
        subscription,
        handle,
    };
    ws.on_upgrade(move |socket| handle_socket(socket, state, session, first))
}

fn close_message(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

fn payload_message(page: &PullResponse) -> Option<Message> {
    serde_json::to_string(page)
        .ok()
        .map(|s| Message::Text(s.into()))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    session: WsSession,
    first: PullResponse,
) {
    let WsSession {
        user,
        expires_at,
        mut subscription,
        handle,
    } = session;
    let (mut sender, mut receiver) = socket.split();

    // Backfill until drained; a full page means there may be more. Live messages queue meanwhile.
    let mut page = first;
    loop {
        let full = page.operations.len() as i64 >= MAX_PULL_LIMIT;
        let cursor = page.cursor;
        if let Some(msg) = payload_message(&page) {
            if sender.send(msg).await.is_err() {
                return;
            }
        }
        if !full {
            break;
        }
        page = match ops_page(&state.pool, user, cursor, MAX_PULL_LIMIT).await {
            Ok(next) if next.operations.is_empty() => break,
            Ok(next) => next,
            Err(e) => {
                let close = match e {
                    SyncError::CursorExpired => {
                        close_message(close_code::CURSOR_EXPIRED, "cursor_expired")
                    }
                    _ => close_message(close_code::BACKFILL_FAILED, "backfill_failed"),
                };
                let _ = sender.send(close).await;
                return;
            }
        };
    }

    let ping_every = state.hub.ping_interval;
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let expiry = tokio::time::sleep_until(expires_at);
    tokio::pin!(expiry);

    let close = loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                    Some(Ok(_)) => {}
                }
            }
            broadcast = subscription.recv() => {
                match broadcast {
                    Ok(payload) => {
                        if sender.send(Message::Text(payload.into())).await.is_err() {
                            break None;
                        }
                    }
                    // A dropped message leaves a gap: close so the reconnect backfill covers it.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        break Some(close_message(close_code::LAGGED, "lagged"));
                    }
                    Err(broadcast::error::RecvError::Closed) => break None,
                }
            }
            _ = handle.close.notified() => {
                break Some(close_message(close_code::SESSION_REVOKED, "session_revoked"));
            }
            _ = &mut expiry => {
                break Some(close_message(close_code::TOKEN_EXPIRED, "token_expired"));
            }
            _ = ping.tick() => {
                if sender.send(Message::Ping(Default::default())).await.is_err() {
                    break None;
                }
            }
        }
    };
    if let Some(close) = close {
        let _ = sender.send(close).await;
    }
}

#[cfg(test)]
impl SyncHub {
    /// Test-only peek into the channel map.
    fn has_channel(&self, user: Uuid) -> bool {
        self.channels.lock().expect("hub mutex").contains_key(&user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAINTEXT_FIELDS_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/plaintext_fields.json"
    ));

    #[test]
    fn every_server_read_field_is_plaintext_on_the_client() {
        let doc: Value = serde_json::from_str(PLAINTEXT_FIELDS_JSON).unwrap();
        let table = &doc["plaintext_fields"];
        for (entity, fields) in SERVER_READ_FIELDS {
            entity_from_str(entity).unwrap_or_else(|_| panic!("unknown entity {entity}"));
            let listed = &table[*entity];
            for (field, _) in *fields {
                let plaintext = listed == "all"
                    || listed
                        .as_array()
                        .is_some_and(|a| a.iter().any(|f| f == *field));
                assert!(
                    plaintext,
                    "{entity}.{field} is read by the server but plaintext_fields.json lets the \
                     client encrypt it"
                );
            }
        }
    }

    /// Lowercase names in `source` that directly follow `needle` and are closed by `end`.
    fn quoted_after<'a>(source: &'a str, needle: &str, end: char) -> Vec<&'a str> {
        source
            .match_indices(needle)
            .filter_map(|(i, _)| {
                let rest = &source[i + needle.len()..];
                let name = &rest[..rest.find(end)?];
                (!name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
                    .then_some(name)
            })
            .collect()
    }

    #[test]
    fn server_read_fields_cover_every_field_lookup_in_the_source() {
        // A field matched by name only (never by value), or handed back to the client verbatim.
        const NOT_INTERPRETED: &[&str] =
            &["deleted_at", "archived_at", "name", "icon", "color", "kind"];
        let sources = [
            include_str!("sync.rs"),
            include_str!("members.rs"),
            include_str!("attachments.rs"),
            include_str!("restore.rs"),
            include_str!("projects.rs"),
        ];
        let mut seen = Vec::new();
        for src in sources {
            seen.extend(quoted_after(src, "field = '", '\''));
            seen.extend(quoted_after(src, "field == \"", '"'));
            // A field compared against a quoted list of names.
            for (i, _) in src.match_indices("field IN (") {
                let rest = &src[i + "field IN (".len()..];
                let list = &rest[..rest.find(')').unwrap_or(0)];
                seen.extend(
                    list.split(',')
                        .map(|n| n.trim().trim_matches('\''))
                        .filter(|n| {
                            !n.is_empty() && n.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                        }),
                );
            }
        }
        assert!(seen.contains(&"project_id") && seen.contains(&"blob_sha"));
        for field in seen {
            let listed = SERVER_READ_FIELDS
                .iter()
                .any(|(_, fields)| fields.iter().any(|(f, _)| *f == field));
            assert!(
                listed || NOT_INTERPRETED.contains(&field),
                "the server reads `{field}`; add it to SERVER_READ_FIELDS"
            );
        }
    }

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

    #[test]
    fn a_ticket_opens_one_socket_before_it_expires() {
        let hub = SyncHub::default();
        let (user, device) = (Uuid::now_v7(), Some(Uuid::now_v7()));
        let t0 = Instant::now();
        let ticket = hub.issue_ticket(user, device, 42, t0).unwrap();
        assert_eq!(ticket.len(), 64, "256 random bits, hex");
        assert!(ticket.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(hub.issue_ticket(user, device, 42, t0).unwrap(), ticket);

        let redeemed = hub
            .redeem_ticket(&ticket, t0 + Duration::from_secs(29))
            .unwrap();
        assert_eq!(
            (redeemed.user, redeemed.device, redeemed.token_expires_at),
            (user, device, 42)
        );
        assert!(hub.redeem_ticket(&ticket, t0).is_none(), "single use");
        assert!(hub.redeem_ticket("", t0).is_none());

        let late = hub.issue_ticket(user, device, 42, t0).unwrap();
        assert!(
            hub.redeem_ticket(&late, t0 + WS_TICKET_TTL).is_none(),
            "expired"
        );
    }

    #[test]
    fn unredeemed_tickets_are_bounded() {
        let hub = SyncHub::default();
        let user = Uuid::now_v7();
        let t0 = Instant::now();
        let first: Vec<String> = (0..WS_TICKETS_PER_USER as u64)
            .map(|i| {
                hub.issue_ticket(user, None, 0, t0 + Duration::from_millis(i))
                    .unwrap()
            })
            .collect();
        let newest = hub
            .issue_ticket(user, None, 0, t0 + Duration::from_secs(1))
            .unwrap();
        let later = t0 + Duration::from_secs(2);
        assert!(
            hub.redeem_ticket(&first[0], later).is_none(),
            "a user's oldest ticket makes room"
        );
        assert!(hub.redeem_ticket(&first[1], later).is_some());
        assert!(hub.redeem_ticket(&newest, later).is_some());

        let full = SyncHub::default();
        for _ in 0..MAX_WS_TICKETS {
            full.issue_ticket(Uuid::now_v7(), None, 0, t0).unwrap();
        }
        assert!(
            full.issue_ticket(Uuid::now_v7(), None, 0, t0).is_none(),
            "no room while every ticket is live"
        );
        assert!(
            full.issue_ticket(Uuid::now_v7(), None, 0, t0 + WS_TICKET_TTL)
                .is_some(),
            "expired tickets are swept to make room"
        );
    }

    #[test]
    fn channel_pruned_after_last_receiver_drops() {
        let hub = SyncHub::default();
        let user = Uuid::nil();
        let rx1 = hub.subscribe(user);
        let rx2 = hub.subscribe(user);

        drop(rx1);
        hub.unsubscribe(user);
        assert!(
            hub.has_channel(user),
            "channel must stay while another receiver is alive"
        );

        drop(rx2);
        hub.unsubscribe(user);
        assert!(
            !hub.has_channel(user),
            "channel must be pruned when the last receiver drops"
        );

        // A later reconnect starts fresh.
        let _rx3 = hub.subscribe(user);
        assert!(hub.has_channel(user));
    }
}
