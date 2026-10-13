//! A WebAuthn relying party, reduced to what passkeys here need: building the ceremony options a
//! client hands to `navigator.credentials` (or Android's Credential Manager), and verifying the
//! registration and assertion responses it sends back.
//!
//! Scope, deliberately small:
//! - Attestation is not verified: options ask for `"none"`, and whatever statement comes back is
//!   ignored. Synced passkeys carry none anyway; what a passkey proves here is possession of its
//!   private key, which every assertion re-checks.
//! - User verification is required in every ceremony (the `UV` flag), since a passkey stands in
//!   for the password and unlocks the account keys.
//! - Signatures: ES256 (P-256), EdDSA (Ed25519) and RS256, over RustCrypto primitives.
//! - Extensions are not interpreted. The PRF extension runs between client and authenticator; the
//!   server only checks that the client reports it enabled and never receives its output.
//!
//! Data in and out is the WebAuthn Level 3 JSON form (`PublicKeyCredentialCreationOptionsJSON`,
//! `RegistrationResponseJSON`, …): binary fields are base64url.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use ciborium::Value as Cbor;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// COSE algorithm identifiers this relying party accepts, in order of preference.
pub const ALG_EDDSA: i64 = -8;
pub const ALG_ES256: i64 = -7;
pub const ALG_RS256: i64 = -257;

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;

/// Upper bound on a credential id (the spec caps it at 1023 bytes).
pub const MAX_CREDENTIAL_ID_LEN: usize = 1023;
/// Upper bound on any one base64url field of a response; real ones are a few hundred bytes.
const MAX_FIELD_LEN: usize = 16 * 1024;

/// Why a response was refused. Never shown in detail to a client beyond the message.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebauthnError {
    #[error("malformed {0}")]
    Malformed(&'static str),
    #[error("the response is for another ceremony")]
    WrongType,
    #[error("the challenge does not match")]
    Challenge,
    #[error("the origin {0:?} is not allowed")]
    Origin(String),
    #[error("the response is for another relying party")]
    RpId,
    #[error("the authenticator did not verify the user")]
    UserNotVerified,
    #[error("unsupported public key algorithm")]
    UnsupportedAlgorithm,
    #[error("the signature does not verify")]
    Signature,
    #[error("the signature counter went backwards")]
    Counter,
}

type Result<T> = std::result::Result<T, WebauthnError>;

/// The relying party: its id (a domain), display name and the origins a response may come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelyingParty {
    pub id: String,
    pub name: String,
    pub origins: Vec<String>,
}

/// Decode base64url, with or without padding.
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() > MAX_FIELD_LEN {
        return None;
    }
    B64URL.decode(s.trim_end_matches('=')).ok()
}

pub fn b64url(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

/// `clientDataJSON`, the fields checked.
#[derive(Debug, Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: Option<bool>,
}

/// The challenge a response answers, read from its `clientDataJSON` (base64url) without checking
/// anything else: the caller looks the ceremony up by it, then verifies against it.
pub fn response_challenge(client_data_json_b64: &str) -> Result<String> {
    let raw =
        b64url_decode(client_data_json_b64).ok_or(WebauthnError::Malformed("clientDataJSON"))?;
    let cd: ClientData =
        serde_json::from_slice(&raw).map_err(|_| WebauthnError::Malformed("clientDataJSON"))?;
    // Normalized: the stored challenge is unpadded base64url.
    let bytes = b64url_decode(&cd.challenge).ok_or(WebauthnError::Malformed("challenge"))?;
    Ok(b64url(&bytes))
}

impl RelyingParty {
    fn check_client_data(&self, raw: &[u8], kind: &str, challenge: &str) -> Result<()> {
        let cd: ClientData =
            serde_json::from_slice(raw).map_err(|_| WebauthnError::Malformed("clientDataJSON"))?;
        if cd.kind != kind {
            return Err(WebauthnError::WrongType);
        }
        let got = b64url_decode(&cd.challenge).ok_or(WebauthnError::Challenge)?;
        let want = b64url_decode(challenge).ok_or(WebauthnError::Challenge)?;
        if got != want {
            return Err(WebauthnError::Challenge);
        }
        if cd.cross_origin == Some(true) {
            return Err(WebauthnError::Origin(cd.origin));
        }
        let origin = cd.origin.trim_end_matches('/');
        if !self.origins.iter().any(|o| o == origin) {
            return Err(WebauthnError::Origin(cd.origin));
        }
        Ok(())
    }

    /// `PublicKeyCredentialCreationOptionsJSON` for a discoverable, user-verified passkey with
    /// the PRF extension (`prf_input` is its `eval.first`).
    pub fn creation_options(
        &self,
        challenge: &str,
        user_handle: &[u8],
        user_name: &str,
        user_display_name: &str,
        exclude: &[(String, Vec<String>)],
        prf_input: &str,
    ) -> Value {
        json!({
            "rp": { "id": self.id, "name": self.name },
            "user": {
                "id": b64url(user_handle),
                "name": user_name,
                "displayName": if user_display_name.is_empty() { user_name } else { user_display_name },
            },
            "challenge": challenge,
            "pubKeyCredParams": [
                { "type": "public-key", "alg": ALG_EDDSA },
                { "type": "public-key", "alg": ALG_ES256 },
                { "type": "public-key", "alg": ALG_RS256 },
            ],
            "timeout": CEREMONY_TIMEOUT_MS,
            "excludeCredentials": descriptors(exclude),
            "authenticatorSelection": {
                "residentKey": "required",
                "requireResidentKey": true,
                "userVerification": "required",
            },
            "attestation": "none",
            "extensions": {
                "credProps": true,
                "prf": { "eval": { "first": prf_input } },
            },
        })
    }

    /// `PublicKeyCredentialRequestOptionsJSON`. With no `allow` list the request is discoverable
    /// (the authenticator offers its passkeys for this RP) and PRF evaluates `prf_input` for any;
    /// otherwise each allowed credential gets its own input.
    pub fn request_options(
        &self,
        challenge: &str,
        allow: &[(String, Vec<String>)],
        prf_input: &str,
        prf_by_credential: &[(String, String)],
    ) -> Value {
        let mut prf = json!({ "eval": { "first": prf_input } });
        if !prf_by_credential.is_empty() {
            let by: serde_json::Map<String, Value> = prf_by_credential
                .iter()
                .map(|(id, input)| (id.clone(), json!({ "first": input })))
                .collect();
            prf["evalByCredential"] = Value::Object(by);
        }
        json!({
            "challenge": challenge,
            "rpId": self.id,
            "timeout": CEREMONY_TIMEOUT_MS,
            "userVerification": "required",
            "allowCredentials": descriptors(allow),
            "extensions": { "prf": prf },
        })
    }

    /// Verify a registration response against the ceremony's challenge.
    pub fn verify_registration(
        &self,
        response: &RegistrationResponse,
        challenge: &str,
    ) -> Result<NewCredential> {
        let client_data = b64url_decode(&response.response.client_data_json)
            .ok_or(WebauthnError::Malformed("clientDataJSON"))?;
        self.check_client_data(&client_data, "webauthn.create", challenge)?;
        let att = b64url_decode(&response.response.attestation_object)
            .ok_or(WebauthnError::Malformed("attestationObject"))?;
        let att: Cbor = ciborium::from_reader(att.as_slice())
            .map_err(|_| WebauthnError::Malformed("attestationObject"))?;
        let auth_data = map_get_text(&att, "authData")
            .and_then(|v| v.as_bytes().cloned())
            .ok_or(WebauthnError::Malformed("attestationObject"))?;
        let parsed = parse_auth_data(&auth_data)?;
        self.check_auth_data(&parsed)?;
        let attested = parsed
            .attested
            .ok_or(WebauthnError::Malformed("authenticatorData"))?;
        // The id the client reports must be the one the authenticator attested.
        let raw_id = b64url_decode(&response.raw_id).ok_or(WebauthnError::Malformed("rawId"))?;
        if raw_id != attested.credential_id {
            return Err(WebauthnError::Malformed("rawId"));
        }
        let algorithm = PublicKey::from_cose(&attested.public_key)?.algorithm();
        Ok(NewCredential {
            credential_id: b64url(&attested.credential_id),
            public_key: attested.public_key,
            algorithm,
            sign_count: parsed.sign_count,
            backup_eligible: parsed.flags & FLAG_BE != 0,
            backed_up: parsed.flags & FLAG_BS != 0,
        })
    }

    /// Verify an assertion against the ceremony's challenge and the stored credential. Returns
    /// the authenticator's new signature counter.
    pub fn verify_assertion(
        &self,
        response: &AssertionResponse,
        challenge: &str,
        public_key_cose: &[u8],
        stored_sign_count: u32,
    ) -> Result<AssertionOutcome> {
        let client_data = b64url_decode(&response.response.client_data_json)
            .ok_or(WebauthnError::Malformed("clientDataJSON"))?;
        self.check_client_data(&client_data, "webauthn.get", challenge)?;
        let auth_data = b64url_decode(&response.response.authenticator_data)
            .ok_or(WebauthnError::Malformed("authenticatorData"))?;
        let parsed = parse_auth_data(&auth_data)?;
        self.check_auth_data(&parsed)?;
        let signature = b64url_decode(&response.response.signature)
            .ok_or(WebauthnError::Malformed("signature"))?;
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&Sha256::digest(&client_data));
        PublicKey::from_cose(public_key_cose)?.verify(&signed, &signature)?;
        // A counter that stops increasing signals a cloned authenticator. Zero on both sides means
        // the authenticator keeps no counter (synced passkeys).
        if (parsed.sign_count != 0 || stored_sign_count != 0)
            && parsed.sign_count <= stored_sign_count
        {
            return Err(WebauthnError::Counter);
        }
        Ok(AssertionOutcome {
            sign_count: parsed.sign_count,
            backed_up: parsed.flags & FLAG_BS != 0,
        })
    }

    fn check_auth_data(&self, parsed: &AuthData) -> Result<()> {
        if parsed.rp_id_hash != Sha256::digest(self.id.as_bytes()).as_slice() {
            return Err(WebauthnError::RpId);
        }
        if parsed.flags & FLAG_UP == 0 || parsed.flags & FLAG_UV == 0 {
            return Err(WebauthnError::UserNotVerified);
        }
        Ok(())
    }
}

/// How long a client gets to finish a ceremony; the server-side challenge lives a little longer.
pub const CEREMONY_TIMEOUT_MS: u64 = 5 * 60 * 1000;

fn descriptors(creds: &[(String, Vec<String>)]) -> Value {
    Value::Array(
        creds
            .iter()
            .map(|(id, transports)| {
                let mut d = json!({ "type": "public-key", "id": id });
                if !transports.is_empty() {
                    d["transports"] = json!(transports);
                }
                d
            })
            .collect(),
    )
}

/// `RegistrationResponseJSON`, the fields used.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistrationResponse {
    pub id: String,
    #[serde(rename = "rawId")]
    pub raw_id: String,
    pub response: AttestationJson,
    #[serde(rename = "clientExtensionResults", default)]
    pub client_extension_results: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttestationJson {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "attestationObject")]
    pub attestation_object: String,
    #[serde(default)]
    pub transports: Vec<String>,
}

/// `AuthenticationResponseJSON`, the fields used.
#[derive(Debug, Clone, Deserialize)]
pub struct AssertionResponse {
    pub id: String,
    #[serde(rename = "rawId")]
    pub raw_id: String,
    pub response: AssertionJson,
    #[serde(rename = "clientExtensionResults", default)]
    pub client_extension_results: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssertionJson {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    pub signature: String,
    #[serde(rename = "userHandle", default)]
    pub user_handle: Option<String>,
}

/// What a client reports of the PRF extension. The output must never reach the server; a client
/// that sends `results` is refused rather than having it silently dropped.
#[derive(Debug, PartialEq, Eq)]
pub enum PrfReport {
    Enabled,
    Missing,
    LeakedOutput,
}

pub fn prf_report(client_extension_results: &Value) -> PrfReport {
    let prf = client_extension_results.get("prf");
    if prf
        .and_then(|p| p.get("results"))
        .is_some_and(|r| !r.is_null())
    {
        return PrfReport::LeakedOutput;
    }
    match prf.and_then(|p| p.get("enabled")).and_then(Value::as_bool) {
        Some(true) => PrfReport::Enabled,
        _ => PrfReport::Missing,
    }
}

/// A verified registration, ready to store.
#[derive(Debug, Clone)]
pub struct NewCredential {
    /// base64url of the raw credential id.
    pub credential_id: String,
    /// The credential's COSE_Key, as the authenticator encoded it.
    pub public_key: Vec<u8>,
    pub algorithm: i64,
    pub sign_count: u32,
    pub backup_eligible: bool,
    pub backed_up: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct AssertionOutcome {
    pub sign_count: u32,
    pub backed_up: bool,
}

struct AuthData {
    rp_id_hash: [u8; 32],
    flags: u8,
    sign_count: u32,
    attested: Option<AttestedCredential>,
}

struct AttestedCredential {
    credential_id: Vec<u8>,
    public_key: Vec<u8>,
}

fn parse_auth_data(data: &[u8]) -> Result<AuthData> {
    const BAD: WebauthnError = WebauthnError::Malformed("authenticatorData");
    if data.len() < 37 {
        return Err(BAD);
    }
    let rp_id_hash: [u8; 32] = data[..32].try_into().map_err(|_| BAD)?;
    let flags = data[32];
    let sign_count = u32::from_be_bytes(data[33..37].try_into().map_err(|_| BAD)?);
    let attested = if flags & FLAG_AT != 0 {
        // aaguid (16), credential id length (2), credential id, COSE key (CBOR), then extensions.
        let rest = data.get(37..).ok_or(BAD)?;
        let len_bytes = rest.get(16..18).ok_or(BAD)?;
        let id_len = usize::from(u16::from_be_bytes([len_bytes[0], len_bytes[1]]));
        if id_len == 0 || id_len > MAX_CREDENTIAL_ID_LEN {
            return Err(BAD);
        }
        let credential_id = rest.get(18..18 + id_len).ok_or(BAD)?.to_vec();
        let key_and_more = rest.get(18 + id_len..).ok_or(BAD)?;
        let mut reader = key_and_more;
        let _: Cbor = ciborium::from_reader(&mut reader).map_err(|_| BAD)?;
        let key_len = key_and_more.len() - reader.len();
        Some(AttestedCredential {
            credential_id,
            public_key: key_and_more[..key_len].to_vec(),
        })
    } else {
        None
    };
    Ok(AuthData {
        rp_id_hash,
        flags,
        sign_count,
        attested,
    })
}

fn map_get_text<'a>(map: &'a Cbor, key: &str) -> Option<&'a Cbor> {
    map.as_map()?
        .iter()
        .find(|(k, _)| k.as_text() == Some(key))
        .map(|(_, v)| v)
}

fn map_get_int(map: &Cbor, key: i64) -> Option<&Cbor> {
    map.as_map()?
        .iter()
        .find(|(k, _)| k.as_integer().and_then(|i| i64::try_from(i).ok()) == Some(key))
        .map(|(_, v)| v)
}

fn cbor_int(v: Option<&Cbor>) -> Option<i64> {
    v?.as_integer().and_then(|i| i64::try_from(i).ok())
}

fn cbor_bytes(v: Option<&Cbor>) -> Option<&Vec<u8>> {
    v?.as_bytes()
}

/// A credential public key, from its COSE_Key encoding.
enum PublicKey {
    Es256(p256::ecdsa::VerifyingKey),
    EdDsa(ed25519_dalek::VerifyingKey),
    Rs256(rsa::RsaPublicKey),
}

impl PublicKey {
    fn from_cose(cose: &[u8]) -> Result<Self> {
        const BAD: WebauthnError = WebauthnError::Malformed("public key");
        let key: Cbor = ciborium::from_reader(cose).map_err(|_| BAD)?;
        let kty = cbor_int(map_get_int(&key, 1)).ok_or(BAD)?;
        let alg = cbor_int(map_get_int(&key, 3)).ok_or(BAD)?;
        match (kty, alg) {
            // EC2, P-256.
            (2, ALG_ES256) => {
                if cbor_int(map_get_int(&key, -1)) != Some(1) {
                    return Err(WebauthnError::UnsupportedAlgorithm);
                }
                let x = cbor_bytes(map_get_int(&key, -2)).ok_or(BAD)?;
                let y = cbor_bytes(map_get_int(&key, -3)).ok_or(BAD)?;
                if x.len() != 32 || y.len() != 32 {
                    return Err(BAD);
                }
                let point = p256::EncodedPoint::from_affine_coordinates(
                    x.as_slice().into(),
                    y.as_slice().into(),
                    false,
                );
                p256::ecdsa::VerifyingKey::from_encoded_point(&point)
                    .map(PublicKey::Es256)
                    .map_err(|_| BAD)
            }
            // OKP, Ed25519.
            (1, ALG_EDDSA) => {
                if cbor_int(map_get_int(&key, -1)) != Some(6) {
                    return Err(WebauthnError::UnsupportedAlgorithm);
                }
                let x: [u8; 32] = cbor_bytes(map_get_int(&key, -2))
                    .ok_or(BAD)?
                    .as_slice()
                    .try_into()
                    .map_err(|_| BAD)?;
                ed25519_dalek::VerifyingKey::from_bytes(&x)
                    .map(PublicKey::EdDsa)
                    .map_err(|_| BAD)
            }
            // RSA.
            (3, ALG_RS256) => {
                let n = cbor_bytes(map_get_int(&key, -1)).ok_or(BAD)?;
                let e = cbor_bytes(map_get_int(&key, -2)).ok_or(BAD)?;
                rsa::RsaPublicKey::new(
                    rsa::BigUint::from_bytes_be(n),
                    rsa::BigUint::from_bytes_be(e),
                )
                .map(PublicKey::Rs256)
                .map_err(|_| BAD)
            }
            _ => Err(WebauthnError::UnsupportedAlgorithm),
        }
    }

    fn algorithm(&self) -> i64 {
        match self {
            PublicKey::Es256(_) => ALG_ES256,
            PublicKey::EdDsa(_) => ALG_EDDSA,
            PublicKey::Rs256(_) => ALG_RS256,
        }
    }

    fn verify(&self, message: &[u8], signature: &[u8]) -> Result<()> {
        use p256::ecdsa::signature::Verifier;
        let ok = match self {
            PublicKey::Es256(key) => p256::ecdsa::Signature::from_der(signature)
                .is_ok_and(|sig| key.verify(message, &sig).is_ok()),
            PublicKey::EdDsa(key) => ed25519_dalek::Signature::from_slice(signature)
                .is_ok_and(|sig| key.verify_strict(message, &sig).is_ok()),
            PublicKey::Rs256(key) => {
                let verifier = rsa::pkcs1v15::VerifyingKey::<rsa::sha2::Sha256>::new(key.clone());
                rsa::pkcs1v15::Signature::try_from(signature)
                    .is_ok_and(|sig| verifier.verify(message, &sig).is_ok())
            }
        };
        if ok {
            Ok(())
        } else {
            Err(WebauthnError::Signature)
        }
    }
}

/// A software authenticator for tests: builds registration and assertion responses the way a
/// browser and platform authenticator would, signing with a P-256 or Ed25519 key.
#[cfg(any(test, feature = "test-authenticator"))]
pub mod soft {
    use super::*;
    use p256::ecdsa::signature::Signer;

    pub enum Key {
        P256(p256::ecdsa::SigningKey),
        Ed25519(ed25519_dalek::SigningKey),
    }

    pub struct SoftAuthenticator {
        pub key: Key,
        pub credential_id: Vec<u8>,
        pub sign_count: u32,
        pub user_handle: Vec<u8>,
        /// Flags set on every response (UP|UV by default).
        pub flags: u8,
    }

    impl SoftAuthenticator {
        pub fn p256(seed: u8, user_handle: &[u8]) -> Self {
            let mut bytes = [seed; 32];
            bytes[0] = 1; // keep the scalar in range
            Self {
                key: Key::P256(p256::ecdsa::SigningKey::from_bytes(&bytes.into()).unwrap()),
                credential_id: vec![seed; 16],
                sign_count: 0,
                user_handle: user_handle.to_vec(),
                flags: FLAG_UP | FLAG_UV,
            }
        }

        pub fn ed25519(seed: u8, user_handle: &[u8]) -> Self {
            Self {
                key: Key::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[seed; 32])),
                credential_id: vec![seed ^ 0x5a; 20],
                sign_count: 0,
                user_handle: user_handle.to_vec(),
                flags: FLAG_UP | FLAG_UV,
            }
        }

        pub fn credential_id_b64(&self) -> String {
            b64url(&self.credential_id)
        }

        fn cose_key(&self) -> Vec<u8> {
            let map = match &self.key {
                Key::P256(k) => {
                    let point = k.verifying_key().to_encoded_point(false);
                    Cbor::Map(vec![
                        (Cbor::from(1), Cbor::from(2)),
                        (Cbor::from(3), Cbor::from(ALG_ES256)),
                        (Cbor::from(-1), Cbor::from(1)),
                        (Cbor::from(-2), Cbor::Bytes(point.x().unwrap().to_vec())),
                        (Cbor::from(-3), Cbor::Bytes(point.y().unwrap().to_vec())),
                    ])
                }
                Key::Ed25519(k) => Cbor::Map(vec![
                    (Cbor::from(1), Cbor::from(1)),
                    (Cbor::from(3), Cbor::from(ALG_EDDSA)),
                    (Cbor::from(-1), Cbor::from(6)),
                    (
                        Cbor::from(-2),
                        Cbor::Bytes(k.verifying_key().to_bytes().to_vec()),
                    ),
                ]),
            };
            let mut out = Vec::new();
            ciborium::into_writer(&map, &mut out).unwrap();
            out
        }

        fn auth_data(&self, rp_id: &str, attested: bool) -> Vec<u8> {
            let mut data = Sha256::digest(rp_id.as_bytes()).to_vec();
            data.push(self.flags | if attested { FLAG_AT } else { 0 });
            data.extend_from_slice(&self.sign_count.to_be_bytes());
            if attested {
                data.extend_from_slice(&[0u8; 16]);
                data.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
                data.extend_from_slice(&self.credential_id);
                data.extend_from_slice(&self.cose_key());
            }
            data
        }

        fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
            serde_json::to_vec(&json!({
                "type": kind,
                "challenge": challenge,
                "origin": origin,
                "crossOrigin": false,
            }))
            .unwrap()
        }

        /// `RegistrationResponseJSON` for creation options (`options.challenge`, `options.rp.id`).
        pub fn register(&self, options: &Value, origin: &str, prf: bool) -> Value {
            let challenge = options["challenge"].as_str().unwrap();
            let rp_id = options["rp"]["id"].as_str().unwrap();
            let att = Cbor::Map(vec![
                (Cbor::from("fmt"), Cbor::from("none")),
                (Cbor::from("attStmt"), Cbor::Map(vec![])),
                (
                    Cbor::from("authData"),
                    Cbor::Bytes(self.auth_data(rp_id, true)),
                ),
            ]);
            let mut att_bytes = Vec::new();
            ciborium::into_writer(&att, &mut att_bytes).unwrap();
            let id = self.credential_id_b64();
            json!({
                "id": id,
                "rawId": id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64url(&Self::client_data("webauthn.create", challenge, origin)),
                    "attestationObject": b64url(&att_bytes),
                    "transports": ["internal", "hybrid"],
                },
                "authenticatorAttachment": "platform",
                "clientExtensionResults": if prf {
                    json!({ "prf": { "enabled": true }, "credProps": { "rk": true } })
                } else {
                    json!({ "credProps": { "rk": true } })
                },
            })
        }

        /// `AuthenticationResponseJSON` for request options; bumps the counter first when it
        /// counts (`counting`).
        pub fn assert(
            &mut self,
            options: &Value,
            rp_id: &str,
            origin: &str,
            counting: bool,
        ) -> Value {
            if counting {
                self.sign_count += 1;
            }
            let challenge = options["challenge"].as_str().unwrap();
            let auth_data = self.auth_data(rp_id, false);
            let client_data = Self::client_data("webauthn.get", challenge, origin);
            let mut signed = auth_data.clone();
            signed.extend_from_slice(&Sha256::digest(&client_data));
            let signature = match &self.key {
                Key::P256(k) => {
                    let sig: p256::ecdsa::Signature = k.sign(&signed);
                    sig.to_der().as_bytes().to_vec()
                }
                Key::Ed25519(k) => {
                    use ed25519_dalek::Signer as _;
                    k.sign(&signed).to_bytes().to_vec()
                }
            };
            let id = self.credential_id_b64();
            json!({
                "id": id,
                "rawId": id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64url(&client_data),
                    "authenticatorData": b64url(&auth_data),
                    "signature": b64url(&signature),
                    "userHandle": b64url(&self.user_handle),
                },
                "authenticatorAttachment": "platform",
                "clientExtensionResults": { "prf": {} },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::soft::SoftAuthenticator;
    use super::*;

    fn rp() -> RelyingParty {
        RelyingParty {
            id: "todo.example.com".into(),
            name: "Atlas".into(),
            origins: vec![
                "https://todo.example.com".into(),
                "android:apk-key-hash:abc".into(),
            ],
        }
    }

    const ORIGIN: &str = "https://todo.example.com";

    fn creation(challenge: &str) -> Value {
        rp().creation_options(challenge, &[7; 16], "a@example.com", "", &[], "cHJm")
    }

    fn registration(v: Value) -> RegistrationResponse {
        serde_json::from_value(v).unwrap()
    }

    fn assertion(v: Value) -> AssertionResponse {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn registers_and_asserts_with_p256_and_ed25519() {
        for mut auth in [
            SoftAuthenticator::p256(3, &[7; 16]),
            SoftAuthenticator::ed25519(4, &[7; 16]),
        ] {
            let opts = creation("Y2hhbGxlbmdl");
            let reg = registration(auth.register(&opts, ORIGIN, true));
            assert_eq!(
                prf_report(&reg.client_extension_results),
                PrfReport::Enabled
            );
            assert_eq!(
                response_challenge(&reg.response.client_data_json).unwrap(),
                "Y2hhbGxlbmdl"
            );
            let cred = rp().verify_registration(&reg, "Y2hhbGxlbmdl").unwrap();
            assert_eq!(cred.credential_id, auth.credential_id_b64());

            let req = rp().request_options("b3RoZXI", &[], "cHJm", &[]);
            let a = assertion(auth.assert(&req, "todo.example.com", ORIGIN, true));
            let out = rp()
                .verify_assertion(&a, "b3RoZXI", &cred.public_key, cred.sign_count)
                .unwrap();
            assert_eq!(out.sign_count, 1);
            // The same counter again is a replay or a clone.
            assert_eq!(
                rp().verify_assertion(&a, "b3RoZXI", &cred.public_key, 1)
                    .unwrap_err(),
                WebauthnError::Counter
            );
        }
    }

    #[test]
    fn a_zero_counter_authenticator_keeps_working() {
        let mut auth = SoftAuthenticator::p256(5, &[1; 16]);
        let reg = registration(auth.register(&creation("YQ"), ORIGIN, true));
        let cred = rp().verify_registration(&reg, "YQ").unwrap();
        for _ in 0..2 {
            let req = rp().request_options("Yg", &[], "cHJm", &[]);
            let a = assertion(auth.assert(&req, "todo.example.com", ORIGIN, false));
            assert_eq!(
                rp().verify_assertion(&a, "Yg", &cred.public_key, 0)
                    .unwrap()
                    .sign_count,
                0
            );
        }
    }

    #[test]
    fn refuses_wrong_challenge_origin_rp_type_and_signature() {
        let mut auth = SoftAuthenticator::p256(6, &[1; 16]);
        let reg = registration(auth.register(&creation("YQ"), ORIGIN, true));
        assert_eq!(
            rp().verify_registration(&reg, "Yg").unwrap_err(),
            WebauthnError::Challenge
        );
        let evil = registration(auth.register(&creation("YQ"), "https://evil.example", true));
        assert!(matches!(
            rp().verify_registration(&evil, "YQ").unwrap_err(),
            WebauthnError::Origin(_)
        ));
        let android =
            registration(auth.register(&creation("YQ"), "android:apk-key-hash:abc", true));
        assert!(rp().verify_registration(&android, "YQ").is_ok());

        let cred = rp().verify_registration(&reg, "YQ").unwrap();
        let req = rp().request_options("Yw", &[], "cHJm", &[]);
        let other_rp = assertion(auth.assert(&req, "evil.example", ORIGIN, true));
        assert_eq!(
            rp().verify_assertion(&other_rp, "Yw", &cred.public_key, 0)
                .unwrap_err(),
            WebauthnError::RpId
        );
        // A registration response replayed as an assertion.
        let mut wrong_type = assertion(auth.assert(&req, "todo.example.com", ORIGIN, true));
        wrong_type.response.client_data_json = reg.response.client_data_json.clone();
        assert!(rp()
            .verify_assertion(&wrong_type, "YQ", &cred.public_key, 0)
            .is_err());
        // Another key's signature.
        let mut other = SoftAuthenticator::p256(9, &[1; 16]);
        other.credential_id = auth.credential_id.clone();
        other.sign_count = 10;
        let forged = assertion(other.assert(&req, "todo.example.com", ORIGIN, true));
        assert_eq!(
            rp().verify_assertion(&forged, "Yw", &cred.public_key, 0)
                .unwrap_err(),
            WebauthnError::Signature
        );
    }

    #[test]
    fn user_verification_is_required() {
        let mut auth = SoftAuthenticator::p256(7, &[1; 16]);
        auth.flags = FLAG_UP;
        let reg = registration(auth.register(&creation("YQ"), ORIGIN, true));
        assert_eq!(
            rp().verify_registration(&reg, "YQ").unwrap_err(),
            WebauthnError::UserNotVerified
        );
    }

    #[test]
    fn prf_reports() {
        assert_eq!(prf_report(&json!({})), PrfReport::Missing);
        assert_eq!(
            prf_report(&json!({ "prf": { "enabled": false } })),
            PrfReport::Missing
        );
        assert_eq!(
            prf_report(&json!({ "prf": { "enabled": true } })),
            PrfReport::Enabled
        );
        assert_eq!(
            prf_report(&json!({ "prf": { "enabled": true, "results": { "first": "AAAA" } } })),
            PrfReport::LeakedOutput
        );
    }

    #[test]
    fn options_carry_prf_and_require_user_verification() {
        let c = rp().creation_options(
            "Yw",
            &[1, 2],
            "a@example.com",
            "Ann",
            &[("aWQ".into(), vec!["internal".into()])],
            "cHJm",
        );
        assert_eq!(c["authenticatorSelection"]["userVerification"], "required");
        assert_eq!(c["authenticatorSelection"]["residentKey"], "required");
        assert_eq!(c["extensions"]["prf"]["eval"]["first"], "cHJm");
        assert_eq!(c["excludeCredentials"][0]["id"], "aWQ");
        assert_eq!(c["user"]["id"], "AQI");
        let r = rp().request_options(
            "Yw",
            &[("aWQ".into(), vec![])],
            "cHJm",
            &[("aWQ".into(), "eHl6".into())],
        );
        assert_eq!(r["rpId"], "todo.example.com");
        assert_eq!(
            r["extensions"]["prf"]["evalByCredential"]["aWQ"]["first"],
            "eHl6"
        );
        assert!(r["allowCredentials"][0].get("transports").is_none());
    }
}
