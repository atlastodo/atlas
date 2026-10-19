//! Passkeys: WebAuthn credentials that sign in and unlock the account.
//!
//! Every passkey here is required to support the PRF extension. The client derives a 32-byte slot
//! key from the passkey's PRF output (HKDF-SHA256 over the output, salt = the raw credential id,
//! info `"atlas-passkey-slot-v1"`) and stores the account root key wrapped under it
//! (`passkeys.encrypted_root_key`, slot `"passkey:<credential id>"`). The PRF output itself never
//! leaves the client; a response that carries it is refused. So a passkey is one more unlock slot
//! next to the password and the recovery phrase, and an account may have passkeys only.
//!
//! The PRF input (`prf_salt`) is one constant for every credential, [`prf_input`]: a discoverable
//! sign-in does not know which passkey will answer, so it cannot name a per-credential input.
//! Different passkeys still give unrelated outputs (the authenticator's PRF secret is per
//! credential), and the HKDF salt binds the slot key to the credential id.
//!
//! Ceremonies (each challenge is single-use and expires, [`issue_challenge`]):
//! - Sign-up with a passkey instead of a password: `POST /auth/passkeys/signup/options`, then
//!   `POST /auth/signup` with `passkey` ([`super::handlers::signup`]).
//! - Add one: `POST /auth/passkeys/register/options`, then `POST /auth/passkeys` (with the current
//!   password or a passkey proof: a bearer token alone must not add a way in).
//! - Sign in: `POST /auth/passkeys/login/options` (discoverable, or email-first), then
//!   `POST /auth/passkeys/login`: a session like a password login, plus the passkey's root slot.
//! - Re-authenticate: `POST /auth/passkeys/reauth/options`, then `POST /auth/passkeys/reauth`,
//!   which answers a short-lived single-use proof ([`REAUTH_TTL_SECS`]) that the account-critical
//!   routes take as `reauth_token` in place of `current_password`, and the root slot (an unlock).
//!
//! Every authenticated route here is interactive ([`InteractiveAuthUser`]); an API-token session
//! gets 403. A recovery, a scheduled deletion and a dropped root key delete the passkeys; a
//! password change keeps them (the root they wrap is unchanged).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

use super::handlers::{passkey_sign_in, verify_password_hash, AuthResponse};
use super::root_key;
use super::webauthn::{
    b64url, b64url_decode, prf_report, response_challenge, AssertionResponse, NewCredential,
    PrfReport, RegistrationResponse, RelyingParty,
};
use super::InteractiveAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The PRF extension's input for every passkey: SHA-256 of this label.
pub const PRF_INPUT_LABEL: &str = "atlas-passkey-prf-v1";
/// How long a ceremony's challenge is answerable (the client's timeout is five minutes).
const CHALLENGE_TTL_SECS: i64 = 6 * 60;
/// How long a re-authentication proof lasts.
pub const REAUTH_TTL_SECS: i64 = 5 * 60;
/// How many passkeys one account may hold.
pub const MAX_PASSKEYS: i64 = 25;
const MAX_NAME_LEN: usize = 100;
const MAX_TRANSPORTS: usize = 8;

/// The PRF input, base64url.
pub fn prf_input() -> String {
    b64url(&Sha256::digest(PRF_INPUT_LABEL.as_bytes()))
}

fn relying_party(state: &AppState) -> AppResult<RelyingParty> {
    let cfg = state
        .config
        .passkeys
        .as_ref()
        .ok_or(AppError::PasskeysDisabled)?;
    RelyingParty::new(&cfg.rp_id, &cfg.rp_name, &cfg.origins).map_err(|e| {
        tracing::error!(error = %e, "passkey relying party configuration");
        AppError::Internal
    })
}

/// The root key under a passkey's slot, as a sign-in or re-authentication hands it back.
#[derive(Debug, Clone, Serialize)]
pub struct PasskeySlot {
    pub id: Uuid,
    /// base64url of the raw credential id; the slot is `"passkey:<credential_id>"`.
    pub credential_id: String,
    pub encrypted_root_key: Value,
}

/// The passkey half of a passkey signup ([`super::handlers::SignupRequest::passkey`]).
#[derive(Debug, Clone, Deserialize)]
pub struct SignupPasskey {
    pub credential: RegistrationResponse,
    #[serde(default)]
    pub name: Option<String>,
    /// The root key wrapped under the passkey's slot key.
    pub encrypted_root_key: Value,
}

/// A registration that verified, ready to store.
pub struct VerifiedPasskey {
    credential: NewCredential,
    transports: Vec<String>,
    name: String,
    encrypted_root_key: Value,
}

#[derive(Debug, Serialize)]
pub struct OptionsResponse {
    /// `PublicKeyCredentialCreationOptionsJSON` or `PublicKeyCredentialRequestOptionsJSON`.
    pub options: Value,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PasskeyView {
    pub id: Uuid,
    pub credential_id: String,
    pub name: String,
    pub transports: Vec<String>,
    pub backup_eligible: bool,
    pub backed_up: bool,
    /// Unix millis, like the session list.
    #[sqlx(skip)]
    pub created_at: i64,
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

fn clean_name(name: Option<&str>) -> AppResult<String> {
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or("Passkey");
    if name.len() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(
            "a passkey name is at most 100 bytes".into(),
        ));
    }
    Ok(name.to_owned())
}

/// Only a passkey whose client reports PRF on can unlock; one that sends the PRF output is
/// refused outright (it must stay on the device).
fn check_prf(client_extension_results: &Value) -> AppResult<()> {
    match prf_report(client_extension_results) {
        PrfReport::Enabled => Ok(()),
        PrfReport::Missing => Err(AppError::PasskeyPrfUnsupported),
        PrfReport::LeakedOutput => Err(AppError::BadRequest(
            "clientExtensionResults.prf.results must not be sent".into(),
        )),
    }
}

fn transports_of(response: &RegistrationResponse) -> Vec<String> {
    const KNOWN: &[&str] = &["usb", "nfc", "ble", "smart-card", "hybrid", "internal"];
    let mut out: Vec<String> = Vec::new();
    for t in response.transports() {
        if KNOWN.contains(&t.as_str()) && !out.contains(&t) && out.len() < MAX_TRANSPORTS {
            out.push(t);
        }
    }
    out
}

/// Normalize a credential id to unpadded base64url; `None` when it is not base64url.
fn normalize_credential_id(raw: &str) -> Option<String> {
    b64url_decode(raw)
        .filter(|b| !b.is_empty() && b.len() <= super::webauthn::MAX_CREDENTIAL_ID_LEN)
        .map(|b| b64url(&b))
}

/// Store a ceremony `webauthn-rs` started: its options' challenge, its purpose and account, and
/// its state, until the answer spends it. Expired ceremonies and re-auth proofs are swept here.
/// Answers the options for the client.
async fn issue_challenge(
    state: &AppState,
    purpose: &'static str,
    user_id: Option<Uuid>,
    (options, ceremony): (Value, Value),
) -> AppResult<Json<OptionsResponse>> {
    sqlx::query("DELETE FROM webauthn_challenges WHERE expires_at < now()")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM passkey_reauth_proofs WHERE expires_at < now()")
        .execute(&state.pool)
        .await?;
    let challenge = options["challenge"]
        .as_str()
        .and_then(b64url_decode)
        .map(|b| b64url(&b))
        .ok_or(AppError::Internal)?;
    sqlx::query(
        "INSERT INTO webauthn_challenges (challenge, purpose, user_id, state, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(&challenge)
    .bind(purpose)
    .bind(user_id)
    .bind(&ceremony)
    .bind(CHALLENGE_TTL_SECS as f64)
    .execute(&state.pool)
    .await?;
    Ok(Json(OptionsResponse { options }))
}

/// A ceremony being answered: the account it was issued for (`None` for a discoverable
/// sign-in) and the state `webauthn-rs` verifies against.
struct Ceremony {
    user_id: Option<Uuid>,
    state: Value,
}

/// Spend a ceremony: the one a response's challenge names, if it is live and of `purpose`;
/// `None` when there is no such ceremony.
async fn take_challenge(
    executor: impl sqlx::Executor<'_, Database = sqlx::Postgres>,
    challenge: &str,
    purpose: &'static str,
) -> AppResult<Option<Ceremony>> {
    let row: Option<(Option<Uuid>, Value)> = sqlx::query_as(
        "DELETE FROM webauthn_challenges
          WHERE challenge = $1 AND purpose = $2 AND expires_at > now()
      RETURNING user_id, state",
    )
    .bind(challenge)
    .bind(purpose)
    .fetch_optional(executor)
    .await?;
    Ok(row.map(|(user_id, state)| Ceremony { user_id, state }))
}

/// A ceremony could not start (the relying party refused its own input).
fn internal(e: impl std::fmt::Display) -> AppError {
    tracing::error!(error = %e, "could not start a passkey ceremony");
    AppError::Internal
}

fn invalid(e: impl std::fmt::Display) -> AppError {
    AppError::PasskeyInvalid(e.to_string())
}

const NO_CEREMONY: &str = "the ceremony is unknown or has expired; start again";

/// Shape checks of a passkey signup, before anything is spent.
pub(super) fn validate_signup_passkey(state: &AppState, passkey: &SignupPasskey) -> AppResult<()> {
    relying_party(state)?;
    root_key::validate_wrap("passkey.encrypted_root_key", &passkey.encrypted_root_key)?;
    clean_name(passkey.name.as_deref())?;
    check_prf(passkey.credential.client_extension_results())
}

/// Verify a passkey signup's registration against the signup ceremony begun for `user_id`,
/// spending it on `conn` (the signup's transaction).
pub(super) async fn verify_signup_passkey(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    passkey: &SignupPasskey,
) -> AppResult<VerifiedPasskey> {
    let rp = relying_party(state)?;
    let challenge = response_challenge(passkey.credential.client_data_json()).map_err(invalid)?;
    let ceremony = match take_challenge(&mut *conn, &challenge, "signup").await? {
        Some(c) if c.user_id == Some(user_id) => c,
        _ => return Err(invalid(NO_CEREMONY)),
    };
    let credential = rp
        .verify_registration(&passkey.credential, &ceremony.state)
        .map_err(invalid)?;
    Ok(VerifiedPasskey {
        credential,
        transports: transports_of(&passkey.credential),
        name: clean_name(passkey.name.as_deref())?,
        encrypted_root_key: passkey.encrypted_root_key.clone(),
    })
}

/// Store a verified passkey for `user_id`; 409 when the credential is already registered.
pub(super) async fn store_passkey(
    conn: &mut sqlx::PgConnection,
    user_id: Uuid,
    passkey: &VerifiedPasskey,
) -> AppResult<PasskeySlot> {
    let c = &passkey.credential;
    let id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO passkeys (user_id, credential_id, credential, sign_count,
                               transports, backup_eligible, backed_up, prf_salt, name,
                               encrypted_root_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (credential_id) DO NOTHING
         RETURNING id",
    )
    .bind(user_id)
    .bind(&c.credential_id)
    .bind(&c.passkey)
    .bind(i64::from(c.sign_count))
    .bind(&passkey.transports)
    .bind(c.backup_eligible)
    .bind(c.backed_up)
    .bind(prf_input())
    .bind(&passkey.name)
    .bind(&passkey.encrypted_root_key)
    .fetch_optional(&mut *conn)
    .await?;
    let id = id.ok_or_else(|| AppError::Conflict("this passkey".into()))?;
    Ok(PasskeySlot {
        id,
        credential_id: c.credential_id.clone(),
        encrypted_root_key: passkey.encrypted_root_key.clone(),
    })
}

/// Spend a re-authentication proof of `user_id`; a wrong, spent or expired one is
/// [`AppError::InvalidCredentials`].
pub(super) async fn consume_reauth_proof(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    token: &str,
) -> AppResult<()> {
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let spent = sqlx::query(
        "DELETE FROM passkey_reauth_proofs
          WHERE token_hash = $1 AND user_id = $2 AND expires_at > now()",
    )
    .bind(&hash)
    .bind(user_id)
    .execute(pool)
    .await?;
    if spent.rows_affected() == 0 {
        return Err(AppError::InvalidCredentials);
    }
    Ok(())
}

/// The account's stored passkeys (`webauthn-rs` JSON) and each one's `(credential id, PRF input)`.
async fn credentials_of(
    state: &AppState,
    user_id: Uuid,
) -> AppResult<(Vec<Value>, Vec<(String, String)>)> {
    let rows: Vec<(String, Value, String)> = sqlx::query_as(
        "SELECT credential_id, credential, prf_salt FROM passkeys
          WHERE user_id = $1 ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let passkeys = rows.iter().map(|(_, cred, _)| cred.clone()).collect();
    let prf = rows.into_iter().map(|(id, _, salt)| (id, salt)).collect();
    Ok((passkeys, prf))
}

#[derive(Debug, Deserialize)]
pub struct SignupOptionsRequest {
    /// The account id the signup will use (client-chosen: the root wraps bind it). It is the
    /// passkey's user handle, which a discoverable sign-in hands back.
    pub user_id: Uuid,
    pub email: String,
    #[serde(default)]
    pub display_name: String,
}

/// `POST /auth/passkeys/signup/options`: begin a passkey signup. Unauthenticated; whether the
/// email is free, signup open or an invite valid is decided by `POST /auth/signup`.
pub async fn signup_options(
    State(state): State<AppState>,
    Json(req): Json<SignupOptionsRequest>,
) -> AppResult<Json<OptionsResponse>> {
    let rp = relying_party(&state)?;
    let email = req.email.trim().to_lowercase();
    let display_name = req.display_name.trim();
    if email.is_empty() || email.len() > 254 || display_name.len() > 200 {
        return Err(AppError::BadRequest("a valid email is required".into()));
    }
    let ceremony = rp
        .creation_options(req.user_id, &email, display_name, &[], &prf_input())
        .map_err(internal)?;
    issue_challenge(&state, "signup", Some(req.user_id), ceremony).await
}

/// `POST /auth/passkeys/register/options`: begin adding a passkey to the signed-in account.
/// Needs a migrated account (the passkey wraps the root key).
pub async fn register_options(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<OptionsResponse>> {
    let rp = relying_party(&state)?;
    let (email, display_name, has_root): (String, String, bool) = sqlx::query_as(
        "SELECT email::TEXT, display_name, root_key_created_at IS NOT NULL
           FROM users WHERE id = $1",
    )
    .bind(user.user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    if !has_root {
        return Err(AppError::BadRequest("the account has no root key".into()));
    }
    let (_, existing) = credentials_of(&state, user.user_id).await?;
    if existing.len() as i64 >= MAX_PASSKEYS {
        return Err(AppError::Conflict(format!(
            "the limit of {MAX_PASSKEYS} passkeys"
        )));
    }
    let exclude: Vec<String> = existing.into_iter().map(|(id, _)| id).collect();
    let ceremony = rp
        .creation_options(user.user_id, &email, &display_name, &exclude, &prf_input())
        .map_err(internal)?;
    issue_challenge(&state, "register", Some(user.user_id), ceremony).await
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub credential: RegistrationResponse,
    #[serde(default)]
    pub name: Option<String>,
    pub encrypted_root_key: Value,
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

fn view_from(row: PasskeyRow) -> PasskeyView {
    PasskeyView {
        id: row.id,
        credential_id: row.credential_id,
        name: row.name,
        transports: row.transports,
        backup_eligible: row.backup_eligible,
        backed_up: row.backed_up,
        created_at: row.created_at.unix_timestamp() * 1000,
        last_used_at: row.last_used_at.map(|t| t.unix_timestamp() * 1000),
    }
}

#[derive(sqlx::FromRow)]
struct PasskeyRow {
    id: Uuid,
    credential_id: String,
    name: String,
    transports: Vec<String>,
    backup_eligible: bool,
    backed_up: bool,
    created_at: OffsetDateTime,
    last_used_at: Option<OffsetDateTime>,
}

const VIEW_COLUMNS: &str =
    "id, credential_id, name, transports, backup_eligible, backed_up, created_at, last_used_at";

/// `POST /auth/passkeys`: finish adding a passkey. Needs the current password or a passkey proof,
/// since a passkey is a way into the account, and the root key wrapped under the passkey's slot.
pub async fn register(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<RegisterRequest>,
) -> AppResult<(StatusCode, Json<PasskeyView>)> {
    let rp = relying_party(&state)?;
    root_key::validate_wrap("encrypted_root_key", &req.encrypted_root_key)?;
    let name = clean_name(req.name.as_deref())?;
    check_prf(req.credential.client_extension_results())?;
    let challenge = response_challenge(req.credential.client_data_json()).map_err(invalid)?;
    verify_password_hash(
        &state,
        user.user_id,
        req.current_password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;

    let mut tx = state.pool.begin().await?;
    let ceremony = match take_challenge(&mut *tx, &challenge, "register").await? {
        Some(c) if c.user_id == Some(user.user_id) => c,
        _ => return Err(invalid(NO_CEREMONY)),
    };
    let credential = rp
        .verify_registration(&req.credential, &ceremony.state)
        .map_err(invalid)?;
    let has_root: bool = sqlx::query_scalar(
        "SELECT root_key_created_at IS NOT NULL FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await?;
    if !has_root {
        return Err(AppError::BadRequest("the account has no root key".into()));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id = $1")
        .bind(user.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= MAX_PASSKEYS {
        return Err(AppError::Conflict(format!(
            "the limit of {MAX_PASSKEYS} passkeys"
        )));
    }
    let verified = VerifiedPasskey {
        credential,
        transports: transports_of(&req.credential),
        name,
        encrypted_root_key: req.encrypted_root_key.clone(),
    };
    let slot = store_passkey(&mut tx, user.user_id, &verified).await?;
    let row: PasskeyRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLUMNS} FROM passkeys WHERE id = $1"
    )))
    .bind(slot.id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(view_from(row))))
}

/// `GET /auth/passkeys`: the account's passkeys, oldest first.
pub async fn list(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<Vec<PasskeyView>>> {
    let rows: Vec<PasskeyRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLUMNS} FROM passkeys WHERE user_id = $1 ORDER BY created_at, id"
    )))
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(view_from).collect()))
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub name: String,
}

/// `PATCH /auth/passkeys/:id`: rename a passkey.
pub async fn rename(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameRequest>,
) -> AppResult<StatusCode> {
    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("a passkey name is required".into()));
    }
    let name = clean_name(Some(&req.name))?;
    let res = sqlx::query("UPDATE passkeys SET name = $1 WHERE id = $2 AND user_id = $3")
        .bind(&name)
        .bind(id)
        .bind(user.user_id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RemoveRequest {
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

/// `DELETE /auth/passkeys/:id`: remove a passkey (with the current password or a passkey proof).
/// The last passkey of an account without a password is 409 `last_unlock_method`.
pub async fn remove(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<RemoveRequest>,
) -> AppResult<StatusCode> {
    verify_password_hash(
        &state,
        user.user_id,
        req.current_password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let mut tx = state.pool.begin().await?;
    let has_password: bool =
        sqlx::query_scalar("SELECT password_hash IS NOT NULL FROM users WHERE id = $1 FOR UPDATE")
            .bind(user.user_id)
            .fetch_one(&mut *tx)
            .await?;
    let others: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM passkeys WHERE user_id = $1 AND id <> $2")
            .bind(user.user_id)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let res = sqlx::query("DELETE FROM passkeys WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    if !has_password && others == 0 {
        return Err(AppError::LastUnlockMethod);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub struct LoginOptionsRequest {
    /// Email-first sign-in: the account's passkeys are named. Without it the request is
    /// discoverable (the authenticator offers this site's passkeys).
    #[serde(default)]
    pub email: Option<String>,
}

/// `POST /auth/passkeys/login/options`: begin a passkey sign-in. Unauthenticated. An email that
/// has no passkeys (or no account) gets a stand-in credential, so the answer does not tell.
pub async fn login_options(
    State(state): State<AppState>,
    Json(req): Json<LoginOptionsRequest>,
) -> AppResult<Json<OptionsResponse>> {
    let rp = relying_party(&state)?;
    let email = req
        .email
        .as_deref()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty());
    let Some(email) = email else {
        let ceremony = rp.discoverable_options(&prf_input()).map_err(internal)?;
        return issue_challenge(&state, "login", None, ceremony).await;
    };
    let user_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM users WHERE email = $1 AND is_e2ee = TRUE")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?;
    let (passkeys, prf) = match user_id {
        Some(id) => credentials_of(&state, id).await?,
        None => (Vec::new(), Vec::new()),
    };
    if passkeys.is_empty() {
        // No passkey to name: a discoverable ceremony that names a stand-in credential, shaped
        // like a real one, so the answer does not tell whether the account exists. No passkey
        // answers for it, and any other assertion is held to an account of `None`, like a
        // discoverable sign-in.
        let mut h = Sha256::new();
        h.update(state.config.jwt_secret.as_slice());
        h.update(b"passkey-dummy");
        h.update(email.as_bytes());
        let id = b64url(&h.finalize()[..16]);
        let (mut options, ceremony) = rp.discoverable_options(&prf_input()).map_err(internal)?;
        options["allowCredentials"] = serde_json::json!([{ "type": "public-key", "id": id, "transports": ["internal", "hybrid"] }]);
        options["extensions"]["prf"]["evalByCredential"] =
            serde_json::json!({ id: { "first": prf_input() } });
        return issue_challenge(&state, "login", None, (options, ceremony)).await;
    }
    let ceremony = rp
        .request_options(&passkeys, &prf_input(), &prf)
        .map_err(internal)?;
    issue_challenge(&state, "login", user_id, ceremony).await
}

/// The stored passkey an assertion names, once verified: its slot.
struct Asserted {
    user_id: Uuid,
    slot: PasskeySlot,
}

/// Verify an assertion for a ceremony of `purpose` and advance the passkey's counter. `expected`
/// is the account the caller already knows (a re-authentication). Every failure is the same
/// error, `fail`.
async fn verify_assertion(
    state: &AppState,
    credential: &AssertionResponse,
    purpose: &'static str,
    expected: Option<Uuid>,
    fail: fn() -> AppError,
) -> AppResult<Asserted> {
    let rp = relying_party(state)?;
    let challenge = response_challenge(credential.client_data_json()).map_err(|_| fail())?;
    let ceremony = take_challenge(&state.pool, &challenge, purpose)
        .await?
        .ok_or_else(fail)?;
    let ceremony_user = ceremony.user_id;
    let credential_id = normalize_credential_id(credential.raw_id()).ok_or_else(fail)?;
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        user_id: Uuid,
        credential: Value,
        sign_count: i64,
        encrypted_root_key: Value,
    }
    let row: Row = sqlx::query_as(
        "SELECT id, user_id, credential, sign_count, encrypted_root_key
           FROM passkeys WHERE credential_id = $1",
    )
    .bind(&credential_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(fail)?;
    // The ceremony's account (email-first or re-authentication), the caller's and the user
    // handle the authenticator returns must all be the passkey's.
    if ceremony_user.is_some_and(|u| u != row.user_id) || expected.is_some_and(|u| u != row.user_id)
    {
        return Err(fail());
    }
    if let Some(handle) = credential.user_handle() {
        if b64url_decode(handle).as_deref() != Some(row.user_id.as_bytes().as_slice()) {
            return Err(fail());
        }
    }
    let outcome = rp
        .verify_assertion(credential, &ceremony.state, &row.credential)
        .map_err(|e| {
            tracing::info!(error = %e, "passkey assertion refused");
            fail()
        })?;
    // Lands only while the counter is where it was read: two uses of one assertion race here.
    let updated = sqlx::query(
        "UPDATE passkeys SET sign_count = $2, backed_up = $3, credential = $5, last_used_at = now()
          WHERE id = $1 AND sign_count = $4",
    )
    .bind(row.id)
    .bind(i64::from(outcome.sign_count))
    .bind(outcome.backed_up)
    .bind(row.sign_count)
    .bind(&outcome.passkey)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(fail());
    }
    Ok(Asserted {
        user_id: row.user_id,
        slot: PasskeySlot {
            id: row.id,
            credential_id,
            encrypted_root_key: row.encrypted_root_key,
        },
    })
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub credential: AssertionResponse,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub install_key: Option<String>,
}

/// `POST /auth/passkeys/login`: finish a passkey sign-in. Answers like `POST /auth/login`, plus
/// `passkey`: the root key under this passkey's slot. A response that does not verify is a bare
/// 401.
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let asserted = verify_assertion(&state, &req.credential, "login", None, || {
        AppError::Unauthorized
    })
    .await?;
    let mut resp = passkey_sign_in(
        &state,
        asserted.user_id,
        req.device_name,
        req.install_key.as_deref(),
    )
    .await?;
    resp.passkey = Some(asserted.slot);
    Ok(Json(resp))
}

/// `POST /auth/passkeys/reauth/options`: begin re-authenticating the signed-in account with one
/// of its passkeys.
pub async fn reauth_options(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<OptionsResponse>> {
    let rp = relying_party(&state)?;
    let (allow, prf) = credentials_of(&state, user.user_id).await?;
    if allow.is_empty() {
        return Err(AppError::BadRequest("the account has no passkeys".into()));
    }
    let ceremony = rp
        .request_options(&allow, &prf_input(), &prf)
        .map_err(internal)?;
    issue_challenge(&state, "reauth", Some(user.user_id), ceremony).await
}

#[derive(Debug, Deserialize)]
pub struct ReauthRequest {
    pub credential: AssertionResponse,
}

#[derive(Debug, Serialize)]
pub struct ReauthResponse {
    /// Single-use; pass as `reauth_token` where a route takes `current_password`.
    pub reauth_token: String,
    pub expires_in: i64,
    /// The root key under the passkey's slot, so a re-authentication also unlocks.
    pub passkey: PasskeySlot,
}

/// `POST /auth/passkeys/reauth`: finish a re-authentication. A response that does not verify is
/// 403 `invalid_credentials`, like a wrong current password.
pub async fn reauth(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<ReauthRequest>,
) -> AppResult<Json<ReauthResponse>> {
    let asserted = verify_assertion(
        &state,
        &req.credential,
        "reauth",
        Some(user.user_id),
        || AppError::InvalidCredentials,
    )
    .await?;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = b64url(&bytes);
    sqlx::query(
        "INSERT INTO passkey_reauth_proofs (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))",
    )
    .bind(hex::encode(Sha256::digest(token.as_bytes())))
    .bind(user.user_id)
    .bind(REAUTH_TTL_SECS as f64)
    .execute(&state.pool)
    .await?;
    Ok(Json(ReauthResponse {
        reauth_token: token,
        expires_in: REAUTH_TTL_SECS,
        passkey: asserted.slot,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prf_input_is_the_hash_of_its_label() {
        // Pinned in test-vectors/passkey_vectors.json too: the client sends the same input.
        assert_eq!(
            prf_input(),
            b64url(&Sha256::digest(b"atlas-passkey-prf-v1"))
        );
        assert_eq!(prf_input().len(), 43);
    }

    /// The client's vectors: the same PRF input, and a slot key derivation an independent HKDF
    /// reproduces (the server never derives one; this pins the documented scheme).
    #[test]
    fn matches_the_passkey_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../test-vectors/passkey_vectors.json"
        ))
        .unwrap();
        assert_eq!(vectors["prf_input"], prf_input());
        for v in vectors["vectors"].as_array().unwrap() {
            let prf = hex::decode(v["prf_output"].as_str().unwrap()).unwrap();
            let id = b64url_decode(v["credential_id"].as_str().unwrap()).unwrap();
            let mut key = [0u8; 32];
            hkdf::Hkdf::<Sha256>::new(Some(&id), &prf)
                .expand(b"atlas-passkey-slot-v1", &mut key)
                .unwrap();
            assert_eq!(hex::encode(key), v["slot_key"].as_str().unwrap());
            assert_eq!(
                v["slot"].as_str().unwrap(),
                format!(
                    "passkey:{}",
                    normalize_credential_id(v["credential_id"].as_str().unwrap()).unwrap()
                )
            );
        }
    }

    #[test]
    fn credential_ids_normalize_to_unpadded_base64url() {
        assert_eq!(normalize_credential_id("AQID").as_deref(), Some("AQID"));
        assert_eq!(normalize_credential_id("AQI=").as_deref(), Some("AQI"));
        assert_eq!(normalize_credential_id(""), None);
        assert_eq!(normalize_credential_id("not base64!"), None);
    }

    #[test]
    fn names_default_and_are_capped() {
        assert_eq!(clean_name(None).unwrap(), "Passkey");
        assert_eq!(clean_name(Some("  Phone ")).unwrap(), "Phone");
        assert!(clean_name(Some(&"x".repeat(101))).is_err());
    }
}
