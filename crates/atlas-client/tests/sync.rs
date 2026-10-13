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
        let st = server.state.lock().unwrap();
        let title = st.ops.iter().find(|(_, o)| o["field"] == "title").unwrap();
        assert_eq!(title.1["value"]["__enc"], 2);
        assert_eq!(title.1["value"]["kid"], "dek");
        let link = st
            .ops
            .iter()
            .find(|(_, o)| o["field"] == "project_id")
            .unwrap();
        assert_eq!(
            link.1["value"],
            json!(project),
            "routing fields stay plaintext"
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
                .find(|(_, o)| o["field"] == "notes")
                .unwrap();
            assert_eq!(notes.1["value"]["kid"], json!(key_id));
            // The signer's identity got pinned in the synced trust state.
            assert!(st.ops.iter().any(|(_, o)| o["entity"] == "preference"
                && o["field"] == json!(format!("identity:{owner}"))));
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
