//! The account root key and the per-app keys under it.
//!
//! A random 32-byte root key sits above one key per app. The unlock slots wrap the root: the
//! password-derived MEK (`users.encrypted_root_key`), the recovery phrase
//! (`users.recovery_encrypted_root_key`) and each passkey (`passkeys.encrypted_root_key`, see
//! [`super::passkeys`]). The root wraps each app's key (`account_app_keys`); the account's original
//! DEK is the `todo` app's key, unchanged.
//!
//! The server sees only ciphertext and checks shapes. The rules it does enforce:
//! - Every route here is interactive ([`InteractiveAuthUser`]): an API-token session, which holds a
//!   copy of the todo key, never reads or writes the root key or another app's key.
//! - The root is set once ([`migrate`]): a second device migrating at the same time gets 409
//!   `root_key_exists` and loads the stored one. Only a password change, a KDF upgrade and a
//!   recovery re-wrap it (`handlers.rs`), in the UPDATE that swaps the credential.
//! - A client predating root keys keeps working: its credential writes carry no root slot, and
//!   [`drop_for_legacy_write`] then removes the root (the next new client re-creates it), unless an
//!   app other than `todo` holds a key, whose loss would be data loss.

use atlas_core::Registry;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::InteractiveAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The app whose key is the account's original DEK.
pub const TODO_APP: &str = "todo";
/// A wrapped 32-byte key is a small JSON object; anything much larger is not one.
const MAX_WRAP_BYTES: usize = 1024;
/// How many app keys one request may carry; there are a handful of apps.
const MAX_APP_KEYS: usize = 16;

/// An app key as a client uploads it.
#[derive(Debug, Clone, Deserialize)]
pub struct AppKeyInput {
    pub app: String,
    pub wrapped_key: Value,
    #[serde(default)]
    pub wrapped_private_key: Option<Value>,
}

/// An app key as stored and returned to the account's interactive sessions.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AppKeyView {
    pub app: String,
    pub wrapped_key: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapped_private_key: Option<Value>,
}

/// App names are short lowercase identifiers (mirrors the table's CHECK).
pub fn validate_app(app: &str) -> AppResult<()> {
    let mut bytes = app.bytes();
    let ok = app.len() <= 32
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'));
    if !ok {
        return Err(AppError::BadRequest(
            "app must be a short lowercase identifier".into(),
        ));
    }
    Ok(())
}

/// An app id this build bundles (`Registry::bundled`); 400 for any other.
pub fn validate_bundled_app(app: &str) -> AppResult<()> {
    validate_app(app)?;
    if Registry::bundled().app(app).is_none() {
        return Err(AppError::BadRequest(format!(
            "{app} is not an app this server bundles"
        )));
    }
    Ok(())
}

/// A bundled app the instance offers (`ATLAS_APPS`): 400 for an id the build does not bundle, 403
/// `app_not_enabled` with scope `instance` for one the instance has off.
pub fn check_offered_app(state: &AppState, app: &str) -> AppResult<()> {
    validate_bundled_app(app)?;
    if !state.config.apps.iter().any(|a| a == app) {
        return Err(AppError::AppNotEnabled {
            app: app.to_owned(),
            scope: "instance",
        });
    }
    Ok(())
}

/// A wrapped key: an object with string `iv` and `ct` and nothing large.
pub fn validate_wrap(field: &str, value: &Value) -> AppResult<()> {
    let shaped = value.as_object().is_some_and(|o| {
        o.get("iv").is_some_and(Value::is_string) && o.get("ct").is_some_and(Value::is_string)
    });
    if !shaped || value.to_string().len() > MAX_WRAP_BYTES {
        return Err(AppError::BadRequest(format!(
            "{field} must be a wrapped key object"
        )));
    }
    Ok(())
}

/// A recovery slot: a wrapped key, plus `epk` (32 bytes of lowercase hex) in the sealed form.
pub fn validate_recovery_slot(value: &Value) -> AppResult<()> {
    validate_wrap("recovery_encrypted_root_key", value)?;
    match value.get("epk") {
        None => Ok(()),
        Some(Value::String(epk)) if super::identity::is_hex_key(epk) => Ok(()),
        Some(_) => Err(AppError::BadRequest(
            "recovery_encrypted_root_key.epk must be 32 bytes of lowercase hex".into(),
        )),
    }
}

/// Validate a set of app keys; `todo` must be among them (it is the key every account has).
pub fn validate_app_keys(keys: &[AppKeyInput]) -> AppResult<()> {
    if keys.len() > MAX_APP_KEYS {
        return Err(AppError::BadRequest("too many app keys".into()));
    }
    for (i, key) in keys.iter().enumerate() {
        validate_bundled_app(&key.app)?;
        validate_wrap("wrapped_key", &key.wrapped_key)?;
        if let Some(private_key) = &key.wrapped_private_key {
            validate_wrap("wrapped_private_key", private_key)?;
        }
        if keys[..i].iter().any(|k| k.app == key.app) {
            return Err(AppError::BadRequest(format!("app key {} twice", key.app)));
        }
    }
    if !keys.iter().any(|k| k.app == TODO_APP) {
        return Err(AppError::BadRequest(
            "app_keys must include the todo key".into(),
        ));
    }
    Ok(())
}

/// The account's app keys, by app name.
pub async fn load_app_keys(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    user_id: Uuid,
) -> AppResult<Vec<AppKeyView>> {
    Ok(sqlx::query_as::<_, AppKeyView>(
        "SELECT app, wrapped_key, wrapped_private_key FROM account_app_keys
          WHERE user_id = $1 ORDER BY app",
    )
    .bind(user_id)
    .fetch_all(executor)
    .await?)
}

/// Replace every app key of `user_id` with `keys` (a new root makes the old rows unopenable).
pub async fn replace_app_keys(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    keys: &[AppKeyInput],
) -> AppResult<()> {
    sqlx::query("DELETE FROM account_app_keys WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    for key in keys {
        sqlx::query(
            "INSERT INTO account_app_keys (user_id, app, wrapped_key, wrapped_private_key)
             VALUES ($1, $2, $3, $4)",
        )
        .bind(user_id)
        .bind(&key.app)
        .bind(&key.wrapped_key)
        .bind(&key.wrapped_private_key)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// A credential write from a client that predates root keys left the root slots unchanged, so
/// they no longer match the new password (or phrase). Drop the root and its app keys, which the
/// next sign-in on a current client re-creates from the DEK, still reachable through the legacy
/// wraps. Refused with [`AppError::RootKeyRequired`] when an app other than `todo` holds a key:
/// nothing but the root reaches that one. Runs in the transaction of the credential write.
pub async fn drop_for_legacy_write(conn: &mut sqlx::PgConnection, user_id: Uuid) -> AppResult<()> {
    let other_apps: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM account_app_keys WHERE user_id = $1 AND app <> $2)",
    )
    .bind(user_id)
    .bind(TODO_APP)
    .fetch_one(&mut *conn)
    .await?;
    if other_apps {
        return Err(AppError::RootKeyRequired);
    }
    sqlx::query(
        "UPDATE users SET root_key_created_at = NULL, encrypted_root_key = NULL,
                recovery_encrypted_root_key = NULL
          WHERE id = $1",
    )
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM account_app_keys WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    // The passkeys wrap the dropped root: nothing they unlock is left.
    super::handlers::drop_passkeys(conn, user_id).await?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct RootKeyResponse {
    /// Whether the account has a root key; a passkey-only account (later) has no password slot.
    pub has_root_key: bool,
    pub encrypted_root_key: Option<Value>,
    pub has_recovery_root_key: bool,
    pub recovery_public_key: Option<String>,
    pub app_keys: Vec<AppKeyView>,
}

/// `GET /auth/root-key`: the caller's password-wrapped root key and app keys (both empty for an
/// account not migrated yet). The recovery slot itself is not returned, only whether it is set.
pub async fn get(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<RootKeyResponse>> {
    let (has_root_key, encrypted_root_key, has_recovery_root_key, recovery_public_key): (
        bool,
        Option<Value>,
        bool,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT root_key_created_at IS NOT NULL, encrypted_root_key,
                recovery_encrypted_root_key IS NOT NULL, recovery_public_key
           FROM users WHERE id = $1",
    )
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let app_keys = load_app_keys(&state.pool, user.user_id).await?;
    Ok(Json(RootKeyResponse {
        has_root_key,
        encrypted_root_key,
        has_recovery_root_key,
        recovery_public_key,
        app_keys,
    }))
}

#[derive(Debug, Deserialize)]
pub struct MigrateRequest {
    /// The current auth hash: a bearer token alone must not install a root key.
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
    pub encrypted_root_key: Value,
    /// The root sealed to (or wrapped under) the recovery key. Optional: an account without a
    /// phrase-derived recovery key has no recovery slot until it registers one.
    #[serde(default)]
    pub recovery_encrypted_root_key: Option<Value>,
    /// The recovery public key a sealed slot was sealed to; the write lands only while it is
    /// still the account's (a phrase replaced meanwhile would make the slot dead).
    #[serde(default)]
    pub recovery_public_key: Option<String>,
    pub app_keys: Vec<AppKeyInput>,
}

/// `POST /auth/root-key`: migrate an account created before root keys. Sets the root slots and the
/// app keys (the todo key at least) in one transaction, only while the account has no root key:
/// otherwise 409 `root_key_exists`, and the client loads the stored root instead.
pub async fn migrate(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<MigrateRequest>,
) -> AppResult<StatusCode> {
    validate_wrap("encrypted_root_key", &req.encrypted_root_key)?;
    if let Some(slot) = &req.recovery_encrypted_root_key {
        validate_recovery_slot(slot)?;
    }
    validate_app_keys(&req.app_keys)?;
    let password_hash = super::handlers::verify_password_hash(
        &state,
        user.user_id,
        req.current_password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let sealed_to = req
        .recovery_public_key
        .as_deref()
        .map(|k| k.trim().to_ascii_lowercase());
    if req.recovery_encrypted_root_key.is_some() && sealed_to.is_none() {
        return Err(AppError::BadRequest(
            "recovery_public_key names the key the recovery slot was made for".into(),
        ));
    }

    let mut tx = state.pool.begin().await?;
    let root_exists: Option<bool> = sqlx::query_scalar(
        "SELECT root_key_created_at IS NOT NULL FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    match root_exists {
        None => return Err(AppError::Unauthorized),
        Some(true) => return Err(AppError::RootKeyExists),
        Some(false) => {}
    }
    let updated = sqlx::query(
        "UPDATE users
            SET root_key_created_at = now(),
                encrypted_root_key = $2,
                recovery_encrypted_root_key = CASE
                    WHEN $3::jsonb IS NOT NULL AND recovery_public_key = $4 THEN $3::jsonb
                    ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND root_key_created_at IS NULL AND password_hash IS NOT DISTINCT FROM $5",
    )
    .bind(user.user_id)
    .bind(&req.encrypted_root_key)
    .bind(&req.recovery_encrypted_root_key)
    .bind(&sealed_to)
    .bind(&password_hash)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        // The password changed between the check and the write.
        return Err(AppError::InvalidCredentials);
    }
    replace_app_keys(&mut tx, user.user_id, &req.app_keys).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PutRecoverySlotRequest {
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
    pub recovery_public_key: String,
    pub recovery_encrypted_root_key: Value,
}

/// `PUT /auth/root-key/recovery`: fill an empty recovery slot for an account that has a root key,
/// e.g. after it registered its phrase-derived recovery key, or after a client predating root keys
/// replaced the phrase (which empties the slot). Lands only while `recovery_public_key` is still
/// the account's; a set slot is 409 `key_already_stored`.
pub async fn put_recovery_slot(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<PutRecoverySlotRequest>,
) -> AppResult<StatusCode> {
    validate_recovery_slot(&req.recovery_encrypted_root_key)?;
    let password_hash = super::handlers::verify_password_hash(
        &state,
        user.user_id,
        req.current_password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let key = req.recovery_public_key.trim().to_ascii_lowercase();
    #[derive(sqlx::FromRow)]
    struct Row {
        has_root: bool,
        has_slot: bool,
        recovery_public_key: Option<String>,
    }
    let row: Row = sqlx::query_as(
        "SELECT root_key_created_at IS NOT NULL AS has_root,
                recovery_encrypted_root_key IS NOT NULL AS has_slot, recovery_public_key
           FROM users WHERE id = $1",
    )
    .bind(user.user_id)
    .fetch_one(&state.pool)
    .await?;
    if !row.has_root {
        return Err(AppError::BadRequest("the account has no root key".into()));
    }
    if row.has_slot {
        return Err(AppError::KeyAlreadyStored("the recovery root key"));
    }
    if row.recovery_public_key.as_deref() != Some(key.as_str()) {
        return Err(AppError::BadRequest(
            "recovery_public_key is not the account's recovery key".into(),
        ));
    }
    let updated = sqlx::query(
        "UPDATE users SET recovery_encrypted_root_key = $2, updated_at = now()
          WHERE id = $1 AND recovery_encrypted_root_key IS NULL AND root_key_created_at IS NOT NULL
            AND recovery_public_key = $3 AND password_hash IS NOT DISTINCT FROM $4",
    )
    .bind(user.user_id)
    .bind(&req.recovery_encrypted_root_key)
    .bind(&key)
    .bind(&password_hash)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::KeyAlreadyStored("the recovery root key"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct PutAppKeyRequest {
    pub wrapped_key: Value,
    #[serde(default)]
    pub wrapped_private_key: Option<Value>,
}

/// `PUT /auth/app-keys/:app`: store a new app's key, wrapped under the root key. Set once: an app
/// that has a key is 409 `key_already_stored`. Needs a migrated account. Only for an app this
/// build bundles (400 otherwise) and the instance offers (403 `app_not_enabled`, scope
/// `instance`): a key row for any other id would sit under the root with nothing to use it.
pub async fn put_app_key(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(app): Path<String>,
    Json(req): Json<PutAppKeyRequest>,
) -> AppResult<StatusCode> {
    check_offered_app(&state, &app)?;
    validate_wrap("wrapped_key", &req.wrapped_key)?;
    if let Some(private_key) = &req.wrapped_private_key {
        validate_wrap("wrapped_private_key", private_key)?;
    }
    let mut tx = state.pool.begin().await?;
    let has_root: bool = sqlx::query_scalar(
        "SELECT root_key_created_at IS NOT NULL FROM users WHERE id = $1 FOR SHARE",
    )
    .bind(user.user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::Unauthorized)?;
    if !has_root {
        return Err(AppError::BadRequest("the account has no root key".into()));
    }
    let inserted = sqlx::query(
        "INSERT INTO account_app_keys (user_id, app, wrapped_key, wrapped_private_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, app) DO NOTHING",
    )
    .bind(user.user_id)
    .bind(&app)
    .bind(&req.wrapped_key)
    .bind(&req.wrapped_private_key)
    .execute(&mut *tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::KeyAlreadyStored("this app's key"));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wrap() -> Value {
        json!({ "v": 1, "iv": "AAAAAAAAAAAAAAAA", "ct": "A".repeat(64) })
    }

    #[test]
    fn app_names_are_short_lowercase_identifiers() {
        for ok in ["todo", "notes", "vault", "a", "x-y_2"] {
            assert!(validate_app(ok).is_ok(), "{ok}");
        }
        for bad in ["", "Todo", "1app", "-x", "a b", "app/x", &"a".repeat(33)] {
            assert!(validate_app(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_recovery_slot_is_a_wrap_with_an_optional_hex_epk() {
        assert!(validate_recovery_slot(&wrap()).is_ok());
        let mut sealed = wrap();
        sealed["epk"] = json!("ab".repeat(32));
        assert!(validate_recovery_slot(&sealed).is_ok());
        sealed["epk"] = json!("AB".repeat(32));
        assert!(validate_recovery_slot(&sealed).is_err());
        assert!(validate_recovery_slot(&json!({ "iv": "A" })).is_err());
    }

    #[test]
    fn app_keys_need_the_todo_key_once() {
        let key = |app: &str| AppKeyInput {
            app: app.into(),
            wrapped_key: wrap(),
            wrapped_private_key: None,
        };
        assert!(validate_app_keys(&[key("todo")]).is_ok());
        assert!(validate_app_keys(&[key("todo"), key("journal")]).is_ok());
        // Only apps this build bundles.
        assert!(validate_app_keys(&[key("todo"), key("notes")]).is_err());
        assert!(validate_app_keys(&[key("journal")]).is_err());
        assert!(validate_app_keys(&[key("todo"), key("todo")]).is_err());
        assert!(validate_app_keys(&[]).is_err());
    }
}
