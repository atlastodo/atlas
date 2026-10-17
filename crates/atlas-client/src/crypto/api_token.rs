//! Personal API tokens (`apiToken.ts`): `atlas_pat_` + base64url(16-byte id ‖ 32-byte secret).
//! HKDF over the secret, salted with the id, gives the auth value the server checks
//! (`atlas-pat-auth-v1`) and the key wrapping the DEK and X25519 private key (`atlas-pat-wrap-v1`).

use serde::{Deserialize, Serialize};

use super::{
    decrypt_aes_gcm, encrypt_aes_gcm_with_iv, hkdf32, json_aad, random_bytes, root_key::TODO_APP,
    uuid_from_bytes, CryptoError, CryptoResult, EncryptedPayload,
};

pub const API_TOKEN_PREFIX: &str = "atlas_pat_";
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// The token string is not an Atlas API token.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("not an Atlas API token")]
pub struct InvalidApiToken;

#[derive(Clone, PartialEq, Eq)]
pub struct ApiTokenParts {
    /// The token id as a lowercase UUID: the server's id for it and the session's device id.
    pub id: String,
    pub secret: [u8; 32],
}

impl std::fmt::Debug for ApiTokenParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiTokenParts")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// A key wrapped for a token: `{ v: 1, iv, ct }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiTokenWrap {
    pub v: u8,
    pub iv: String,
    pub ct: String,
}

impl ApiTokenWrap {
    fn payload(&self) -> EncryptedPayload {
        EncryptedPayload {
            iv: self.iv.clone(),
            ct: self.ct.clone(),
        }
    }
}

fn to_base64url(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = (chunk.len() * 8).div_ceil(6).min(4);
        for c in 0..chars {
            out.push(B64URL[(n >> (18 - 6 * c) & 63) as usize] as char);
        }
    }
    out
}

/// Lenient like the TypeScript reader: any trailing bits are dropped.
fn from_base64url(text: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let (mut bits, mut acc) = (0u32, 0u32);
    for ch in text.chars() {
        let v = B64URL.iter().position(|&c| c as char == ch)? as u32;
        acc = (acc << 6 | v) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits & 0xff) as u8);
        }
    }
    Some(bytes)
}

pub fn generate_api_token() -> ApiTokenParts {
    let mut id: [u8; 16] = random_bytes();
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    ApiTokenParts {
        id: uuid_from_bytes(&id),
        secret: random_bytes(),
    }
}

fn id_bytes(id: &str) -> CryptoResult<[u8; 16]> {
    hex::decode(id.replace('-', ""))
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| CryptoError::new("a token id is a UUID"))
}

pub fn format_api_token(parts: &ApiTokenParts) -> String {
    let mut raw = id_bytes(&parts.id).expect("a token id is a UUID").to_vec();
    raw.extend_from_slice(&parts.secret);
    format!("{API_TOKEN_PREFIX}{}", to_base64url(&raw))
}

/// Read a token string (surrounding whitespace allowed).
pub fn parse_api_token(token: &str) -> Result<ApiTokenParts, InvalidApiToken> {
    let rest = token
        .trim()
        .strip_prefix(API_TOKEN_PREFIX)
        .ok_or(InvalidApiToken)?;
    let raw = from_base64url(rest).ok_or(InvalidApiToken)?;
    if raw.len() != 48 {
        return Err(InvalidApiToken);
    }
    let id: [u8; 16] = raw[..16].try_into().expect("16 bytes");
    Ok(ApiTokenParts {
        id: uuid_from_bytes(&id),
        secret: raw[16..].try_into().expect("32 bytes"),
    })
}

pub struct ApiTokenKeys {
    /// Hex; the server stores only its SHA-256.
    pub auth: String,
    pub wrap_key: [u8; 32],
}

pub fn derive_api_token_keys(parts: &ApiTokenParts) -> ApiTokenKeys {
    let salt = id_bytes(&parts.id).expect("a parsed token id is a UUID");
    ApiTokenKeys {
        auth: hex::encode(hkdf32(&parts.secret, Some(&salt), "atlas-pat-auth-v1")),
        wrap_key: hkdf32(&parts.secret, Some(&salt), "atlas-pat-wrap-v1"),
    }
}

fn wrap_aad(user_id: &str, token_id: &str, slot: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-pat-wrap".into(),
        1.into(),
        user_id.to_lowercase().into(),
        token_id.to_lowercase().into(),
        slot.into(),
    ])
}

pub struct ApiTokenWraps {
    pub wrapped_dek: ApiTokenWrap,
    pub wrapped_private_key: ApiTokenWrap,
}

/// Wrap the account's DEK and X25519 private key for the token.
pub fn wrap_keys_for_api_token(
    parts: &ApiTokenParts,
    user_id: &str,
    dek: &[u8; 32],
    private_key: &[u8; 32],
) -> CryptoResult<ApiTokenWraps> {
    let k = derive_api_token_keys(parts).wrap_key;
    let wrap = |key: &[u8], slot: &str| -> CryptoResult<ApiTokenWrap> {
        let p =
            encrypt_aes_gcm_with_iv(&k, key, &wrap_aad(user_id, &parts.id, slot), random_bytes())?;
        Ok(ApiTokenWrap {
            v: 1,
            iv: p.iv,
            ct: p.ct,
        })
    };
    Ok(ApiTokenWraps {
        wrapped_dek: wrap(dek, "dek")?,
        wrapped_private_key: wrap(private_key, "private_key")?,
    })
}

/// Open the wraps a token session returned: the DEK and the X25519 private key.
pub fn unwrap_api_token_keys(
    parts: &ApiTokenParts,
    user_id: &str,
    wrapped_dek: &ApiTokenWrap,
    wrapped_private_key: &ApiTokenWrap,
) -> CryptoResult<([u8; 32], [u8; 32])> {
    let k = derive_api_token_keys(parts).wrap_key;
    let dek = decrypt_aes_gcm(
        &k,
        &wrapped_dek.payload(),
        &wrap_aad(user_id, &parts.id, "dek"),
    )?;
    let private_key = decrypt_aes_gcm(
        &k,
        &wrapped_private_key.payload(),
        &wrap_aad(user_id, &parts.id, "private_key"),
    )?;
    let size = || CryptoError::new("an API token wrap holds a key of the wrong size");
    Ok((
        dek.try_into().map_err(|_| size())?,
        private_key.try_into().map_err(|_| size())?,
    ))
}

/// One `app_keys` entry of a token: another app's key and X25519 identity, wrapped for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiTokenAppWraps {
    pub wrapped_key: ApiTokenWrap,
    pub wrapped_private_key: ApiTokenWrap,
}

fn check_token_app(app: &str) -> CryptoResult<()> {
    if app == TODO_APP {
        return Err(CryptoError::new(
            "todo's key travels as wrapped_dek (wrap_keys_for_api_token)",
        ));
    }
    let mut bytes = app.bytes();
    let ok = bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'));
    if !ok {
        return Err(CryptoError::new(format!("not an app id: {app}")));
    }
    Ok(())
}

/// Wrap a non-todo app's key and X25519 identity for the token (`wrapAppKeysForApiToken`), as one
/// `app_keys` entry: associated data slots `app_key:<app>` and `app_private_key:<app>`, so one
/// app's wrap does not open as another's.
pub fn wrap_app_keys_for_api_token(
    parts: &ApiTokenParts,
    user_id: &str,
    app: &str,
    app_key: &[u8; 32],
    private_key: &[u8; 32],
) -> CryptoResult<ApiTokenAppWraps> {
    check_token_app(app)?;
    let k = derive_api_token_keys(parts).wrap_key;
    let wrap = |key: &[u8], slot: &str| -> CryptoResult<ApiTokenWrap> {
        let p =
            encrypt_aes_gcm_with_iv(&k, key, &wrap_aad(user_id, &parts.id, slot), random_bytes())?;
        Ok(ApiTokenWrap {
            v: 1,
            iv: p.iv,
            ct: p.ct,
        })
    };
    Ok(ApiTokenAppWraps {
        wrapped_key: wrap(app_key, &format!("app_key:{app}"))?,
        wrapped_private_key: wrap(private_key, &format!("app_private_key:{app}"))?,
    })
}

/// Open one `app_keys` entry a token session returned (`unwrapApiTokenAppKeys`): the app key and
/// the app's X25519 private key. Fails when it is not this token's, account's or app's.
pub fn unwrap_api_token_app_keys(
    parts: &ApiTokenParts,
    user_id: &str,
    app: &str,
    wraps: &ApiTokenAppWraps,
) -> CryptoResult<([u8; 32], [u8; 32])> {
    check_token_app(app)?;
    let k = derive_api_token_keys(parts).wrap_key;
    let app_key = decrypt_aes_gcm(
        &k,
        &wraps.wrapped_key.payload(),
        &wrap_aad(user_id, &parts.id, &format!("app_key:{app}")),
    )?;
    let private_key = decrypt_aes_gcm(
        &k,
        &wraps.wrapped_private_key.payload(),
        &wrap_aad(user_id, &parts.id, &format!("app_private_key:{app}")),
    )?;
    let size = || CryptoError::new("an API token wrap holds a key of the wrong size");
    Ok((
        app_key.try_into().map_err(|_| size())?,
        private_key.try_into().map_err(|_| size())?,
    ))
}
