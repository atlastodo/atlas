//! Application error type and its HTTP representation.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Errors surfaced from handlers. Each maps to an HTTP status + JSON body `{ "error": msg }`, plus
/// a `"code"` for the variants [`AppError::code`] names.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    /// A wrong current credential on an authenticated re-check. A 403, not 401, which would
    /// send the client into its refresh-and-retry loop.
    #[error("invalid credentials")]
    InvalidCredentials,
    /// A refresh token another tab rotated moments ago: the caller should pick up the newer token.
    #[error("refresh superseded")]
    RefreshSuperseded,
    #[error("account_scheduled_deletion")]
    AccountScheduledDeletion { days_remaining: i64 },
    /// The deletion grace period is over; the account awaits the next purge pass.
    #[error("account_deleted")]
    AccountDeleted,
    #[error("signup_disabled")]
    SignupDisabled,
    #[error("account_disabled")]
    AccountDisabled,
    /// An account from before end-to-end encryption, which can no longer sign in.
    #[error("legacy account")]
    LegacyAccount,
    #[error("invite_invalid")]
    InviteInvalid,
    #[error("forbidden: {0}")]
    Forbidden(String),
    /// An API-token session on a route only a signed-in device may use.
    #[error("this needs a signed-in device, not an API token")]
    InteractiveSessionRequired,
    /// An op or request naming an app (`manifests/<app>.json`) that is not enabled for this
    /// instance (`ATLAS_APPS`) or account (`account_apps`). 403 with `code: app_not_enabled`.
    #[error("the {app} app is not enabled for this {scope}")]
    AppNotEnabled { app: String, scope: &'static str },
    #[error("{0} already exists")]
    Conflict(String),
    /// `PUT /auth/recovery-key` naming a key other than the one already registered.
    #[error("a different recovery key is already registered")]
    RecoveryKeyAlreadySet,
    /// `PUT /auth/signing-key` naming a key other than the one already stored.
    #[error("a different signing key is already stored")]
    SigningKeyAlreadySet,
    /// `POST /auth/root-key` for an account that already has a root key (another device migrated
    /// it first): the client fetches the stored one instead.
    #[error("the account already has a root key")]
    RootKeyExists,
    /// A write of a key that is set once (`PUT /auth/root-key/recovery`, `PUT /auth/app-keys/:app`)
    /// when one is already stored.
    #[error("{0} is already stored")]
    KeyAlreadyStored(&'static str),
    /// A credential or recovery write without the root-key slot, from a client predating root
    /// keys, on an account holding app keys that dropping the root would orphan.
    #[error("this account needs an app version that knows the account root key")]
    RootKeyRequired,
    /// `POST /projects/:id/key-rotation` with no rotation outstanding, or one another owner completed.
    #[error("no key rotation is pending for this project")]
    RotationNotPending,
    /// An invite naming someone already an active member; roles change via `PATCH`.
    #[error("already a member of this project")]
    AlreadyMember,
    /// A passkey route on an instance without `WEBAUTHN_RP_ID`: 404 `passkeys_disabled`.
    #[error("passkeys are not enabled on this server")]
    PasskeysDisabled,
    /// A passkey registration whose credential has no PRF (it could sign in but not unlock).
    #[error("this passkey does not support the PRF extension, which unlocking the account needs")]
    PasskeyPrfUnsupported,
    /// A WebAuthn response that does not verify, or a ceremony that is unknown or expired.
    #[error("passkey verification failed: {0}")]
    PasskeyInvalid(String),
    /// Removing the password or a passkey that is the account's last way to sign in.
    #[error("this is the account's last way to sign in")]
    LastUnlockMethod,
    #[error("not found")]
    NotFound,
    /// A filesystem operation failed (blob store I/O); surfaced as `internal error`, logged with path context.
    #[error("internal error")]
    Filesystem(#[from] std::io::Error),
    /// A body or payload exceeds a configured cap (`413`).
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("too many requests")]
    TooManyRequests,
    /// The server is at a global capacity limit: `503` with `Retry-After` of this many seconds.
    #[error("server busy, try again shortly")]
    Busy(u64),
    #[error("database error")]
    Database(#[from] sqlx::Error),
    /// The attachment object store failed; surfaced as `internal error`, logged in full.
    #[error("internal error")]
    ObjectStore(#[from] object_store::Error),
    #[error("internal error")]
    Internal,
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::InvalidCredentials => StatusCode::FORBIDDEN,
            AppError::RefreshSuperseded => StatusCode::UNAUTHORIZED,
            AppError::AccountScheduledDeletion { .. } => StatusCode::FORBIDDEN,
            AppError::AccountDeleted => StatusCode::FORBIDDEN,
            AppError::SignupDisabled => StatusCode::FORBIDDEN,
            AppError::AccountDisabled => StatusCode::FORBIDDEN,
            AppError::LegacyAccount => StatusCode::FORBIDDEN,
            AppError::InviteInvalid => StatusCode::FORBIDDEN,
            AppError::Forbidden(_)
            | AppError::InteractiveSessionRequired
            | AppError::AppNotEnabled { .. } => StatusCode::FORBIDDEN,
            AppError::Conflict(_)
            | AppError::RecoveryKeyAlreadySet
            | AppError::SigningKeyAlreadySet
            | AppError::RootKeyExists
            | AppError::KeyAlreadyStored(_)
            | AppError::RootKeyRequired
            | AppError::RotationNotPending
            | AppError::AlreadyMember => StatusCode::CONFLICT,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::PasskeysDisabled => StatusCode::NOT_FOUND,
            AppError::PasskeyPrfUnsupported | AppError::PasskeyInvalid(_) => {
                StatusCode::BAD_REQUEST
            }
            AppError::LastUnlockMethod => StatusCode::CONFLICT,
            AppError::Filesystem(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            AppError::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            AppError::Busy(_) => StatusCode::SERVICE_UNAVAILABLE,
            AppError::Database(_) | AppError::ObjectStore(_) | AppError::Internal => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }
    }

    /// The machine-readable `code` rendered next to `error`, for variants a client branches on.
    fn code(&self) -> Option<&'static str> {
        match self {
            AppError::LegacyAccount => Some("legacy_account"),
            AppError::InvalidCredentials => Some("invalid_credentials"),
            AppError::AccountDeleted => Some("account_deleted"),
            AppError::RefreshSuperseded => Some("refresh_superseded"),
            AppError::RecoveryKeyAlreadySet => Some("recovery_key_already_set"),
            AppError::SigningKeyAlreadySet => Some("signing_key_already_set"),
            AppError::RootKeyExists => Some("root_key_exists"),
            AppError::KeyAlreadyStored(_) => Some("key_already_stored"),
            AppError::RootKeyRequired => Some("root_key_required"),
            AppError::RotationNotPending => Some("rotation_not_pending"),
            AppError::AlreadyMember => Some("already_member"),
            AppError::InteractiveSessionRequired => Some("interactive_session_required"),
            AppError::AppNotEnabled { .. } => Some("app_not_enabled"),
            AppError::PasskeysDisabled => Some("passkeys_disabled"),
            AppError::PasskeyPrfUnsupported => Some("passkey_prf_unsupported"),
            AppError::PasskeyInvalid(_) => Some("passkey_invalid"),
            AppError::LastUnlockMethod => Some("last_unlock_method"),
            _ => None,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Log the whole cause chain but never leak it to the client.
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %error_chain(&self), "request failed");
        }
        if let AppError::AccountScheduledDeletion { days_remaining } = self {
            return (
                status,
                Json(json!({
                    "error": "account_scheduled_deletion",
                    "days_remaining": days_remaining
                })),
            )
                .into_response();
        }
        if let AppError::AppNotEnabled { app, scope } = &self {
            return (
                status,
                Json(json!({
                    "error": self.to_string(),
                    "code": "app_not_enabled",
                    "app": app,
                    "scope": scope,
                })),
            )
                .into_response();
        }
        if let AppError::Busy(retry_after) = self {
            return (
                status,
                [(axum::http::header::RETRY_AFTER, retry_after.to_string())],
                Json(json!({ "error": self.to_string() })),
            )
                .into_response();
        }
        let message = match &self {
            AppError::Database(_)
            | AppError::ObjectStore(_)
            | AppError::Internal
            | AppError::Filesystem(_) => "internal error".to_string(),
            other => other.to_string(),
        };
        match self.code() {
            Some(code) => (status, Json(json!({ "error": message, "code": code }))),
            None => (status, Json(json!({ "error": message }))),
        }
        .into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// `err` and each of its sources, joined with `": "`.
pub fn error_chain(err: &dyn std::error::Error) -> String {
    let mut chain = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        chain.push_str(": ");
        chain.push_str(&cause.to_string());
        source = cause.source();
    }
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_logged_chain_names_the_underlying_cause() {
        let db = error_chain(&AppError::Database(sqlx::Error::RowNotFound));
        assert!(db.starts_with("database error: "), "{db}");
        assert!(db.contains("no rows returned"), "{db}");

        let io = error_chain(&AppError::Filesystem(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "blob dir is read-only",
        )));
        assert!(io.ends_with(": blob dir is read-only"), "{io}");

        assert_eq!(error_chain(&AppError::Internal), "internal error");
    }
}
