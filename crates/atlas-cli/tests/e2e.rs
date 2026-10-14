//! The `atlas` binary end to end against a real server on the Postgres in `TEST_DATABASE_URL`: an
//! account signs up with real keys, makes an API token as the app does, and the CLI reads and
//! writes its tasks over HTTP. A second token session checks that the server only ever held
//! ciphertext that the account's keys open.

use std::net::SocketAddr;
use std::process::Command;

use atlas_client::api::{ApiClient, UreqTransport};
use atlas_client::client::{AtlasClient, TaskQuery};
use atlas_client::crypto::{
    format_api_token, generate_api_token, random_bytes, wrap_keys_for_api_token, x25519_public_key,
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
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let config = Config {
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
                apps: vec!["todo".into()],
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
