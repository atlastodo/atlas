//! The Ed25519 identity signing key, delivery signatures and safety numbers (`identity.ts`).

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha512};

use super::{
    decrypt_aes_gcm, encrypt_aes_gcm_with_iv, from_base64, from_hex, from_hex32, json_aad,
    random_bytes, CryptoError, CryptoResult, EncryptedPayload, SealedKey,
};

pub fn signing_public_key(secret: &[u8; 32]) -> String {
    hex::encode(SigningKey::from_bytes(secret).verifying_key().as_bytes())
}

fn signing_wrap_aad(public_key: &str) -> Vec<u8> {
    json_aad(&[
        "atlas-signing-key-wrap".into(),
        1.into(),
        public_key.to_lowercase().into(),
    ])
}

/// `{ v: 1, iv, ct }`: the signing key's secret half under the DEK, bound to its public half.
pub fn wrap_signing_key_with_iv(
    secret: &[u8; 32],
    dek: &[u8],
    iv: [u8; 12],
) -> CryptoResult<EncryptedPayload> {
    encrypt_aes_gcm_with_iv(
        dek,
        secret,
        &signing_wrap_aad(&signing_public_key(secret)),
        iv,
    )
}

pub fn wrap_signing_key(secret: &[u8; 32], dek: &[u8]) -> CryptoResult<EncryptedPayload> {
    wrap_signing_key_with_iv(secret, dek, random_bytes())
}

/// Open a stored signing key published as `public_key`; fails unless it is that key's secret.
pub fn unwrap_signing_key(
    wrapped: &EncryptedPayload,
    dek: &[u8],
    public_key: &str,
) -> CryptoResult<[u8; 32]> {
    let secret: [u8; 32] = decrypt_aes_gcm(dek, wrapped, &signing_wrap_aad(public_key))?
        .try_into()
        .map_err(|_| CryptoError::new("the signing key is not 32 bytes"))?;
    if signing_public_key(&secret) != public_key.to_lowercase() {
        return Err(CryptoError::new(
            "the stored signing key does not match the published one",
        ));
    }
    Ok(secret)
}

/// What a project key delivery signature covers.
pub struct DeliveryFields<'a> {
    pub project_id: &'a str,
    pub recipient_id: &'a str,
    pub key_id: &'a str,
    pub sealed: &'a SealedKey,
}

const DELIVERY_DOMAIN: &str = "atlas-key-delivery-v1";

/// Each part length-prefixed (u32 big-endian); ids lowercased; the sealed key as bytes.
pub fn delivery_message(f: &DeliveryFields<'_>) -> CryptoResult<Vec<u8>> {
    let parts: [Vec<u8>; 7] = [
        DELIVERY_DOMAIN.as_bytes().to_vec(),
        f.project_id.to_lowercase().into_bytes(),
        f.recipient_id.to_lowercase().into_bytes(),
        f.key_id.as_bytes().to_vec(),
        from_hex(&f.sealed.ephemeral_public_key)?,
        from_base64(&f.sealed.encrypted_key.iv)?,
        from_base64(&f.sealed.encrypted_key.ct)?,
    ];
    let mut out = Vec::new();
    for part in parts {
        out.extend_from_slice(&(part.len() as u32).to_be_bytes());
        out.extend_from_slice(&part);
    }
    Ok(out)
}

pub fn sign_delivery(secret: &[u8; 32], f: &DeliveryFields<'_>) -> CryptoResult<String> {
    let sig = SigningKey::from_bytes(secret).sign(&delivery_message(f)?);
    Ok(hex::encode(sig.to_bytes()))
}

/// Whether `signature` (hex) is `public_key`'s (hex) over the delivery. Never panics.
pub fn verify_delivery(public_key: &str, signature: &str, f: &DeliveryFields<'_>) -> bool {
    let check = || -> Option<bool> {
        let key = VerifyingKey::from_bytes(&from_hex32(public_key).ok()?).ok()?;
        let sig: [u8; 64] = from_hex(signature).ok()?.try_into().ok()?;
        let msg = delivery_message(f).ok()?;
        Some(key.verify(&msg, &Signature::from_bytes(&sig)).is_ok())
    };
    check().unwrap_or(false)
}

/// One side of a safety number: an account id and its two identity public keys (hex).
pub struct IdentityKeys<'a> {
    pub user_id: &'a str,
    pub public_key: &'a str,
    pub signing_key: &'a str,
}

fn fingerprint_digits(side: &IdentityKeys<'_>) -> CryptoResult<String> {
    let mut keys = from_hex32(side.public_key)?.to_vec();
    keys.extend_from_slice(&from_hex32(side.signing_key)?);
    let mut first = vec![0u8, 1u8];
    first.extend_from_slice(&keys);
    first.extend_from_slice(side.user_id.to_lowercase().as_bytes());
    let mut hash = Sha512::digest(&first).to_vec();
    for _ in 0..5200 {
        let mut round = hash.clone();
        round.extend_from_slice(&keys);
        hash = Sha512::digest(&round).to_vec();
    }
    let mut digits = String::new();
    for chunk in 0..6 {
        let n = hash[chunk * 5..chunk * 5 + 5]
            .iter()
            .fold(0u64, |acc, &b| acc * 256 + u64::from(b));
        digits.push_str(&format!("{:05}", n % 100_000));
    }
    Ok(digits)
}

/// The 60-digit safety number of two accounts, the same from either side.
pub fn safety_number(a: &IdentityKeys<'_>, b: &IdentityKeys<'_>) -> CryptoResult<String> {
    let mut sides = [fingerprint_digits(a)?, fingerprint_digits(b)?];
    sides.sort();
    Ok(sides.concat())
}
