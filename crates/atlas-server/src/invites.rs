//! Signup invites: single-use codes that let one person create an account on a closed instance.
//!
//! A code is addressed to one signup, expires and can be revoked. Only a SHA-256 of each code is
//! stored ([`hash_code`]); the code is shown once, so a database dump hands out no door-openers.
//! Consumption happens in the signup transaction ([`lock_valid`], [`mark_used`]), so an invite is
//! burned exactly when its account is created.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin::AdminUser;
use crate::audit;
use crate::auth::token::{generate_refresh_token, hash_refresh_token};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Default lifetime of a fresh invite, in days.
const DEFAULT_VALIDITY_DAYS: i32 = 7;

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/invites", get(list_invites).post(create_invite))
        .route("/admin/invites/{id}", delete(revoke_invite))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AdminInviteView {
    pub id: Uuid,
    /// The code itself: only in the response that creates the invite, null elsewhere.
    #[sqlx(skip)]
    pub code: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub used_at_ms: Option<i64>,
    pub used_by_email: Option<String>,
    pub revoked_at_ms: Option<i64>,
}

/// Wire columns for [`AdminInviteView`]; timestamps go out as Unix milliseconds.
const INVITE_COLUMNS: &str = "i.id, \
     (EXTRACT(EPOCH FROM i.created_at) * 1000)::BIGINT AS created_at_ms, \
     (EXTRACT(EPOCH FROM i.expires_at) * 1000)::BIGINT AS expires_at_ms, \
     (EXTRACT(EPOCH FROM i.used_at) * 1000)::BIGINT AS used_at_ms, \
     u.email AS used_by_email, \
     (EXTRACT(EPOCH FROM i.revoked_at) * 1000)::BIGINT AS revoked_at_ms";

/// The stored form of an invite code: hex SHA-256. A code carries 256 bits of entropy, so an
/// unsalted fast hash makes a leaked hash useless.
pub fn hash_code(code: &str) -> String {
    hash_refresh_token(code)
}

/// Find a still-valid invite by code and lock it for the caller's transaction, so no concurrent
/// signup can spend it too. `None` for any bad code. Signup checks this before anything else:
/// a 409 for a duplicate email ahead of a bogus code's 403 would reveal which addresses have
/// accounts.
pub async fn lock_valid(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    code: &str,
) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM invites
          WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE",
    )
    .bind(hash_code(code))
    .fetch_optional(executor)
    .await?)
}

/// Spend an invite [`lock_valid`] returned, in the transaction that created `user_id`.
pub async fn mark_used(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    invite_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query("UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1")
        .bind(invite_id)
        .bind(user_id)
        .execute(executor)
        .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct CreateInviteRequest {
    #[serde(default)]
    days_valid: Option<i32>,
}

/// `POST /admin/invites`: mint a single-use code.
async fn create_invite(
    State(state): State<AppState>,
    admin: AdminUser,
    body: Option<Json<CreateInviteRequest>>,
) -> AppResult<(StatusCode, Json<AdminInviteView>)> {
    let days = body
        .map(|Json(b)| b)
        .and_then(|b| b.days_valid)
        .unwrap_or(DEFAULT_VALIDITY_DAYS)
        .clamp(1, 365);
    let id = Uuid::now_v7();
    // The refresh-token generator: 256 bits of entropy, hex-encoded; one randomness story to audit.
    let code = generate_refresh_token().plaintext;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO invites (id, code_hash, created_by, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    )
    .bind(id)
    .bind(hash_code(&code))
    .bind(admin.user_id)
    .bind(days)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        admin.user_id,
        "invite.create",
        None,
        serde_json::json!({ "invite_id": id, "days_valid": days }),
    )
    .await?;
    tx.commit().await?;
    let mut view = fetch_invite_view(&state.pool, id).await?;
    view.code = Some(code);
    Ok((StatusCode::CREATED, Json(view)))
}

/// One invite, joined to its consumer's email (INSERT ... RETURNING cannot reach `users`).
async fn fetch_invite_view(pool: &sqlx::PgPool, id: Uuid) -> AppResult<AdminInviteView> {
    let sql = format!(
        "SELECT {INVITE_COLUMNS}
           FROM invites i
           LEFT JOIN users u ON u.id = i.used_by
          WHERE i.id = $1"
    );
    sqlx::query_as::<_, AdminInviteView>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    limit: Option<i64>,
}

/// `GET /admin/invites`: newest first, used and revoked included.
async fn list_invites(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<AdminInviteView>>> {
    let rows = sqlx::query_as::<_, AdminInviteView>(sqlx::AssertSqlSafe(format!(
        "SELECT {INVITE_COLUMNS}
           FROM invites i
           LEFT JOIN users u ON u.id = i.used_by
          ORDER BY i.created_at DESC
          LIMIT $1"
    )))
    .bind(q.limit.unwrap_or(50).clamp(1, 100))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// `DELETE /admin/invites/:id`: revoke an unused invite; a used one is a 404.
async fn revoke_invite(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let res = sqlx::query(
        "UPDATE invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(
        &mut *tx,
        admin.user_id,
        "invite.revoke",
        None,
        serde_json::json!({ "invite_id": id }),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
