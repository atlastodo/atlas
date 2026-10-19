//! `secretspec-provider-atlas` end to end: the binary is launched as SecretSpec launches it, over
//! the Secret Provider Protocol client of `secretspec-ipc` (the one SecretSpec itself uses),
//! against a real server on the Postgres in `TEST_DATABASE_URL` (or the server in
//! `ATLAS_E2E_SERVER`, e.g. a `cargo run -p atlas-server` with `ATLAS_APPS=todo,vault`).
//!
//! A read-only vault token reads secrets stored with the vault client and is refused every write;
//! a token with writes stores secrets where the mapping puts them; an expired, revoked or missing
//! token fails with `interaction_required`. The last test drives the real `secretspec` CLI when
//! `SECRETSPEC_BIN` names one (0.21+); it is ignored otherwise.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use atlas_client::api::{ApiClient, UreqTransport};
use atlas_client::client::AtlasClient;
use atlas_client::crypto::{
    format_api_token, generate_api_token, random_bytes, wrap_app_keys_for_api_token,
    x25519_public_key,
};
use atlas_client::session::ConnectOptions;
use atlas_server::{app, config::Config, db, state::AppState};
use secretspec_ipc::error::{ErrorKind, RpcError};
use secretspec_ipc::launch::{Environment, LaunchOptions};
use secretspec_ipc::lifecycle::{CredentialResponder, ProviderSession};
use secretspec_ipc::protocol::callback::{CredentialParams, CredentialResult};
use secretspec_ipc::protocol::provider::{
    Address, AddressParams, ApplicationContext, Coordinates, GetResult, InitializeApplication,
    SetParams,
};
use secretspec_ipc::{deadline_unix_ms_after, Limits, Product};
use serde_json::{json, Value};
use uuid::Uuid;

const BIN: &str = env!("CARGO_BIN_EXE_secretspec-provider-atlas");

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

/// The server in `ATLAS_E2E_SERVER`, or a fresh one offering todo and vault on a free port.
fn server() -> String {
    if let Ok(url) = std::env::var("ATLAS_E2E_SERVER") {
        if !url.is_empty() {
            return url.trim_end_matches('/').to_owned();
        }
    }
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
                apps: vec!["todo".into(), "vault".into()],
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

struct Account {
    api: ApiClient,
    user_id: String,
    key: [u8; 32],
    private_key: [u8; 32],
}

/// Sign up an account and enable Atlas Vault as the app does.
fn account(base: &str) -> Account {
    let api = ApiClient::new(base, Box::new(UreqTransport::default()));
    let user_id = Uuid::new_v4().to_string();
    let signup = api
        .request(
            "POST",
            "/auth/signup",
            Some(&json!({
                "email": format!("secretspec-{}@example.com", Uuid::now_v7()),
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
    Account {
        api,
        user_id,
        key: random_bytes(),
        private_key: random_bytes(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

impl Account {
    /// A vault-only token expiring in `lifetime_ms`; `extra` adds to the request (`write`).
    /// Returns the token and its id.
    fn token(&self, lifetime_ms: i64, extra: Value) -> (String, String) {
        let token = generate_api_token();
        let wraps = wrap_app_keys_for_api_token(
            &token,
            &self.user_id,
            "vault",
            &self.key,
            &self.private_key,
        )
        .unwrap();
        let auth = atlas_client::crypto::derive_api_token_keys(&token).auth;
        let mut body = json!({
            "id": token.id, "name": "secretspec", "auth": auth,
            "apps": ["vault"], "app_keys": { "vault": wraps },
            "expires_at": now_ms() + lifetime_ms,
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        self.api
            .request("POST", "/auth/api-tokens", Some(&body))
            .expect("creates a vault token");
        (format_api_token(&token), token.id.clone())
    }
}

fn vault_client(base: &str, token: &str) -> AtlasClient {
    let mut opts = ConnectOptions::new(base, token);
    opts.app = "vault".into();
    AtlasClient::connect(opts).expect("a vault session connects")
}

/// Answers the endpoint's `token` credential request, as SecretSpec's broker does.
struct Broker(String);

#[async_trait]
impl CredentialResponder for Broker {
    async fn credential(&self, params: CredentialParams) -> Result<CredentialResult, RpcError> {
        assert_eq!(params.name, "token");
        assert!(params.scope.starts_with("atlas://"), "{}", params.scope);
        Ok(CredentialResult::Found {
            value: self.0.clone(),
        })
    }
}

/// Launch the endpoint for `uri` as SecretSpec would: a replaced environment holding only what
/// its registration passes through.
async fn launch(
    env: &[(&str, &str)],
    uri: &str,
    broker: Option<Arc<dyn CredentialResponder>>,
) -> secretspec_ipc::Result<ProviderSession> {
    let environment: BTreeMap<OsString, OsString> = env
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
    ProviderSession::launch_with_credential_broker(
        LaunchOptions {
            executable: PathBuf::from(BIN),
            arguments: vec!["provider".into()],
            environment: Environment::Replace(environment),
            allow_path_discovery: false,
            max_stderr_bytes: 64 * 1024,
        },
        Product {
            name: "atlas-secretspec-e2e".into(),
            version: "1".into(),
        },
        Limits {
            max_frame_bytes: 1024 * 1024,
            max_in_flight: 8,
        },
        InitializeApplication {
            scheme: "atlas".into(),
            uri: uri.into(),
            context: ApplicationContext {
                project: Some("payments".into()),
                profile: Some("production".into()),
                base_dir: None,
                reason: None,
                requested_authorization_duration_ms: None,
            },
        },
        deadline_unix_ms_after(Duration::from_secs(10)),
        broker,
    )
    .await
}

fn deadline() -> u64 {
    deadline_unix_ms_after(Duration::from_secs(30))
}

fn convention(project: &str, profile: &str, key: &str) -> AddressParams {
    AddressParams {
        address: Address::Convention {
            project: project.into(),
            profile: profile.into(),
            key: key.into(),
        },
    }
}

fn native(item: &str, field: &str, vault: Option<&str>) -> AddressParams {
    AddressParams {
        address: Address::Native {
            coordinates: Coordinates {
                item: item.into(),
                field: Some(field.into()),
                vault: vault.map(Into::into),
                section: None,
                version: None,
            },
        },
    }
}

fn found(result: GetResult) -> Option<String> {
    match result {
        GetResult::Found { value, .. } => Some(value),
        GetResult::Missing => None,
    }
}

fn kind<T: std::fmt::Debug>(result: secretspec_ipc::Result<T>) -> ErrorKind {
    match result {
        Err(e) => e.rpc_kind().unwrap_or(ErrorKind::Unrecognized),
        Ok(v) => panic!("expected an error, got {v:?}"),
    }
}

/// Store the secrets a team keeps with `atlas vault add`: an item per profile in a folder per
/// project, and a deploy key outside any folder.
fn seed(base: &str, writer: &str) {
    let mut client = vault_client(base, writer);
    client.create_vault_folder("payments").unwrap();
    client
        .create_vault_item(&json!({
            "name": "production", "type": "api_key", "folder": "payments",
            "fields": [
                { "name": "DATABASE_URL", "kind": "hidden", "value": "postgres://prod" },
                { "name": "REGION", "kind": "text", "value": "eu-north-1" },
            ],
        }))
        .unwrap();
    client
        .create_vault_item(&json!({
            "name": "Deploy key", "type": "api_key",
            "fields": [{ "name": "token", "kind": "hidden", "value": "sk_live_e2e" }],
        }))
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_only_token_resolves_secrets_and_is_refused_writes() {
    let base = server();
    let account = account(&base);
    let (writer, _) = account.token(86_400_000, json!({ "write": true }));
    let (reader, _) = account.token(86_400_000, json!({}));
    let seeded = base.clone();
    tokio::task::spawn_blocking(move || seed(&seeded, &writer))
        .await
        .unwrap();

    let session = launch(
        &[("ATLAS_URL", &base), ("ATLAS_TOKEN", &reader)],
        "atlas://",
        None,
    )
    .await
    .expect("the endpoint initializes");
    assert_eq!(session.metadata().name, "atlas");
    assert!(
        session
            .metadata()
            .display_uri
            .starts_with("atlas://127.0.0.1:")
            || std::env::var("ATLAS_E2E_SERVER").is_ok()
    );
    assert!(!session.metadata().display_uri.contains("atlas_pat_"));

    // The convention address: folder = project, item = profile, field = key.
    let resolved = session
        .resolve_address(
            &convention("payments", "production", "DATABASE_URL"),
            deadline(),
        )
        .await
        .unwrap();
    assert_eq!(resolved.coordinates.vault.as_deref(), Some("payments"));
    assert_eq!(resolved.coordinates.item, "production");
    assert_eq!(resolved.coordinates.field.as_deref(), Some("DATABASE_URL"));
    let get = |p: AddressParams| {
        let session = &session;
        async move { session.get(&p, deadline()).await.map(found) }
    };
    assert_eq!(
        get(convention("payments", "production", "DATABASE_URL"))
            .await
            .unwrap()
            .as_deref(),
        Some("postgres://prod")
    );
    // Names match case-insensitively, as in the CLI.
    assert_eq!(
        get(convention("Payments", "PRODUCTION", "region"))
            .await
            .unwrap()
            .as_deref(),
        Some("eu-north-1")
    );
    // A native ref names an item anywhere in the vault, or in a folder.
    assert_eq!(
        get(native("deploy key", "token", None))
            .await
            .unwrap()
            .as_deref(),
        Some("sk_live_e2e")
    );
    assert_eq!(
        get(native("production", "DATABASE_URL", Some("payments")))
            .await
            .unwrap()
            .as_deref(),
        Some("postgres://prod")
    );
    // A folder, item or field that is not there is a miss, not an error.
    for missing in [
        convention("payments", "production", "STRIPE_KEY"),
        convention("payments", "staging", "DATABASE_URL"),
        convention("billing", "production", "DATABASE_URL"),
        native("Deploy key", "token", Some("payments")),
        native("nope", "token", None),
    ] {
        assert_eq!(get(missing).await.unwrap(), None);
    }
    let exists = session
        .exists(
            &convention("payments", "production", "DATABASE_URL"),
            deadline(),
        )
        .await
        .unwrap();
    assert!(exists.exists);

    // Read-only: the preflight, the write and the delete are refused.
    let address = convention("payments", "production", "DATABASE_URL");
    assert_eq!(
        kind(session.check_writable(&address, deadline()).await),
        ErrorKind::PermissionDenied
    );
    let set = SetParams {
        address: address.address.clone(),
        value: "postgres://hijacked".into(),
    };
    assert_eq!(
        kind(session.set(&set, deadline()).await),
        ErrorKind::PermissionDenied
    );
    assert_eq!(
        kind(session.delete(&address, deadline()).await),
        ErrorKind::PermissionDenied
    );
    assert_eq!(
        get(convention("payments", "production", "DATABASE_URL"))
            .await
            .unwrap()
            .as_deref(),
        Some("postgres://prod")
    );
    // A native ref without a field is refused before any lookup.
    let fieldless = AddressParams {
        address: Address::Native {
            coordinates: Coordinates {
                item: "Deploy key".into(),
                field: None,
                vault: None,
                section: None,
                version: None,
            },
        },
    };
    assert_eq!(
        kind(session.get(&fieldless, deadline()).await),
        ErrorKind::InvalidParams
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_with_writes_stores_secrets_where_the_mapping_puts_them() {
    let base = server();
    let account = account(&base);
    let (writer, _) = account.token(86_400_000, json!({ "write": true }));

    // No ATLAS_TOKEN: the endpoint asks SecretSpec's broker for its credential `token`.
    let host = base.trim_start_matches("http://");
    let session = launch(
        &[],
        &format!("atlas://{host}"),
        Some(Arc::new(Broker(writer.clone()))),
    )
    .await
    .expect("the endpoint initializes");
    let address = convention("web", "staging", "API_KEY");
    session.check_writable(&address, deadline()).await.unwrap();
    let described = session
        .describe_write_target(&address, deadline())
        .await
        .unwrap();
    assert_eq!(
        described.description,
        "Atlas Vault folder \"web\", item \"staging\", field \"API_KEY\""
    );
    let set = |address: &AddressParams, value: &str| SetParams {
        address: address.address.clone(),
        value: value.into(),
    };
    session
        .set(&set(&address, "key-1"), deadline())
        .await
        .unwrap();
    session
        .set(
            &set(&convention("web", "staging", "SECRET"), "s-1"),
            deadline(),
        )
        .await
        .unwrap();
    session
        .set(&set(&address, "key-2"), deadline())
        .await
        .unwrap();
    let read = session.get(&address, deadline()).await.unwrap();
    assert_eq!(found(read).as_deref(), Some("key-2"));

    // In the vault: one folder, one item tagged secretspec with two hidden fields, and the
    // replaced value in its history.
    let check = base.clone();
    let token = writer.clone();
    tokio::task::spawn_blocking(move || {
        let client = vault_client(&check, &token);
        let folders = client.vault_folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "web");
        let item = client.vault_item("staging").unwrap();
        assert_eq!(item.folder_name.as_deref(), Some("web"));
        let item = item.item;
        assert_eq!(item.kind, "api_key");
        assert_eq!(item.tags, ["secretspec"]);
        let fields: Vec<_> = item
            .fields
            .iter()
            .map(|f| (f.name.as_str(), f.kind.as_str(), f.value.as_str()))
            .collect();
        assert_eq!(
            fields,
            [("API_KEY", "hidden", "key-2"), ("SECRET", "hidden", "s-1")]
        );
        assert_eq!(item.history.len(), 1);
        assert_eq!(item.history[0].value, "key-1");
    })
    .await
    .unwrap();

    // Delete removes the field and is idempotent.
    let deleted = session.delete(&address, deadline()).await.unwrap();
    assert!(deleted.deleted);
    let deleted = session.delete(&address, deadline()).await.unwrap();
    assert!(!deleted.deleted);
    assert_eq!(
        found(session.get(&address, deadline()).await.unwrap()),
        None
    );

    // Two items of one name in a folder are a conflict, not a guess.
    let dup = base.clone();
    tokio::task::spawn_blocking(move || {
        let mut client = vault_client(&dup, &writer);
        client
            .create_vault_item(&json!({ "name": "staging", "folder": "web" }))
            .unwrap();
    })
    .await
    .unwrap();
    let fresh = launch(
        &[],
        &format!("atlas://{host}"),
        Some(Arc::new(Broker(session_token(&account)))),
    )
    .await
    .unwrap();
    assert_eq!(
        kind(
            fresh
                .get(&convention("web", "staging", "SECRET"), deadline())
                .await
        ),
        ErrorKind::Conflict
    );
}

/// Another read-only token of the account.
fn session_token(account: &Account) -> String {
    account.token(86_400_000, json!({})).0
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_revoked_or_missing_token_needs_a_person() {
    let base = server();
    let account = account(&base);
    let (expiring, _) = account.token(1_500, json!({}));
    let (revoked, revoked_id) = account.token(86_400_000, json!({}));
    account
        .api
        .request("DELETE", &format!("/auth/api-tokens/{revoked_id}"), None)
        .expect("revokes");
    tokio::time::sleep(Duration::from_millis(2_000)).await;

    let address = convention("payments", "production", "DATABASE_URL");
    for token in [expiring.as_str(), revoked.as_str(), "not-a-token"] {
        let session = launch(
            &[("ATLAS_URL", &base), ("ATLAS_TOKEN", token)],
            "atlas://",
            None,
        )
        .await
        .expect("initializes; signing in waits for the first operation");
        assert_eq!(
            kind(session.get(&address, deadline()).await),
            ErrorKind::InteractionRequired
        );
        // The failure is kept: the second request does not sign in again.
        assert_eq!(
            kind(session.exists(&address, deadline()).await),
            ErrorKind::InteractionRequired
        );
    }
    // `status` says why in words.
    let status = std::process::Command::new(BIN)
        .arg("status")
        .env("ATLAS_URL", &base)
        .env("ATLAS_TOKEN", &expiring)
        .output()
        .unwrap();
    assert!(!status.status.success());
    let err = String::from_utf8_lossy(&status.stderr);
    assert!(
        err.contains("has expired") && err.contains("(api_token_expired)"),
        "{err}"
    );
    let live = account.token(86_400_000, json!({})).0;
    let status = std::process::Command::new(BIN)
        .arg("status")
        .env("ATLAS_URL", &base)
        .env("ATLAS_TOKEN", &live)
        .output()
        .unwrap();
    let out = String::from_utf8_lossy(&status.stdout);
    assert!(status.status.success(), "{status:?}");
    assert!(out.contains("access: read-only"), "{out}");
    assert!(out.contains("expires: 20"), "{out}");

    let session = launch(&[("ATLAS_URL", &base)], "atlas://", None)
        .await
        .unwrap();
    assert_eq!(
        kind(session.get(&address, deadline()).await),
        ErrorKind::InteractionRequired
    );

    // A URI with a credential or without a server is refused at initialization.
    for uri in ["atlas://user:secret@example.com", "atlas://"] {
        assert!(launch(&[], uri, None).await.is_err(), "{uri}");
    }
}

/// Write `contents` to `dir/name` and return the path.
fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

/// The real `secretspec` CLI (`SECRETSPEC_BIN`, 0.21+) with the endpoint registered in a fresh
/// config directory: `check` and `get` resolve vault secrets with a read-only token, `set` with
/// it fails, and an expired token fails.
#[test]
#[ignore = "needs SECRETSPEC_BIN, a secretspec 0.21+ binary"]
fn the_secretspec_cli_resolves_vault_secrets() {
    let secretspec = std::env::var("SECRETSPEC_BIN").expect("SECRETSPEC_BIN");
    let base = server();
    let account = account(&base);
    let (writer, _) = account.token(86_400_000, json!({ "write": true }));
    let (reader, _) = account.token(86_400_000, json!({}));
    let (expiring, _) = account.token(1_500, json!({}));
    // The secrets come from the `atlas` CLI next to this binary (`cargo build -p atlas-cli`).
    let atlas = Path::new(BIN).with_file_name("atlas");
    assert!(
        atlas.exists(),
        "build the atlas CLI first: cargo build -p atlas-cli"
    );
    let atlas_cli = |args: &[&str], stdin: &str| {
        use std::io::Write;
        let mut child = std::process::Command::new(&atlas)
            .args(args)
            .env("ATLAS_URL", &base)
            .env("ATLAS_TOKEN", &writer)
            .env_remove("ATLAS_STATE_DIR")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "atlas {args:?}: {out:?}");
    };
    atlas_cli(&["vault", "folders", "add", "payments"], "");
    atlas_cli(
        &["vault", "add", "--json", "-"],
        r#"{"name": "production", "type": "api_key", "folder": "payments", "fields": [
            {"name": "DATABASE_URL", "kind": "hidden", "value": "postgres://prod"},
            {"name": "REGION", "kind": "text", "value": "eu-north-1"}]}"#,
    );
    atlas_cli(
        &["vault", "add", "--json", "-"],
        r#"{"name": "Deploy key", "type": "api_key",
            "fields": [{"name": "token", "kind": "hidden", "value": "sk_live_e2e"}]}"#,
    );

    let root = std::env::temp_dir().join(format!("atlas-secretspec-{}", Uuid::now_v7()));
    let config = root.join("config");
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let registered = std::process::Command::new(BIN)
        .arg("register")
        .env("XDG_CONFIG_HOME", &config)
        .output()
        .unwrap();
    assert!(registered.status.success(), "{registered:?}");
    write(
        &project,
        "secretspec.toml",
        r#"[project]
name = "payments"
revision = "1.0"

[providers]
atlas_vault = "atlas://"

[defaults]
providers = ["atlas_vault"]

[profiles.default]
DATABASE_URL = { description = "The database", required = true }
REGION = { description = "Where it runs", required = true }
DEPLOY_TOKEN = { description = "The deploy key", required = true, ref = { item = "Deploy key", field = "token" } }

[profiles.production]
DATABASE_URL = { required = true }
"#,
    );
    let run = |token: &str, args: &[&str], stdin: Option<&str>| {
        use std::io::Write;
        let mut child = std::process::Command::new(&secretspec)
            .args(args)
            .current_dir(&project)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", &config)
            .env("ATLAS_URL", &base)
            .env("ATLAS_TOKEN", token)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        if let Some(text) = stdin {
            input.write_all(text.as_bytes()).unwrap();
        }
        drop(input);
        let out = child.wait_with_output().unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    };
    let with = |args: &[&str]| -> Vec<String> {
        args.iter()
            .chain(["--profile", "production"].iter())
            .map(|s| s.to_string())
            .collect()
    };
    let run = |token: &str, args: Vec<String>, stdin: Option<&str>| {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        run(token, &args, stdin)
    };
    // The project's default provider chain names the alias for `atlas://`.
    let (ok, out, err) = run(&reader, with(&["check"]), None);
    eprintln!("check: {out}{err}");
    assert!(ok, "check: {out}{err}");
    let (ok, out, err) = run(&reader, with(&["get", "DATABASE_URL"]), None);
    assert!(ok, "get: {out}{err}");
    assert_eq!(out.trim(), "postgres://prod");
    // A `ref`, and the provider URI given on the command line.
    let (ok, out, err) = run(
        &reader,
        with(&["get", "DEPLOY_TOKEN", "--provider", "atlas://"]),
        None,
    );
    assert!(ok, "get ref: {out}{err}");
    assert_eq!(out.trim(), "sk_live_e2e");

    // A read-only token is refused before the value is read.
    let (ok, out, err) = run(&reader, with(&["set", "REGION"]), Some("us-east-1\n"));
    eprintln!("read-only set: {out}{err}");
    assert!(!ok, "a read-only token cannot set: {out}{err}");
    assert!(err.contains("permission denied"), "{err}");
    let (ok, out, err) = run(&writer, with(&["set", "REGION", "us-east-1"]), None);
    eprintln!("set: {out}{err}");
    assert!(ok, "a token with writes sets: {out}{err}");
    let client = vault_client(&base, &reader);
    assert_eq!(
        client.vault_secret("production", "REGION").unwrap(),
        "us-east-1"
    );

    std::thread::sleep(Duration::from_millis(2_000));
    let (ok, out, err) = run(&expiring, with(&["check"]), None);
    eprintln!("expired: {out}{err}");
    assert!(!ok, "an expired token fails: {out}{err}");
    assert!(err.contains("interaction required"), "{err}");
    let _ = std::fs::remove_dir_all(&root);
}
