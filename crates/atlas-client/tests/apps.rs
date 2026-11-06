//! App-scoped API-token sessions against the fake server, for the suite's personal apps (Atlas
//! Journal and Atlas Vault, whose manifests core bundles; their rules live in their own
//! repositories): an app-only token (its key in `app_keys`, no todo key) writes sealed ops only
//! that key opens, tokens and servers without the app are refused clearly, each app keeps its data
//! and its state file apart, and the vault's token policies (read-only, expiry) hold.

use atlas_client::client::AtlasClient;
use atlas_client::crypto::{FieldEnvelope, Keyring};
use atlas_client::session::ConnectOptions;
use atlas_client::testing::{current_discovery, FakeServer};
use atlas_client::wire::open_sealed;
use atlas_client::Error;
use atlas_core::EntityKind;
use serde_json::json;

const NOW: i64 = 1_792_279_800_000;

fn server(token_apps: &[&str], offered: &[&str]) -> FakeServer {
    let server = FakeServer::with_apps(token_apps);
    server.state.lock().unwrap().discovery = Some(current_discovery(offered));
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

/// Write one entity of `kind` with `fields` and push it, as an app's client would.
fn write(client: &mut AtlasClient, kind: EntityKind, fields: serde_json::Value) -> String {
    let store = &mut client.session_mut().store;
    let id = store.new_entity_id();
    for (field, value) in fields.as_object().unwrap() {
        store.set(kind, &id, field, value.clone());
    }
    client.push().unwrap();
    id
}

#[test]
fn an_app_only_token_writes_ops_only_its_key_opens() {
    let server = server(&["journal"], &["todo", "journal"]);
    let mut journal = connect(&server, "journal").expect("a journal-only token connects");
    assert_eq!(journal.session().app, "journal");
    let id = write(
        &mut journal,
        EntityKind::JournalEntry,
        json!({ "title": "Harbour walk", "body": "Fog over the water." }),
    );

    // Every sync request named journal; the server holds only ciphertext.
    let st = server.state.lock().unwrap();
    assert!(!st.sync_apps.is_empty());
    assert!(st.sync_apps.iter().all(|a| a.as_deref() == Some("journal")));
    let raw = serde_json::to_string(&st.ops).unwrap();
    assert!(!raw.contains("Harbour") && !raw.contains("Fog"));
    // Each value is a personal-scope v3 envelope under the journal key, the kind inside it.
    let (journal_key, _) = server.app_keys["journal"];
    for (_, op) in &st.ops {
        assert_eq!(op["entity"], "journal.sealed");
        assert!(op["scope"].is_null());
        let envelope = FieldEnvelope::from_value_v3(&op["value"]).expect("an envelope");
        assert_eq!(envelope.kid, "dek");
        let open = |key: [u8; 32]| {
            open_sealed(
                &Keyring::new(key, [0; 32], None),
                "journal.sealed",
                op["entity_id"].as_str().unwrap(),
                op["field"].as_str().unwrap(),
                None,
                &envelope,
            )
        };
        assert_eq!(open(journal_key).unwrap().kind.as_str(), "journal.entry");
        assert!(open(server.dek).is_none());
    }
    drop(st);

    // Another session of the token pulls and opens it.
    let other = connect(&server, "journal").unwrap();
    let fields = other
        .session()
        .store
        .get(EntityKind::JournalEntry, &id)
        .unwrap();
    assert_eq!(fields["title"], "Harbour walk");
}

#[test]
fn a_token_or_server_without_the_app_is_refused_clearly() {
    // A journal-only token has no todo key.
    let journal_only = server(&["journal"], &["todo", "journal"]);
    let err = connect(&journal_only, "todo").err().unwrap();
    assert_eq!(code(&err), "app_not_in_token");
    assert!(err.to_string().contains("Atlas Todo"), "{err}");

    // A todo token has no journal or vault key.
    let todo_only = server(&["todo"], &["todo", "journal", "vault"]);
    for (app, name) in [("journal", "Atlas Journal"), ("vault", "Atlas Vault")] {
        let err = connect(&todo_only, app).err().unwrap();
        assert_eq!(code(&err), "app_not_in_token");
        assert!(err.to_string().contains(name), "{err}");
    }

    // An app this client does not bundle, and a server that does not offer the app.
    assert_eq!(
        code(&connect(&todo_only, "notes").err().unwrap()),
        "unknown_app"
    );
    let no_journal = server(&["journal"], &["todo"]);
    assert_eq!(
        code(&connect(&no_journal, "journal").err().unwrap()),
        "server_incompatible"
    );
    // A server from before discovery has no other app at all.
    let legacy = FakeServer::with_apps(&["journal"]);
    assert_eq!(
        code(&connect(&legacy, "journal").err().unwrap()),
        "server_incompatible"
    );
}

#[test]
fn a_token_for_two_apps_keeps_their_data_apart() {
    // Todo has shared projects: its writes need its definition (the todo-shaped test app here).
    atlas_client::testing::register_test_app();
    let server = server(&["todo", "journal"], &["todo", "journal"]);
    let mut todo = connect(&server, "todo").unwrap();
    let task = todo.session_mut().store.new_entity_id();
    todo.session_mut()
        .store
        .set("task", &task, "title", json!("Buy stamps"));
    todo.push().unwrap();
    let mut journal = connect(&server, "journal").unwrap();
    write(
        &mut journal,
        EntityKind::JournalEntry,
        json!({ "title": "Posted the letters" }),
    );
    // Each session sees only its app, and named it on every sync request.
    let todo = connect(&server, "todo").unwrap();
    assert_eq!(todo.session().store.list("task").len(), 1);
    assert!(todo
        .session()
        .store
        .list(EntityKind::JournalEntry)
        .is_empty());
    let journal = connect(&server, "journal").unwrap();
    assert_eq!(
        journal.session().store.list(EntityKind::JournalEntry).len(),
        1
    );
    assert!(journal.session().store.list(EntityKind::Task).is_empty());
    let st = server.state.lock().unwrap();
    assert!(st
        .sync_apps
        .iter()
        .all(|a| matches!(a.as_deref(), Some("todo" | "journal"))));
}

#[test]
fn each_app_has_its_own_state_file() {
    let server = server(&["todo", "journal"], &["todo", "journal"]);
    let dir = std::env::temp_dir().join(format!("atlas-app-state-{}", uuid::Uuid::new_v4()));
    let open = |app: &str| {
        let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
        opts.transport = Some(server.transport());
        opts.app = app.into();
        opts.state_dir = Some(dir.clone());
        AtlasClient::connect(opts).unwrap()
    };
    let mut journal = open("journal");
    write(
        &mut journal,
        EntityKind::JournalEntry,
        json!({ "body": "cached" }),
    );
    assert!(journal.session().save_state().unwrap());
    assert!(open("todo").session().save_state().unwrap());
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    let id = &server.token.id;
    assert_eq!(
        files,
        [format!("{id}.journal.state"), format!("{id}.state")]
    );
    // The cache brings the entry back.
    let again = open("journal");
    assert_eq!(
        again.session().store.list(EntityKind::JournalEntry).len(),
        1
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_read_only_token_reads_and_refuses_writes_before_pushing() {
    let server = server(&["vault"], &["todo", "vault"]);
    let mut writer = connect(&server, "vault").unwrap();
    let id = write(&mut writer, EntityKind::VaultItem, json!({ "name": "DB" }));
    {
        let mut st = server.state.lock().unwrap();
        st.write = false;
        st.expires_at = Some(NOW + 86_400_000);
    }
    let reader = connect(&server, "vault").unwrap();
    assert!(!reader.session().can_write);
    assert_eq!(reader.session().token_expires_at, Some(NOW + 86_400_000));
    assert_eq!(
        reader
            .session()
            .store
            .get(EntityKind::VaultItem, &id)
            .unwrap()["name"],
        "DB"
    );
    let pushed = server.state.lock().unwrap().ops.len();
    let err = reader.session().require_write().unwrap_err();
    assert_eq!(code(&err), "api_token_read_only");
    assert_eq!(server.state.lock().unwrap().ops.len(), pushed);
}

#[test]
fn an_expired_token_is_refused_with_its_code() {
    let server = server(&["vault"], &["todo", "vault"]);
    drop(connect(&server, "vault").unwrap());
    server.state.lock().unwrap().token_expired = true;
    let err = connect(&server, "vault").err().unwrap();
    assert_eq!(err.status(), Some(401));
    assert_eq!(code(&err), "api_token_expired");
}
