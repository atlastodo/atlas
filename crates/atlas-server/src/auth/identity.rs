//! The account's Ed25519 identity signing key.
//!
//! An owner signs every project key delivery with it, and members check the signature against the
//! key they pinned for that owner the first time they saw it. The server stores the public half and
//! the private half wrapped under the account's DEK; it never signs or verifies anything, so all it
//! checks here is the shape.
//!
//! The key is set once. `PUT /auth/signing-key` stores it for an account that has none (created
//! before these keys existed) and refuses a different one afterwards: a key the server would swap on
//! request would be no identity at all.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{AuthUser, InteractiveAuthUser};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// A wrapped 32-byte secret is a small JSON object; anything much larger is not one.
const MAX_WRAPPED_KEY_BYTES: usize = 512;

/// The public key must be 32 bytes of lowercase hex, and the wrapped private key an object with
/// string `iv` and `ct` (whatever else the client binds into it).
pub(super) fn validate_signing_key(public_key: &str, wrapped: &Value) -> AppResult<()> {
    if !is_hex_key(public_key) {
        return Err(AppError::BadRequest(
            "signing_public_key must be 32 bytes of lowercase hex".into(),
        ));
    }
    let shaped = wrapped.as_object().is_some_and(|o| {
        o.get("iv").is_some_and(Value::is_string) && o.get("ct").is_some_and(Value::is_string)
    });
    if !shaped || wrapped.to_string().len() > MAX_WRAPPED_KEY_BYTES {
        return Err(AppError::BadRequest(
            "encrypted_signing_key must be a wrapped key".into(),
        ));
    }
    Ok(())
}

/// 32 bytes as 64 lowercase hex characters.
pub(crate) fn is_hex_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The signing key fields of a signup: both or neither.
pub(super) fn signup_signing_key(
    public_key: Option<&str>,
    wrapped: Option<&Value>,
) -> AppResult<()> {
    match (public_key, wrapped) {
        (None, None) => Ok(()),
        (Some(public_key), Some(wrapped)) => validate_signing_key(public_key, wrapped),
        _ => Err(AppError::BadRequest(
            "signing_public_key and encrypted_signing_key go together".into(),
        )),
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SigningKey {
    pub signing_public_key: Option<String>,
    pub encrypted_signing_key: Option<Value>,
}

/// `GET /auth/signing-key` — the caller's own signing key as stored (both null when none is).
pub async fn get_signing_key(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<SigningKey>> {
    let (signing_public_key, encrypted_signing_key): (Option<String>, Option<Value>) =
        sqlx::query_as("SELECT signing_public_key, encrypted_signing_key FROM users WHERE id = $1")
            .bind(user.user_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or(AppError::NotFound)?;
    Ok(Json(SigningKey {
        signing_public_key,
        encrypted_signing_key,
    }))
}

#[derive(Debug, Deserialize)]
pub struct PutSigningKeyRequest {
    #[serde(default)]
    pub signing_public_key: String,
    #[serde(default)]
    pub encrypted_signing_key: Value,
}

/// `PUT /auth/signing-key` — store the caller's signing key, once. Repeating the stored public key
/// is a no-op (the stored wrap is kept); any other key is a 409 `signing_key_already_set`, and the
/// client then loads the stored one through `GET /auth/signing-key`.
pub async fn put_signing_key(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Json(req): Json<PutSigningKeyRequest>,
) -> AppResult<StatusCode> {
    let public_key = req.signing_public_key.trim().to_ascii_lowercase();
    validate_signing_key(&public_key, &req.encrypted_signing_key)?;
    let stored: Option<String> = sqlx::query_scalar(
        "UPDATE users
            SET signing_public_key = COALESCE(signing_public_key, $2),
                encrypted_signing_key = CASE WHEN signing_public_key IS NULL THEN $3
                                             ELSE encrypted_signing_key END,
                updated_at = now()
          WHERE id = $1
      RETURNING signing_public_key",
    )
    .bind(user.user_id)
    .bind(&public_key)
    .bind(&req.encrypted_signing_key)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    if stored.as_deref() != Some(public_key.as_str()) {
        return Err(AppError::SigningKeyAlreadySet);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_signing_key_is_hex_and_a_small_wrapped_object() {
        let wrapped = json!({ "v": 1, "iv": "A".repeat(16), "ct": "A".repeat(64) });
        assert!(validate_signing_key(&"ab".repeat(32), &wrapped).is_ok());
        assert!(validate_signing_key(&"AB".repeat(32), &wrapped).is_err());
        assert!(validate_signing_key(&"ab".repeat(31), &wrapped).is_err());
        assert!(validate_signing_key(&"ab".repeat(32), &json!("x")).is_err());
        assert!(validate_signing_key(&"ab".repeat(32), &json!({ "iv": "A" })).is_err());
        let huge = json!({ "iv": "A", "ct": "A".repeat(MAX_WRAPPED_KEY_BYTES) });
        assert!(validate_signing_key(&"ab".repeat(32), &huge).is_err());
    }

    #[test]
    fn signup_takes_both_signing_fields_or_neither() {
        let wrapped = json!({ "iv": "A", "ct": "B" });
        assert!(signup_signing_key(None, None).is_ok());
        assert!(signup_signing_key(Some(&"ab".repeat(32)), Some(&wrapped)).is_ok());
        assert!(signup_signing_key(Some(&"ab".repeat(32)), None).is_err());
        assert!(signup_signing_key(None, Some(&wrapped)).is_err());
    }
}
