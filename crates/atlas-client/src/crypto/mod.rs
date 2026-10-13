//! End-to-end encryption, byte for byte with `packages/client-core/src/crypto`. Every format here
//! is pinned by a fixture in `test-vectors/` that the TypeScript tests assert as well.

mod api_token;
mod bip39;
mod identity;
mod kdf;
mod keyring;
mod root_key;

pub use api_token::*;
pub use bip39::*;
pub use identity::*;
pub use kdf::*;
pub use keyring::*;
pub use root_key::*;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use hkdf::Hkdf;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// A cryptographic operation failed: a wrong key, a value bound elsewhere, or a malformed input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CryptoError(pub String);

impl CryptoError {
    pub(crate) fn new(msg: impl Into<String>) -> Self {
        Self(msg.into())
    }
}

pub type CryptoResult<T> = Result<T, CryptoError>;

/// Standard base64, padded when written; read with or without padding (as Node's `Buffer` does).
const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn to_base64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn from_base64(text: &str) -> CryptoResult<Vec<u8>> {
    B64.decode(text.trim())
        .map_err(|e| CryptoError::new(format!("bad base64: {e}")))
}

pub fn from_hex(text: &str) -> CryptoResult<Vec<u8>> {
    hex::decode(text).map_err(|e| CryptoError::new(format!("bad hex: {e}")))
}

pub fn from_hex32(text: &str) -> CryptoResult<[u8; 32]> {
    from_hex(text)?
        .try_into()
        .map_err(|_| CryptoError::new("expected 32 bytes"))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::rng().fill_bytes(&mut out);
    out
}

/// `JSON.stringify` of a list of strings and numbers: the associated data of every binding.
pub(crate) fn json_aad(parts: &[Value]) -> Vec<u8> {
    serde_json::to_vec(parts).expect("a JSON array serializes")
}

pub fn hkdf32(ikm: &[u8], salt: Option<&[u8]>, info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(salt, ikm)
        .expand(info.as_bytes(), &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// `{ iv, ct }`: AES-256-GCM with a 12-byte IV, `ct` holding the ciphertext and its 16-byte tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub iv: String,
    pub ct: String,
}

fn cipher(key: &[u8]) -> CryptoResult<Aes256Gcm> {
    if key.len() != 32 {
        return Err(CryptoError::new(format!(
            "AES-256 key must be 32 bytes, got {}",
            key.len()
        )));
    }
    Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::new("bad AES key"))
}

/// Encrypt under `key` with the given IV (the vectors) or a fresh one.
pub fn encrypt_aes_gcm_with_iv(
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
    iv: [u8; 12],
) -> CryptoResult<EncryptedPayload> {
    let ct = cipher(key)?
        .encrypt(
            &Nonce::from(iv),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::new("encryption failed"))?;
    Ok(EncryptedPayload {
        iv: to_base64(&iv),
        ct: to_base64(&ct),
    })
}

pub fn encrypt_aes_gcm(key: &[u8], plaintext: &[u8], aad: &[u8]) -> CryptoResult<EncryptedPayload> {
    encrypt_aes_gcm_with_iv(key, plaintext, aad, random_bytes())
}

pub fn decrypt_aes_gcm(
    key: &[u8],
    payload: &EncryptedPayload,
    aad: &[u8],
) -> CryptoResult<Vec<u8>> {
    let iv = from_base64(&payload.iv)?;
    let ct = from_base64(&payload.ct)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| CryptoError::new("bad IV length"))?;
    cipher(key)?
        .decrypt(&nonce, Payload { msg: &ct, aad })
        .map_err(|_| CryptoError::new("decryption failed"))
}

/// `encryptJson`: a value's JSON, unpadded, with no associated data (field envelope version 1).
pub fn decrypt_json(key: &[u8], payload: &EncryptedPayload) -> CryptoResult<Value> {
    let plain = decrypt_aes_gcm(key, payload, &[])?;
    serde_json::from_slice(&plain).map_err(|e| CryptoError::new(format!("bad JSON: {e}")))
}

pub fn encrypt_json(key: &[u8], value: &Value) -> CryptoResult<EncryptedPayload> {
    encrypt_aes_gcm(key, &serde_json::to_vec(value).expect("JSON"), &[])
}

// ---------------------------------------------------------------------------------------------
// Key wraps (envelope.ts)

/// An unbound wrap of a key under another (legacy formats; still read).
pub fn unwrap_key(wrapped: &EncryptedPayload, wrapping_key: &[u8]) -> CryptoResult<Vec<u8>> {
    decrypt_aes_gcm(wrapping_key, wrapped, &[])
}

pub fn wrap_key(target: &[u8], wrapping_key: &[u8]) -> CryptoResult<EncryptedPayload> {
    encrypt_aes_gcm(wrapping_key, target, &[])
}

fn project_key_aad(project_id: &str) -> Vec<u8> {
    json_aad(&["atlas-pek-wrap".into(), 2.into(), project_id.into()])
}

/// `{ v: 2, iv, ct }`: a PEK under the DEK, bound to its project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedProjectKey {
    pub v: u8,
    pub iv: String,
    pub ct: String,
}

pub fn wrap_project_key_with_iv(
    pek: &[u8],
    dek: &[u8],
    project_id: &str,
    iv: [u8; 12],
) -> CryptoResult<WrappedProjectKey> {
    let p = encrypt_aes_gcm_with_iv(dek, pek, &project_key_aad(project_id), iv)?;
    Ok(WrappedProjectKey {
        v: 2,
        iv: p.iv,
        ct: p.ct,
    })
}

pub fn wrap_project_key(
    pek: &[u8],
    dek: &[u8],
    project_id: &str,
) -> CryptoResult<WrappedProjectKey> {
    wrap_project_key_with_iv(pek, dek, project_id, random_bytes())
}

/// Open a `{ v: 2 }` copy bound to `project_id`, or an older unbound `{ iv, ct }`.
pub fn unwrap_project_key(
    payload: &EncryptedPayload,
    version: Option<&Value>,
    dek: &[u8],
    project_id: &str,
) -> CryptoResult<Vec<u8>> {
    if version.and_then(Value::as_i64) == Some(2) {
        decrypt_aes_gcm(dek, payload, &project_key_aad(project_id))
    } else {
        decrypt_aes_gcm(dek, payload, &[])
    }
}

/// Whether a field value is still an encrypted envelope (`__enc: 2` with a `kid`, or `__enc: 1`).
pub fn is_encrypted_envelope(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if !o.get("iv").is_some_and(Value::is_string) || !o.get("ct").is_some_and(Value::is_string) {
        return false;
    }
    match o.get("__enc") {
        Some(e) if json_is_number(e, 1.0) => true,
        Some(e) if json_is_number(e, 2.0) => o.get("kid").is_some_and(Value::is_string),
        _ => false,
    }
}

fn json_is_number(v: &Value, n: f64) -> bool {
    v.as_f64() == Some(n)
}

// ---------------------------------------------------------------------------------------------
// Field envelopes (field.ts)

pub const FIELD_ENVELOPE_VERSION: u8 = 2;

/// Which keys a value belongs to: the DEK's (`personal`) or a shared project's.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum KeyScope {
    Personal,
    Project(String),
}

impl KeyScope {
    pub fn label(&self) -> String {
        match self {
            KeyScope::Personal => "personal".into(),
            KeyScope::Project(id) => format!("project:{id}"),
        }
    }
}

/// Where a field value sits: entity kind, entity id and field name.
#[derive(Debug, Clone, Copy)]
pub struct FieldLocation<'a> {
    pub entity: &'a str,
    pub entity_id: &'a str,
    pub field: &'a str,
}

/// `{ __enc: 2, kid, iv, ct }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldEnvelope {
    pub __enc: u8,
    pub kid: String,
    pub iv: String,
    pub ct: String,
}

impl FieldEnvelope {
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("envelope")
    }

    /// A v2 envelope's parts, when `v` is one.
    pub fn from_value(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        if !json_is_number(o.get("__enc")?, 2.0) {
            return None;
        }
        Some(Self {
            __enc: 2,
            kid: o.get("kid")?.as_str()?.to_owned(),
            iv: o.get("iv")?.as_str()?.to_owned(),
            ct: o.get("ct")?.as_str()?.to_owned(),
        })
    }

    fn payload(&self) -> EncryptedPayload {
        EncryptedPayload {
            iv: self.iv.clone(),
            ct: self.ct.clone(),
        }
    }
}

fn field_aad(at: FieldLocation<'_>, scope: &KeyScope, kid: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-field".into(),
        FIELD_ENVELOPE_VERSION.into(),
        at.entity.into(),
        at.entity_id.into(),
        at.field.into(),
        scope.label().into(),
        kid.into(),
    ])
}

/// The padded size for `n` bytes plus the pad marker: at least 32, powers of two to 1 KiB, then
/// whole KiB.
pub fn padded_length(n: usize) -> usize {
    let needed = n + 1;
    if needed <= 32 {
        32
    } else if needed <= 1024 {
        needed.next_power_of_two()
    } else {
        needed.div_ceil(1024) * 1024
    }
}

pub fn pad_plaintext(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; padded_length(data.len())];
    out[..data.len()].copy_from_slice(data);
    out[data.len()] = 0x80;
    out
}

pub fn unpad_plaintext(data: &[u8]) -> CryptoResult<&[u8]> {
    let end = data
        .iter()
        .rposition(|&b| b != 0)
        .ok_or_else(|| CryptoError::new("bad field padding"))?;
    if data[end] != 0x80 {
        return Err(CryptoError::new("bad field padding"));
    }
    Ok(&data[..end])
}

pub fn encrypt_field_with_iv(
    key: &[u8],
    kid: &str,
    scope: &KeyScope,
    at: FieldLocation<'_>,
    value: &Value,
    iv: [u8; 12],
) -> CryptoResult<FieldEnvelope> {
    let plain = pad_plaintext(&serde_json::to_vec(value).expect("JSON"));
    let p = encrypt_aes_gcm_with_iv(key, &plain, &field_aad(at, scope, kid), iv)?;
    Ok(FieldEnvelope {
        __enc: 2,
        kid: kid.to_owned(),
        iv: p.iv,
        ct: p.ct,
    })
}

pub fn encrypt_field(
    key: &[u8],
    kid: &str,
    scope: &KeyScope,
    at: FieldLocation<'_>,
    value: &Value,
) -> CryptoResult<FieldEnvelope> {
    encrypt_field_with_iv(key, kid, scope, at, value, random_bytes())
}

/// Open an envelope that claims to sit at `at` under `key` of `scope`; fails when any is untrue.
pub fn decrypt_field(
    key: &[u8],
    scope: &KeyScope,
    at: FieldLocation<'_>,
    envelope: &FieldEnvelope,
) -> CryptoResult<Value> {
    let plain = decrypt_aes_gcm(
        key,
        &envelope.payload(),
        &field_aad(at, scope, &envelope.kid),
    )?;
    serde_json::from_slice(unpad_plaintext(&plain)?)
        .map_err(|e| CryptoError::new(format!("bad JSON: {e}")))
}

// ---------------------------------------------------------------------------------------------
// Sealed boxes (asym.ts)

/// `{ ephemeralPublicKey, encryptedKey }`: a key sealed to an X25519 public key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedKey {
    #[serde(rename = "ephemeralPublicKey")]
    pub ephemeral_public_key: String,
    #[serde(rename = "encryptedKey")]
    pub encrypted_key: EncryptedPayload,
}

pub fn x25519_public_key(secret: &[u8; 32]) -> String {
    hex::encode(PublicKey::from(&StaticSecret::from(*secret)).as_bytes())
}

fn x25519_shared(secret: &[u8; 32], public: &[u8; 32]) -> [u8; 32] {
    *StaticSecret::from(*secret)
        .diffie_hellman(&PublicKey::from(*public))
        .as_bytes()
}

pub fn seal_key_with(
    target: &[u8],
    recipient_public_hex: &str,
    ephemeral_secret: [u8; 32],
    iv: [u8; 12],
) -> CryptoResult<SealedKey> {
    let recipient = from_hex32(recipient_public_hex)?;
    let shared = x25519_shared(&ephemeral_secret, &recipient);
    let key = hkdf32(&shared, None, "atlas-seal-v1");
    Ok(SealedKey {
        ephemeral_public_key: x25519_public_key(&ephemeral_secret),
        encrypted_key: encrypt_aes_gcm_with_iv(&key, target, &[], iv)?,
    })
}

pub fn seal_key(target: &[u8], recipient_public_hex: &str) -> CryptoResult<SealedKey> {
    seal_key_with(target, recipient_public_hex, random_bytes(), random_bytes())
}

pub fn unseal_key(sealed: &SealedKey, recipient_secret: &[u8; 32]) -> CryptoResult<Vec<u8>> {
    let ephemeral = from_hex32(&sealed.ephemeral_public_key)?;
    let shared = x25519_shared(recipient_secret, &ephemeral);
    let key = hkdf32(&shared, None, "atlas-seal-v1");
    decrypt_aes_gcm(&key, &sealed.encrypted_key, &[])
}

/// A fresh random v4 UUID string.
pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn uuid_from_bytes(b: &[u8; 16]) -> String {
    uuid::Uuid::from_bytes(*b).to_string()
}

#[cfg(test)]
mod vectors;
