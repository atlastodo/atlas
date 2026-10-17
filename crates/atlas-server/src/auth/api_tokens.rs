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
//!
//! A token is scoped to apps (`apps`, todo when the client names none): it carries a copy of each
//! of their keys and identities, and its sessions may sync only those apps
//! ([`crate::apps::SessionApps`]). The todo key travels as `wrapped_dek` / `wrapped_private_key`
//! as before; every other app's in `app_keys`. Never the account root key.

use std::collections::BTreeMap;

use atlas_core::Registry;
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

/// The app whose key a token carries as `wrapped_dek` (the account's DEK).
const TODO_APP: &str = "todo";

/// One non-todo app's key and X25519 identity, wrapped for a token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenAppKey {
    pub wrapped_key: serde_json::Value,
    pub wrapped_private_key: serde_json::Value,
}

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
    /// The apps the token is for; todo when absent (every client predating app-scoped tokens).
    #[serde(default)]
    pub apps: Option<Vec<String>>,
    /// The todo key and identity: required when the token is for todo, refused otherwise.
    #[serde(default)]
    pub wrapped_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub wrapped_private_key: Option<serde_json::Value>,
    /// Every other app's key and identity, one entry per app the token is for.
    #[serde(default)]
    pub app_keys: BTreeMap<String, TokenAppKey>,
}

#[derive(Debug, Serialize)]
pub struct ApiTokenView {
    pub id: Uuid,
    pub name: String,
    /// The apps the token carries keys for and may sync.
    pub apps: Vec<String>,
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
    /// The apps this session may sync (`x-atlas-sync-apps` names a subset).
    pub apps: Vec<String>,
    /// The todo key and identity; absent for a token without todo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapped_dek: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapped_private_key: Option<serde_json::Value>,
    /// Every other app's key and identity, by app.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub app_keys: BTreeMap<String, TokenAppKey>,
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

/// The token's apps, checked against what the request wraps: bundled ids, sorted, deduplicated,
/// at least one; the todo wraps present exactly when todo is listed, and one `app_keys` entry
/// for every other app and none besides.
fn check_token_apps(req: &CreateApiTokenRequest) -> AppResult<Vec<String>> {
    let mut apps = req.apps.clone().unwrap_or_else(|| vec![TODO_APP.into()]);
    apps.sort();
    apps.dedup();
    if apps.is_empty() {
        return Err(AppError::BadRequest(
            "a token is for at least one app".into(),
        ));
    }
    let registry = Registry::bundled();
    if let Some(app) = apps.iter().find(|a| registry.app(a).is_none()) {
        return Err(AppError::BadRequest(format!(
            "{app} is not an app this server bundles"
        )));
    }
    let todo = apps.iter().any(|a| a == TODO_APP);
    match (todo, &req.wrapped_dek, &req.wrapped_private_key) {
        (true, Some(dek), Some(private_key)) => {
            validate_wrap("wrapped_dek", dek)?;
            validate_wrap("wrapped_private_key", private_key)?;
        }
        (true, _, _) => {
            return Err(AppError::BadRequest(
                "a todo token needs wrapped_dek and wrapped_private_key".into(),
            ))
        }
        (false, None, None) => {}
        (false, _, _) => {
            return Err(AppError::BadRequest(
                "a token without todo carries no todo key".into(),
            ))
        }
    }
    for app in apps.iter().filter(|a| *a != TODO_APP) {
        let key = req
            .app_keys
            .get(app)
            .ok_or_else(|| AppError::BadRequest(format!("app_keys has no entry for {app}")))?;
        validate_wrap("app_keys.wrapped_key", &key.wrapped_key)?;
        validate_wrap("app_keys.wrapped_private_key", &key.wrapped_private_key)?;
    }
    if req
        .app_keys
        .keys()
        .any(|app| !apps.contains(app) || app == TODO_APP)
    {
        return Err(AppError::BadRequest(
            "app_keys holds an app the token is not for".into(),
        ));
    }
    Ok(apps)
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
    let apps = check_token_apps(&req)?;
    // A token acts within the account's enabled apps, and a non-todo app's key exists only once
    // the account enabled it (`PUT /auth/app-keys/:app`).
    crate::apps::SessionApps::resolve(&state, user.user_id, None, Some(apps.clone())).await?;
    let keyed: Vec<String> =
        sqlx::query_scalar("SELECT app FROM account_app_keys WHERE user_id = $1 AND app = ANY($2)")
            .bind(user.user_id)
            .bind(&apps)
            .fetch_all(&state.pool)
            .await?;
    if let Some(app) = apps.iter().find(|a| *a != TODO_APP && !keyed.contains(a)) {
        return Err(AppError::BadRequest(format!(
            "the account has no {app} key to give a token"
        )));
    }
    let app_keys = (!req.app_keys.is_empty())
        .then(|| serde_json::to_value(&req.app_keys))
        .transpose()
        .map_err(|_| AppError::Internal)?;

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
        "INSERT INTO api_tokens
            (id, user_id, name, auth_hash, wrapped_dek, wrapped_private_key, apps, app_keys)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING created_at",
    )
    .bind(req.id)
    .bind(user.user_id)
    .bind(name)
    .bind(hash_refresh_token(&req.auth))
    .bind(&req.wrapped_dek)
    .bind(&req.wrapped_private_key)
    .bind(&apps)
    .bind(&app_keys)
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
            apps,
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
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        Uuid,
        String,
        Vec<String>,
        OffsetDateTime,
        Option<OffsetDateTime>,
    )> = sqlx::query_as(
        "SELECT id, name, apps, created_at, last_used_at FROM api_tokens
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, apps, created_at, last_used_at)| ApiTokenView {
                id,
                name,
                apps,
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
            SET revoked_at = now(), wrapped_dek = NULL, wrapped_private_key = NULL, app_keys = NULL
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
            SET revoked_at = now(), wrapped_dek = NULL, wrapped_private_key = NULL, app_keys = NULL
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
        apps: Vec<String>,
        app_keys: Option<serde_json::Value>,
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
      RETURNING t.user_id, t.wrapped_dek, t.wrapped_private_key, t.apps, t.app_keys,
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
    // Every app the token is for must still have its wraps (revoking nulls them).
    let app_keys: BTreeMap<String, TokenAppKey> = match row.app_keys {
        Some(v) => serde_json::from_value(v).map_err(|_| AppError::Internal)?,
        None => BTreeMap::new(),
    };
    let todo = row.apps.iter().any(|a| a == TODO_APP);
    let todo_wrapped = row.wrapped_dek.is_some() && row.wrapped_private_key.is_some();
    let complete = row
        .apps
        .iter()
        .filter(|a| *a != TODO_APP)
        .all(|a| app_keys.contains_key(a));
    if row.apps.is_empty() || (todo && !todo_wrapped) || !complete {
        return Err(AppError::Unauthorized);
    }
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
        apps: row.apps,
        wrapped_dek: row.wrapped_dek.filter(|_| todo),
        wrapped_private_key: row.wrapped_private_key.filter(|_| todo),
        app_keys,
        public_key: row.public_key,
        signing_public_key: row.signing_public_key,
        encrypted_signing_key: row.encrypted_signing_key,
    }))
}
