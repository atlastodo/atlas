//! A stand-in for the server's sync surface, like `FakeServer` in `packages/sdk/src/testing.ts`:
//! one account's op log, kept as the opaque wire ops the clients push (ciphertext).
//!
//! The token is for todo unless made with [`FakeServer::with_apps`]. Sync requests are scoped as
//! the server scopes a token session (`x-atlas-sync-apps`, todo when absent): naming an app the
//! token is not for is 403 `app_not_enabled` with scope `token`, pull and the snapshot serve only
//! the scope's ops, and a push of an op outside it is 403 with scope `session`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use atlas_core::Registry;
use serde_json::{json, Map, Value};

use crate::api::{HttpResponse, Transport, SYNC_APPS_HEADER};
use crate::crypto::{
    derive_api_token_keys, format_api_token, generate_api_token, random_bytes,
    wrap_app_keys_for_api_token, wrap_keys_for_api_token, x25519_public_key, ApiTokenParts,
    TODO_APP,
};

pub const USER_ID: &str = "01920000-0000-7000-8000-0000000000aa";

pub struct FakeState {
    /// Wire ops with their sequence numbers.
    pub ops: Vec<(u64, Value)>,
    pub seq: u64,
    pub sessions: u32,
    pub revoked: bool,
    /// Access tokens that answer 401 (expired).
    pub expired: Vec<String>,
    /// `GET /project-keys`.
    pub project_keys: Value,
    /// Bodies of `PUT /projects/:id/keys`.
    pub stored_keys: Vec<(String, Value)>,
    /// `GET /discovery`; `None` answers 404.
    pub discovery: Option<Value>,
    /// Every request, as `METHOD /path`.
    pub log: Vec<String>,
    /// The `x-atlas-sync-apps` header of every `/sync/*` request (`None` when absent).
    pub sync_apps: Vec<Option<String>>,
}

#[derive(Clone)]
pub struct FakeServer {
    pub token: Arc<ApiTokenParts>,
    pub dek: [u8; 32],
    pub private_key: [u8; 32],
    /// The apps the token is for.
    pub apps: Vec<String>,
    /// Every other app's key and X25519 private key, by app.
    pub app_keys: BTreeMap<String, ([u8; 32], [u8; 32])>,
    pub state: Arc<Mutex<FakeState>>,
}

impl Default for FakeServer {
    fn default() -> Self {
        Self::new()
    }
}

fn json_res(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        body: serde_json::to_vec(&body).expect("JSON"),
        retry_after: None,
    }
}

/// The app of a wire op's entity kind, if a bundled manifest lists it.
fn app_of_op(op: &Value) -> Option<&'static str> {
    let kind = op.get("entity")?.as_str()?;
    Registry::bundled().app_of(kind).map(|m| m.app.as_str())
}

fn refused(app: &str, scope: &str) -> HttpResponse {
    json_res(
        403,
        json!({
            "error": format!("{app} is not enabled for this {scope}"),
            "code": "app_not_enabled",
            "app": app,
            "scope": scope,
        }),
    )
}

impl FakeServer {
    /// A todo token.
    pub fn new() -> Self {
        Self::with_apps(&[TODO_APP])
    }

    /// A token for `apps`, carrying a fresh key and identity for each app other than todo.
    pub fn with_apps(apps: &[&str]) -> Self {
        Self {
            token: Arc::new(generate_api_token()),
            dek: random_bytes(),
            private_key: random_bytes(),
            apps: apps.iter().map(|a| a.to_string()).collect(),
            app_keys: apps
                .iter()
                .filter(|a| **a != TODO_APP)
                .map(|a| (a.to_string(), (random_bytes(), random_bytes())))
                .collect(),
            state: Arc::new(Mutex::new(FakeState {
                ops: Vec::new(),
                seq: 0,
                sessions: 0,
                revoked: false,
                expired: Vec::new(),
                project_keys: json!({"keys": [], "canonical": {}}),
                stored_keys: Vec::new(),
                discovery: None,
                log: Vec::new(),
                sync_apps: Vec::new(),
            })),
        }
    }

    pub fn token_string(&self) -> String {
        format_api_token(&self.token)
    }

    pub fn public_key(&self) -> String {
        x25519_public_key(&self.private_key)
    }

    pub fn transport(&self) -> Box<dyn Transport> {
        Box::new(self.clone())
    }

    /// `POST /auth/api-token/session`: the todo wraps exactly when the token is for todo, every
    /// other app's in `app_keys`.
    fn session_body(&self, sessions: u32) -> Value {
        let mut body = json!({
            "access_token": format!("access-{sessions}"),
            "expires_in": 900,
            "token_id": self.token.id,
            "user_id": USER_ID,
            "apps": self.apps,
            "public_key": self.public_key(),
        });
        if self.apps.iter().any(|a| a == TODO_APP) {
            let wraps = wrap_keys_for_api_token(&self.token, USER_ID, &self.dek, &self.private_key)
                .expect("wraps");
            body["wrapped_dek"] = json!(wraps.wrapped_dek);
            body["wrapped_private_key"] = json!(wraps.wrapped_private_key);
        }
        if !self.app_keys.is_empty() {
            let mut entries = Map::new();
            for (app, (key, private_key)) in &self.app_keys {
                let wraps =
                    wrap_app_keys_for_api_token(&self.token, USER_ID, app, key, private_key)
                        .expect("wraps");
                entries.insert(app.clone(), json!(wraps));
            }
            body["app_keys"] = Value::Object(entries);
        }
        body
    }

    fn handle(
        &self,
        method: &str,
        url: &str,
        auth: Option<&str>,
        sync_apps: Option<&str>,
        body: Option<Value>,
    ) -> HttpResponse {
        let mut st = self.state.lock().expect("fake server");
        let (path, query) = match url
            .split_once("://")
            .map(|(_, r)| r)
            .and_then(|r| r.find('/').map(|i| &r[i..]))
        {
            Some(p) => p.split_once('?').unwrap_or((p, "")),
            None => (url, ""),
        };
        st.log.push(format!("{method} {path}"));
        let param = |name: &str| {
            query
                .split('&')
                .filter_map(|kv| kv.split_once('='))
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_owned())
        };
        if method == "GET" && path == "/discovery" {
            return match &st.discovery {
                Some(d) => json_res(200, d.clone()),
                None => json_res(404, json!({"error": "not found"})),
            };
        }
        if method == "POST" && path == "/auth/api-token/session" {
            let body = body.unwrap_or_default();
            if st.revoked
                || body["token_id"] != json!(self.token.id)
                || body["auth"] != json!(derive_api_token_keys(&self.token).auth)
            {
                return json_res(401, json!({"error": "unauthorized"}));
            }
            st.sessions += 1;
            return json_res(200, self.session_body(st.sessions));
        }
        let bearer = auth.and_then(|a| a.strip_prefix("Bearer "));
        if st.revoked || bearer.is_none() || st.expired.iter().any(|e| Some(e.as_str()) == bearer) {
            return json_res(401, json!({"error": "unauthorized"}));
        }
        // The session's scope, resolved as the server resolves it for a token session.
        let scope: Vec<String> = match sync_apps {
            Some(h) => h.split(',').map(|a| a.trim().to_owned()).collect(),
            None => vec![TODO_APP.to_owned()],
        };
        if path.starts_with("/sync/") {
            st.sync_apps.push(sync_apps.map(str::to_owned));
            if let Some(app) = scope.iter().find(|a| !self.apps.contains(a)) {
                return refused(app, "token");
            }
        }
        let in_scope = |op: &Value| app_of_op(op).is_some_and(|a| scope.iter().any(|s| s == a));
        match (method, path) {
            ("GET", "/sync/snapshot") => {
                let ops: Vec<Value> = st
                    .ops
                    .iter()
                    .map(|(_, o)| o)
                    .filter(|o| in_scope(o))
                    .cloned()
                    .collect();
                json_res(200, json!({"operations": ops, "cursor": st.seq}))
            }
            ("GET", "/sync/pull") => {
                let since: u64 = param("since").and_then(|s| s.parse().ok()).unwrap_or(0);
                let page: Vec<&(u64, Value)> = st
                    .ops
                    .iter()
                    .filter(|(s, _)| *s > since)
                    .take(500)
                    .collect();
                let cursor = page.last().map(|(s, _)| *s).unwrap_or(since.max(st.seq));
                let ops: Vec<Value> = page
                    .iter()
                    .map(|(_, o)| o)
                    .filter(|o| in_scope(o))
                    .cloned()
                    .collect();
                json_res(
                    200,
                    json!({"operations": ops, "from": since, "cursor": cursor}),
                )
            }
            ("POST", "/sync/push") => {
                let from = st.seq;
                let ops = body.unwrap_or_default()["operations"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                if let Some(op) = ops.iter().find(|o| !in_scope(o)) {
                    return refused(app_of_op(op).unwrap_or("unknown"), "session");
                }
                let applied = ops.len();
                for op in ops {
                    if st.ops.iter().any(|(_, o)| o["id"] == op["id"]) {
                        continue;
                    }
                    st.seq += 1;
                    let seq = st.seq;
                    st.ops.push((seq, op));
                }
                json_res(
                    200,
                    json!({"applied": applied, "from": from, "cursor": st.seq}),
                )
            }
            ("GET", "/project-keys") => json_res(200, st.project_keys.clone()),
            ("PUT", p) if p.starts_with("/projects/") && p.ends_with("/keys") => {
                let id = p
                    .trim_start_matches("/projects/")
                    .trim_end_matches("/keys")
                    .to_owned();
                st.stored_keys.push((id, body.unwrap_or_default()));
                HttpResponse {
                    status: 204,
                    body: Vec::new(),
                    retry_after: None,
                }
            }
            _ => json_res(404, json!({"error": format!("not found: {method} {path}")})),
        }
    }
}

impl Transport for FakeServer {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<HttpResponse, String> {
        let header = |name: &str| {
            headers
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.as_str())
        };
        let body = body.map(|b| serde_json::from_slice(&b).expect("JSON body"));
        Ok(self.handle(
            method,
            url,
            header("authorization"),
            header(SYNC_APPS_HEADER),
            body,
        ))
    }
}
