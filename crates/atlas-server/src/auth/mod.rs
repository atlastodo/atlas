//! Authentication: password hashing, tokens, HTTP handlers, and the `AuthUser` extractor.

pub mod account_purge;
pub mod api_tokens;
mod handlers;
pub(crate) mod identity;
pub mod kdf;
pub mod passkeys;
pub mod password;
mod recovery;
pub mod root_key;
pub mod token;
pub mod webauthn;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

/// Routes under `/auth`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/salt", get(handlers::get_salt))
        .route("/auth/signup", post(handlers::signup))
        .route("/auth/login", post(handlers::login))
        .route("/auth/refresh", post(handlers::refresh))
        .route("/auth/logout", post(handlers::logout))
        .route("/auth/me", get(handlers::me))
        .route("/auth/change-password", post(handlers::change_password))
        .route("/auth/recovery-keys", get(handlers::get_recovery_keys))
        .route("/auth/recover", post(handlers::recover_account))
        .route("/auth/recovery-key", put(handlers::register_recovery_key))
        .route(
            "/auth/recovery-key/replace",
            post(handlers::replace_recovery_key),
        )
        .route(
            "/auth/signing-key",
            get(identity::get_signing_key).put(identity::put_signing_key),
        )
        .route("/auth/account", delete(handlers::delete_account))
        .route(
            "/auth/account/cancel-deletion",
            post(handlers::cancel_account_deletion),
        )
        .route("/auth/export", get(handlers::export))
        .route("/auth/sessions", get(handlers::list_sessions))
        .route(
            "/auth/sessions/revoke-others",
            post(handlers::revoke_other_devices),
        )
        .route(
            "/auth/sessions/{device_id}",
            patch(handlers::rename_session).delete(handlers::revoke_session),
        )
        .route(
            "/auth/api-tokens",
            get(api_tokens::list).post(api_tokens::create),
        )
        .route("/auth/api-tokens/{id}", delete(api_tokens::revoke))
        .route("/auth/api-token/session", post(api_tokens::open_session))
        .route("/auth/root-key", get(root_key::get).post(root_key::migrate))
        .route("/auth/root-key/recovery", put(root_key::put_recovery_slot))
        .route("/auth/app-keys/{app}", put(root_key::put_app_key))
        .route("/auth/password", delete(handlers::remove_password))
        .route(
            "/auth/passkeys",
            get(passkeys::list).post(passkeys::register),
        )
        .route(
            "/auth/passkeys/{id}",
            patch(passkeys::rename).delete(passkeys::remove),
        )
        .route(
            "/auth/passkeys/signup/options",
            post(passkeys::signup_options),
        )
        .route(
            "/auth/passkeys/register/options",
            post(passkeys::register_options),
        )
        .route(
            "/auth/passkeys/login/options",
            post(passkeys::login_options),
        )
        .route("/auth/passkeys/login", post(passkeys::login))
        .route(
            "/auth/passkeys/reauth/options",
            post(passkeys::reauth_options),
        )
        .route("/auth/passkeys/reauth", post(passkeys::reauth))
        .route("/users/public-key", get(handlers::get_public_key))
}

/// Extractor that authenticates a request via `Authorization: Bearer <access-token>`. Rejects
/// with 401 when the header is missing/malformed, the token invalid/expired, or the account gone.
///
/// The token is stateless, so a disabled or deletion-scheduled account and a revoked session
/// (signed out, or ended from another device) are caught here by re-checking them on every
/// request, taking effect on the next call rather than at access-token expiry.
/// [`AuthUserAllowScheduled`] admits a scheduled deletion.
pub struct AuthUser {
    pub user_id: Uuid,
    /// The device the token was issued to (`did` claim), which lets the session endpoints spare
    /// the caller's own family. `None` for a token minted before the claim: the conservative
    /// "unknown device" reading.
    pub device_id: Option<Uuid>,
    /// When the access token expires (unix seconds); a sync socket opened on it closes then.
    pub token_expires_at: i64,
    /// Whether an API token opened the session (`device_id` is then the token's id). Such a
    /// session reaches the data routes only; see [`InteractiveAuthUser`].
    pub api_token: bool,
    /// For an API-token session, the apps its token carries keys for (`api_tokens.apps`): the
    /// only apps it may sync. `None` for an interactive session.
    pub token_apps: Option<Vec<String>>,
}

/// [`AuthUser`] for the account-critical routes (credentials, recovery, sessions, API tokens,
/// account deletion, export, admin): refuses an API-token session with 403
/// `interactive_session_required`, so a leaked integration token cannot take the account over.
pub struct InteractiveAuthUser(pub AuthUser);

impl FromRequestParts<AppState> for InteractiveAuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if user.api_token {
            return Err(AppError::InteractiveSessionRequired);
        }
        Ok(InteractiveAuthUser(user))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let (user, deletion_scheduled_at) = authenticate_bearer(parts, state).await?;
        if let Some(scheduled_at) = deletion_scheduled_at {
            return Err(handlers::scheduled_deletion_error(scheduled_at));
        }
        Ok(user)
    }
}

/// [`AuthUser`] that also admits an account in its deletion grace period, for the data export.
/// Interactive only, like [`InteractiveAuthUser`].
pub struct AuthUserAllowScheduled(pub AuthUser);

impl FromRequestParts<AppState> for AuthUserAllowScheduled {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = authenticate_bearer(parts, state).await?.0;
        if user.api_token {
            return Err(AppError::InteractiveSessionRequired);
        }
        Ok(AuthUserAllowScheduled(user))
    }
}

/// Verify the bearer token and that its account exists and is not disabled; also returns when a
/// deletion was scheduled, which the caller decides about.
async fn authenticate_bearer(
    parts: &Parts,
    state: &AppState,
) -> Result<(AuthUser, Option<time::OffsetDateTime>), AppError> {
    let header = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let token = header
        .strip_prefix("Bearer ")
        .ok_or(AppError::Unauthorized)?;
    let claims = token::verify_access_token(token, &state.config.jwt_secret)
        .map_err(|_| AppError::Unauthorized)?;
    // A token minted before the `did` claim has no session to check. An API-token session is
    // live while its token is unrevoked; a device session while its refresh family is.
    let api_token = claims.kind == Some(token::TokenKind::ApiToken);
    if api_token && claims.did.is_none() {
        return Err(AppError::Unauthorized);
    }
    let (disabled, deletion_scheduled_at, live_session, token_apps): (
        bool,
        Option<time::OffsetDateTime>,
        bool,
        Option<Vec<String>>,
    ) = sqlx::query_as(
        "SELECT disabled_at IS NOT NULL, deletion_scheduled_at,
                CASE WHEN $3 THEN EXISTS (
                    SELECT 1 FROM api_tokens
                     WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL)
                ELSE $2::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM refresh_tokens
                     WHERE user_id = $1 AND device_id = $2
                       AND revoked_at IS NULL AND expires_at > now())
                END,
                CASE WHEN $3 THEN (
                    SELECT apps FROM api_tokens
                     WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL)
                END
           FROM users WHERE id = $1",
    )
    .bind(claims.sub)
    .bind(claims.did)
    .bind(api_token)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    // Typed 403s, not 401: the credentials are fine, and the client must not enter the
    // refresh-and-retry loop over a rejection refresh cannot fix.
    if disabled {
        return Err(AppError::AccountDisabled);
    }
    // Scheduling a deletion also ends every session. The token in hand still reaches the export
    // until it expires (`AuthUserAllowScheduled`), as no new session can be had in the grace
    // period; `AuthUser` refuses it with the typed error.
    // An API token never reaches the grace-period export, so it needs a live token regardless.
    if !live_session && (api_token || deletion_scheduled_at.is_none()) {
        return Err(AppError::Unauthorized);
    }
    Ok((
        AuthUser {
            user_id: claims.sub,
            device_id: claims.did,
            token_expires_at: claims.exp,
            api_token,
            // A token session always has a list (empty only if the row vanished meanwhile).
            token_apps: api_token.then(|| token_apps.unwrap_or_default()),
        },
        deletion_scheduled_at,
    ))
}

/// Extractor for an endpoint reachable without a session that still attributes the caller when
/// one is present. Never rejects: a missing, malformed, invalid or expired token yields `None`.
/// `POST /reports` uses it, since crashes before sign-in have no token.
pub struct OptionalAuthUser(pub Option<Uuid>);

impl FromRequestParts<AppState> for OptionalAuthUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user_id = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .and_then(|token| token::verify_access_token(token, &state.config.jwt_secret).ok())
            .map(|claims| claims.sub);
        Ok(OptionalAuthUser(user_id))
    }
}
