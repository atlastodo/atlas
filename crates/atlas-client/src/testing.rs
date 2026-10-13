//! A stand-in for the server's sync surface, like `FakeServer` in `packages/sdk/src/testing.ts`:
//! one account's op log, kept as the opaque wire ops the clients push (ciphertext).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::api::{HttpResponse, Transport};
use crate::crypto::{
    derive_api_token_keys, format_api_token, generate_api_token, random_bytes,
    wrap_keys_for_api_token, x25519_public_key, ApiTokenParts,
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
}

#[derive(Clone)]
pub struct FakeServer {
    pub token: Arc<ApiTokenParts>,
    pub dek: [u8; 32],
    pub private_key: [u8; 32],
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

impl FakeServer {
    pub fn new() -> Self {
        Self {
            token: Arc::new(generate_api_token()),
            dek: random_bytes(),
            private_key: random_bytes(),
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

    fn handle(
        &self,
        method: &str,
        url: &str,
        auth: Option<&str>,
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
            let wraps = wrap_keys_for_api_token(&self.token, USER_ID, &self.dek, &self.private_key)
                .expect("wraps");
            return json_res(
                200,
                json!({
                    "access_token": format!("access-{}", st.sessions),
                    "expires_in": 900,
                    "token_id": self.token.id,
                    "user_id": USER_ID,
                    "wrapped_dek": wraps.wrapped_dek,
                    "wrapped_private_key": wraps.wrapped_private_key,
                    "public_key": self.public_key(),
                }),
            );
        }
        let bearer = auth.and_then(|a| a.strip_prefix("Bearer "));
        if st.revoked || bearer.is_none() || st.expired.iter().any(|e| Some(e.as_str()) == bearer) {
            return json_res(401, json!({"error": "unauthorized"}));
        }
        match (method, path) {
            ("GET", "/sync/snapshot") => {
                let ops: Vec<Value> = st.ops.iter().map(|(_, o)| o.clone()).collect();
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
                let ops: Vec<Value> = page.iter().map(|(_, o)| o.clone()).collect();
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
        let auth = headers
            .iter()
            .find(|(k, _)| *k == "authorization")
            .map(|(_, v)| v.as_str());
        let body = body.map(|b| serde_json::from_slice(&b).expect("JSON body"));
        Ok(self.handle(method, url, auth, body))
    }
}
