//! The `atlas` binary end to end against a real server on the Postgres in `TEST_DATABASE_URL`: an
//! account signs up with real keys, makes an API token as the app does, and the CLI reads and
//! writes its tasks over HTTP. A second token session checks that the server only ever held
//! ciphertext that the account's keys open. A journal-only token does the same with Atlas Journal
//! entries, and a token or server without the app is refused with a JSON error. Vault-only tokens
//! keep a CI secret: one with writes opted in stores it, the default read-only one reads it back
//! and is refused writes by the server as well as the client.

use std::net::SocketAddr;
use std::process::Command;

use atlas_client::api::{ApiClient, UreqTransport};
use atlas_client::client::{AtlasClient, TaskQuery};
use atlas_client::crypto::{
    decrypt_field, format_api_token, generate_api_token, random_bytes, wrap_app_keys_for_api_token,
    wrap_keys_for_api_token, x25519_public_key, FieldEnvelope, FieldLocation, KeyScope,
};
use atlas_client::session::ConnectOptions;
use atlas_server::{app, config::Config, db, state::AppState};
use serde_json::{json, Value};
use uuid::Uuid;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

/// Serve a fresh app on a free port from a background runtime; returns its base URL.
fn start_server() -> String {
    start_server_with(&["todo"])
}

/// [`start_server`] for an instance offering `apps` (`ATLAS_APPS`).
fn start_server_with(apps: &[&str]) -> String {
    let apps: Vec<String> = apps.iter().map(|a| a.to_string()).collect();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let config = Config {
                passkeys: None,
                android_asset_links: None,
                database_url: test_database_url(),
                jwt_secret: b"integration-test-secret-32-bytes-x".to_vec(),
                access_ttl_seconds: 900,
                refresh_ttl_seconds: 3600,
                port: 0,
                admin_emails: Vec::new(),
                signup_enabled: true,
                bug_reports_enabled: true,
                op_retention_days: 0,
                max_push_bytes: 2 * 1024 * 1024,
                refresh_token_retention_days: 30,
                attachments_enabled: false,
                blob_backend: atlas_server::config::BlobBackend::Fs,
                blob_dir: None,
                max_blob_bytes: 25 * 1024 * 1024,
                blob_quota_bytes: 1024 * 1024 * 1024,
                blob_gc_grace_days: 7,
                max_blob_transfers: 16,
                apps,
                static_dir: None,
            };
            let pool = db::connect(&test_database_url())
                .await
                .expect("connect to test db");
            db::migrate(&pool).await.expect("migrate test db");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            axum::serve(
                listener,
                app(AppState::new(pool, config))
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
    });
    format!("http://{}", rx.recv().unwrap())
}

fn wrapped() -> Value {
    json!({ "v": 1, "iv": hex::encode(random_bytes::<12>()), "ct": hex::encode(random_bytes::<48>()) })
}

/// Sign up an account and make an API token for it; returns the token string.
fn account_with_token(base: &str) -> String {
    let api = ApiClient::new(base, Box::new(UreqTransport::default()));
    let dek: [u8; 32] = random_bytes();
    let private_key: [u8; 32] = random_bytes();
    let signup = api
        .request(
            "POST",
            "/auth/signup",
            Some(&json!({
                "email": format!("cli-{}@example.com", Uuid::now_v7()),
                "password": hex::encode(random_bytes::<32>()),
                "salt": hex::encode(random_bytes::<16>()),
                "public_key": x25519_public_key(&private_key),
                "recovery_public_key": x25519_public_key(&random_bytes()),
                "encrypted_dek": wrapped(),
                "encrypted_private_key": wrapped(),
                "recovery_encrypted_dek": wrapped(),
                "recovery_encrypted_private_key": wrapped(),
            })),
        )
        .expect("signs up");
    let user_id = signup["user"]["id"].as_str().unwrap().to_owned();
    api.set_token(Some(signup["access_token"].as_str().unwrap().to_owned()));
    let token = generate_api_token();
    let wraps = wrap_keys_for_api_token(&token, &user_id, &dek, &private_key).unwrap();
    let auth = atlas_client::crypto::derive_api_token_keys(&token).auth;
    api.request(
        "POST",
        "/auth/api-tokens",
        Some(&json!({
            "id": token.id, "name": "cli e2e", "auth": auth,
            "wrapped_dek": wraps.wrapped_dek, "wrapped_private_key": wraps.wrapped_private_key,
        })),
    )
    .expect("creates a token");
    format_api_token(&token)
}

/// Run the built `atlas` binary; returns (exit code, stdout JSON or text, stderr).
fn atlas(base: &str, token: &str, args: &[&str]) -> (i32, Value, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_atlas"))
        .args(args)
        .env("ATLAS_URL", base)
        .env("ATLAS_TOKEN", token)
        .env("ATLAS_TZ", "Europe/Copenhagen")
        .env_remove("ATLAS_STATE_DIR")
        .output()
        .expect("runs atlas");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let json = serde_json::from_str(&stdout).unwrap_or(Value::String(stdout));
    (
        out.status.code().unwrap(),
        json,
        String::from_utf8(out.stderr).unwrap(),
    )
}

#[test]
fn the_cli_reads_and_writes_tasks_on_a_real_server() {
    let base = start_server();
    let token = account_with_token(&base);

    let (code, added, err) = atlas(
        &base,
        &token,
        &[
            "tasks",
            "add",
            "--title",
            "Renew passport",
            "--due",
            "2026-11-02",
            "--priority",
            "2",
        ],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(added["title"], "Renew passport");
    assert_eq!(added["priority"], 2);
    let id = added["id"].as_str().unwrap().to_owned();

    let (code, quick, err) = atlas(
        &base,
        &token,
        &["todo", "tasks", "quick", "Pay rent every month p1"],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(quick["title"], "Pay rent");
    assert!(quick["recurrence"]
        .as_str()
        .unwrap()
        .starts_with("FREQ=MONTHLY"));

    let (code, listed, _) = atlas(&base, &token, &["tasks", "list", "--filter", "p1 | p2"]);
    assert_eq!(code, 0);
    assert_eq!(listed.as_array().unwrap().len(), 2);

    let (code, done, err) = atlas(
        &base,
        &token,
        &["tasks", "complete", quick["id"].as_str().unwrap()],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(done["task"]["is_completed"], true);
    assert_eq!(
        done["next"]["title"], "Pay rent",
        "a recurring task spawns its next occurrence"
    );

    let (code, _, err) = atlas(
        &base,
        &token,
        &["tasks", "update", &id, "--notes", "bring photo"],
    );
    assert_eq!(code, 0, "{err}");
    let (code, cursor, _) = atlas(&base, &token, &["changes"]);
    assert_eq!(code, 0);
    assert!(cursor["cursor"].as_u64().unwrap() > 0);

    // Another session opens what the CLI wrote; the server held it encrypted.
    let mut opts = ConnectOptions::new(&base, &token);
    opts.time_zone = Some("UTC".into());
    let client = AtlasClient::connect(opts).expect("connects");
    let task = client.task(&id).unwrap();
    assert_eq!(task.task.notes, "bring photo");
    assert_eq!(client.tasks(&TaskQuery::default()).unwrap().len(), 2);
    let raw = client
        .session()
        .api
        .request("GET", "/sync/pull?since=0", None)
        .unwrap()
        .to_string();
    assert!(!raw.contains("Renew passport") && !raw.contains("bring photo"));

    // A state directory: the next run starts from the cache and still sees the account.
    let dir = std::env::temp_dir().join(format!("atlas-e2e-{}", Uuid::new_v4()));
    let run_cached = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_atlas"))
            .args(args)
            .env("ATLAS_URL", &base)
            .env("ATLAS_TOKEN", &token)
            .env("ATLAS_STATE_DIR", &dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    assert_eq!(run_cached(&["tasks", "list"]).as_array().unwrap().len(), 2);
    assert_eq!(run_cached(&["tasks", "list"]).as_array().unwrap().len(), 2);
    std::fs::remove_dir_all(&dir).unwrap();

    // A token that is not one, and an unknown one.
    let (code, _, err) = atlas(&base, "nope", &["tasks", "list"]);
    assert_eq!(code, 1);
    assert!(err.contains("invalid_token"), "{err}");
    let other = format_api_token(&generate_api_token());
    let (code, _, err) = atlas(&base, &other, &["tasks", "list"]);
    assert_eq!(code, 1);
    assert!(err.contains("\"status\":401"), "{err}");
}

/// Sign up a current account (a root key and the todo key under it), enable Atlas Journal as the
/// app does (its key under the root, then the app), and make a journal-only API token carrying the
/// journal key and identity. Returns the token string and the journal key.
fn account_with_journal_token(base: &str) -> (String, [u8; 32]) {
    let api = ApiClient::new(base, Box::new(UreqTransport::default()));
    let user_id = Uuid::new_v4().to_string();
    let signup = api
        .request(
            "POST",
            "/auth/signup",
            Some(&json!({
                "email": format!("cli-journal-{}@example.com", Uuid::now_v7()),
                "password": hex::encode(random_bytes::<32>()),
                "salt": hex::encode(random_bytes::<16>()),
                "public_key": x25519_public_key(&random_bytes()),
                "recovery_public_key": x25519_public_key(&random_bytes()),
                "encrypted_dek": wrapped(),
                "encrypted_private_key": wrapped(),
                "recovery_encrypted_dek": wrapped(),
                "recovery_encrypted_private_key": wrapped(),
                "user_id": user_id,
                "encrypted_root_key": wrapped(),
                "recovery_encrypted_root_key": wrapped(),
                "app_keys": [{ "app": "todo", "wrapped_key": wrapped(), "wrapped_private_key": wrapped() }],
            })),
        )
        .expect("signs up");
    api.set_token(Some(signup["access_token"].as_str().unwrap().to_owned()));
    api.request(
        "PUT",
        "/auth/app-keys/journal",
        Some(&json!({ "wrapped_key": wrapped(), "wrapped_private_key": wrapped() })),
    )
    .expect("stores the journal key");
    api.request("PUT", "/auth/apps/journal", None)
        .expect("enables journal");

    let journal_key: [u8; 32] = random_bytes();
    let journal_private: [u8; 32] = random_bytes();
    let token = generate_api_token();
    let wraps =
        wrap_app_keys_for_api_token(&token, &user_id, "journal", &journal_key, &journal_private)
            .unwrap();
    let auth = atlas_client::crypto::derive_api_token_keys(&token).auth;
    let made = api
        .request(
            "POST",
            "/auth/api-tokens",
            Some(&json!({
                "id": token.id, "name": "journal e2e", "auth": auth,
                "apps": ["journal"], "app_keys": { "journal": wraps },
            })),
        )
        .expect("creates a journal token");
    assert_eq!(made["apps"], json!(["journal"]));
    (format_api_token(&token), journal_key)
}

#[test]
fn the_cli_writes_journal_entries_with_a_journal_only_token() {
    let base = start_server_with(&["todo", "journal"]);
    let (token, journal_key) = account_with_journal_token(&base);

    let (code, added, err) = atlas(
        &base,
        &token,
        &[
            "journal",
            "entries",
            "add",
            "--date",
            "2026-10-17",
            "--title",
            "Harbour walk",
            "--body",
            "Fog over the water.",
            "--mood",
            "4",
            "--tag",
            "walks",
        ],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(added["title"], "Harbour walk");
    assert_eq!(added["mood"], 4);
    assert_eq!(added["tags"], json!(["walks"]));
    let id = added["id"].as_str().unwrap().to_owned();

    let (code, _, err) = atlas(
        &base,
        &token,
        &[
            "journal",
            "entries",
            "add",
            "--json",
            r#"{"date": "2026-10-16", "body": "From n8n", "tags": ["n8n"]}"#,
        ],
    );
    assert_eq!(code, 0, "{err}");
    let (code, listed, err) = atlas(&base, &token, &["journal", "entries", "list"]);
    assert_eq!(code, 0, "{err}");
    let dates: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["date"].as_str().unwrap())
        .collect();
    assert_eq!(dates, ["2026-10-17", "2026-10-16"]);

    let (code, updated, err) = atlas(
        &base,
        &token,
        &[
            "journal",
            "entries",
            "update",
            &id,
            "--body",
            "Fog, then sun.",
            "--mood",
            "none",
        ],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(updated["body"], "Fog, then sun.");
    assert!(updated["mood"].is_null());
    let (code, got, _) = atlas(&base, &token, &["journal", "entries", "get", &id]);
    assert_eq!(code, 0);
    assert_eq!(got["body"], "Fog, then sun.");
    let (code, _, err) = atlas(&base, &token, &["journal", "entries", "delete", &id]);
    assert_eq!(code, 0, "{err}");
    let (_, listed, _) = atlas(
        &base,
        &token,
        &["journal", "entries", "list", "--tag", "walks"],
    );
    assert_eq!(listed, json!([]));

    // Another session opens what the CLI wrote; the server held only ciphertext under the journal
    // key, as journal.entry ops.
    let mut opts = ConnectOptions::new(&base, &token);
    opts.app = "journal".into();
    let client = AtlasClient::connect(opts).expect("a journal session connects");
    assert_eq!(client.journal_entry(&id).unwrap().body, "Fog, then sun.");
    let pulled = client
        .session()
        .api
        .request("GET", "/sync/pull?since=0", None)
        .unwrap();
    let raw = pulled.to_string();
    assert!(!raw.contains("Harbour") && !raw.contains("Fog") && !raw.contains("walks"));
    let ops = pulled["operations"].as_array().unwrap();
    assert!(!ops.is_empty());
    for op in ops {
        assert_eq!(op["entity"], "journal.entry");
        let envelope = FieldEnvelope::from_value(&op["value"]).expect("encrypted");
        let at = FieldLocation {
            entity: "journal.entry",
            entity_id: op["entity_id"].as_str().unwrap(),
            field: op["field"].as_str().unwrap(),
        };
        assert!(decrypt_field(&journal_key, &KeyScope::Personal, at, &envelope).is_ok());
    }

    // The token carries no todo key: todo commands fail with a clear JSON error, before any sync.
    for args in [&["tasks", "list"][..], &["todo", "projects", "list"]] {
        let (code, _, err) = atlas(&base, &token, args);
        assert_eq!(code, 1, "{args:?}");
        let line: Value = serde_json::from_str(err.trim()).expect("a JSON error");
        assert_eq!(line["code"], "app_not_in_token", "{err}");
        assert!(
            line["error"].as_str().unwrap().contains("Atlas Todo"),
            "{err}"
        );
    }
}

#[test]
fn journal_commands_need_a_token_and_a_server_with_journal() {
    // A todo token on a server offering journal: refused with a JSON error naming the app.
    let base = start_server_with(&["todo", "journal"]);
    let token = account_with_token(&base);
    let (code, _, err) = atlas(&base, &token, &["journal", "entries", "list"]);
    assert_eq!(code, 1);
    let line: Value = serde_json::from_str(err.trim()).expect("a JSON error");
    assert_eq!(line["code"], "app_not_in_token", "{err}");
    assert!(
        line["error"].as_str().unwrap().contains("Atlas Journal"),
        "{err}"
    );

    // A server that does not offer journal.
    let todo_only = start_server_with(&["todo"]);
    let token = account_with_token(&todo_only);
    let (code, _, err) = atlas(&todo_only, &token, &["journal", "entries", "list"]);
    assert_eq!(code, 1);
    let line: Value = serde_json::from_str(err.trim()).expect("a JSON error");
    assert_eq!(line["code"], "server_incompatible", "{err}");
    assert!(line["error"].as_str().unwrap().contains("journal"), "{err}");
}

/// Sign up a current account and enable Atlas Vault as the app does; returns the signed-in API
/// client, the account id, and the vault key and identity.
fn account_with_vault(base: &str) -> (ApiClient, String, [u8; 32], [u8; 32]) {
    let api = ApiClient::new(base, Box::new(UreqTransport::default()));
    let user_id = Uuid::new_v4().to_string();
    let signup = api
        .request(
            "POST",
            "/auth/signup",
            Some(&json!({
                "email": format!("cli-vault-{}@example.com", Uuid::now_v7()),
                "password": hex::encode(random_bytes::<32>()),
                "salt": hex::encode(random_bytes::<16>()),
                "public_key": x25519_public_key(&random_bytes()),
                "recovery_public_key": x25519_public_key(&random_bytes()),
                "encrypted_dek": wrapped(),
                "encrypted_private_key": wrapped(),
                "recovery_encrypted_dek": wrapped(),
                "recovery_encrypted_private_key": wrapped(),
                "user_id": user_id,
                "encrypted_root_key": wrapped(),
                "recovery_encrypted_root_key": wrapped(),
                "app_keys": [{ "app": "todo", "wrapped_key": wrapped(), "wrapped_private_key": wrapped() }],
            })),
        )
        .expect("signs up");
    api.set_token(Some(signup["access_token"].as_str().unwrap().to_owned()));
    api.request(
        "PUT",
        "/auth/app-keys/vault",
        Some(&json!({ "wrapped_key": wrapped(), "wrapped_private_key": wrapped() })),
    )
    .expect("stores the vault key");
    api.request("PUT", "/auth/apps/vault", None)
        .expect("enables vault");
    (api, user_id, random_bytes(), random_bytes())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Make a vault-only API token carrying `key` and `private_key`, expiring in a day; `extra` adds
/// to the request (`write`). Returns the token string and its id.
fn vault_token(
    api: &ApiClient,
    user_id: &str,
    key: &[u8; 32],
    private_key: &[u8; 32],
    extra: Value,
) -> (String, String) {
    let token = generate_api_token();
    let wraps = wrap_app_keys_for_api_token(&token, user_id, "vault", key, private_key).unwrap();
    let auth = atlas_client::crypto::derive_api_token_keys(&token).auth;
    let mut body = json!({
        "id": token.id, "name": "ci", "auth": auth,
        "apps": ["vault"], "app_keys": { "vault": wraps },
        "expires_at": now_ms() + 86_400_000,
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    api.request("POST", "/auth/api-tokens", Some(&body))
        .expect("creates a vault token");
    (format_api_token(&token), token.id.clone())
}

/// [`atlas`] with `input` on standard input.
fn atlas_with_stdin(base: &str, token: &str, args: &[&str], input: &str) -> (i32, Value, String) {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_atlas"))
        .args(args)
        .env("ATLAS_URL", base)
        .env("ATLAS_TOKEN", token)
        .env_remove("ATLAS_STATE_DIR")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("runs atlas");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    let json = serde_json::from_str(&stdout).unwrap_or(Value::String(stdout));
    (
        out.status.code().unwrap(),
        json,
        String::from_utf8(out.stderr).unwrap(),
    )
}

fn error_code(err: &str) -> String {
    let line: Value = serde_json::from_str(err.trim()).expect("a JSON error");
    line["code"].as_str().unwrap_or("").to_owned()
}

#[test]
fn the_cli_keeps_vault_secrets_for_ci_with_scoped_tokens() {
    let base = start_server_with(&["todo", "vault"]);
    let (api, user_id, vault_key, vault_private) = account_with_vault(&base);

    // A token with writes opted in stores a secret, read from stdin so it never sits in argv.
    let (writer, _) = vault_token(
        &api,
        &user_id,
        &vault_key,
        &vault_private,
        json!({ "write": true }),
    );
    let (code, _, err) = atlas(&base, &writer, &["vault", "folders", "add", "CI"]);
    assert_eq!(code, 0, "{err}");
    let (code, added, err) = atlas_with_stdin(
        &base,
        &writer,
        &["vault", "add", "--json", "-"],
        r#"{"name": "Deploy key", "type": "api_key", "folder": "ci",
            "fields": [{"name": "token", "kind": "hidden", "value": "sk_live_e2e"}]}"#,
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(added["folder_name"], "CI");
    assert!(
        !added.to_string().contains("sk_live_e2e"),
        "a write does not echo the secret: {added}"
    );
    let id = added["id"].as_str().unwrap().to_owned();

    // The default vault token reads only: the secret, as plain text for scripts.
    let (reader, reader_id) = vault_token(&api, &user_id, &vault_key, &vault_private, json!({}));
    let (code, value, err) = atlas(
        &base,
        &reader,
        &["vault", "get", "deploy key", "--field", "token"],
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(value, Value::String("sk_live_e2e\n".into()));
    let (code, listed, err) = atlas(&base, &reader, &["vault", "list", "--folder", "CI"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains("sk_live_e2e"));
    let (code, _, err) = atlas(&base, &reader, &["vault", "delete", &id]);
    assert_eq!(code, 1);
    assert_eq!(error_code(&err), "api_token_read_only", "{err}");

    // The server refuses the read-only token's writes itself, whatever the client does.
    let mut opts = ConnectOptions::new(&base, &reader);
    opts.app = "vault".into();
    let client = AtlasClient::connect(opts).expect("a vault session connects");
    assert!(!client.session().can_write);
    let refused = client
        .session()
        .api
        .request("POST", "/sync/push", Some(&json!({ "operations": [] })))
        .unwrap_err();
    assert_eq!(refused.status(), Some(403));
    assert_eq!(refused.api_code(), Some("api_token_read_only"));

    // What the server holds is ciphertext under the vault key, as vault.* ops.
    let pulled = client
        .session()
        .api
        .request("GET", "/sync/pull?since=0", None)
        .unwrap();
    let raw = pulled.to_string();
    assert!(!raw.contains("sk_live_e2e") && !raw.contains("Deploy key"));
    for op in pulled["operations"].as_array().unwrap() {
        let entity = op["entity"].as_str().unwrap();
        assert!(entity.starts_with("vault."), "{entity}");
        let envelope = FieldEnvelope::from_value(&op["value"]).expect("encrypted");
        let at = FieldLocation {
            entity,
            entity_id: op["entity_id"].as_str().unwrap(),
            field: op["field"].as_str().unwrap(),
        };
        assert!(decrypt_field(&vault_key, &KeyScope::Personal, at, &envelope).is_ok());
    }

    // Revoked, the token opens nothing; a vault token without an expiry is never made.
    api.request("DELETE", &format!("/auth/api-tokens/{reader_id}"), None)
        .expect("revokes");
    let (code, _, err) = atlas(&base, &reader, &["vault", "list"]);
    assert_eq!(code, 1);
    assert_eq!(error_code(&err), "unauthorized", "{err}");
    let token = generate_api_token();
    let wraps =
        wrap_app_keys_for_api_token(&token, &user_id, "vault", &vault_key, &vault_private).unwrap();
    let refused = api
        .request(
            "POST",
            "/auth/api-tokens",
            Some(&json!({
                "id": token.id, "name": "forever", "apps": ["vault"],
                "auth": atlas_client::crypto::derive_api_token_keys(&token).auth,
                "app_keys": { "vault": wraps },
            })),
        )
        .unwrap_err();
    assert_eq!(refused.api_code(), Some("api_token_expiry_required"));
}
