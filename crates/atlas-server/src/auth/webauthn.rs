//! The WebAuthn relying party, over `webauthn-rs`: the ceremony options a client hands to
//! `navigator.credentials` (or Android's Credential Manager), the server-side state each ceremony
//! keeps until it is answered, and the verification of the answers.
//!
//! `webauthn-rs` verifies (challenge, origin, RP ID hash, user presence and verification,
//! signature, counter); this module adapts it to what passkeys here need:
//! - Registration asks for a discoverable credential (`residentKey: "required"`), which
//!   `start_passkey_registration` leaves to the authenticator, so the options are adjusted before
//!   they are sent; the stored state does not depend on it.
//! - Every ceremony requests the PRF extension, which `webauthn-rs` does not model: it is added to
//!   the options JSON. It runs between client and authenticator; the server never receives the
//!   output ([`prf_report`] refuses a response that carries it).
//! - A modal discoverable sign-in uses `start_discoverable_authentication` without the conditional
//!   mediation it sets.
//! - Ceremony state and credentials are stored as JSON (`danger-allow-state-serialisation`); the
//!   state lives in `webauthn_challenges` until its single use.
//!
//! Attestation is not requested (`"none"`). Data in and out is WebAuthn Level 3 JSON: binary
//! fields are base64url.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
use webauthn_rs::prelude::{
    CredentialID, DiscoverableAuthentication, DiscoverableKey, Passkey, PasskeyAuthentication,
    PasskeyRegistration, PublicKeyCredential, RegisterPublicKeyCredential, Url, Webauthn,
    WebauthnBuilder,
};

/// Upper bound on a credential id (the spec caps it at 1023 bytes).
pub const MAX_CREDENTIAL_ID_LEN: usize = 1023;
/// Upper bound on any one base64url field of a response; real ones are a few hundred bytes.
const MAX_FIELD_LEN: usize = 16 * 1024;
/// How long a client gets to finish a ceremony; the server-side challenge lives a little longer.
pub const CEREMONY_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// Why a ceremony could not start or a response was refused.
#[derive(Debug, thiserror::Error)]
pub enum PasskeyError {
    #[error("malformed {0}")]
    Malformed(&'static str),
    #[error("the relying party is misconfigured")]
    Configuration,
    #[error("{0}")]
    Webauthn(#[from] webauthn_rs::prelude::WebauthnError),
}

type Result<T> = std::result::Result<T, PasskeyError>;

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

/// The challenge a response answers (unpadded base64url), read from its `clientDataJSON` without
/// checking anything else: the caller looks the ceremony up by it, then verifies against it.
pub fn response_challenge(client_data_json_b64: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct ClientData {
        challenge: String,
    }
    let raw =
        b64url_decode(client_data_json_b64).ok_or(PasskeyError::Malformed("clientDataJSON"))?;
    let cd: ClientData =
        serde_json::from_slice(&raw).map_err(|_| PasskeyError::Malformed("clientDataJSON"))?;
    let bytes = b64url_decode(&cd.challenge).ok_or(PasskeyError::Malformed("challenge"))?;
    Ok(b64url(&bytes))
}

/// A `RegistrationResponseJSON` as the client sent it; [`RelyingParty::verify_registration`]
/// parses it fully.
#[derive(Debug, Clone, Deserialize)]
#[serde(transparent)]
pub struct RegistrationResponse(pub Value);

/// An `AuthenticationResponseJSON` as the client sent it; [`RelyingParty::verify_assertion`]
/// parses it fully.
#[derive(Debug, Clone, Deserialize)]
#[serde(transparent)]
pub struct AssertionResponse(pub Value);

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |v, k| v.get(*k))?.as_str()
}

impl RegistrationResponse {
    pub fn client_data_json(&self) -> &str {
        str_at(&self.0, &["response", "clientDataJSON"]).unwrap_or_default()
    }
    pub fn client_extension_results(&self) -> &Value {
        self.0.get("clientExtensionResults").unwrap_or(&Value::Null)
    }
    pub fn transports(&self) -> Vec<String> {
        self.0["response"]["transports"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl AssertionResponse {
    pub fn client_data_json(&self) -> &str {
        str_at(&self.0, &["response", "clientDataJSON"]).unwrap_or_default()
    }
    pub fn raw_id(&self) -> &str {
        str_at(&self.0, &["rawId"]).unwrap_or_default()
    }
    pub fn user_handle(&self) -> Option<&str> {
        str_at(&self.0, &["response", "userHandle"])
    }
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
    /// The `webauthn-rs` passkey (public key, counter, flags), as stored.
    pub passkey: Value,
    pub sign_count: u32,
    pub backup_eligible: bool,
    pub backed_up: bool,
}

/// A verified assertion: the counter and backup state it reported, and the stored passkey brought
/// up to date with them.
#[derive(Debug, Clone)]
pub struct AssertionOutcome {
    pub sign_count: u32,
    pub backed_up: bool,
    pub passkey: Value,
}

/// The server-side state of a ceremony, as `webauthn_challenges.state` holds it.
#[derive(Debug, serde::Serialize, Deserialize)]
#[serde(tag = "kind", content = "state", rename_all = "snake_case")]
enum Ceremony {
    Registration(PasskeyRegistration),
    Authentication(PasskeyAuthentication),
    Discoverable(DiscoverableAuthentication),
}

/// The relying party: its id (a domain) and `webauthn-rs` configured with its exact origins.
#[derive(Debug, Clone)]
pub struct RelyingParty {
    pub id: String,
    webauthn: Webauthn,
}

/// Drop `null` members: the options go to Android's Credential Manager as JSON, which expects
/// absent rather than null optional members.
fn without_nulls(v: Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, without_nulls(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_nulls).collect()),
        other => other,
    }
}

fn passkey_fields(passkey: &Passkey) -> Result<(Value, u32, bool, bool)> {
    let value = serde_json::to_value(passkey).map_err(|_| PasskeyError::Malformed("passkey"))?;
    let cred = &value["cred"];
    let counter = cred["counter"].as_u64().unwrap_or(0) as u32;
    let eligible = cred["backup_eligible"].as_bool().unwrap_or(false);
    let state = cred["backup_state"].as_bool().unwrap_or(false);
    Ok((value, counter, eligible, state))
}

fn parse_passkey(v: &Value) -> Result<Passkey> {
    serde_json::from_value(v.clone()).map_err(|_| PasskeyError::Malformed("stored passkey"))
}

fn state_json(c: &Ceremony) -> Result<Value> {
    serde_json::to_value(c).map_err(|_| PasskeyError::Malformed("ceremony state"))
}

impl RelyingParty {
    /// `origins` are exact (`https://host[:port]`, or `android:apk-key-hash:…`). `webauthn-rs`
    /// needs one origin on the RP ID's domain to anchor the configuration: the first https one,
    /// else `https://<rp id>`.
    pub fn new(id: &str, name: &str, origins: &[String]) -> Result<Self> {
        let parsed: Vec<Url> = origins
            .iter()
            .map(|o| Url::parse(o).map_err(|_| PasskeyError::Configuration))
            .collect::<Result<_>>()?;
        let anchor = match parsed
            .iter()
            .position(|u| u.scheme() == "https" || u.scheme() == "http")
        {
            Some(i) => parsed[i].clone(),
            None => {
                Url::parse(&format!("https://{id}")).map_err(|_| PasskeyError::Configuration)?
            }
        };
        let mut builder = WebauthnBuilder::new(id, &anchor)
            .map_err(|_| PasskeyError::Configuration)?
            .rp_name(name)
            .timeout(std::time::Duration::from_millis(CEREMONY_TIMEOUT_MS));
        for origin in parsed.iter().filter(|u| **u != anchor) {
            builder = builder.append_allowed_origin(origin);
        }
        Ok(Self {
            id: id.to_owned(),
            webauthn: builder.build()?,
        })
    }

    /// `PublicKeyCredentialCreationOptionsJSON` for a discoverable, user-verified passkey with the
    /// PRF extension (`prf_input` is its `eval.first`), and the ceremony's state. The user handle is
    /// the account id.
    pub fn creation_options(
        &self,
        user_id: Uuid,
        user_name: &str,
        user_display_name: &str,
        exclude: &[String],
        prf_input: &str,
    ) -> Result<(Value, Value)> {
        let exclude: Vec<CredentialID> = exclude
            .iter()
            .filter_map(|id| b64url_decode(id))
            .map(CredentialID::from)
            .collect();
        let display = if user_display_name.is_empty() {
            user_name
        } else {
            user_display_name
        };
        let (ccr, state) = self.webauthn.start_passkey_registration(
            user_id,
            user_name,
            display,
            (!exclude.is_empty()).then_some(exclude),
        )?;
        let mut options = serde_json::to_value(&ccr)
            .map_err(|_| PasskeyError::Malformed("options"))?
            .get("publicKey")
            .cloned()
            .ok_or(PasskeyError::Malformed("options"))?;
        options["authenticatorSelection"] = json!({
            "residentKey": "required",
            "requireResidentKey": true,
            "userVerification": "required",
        });
        options["extensions"]["prf"] = json!({ "eval": { "first": prf_input } });
        Ok((
            without_nulls(options),
            state_json(&Ceremony::Registration(state))?,
        ))
    }

    /// Verify a registration response against its ceremony's state.
    pub fn verify_registration(
        &self,
        response: &RegistrationResponse,
        state: &Value,
    ) -> Result<NewCredential> {
        let Ok(Ceremony::Registration(state)) = serde_json::from_value(state.clone()) else {
            return Err(PasskeyError::Malformed("ceremony state"));
        };
        let reg: RegisterPublicKeyCredential = serde_json::from_value(response.0.clone())
            .map_err(|_| PasskeyError::Malformed("registration response"))?;
        let passkey = self.webauthn.finish_passkey_registration(&reg, &state)?;
        let credential_id = b64url(passkey.cred_id().as_ref());
        let (passkey, sign_count, backup_eligible, backed_up) = passkey_fields(&passkey)?;
        Ok(NewCredential {
            credential_id,
            passkey,
            sign_count,
            backup_eligible,
            backed_up,
        })
    }

    fn with_prf(
        rcr: &impl serde::Serialize,
        prf_input: &str,
        prf_by_credential: &[(String, String)],
    ) -> Result<Value> {
        let mut options = serde_json::to_value(rcr)
            .map_err(|_| PasskeyError::Malformed("options"))?
            .get("publicKey")
            .cloned()
            .ok_or(PasskeyError::Malformed("options"))?;
        let mut prf = json!({ "eval": { "first": prf_input } });
        if !prf_by_credential.is_empty() {
            let by: serde_json::Map<String, Value> = prf_by_credential
                .iter()
                .map(|(id, input)| (id.clone(), json!({ "first": input })))
                .collect();
            prf["evalByCredential"] = Value::Object(by);
        }
        // Only PRF: the `uvm` webauthn-rs asks for is of no use here.
        options["extensions"] = json!({ "prf": prf });
        options["userVerification"] = json!("required");
        Ok(without_nulls(options))
    }

    /// `PublicKeyCredentialRequestOptionsJSON` for a discoverable sign-in (the authenticator
    /// offers its passkeys for this RP), and the ceremony's state.
    pub fn discoverable_options(&self, prf_input: &str) -> Result<(Value, Value)> {
        let (rcr, state) = self.webauthn.start_discoverable_authentication()?;
        let mut options = Self::with_prf(&rcr, prf_input, &[])?;
        if let Some(o) = options.as_object_mut() {
            o.insert("allowCredentials".into(), json!([]));
        }
        Ok((options, state_json(&Ceremony::Discoverable(state))?))
    }

    /// `PublicKeyCredentialRequestOptionsJSON` naming `passkeys` (stored JSON), each with its own
    /// PRF input, and the ceremony's state.
    pub fn request_options(
        &self,
        passkeys: &[Value],
        prf_input: &str,
        prf_by_credential: &[(String, String)],
    ) -> Result<(Value, Value)> {
        let creds: Vec<Passkey> = passkeys.iter().map(parse_passkey).collect::<Result<_>>()?;
        let (rcr, state) = self.webauthn.start_passkey_authentication(&creds)?;
        let options = Self::with_prf(&rcr, prf_input, prf_by_credential)?;
        Ok((options, state_json(&Ceremony::Authentication(state))?))
    }

    /// Verify an assertion against its ceremony's state and the stored passkey it names.
    pub fn verify_assertion(
        &self,
        response: &AssertionResponse,
        state: &Value,
        passkey: &Value,
    ) -> Result<AssertionOutcome> {
        let cred: PublicKeyCredential = serde_json::from_value(response.0.clone())
            .map_err(|_| PasskeyError::Malformed("assertion response"))?;
        let mut stored = parse_passkey(passkey)?;
        let result = match serde_json::from_value(state.clone()) {
            Ok(Ceremony::Authentication(state)) => {
                self.webauthn.finish_passkey_authentication(&cred, &state)?
            }
            Ok(Ceremony::Discoverable(state)) => self.webauthn.finish_discoverable_authentication(
                &cred,
                state,
                &[DiscoverableKey::from(&stored)],
            )?,
            _ => return Err(PasskeyError::Malformed("ceremony state")),
        };
        stored.update_credential(&result);
        let (passkey, ..) = passkey_fields(&stored)?;
        Ok(AssertionOutcome {
            sign_count: result.counter(),
            backed_up: result.backup_state(),
            passkey,
        })
    }
}

/// A software authenticator for tests: builds registration and assertion responses the way a
/// browser and platform authenticator would, signing with a P-256 key, for `webauthn-rs` to verify.
#[cfg(feature = "test-authenticator")]
pub mod soft {
    use super::*;
    use ciborium::Value as Cbor;
    use p256::ecdsa::signature::Signer;
    use sha2::{Digest, Sha256};

    const FLAG_UP: u8 = 0x01;
    const FLAG_UV: u8 = 0x04;
    const FLAG_AT: u8 = 0x40;
    const ALG_ES256: i64 = -7;

    pub struct SoftAuthenticator {
        pub key: p256::ecdsa::SigningKey,
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
                key: p256::ecdsa::SigningKey::from_bytes(&bytes.into()).unwrap(),
                credential_id: vec![seed; 16],
                sign_count: 0,
                user_handle: user_handle.to_vec(),
                flags: FLAG_UP | FLAG_UV,
            }
        }

        /// Remove user verification from every response (a UP-only authenticator).
        pub fn without_user_verification(mut self) -> Self {
            self.flags = FLAG_UP;
            self
        }

        pub fn credential_id_b64(&self) -> String {
            b64url(&self.credential_id)
        }

        fn cose_key(&self) -> Vec<u8> {
            let point = self.key.verifying_key().to_sec1_point(false);
            let map = Cbor::Map(vec![
                (Cbor::from(1), Cbor::from(2)),
                (Cbor::from(3), Cbor::from(ALG_ES256)),
                (Cbor::from(-1), Cbor::from(1)),
                (Cbor::from(-2), Cbor::Bytes(point.x().unwrap().to_vec())),
                (Cbor::from(-3), Cbor::Bytes(point.y().unwrap().to_vec())),
            ]);
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
            let sig: p256::ecdsa::Signature = self.key.sign(&signed);
            let id = self.credential_id_b64();
            json!({
                "id": id,
                "rawId": id,
                "type": "public-key",
                "response": {
                    "clientDataJSON": b64url(&client_data),
                    "authenticatorData": b64url(&auth_data),
                    "signature": b64url(sig.to_der().as_bytes()),
                    "userHandle": b64url(&self.user_handle),
                },
                "authenticatorAttachment": "platform",
                "clientExtensionResults": {},
            })
        }
    }
}

#[cfg(all(test, feature = "test-authenticator"))]
mod tests {
    use super::soft::SoftAuthenticator;
    use super::*;

    const ORIGIN: &str = "https://todo.example.com";

    fn rp() -> RelyingParty {
        RelyingParty::new(
            "todo.example.com",
            "Atlas",
            &[ORIGIN.into(), "android:apk-key-hash:abc".into()],
        )
        .unwrap()
    }

    fn user() -> Uuid {
        Uuid::from_bytes([7; 16])
    }

    fn register(auth: &SoftAuthenticator, origin: &str) -> Result<NewCredential> {
        let (options, state) = rp()
            .creation_options(user(), "a@example.com", "", &[], "cHJm")
            .unwrap();
        let reg = RegistrationResponse(auth.register(&options, origin, true));
        assert_eq!(
            response_challenge(reg.client_data_json()).unwrap(),
            options["challenge"].as_str().unwrap()
        );
        rp().verify_registration(&reg, &state)
    }

    #[test]
    fn registers_and_asserts_and_refuses_a_replayed_counter() {
        let mut auth = SoftAuthenticator::p256(3, user().as_bytes());
        let cred = register(&auth, ORIGIN).unwrap();
        assert_eq!(cred.credential_id, auth.credential_id_b64());

        // Discoverable, then naming the credential.
        let (options, state) = rp().discoverable_options("cHJm").unwrap();
        assert!(options.get("mediation").is_none());
        let a = AssertionResponse(auth.assert(&options, "todo.example.com", ORIGIN, true));
        let out = rp().verify_assertion(&a, &state, &cred.passkey).unwrap();
        assert_eq!(out.sign_count, 1);

        let (options, state) = rp()
            .request_options(std::slice::from_ref(&out.passkey), "cHJm", &[])
            .unwrap();
        let a = AssertionResponse(auth.assert(&options, "todo.example.com", ORIGIN, true));
        let next = rp().verify_assertion(&a, &state, &out.passkey).unwrap();
        assert_eq!(next.sign_count, 2);

        // The same counter again is a clone or a replay.
        auth.sign_count = 1;
        let (options, state) = rp()
            .request_options(std::slice::from_ref(&next.passkey), "cHJm", &[])
            .unwrap();
        let a = AssertionResponse(auth.assert(&options, "todo.example.com", ORIGIN, true));
        assert!(rp().verify_assertion(&a, &state, &next.passkey).is_err());
    }

    #[test]
    fn refuses_wrong_origin_rp_signature_and_missing_user_verification() {
        let mut auth = SoftAuthenticator::p256(6, user().as_bytes());
        assert!(register(&auth, "https://evil.example").is_err());
        assert!(register(&auth, "android:apk-key-hash:abc").is_ok());
        let cred = register(&auth, ORIGIN).unwrap();

        let (options, state) = rp().discoverable_options("cHJm").unwrap();
        let other_rp = AssertionResponse(auth.assert(&options, "evil.example", ORIGIN, true));
        assert!(rp()
            .verify_assertion(&other_rp, &state, &cred.passkey)
            .is_err());

        let mut forger = SoftAuthenticator::p256(9, user().as_bytes());
        forger.credential_id = auth.credential_id.clone();
        forger.sign_count = 10;
        let (options, state) = rp().discoverable_options("cHJm").unwrap();
        let forged = AssertionResponse(forger.assert(&options, "todo.example.com", ORIGIN, true));
        assert!(rp()
            .verify_assertion(&forged, &state, &cred.passkey)
            .is_err());

        let up_only = SoftAuthenticator::p256(7, user().as_bytes()).without_user_verification();
        assert!(register(&up_only, ORIGIN).is_err());
    }

    #[test]
    fn options_carry_prf_and_require_discoverable_user_verified_passkeys() {
        let (c, _) = rp()
            .creation_options(user(), "a@example.com", "Ann", &["aWQ".into()], "cHJm")
            .unwrap();
        assert_eq!(c["authenticatorSelection"]["userVerification"], "required");
        assert_eq!(c["authenticatorSelection"]["residentKey"], "required");
        assert_eq!(c["extensions"]["prf"]["eval"]["first"], "cHJm");
        assert_eq!(c["excludeCredentials"][0]["id"], "aWQ");
        assert_eq!(c["user"]["id"], b64url(user().as_bytes()));
        assert_eq!(c["rp"]["id"], "todo.example.com");
        fn no_nulls(v: &Value) -> bool {
            match v {
                Value::Null => false,
                Value::Object(m) => m.values().all(no_nulls),
                Value::Array(a) => a.iter().all(no_nulls),
                _ => true,
            }
        }
        assert!(no_nulls(&c));

        let auth = SoftAuthenticator::p256(4, user().as_bytes());
        let cred = register(&auth, ORIGIN).unwrap();
        let (r, _) = rp()
            .request_options(
                &[cred.passkey],
                "cHJm",
                &[(cred.credential_id.clone(), "eHl6".into())],
            )
            .unwrap();
        assert_eq!(r["rpId"], "todo.example.com");
        assert_eq!(r["userVerification"], "required");
        assert_eq!(r["allowCredentials"][0]["id"], cred.credential_id);
        assert_eq!(
            r["extensions"]["prf"]["evalByCredential"][&cred.credential_id]["first"],
            "eHl6"
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
}
