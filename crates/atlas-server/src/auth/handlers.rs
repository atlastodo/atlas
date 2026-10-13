//! Auth HTTP handlers: signup, login, refresh, logout, and the current-user probe.

use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_DISPOSITION;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::time::Instant;
use time::OffsetDateTime;
use uuid::Uuid;

use super::account_purge;
use super::api_tokens;
use super::kdf::Kdf;
use super::password::{hash_password, verify_password};
use super::recovery::{self, Challenge};
use super::root_key::{self, AppKeyInput, AppKeyView};
use super::token::{generate_refresh_token, hash_refresh_token, issue_access_token};
use super::{AuthUser, AuthUserAllowScheduled, InteractiveAuthUser};
use crate::error::{AppError, AppResult};
use crate::ratelimit::{self, ClientIp};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub display_name: String,
    /// A single-use signup invite code; only meaningful on a closed instance.
    #[serde(default)]
    pub invite: Option<String>,
    // E2EE key material. The first four are required (see `signup`); optional here so a
    // missing one is a typed 400, not a deserialization error. `encrypted_dek`,
    // `encrypted_private_key` and the two `recovery_encrypted_*` wraps are the deprecated legacy
    // slots, still required so clients predating the root key can sign in to the account.
    #[serde(default)]
    pub salt: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    /// The phrase-derived recovery public key (32 bytes, hex); required, see [`signup`].
    #[serde(default)]
    pub recovery_public_key: Option<String>,
    #[serde(default)]
    pub encrypted_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub encrypted_private_key: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_private_key: Option<serde_json::Value>,
    #[serde(default)]
    pub kdf_version: Option<i16>,
    #[serde(default)]
    pub kdf_params: Option<serde_json::Value>,
    #[serde(default)]
    pub device_name: Option<String>,
    /// See [`InstallKey`].
    #[serde(default)]
    pub install_key: Option<String>,
    /// The Ed25519 identity signing key (see [`super::identity`]): public half, and private half
    /// wrapped under the DEK. Both or neither; later uploads go through `PUT /auth/signing-key`.
    #[serde(default)]
    pub signing_public_key: Option<String>,
    #[serde(default)]
    pub encrypted_signing_key: Option<serde_json::Value>,
    /// The account root key (see [`super::root_key`]), all four together or none (a client
    /// predating root keys; the account migrates on its next sign-in on a current client). The
    /// account id is client-chosen with them, because the wraps' associated data binds it.
    #[serde(default)]
    pub user_id: Option<Uuid>,
    #[serde(default)]
    pub encrypted_root_key: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_root_key: Option<serde_json::Value>,
    #[serde(default)]
    pub app_keys: Option<Vec<AppKeyInput>>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
    /// See [`InstallKey`].
    #[serde(default)]
    pub install_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
    /// Opt into the reuse grace window ([`REFRESH_REUSE_GRACE_SECS`]), for clients that cannot
    /// serialize rotations across instances (web tabs without `navigator.locks`). Without it,
    /// any reuse of a rotated token is treated as theft.
    #[serde(default)]
    pub grace: bool,
}

#[derive(Debug, Deserialize)]
pub struct LogoutRequest {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct SaltQuery {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct SaltResponse {
    pub salt: String,
    /// Always true: every address answers as an E2EE account (see [`get_salt`]). Kept for old clients.
    pub is_e2ee: bool,
    /// Which KDF derives the credential from the password and `salt` ([`Kdf`]).
    pub kdf_version: i16,
    pub kdf_params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct PublicKeyQuery {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct PublicKeyResponse {
    pub user_id: Uuid,
    pub email: String,
    pub public_key: Option<String>,
    pub signing_public_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RecoveryKeysQuery {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct RecoveryKeysResponse {
    pub salt: String,
    /// Deprecated: the legacy DEK and private key wrapped under the phrase, still written for
    /// clients predating root keys. A current client takes the DEK from here too, to check the
    /// recovered root key against.
    pub recovery_encrypted_dek: serde_json::Value,
    pub recovery_encrypted_private_key: serde_json::Value,
    /// Which secret answers the challenge: 2 = phrase-derived recovery key, 1 = the account's
    /// X25519 private key (no recovery key registered yet).
    pub recovery_key_version: u8,
    pub challenge: Challenge,
    /// The account id, which the root key wraps' associated data binds.
    pub user_id: Uuid,
    /// The root key's recovery slot and the todo app key under the root, which the client opens
    /// to check the recovered root against the DEK. Dummies (like every field here) when the
    /// account has none, so the response does not tell whether it migrated. The slot always has
    /// an `epk` ([`recovery::padded_root_slot`]): the client tries it as sealed and as
    /// phrase-wrapped.
    pub recovery_encrypted_root_key: serde_json::Value,
    pub todo_app_key: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
    // Key material re-wrapped under the new password's MEK. The first two are required;
    // optional here so a refusal is a typed 400.
    #[serde(default)]
    pub encrypted_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub encrypted_private_key: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_private_key: Option<serde_json::Value>,
    #[serde(default)]
    pub kdf_version: Option<i16>,
    #[serde(default)]
    pub kdf_params: Option<serde_json::Value>,
    /// The password is unchanged and only moves to a newer KDF. Allowed only to a newer version,
    /// and keeps the account's other sessions.
    #[serde(default)]
    pub kdf_upgrade: bool,
    /// The root key re-wrapped under the new MEK. Required to keep an account's root key; a
    /// request without it (a client predating root keys) drops the root, see
    /// [`root_key::drop_for_legacy_write`].
    #[serde(default)]
    pub encrypted_root_key: Option<serde_json::Value>,
}

/// The salt, public key and recovery-wrapped blobs are absent: recovery replaces only the login
/// credential and the primary wraps, which the client re-derives under the existing salt.
#[derive(Debug, Deserialize)]
pub struct RecoverAccountRequest {
    pub email: String,
    pub challenge_token: String,
    pub challenge_response: String,
    pub new_auth_hash: String,
    pub encrypted_dek: serde_json::Value,
    pub encrypted_private_key: serde_json::Value,
    #[serde(default)]
    pub kdf_version: Option<i16>,
    #[serde(default)]
    pub kdf_params: Option<serde_json::Value>,
    /// The root key, recovered from its recovery slot (or new, with `app_keys`), wrapped under the
    /// new MEK. Absent from a client predating root keys: the root is then dropped.
    #[serde(default)]
    pub encrypted_root_key: Option<serde_json::Value>,
    /// The root wrapped under the phrase, replacing the recovery slot (the client has the phrase).
    #[serde(default)]
    pub recovery_encrypted_root_key: Option<serde_json::Value>,
    /// Present when the client could not recover the root (no recovery slot): a new root, and the
    /// app keys under it, replacing every stored one. Refused while a recovery slot exists.
    #[serde(default)]
    pub app_keys: Option<Vec<AppKeyInput>>,
}

#[derive(Debug, Serialize)]
pub struct UserView {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    /// Whether this account may reach `/admin/*`; lets the app hide the Admin entry.
    pub is_admin: bool,
    /// Whether a phrase-derived recovery key is registered. When false the client should ask for
    /// the phrase and `PUT /auth/recovery-key`; recovery falls back to the device key meanwhile.
    pub has_recovery_key: bool,
}

impl UserRow {
    fn kdf(&self) -> Kdf {
        Kdf::from_row(self.kdf_version, &self.kdf_params)
    }
}

impl UserView {
    fn from_row(row: &UserRow) -> Self {
        UserView {
            id: row.id,
            email: row.email.clone(),
            display_name: row.display_name.clone(),
            is_admin: row.is_admin,
            has_recovery_key: row.recovery_public_key.is_some(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub device_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub user: UserView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// Deprecated: the DEK and private key wrapped directly under the MEK, from before the root
    /// key. Still written and returned so clients predating root keys keep working; a current
    /// client opens `encrypted_root_key` and the todo app key first and falls back to these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_dek: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_private_key: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_signing_key: Option<serde_json::Value>,
    pub is_e2ee: bool,
    /// The KDF behind the key wrapping `encrypted_dek`, `encrypted_private_key` and
    /// `encrypted_root_key`.
    pub kdf_version: i16,
    pub kdf_params: serde_json::Value,
    /// The root key under the MEK, absent until the account migrates ([`super::root_key`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_root_key: Option<serde_json::Value>,
    /// The app keys under the root key.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub app_keys: Vec<AppKeyView>,
    /// The phrase-derived recovery public key, for sealing the root key's recovery slot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_public_key: Option<String>,
    pub has_recovery_root_key: bool,
    /// Whether the account has a root key at all (the password slot alone does not say: a later
    /// passkey-only account has none).
    pub has_root_key: bool,
}

/// The user row every user SELECT/RETURNING in this module maps into ([`USER_COLUMNS`]). One
/// wide struct keeps the column lists from drifting; handlers read only the fields they need,
/// hence the scoped `dead_code` allow.
#[allow(dead_code)]
#[derive(sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    display_name: String,
    password_hash: String,
    is_admin: bool,
    salt: Option<String>,
    public_key: Option<String>,
    recovery_public_key: Option<String>,
    encrypted_dek: Option<serde_json::Value>,
    encrypted_private_key: Option<serde_json::Value>,
    recovery_encrypted_dek: Option<serde_json::Value>,
    recovery_encrypted_private_key: Option<serde_json::Value>,
    signing_public_key: Option<String>,
    encrypted_signing_key: Option<serde_json::Value>,
    is_e2ee: bool,
    kdf_version: i16,
    kdf_params: serde_json::Value,
    root_key_created_at: Option<OffsetDateTime>,
    encrypted_root_key: Option<serde_json::Value>,
    recovery_encrypted_root_key: Option<serde_json::Value>,
    #[sqlx(default)]
    deletion_scheduled_at: Option<OffsetDateTime>,
    #[sqlx(default)]
    disabled_at: Option<OffsetDateTime>,
    #[sqlx(default)]
    last_login_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}

/// Columns selected for [`UserRow`], shared by every user SELECT/RETURNING.
const USER_COLUMNS: &str = "id, email, display_name, password_hash, is_admin, salt, public_key, \
     recovery_public_key, encrypted_dek, encrypted_private_key, recovery_encrypted_dek, recovery_encrypted_private_key, \
     signing_public_key, encrypted_signing_key, is_e2ee, kdf_version, kdf_params, root_key_created_at, encrypted_root_key, \
     recovery_encrypted_root_key, deletion_scheduled_at, disabled_at, last_login_at, created_at";

/// Upper bound roughly matching the RFC 5321 address limit.
const MAX_EMAIL_LEN: usize = 254;
/// Cap on the presented credential's length before Argon2, so a huge body cannot force an
/// expensive hash. Above both the auth hash and a legacy plaintext password.
const MAX_PASSWORD_LEN: usize = 128;
/// Length of the client-derived auth hash: 32 bytes of HKDF output as hex.
const AUTH_HASH_LEN: usize = 64;
const MAX_DISPLAY_NAME_LEN: usize = 200;

/// A recovery public key must be a 32-byte X25519 key in hex, and not the device key (which
/// every signed-in device holds, exactly what recovery must not depend on).
fn validate_recovery_public_key(key: Option<&str>, device_key: Option<&str>) -> AppResult<()> {
    let key = key.ok_or_else(|| AppError::BadRequest("recovery_public_key is required".into()))?;
    if recovery::parse_public_key(key).is_none() {
        return Err(AppError::BadRequest(
            "recovery_public_key must be 32 bytes of hex".into(),
        ));
    }
    if device_key.is_some_and(|d| d.eq_ignore_ascii_case(key)) {
        return Err(AppError::BadRequest(
            "recovery_public_key must differ from public_key".into(),
        ));
    }
    Ok(())
}

/// Email sanity and length cap; the unique `CITEXT` column is the real guard.
fn validate_email(email: &str) -> AppResult<()> {
    if email.len() < 3 || email.len() > MAX_EMAIL_LEN || email.contains(char::is_whitespace) {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    let mut parts = email.splitn(2, '@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    Ok(())
}

/// A stored credential must be the auth hash the client derives: exactly [`AUTH_HASH_LEN`]
/// lowercase hex characters. No strength check (the server never sees the password); it keeps
/// out a raw password sent by mistake. Login only compares.
fn validate_auth_hash(hash: &str) -> AppResult<()> {
    let is_auth_hash =
        hash.len() == AUTH_HASH_LEN && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !is_auth_hash {
        return Err(AppError::BadRequest(
            "the password must be sent as the 64-character hex auth hash".into(),
        ));
    }
    Ok(())
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// Fetch a user by email and verify `password`. Runs a dummy Argon2 verify for unknown users to
/// keep timing constant, and rejects an over-long password before hashing.
///
/// Failures count against the email and the caller's address ([`ratelimit::account_failures`]),
/// known email or not; a locked one is refused before any password is checked.
async fn authenticate(
    state: &AppState,
    email: &str,
    password: &str,
    ip: IpAddr,
) -> AppResult<UserRow> {
    let failures = ratelimit::account_failures();
    if failures.is_blocked(email, ip, Instant::now()) {
        return Err(AppError::TooManyRequests);
    }
    let verified = verify_login(state, email, password).await;
    match &verified {
        Err(AppError::Unauthorized) => failures.record_failure(email, ip, Instant::now()),
        Ok(_) | Err(AppError::AccountDisabled | AppError::LegacyAccount) => {
            failures.reset(email, ip)
        }
        Err(_) => {}
    }
    verified
}

async fn verify_login(state: &AppState, email: &str, password: &str) -> AppResult<UserRow> {
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::Unauthorized);
    }
    let user: Option<UserRow> = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE email = $1"
    )))
    .bind(email)
    .fetch_optional(&state.pool)
    .await?;
    let user = match user {
        Some(u) => u,
        None => {
            let _ = verify_password(password, DUMMY_HASH);
            return Err(AppError::Unauthorized);
        }
    };
    if !verify_password(password, &user.password_hash).map_err(|_| AppError::Internal)? {
        return Err(AppError::Unauthorized);
    }
    // Only after the password verifies: a disabled or legacy account answers like a wrong
    // password to anyone who cannot authenticate.
    if user.disabled_at.is_some() {
        return Err(AppError::AccountDisabled);
    }
    if !user.is_e2ee {
        return Err(AppError::LegacyAccount);
    }
    Ok(user)
}

/// Fetch a user by id and verify `password` against the stored Argon2 hash, for the
/// credential-confirming endpoints where the row is known to exist (no timing to equalize). A
/// mismatch is [`AppError::InvalidCredentials`].
async fn verify_current_password(
    state: &AppState,
    user_id: Uuid,
    password: &str,
) -> AppResult<UserRow> {
    if password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::InvalidCredentials);
    }
    let user: Option<UserRow> = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = $1"
    )))
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let user = user.ok_or(AppError::Unauthorized)?;
    if !verify_password(password, &user.password_hash).map_err(|_| AppError::Internal)? {
        return Err(AppError::InvalidCredentials);
    }
    Ok(user)
}

/// [`verify_current_password`] for other auth modules: the verified Argon2 hash, which their
/// UPDATE re-checks so a concurrent password change wins.
pub(super) async fn verify_password_hash(
    state: &AppState,
    user_id: Uuid,
    password: &str,
) -> AppResult<String> {
    let row = verify_current_password(state, user_id, password).await?;
    if !row.is_e2ee {
        return Err(AppError::LegacyAccount);
    }
    Ok(row.password_hash)
}

/// Revoke every live refresh-token family of `user_id` except `keep_device`'s (one family per
/// (user, device)), and close those devices' sync sockets. `None` keeps nothing.
async fn revoke_other_sessions(
    state: &AppState,
    user_id: Uuid,
    keep_device: Option<Uuid>,
) -> AppResult<()> {
    match keep_device {
        Some(device_id) => {
            sqlx::query(
                "UPDATE refresh_tokens SET revoked_at = now()
                  WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL",
            )
            .bind(user_id)
            .bind(device_id)
            .execute(&state.pool)
            .await?;
            // Every device the account ever had: one with a dead family can still hold an open socket.
            let others: Vec<Uuid> = sqlx::query_scalar(
                "SELECT DISTINCT device_id FROM refresh_tokens WHERE user_id = $1 AND device_id <> $2",
            )
            .bind(user_id)
            .bind(device_id)
            .fetch_all(&state.pool)
            .await?;
            for other in others {
                state.hub.close_device_sockets(user_id, other);
            }
        }
        None => {
            sqlx::query(
                "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
            )
            .bind(user_id)
            .execute(&state.pool)
            .await?;
            state.hub.close_user_sockets(user_id);
        }
    }
    Ok(())
}

/// The client's install key: an identifier that outlives an uninstall of the app on the same
/// device (Android ID; a keychain value on iOS), sent at sign-in. Only its hash is stored, on the
/// refresh-token family, so a later sign-in with the same key can replace that family rather
/// than leave it listed until it expires. The app's own data is gone by then, so the old family
/// can never be refreshed again anyway. It is not trusted for anything else: the device id stays
/// server-minted, and a key only ever revokes the signing-in account's own sessions.
struct InstallKey;

impl InstallKey {
    const MAX_LEN: usize = 256;

    /// The stored form of a request's key; absent, blank or oversized keys are ignored.
    fn hash(raw: Option<&str>) -> Option<String> {
        let raw = raw?.trim();
        (!raw.is_empty() && raw.len() <= Self::MAX_LEN).then(|| hash_refresh_token(raw))
    }
}

/// Sign a user in on a new device. The device id is minted here, never taken from the request:
/// it names the refresh-token family that revocations spare, so a client choosing it could join
/// someone else's family. With an [`InstallKey`], the user's live families from the same install
/// are signed out first.
async fn start_new_session(
    state: &AppState,
    user: &UserRow,
    device_name: Option<String>,
    install_key: Option<&str>,
) -> AppResult<AuthResponse> {
    let install_key_hash = InstallKey::hash(install_key);
    let mut tx = state.pool.begin().await?;
    let replaced: Vec<Uuid> = match &install_key_hash {
        Some(hash) => {
            sqlx::query_scalar(
                "UPDATE refresh_tokens SET revoked_at = now()
                  WHERE user_id = $1 AND install_key_hash = $2 AND revoked_at IS NULL
              RETURNING device_id",
            )
            .bind(user.id)
            .bind(hash)
            .fetch_all(&mut *tx)
            .await?
        }
        None => Vec::new(),
    };
    let session = start_session(
        &mut tx,
        state,
        user,
        Uuid::now_v7(),
        device_name,
        install_key_hash,
    )
    .await?;
    tx.commit().await?;
    for device_id in replaced {
        state.hub.close_device_sockets(user.id, device_id);
    }
    Ok(session)
}

/// Create a session (access token + refresh token row) on `conn`, so a rotation can insert it in
/// the transaction that consumed its predecessor. The response carries the account's key
/// material, the root key slot and app keys included.
async fn start_session(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    device_id: Uuid,
    device_name: Option<String>,
    install_key_hash: Option<String>,
) -> AppResult<AuthResponse> {
    let access_token = issue_access_token(
        user.id,
        device_id,
        state.config.access_ttl_seconds,
        &state.config.jwt_secret,
        now_unix(),
    )
    .map_err(|_| AppError::Internal)?;

    let clean_device_name = device_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .map(|n| {
            if n.len() > 100 {
                n[..100].to_string()
            } else {
                n
            }
        });

    let refresh = generate_refresh_token();
    let expires_at =
        OffsetDateTime::now_utc() + time::Duration::seconds(state.config.refresh_ttl_seconds);
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at, device_name, install_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(user.id)
    .bind(device_id)
    .bind(&refresh.hash)
    .bind(expires_at)
    .bind(&clean_device_name)
    .bind(&install_key_hash)
    .execute(&mut *conn)
    .await?;
    // No root key, no app keys: skip the query for accounts not migrated yet.
    let app_keys = match user.root_key_created_at {
        Some(_) => root_key::load_app_keys(&mut *conn, user.id).await?,
        None => Vec::new(),
    };

    Ok(AuthResponse {
        access_token,
        refresh_token: refresh.plaintext,
        expires_in: state.config.access_ttl_seconds,
        device_id,
        device_name: clean_device_name,
        user: UserView::from_row(user),
        salt: user.salt.clone(),
        public_key: user.public_key.clone(),
        encrypted_dek: user.encrypted_dek.clone(),
        encrypted_private_key: user.encrypted_private_key.clone(),
        signing_public_key: user.signing_public_key.clone(),
        encrypted_signing_key: user.encrypted_signing_key.clone(),
        is_e2ee: user.is_e2ee,
        kdf_version: user.kdf().version(),
        kdf_params: user.kdf().params(),
        encrypted_root_key: user.encrypted_root_key.clone(),
        app_keys,
        recovery_public_key: user.recovery_public_key.clone(),
        has_recovery_root_key: user.recovery_encrypted_root_key.is_some(),
        has_root_key: user.root_key_created_at.is_some(),
    })
}

/// A deterministic per-email dummy behind the anti-enumeration fakes, keyed by the JWT secret:
/// stable across restarts, unpredictable to callers, different per email.
fn dummy_secret(state: &AppState, email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(state.config.jwt_secret.as_slice());
    hasher.update(email.as_bytes());
    hex::encode(&hasher.finalize()[..16])
}

/// `GET /auth/salt`: the KDF salt of an email's account, and which KDF to run over it.
///
/// Anything that cannot sign in with a derived credential (unknown address, legacy account, no
/// salt) gets a deterministic dummy salt with [`Kdf::CURRENT`], so the answer does not reveal
/// whether or what account exists. A version-1 answer does single out an account that has not
/// signed in since version 2 existed; the client needs it to sign in.
pub async fn get_salt(
    State(state): State<AppState>,
    Query(query): Query<SaltQuery>,
) -> AppResult<Json<SaltResponse>> {
    let email = query.email.trim().to_lowercase();
    let row: Option<(Option<String>, i16, serde_json::Value)> = sqlx::query_as(
        "SELECT salt, kdf_version, kdf_params FROM users WHERE email = $1 AND is_e2ee = TRUE",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;
    let (salt, kdf) = match row {
        Some((Some(salt), version, params)) => (salt, Kdf::from_row(version, &params)),
        _ => (dummy_secret(&state, &email), Kdf::CURRENT),
    };

    Ok(Json(SaltResponse {
        salt,
        is_e2ee: true,
        kdf_version: kdf.version(),
        kdf_params: kdf.params(),
    }))
}

/// Create the user row, never an admin (see [`crate::admin::set_admin_by_email`]), with its app
/// keys. Runs on the caller's transaction, which on the invite path also consumes the invite.
/// `None` when the email (or a client-chosen id) is taken.
async fn insert_user(
    conn: &mut sqlx::PgConnection,
    email: &str,
    password_hash: &str,
    display_name: &str,
    kdf: Kdf,
    req: &SignupRequest,
) -> AppResult<Option<UserRow>> {
    let inserted: Option<UserRow> = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (id, email, password_hash, display_name, salt, public_key, encrypted_dek, encrypted_private_key, recovery_encrypted_dek, recovery_encrypted_private_key, recovery_public_key, kdf_version, kdf_params, signing_public_key, encrypted_signing_key, encrypted_root_key, recovery_encrypted_root_key, root_key_created_at, is_e2ee, last_login_at)
         VALUES (COALESCE($17, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $15::jsonb IS NULL THEN NULL ELSE now() END, TRUE, now())
         ON CONFLICT DO NOTHING
         RETURNING {USER_COLUMNS}"
    )))
    .bind(email)
    .bind(password_hash)
    .bind(display_name)
    .bind(&req.salt)
    .bind(&req.public_key)
    .bind(&req.encrypted_dek)
    .bind(&req.encrypted_private_key)
    .bind(&req.recovery_encrypted_dek)
    .bind(&req.recovery_encrypted_private_key)
    .bind(&req.recovery_public_key)
    .bind(kdf.version())
    .bind(kdf.params())
    .bind(
        req.signing_public_key
            .as_deref()
            .map(|k| k.trim().to_ascii_lowercase()),
    )
    .bind(&req.encrypted_signing_key)
    .bind(&req.encrypted_root_key)
    .bind(&req.recovery_encrypted_root_key)
    .bind(req.user_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let (Some(user), Some(app_keys)) = (&inserted, &req.app_keys) {
        root_key::replace_app_keys(conn, user.id, app_keys).await?;
    }
    Ok(inserted)
}

/// The 409 for a signup whose insert hit a conflict: the email, or else the client-chosen id.
async fn signup_conflict(conn: &mut sqlx::PgConnection, email: &str) -> AppError {
    let taken: Result<bool, sqlx::Error> =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)")
            .bind(email)
            .fetch_one(conn)
            .await;
    match taken {
        Ok(true) => AppError::Conflict("email".into()),
        Ok(false) => AppError::Conflict("user id".into()),
        Err(e) => e.into(),
    }
}

/// The root key fields of a signup: all of `user_id`, `encrypted_root_key`,
/// `recovery_encrypted_root_key` and `app_keys` (the todo key among them), or none.
fn validate_signup_root_key(req: &SignupRequest) -> AppResult<()> {
    match (
        req.user_id,
        &req.encrypted_root_key,
        &req.recovery_encrypted_root_key,
        &req.app_keys,
    ) {
        (None, None, None, None) => Ok(()),
        (Some(_), Some(root), Some(recovery), Some(app_keys)) => {
            root_key::validate_wrap("encrypted_root_key", root)?;
            root_key::validate_recovery_slot(recovery)?;
            root_key::validate_app_keys(app_keys)
        }
        _ => Err(AppError::BadRequest(
            "user_id, encrypted_root_key, recovery_encrypted_root_key and app_keys go together"
                .into(),
        )),
    }
}

/// `POST /auth/signup`
pub async fn signup(
    State(state): State<AppState>,
    Json(req): Json<SignupRequest>,
) -> AppResult<(StatusCode, Json<AuthResponse>)> {
    // A closed instance refuses new accounts; the runtime setting overrides the env default and
    // a valid invite code still opens the door. An `ADMIN_EMAILS` address is no key.
    let email = req.email.trim().to_lowercase();
    validate_email(&email)?;
    validate_auth_hash(&req.password)?;
    // Every account is E2EE: without wrapped keys it could neither decrypt, share nor recover.
    let has_keys = req.salt.as_deref().is_some_and(|s| !s.is_empty())
        && req.public_key.as_deref().is_some_and(|k| !k.is_empty())
        && req.encrypted_dek.is_some()
        && req.encrypted_private_key.is_some();
    if !has_keys {
        return Err(AppError::BadRequest(
            "salt, public_key, encrypted_dek and encrypted_private_key are required".into(),
        ));
    }
    validate_recovery_public_key(
        req.recovery_public_key.as_deref(),
        req.public_key.as_deref(),
    )?;
    let kdf = Kdf::from_request(req.kdf_version, req.kdf_params.as_ref())?;
    super::identity::signup_signing_key(
        req.signing_public_key
            .as_deref()
            .map(|k| k.trim().to_ascii_lowercase())
            .as_deref(),
        req.encrypted_signing_key.as_ref(),
    )?;
    validate_signup_root_key(&req)?;
    let invite_code = req
        .invite
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    let signup_open = crate::settings::signup_enabled(&state).await?;
    if !signup_open && invite_code.is_none() {
        return Err(AppError::SignupDisabled);
    }

    let display_name = req.display_name.trim();
    if display_name.len() > MAX_DISPLAY_NAME_LEN {
        return Err(AppError::BadRequest("display name is too long".into()));
    }
    // User creation, its app keys and (on the invite path) the invite's consumption commit together.
    let mut tx = state.pool.begin().await?;
    // The invite is validated and locked first, before the duplicate-email check and any Argon2
    // work (`invites::lock_valid`).
    let invite_id = match invite_code {
        Some(code) => Some(
            crate::invites::lock_valid(&mut *tx, &code)
                .await?
                .ok_or(AppError::InviteInvalid)?,
        ),
        None => None,
    };
    let password_hash = hash_password(&req.password).map_err(|_| AppError::Internal)?;
    let Some(user) = insert_user(&mut tx, &email, &password_hash, display_name, kdf, &req).await?
    else {
        return Err(signup_conflict(&mut tx, &email).await);
    };
    if let Some(invite_id) = invite_id {
        crate::invites::mark_used(&mut *tx, invite_id, user.id).await?;
    }
    tx.commit().await?;

    let resp =
        start_new_session(&state, &user, req.device_name, req.install_key.as_deref()).await?;
    Ok((StatusCode::CREATED, Json(resp)))
}

/// `POST /auth/login`
pub async fn login(
    State(state): State<AppState>,
    client: Option<Extension<ClientIp>>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let email = req.email.trim().to_lowercase();
    let user = authenticate(&state, &email, &req.password, ClientIp::of(client)).await?;

    if let Some(scheduled_at) = user.deletion_scheduled_at {
        return Err(scheduled_deletion_error(scheduled_at));
    }

    // Stamp the admin panel's "last sign-in"; a refresh-driven rotation is not a sign-in.
    sqlx::query("UPDATE users SET last_login_at = now() WHERE id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(
        start_new_session(&state, &user, req.device_name, req.install_key.as_deref()).await?,
    ))
}

/// How long after a rotation the rotated token may be presented again without counting as theft,
/// for clients that asked ([`RefreshRequest::grace`]). Covers tabs racing to refresh; short
/// because a thief's replay goes undetected inside it.
const REFRESH_REUSE_GRACE_SECS: i32 = 10;

/// `POST /auth/refresh`: rotate the refresh token (revoke old, issue new).
///
/// Presenting a revoked token is a theft signal and revokes the device's whole family, except
/// within [`REFRESH_REUSE_GRACE_SECS`] for a client that asked, which answers 401
/// `refresh_superseded` and leaves the family signed in. A disabled or deletion-scheduled
/// account gets its typed 403 and nothing is consumed. Consume and insert share a transaction.
pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<AuthResponse>> {
    let token_hash = hash_refresh_token(&req.refresh_token);

    let mut tx = state.pool.begin().await?;
    // Consume the token only if it is live and its account may still hold a session.
    let consumed: Option<(Uuid, Uuid, Option<String>, Option<String>)> = sqlx::query_as(
        "UPDATE refresh_tokens t
            SET revoked_at = now(), rotated_at = now()
           FROM users u
          WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
            AND u.id = t.user_id AND u.disabled_at IS NULL AND u.deletion_scheduled_at IS NULL
        RETURNING t.user_id, t.device_id, t.device_name, t.install_key_hash",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((user_id, device_id, device_name, install_key_hash)) = consumed else {
        drop(tx);
        return Err(refresh_rejection(&state, &token_hash, req.grace).await);
    };
    let user: UserRow = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = $1"
    )))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !user.is_e2ee {
        return Err(AppError::LegacyAccount);
    }
    let session = start_session(
        &mut tx,
        &state,
        &user,
        device_id,
        device_name,
        install_key_hash,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(session))
}

/// Why a refresh token could not be consumed; a reuse outside the grace revokes its family.
async fn refresh_rejection(state: &AppState, token_hash: &str, grace: bool) -> AppError {
    #[derive(sqlx::FromRow)]
    struct Row {
        user_id: Uuid,
        device_id: Uuid,
        revoked: bool,
        just_rotated: bool,
        live: bool,
        disabled: bool,
        deletion_scheduled_at: Option<OffsetDateTime>,
    }
    let lookup = sqlx::query_as::<_, Row>(
        "SELECT t.user_id, t.device_id,
                t.revoked_at IS NOT NULL AS revoked,
                COALESCE(t.rotated_at > now() - make_interval(secs => $2), FALSE) AS just_rotated,
                (t.revoked_at IS NULL AND t.expires_at > now()) AS live,
                u.disabled_at IS NOT NULL AS disabled,
                u.deletion_scheduled_at
           FROM refresh_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1",
    )
    .bind(token_hash)
    .bind(f64::from(REFRESH_REUSE_GRACE_SECS))
    .fetch_optional(&state.pool)
    .await;
    let row = match lookup {
        Ok(Some(row)) => row,
        Ok(None) => return AppError::Unauthorized,
        Err(e) => return e.into(),
    };
    if row.live {
        if row.disabled {
            return AppError::AccountDisabled;
        }
        if let Some(scheduled_at) = row.deletion_scheduled_at {
            return scheduled_deletion_error(scheduled_at);
        }
        // Consumed concurrently: that request won the rotation.
        return AppError::Unauthorized;
    }
    if !row.revoked {
        return AppError::Unauthorized; // expired
    }
    if grace && row.just_rotated {
        return AppError::RefreshSuperseded;
    }
    if let Err(e) = revoke_family(&state.pool, row.user_id, row.device_id).await {
        return e;
    }
    state.hub.close_device_sockets(row.user_id, row.device_id);
    AppError::Unauthorized
}

async fn revoke_family(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    user_id: Uuid,
    device_id: Uuid,
) -> AppResult<()> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .bind(device_id)
    .execute(executor)
    .await?;
    Ok(())
}

/// The typed refusal for an account whose deletion is scheduled: days left to cancel, or that
/// it is gone (the purge has not reached it yet).
pub(super) fn scheduled_deletion_error(scheduled_at: OffsetDateTime) -> AppError {
    if account_purge::is_past_grace(scheduled_at) {
        return AppError::AccountDeleted;
    }
    AppError::AccountScheduledDeletion {
        days_remaining: account_purge::days_remaining(scheduled_at),
    }
}

/// `POST /auth/change-password`: rotate the login credential of the signed-in account.
///
/// The current credential is verified as at login ([`verify_current_password`]). The request
/// also carries the keys re-wrapped under the new password's MEK, and the hash swap, re-wrap
/// and KDF commit in one UPDATE so they never disagree. The KDF salt is kept (recovery-wrapped
/// copies are bound to it). The UPDATE only lands while the verified hash is still in place;
/// otherwise 403 `invalid_credentials`.
///
/// The device that proved the credential (the access token's device claim, never the body)
/// keeps its session; every other family is revoked. A token without the claim revokes all.
/// Access tokens are stateless and expire within
/// [`crate::config::Config::access_ttl_seconds`].
///
/// A `kdf_upgrade` request moves an unchanged password to a newer KDF: it must name a newer
/// version than stored and revokes nothing.
pub async fn change_password(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<ChangePasswordRequest>,
) -> AppResult<StatusCode> {
    let row = verify_current_password(&state, user.user_id, &req.current_password).await?;
    if !row.is_e2ee {
        return Err(AppError::LegacyAccount);
    }
    validate_auth_hash(&req.new_password)?;
    let kdf = Kdf::from_request(req.kdf_version, req.kdf_params.as_ref())?;
    if req.kdf_upgrade && kdf.version() <= row.kdf().version() {
        return Err(AppError::BadRequest(
            "kdf_upgrade needs a newer kdf_version than the account's".into(),
        ));
    }
    // A hash swap without the re-wrap would leave the account unloggable.
    let (Some(encrypted_dek), Some(encrypted_private_key)) =
        (&req.encrypted_dek, &req.encrypted_private_key)
    else {
        return Err(AppError::BadRequest(
            "re-wrapped key material is required".into(),
        ));
    };

    if let Some(root) = &req.encrypted_root_key {
        root_key::validate_wrap("encrypted_root_key", root)?;
    }

    let new_hash = hash_password(&req.new_password).map_err(|_| AppError::Internal)?;
    let mut tx = state.pool.begin().await?;
    // The root slot moves with the legacy wraps, and only for an account that has a root: a
    // request cannot install one here (that is `POST /auth/root-key`, set once).
    let updated: Option<bool> = sqlx::query_scalar(
        "UPDATE users
            SET password_hash = $1,
                encrypted_dek = $2,
                encrypted_private_key = $3,
                recovery_encrypted_dek = COALESCE($4, recovery_encrypted_dek),
                recovery_encrypted_private_key = COALESCE($5, recovery_encrypted_private_key),
                kdf_version = $6,
                kdf_params = $7,
                encrypted_root_key = CASE WHEN root_key_created_at IS NULL THEN NULL
                                          ELSE COALESCE($10, encrypted_root_key) END,
                updated_at = now()
          WHERE id = $8 AND password_hash = $9
      RETURNING root_key_created_at IS NOT NULL",
    )
    .bind(&new_hash)
    .bind(encrypted_dek)
    .bind(encrypted_private_key)
    .bind(&req.recovery_encrypted_dek)
    .bind(&req.recovery_encrypted_private_key)
    .bind(kdf.version())
    .bind(kdf.params())
    .bind(user.user_id)
    .bind(&row.password_hash)
    .bind(&req.encrypted_root_key)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(has_root) = updated else {
        return Err(AppError::InvalidCredentials);
    };
    // A client predating root keys sent no root slot; the stored one is under the old MEK.
    if has_root && req.encrypted_root_key.is_none() {
        root_key::drop_for_legacy_write(&mut tx, user.user_id).await?;
    }
    tx.commit().await?;

    if !req.kdf_upgrade {
        revoke_other_sessions(&state, user.user_id, user.device_id).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /auth/recovery-keys?email=...`: the recovery-wrapped keys plus a challenge sealed to the
/// account's recovery key (see [`recovery::recipient`]), which `POST /auth/recover` requires
/// answered. `recovery_key_version` says which secret answers it.
///
/// An address that cannot be recovered gets a dummy of the same shape (version 2) sealed to a
/// per-email dummy key, so the answer leaks neither existence nor E2EE status. The dummy blobs
/// fail AES-GCM like a wrong phrase would. A version-1 answer does single out an account without
/// a recovery key; that is inherent and shrinks as accounts migrate.
pub async fn get_recovery_keys(
    State(state): State<AppState>,
    Query(query): Query<RecoveryKeysQuery>,
) -> AppResult<Json<RecoveryKeysResponse>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        password_hash: String,
        salt: Option<String>,
        public_key: Option<String>,
        recovery_public_key: Option<String>,
        recovery_encrypted_dek: Option<serde_json::Value>,
        recovery_encrypted_private_key: Option<serde_json::Value>,
        recovery_encrypted_root_key: Option<serde_json::Value>,
        todo_app_key: Option<serde_json::Value>,
    }
    let email = query.email.trim().to_lowercase();
    let row: Option<Row> = sqlx::query_as(
        "SELECT u.id, u.password_hash, u.salt, u.public_key, u.recovery_public_key,
                u.recovery_encrypted_dek, u.recovery_encrypted_private_key,
                u.recovery_encrypted_root_key, k.wrapped_key AS todo_app_key
           FROM users u
           LEFT JOIN account_app_keys k ON k.user_id = u.id AND k.app = $2
          WHERE u.email = $1 AND u.is_e2ee = TRUE",
    )
    .bind(&email)
    .bind(root_key::TODO_APP)
    .fetch_optional(&state.pool)
    .await?;

    let seed = dummy_secret(&state, &email);
    let recoverable = row.and_then(|r| {
        let (version, recipient) =
            recovery::recipient(r.recovery_public_key.as_deref(), r.public_key.as_deref())?;
        Some((r.salt.clone()?, version, recipient, r))
    });
    let (salt, dek, priv_key, pwh, version, recipient, user_id, root_slot, todo_key) =
        match recoverable {
            // A missing blob gets the dummy too: a null would stand out.
            Some((salt, version, recipient, r)) => (
                salt,
                r.recovery_encrypted_dek
                    .unwrap_or_else(|| recovery::dummy_wrapped_key(&seed, "dek")),
                r.recovery_encrypted_private_key
                    .unwrap_or_else(|| recovery::dummy_wrapped_key(&seed, "priv")),
                recovery::password_hash_fingerprint(&r.password_hash),
                version,
                recipient,
                r.id,
                r.recovery_encrypted_root_key
                    .map(|slot| recovery::padded_root_slot(&seed, slot))
                    .unwrap_or_else(|| recovery::dummy_root_slot(&seed)),
                r.todo_app_key
                    .unwrap_or_else(|| recovery::dummy_versioned_wrap(&seed, "todo")),
            ),
            None => (
                seed.clone(),
                recovery::dummy_wrapped_key(&seed, "dek"),
                recovery::dummy_wrapped_key(&seed, "priv"),
                recovery::dummy_fingerprint(&seed),
                recovery::RECOVERY_KEY_V2,
                recovery::dummy_public_key(&seed),
                recovery::dummy_user_id(&seed),
                recovery::dummy_root_slot(&seed),
                recovery::dummy_versioned_wrap(&seed, "todo"),
            ),
        };
    let challenge = recovery::issue_challenge(
        &state.config.jwt_secret,
        &email,
        &pwh,
        version,
        &recipient,
        now_unix(),
    )
    .map_err(|_| AppError::Internal)?;

    Ok(Json(RecoveryKeysResponse {
        salt,
        recovery_encrypted_dek: dek,
        recovery_encrypted_private_key: priv_key,
        recovery_key_version: version,
        challenge,
        user_id,
        recovery_encrypted_root_key: root_slot,
        todo_app_key: todo_key,
    }))
}

/// `POST /auth/recover`: replace the login credential and primary key wraps after the caller
/// answered a challenge from [`get_recovery_keys`].
///
/// Every rejection past input validation is the same bare 401. A challenge is single-use, bound
/// to the password hash current at issue and to the key it was sealed to, and the UPDATE only
/// lands while that hash is still in place.
pub async fn recover_account(
    State(state): State<AppState>,
    client: Option<Extension<ClientIp>>,
    Json(req): Json<RecoverAccountRequest>,
) -> AppResult<StatusCode> {
    let ip = ClientIp::of(client);
    validate_auth_hash(&req.new_auth_hash)?;
    let kdf = Kdf::from_request(req.kdf_version, req.kdf_params.as_ref())?;
    let email = req.email.trim().to_lowercase();
    // Failures count per email and address, as for login.
    let failures = ratelimit::account_failures();
    if failures.is_blocked(&email, ip, Instant::now()) {
        return Err(AppError::TooManyRequests);
    }
    let recovered = recover(&state, &email, &req, kdf).await;
    match &recovered {
        Err(AppError::Unauthorized) => failures.record_failure(&email, ip, Instant::now()),
        Ok(_) => failures.reset(&email, ip),
        Err(_) => {}
    }
    recovered
}

async fn recover(
    state: &AppState,
    email: &str,
    req: &RecoverAccountRequest,
    kdf: Kdf,
) -> AppResult<StatusCode> {
    let secret = &state.config.jwt_secret;

    let claims =
        recovery::verify_challenge(secret, &req.challenge_token).ok_or(AppError::Unauthorized)?;
    if claims.email != email {
        return Err(AppError::Unauthorized);
    }
    let (user_id, old_hash, public_key, recovery_public_key): (
        Uuid,
        String,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT id, password_hash, public_key, recovery_public_key FROM users
          WHERE email = $1 AND is_e2ee = TRUE",
    )
    .bind(email)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    let (version, key) = recovery::recipient(recovery_public_key.as_deref(), public_key.as_deref())
        .ok_or(AppError::Unauthorized)?;
    if claims.ver != version
        || claims.rk != recovery::key_fingerprint(&key)
        || recovery::password_hash_fingerprint(&old_hash) != claims.pwh
        || !recovery::response_matches(secret, &req.challenge_token, &req.challenge_response)
    {
        return Err(AppError::Unauthorized);
    }

    if let Some(root) = &req.encrypted_root_key {
        root_key::validate_wrap("encrypted_root_key", root)?;
    }
    if let Some(slot) = &req.recovery_encrypted_root_key {
        root_key::validate_recovery_slot(slot)?;
    }
    if let Some(app_keys) = &req.app_keys {
        root_key::validate_app_keys(app_keys)?;
        if req.encrypted_root_key.is_none() {
            return Err(AppError::BadRequest(
                "app_keys come with a new encrypted_root_key".into(),
            ));
        }
    }

    let new_hash = hash_password(&req.new_auth_hash).map_err(|_| AppError::Internal)?;
    let mut tx = state.pool.begin().await?;
    let (has_root, has_recovery_slot): (bool, bool) = sqlx::query_as(
        "SELECT root_key_created_at IS NOT NULL, recovery_encrypted_root_key IS NOT NULL
           FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let updated = sqlx::query(
        "UPDATE users
            SET password_hash = $1,
                encrypted_dek = $2,
                encrypted_private_key = $3,
                kdf_version = $4,
                kdf_params = $5,
                updated_at = now()
          WHERE id = $6 AND password_hash = $7",
    )
    .bind(&new_hash)
    .bind(&req.encrypted_dek)
    .bind(&req.encrypted_private_key)
    .bind(kdf.version())
    .bind(kdf.params())
    .bind(user_id)
    .bind(&old_hash)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::Unauthorized);
    }
    match (&req.encrypted_root_key, &req.app_keys) {
        // A client predating root keys: the stored password slot is under the old MEK.
        (None, _) if has_root => root_key::drop_for_legacy_write(&mut tx, user_id).await?,
        (None, _) => {}
        // The root came back out of its recovery slot: re-wrap it, and take the phrase-form slot.
        (Some(root), None) => {
            if !has_root {
                return Err(AppError::BadRequest(
                    "the account has no root key to keep; send app_keys with a new one".into(),
                ));
            }
            sqlx::query(
                "UPDATE users
                    SET encrypted_root_key = $2,
                        recovery_encrypted_root_key = COALESCE($3, recovery_encrypted_root_key)
                  WHERE id = $1",
            )
            .bind(user_id)
            .bind(root)
            .bind(&req.recovery_encrypted_root_key)
            .execute(&mut *tx)
            .await?;
        }
        // A new root. Only when the stored one has no recovery slot (an account without a
        // phrase-derived recovery key, or not migrated): a root that recovery could reach is
        // never thrown away, with whatever app keys it holds.
        (Some(root), Some(app_keys)) => {
            if has_recovery_slot {
                return Err(AppError::BadRequest(
                    "the account's root key is recoverable; recover it instead".into(),
                ));
            }
            sqlx::query(
                "UPDATE users
                    SET root_key_created_at = now(),
                        encrypted_root_key = $2,
                        recovery_encrypted_root_key = $3
                  WHERE id = $1",
            )
            .bind(user_id)
            .bind(root)
            .bind(&req.recovery_encrypted_root_key)
            .execute(&mut *tx)
            .await?;
            root_key::replace_app_keys(&mut tx, user_id, app_keys).await?;
        }
    }
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    // A recovery assumes the account may have been in other hands: API tokens go too.
    api_tokens::revoke_all(&mut *tx, user_id).await?;
    tx.commit().await?;
    state.hub.close_user_sockets(user_id);

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RegisterRecoveryKeyRequest {
    pub current_password: String,
    pub recovery_public_key: String,
}

/// `PUT /auth/recovery-key`: register the phrase-derived recovery key of an account created
/// before they existed. Set once: the same key again is a no-op, a different one is 409 (a new
/// phrase goes through [`replace_recovery_key`]).
pub async fn register_recovery_key(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<RegisterRecoveryKeyRequest>,
) -> AppResult<StatusCode> {
    let row = verify_current_password(&state, user.user_id, &req.current_password).await?;
    let key = req.recovery_public_key.trim().to_ascii_lowercase();
    validate_recovery_public_key(Some(&key), row.public_key.as_deref())?;
    let stored: Option<String> = sqlx::query_scalar(
        "UPDATE users SET recovery_public_key = COALESCE(recovery_public_key, $2), updated_at = now()
          WHERE id = $1
      RETURNING recovery_public_key",
    )
    .bind(user.user_id)
    .bind(&key)
    .fetch_one(&state.pool)
    .await?;
    if stored.as_deref() != Some(key.as_str()) {
        return Err(AppError::RecoveryKeyAlreadySet);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ReplaceRecoveryKeyRequest {
    pub current_password: String,
    pub recovery_public_key: String,
    /// The DEK and private key wrapped under the new phrase's recovery key. Required.
    #[serde(default)]
    pub recovery_encrypted_dek: Option<serde_json::Value>,
    #[serde(default)]
    pub recovery_encrypted_private_key: Option<serde_json::Value>,
    /// The root key wrapped under the new phrase. A request without it (a client predating root
    /// keys) empties the recovery slot, which the next current client refills sealed to the new
    /// recovery key (`PUT /auth/root-key/recovery`).
    #[serde(default)]
    pub recovery_encrypted_root_key: Option<serde_json::Value>,
}

/// `POST /auth/recovery-key/replace`: replace the recovery phrase for a user who lost it: the
/// recovery public key and both recovery-wrapped blobs in one UPDATE, so recovery never pairs
/// one phrase's key with the other's blobs.
///
/// The old phrase stops working at once (its blobs are gone and outstanding challenges were
/// sealed to its key; see `recovery.rs`). Requires the current password, and the UPDATE only
/// lands while the verified hash is in place. Sessions are untouched.
///
/// Someone who learned the password could plant their own phrase, which a later password change
/// does not undo; a user who suspects that should change the password and then replace the phrase.
pub async fn replace_recovery_key(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<ReplaceRecoveryKeyRequest>,
) -> AppResult<StatusCode> {
    let row = verify_current_password(&state, user.user_id, &req.current_password).await?;
    if !row.is_e2ee {
        return Err(AppError::LegacyAccount);
    }
    let key = req.recovery_public_key.trim().to_ascii_lowercase();
    validate_recovery_public_key(Some(&key), row.public_key.as_deref())?;
    let (Some(recovery_dek), Some(recovery_private_key)) = (
        &req.recovery_encrypted_dek,
        &req.recovery_encrypted_private_key,
    ) else {
        return Err(AppError::BadRequest(
            "recovery_encrypted_dek and recovery_encrypted_private_key are required".into(),
        ));
    };
    if let Some(slot) = &req.recovery_encrypted_root_key {
        root_key::validate_recovery_slot(slot)?;
    }
    // The old phrase's root slot goes with its blobs; an account without a root keeps none.
    let updated = sqlx::query(
        "UPDATE users
            SET recovery_public_key = $1,
                recovery_encrypted_dek = $2,
                recovery_encrypted_private_key = $3,
                recovery_encrypted_root_key = CASE WHEN root_key_created_at IS NULL THEN NULL
                                                   ELSE $6::jsonb END,
                updated_at = now()
          WHERE id = $4 AND password_hash = $5",
    )
    .bind(&key)
    .bind(recovery_dek)
    .bind(recovery_private_key)
    .bind(user.user_id)
    .bind(&row.password_hash)
    .bind(&req.recovery_encrypted_root_key)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::InvalidCredentials);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /users/public-key?email=...`: a user's public keys for sharing: the X25519 key deliveries
/// are sealed to, and the Ed25519 identity key (see [`super::identity`]).
pub async fn get_public_key(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<PublicKeyQuery>,
) -> AppResult<Json<PublicKeyResponse>> {
    let email = query.email.trim().to_lowercase();
    let row: Option<(Uuid, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, email::TEXT, public_key, signing_public_key FROM users WHERE email = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    match row {
        Some((user_id, email, public_key, signing_public_key)) => Ok(Json(PublicKeyResponse {
            user_id,
            email,
            public_key,
            signing_public_key,
        })),
        None => Err(AppError::NotFound),
    }
}

/// `POST /auth/logout`: sign out the presented token's device (its whole family, even if the
/// token was already rotated). Unknown tokens are a 204 too.
pub async fn logout(
    State(state): State<AppState>,
    Json(req): Json<LogoutRequest>,
) -> AppResult<StatusCode> {
    let token_hash = hash_refresh_token(&req.refresh_token);
    let family: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT user_id, device_id FROM refresh_tokens WHERE token_hash = $1")
            .bind(&token_hash)
            .fetch_optional(&state.pool)
            .await?;
    if let Some((user_id, device_id)) = family {
        revoke_family(&state.pool, user_id, device_id).await?;
        state.hub.close_device_sockets(user_id, device_id);
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<UserView>> {
    let row: UserRow = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = $1"
    )))
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(UserView::from_row(&row)))
}

/// One live refresh-token family, i.e. a signed-in device: every `refresh_tokens` row issued to
/// one `(user_id, device_id)`. The live row's `created_at` is the family's last use, and the
/// family's `MIN(created_at)` is when the device first signed in.
#[derive(Debug, Serialize)]
pub struct SessionView {
    pub device_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub created_at: i64,
    /// When the live token was issued: the last refresh (unix millis).
    pub last_used_at: i64,
    pub expires_at: i64,
    pub current: bool,
}

/// `GET /auth/sessions`: the caller's live families, newest first. Dead families are not listed.
pub async fn list_sessions(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<Vec<SessionView>>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        device_id: Uuid,
        device_name: Option<String>,
        created_at: OffsetDateTime,
        last_used_at: OffsetDateTime,
        expires_at: OffsetDateTime,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT device_id,
                MAX(device_name) AS device_name,
                MIN(created_at) AS created_at,
                MAX(created_at) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) AS last_used_at,
                MAX(expires_at) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) AS expires_at
           FROM refresh_tokens
          WHERE user_id = $1
          GROUP BY device_id
         HAVING COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) > 0
          ORDER BY created_at DESC",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;

    let sessions = rows
        .into_iter()
        .map(|r| SessionView {
            device_id: r.device_id,
            device_name: r.device_name,
            created_at: r.created_at.unix_timestamp() * 1000,
            last_used_at: r.last_used_at.unix_timestamp() * 1000,
            expires_at: r.expires_at.unix_timestamp() * 1000,
            current: user.device_id == Some(r.device_id),
        })
        .collect();
    Ok(Json(sessions))
}

#[derive(Debug, Deserialize)]
pub struct RenameSessionRequest {
    pub name: String,
}

pub async fn rename_session(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(device_id): Path<Uuid>,
    Json(req): Json<RenameSessionRequest>,
) -> AppResult<StatusCode> {
    let name = req.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(AppError::BadRequest("invalid device name".into()));
    }
    let res = sqlx::query(
        "UPDATE refresh_tokens
            SET device_name = $1
          WHERE user_id = $2 AND device_id = $3",
    )
    .bind(name)
    .bind(user.user_id)
    .bind(device_id)
    .execute(&state.pool)
    .await?;

    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /auth/sessions/:device_id`: revoke a family (sign that device out).
///
/// The current device cannot revoke itself here (400); its way out is `POST /auth/logout`. An
/// unknown or already-dead family is a 404.
pub async fn revoke_session(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(device_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if user.device_id == Some(device_id) {
        return Err(AppError::BadRequest(
            "cannot revoke the current device; sign out instead".into(),
        ));
    }
    let res = sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL",
    )
    .bind(user.user_id)
    .bind(device_id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.hub.close_device_sockets(user.user_id, device_id);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /auth/sessions/revoke-others`: sign every other device out. When the token predates
/// the device claim nothing can be safely spared, so every family is revoked (as in
/// `change_password`).
pub async fn revoke_other_devices(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<StatusCode> {
    revoke_other_sessions(&state, user.user_id, user.device_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /auth/export`: the caller's data as a downloadable JSON bundle.
///
/// - `account`: the `/auth/me` profile plus the primary E2EE envelope (so an export can seed a
///   new device). Never the password hash, recovery-wrapped blobs or operational stamps.
/// - `data`: the materialized entity state as snapshot-shaped ops ([`crate::sync::partition_ops`]).
pub async fn export(
    State(state): State<AppState>,
    AuthUserAllowScheduled(user): AuthUserAllowScheduled,
) -> AppResult<Response> {
    let row: UserRow = sqlx::query_as::<_, UserRow>(sqlx::AssertSqlSafe(format!(
        "SELECT {USER_COLUMNS} FROM users WHERE id = $1"
    )))
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let operations = crate::sync::partition_ops(&state.pool, user.user_id).await?;
    let app_keys = root_key::load_app_keys(&state.pool, user.user_id).await?;

    let body = Json(serde_json::json!({
        "exported_at": now_unix() * 1000,
        "account": {
            "id": row.id,
            "email": row.email,
            "display_name": row.display_name,
            "is_admin": row.is_admin,
            "is_e2ee": row.is_e2ee,
            "created_at": row.created_at.unix_timestamp() * 1000,
            "salt": row.salt,
            "public_key": row.public_key,
            "encrypted_dek": row.encrypted_dek,
            "encrypted_private_key": row.encrypted_private_key,
            "kdf_version": row.kdf().version(),
            "kdf_params": row.kdf().params(),
            "signing_public_key": row.signing_public_key,
            "encrypted_signing_key": row.encrypted_signing_key,
            "encrypted_root_key": row.encrypted_root_key,
            "app_keys": app_keys,
        },
        "data": {
            "operations": operations,
        },
    }));

    let mut response = body.into_response();
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"atlas-export-{}.json\"",
            OffsetDateTime::now_utc().date()
        ))
        .map_err(|_| AppError::Internal)?,
    );
    Ok(response)
}

#[derive(Debug, Deserialize)]
pub struct DeleteAccountRequest {
    /// The client-derived auth hash login sends. Required because a bearer token alone must not
    /// schedule a deletion, which a password login cannot undo.
    pub password: String,
}

/// `DELETE /auth/account`: verify the password, schedule deletion in 30 days and revoke active
/// sessions. Cancelling is `POST /auth/account/cancel-deletion`.
pub async fn delete_account(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<DeleteAccountRequest>,
) -> AppResult<StatusCode> {
    let row = verify_current_password(&state, user.user_id, &req.password).await?;

    sqlx::query("UPDATE users SET deletion_scheduled_at = now() WHERE id = $1")
        .bind(row.id)
        .execute(&state.pool)
        .await?;

    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user.user_id)
    .execute(&state.pool)
    .await?;
    // Cancelling the deletion signs in again; it must not bring integrations back with it.
    api_tokens::revoke_all(&state.pool, user.user_id).await?;

    state.hub.close_user_sockets(user.user_id);
    broadcast_membership_change(&state, user.user_id).await;

    Ok(StatusCode::NO_CONTENT)
}

/// Tell the members of the user's shared projects that the account's deletion state changed.
/// Runs after commit, so a failure is logged rather than failing the request.
async fn broadcast_membership_change(state: &AppState, user_id: Uuid) {
    if let Err(e) = crate::members::broadcast_members_for_user_projects(state, user_id).await {
        tracing::warn!(error = ?e, %user_id, "could not broadcast a membership change");
    }
}

#[derive(Debug, Deserialize)]
pub struct CancelDeletionRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
    /// See [`InstallKey`].
    #[serde(default)]
    pub install_key: Option<String>,
}

/// `POST /auth/account/cancel-deletion`: cancel a pending deletion and start a session.
pub async fn cancel_account_deletion(
    State(state): State<AppState>,
    client: Option<Extension<ClientIp>>,
    Json(req): Json<CancelDeletionRequest>,
) -> AppResult<Json<AuthResponse>> {
    let email = req.email.trim().to_lowercase();
    let user = authenticate(&state, &email, &req.password, ClientIp::of(client)).await?;

    match user.deletion_scheduled_at {
        None => Ok(Json(
            start_new_session(&state, &user, req.device_name, req.install_key.as_deref()).await?,
        )),
        Some(scheduled_at) => {
            if account_purge::is_past_grace(scheduled_at) {
                return Err(AppError::AccountDeleted);
            }

            sqlx::query("UPDATE users SET deletion_scheduled_at = NULL WHERE id = $1")
                .bind(user.id)
                .execute(&state.pool)
                .await?;

            broadcast_membership_change(&state, user.id).await;

            let mut restored_user = user;
            restored_user.deletion_scheduled_at = None;
            Ok(Json(
                start_new_session(
                    &state,
                    &restored_user,
                    req.device_name,
                    req.install_key.as_deref(),
                )
                .await?,
            ))
        }
    }
}

/// A valid Argon2 hash of a random value, to equalize timing on unknown-user logins.
const DUMMY_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation_accepts_normal_and_rejects_malformed_or_unbounded() {
        assert!(validate_email("user@example.com").is_ok());
        assert!(validate_email("a@b").is_err(), "domain needs a dot");
        assert!(validate_email("@example.com").is_err(), "empty local part");
        assert!(validate_email("user@").is_err(), "empty domain");
        assert!(
            validate_email("user @example.com").is_err(),
            "no whitespace"
        );
        let too_long = format!("{}@example.com", "a".repeat(300));
        assert!(validate_email(&too_long).is_err(), "length is capped");
    }

    #[test]
    fn a_stored_credential_must_be_a_lowercase_hex_auth_hash() {
        let hash = "0123456789abcdef".repeat(4);
        assert!(validate_auth_hash(&hash).is_ok());
        assert!(
            validate_auth_hash("hunter2hunter").is_err(),
            "a raw password"
        );
        assert!(validate_auth_hash(&hash[1..]).is_err(), "too short");
        assert!(validate_auth_hash(&format!("{hash}0")).is_err(), "too long");
        assert!(
            validate_auth_hash(&hash.to_uppercase()).is_err(),
            "the client sends lowercase, and login compares the exact string"
        );
        assert!(validate_auth_hash(&format!("{}g", &hash[1..])).is_err());
        assert!(validate_auth_hash(&"x".repeat(MAX_PASSWORD_LEN + 1)).is_err());
    }
}
