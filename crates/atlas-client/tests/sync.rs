//! The session, sync and key hydration against the in-memory fake server.

use atlas_client::crypto::{
    encrypt_field, project_key_id, random_bytes, seal_key, sign_delivery, signing_public_key,
    x25519_public_key, DeliveryFields, FieldLocation, KeyScope,
};
use atlas_client::session::{ConnectOptions, Session};
use atlas_client::testing::{FakeServer, USER_ID};
use atlas_core::EntityKind;
use serde_json::{json, Value};
use uuid::Uuid;

fn connect(server: &FakeServer) -> Session {
    let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    Session::connect(opts).expect("connects")
}

fn wire_set(entity: &str, entity_id: &str, field: &str, value: Value, wall_ms: u64) -> Value {
    json!({
        "id": Uuid::new_v4(), "entity": entity, "entity_id": entity_id, "op": "set",
        "field": field, "value": value,
        "ts": {"wall_ms": wall_ms, "counter": 0, "node": "00000000-0000-4000-8000-0000000000ff"},
    })
}

fn inject(server: &FakeServer, op: Value) {
    let mut st = server.state.lock().unwrap();
    st.seq += 1;
    let seq = st.seq;
    st.ops.push((seq, op));
}

#[test]
fn the_state_dir_caches_the_account_between_runs() {
    let server = FakeServer::new();
    let dir = std::env::temp_dir().join(format!("atlas-state-test-{}", Uuid::new_v4()));
    let open = |dir: &std::path::Path| {
        let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
        opts.transport = Some(server.transport());
        opts.state_dir = Some(dir.to_path_buf());
        Session::connect(opts).expect("connects")
    };
    let mut a = open(&dir);
    let task = Uuid::new_v4().to_string();
    a.store
        .set(EntityKind::Task, &task, "title", json!("Cached"));
    a.push().unwrap();
    assert!(a.save_state().unwrap());
    let file = std::fs::read_to_string(dir.join(format!("{}.state", server.token.id))).unwrap();
    assert!(!file.contains("Cached"), "the cache is sealed");

    // Another device writes meanwhile; the next run pulls only that.
    let at = FieldLocation {
        entity: "task",
        entity_id: &task,
        field: "notes",
    };
    let env = encrypt_field(&server.dek, "dek", &KeyScope::Personal, at, &json!("later")).unwrap();
    inject(&server, wire_set("task", &task, "notes", env.to_value(), 1));
    server.state.lock().unwrap().log.clear();
    let b = open(&dir);
    let log = server.state.lock().unwrap().log.clone();
    assert!(!log.iter().any(|l| l.contains("/sync/snapshot")), "{log:?}");
    let fields = b.store.get(EntityKind::Task, &task).unwrap();
    assert_eq!(
        (fields["title"].clone(), fields["notes"].clone()),
        (json!("Cached"), json!("later"))
    );
    assert_eq!(b.sync.cursor(), 2);

    // Another token does not open the file: it syncs from scratch.
    let other = FakeServer::new();
    std::fs::copy(
        dir.join(format!("{}.state", server.token.id)),
        dir.join(format!("{}.state", other.token.id)),
    )
    .unwrap();
    let mut opts = ConnectOptions::new("http://atlas.test", &other.token_string());
    opts.transport = Some(other.transport());
    opts.state_dir = Some(dir.clone());
    let c = Session::connect(opts).unwrap();
    assert!(c.store.get(EntityKind::Task, &task).is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn writes_travel_encrypted_and_another_session_reads_them() {
    let server = FakeServer::new();
    let mut a = connect(&server);
    let task = Uuid::new_v4().to_string();
    let project = Uuid::new_v4().to_string();
    a.store
        .set(EntityKind::Task, &task, "project_id", json!(project));
    a.store
        .set(EntityKind::Task, &task, "title", json!("Renew passport"));
    a.push().unwrap();
    assert!(a.store.unsynced_ops().is_empty());
    {
        // The kind, the field names and the link stay inside the sealed values (protocol 7): the
        // project has no key here, so both go under the account's own key.
        let st = server.state.lock().unwrap();
        assert_eq!(st.ops.len(), 2);
        for (_, op) in &st.ops {
            assert_eq!(op["entity"], "todo.sealed");
            assert!(op["scope"].is_null());
            assert_eq!(op["field"].as_str().unwrap().len(), 32);
            assert_eq!(
                (op["value"]["__enc"].as_u64(), op["value"]["kid"].as_str()),
                (Some(3), Some("dek"))
            );
        }
        let raw = serde_json::to_string(&st.ops).unwrap();
        assert!(
            !raw.contains("Renew passport") && !raw.contains(&project) && !raw.contains("title")
        );
    }
    let b = connect(&server);
    let fields = b.store.get(EntityKind::Task, &task).unwrap();
    assert_eq!(fields["title"], "Renew passport");
    assert_eq!(b.sync.cursor(), 2);
}

#[test]
fn an_expired_access_token_is_exchanged_again() {
    let server = FakeServer::new();
    let mut a = connect(&server);
    server.state.lock().unwrap().expired.push("access-1".into());
    a.sync_now().unwrap();
    assert_eq!(server.state.lock().unwrap().sessions, 2);
    server.state.lock().unwrap().revoked = true;
    let err = a.sync_now().unwrap_err();
    assert_eq!(err.status(), Some(401));
}

#[test]
fn a_revoked_or_wrong_token_does_not_connect() {
    let server = FakeServer::new();
    server.state.lock().unwrap().revoked = true;
    let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    assert_eq!(Session::connect(opts).err().unwrap().status(), Some(401));
    let mut opts = ConnectOptions::new("http://atlas.test", "not a token");
    opts.transport = Some(server.transport());
    assert!(matches!(
        Session::connect(opts),
        Err(atlas_client::Error::InvalidApiToken(_))
    ));
}

#[test]
fn an_incompatible_server_is_refused_before_signing_in() {
    let server = FakeServer::new();
    server.state.lock().unwrap().discovery = Some(json!({
        "version": "0.0.9", "protocol_version": 5, "capabilities": [], "apps": []
    }));
    let mut opts = ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    let err = Session::connect(opts).err().unwrap();
    assert!(err.to_string().contains("speaks sync protocol 5"), "{err}");
    assert_eq!(server.state.lock().unwrap().sessions, 0);
}

/// A project shared by another owner: its key arrives sealed to this account and signed by the
/// owner, and opens the project's values. A delivery with a bad signature is refused.
#[test]
fn signed_project_key_deliveries_open_shared_content() {
    for good_signature in [true, false] {
        let server = FakeServer::new();
        let owner = "01920000-0000-7000-8000-0000000000bb";
        let owner_x25519: [u8; 32] = random_bytes();
        let owner_signing: [u8; 32] = random_bytes();
        let project = Uuid::new_v4().to_string();
        let task = Uuid::new_v4().to_string();
        let pek: [u8; 32] = random_bytes();
        let key_id = project_key_id(&pek);
        let sealed = seal_key(&pek, &server.public_key()).unwrap();
        let signature = sign_delivery(
            &owner_signing,
            &DeliveryFields {
                project_id: &project,
                recipient_id: if good_signature { USER_ID } else { owner },
                key_id: &key_id,
                sealed: &sealed,
            },
        )
        .unwrap();
        server.state.lock().unwrap().project_keys = json!({
            "keys": [{
                "project_id": project, "key_id": key_id, "kind": "sealed",
                "encrypted_pek": sealed, "signature": signature, "signed_by": owner,
                "signer_public_key": x25519_public_key(&owner_x25519),
                "signer_signing_key": signing_public_key(&owner_signing),
            }],
            "canonical": { project.clone(): key_id },
        });
        // The server-written membership rows: the owner's and this account's.
        for (user, role) in [(owner, "owner"), (USER_ID, "editor")] {
            let member = Uuid::new_v4().to_string();
            for (field, value) in [
                ("project_id", json!(project)),
                ("user_id", json!(user)),
                ("role", json!(role)),
                ("state", json!("active")),
            ] {
                inject(
                    &server,
                    wire_set("project_member", &member, field, value, 1),
                );
            }
        }
        inject(
            &server,
            wire_set("task", &task, "project_id", json!(project), 1),
        );
        let at = FieldLocation {
            entity: "task",
            entity_id: &task,
            field: "title",
        };
        let env = encrypt_field(
            &pek,
            &key_id,
            &KeyScope::Project(project.clone()),
            at,
            &json!("Shared"),
        )
        .unwrap();
        inject(&server, wire_set("task", &task, "title", env.to_value(), 1));

        let mut s = connect(&server);
        let title = s.store.get(EntityKind::Task, &task).unwrap()["title"].clone();
        if good_signature {
            assert_eq!(title, "Shared");
            assert_eq!(s.keyring.canonical_key_id(&project), Some(key_id.as_str()));
            // A write to the project is encrypted with its key.
            s.store.set(EntityKind::Task, &task, "notes", json!("n"));
            s.push().unwrap();
            let st = server.state.lock().unwrap();
            let notes = st
                .ops
                .iter()
                .rev()
                .find(|(_, o)| o["entity_id"] == json!(task) && o["entity"] == "todo.sealed")
                .unwrap();
            assert_eq!(notes.1["value"]["kid"], json!(key_id));
            assert_eq!(notes.1["scope"], json!(project));
            // The signer's identity got pinned in the synced trust state, under the account's key.
            assert!(st.ops.iter().any(|(_, o)| o["entity"] == "todo.sealed"
                && o["entity_id"] == json!(atlas_client::trust::KEY_TRUST_ID)
                && o["scope"].is_null()));
        } else {
            assert_eq!(title["__enc"], 2, "the value stays locked");
            assert!(s.keyring.project_key(&project, &key_id).is_none());
            // Writes to a shared project without its key wait.
            s.store.set(EntityKind::Task, &task, "notes", json!("n"));
            let err = s.push().unwrap_err();
            assert!(
                err.to_string().contains("did not reach the server"),
                "{err}"
            );
        }
    }
}

#[test]
fn values_under_the_wrong_scope_stay_unread() {
    let server = FakeServer::new();
    let task = Uuid::new_v4().to_string();
    let other = Uuid::new_v4().to_string();
    // A value encrypted for another entity, copied here by the server.
    let at = FieldLocation {
        entity: "task",
        entity_id: &other,
        field: "title",
    };
    let env = encrypt_field(
        &server.dek,
        "dek",
        &KeyScope::Personal,
        at,
        &json!("copied"),
    )
    .unwrap();
    inject(&server, wire_set("task", &task, "title", env.to_value(), 1));
    let s = connect(&server);
    assert_eq!(
        s.store.get(EntityKind::Task, &task).unwrap()["title"]["__enc"],
        2
    );
}

/// Rows a protocol 6 client wrote are re-encoded with their stamps and dropped by the first session
/// that reads them (`migrate_legacy`).
#[test]
fn protocol_6_rows_are_re_encoded_and_dropped() {
    let server = FakeServer::new();
    let task = Uuid::new_v4().to_string();
    let dek = server.dek;
    let at = FieldLocation {
        entity: "task",
        entity_id: &task,
        field: "title",
    };
    let title = encrypt_field(&dek, "dek", &KeyScope::Personal, at, &json!("Old title")).unwrap();
    inject(
        &server,
        wire_set("task", &task, "title", title.to_value(), 7),
    );
    inject(&server, wire_set("task", &task, "priority", json!(3), 8));

    let s = connect(&server);
    assert_eq!(
        s.store.get(EntityKind::Task, &task).unwrap()["title"],
        "Old title"
    );
    let legacy = s.sync.legacy.clone().expect("the pass ran");
    assert_eq!((legacy.reencoded, legacy.left), (1, 0));
    let st = server.state.lock().unwrap();
    assert!(
        st.ops.iter().all(|(_, o)| o["entity"] != "task"),
        "the originals are gone"
    );
    let copies: Vec<&Value> = st
        .ops
        .iter()
        .map(|(_, o)| o)
        .filter(|o| o["entity_id"] == json!(task))
        .collect();
    assert_eq!(copies.len(), 2);
    let mut walls: Vec<u64> = copies
        .iter()
        .map(|o| o["ts"]["wall_ms"].as_u64().unwrap())
        .collect();
    walls.sort();
    assert_eq!(walls, [7, 8], "every stamp kept");
    drop(st);

    // A later session reads the re-encoded copy.
    let b = connect(&server);
    let fields = b.store.get(EntityKind::Task, &task).unwrap();
    assert_eq!(
        (fields["title"].as_str(), fields["priority"].as_i64()),
        (Some("Old title"), Some(3))
    );
}
