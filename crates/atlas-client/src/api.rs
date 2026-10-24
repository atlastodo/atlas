//! The HTTP API (`api.ts`, the parts an integration uses): API-token sessions, discovery, project
//! keys and `/sync/*`, encrypting op values on the way out and opening them on the way in.

use std::collections::BTreeMap;
use std::time::Duration;

use atlas_core::{Change, EntityKind, Operation};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::crypto::{
    is_encrypted_envelope, ApiTokenAppWraps, ApiTokenWrap, EncryptedPayload, FieldLocation,
    KeyScope, Keyring, WrappedProjectKey, DEK_KEY_ID, TODO_APP,
};
use crate::discovery::{parse_discovery, ServerDiscovery, LEGACY_DISCOVERY};
use crate::error::{Error, Result};
use crate::scope::{
    batch_links_of, expected_key_scope, key_for_scope, open_field_value, open_options_for,
    resolve_scope, shared_project_ids, Repair, RepairReason, Scope,
};
use crate::store::{op_entity_id, Store};
use crate::trust::{read_key_trust, KEY_TRUST_ID};

/// The sync protocol this client speaks (`SYNC_PROTOCOL`).
pub const SYNC_PROTOCOL: u32 = 7;

/// Names the apps a sync request works with (`x-atlas-sync-apps`); todo when absent.
pub const SYNC_APPS_HEADER: &str = "x-atlas-sync-apps";

/// Snapshot page size, in entities.
pub const SNAPSHOT_PAGE_KEYS: u32 = 500;

/// Short enough to beat the OS TCP timeout.
pub const DEFAULT_FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// One HTTP response.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after: Option<String>,
}

/// How requests reach the server: [`UreqTransport`] over the network, or a stand-in in tests.
pub trait Transport: Send + Sync {
    /// `Err` only when nothing came back (the network, a timeout).
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> std::result::Result<HttpResponse, String>;
}

/// Blocking HTTPS over rustls with the bundled web PKI roots.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new(timeout: Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .user_agent(concat!("atlas-client/", env!("CARGO_PKG_VERSION")))
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new(DEFAULT_FETCH_TIMEOUT)
    }
}

impl Transport for UreqTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> std::result::Result<HttpResponse, String> {
        let mut req = ureq::http::Request::builder().method(method).uri(url);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let result = match body {
            Some(b) => self.agent.run(req.body(b).map_err(|e| e.to_string())?),
            None => self.agent.run(req.body(()).map_err(|e| e.to_string())?),
        };
        let mut res = result.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = res
            .body_mut()
            .with_config()
            .limit(256 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok(HttpResponse {
            status,
            body,
            retry_after,
        })
    }
}

/// `POST /auth/api-token/session`.
#[derive(Debug, Clone, Deserialize)]
pub struct ApiTokenSession {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: u64,
    pub token_id: String,
    pub user_id: String,
    /// The apps the token is for; a server predating app-scoped tokens sends none (todo).
    #[serde(default = "default_token_apps")]
    pub apps: Vec<String>,
    /// The todo key, present exactly when the token is for todo.
    #[serde(default)]
    pub wrapped_dek: Option<ApiTokenWrap>,
    #[serde(default)]
    pub wrapped_private_key: Option<ApiTokenWrap>,
    /// Every other app's key and identity, by app id.
    #[serde(default)]
    pub app_keys: BTreeMap<String, ApiTokenAppWraps>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub signing_public_key: Option<String>,
    #[serde(default)]
    pub encrypted_signing_key: Option<EncryptedPayload>,
    /// When the token expires (unix ms); `None` when it never does, or on a server predating
    /// expiring tokens.
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// Whether the session may write; a server predating read-only tokens sends none (it may).
    #[serde(default = "default_token_write")]
    pub write: bool,
}

fn default_token_write() -> bool {
    true
}

fn default_token_apps() -> Vec<String> {
    vec![TODO_APP.to_owned()]
}

/// A row of `GET /project-keys`.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectKeyRow {
    pub project_id: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub kind: String,
    pub encrypted_pek: Value,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub signed_by: Option<String>,
    #[serde(default)]
    pub signer_public_key: Option<String>,
    #[serde(default)]
    pub signer_signing_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectKeysResponse {
    #[serde(default)]
    pub keys: Vec<ProjectKeyRow>,
    #[serde(default)]
    pub canonical: serde_json::Map<String, Value>,
    #[serde(default)]
    pub retired: Option<serde_json::Map<String, Value>>,
}

/// A pulled or snapshot page, opened.
#[derive(Debug, Clone)]
pub struct Page {
    pub operations: Vec<Operation>,
    pub cursor: u64,
    pub from: Option<u64>,
    pub next: Option<String>,
    pub repairs: Vec<Repair>,
    /// Values no key here opened and tombstones of entities not seen yet, for the store to keep.
    pub aside: crate::wire::Aside,
}

#[derive(Debug, Clone, Default)]
pub struct PushResult {
    pub cursor: u64,
    pub applied: u64,
    pub from: Option<u64>,
    /// Ops of a shared project whose key is not here: kept back, not pushed.
    pub deferred: Vec<uuid::Uuid>,
}

/// Re-opens a token session when the access token expired (no refresh token exists for one).
pub type Reauthenticate = Box<dyn Fn(&ApiClient) -> Result<String> + Send + Sync>;

pub struct ApiClient {
    base_url: String,
    token: std::sync::Mutex<Option<String>>,
    transport: Box<dyn Transport>,
    reauthenticate: Option<Reauthenticate>,
    legacy_done: bool,
    sync_apps: Option<String>,
}

/// Body-credential endpoints: a 401 there means a wrong credential.
const CREDENTIAL_PATHS: &[&str] = &[
    "/auth/login",
    "/auth/signup",
    "/auth/refresh",
    "/auth/logout",
    "/auth/recover",
    "/auth/recovery-keys",
    "/auth/salt",
    "/auth/account/cancel-deletion",
    "/auth/api-token/session",
];

fn parse_retry_after(value: Option<&str>) -> Option<u64> {
    let secs: f64 = value?.trim().parse().ok()?;
    secs.is_finite().then(|| (secs.max(0.0) * 1000.0) as u64)
}

impl ApiClient {
    pub fn new(base_url: &str, transport: Box<dyn Transport>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            token: std::sync::Mutex::new(None),
            transport,
            reauthenticate: None,
            legacy_done: false,
            sync_apps: None,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn set_token(&self, token: Option<String>) {
        *self.token.lock().expect("token lock") = token;
    }

    pub fn set_reauthenticate(&mut self, f: Reauthenticate) {
        self.reauthenticate = Some(f);
    }

    /// The apps every `/sync/*` request names in [`SYNC_APPS_HEADER`]; `None` sends no header,
    /// which the server reads as todo.
    pub fn set_sync_apps(&mut self, apps: Option<String>) {
        self.sync_apps = apps;
    }

    pub fn sync_apps(&self) -> Option<&str> {
        self.sync_apps.as_deref()
    }

    pub fn set_legacy_migrated(&mut self, done: bool) {
        self.legacy_done = done;
    }

    /// Whether the account's own old-format values were rewritten (locally recorded).
    pub fn is_legacy_migrated(&self, store: &Store) -> bool {
        self.legacy_done || read_key_trust(store).legacy_migrated
    }

    fn error_for(res: &HttpResponse) -> Error {
        let data: Option<Value> = serde_json::from_slice(&res.body).ok();
        if res.status == 426 {
            let min = data
                .as_ref()
                .and_then(|d| d.get("min_protocol"))
                .and_then(Value::as_u64);
            return Error::UpgradeRequired { min_protocol: min };
        }
        let message = data
            .as_ref()
            .and_then(|d| d.get("error"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| status_text(res.status).to_owned());
        Error::Api {
            status: res.status,
            message,
            data,
            retry_after_ms: parse_retry_after(res.retry_after.as_deref()),
        }
    }

    fn raw_request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut headers = vec![("x-atlas-sync-protocol", SYNC_PROTOCOL.to_string())];
        if let Some(apps) = &self.sync_apps {
            if path.starts_with("/sync/") {
                headers.push((SYNC_APPS_HEADER, apps.clone()));
            }
        }
        if let Some(token) = self.token.lock().expect("token lock").clone() {
            headers.push(("authorization", format!("Bearer {token}")));
        }
        let bytes = body.map(|b| {
            headers.push(("content-type", "application/json".into()));
            serde_json::to_vec(b).expect("JSON")
        });
        let url = format!("{}{}", self.base_url, path);
        let res = self
            .transport
            .send(method, &url, &headers, bytes)
            .map_err(Error::Network)?;
        if !(200..300).contains(&res.status) {
            return Err(Self::error_for(&res));
        }
        if res.status == 204 || res.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&res.body)
            .map_err(|e| Error::Protocol(format!("the server's answer is not JSON: {e}")))
    }

    /// A request; a 401 on a token session opens a new session once and retries.
    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        match self.raw_request(method, path, body) {
            Err(Error::Api { status: 401, .. })
                if self.reauthenticate.is_some()
                    && !CREDENTIAL_PATHS.contains(&path.split('?').next().unwrap_or(path)) =>
            {
                let token = (self.reauthenticate.as_ref().expect("checked"))(self)?;
                self.set_token(Some(token));
                self.raw_request(method, path, body)
            }
            other => other,
        }
    }

    fn typed<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T> {
        let v = self.request(method, path, body)?;
        serde_json::from_value(v).map_err(|e| Error::Protocol(format!("{method} {path}: {e}")))
    }

    /// `GET /discovery`; a server that predates it (404, or a non-JSON page) is legacy.
    pub fn get_discovery(&self) -> Result<ServerDiscovery> {
        match self.raw_request("GET", "/discovery", None) {
            Ok(body) => Ok(parse_discovery(&body)),
            Err(Error::Api { status: 404, .. }) | Err(Error::Protocol(_)) => {
                Ok(LEGACY_DISCOVERY.clone())
            }
            Err(e) => Err(e),
        }
    }

    pub fn open_api_token_session(&self, token_id: &str, auth: &str) -> Result<ApiTokenSession> {
        self.typed(
            "POST",
            "/auth/api-token/session",
            Some(&json!({ "token_id": token_id, "auth": auth })),
        )
    }

    pub fn list_project_keys(&self) -> Result<ProjectKeysResponse> {
        self.typed("GET", "/project-keys", None)
    }

    pub fn put_project_key(
        &self,
        project_id: &str,
        wrapped: &WrappedProjectKey,
        key_id: &str,
    ) -> Result<()> {
        self.request(
            "PUT",
            &format!("/projects/{project_id}/keys"),
            Some(&json!({ "encrypted_pek": wrapped, "key_id": key_id })),
        )?;
        Ok(())
    }

    /// Push `ops` in the protocol 7 wire form (`crate::wire`), each with the key of its scope. Ops of
    /// a shared project whose key is missing are all deferred.
    pub fn sync_push(
        &self,
        store: &Store,
        keyring: &Keyring,
        ops: &[Operation],
    ) -> Result<PushResult> {
        if !keyring.has_keys() {
            return Err(Error::E2eeLocked);
        }
        let batch = batch_links_of(ops);
        let shared = shared_project_ids(store);
        let mut deferred = Vec::new();
        let mut wire = Vec::new();
        for op in ops {
            let scope = resolve_scope(store, op.entity, &op_entity_id(op), Some(&batch));
            if let Scope::Project(p) = &scope {
                if shared.contains(p) && keyring.project_key_canonical(p).is_none() {
                    deferred.push(op.id);
                    continue;
                }
            }
            wire.push(crate::wire::encode_op(
                op,
                &key_for_scope(keyring, &scope, &shared)?,
            )?);
        }
        if wire.is_empty() {
            return Ok(PushResult {
                deferred,
                ..PushResult::default()
            });
        }
        let res = self.request("POST", "/sync/push", Some(&json!({ "operations": wire })))?;
        Ok(PushResult {
            cursor: res["cursor"].as_u64().unwrap_or(0),
            applied: res["applied"].as_u64().unwrap_or(0),
            from: res["from"].as_u64(),
            deferred,
        })
    }

    pub fn sync_pull(&self, store: &Store, keyring: &Keyring, since: u64) -> Result<Page> {
        if !keyring.has_keys() {
            return Err(Error::E2eeLocked);
        }
        let res = self.request("GET", &format!("/sync/pull?since={since}"), None)?;
        self.decode_wire_payload(store, keyring, &res)
    }

    /// `next` is the previous page's token, sent back verbatim.
    pub fn sync_snapshot(
        &self,
        store: &Store,
        keyring: &Keyring,
        next: Option<&str>,
    ) -> Result<Page> {
        if !keyring.has_keys() {
            return Err(Error::E2eeLocked);
        }
        let q = match next {
            None => format!("?limit={SNAPSHOT_PAGE_KEYS}"),
            Some(n) => format!(
                "?next={}&limit={SNAPSHOT_PAGE_KEYS}",
                encode_uri_component(n)
            ),
        };
        let res = self.request("GET", &format!("/sync/snapshot{q}"), None)?;
        let mut page = self.decode_wire_payload(store, keyring, &res)?;
        page.next = res.get("next").and_then(Value::as_str).map(str::to_owned);
        Ok(page)
    }

    /// The protocol 6 entities this partition still holds, a page at a time (`migrate_legacy`).
    pub fn legacy_keys(&self, next: Option<&str>) -> Result<crate::sync::LegacyKeysPage> {
        let q = next.map_or(String::new(), |n| {
            format!("?next={}", encode_uri_component(n))
        });
        let res = self.request("GET", &format!("/sync/legacy/keys{q}"), None)?;
        serde_json::from_value(res).map_err(|e| Error::Protocol(format!("legacy keys: {e}")))
    }

    /// Drop re-encoded protocol 6 entities from this partition; answers how many it still held.
    pub fn drop_legacy(&self, keys: &[(String, String)]) -> Result<u64> {
        let entities: Vec<Value> = keys
            .iter()
            .map(|(entity, id)| json!({ "entity": entity, "entity_id": id }))
            .collect();
        let res = self.request(
            "POST",
            "/sync/legacy/drop",
            Some(&json!({ "entities": entities })),
        )?;
        Ok(res["dropped"].as_u64().unwrap_or(0))
    }

    /// The one decode path for pull and snapshot pages (`decodeWirePayload`).
    pub fn decode_wire_payload(
        &self,
        store: &Store,
        keyring: &Keyring,
        payload: &Value,
    ) -> Result<Page> {
        let malformed = || Error::Protocol("malformed sync payload".into());
        let operations = payload
            .get("operations")
            .and_then(Value::as_array)
            .ok_or_else(malformed)?;
        let cursor = payload
            .get("cursor")
            .and_then(Value::as_u64)
            .ok_or_else(malformed)?;
        let from = payload.get("from").and_then(Value::as_u64);
        let legacy = !self.is_legacy_migrated(store);
        // Legacy rows (protocol 6) carry their links in plaintext, so their scopes resolve first.
        let legacy_ops: Vec<Operation> = operations
            .iter()
            .filter(|w| {
                w.get("entity")
                    .and_then(Value::as_str)
                    .is_some_and(crate::field_policy::is_legacy_wire_kind)
            })
            .filter_map(|w| serde_json::from_value::<Operation>(w.clone()).ok())
            .collect();
        let legacy_links = batch_links_of(&legacy_ops);
        let shared = shared_project_ids(store);
        let open_legacy = |mut op: Operation| -> Option<Operation> {
            let id = op_entity_id(&op);
            let Change::Set { field, value } = &mut op.change else {
                return Some(op);
            };
            let trust_state = op.entity == EntityKind::Preference && id == KEY_TRUST_ID;
            if !is_encrypted_envelope(value) {
                // Plaintext in an encrypted field: old-client content before the legacy migration;
                // after it, only a forgery.
                return (legacy && !trust_state).then_some(op);
            }
            let expected = expected_key_scope(
                keyring,
                &resolve_scope(store, op.entity, &id, Some(&legacy_links)),
                &shared,
            );
            let at = FieldLocation {
                entity: op.entity.as_str(),
                entity_id: &id,
                field,
            };
            // Kept as the envelope when no key opens it: a key that arrives later may.
            if let Some(opened) = open_field_value(
                keyring,
                value,
                at,
                expected.as_ref(),
                open_options_for(op.entity, &id, legacy),
            ) {
                *value = opened.value;
            }
            Some(op)
        };
        let (decoded, aside) = crate::wire::decode_ops(operations, keyring, store, open_legacy);
        // Current values opened with the keys of the scope they arrived in; their entities' scopes
        // are known now that their links are readable.
        let batch = batch_links_of(&decoded.iter().map(|d| d.op.clone()).collect::<Vec<_>>());
        let mut repairs = Vec::new();
        let mut out = Vec::with_capacity(decoded.len());
        for d in decoded {
            if let (false, Some((key_id, scope)), Change::Set { field, value }) =
                (d.legacy, &d.opened, &d.op.change)
            {
                let id = op_entity_id(&d.op);
                let expected = expected_key_scope(
                    keyring,
                    &resolve_scope(store, d.op.entity, &id, Some(&batch)),
                    &shared,
                );
                let canonical = match &expected {
                    Some(KeyScope::Personal) => key_id == DEK_KEY_ID,
                    Some(KeyScope::Project(p)) => {
                        keyring.canonical_key_id(p) == Some(key_id.as_str())
                    }
                    None => false,
                };
                if expected.as_ref() != Some(scope) || !canonical {
                    repairs.push(Repair {
                        entity: d.op.entity,
                        entity_id: id,
                        field: field.clone(),
                        ts: d.op.ts,
                        value: value.clone(),
                        reason: RepairReason::Key,
                        key_id: Some(key_id.clone()),
                        scope: Some(scope.clone()),
                        version: Some(3),
                    });
                }
            }
            out.push(d.op);
        }
        Ok(Page {
            operations: out,
            cursor,
            from,
            next: None,
            repairs,
            aside,
        })
    }
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}
