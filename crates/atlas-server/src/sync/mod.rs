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
//! - [`legacy`]: `POST /sync/legacy/drop`, a client dropping the rows it migrated.

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

/// Begin a transaction that may insert into `operations`, holding [`SYNC_WRITE_LOCK`].
pub(crate) async fn begin_sync_write(
    pool: &sqlx::PgPool,
) -> AppResult<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    take_sync_write_lock(&mut tx).await?;
    Ok(tx)
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
