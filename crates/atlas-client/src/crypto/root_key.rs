//! The account root key and the per-app keys (`rootKey.ts`): unlock slots wrap the root, the root
//! wraps each app's key, and an app key wraps that app's X25519 identity. The todo app key is the
//! account's DEK. An API token never carries the root.

use serde::{Deserialize, Serialize};

use super::{
    decrypt_aes_gcm, encrypt_aes_gcm_with_iv, from_hex32, hkdf32, json_aad, random_bytes,
    x25519_public_key, CryptoError, CryptoResult, EncryptedPayload,
};

pub const TODO_APP: &str = "todo";

/// `{ v: 1, iv, ct }`, with `epk` for a root sealed to the recovery public key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootKeyWrap {
    pub v: u8,
    pub iv: String,
    pub ct: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epk: Option<String>,
}

impl RootKeyWrap {
    fn payload(&self) -> EncryptedPayload {
        EncryptedPayload {
            iv: self.iv.clone(),
            ct: self.ct.clone(),
        }
    }
}

fn root_aad(user_id: &str, slot: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-root-key".into(),
        1.into(),
        user_id.to_lowercase().into(),
        slot.into(),
    ])
}

fn sealed_aad(user_id: &str, recipient_hex: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-root-key".into(),
        1.into(),
        user_id.to_lowercase().into(),
        "recovery-sealed".into(),
        recipient_hex.to_lowercase().into(),
    ])
}

fn app_key_aad(user_id: &str, app: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-app-key".into(),
        1.into(),
        user_id.to_lowercase().into(),
        app.into(),
    ])
}

fn app_identity_aad(user_id: &str, app: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-app-identity".into(),
        1.into(),
        user_id.to_lowercase().into(),
        app.into(),
        "x25519".into(),
    ])
}

fn wrap_with(key: &[u8], target: &[u8], aad: &[u8], iv: [u8; 12]) -> CryptoResult<RootKeyWrap> {
    if key.len() != 32 || target.len() != 32 {
        return Err(CryptoError::new("keys must be 32 bytes"));
    }
    let p = encrypt_aes_gcm_with_iv(key, target, aad, iv)?;
    Ok(RootKeyWrap {
        v: 1,
        iv: p.iv,
        ct: p.ct,
        epk: None,
    })
}

fn unwrap_with(key: &[u8], wrap: &RootKeyWrap, aad: &[u8], what: &str) -> CryptoResult<[u8; 32]> {
    if wrap.v != 1 {
        return Err(CryptoError::new(format!("unknown {what} wrap version")));
    }
    decrypt_aes_gcm(key, &wrap.payload(), aad)?
        .try_into()
        .map_err(|_| CryptoError::new(format!("{what} must be 32 bytes")))
}

/// Wrap the root under an unlock slot's key (`password`, `recovery`, `passkey:<credential>`).
pub fn wrap_root_key(
    root: &[u8; 32],
    wrapping_key: &[u8; 32],
    user_id: &str,
    slot: &str,
) -> CryptoResult<RootKeyWrap> {
    wrap_with(wrapping_key, root, &root_aad(user_id, slot), random_bytes())
}

pub fn unwrap_root_key(
    wrap: &RootKeyWrap,
    wrapping_key: &[u8; 32],
    user_id: &str,
    slot: &str,
) -> CryptoResult<[u8; 32]> {
    unwrap_with(wrapping_key, wrap, &root_aad(user_id, slot), "root key")
}

fn seal_key_from(shared: &[u8; 32]) -> [u8; 32] {
    hkdf32(shared, None, "atlas-root-seal-v1")
}

/// Seal the root to the recovery public key (hex) with an ephemeral X25519 key.
pub fn seal_root_key(
    root: &[u8; 32],
    recovery_public_hex: &str,
    user_id: &str,
) -> CryptoResult<RootKeyWrap> {
    let ephemeral: [u8; 32] = random_bytes();
    let recipient = from_hex32(recovery_public_hex)?;
    let shared = x25519_dalek::StaticSecret::from(ephemeral)
        .diffie_hellman(&x25519_dalek::PublicKey::from(recipient));
    let mut wrap = wrap_with(
        &seal_key_from(shared.as_bytes()),
        root,
        &sealed_aad(user_id, recovery_public_hex),
        random_bytes(),
    )?;
    wrap.epk = Some(x25519_public_key(&ephemeral));
    Ok(wrap)
}

pub fn unseal_root_key(
    sealed: &RootKeyWrap,
    recovery_secret: &[u8; 32],
    user_id: &str,
) -> CryptoResult<[u8; 32]> {
    let epk = sealed
        .epk
        .as_deref()
        .ok_or_else(|| CryptoError::new("not a sealed root key"))?;
    let shared = x25519_dalek::StaticSecret::from(*recovery_secret)
        .diffie_hellman(&x25519_dalek::PublicKey::from(from_hex32(epk)?));
    let recipient = x25519_public_key(recovery_secret);
    unwrap_with(
        &seal_key_from(shared.as_bytes()),
        sealed,
        &sealed_aad(user_id, &recipient),
        "root key",
    )
}

/// Open a recovery slot in either form: sealed when it has an `epk` that opens, else the phrase
/// form (the server pads it with a stand-in `epk`).
pub fn open_recovery_slot(
    slot: &RootKeyWrap,
    wrap_key: &[u8; 32],
    secret_key: &[u8; 32],
    user_id: &str,
) -> CryptoResult<[u8; 32]> {
    if slot.epk.is_some() {
        if let Ok(root) = unseal_root_key(slot, secret_key, user_id) {
            return Ok(root);
        }
    }
    let plain = RootKeyWrap {
        epk: None,
        ..slot.clone()
    };
    unwrap_root_key(&plain, wrap_key, user_id, "recovery")
}

pub fn wrap_app_key(
    app_key: &[u8; 32],
    root: &[u8; 32],
    user_id: &str,
    app: &str,
) -> CryptoResult<RootKeyWrap> {
    wrap_with(root, app_key, &app_key_aad(user_id, app), random_bytes())
}

pub fn unwrap_app_key(
    wrap: &RootKeyWrap,
    root: &[u8; 32],
    user_id: &str,
    app: &str,
) -> CryptoResult<[u8; 32]> {
    unwrap_with(root, wrap, &app_key_aad(user_id, app), "app key")
}

pub fn wrap_app_private_key(
    private_key: &[u8; 32],
    app_key: &[u8; 32],
    user_id: &str,
    app: &str,
) -> CryptoResult<RootKeyWrap> {
    wrap_with(
        app_key,
        private_key,
        &app_identity_aad(user_id, app),
        random_bytes(),
    )
}

pub fn unwrap_app_private_key(
    wrap: &RootKeyWrap,
    app_key: &[u8; 32],
    user_id: &str,
    app: &str,
) -> CryptoResult<[u8; 32]> {
    unwrap_with(
        app_key,
        wrap,
        &app_identity_aad(user_id, app),
        "private key",
    )
}
