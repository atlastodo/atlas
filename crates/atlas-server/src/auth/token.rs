//! Tokens: short-lived JWT access tokens and opaque, hashed refresh tokens.
//!
//! Access tokens are stateless HS256 JWTs carrying the user id and an expiry. Refresh tokens are
//! random opaque strings handed to the client; we persist only their SHA-256 hash so a database
//! leak can't be replayed. Refresh tokens are bound to a `device_id` and rotated on every use.

use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// JWT claims for an access token.
#[derive(Debug, Serialize, Deserialize)]
pub struct AccessClaims {
    pub sub: Uuid,
    /// The device the token was issued to: one refresh-token family per device. Optional so a
    /// token minted before the claim still verifies; its session endpoints treat the device as
    /// unknown (revoke-others revokes every family). The gap self-heals at the next refresh.
    pub did: Option<Uuid>,
    pub iat: i64,
    pub exp: i64,
    /// What kind of credential the session stands on. Absent for a device session (password
    /// sign-in plus refresh tokens); [`TokenKind::ApiToken`] for one an API token opened, whose
    /// `did` is the token's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<TokenKind>,
}

/// The non-default session kinds an access token can carry in its `kind` claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    /// Opened with a personal API token (`POST /auth/api-token/session`).
    ApiToken,
}

/// Mint a signed access token for `user_id` (issued to `device_id`) valid for `ttl_seconds`.
pub fn issue_access_token(
    user_id: Uuid,
    device_id: Uuid,
    ttl_seconds: i64,
    secret: &[u8],
    now_unix: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    issue_access_token_of_kind(user_id, device_id, None, ttl_seconds, secret, now_unix)
}

/// [`issue_access_token`] for a session of the given `kind`.
pub fn issue_access_token_of_kind(
    user_id: Uuid,
    device_id: Uuid,
    kind: Option<TokenKind>,
    ttl_seconds: i64,
    secret: &[u8],
    now_unix: i64,
) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = AccessClaims {
        sub: user_id,
        did: Some(device_id),
        iat: now_unix,
        exp: now_unix + ttl_seconds,
        kind,
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret),
    )
}

/// Verify and decode an access token, enforcing expiry.
pub fn verify_access_token(
    token: &str,
    secret: &[u8],
) -> Result<AccessClaims, jsonwebtoken::errors::Error> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.leeway = 0;
    let data = jsonwebtoken::decode::<AccessClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret),
        &validation,
    )?;
    Ok(data.claims)
}

/// A freshly generated refresh token: the opaque secret to return to the client, and the hash to
/// store in the database.
pub struct RefreshToken {
    pub plaintext: String,
    pub hash: String,
}

/// Generate a new random refresh token (256 bits of entropy, hex-encoded).
pub fn generate_refresh_token() -> RefreshToken {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let plaintext = hex::encode(bytes);
    let hash = hash_refresh_token(&plaintext);
    RefreshToken { plaintext, hash }
}

/// Hash a refresh token for storage/lookup. Deterministic so we can look up by hash.
pub fn hash_refresh_token(plaintext: &str) -> String {
    let digest = Sha256::digest(plaintext.as_bytes());
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-at-least-32-bytes-long!!";

    // jsonwebtoken validates `exp` against the real wall clock, so tests use a realistic `now`.
    fn now() -> i64 {
        time::OffsetDateTime::now_utc().unix_timestamp()
    }

    #[test]
    fn access_token_roundtrips() {
        let uid = Uuid::now_v7();
        let device = Uuid::now_v7();
        let iat = now();
        let token = issue_access_token(uid, device, 900, SECRET, iat).unwrap();
        let claims = verify_access_token(&token, SECRET).unwrap();
        assert_eq!(claims.sub, uid);
        assert_eq!(claims.did, Some(device), "the device claim rides the token");
        assert_eq!(claims.exp, iat + 900);
        assert_eq!(claims.kind, None, "a device session carries no kind");
    }

    #[test]
    fn api_token_session_kind_roundtrips() {
        let token = issue_access_token_of_kind(
            Uuid::now_v7(),
            Uuid::now_v7(),
            Some(TokenKind::ApiToken),
            900,
            SECRET,
            now(),
        )
        .unwrap();
        let claims = verify_access_token(&token, SECRET).unwrap();
        assert_eq!(claims.kind, Some(TokenKind::ApiToken));
    }

    #[test]
    fn token_without_a_device_claim_still_verifies() {
        // Tokens minted before the `did` claim must keep working: the field deserializes as None.
        let uid = Uuid::now_v7();
        let iat = now();
        #[derive(serde::Serialize)]
        struct LegacyClaims {
            sub: Uuid,
            iat: i64,
            exp: i64,
        }
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &LegacyClaims {
                sub: uid,
                iat,
                exp: iat + 900,
            },
            &jsonwebtoken::EncodingKey::from_secret(SECRET),
        )
        .unwrap();
        let decoded = verify_access_token(&token, SECRET).unwrap();
        assert_eq!(
            decoded.did, None,
            "a missing claim reads as an unknown device"
        );
        assert_eq!(decoded.sub, uid);
    }

    #[test]
    fn expired_access_token_is_rejected() {
        // Issued far enough in the past that it is already expired.
        let token =
            issue_access_token(Uuid::now_v7(), Uuid::now_v7(), 60, SECRET, now() - 3_600).unwrap();
        assert!(verify_access_token(&token, SECRET).is_err());
    }

    #[test]
    fn token_signed_with_other_secret_is_rejected() {
        let token = issue_access_token(Uuid::now_v7(), Uuid::now_v7(), 900, SECRET, now()).unwrap();
        assert!(verify_access_token(&token, b"a-completely-different-secret-value!").is_err());
    }

    #[test]
    fn refresh_token_hash_is_deterministic_and_hides_secret() {
        let rt = generate_refresh_token();
        assert_eq!(rt.hash, hash_refresh_token(&rt.plaintext));
        assert_ne!(rt.hash, rt.plaintext);
        assert_eq!(rt.plaintext.len(), 64); // 32 bytes hex
    }

    #[test]
    fn distinct_refresh_tokens_are_unique() {
        assert_ne!(
            generate_refresh_token().plaintext,
            generate_refresh_token().plaintext
        );
    }
}
