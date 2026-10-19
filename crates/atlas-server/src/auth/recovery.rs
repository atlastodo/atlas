//! Account-recovery challenge: `POST /auth/recover` must prove possession of the account's
//! recovery key, not just knowledge of an email.
//!
//! `GET /auth/recovery-keys` issues a signed token plus a nonce sealed to the recovery key; the
//! caller answers with the unsealed nonce (an HMAC of the token under the server secret, so
//! nothing is stored). The token carries a fingerprint of the current password hash, so a
//! recovery spends every outstanding challenge. The sealing key is chosen by the recovery key
//! version ([`recipient`]): 2 is the phrase-derived `recovery_public_key`, 1 is the device
//! `public_key` (accounts without a recovery key; every signed-in device holds that private key,
//! so version 1 is never used once version 2 exists). The token names the version and key, so a
//! challenge dies if the recovery key changes. Sealing is byte-compatible with the client's
//! `sealKey`/`unsealKey` and pinned by `test-vectors/recovery_challenge_vectors.json`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit as HmacKeyInit, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

pub const CHALLENGE_TTL_SECS: i64 = 600;
pub const RECOVERY_KEY_V1: u8 = 1;
pub const RECOVERY_KEY_V2: u8 = 2;
const AUDIENCE: &str = "atlas-recover";
const NONCE_DOMAIN: &[u8] = b"atlas-recover-v1";
const SEAL_INFO: &[u8] = b"atlas-seal-v1";
/// Recovery blobs wrap a 32-byte key; AES-GCM appends a 16-byte tag.
const WRAPPED_KEY_CT_LEN: usize = 32 + 16;
const IV_LEN: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub iv: String,
    pub ct: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedKey {
    pub ephemeral_public_key: String,
    pub encrypted_key: EncryptedPayload,
}

#[derive(Debug, Serialize)]
pub struct Challenge {
    pub token: String,
    pub sealed: SealedKey,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChallengeClaims {
    pub aud: String,
    pub email: String,
    pub pwh: String,
    pub ver: u8,
    pub rk: String,
    pub exp: i64,
    pub jti: Uuid,
}

/// First 16 bytes of SHA-256 over the stored PHC string, hex; a challenge dies with its hash.
pub fn password_hash_fingerprint(password_hash: &str) -> String {
    hex::encode(&Sha256::digest(password_hash.as_bytes())[..16])
}

pub fn key_fingerprint(key: &PublicKey) -> String {
    hex::encode(&Sha256::digest(key.as_bytes())[..16])
}

/// Parse a stored X25519 public key (32 bytes, hex); `None` means the account gets the dummy.
pub fn parse_public_key(hex_key: &str) -> Option<PublicKey> {
    let bytes: [u8; 32] = hex::decode(hex_key).ok()?.try_into().ok()?;
    Some(PublicKey::from(bytes))
}

/// The key an account's challenge is sealed to, with its version: the recovery key when one is
/// registered, else the device key. An unparseable registered key yields `None`, not a fallback.
pub fn recipient(
    recovery_public_key: Option<&str>,
    public_key: Option<&str>,
) -> Option<(u8, PublicKey)> {
    match recovery_public_key {
        Some(key) => Some((RECOVERY_KEY_V2, parse_public_key(key)?)),
        None => Some((RECOVERY_KEY_V1, parse_public_key(public_key?)?)),
    }
}

pub fn issue_challenge(
    secret: &[u8],
    email: &str,
    pwh: &str,
    version: u8,
    recipient: &PublicKey,
    now_unix: i64,
) -> Result<Challenge, jsonwebtoken::errors::Error> {
    let claims = ChallengeClaims {
        aud: AUDIENCE.to_owned(),
        email: email.to_owned(),
        pwh: pwh.to_owned(),
        ver: version,
        rk: key_fingerprint(recipient),
        exp: now_unix + CHALLENGE_TTL_SECS,
        jti: random_uuid(),
    };
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret),
    )?;
    let nonce = nonce_mac(secret, &token).finalize().into_bytes();
    let sealed = seal(recipient, &nonce);
    Ok(Challenge { token, sealed })
}

fn random_uuid() -> Uuid {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    uuid::Builder::from_random_bytes(bytes).into_uuid()
}

/// Verify a challenge token's signature, expiry and audience; `aud` keeps an access token from
/// passing as a challenge and vice versa.
pub fn verify_challenge(secret: &[u8], token: &str) -> Option<ChallengeClaims> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.leeway = 0;
    validation.set_audience(&[AUDIENCE]);
    validation.set_required_spec_claims(&["exp", "aud"]);
    jsonwebtoken::decode::<ChallengeClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret),
        &validation,
    )
    .ok()
    .map(|data| data.claims)
}

pub fn response_matches(secret: &[u8], token: &str, response_hex: &str) -> bool {
    let Ok(response) = hex::decode(response_hex) else {
        return false;
    };
    nonce_mac(secret, token).verify_slice(&response).is_ok()
}

fn nonce_mac(secret: &[u8], token: &str) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as HmacKeyInit>::new_from_slice(secret)
        .expect("HMAC accepts keys of any length");
    mac.update(NONCE_DOMAIN);
    mac.update(token.as_bytes());
    mac
}

pub fn seal(recipient: &PublicKey, plaintext: &[u8]) -> SealedKey {
    let mut ephemeral_secret = [0u8; 32];
    let mut iv = [0u8; IV_LEN];
    rand::rng().fill_bytes(&mut ephemeral_secret);
    rand::rng().fill_bytes(&mut iv);
    seal_with(recipient, plaintext, ephemeral_secret, iv)
}

fn seal_with(
    recipient: &PublicKey,
    plaintext: &[u8],
    ephemeral_secret: [u8; 32],
    iv: [u8; IV_LEN],
) -> SealedKey {
    let ephemeral = StaticSecret::from(ephemeral_secret);
    let shared = ephemeral.diffie_hellman(recipient);
    let ct = Aes256Gcm::new(&seal_key(shared.as_bytes()).into())
        .encrypt(&Nonce::from(iv), plaintext)
        .expect("AES-GCM only fails for plaintexts beyond 64 GiB");
    SealedKey {
        ephemeral_public_key: hex::encode(PublicKey::from(&ephemeral).as_bytes()),
        encrypted_key: EncryptedPayload {
            iv: BASE64.encode(iv),
            ct: BASE64.encode(ct),
        },
    }
}

fn seal_key(shared: &[u8; 32]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared)
        .expand(SEAL_INFO, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

// Anti-enumeration dummies: an address with no recoverable account gets a response of identical
// shape. Each derives from the per-email server-keyed `seed`, stable across requests but
// unpredictable.

fn dummy_bytes<const N: usize>(seed: &str, label: &str) -> [u8; N] {
    let mut out = [0u8; N];
    Hkdf::<Sha256>::new(None, seed.as_bytes())
        .expand(
            format!("atlas-recover-dummy-v1/{label}").as_bytes(),
            &mut out,
        )
        .expect("dummy lengths are far below the HKDF-SHA256 limit");
    out
}

/// A stand-in for the account's public key; its secret is derivable only with the server secret.
pub fn dummy_public_key(seed: &str) -> PublicKey {
    PublicKey::from(&StaticSecret::from(dummy_bytes::<32>(seed, "key")))
}

pub fn dummy_fingerprint(seed: &str) -> String {
    hex::encode(dummy_bytes::<16>(seed, "pwh"))
}

/// A wrapped-key blob the length of a real one; like a real blob under a wrong phrase it fails
/// AES-GCM authentication. Keys are emitted in the order Postgres `jsonb` returns.
pub fn dummy_wrapped_key(seed: &str, label: &str) -> serde_json::Value {
    let iv = dummy_bytes::<IV_LEN>(seed, &format!("{label}/iv"));
    let ct = dummy_bytes::<WRAPPED_KEY_CT_LEN>(seed, &format!("{label}/ct"));
    serde_json::json!({ "ct": BASE64.encode(ct), "iv": BASE64.encode(iv) })
}

/// A root-key-era wrap (`{v: 1, iv, ct}`): an app key under the root, or a phrase-form recovery
/// slot.
pub fn dummy_versioned_wrap(seed: &str, label: &str) -> serde_json::Value {
    let mut wrap = dummy_wrapped_key(seed, label);
    wrap["v"] = serde_json::json!(1);
    wrap
}

/// The root key's recovery slot as `GET /auth/recovery-keys` answers it: always with an `epk`.
/// Real slots come in two forms, wrapped under the phrase (`{v, iv, ct}`) or sealed to the
/// recovery key (`{v, epk, iv, ct}`); the phrase form gets a stand-in `epk` and the client tries
/// both, so the shape tells neither the form nor, with [`dummy_root_slot`], whether a slot exists.
pub fn padded_root_slot(seed: &str, mut slot: serde_json::Value) -> serde_json::Value {
    if slot.get("epk").is_none() {
        slot["epk"] = serde_json::json!(hex::encode(dummy_bytes::<32>(seed, "root/epk")));
    }
    slot
}

/// A stand-in for the root key's recovery slot (see [`padded_root_slot`]).
pub fn dummy_root_slot(seed: &str) -> serde_json::Value {
    padded_root_slot(seed, dummy_versioned_wrap(seed, "root"))
}

/// A stand-in account id (a v4 UUID, like the ones Postgres and the client generate).
pub fn dummy_user_id(seed: &str) -> Uuid {
    uuid::Builder::from_random_bytes(dummy_bytes::<16>(seed, "user-id")).into_uuid()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-at-least-32-bytes-long!!";
    const VECTORS: &str = include_str!("../../../../test-vectors/recovery_challenge_vectors.json");

    fn now() -> i64 {
        time::OffsetDateTime::now_utc().unix_timestamp()
    }

    fn unseal(sealed: &SealedKey, recipient: &StaticSecret) -> Option<Vec<u8>> {
        let ephemeral: [u8; 32] = hex::decode(&sealed.ephemeral_public_key)
            .ok()?
            .try_into()
            .ok()?;
        let shared = recipient.diffie_hellman(&PublicKey::from(ephemeral));
        let iv = BASE64.decode(&sealed.encrypted_key.iv).ok()?;
        let ct = BASE64.decode(&sealed.encrypted_key.ct).ok()?;
        Aes256Gcm::new(&seal_key(shared.as_bytes()).into())
            .decrypt(&Nonce::try_from(iv.as_slice()).ok()?, ct.as_slice())
            .ok()
    }

    fn hex32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn sealing_reproduces_the_shared_vectors() {
        let file: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let recipient = StaticSecret::from(hex32(v["recipient_secret_key"].as_str().unwrap()));
            let recipient_pub = PublicKey::from(&recipient);
            assert_eq!(
                hex::encode(recipient_pub.as_bytes()),
                v["recipient_public_key"].as_str().unwrap(),
                "{name}: public key"
            );
            let nonce = hex::decode(v["nonce"].as_str().unwrap()).unwrap();
            let iv: [u8; IV_LEN] = hex::decode(v["iv"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let sealed = seal_with(
                &recipient_pub,
                &nonce,
                hex32(v["ephemeral_secret_key"].as_str().unwrap()),
                iv,
            );
            assert_eq!(
                serde_json::to_value(&sealed).unwrap(),
                v["sealed"],
                "{name}: sealed output"
            );
            let expected: SealedKey = serde_json::from_value(v["sealed"].clone()).unwrap();
            assert_eq!(unseal(&expected, &recipient), Some(nonce), "{name}: unseal");
        }
    }

    #[test]
    fn an_issued_challenge_is_answered_only_by_the_key_holder() {
        let recipient = StaticSecret::from([7u8; 32]);
        let challenge = issue_challenge(
            SECRET,
            "a@example.com",
            &password_hash_fingerprint("$argon2id$x"),
            RECOVERY_KEY_V2,
            &PublicKey::from(&recipient),
            now(),
        )
        .unwrap();
        let claims = verify_challenge(SECRET, &challenge.token).unwrap();
        assert_eq!(claims.email, "a@example.com");
        assert_eq!(claims.pwh, password_hash_fingerprint("$argon2id$x"));
        assert_eq!(claims.ver, RECOVERY_KEY_V2);
        assert_eq!(claims.rk, key_fingerprint(&PublicKey::from(&recipient)));

        let nonce = unseal(&challenge.sealed, &recipient).unwrap();
        assert_eq!(nonce.len(), 32);
        assert!(response_matches(
            SECRET,
            &challenge.token,
            &hex::encode(&nonce)
        ));

        assert!(unseal(&challenge.sealed, &StaticSecret::from([8u8; 32])).is_none());
        assert!(!response_matches(
            SECRET,
            &challenge.token,
            &"00".repeat(32)
        ));
        assert!(!response_matches(SECRET, &challenge.token, "not hex"));
        assert!(!response_matches(SECRET, &challenge.token, ""));
        assert!(
            !response_matches(b"another-secret", &challenge.token, &hex::encode(&nonce)),
            "the nonce is keyed by the server secret"
        );
    }

    #[test]
    fn challenge_tokens_expire_and_are_not_access_tokens() {
        let recipient = PublicKey::from(&StaticSecret::from([7u8; 32]));
        let expired =
            issue_challenge(SECRET, "a@example.com", "pwh", 2, &recipient, now() - 601).unwrap();
        assert!(verify_challenge(SECRET, &expired.token).is_none());

        let fresh = issue_challenge(SECRET, "a@example.com", "pwh", 2, &recipient, now()).unwrap();
        assert!(verify_challenge(b"another-secret", &fresh.token).is_none());
        assert!(
            super::super::token::verify_access_token(&fresh.token, SECRET).is_err(),
            "a challenge token is not a session"
        );

        let access = super::super::token::issue_access_token(
            Uuid::now_v7(),
            Uuid::now_v7(),
            900,
            SECRET,
            now(),
        )
        .unwrap();
        assert!(
            verify_challenge(SECRET, &access).is_none(),
            "an access token is not a challenge"
        );
    }

    #[test]
    fn the_recovery_key_wins_and_never_falls_back_once_registered() {
        let device = hex::encode([1u8; 32]);
        let recovery = hex::encode([2u8; 32]);
        let (ver, key) = recipient(Some(&recovery), Some(&device)).unwrap();
        assert_eq!((ver, key.as_bytes()), (RECOVERY_KEY_V2, &[2u8; 32]));
        let (ver, key) = recipient(None, Some(&device)).unwrap();
        assert_eq!((ver, key.as_bytes()), (RECOVERY_KEY_V1, &[1u8; 32]));
        assert!(
            recipient(Some("garbage"), Some(&device)).is_none(),
            "a broken recovery key does not reopen the device-key path"
        );
        assert!(recipient(None, None).is_none());
    }

    #[test]
    fn dummies_match_real_lengths_and_are_deterministic_per_seed() {
        let real_fingerprint = password_hash_fingerprint("$argon2id$v=19$whatever");
        assert_eq!(dummy_fingerprint("seed").len(), real_fingerprint.len());
        assert_eq!(dummy_fingerprint("seed"), dummy_fingerprint("seed"));
        assert_ne!(dummy_fingerprint("seed"), dummy_fingerprint("other"));

        let blob = dummy_wrapped_key("seed", "dek");
        assert_eq!(
            BASE64.decode(blob["iv"].as_str().unwrap()).unwrap().len(),
            12
        );
        assert_eq!(
            BASE64.decode(blob["ct"].as_str().unwrap()).unwrap().len(),
            48
        );
        assert_eq!(blob, dummy_wrapped_key("seed", "dek"));
        assert_ne!(blob, dummy_wrapped_key("seed", "priv"));

        assert_eq!(
            dummy_public_key("seed").as_bytes(),
            dummy_public_key("seed").as_bytes()
        );
        assert_ne!(
            dummy_public_key("seed").as_bytes(),
            dummy_public_key("other").as_bytes()
        );
    }
}
