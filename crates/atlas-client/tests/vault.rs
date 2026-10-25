//! Atlas Vault sessions against the fake server: a vault-only token (its key in `app_keys`, no
//! todo key) writing items and folders only that key opens, secrets read back by name, and the
//! token policies: a read-only token refused writes before anything is pushed, and an expired one
//! refused with its typed error.

use atlas_client::client::AtlasClient;
use atlas_client::crypto::{FieldEnvelope, Keyring};
use atlas_client::session::ConnectOptions;
use atlas_client::testing::{current_discovery, FakeServer};
use atlas_client::vault::VaultQuery;
use atlas_client::wire::open_sealed;
use atlas_client::Error;
use serde_json::json;

const NOW: i64 = 1_792_279_800_000;

fn server(token_apps: &[&str]) -> FakeServer {
    let server = FakeServer::with_apps(token_apps);
    server.state.lock().unwrap().discovery = Some(current_discovery(&["todo", "vault"]));
    server
}

fn connect(server: &FakeServer, app: &str) -> Result<AtlasClient, Error> {
    let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    opts.app = app.into();
    let mut client = AtlasClient::connect(opts)?;
    client.set_now(Box::new(|| NOW));
    Ok(client)
}

fn code(err: &Error) -> String {
    match err {
        Error::Atlas { code, .. } => code.clone(),
        Error::Api { .. } => err.api_code().unwrap_or("").to_owned(),
        other => panic!("not a coded error: {other:?}"),
    }
}

#[test]
fn a_vault_token_writes_items_only_its_key_opens() {
    let server = server(&["vault"]);
    let mut vault = connect(&server, "vault").expect("a vault-only token connects");
    assert!(vault.session().can_write);

    let folder = vault.create_vault_folder(" CI ").unwrap();
    assert_eq!(folder.name, "CI");
    assert_eq!(
        code(&vault.create_vault_folder("ci").unwrap_err()),
        "vault_folder_exists"
    );
    let item = vault
        .create_vault_item(&json!({
            "type": "api_key",
            "name": "Deploy key",
            "folder": "ci",
            "fields": [
                { "name": "token", "kind": "hidden", "value": "sk_live_secret" },
                { "name": "account", "value": "ops" },
            ],
            "urls": ["https://deploy.example"],
            "tags": ["prod"],
        }))
        .unwrap();
    assert_eq!(item.item.folder.as_deref(), Some(folder.id.as_str()));
    assert_eq!(item.folder_name.as_deref(), Some("CI"));
    assert_eq!((item.item.created_at, item.item.updated_at), (NOW, NOW));

    // The server holds only ciphertext, each value a personal-scope envelope under the vault key.
    let st = server.state.lock().unwrap();
    assert!(st.sync_apps.iter().all(|a| a.as_deref() == Some("vault")));
    let raw = serde_json::to_string(&st.ops).unwrap();
    // Long enough, or holding `_`, not to turn up in base64 ciphertext by chance.
    for plain in ["sk_live_secret", "Deploy key", "api_key", "deploy.example"] {
        assert!(!raw.contains(plain), "{plain} leaked");
    }
    let (vault_key, _) = server.app_keys["vault"];
    for (_, op) in &st.ops {
        assert_eq!(op["entity"], "vault.sealed");
        assert!(op["scope"].is_null());
        let envelope = FieldEnvelope::from_value_v3(&op["value"]).expect("an envelope");
        let open = |key: [u8; 32]| {
            open_sealed(
                &Keyring::new(key, [0; 32], None),
                "vault.sealed",
                op["entity_id"].as_str().unwrap(),
                op["field"].as_str().unwrap(),
                None,
                &envelope,
            )
        };
        let kind = open(vault_key).expect("the vault key opens it").kind;
        assert!(
            matches!(kind.as_str(), "vault.item" | "vault.folder"),
            "{kind:?}"
        );
        assert!(open(server.dek).is_none());
    }
    drop(st);

    // Another session reads it by name, one secret at a time, and lists it without secrets.
    let mut other = connect(&server, "vault").unwrap();
    assert_eq!(other.vault_item("deploy KEY").unwrap(), item);
    assert_eq!(
        other.vault_secret("Deploy key", "TOKEN").unwrap(),
        "sk_live_secret"
    );
    assert_eq!(
        code(&other.vault_secret("Deploy key", "password").unwrap_err()),
        "unknown_vault_field"
    );
    let listed = other.vault_items(&VaultQuery::default()).unwrap();
    assert_eq!(listed.len(), 1);
    let printed = serde_json::to_string(&listed).unwrap();
    assert!(!printed.contains("sk_live_secret"), "{printed}");
    let found = |q: VaultQuery| other.vault_items(&q).unwrap().len();
    assert_eq!(
        found(VaultQuery {
            folder: Some("CI".into()),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        found(VaultQuery {
            kind: Some("login".into()),
            ..Default::default()
        }),
        0
    );
    assert_eq!(
        found(VaultQuery {
            search: Some("deploy.EXAMPLE".into()),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        code(
            &other
                .vault_items(&VaultQuery {
                    folder: Some("nope".into()),
                    ..Default::default()
                })
                .unwrap_err()
        ),
        "unknown_vault_folder"
    );

    // A rotated secret keeps its old value in the history.
    let rotated = other
        .update_vault_item(
            "Deploy key",
            &json!({ "set_fields": [{ "name": "token", "value": "sk_live_new" }] }),
        )
        .unwrap();
    assert_eq!(rotated.item.history.len(), 1);
    assert_eq!(rotated.item.history[0].value, "sk_live_secret");
    assert_eq!(
        other.vault_secret(&item.item.id, "token").unwrap(),
        "sk_live_new"
    );

    other.delete_vault_item("Deploy key").unwrap();
    assert!(other
        .vault_items(&VaultQuery::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        other.vault_item(&item.item.id).unwrap().item.deleted_at,
        Some(NOW)
    );
    assert_eq!(
        code(&other.vault_item("Deploy key").unwrap_err()),
        "unknown_vault_item"
    );
}

#[test]
fn a_read_only_token_reads_and_refuses_writes_before_pushing() {
    let server = server(&["vault"]);
    let mut writer = connect(&server, "vault").unwrap();
    writer
        .create_vault_item(&json!({
            "name": "DB",
            "fields": [{ "name": "password", "kind": "hidden", "value": "pw" }],
        }))
        .unwrap();

    {
        let mut st = server.state.lock().unwrap();
        st.write = false;
        st.expires_at = Some(NOW + 86_400_000);
    }
    let mut reader = connect(&server, "vault").unwrap();
    assert!(!reader.session().can_write);
    assert_eq!(reader.session().token_expires_at, Some(NOW + 86_400_000));
    assert_eq!(reader.vault_secret("db", "password").unwrap(), "pw");
    let pushed = server.state.lock().unwrap().ops.len();
    for err in [
        reader
            .create_vault_item(&json!({ "name": "x" }))
            .unwrap_err(),
        reader
            .update_vault_item("DB", &json!({ "notes": "x" }))
            .unwrap_err(),
        reader.delete_vault_item("DB").unwrap_err(),
        reader.create_vault_folder("x").unwrap_err(),
    ] {
        assert_eq!(code(&err), "api_token_read_only");
    }
    assert_eq!(server.state.lock().unwrap().ops.len(), pushed);
    assert!(reader.session().store.unsynced_ops().is_empty());
}

#[test]
fn an_expired_token_is_refused_with_its_code() {
    let server = server(&["vault"]);
    let client = connect(&server, "vault").unwrap();
    drop(client);
    server.state.lock().unwrap().token_expired = true;
    let err = connect(&server, "vault").err().unwrap();
    assert_eq!(err.status(), Some(401));
    assert_eq!(code(&err), "api_token_expired");
}

#[test]
fn vault_needs_a_vault_session() {
    let todo_only = server(&["todo"]);
    let err = connect(&todo_only, "vault").err().unwrap();
    assert_eq!(code(&err), "app_not_in_token");
    assert!(err.to_string().contains("Atlas Vault"), "{err}");
    let todo = connect(&todo_only, "todo").unwrap();
    assert_eq!(
        code(&todo.vault_items(&VaultQuery::default()).unwrap_err()),
        "wrong_app"
    );
    // A server that does not offer the vault.
    let no_vault = FakeServer::with_apps(&["vault"]);
    no_vault.state.lock().unwrap().discovery = Some(current_discovery(&["todo"]));
    assert_eq!(
        code(&connect(&no_vault, "vault").err().unwrap()),
        "server_incompatible"
    );
}
