//! Personal API tokens, for integrations (n8n, scripts) that act as the account without a
//! password.
//!
//! The server never sees a token. The client generates it (`atlas_pat_` + base64url of a 16-byte
//! id and a 32-byte secret) and derives two values from the secret: an auth value, whose hex
//! SHA-256 is stored here, and a wrapping key, under which it uploads a copy of the account's DEK
//! and X25519 private key. Presenting the id and auth value to `POST /auth/api-token/session`
//! opens a session: an access token of kind [`TokenKind::ApiToken`] (no refresh token; the holder
//! exchanges again) plus the wrapped keys, which only the token's secret opens. The data stays
//! end-to-end encrypted.
//!
//! A token session reaches the data routes (sync, project keys, members, attachments) but not
//! the account-critical ones ([`super::InteractiveAuthUser`]). Revoking a token ends its sessions
//! on their next request and drops its wrapped keys.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use super::token::{hash_refresh_token, issue_access_token_of_kind, TokenKind};
use super::InteractiveAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How many unrevoked tokens one account may hold.
pub const MAX_LIVE_TOKENS: i64 = 25;
const MAX_NAME_LEN: usize = 100;
/// The auth value is 32 bytes, sent as lowercase hex.
const AUTH_LEN: usize = 64;
/// Cap on one serialized wrapped key; a real one is well under 1 KiB.
const MAX_WRAP_BYTES: usize = 4096;

#[derive(Debug, Deserialize)]
pub struct CreateApiTokenRequest {
    /// Client-chosen: the wraps' associated data binds it, so it must exist before the upload.
    pub id: Uuid,
    pub name: String,
    pub auth: String,
    pub wrapped_dek: serde_json::Value,
    pub wrapped_private_key: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ApiTokenView {
    pub id: Uuid,
    pub name: String,
    /// Unix millis, like the session list.
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ApiTokenSessionRequest {
    pub token_id: Uuid,
    pub auth: String,
}

#[derive(Debug, Serialize)]
pub struct ApiTokenSessionResponse {
    pub access_token: String,
    pub expires_in: i64,
    pub token_id: Uuid,
    pub user_id: Uuid,
    pub wrapped_dek: serde_json::Value,
    pub wrapped_private_key: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_signing_key: Option<serde_json::Value>,
}

fn validate_auth(auth: &str) -> AppResult<()> {
    let ok = auth.len() == AUTH_LEN && auth.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !ok {
        return Err(AppError::BadRequest(
            "auth must be 64 characters of lowercase hex".into(),
        ));
    }
    Ok(())
}

fn validate_wrap(field: &str, value: &serde_json::Value) -> AppResult<()> {
    let too_big = serde_json::to_vec(value).map_or(true, |v| v.len() > MAX_WRAP_BYTES);
    if !value.is_object() || too_big {
        return Err(AppError::BadRequest(format!(
            "{field} must be a wrapped key object"
        )));
    }
    Ok(())
}

fn millis(t: OffsetDateTime) -> i64 {
    t.unix_timestamp() * 1000
}

/// `POST /auth/api-tokens`: register a token the client generated. 409 when the id is taken or
/// the account already holds [`MAX_LIVE_TOKENS`].
pub async fn create(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<CreateApiTokenRequest>,
) -> AppResult<(StatusCode, Json<ApiTokenView>)> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(
            "a token name of 1-100 bytes is required".into(),
        ));
    }
    validate_auth(&req.auth)?;
    validate_wrap("wrapped_dek", &req.wrapped_dek)?;
    validate_wrap("wrapped_private_key", &req.wrapped_private_key)?;

    let mut tx = state.pool.begin().await?;
    // Serialize concurrent creates for one account so the cap holds.
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if live >= MAX_LIVE_TOKENS {
        return Err(AppError::Conflict(format!(
            "the limit of {MAX_LIVE_TOKENS} API tokens"
        )));
    }
    let created_at: Option<OffsetDateTime> = sqlx::query_scalar(
        "INSERT INTO api_tokens (id, user_id, name, auth_hash, wrapped_dek, wrapped_private_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING created_at",
    )
    .bind(req.id)
    .bind(user.user_id)
    .bind(name)
    .bind(hash_refresh_token(&req.auth))
    .bind(&req.wrapped_dek)
    .bind(&req.wrapped_private_key)
    .fetch_optional(&mut *tx)
    .await?;
    let created_at =
        created_at.ok_or_else(|| AppError::Conflict("an API token with this id".into()))?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(ApiTokenView {
            id: req.id,
            name: name.to_string(),
            created_at: millis(created_at),
            last_used_at: None,
        }),
    ))
}

/// `GET /auth/api-tokens`: the caller's unrevoked tokens, newest first. Never any secret.
pub async fn list(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<Vec<ApiTokenView>>> {
    let rows: Vec<(Uuid, String, OffsetDateTime, Option<OffsetDateTime>)> = sqlx::query_as(
        "SELECT id, name, created_at, last_used_at FROM api_tokens
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, created_at, last_used_at)| ApiTokenView {
                id,
                name,
                created_at: millis(created_at),
                last_used_at: last_used_at.map(millis),
            })
            .collect(),
    ))
}

/// `DELETE /auth/api-tokens/:id`: revoke a token; 404 when unknown or already revoked.
pub async fn revoke(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let res = sqlx::query(
        "UPDATE api_tokens
            SET revoked_at = now(), wrapped_dek = NULL, wrapped_private_key = NULL
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(id)
    .bind(user.user_id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.close_device_sockets(user.user_id, id);
    Ok(StatusCode::NO_CONTENT)
}

/// Revoke every token of `user_id` (account recovery, account deletion). The caller closes the
/// account's sockets.
pub async fn revoke_all(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE api_tokens
            SET revoked_at = now(), wrapped_dek = NULL, wrapped_private_key = NULL
          WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(executor)
    .await?;
    Ok(())
}

/// `POST /auth/api-token/session`: open a session with a token. Every refusal (unknown, revoked,
/// wrong auth) is a plain 401, except a disabled or deletion-scheduled account's typed 403s,
/// which only someone holding the token gets. IP rate-limited with the rest of `/auth/*`; the
/// auth value has 256 bits of entropy, so there is nothing to guess.
pub async fn open_session(
    State(state): State<AppState>,
    Json(req): Json<ApiTokenSessionRequest>,
) -> AppResult<Json<ApiTokenSessionResponse>> {
    if validate_auth(&req.auth).is_err() {
        return Err(AppError::Unauthorized);
    }
    #[derive(sqlx::FromRow)]
    struct Row {
        user_id: Uuid,
        wrapped_dek: Option<serde_json::Value>,
        wrapped_private_key: Option<serde_json::Value>,
        disabled: bool,
        deletion_scheduled_at: Option<OffsetDateTime>,
        public_key: Option<String>,
        signing_public_key: Option<String>,
        encrypted_signing_key: Option<serde_json::Value>,
    }
    let row: Row = sqlx::query_as(
        "UPDATE api_tokens t SET last_used_at = now()
           FROM users u
          WHERE t.id = $1 AND t.auth_hash = $2 AND t.revoked_at IS NULL AND u.id = t.user_id
      RETURNING t.user_id, t.wrapped_dek, t.wrapped_private_key,
                u.disabled_at IS NOT NULL AS disabled, u.deletion_scheduled_at,
                u.public_key, u.signing_public_key, u.encrypted_signing_key",
    )
    .bind(req.token_id)
    .bind(hash_refresh_token(&req.auth))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    if row.disabled {
        return Err(AppError::AccountDisabled);
    }
    if let Some(scheduled_at) = row.deletion_scheduled_at {
        return Err(super::handlers::scheduled_deletion_error(scheduled_at));
    }
    let (Some(wrapped_dek), Some(wrapped_private_key)) = (row.wrapped_dek, row.wrapped_private_key)
    else {
        return Err(AppError::Unauthorized);
    };
    let access_token = issue_access_token_of_kind(
        row.user_id,
        req.token_id,
        Some(TokenKind::ApiToken),
        state.config.access_ttl_seconds,
        &state.config.jwt_secret,
        OffsetDateTime::now_utc().unix_timestamp(),
    )
    .map_err(|_| AppError::Internal)?;
    Ok(Json(ApiTokenSessionResponse {
        access_token,
        expires_in: state.config.access_ttl_seconds,
        token_id: req.token_id,
        user_id: row.user_id,
        wrapped_dek,
        wrapped_private_key,
        public_key: row.public_key,
        signing_public_key: row.signing_public_key,
        encrypted_signing_key: row.encrypted_signing_key,
    }))
}
