//! The realtime socket: `POST /sync/ws-ticket` issues a single-use ticket, and `GET /sync/ws`
//! redeems it for a live stream of pull-shaped messages.

use std::time::{Duration, Instant};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::hub::{SocketHandle, Subscription, WS_TICKET_TTL};
use super::pull::{ops_page, MAX_PULL_LIMIT};
use super::{PullResponse, SyncError};
use crate::apps::EnabledApps;
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

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
pub(super) async fn ws_ticket(
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
pub(super) async fn ws_handler(
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
    let apps = match EnabledApps::load(&state, user).await {
        Ok(apps) => apps,
        Err(e) => return e.into_response(),
    };
    let first = match ops_page(&state.pool, &apps, user, params.since, MAX_PULL_LIMIT).await {
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
    ws.on_upgrade(move |socket| handle_socket(socket, state, session, apps, first))
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
    apps: EnabledApps,
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
        page = match ops_page(&state.pool, &apps, user, cursor, MAX_PULL_LIMIT).await {
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
