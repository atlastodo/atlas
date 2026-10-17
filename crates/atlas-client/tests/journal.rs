//! App-scoped token sessions against the fake server: a journal-only token (its key in
//! `app_keys`, no todo key), the journal entries over it, and tokens without the app asked for.

use atlas_client::client::AtlasClient;
use atlas_client::crypto::{decrypt_field, FieldEnvelope, FieldLocation, KeyScope};
use atlas_client::journal::{JournalFields, JournalQuery};
use atlas_client::session::ConnectOptions;
use atlas_client::testing::FakeServer;
use atlas_client::Error;
use serde_json::{json, Value};

const NOW: i64 = 1_792_279_800_000; // 2026-10-17T23:30:00Z, the 18th in Copenhagen

fn discovery(apps: &[&str]) -> Value {
    json!({
        "service": "atlas-server", "version": "0.2.0", "protocol_version": 6,
        "min_protocol_version": 6,
        "capabilities": ["api_tokens", "app_manifests", "account_apps", "root_key",
                         "app_scoped_sync", "app_scoped_api_tokens"],
        "apps": apps.iter().map(|a| json!({"id": a, "name": a, "version": 1})).collect::<Vec<_>>(),
    })
}

fn server(token_apps: &[&str]) -> FakeServer {
    let server = FakeServer::with_apps(token_apps);
    server.state.lock().unwrap().discovery = Some(discovery(&["todo", "journal"]));
    server
}

fn connect(server: &FakeServer, app: &str) -> Result<AtlasClient, Error> {
    let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    opts.time_zone = Some("Europe/Copenhagen".into());
    opts.app = app.into();
    let mut client = AtlasClient::connect(opts)?;
    client.set_now(Box::new(|| NOW));
    Ok(client)
}

fn code(err: &Error) -> &str {
    match err {
        Error::Atlas { code, .. } => code,
        other => panic!("not an Atlas error: {other:?}"),
    }
}

#[test]
fn a_journal_only_token_writes_entries_only_its_key_opens() {
    let server = server(&["journal"]);
    let mut journal = connect(&server, "journal").expect("a journal-only token connects");
    assert_eq!(journal.session().app, "journal");

    let entry = journal
        .create_journal_entry(JournalFields {
            title: Some("  Harbour walk ".into()),
            body: Some("Fog over the water.".into()),
            mood: Some(Some(4)),
            tags: Some(vec!["walks".into(), "Walks".into(), "sea".into()]),
            ..JournalFields::default()
        })
        .unwrap();
    assert_eq!(entry.date, "2026-10-18", "today in ATLAS_TZ");
    assert_eq!(entry.title, "Harbour walk");
    assert_eq!(entry.mood, Some(4));
    assert_eq!(entry.tags, ["walks", "sea"]);
    assert_eq!((entry.created_at, entry.updated_at), (NOW, NOW));
    assert_eq!(entry.deleted_at, None);

    // Every sync request named journal; the server holds only ciphertext.
    let st = server.state.lock().unwrap();
    assert!(!st.sync_apps.is_empty());
    assert!(st.sync_apps.iter().all(|a| a.as_deref() == Some("journal")));
    let raw = serde_json::to_string(&st.ops).unwrap();
    assert!(!raw.contains("Harbour") && !raw.contains("Fog") && !raw.contains("walks"));
    // Each value is a personal-scope envelope under the journal key, bound to journal.entry.
    let (journal_key, _) = server.app_keys["journal"];
    for (_, op) in &st.ops {
        assert_eq!(op["entity"], "journal.entry");
        let envelope = FieldEnvelope::from_value(&op["value"]).expect("an envelope");
        assert_eq!(envelope.kid, "dek");
        let at = FieldLocation {
            entity: "journal.entry",
            entity_id: op["entity_id"].as_str().unwrap(),
            field: op["field"].as_str().unwrap(),
        };
        assert!(decrypt_field(&journal_key, &KeyScope::Personal, at, &envelope).is_ok());
        assert!(decrypt_field(&server.dek, &KeyScope::Personal, at, &envelope).is_err());
    }
    drop(st);

    // Another session reads, edits and trashes it.
    let mut other = connect(&server, "journal").unwrap();
    assert_eq!(other.journal_entry(&entry.id).unwrap(), entry);
    let edited = other
        .update_journal_entry(
            &entry.id,
            JournalFields {
                date: Some("yesterday".into()),
                mood: Some(None),
                tags: Some(vec![]),
                ..JournalFields::default()
            },
        )
        .unwrap();
    assert_eq!(
        (edited.date.as_str(), edited.mood, edited.tags.len()),
        ("2026-10-17", None, 0)
    );
    assert_eq!(edited.body, "Fog over the water.");
    other
        .create_journal_entry(JournalFields {
            date: Some("2026-09-01".into()),
            body: Some("First day of autumn term".into()),
            tags: Some(vec!["school".into()]),
            ..JournalFields::default()
        })
        .unwrap();
    let all = other.journal_entries(&JournalQuery::default()).unwrap();
    assert_eq!(
        all.iter().map(|e| e.date.as_str()).collect::<Vec<_>>(),
        ["2026-10-17", "2026-09-01"],
        "newest first"
    );
    let found = |q: JournalQuery| other.journal_entries(&q).unwrap().len();
    assert_eq!(
        found(JournalQuery {
            from: Some("2026-10-01".into()),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        found(JournalQuery {
            to: Some("2026-09-01".into()),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        found(JournalQuery {
            tag: Some("SCHOOL".into()),
            ..Default::default()
        }),
        1
    );
    assert_eq!(
        found(JournalQuery {
            search: Some("fog".into()),
            ..Default::default()
        }),
        1
    );
    assert!(other
        .journal_entries(&JournalQuery {
            from: Some("soon".into()),
            ..Default::default()
        })
        .is_err());

    other.delete_journal_entry(&entry.id).unwrap();
    assert_eq!(
        other
            .journal_entries(&JournalQuery::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        other.journal_entry(&entry.id).unwrap().deleted_at,
        Some(NOW)
    );

    // Refusals.
    let err = other
        .create_journal_entry(JournalFields {
            title: Some(" ".into()),
            ..JournalFields::default()
        })
        .unwrap_err();
    assert_eq!(code(&err), "bad_input");
    assert_eq!(
        code(&other.journal_entry("nope").unwrap_err()),
        "unknown_journal_entry"
    );
}

#[test]
fn a_token_without_the_app_is_refused_clearly() {
    // A journal-only token has no todo key.
    let journal_only = server(&["journal"]);
    let err = connect(&journal_only, "todo").err().unwrap();
    assert_eq!(code(&err), "app_not_in_token");
    assert!(err.to_string().contains("Atlas Todo"), "{err}");

    // A todo token has no journal key.
    let todo_only = server(&["todo"]);
    let err = connect(&todo_only, "journal").err().unwrap();
    assert_eq!(code(&err), "app_not_in_token");
    assert!(err.to_string().contains("Atlas Journal"), "{err}");

    // A todo session cannot write journal entries.
    let todo = connect(&todo_only, "todo").unwrap();
    assert_eq!(
        code(&todo.journal_entries(&JournalQuery::default()).unwrap_err()),
        "wrong_app"
    );

    // An app this client does not bundle, and a server that does not offer journal.
    assert_eq!(
        code(&connect(&todo_only, "notes").err().unwrap()),
        "unknown_app"
    );
    let todo_server = FakeServer::with_apps(&["journal"]);
    todo_server.state.lock().unwrap().discovery = Some(discovery(&["todo"]));
    let err = connect(&todo_server, "journal").err().unwrap();
    assert_eq!(code(&err), "server_incompatible");
    // A server from before discovery has no journal at all.
    let legacy = FakeServer::with_apps(&["journal"]);
    assert_eq!(
        code(&connect(&legacy, "journal").err().unwrap()),
        "server_incompatible"
    );
}

#[test]
fn a_token_for_both_apps_keeps_their_data_apart() {
    let server = server(&["todo", "journal"]);
    let mut todo = connect(&server, "todo").unwrap();
    todo.quick_add("Buy stamps").unwrap();
    let mut journal = connect(&server, "journal").unwrap();
    journal
        .create_journal_entry(JournalFields {
            title: Some("Posted the letters".into()),
            ..JournalFields::default()
        })
        .unwrap();
    // Each session sees only its app, and named it on every sync request.
    let todo = connect(&server, "todo").unwrap();
    assert_eq!(todo.tasks(&Default::default()).unwrap().len(), 1);
    assert!(todo
        .session()
        .store
        .list(atlas_core::EntityKind::JournalEntry)
        .is_empty());
    let journal = connect(&server, "journal").unwrap();
    assert_eq!(
        journal
            .journal_entries(&JournalQuery::default())
            .unwrap()
            .len(),
        1
    );
    assert!(journal
        .session()
        .store
        .list(atlas_core::EntityKind::Task)
        .is_empty());
    let st = server.state.lock().unwrap();
    assert!(st
        .sync_apps
        .iter()
        .all(|a| matches!(a.as_deref(), Some("todo" | "journal"))));
}

#[test]
fn each_app_has_its_own_state_file() {
    let server = server(&["todo", "journal"]);
    let dir = std::env::temp_dir().join(format!("atlas-journal-state-{}", uuid::Uuid::new_v4()));
    let open = |app: &str| {
        let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
        opts.transport = Some(server.transport());
        opts.app = app.into();
        opts.state_dir = Some(dir.clone());
        AtlasClient::connect(opts).unwrap()
    };
    let mut journal = open("journal");
    journal
        .create_journal_entry(JournalFields {
            body: Some("cached".into()),
            ..JournalFields::default()
        })
        .unwrap();
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
        again
            .journal_entries(&JournalQuery::default())
            .unwrap()
            .len(),
        1
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
