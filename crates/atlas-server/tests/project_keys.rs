//! Integration tests for E2EE project-key distribution (`project_keys`).
//!
//! Each user holds an append-only history of PEK rows per project, keyed by the key's fingerprint
//! (`key_id`): `wrapped` rows are their own copies, `sealed` rows are deliveries from an owner. The
//! canonical key of a shared project is the earliest active owner's first fingerprinted copy that
//! another member also holds (or simply the first, while nobody else holds one).

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config(database_url: String) -> Config {
    Config {
        database_url,
        jwt_secret: b"integration-test-secret-32-bytes-x".to_vec(),
        access_ttl_seconds: 900,
        refresh_ttl_seconds: 3600,
        port: 8080,
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
    }
}

async fn setup() -> Router {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    app(AppState::new(pool, config(test_database_url())))
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-atlas-sync-protocol", "6");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let req = b
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

struct User {
    token: String,
    id: String,
    email: String,
}

const PUBLIC_KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";
/// Every account's Ed25519 identity key in these tests (placeholders: nothing is verified here).
const SIGNING_KEY: &str = "3333333333333333333333333333333333333333333333333333333333333333";
/// A delivery signature's shape: 64 bytes, hex. The server never verifies it.
const SIGNATURE: &str = "abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab";

/// Adds the E2EE key material every signup must carry. Placeholders: these tests never decrypt.
fn with_keys(mut body: Value) -> Value {
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let fields = body.as_object_mut().unwrap();
    fields.insert("salt".into(), json!("00".repeat(16)));
    fields.insert("public_key".into(), json!(PUBLIC_KEY));
    fields.insert("recovery_public_key".into(), json!("22".repeat(32)));
    fields.insert("signing_public_key".into(), json!(SIGNING_KEY));
    fields.insert("encrypted_signing_key".into(), wrapped.clone());
    for key in [
        "encrypted_dek",
        "encrypted_private_key",
        "recovery_encrypted_dek",
        "recovery_encrypted_private_key",
    ] {
        fields.insert(key.into(), wrapped.clone());
    }
    body
}

async fn new_user(router: &Router) -> User {
    let email = format!("k-{}@example.com", Uuid::now_v7());
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email,
    }
}

/// Create a project in `owner`'s partition (making them its creator). Returns the project id.
async fn push_project(router: &Router, owner: &User) -> String {
    let pid = Uuid::now_v7().to_string();
    let (status, _) = send(
        router,
        "POST",
        "/sync/push",
        Some(&owner.token),
        json!({ "operations": [{
            "id": Uuid::now_v7().to_string(),
            "entity": "project",
            "entity_id": pid,
            "op": "set",
            "field": "name",
            "value": { "__enc": 1, "iv": "AAAAAAAAAAAAAAAA", "ct": "bmFtZQ==" },
            "ts": { "wall_ms": 1000, "counter": 0, "node": Uuid::now_v7().to_string() }
        }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    pid
}

async fn invite(router: &Router, owner: &User, invitee: &User, pid: &str, role: &str) {
    let (status, body) = send(
        router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&owner.token),
        json!({ "email": invitee.email, "role": role }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "invite: {body}");
}

async fn accept(router: &Router, invitee: &User, pid: &str) {
    let (status, _) = send(
        router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&invitee.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "accept");
}

/// A distinct 32-hex key fingerprint.
fn key_id(n: u8) -> String {
    format!("{:02x}", n).repeat(16)
}

/// A wrapped-shaped payload (AES-GCM under the DEK: 16-char base64 iv).
fn wrapped_pek(tag: &str) -> Value {
    json!({ "iv": "B".repeat(16), "ct": tag })
}

/// A sealed-shaped payload (the iv slot is the 64-hex ephemeral public key).
fn sealed_pek(tag: &str) -> Value {
    json!({ "iv": "e".repeat(64), "ct": tag })
}

async fn put_own(router: &Router, user: &User, pid: &str, kid: &str, pek: Value) -> StatusCode {
    send(
        router,
        "PUT",
        &format!("/projects/{pid}/keys"),
        Some(&user.token),
        json!({ "encrypted_pek": pek, "key_id": kid }),
    )
    .await
    .0
}

/// Store a `wrapped` key row directly, as older versions could: the API now refuses a second key
/// for a shared project, but the canonical-key choice must still cope with rows already stored.
async fn store_raw_key(user: &User, pid: &str, kid: &str, pek: Value) {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    sqlx::query(
        "INSERT INTO project_keys (project_id, user_id, key_id, kind, encrypted_pek)
         VALUES ($1::uuid, $2::uuid, $3, 'wrapped', $4)",
    )
    .bind(pid)
    .bind(&user.id)
    .bind(kid)
    .bind(pek)
    .execute(&pool)
    .await
    .unwrap();
}

async fn put_member(
    router: &Router,
    caller: &User,
    pid: &str,
    member_id: &str,
    kid: &str,
    pek: Value,
) -> StatusCode {
    send(
        router,
        "PUT",
        &format!("/projects/{pid}/member-keys/{member_id}"),
        Some(&caller.token),
        json!({ "encrypted_pek": pek, "key_id": kid, "signature": SIGNATURE }),
    )
    .await
    .0
}

async fn project_keys(router: &Router, user: &User) -> Value {
    let (status, body) = send(router, "GET", "/project-keys", Some(&user.token), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// The caller's rows for one project, as `(key_id, kind, encrypted_pek)`.
async fn rows_for(router: &Router, user: &User, pid: &str) -> Vec<(String, String, Value)> {
    let body = project_keys(router, user).await;
    let mut rows: Vec<_> = body["keys"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|k| k["project_id"] == pid)
        .map(|k| {
            (
                k["key_id"].as_str().unwrap().to_string(),
                k["kind"].as_str().unwrap().to_string(),
                k["encrypted_pek"].clone(),
            )
        })
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

async fn missing(router: &Router, user: &User) -> Vec<Value> {
    let (status, body) = send(
        router,
        "GET",
        "/project-keys/missing",
        Some(&user.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

#[tokio::test]
async fn editor_cannot_write_member_keys() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;

    // Bob (an active editor) must not be able to overwrite anyone's key, the owner's included.
    for target in [&alice.id, &bob.id] {
        assert_eq!(
            put_member(&router, &bob, &pid, target, &key_id(1), sealed_pek("x")).await,
            StatusCode::FORBIDDEN,
            "editor -> {target}"
        );
    }
    // An owner cannot deliver to themselves either (their own copy goes through /keys).
    assert_eq!(
        put_member(
            &router,
            &alice,
            &pid,
            &alice.id,
            &key_id(1),
            sealed_pek("x")
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert!(rows_for(&router, &alice, &pid).await.is_empty());
}

#[tokio::test]
async fn owner_delivers_only_to_existing_members() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // Before sharing, Alice is not yet a member: a delivery to anyone is 404.
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(1), sealed_pek("s")).await,
        StatusCode::NOT_FOUND
    );

    invite(&router, &alice, &bob, &pid, "editor").await;

    // Carol has no membership row.
    assert_eq!(
        put_member(
            &router,
            &alice,
            &pid,
            &carol.id,
            &key_id(1),
            sealed_pek("s")
        )
        .await,
        StatusCode::NOT_FOUND
    );
    // A stranger to the project learns nothing either.
    assert_eq!(
        put_member(&router, &carol, &pid, &bob.id, &key_id(1), sealed_pek("s")).await,
        StatusCode::NOT_FOUND
    );
    assert!(rows_for(&router, &carol, &pid).await.is_empty());

    // Bob is a pending invitee: the owner can deliver.
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(1), sealed_pek("s")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &bob, &pid).await,
        vec![(key_id(1), "sealed".into(), sealed_pek("s"))]
    );
    // Re-delivering the same key replaces the sealed row.
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(1), sealed_pek("s2")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &bob, &pid).await,
        vec![(key_id(1), "sealed".into(), sealed_pek("s2"))]
    );
}

#[tokio::test]
async fn delivery_never_touches_the_members_wrapped_row() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;

    assert_eq!(
        put_own(&router, &bob, &pid, &key_id(1), wrapped_pek("mine")).await,
        StatusCode::NO_CONTENT
    );
    // A delivery of the key Bob already holds leaves his own copy alone...
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(1), sealed_pek("s")).await,
        StatusCode::NO_CONTENT
    );
    // ...and a delivery of another key is added next to it.
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(2), sealed_pek("s2")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &bob, &pid).await,
        vec![
            (key_id(1), "wrapped".into(), wrapped_pek("mine")),
            (key_id(2), "sealed".into(), sealed_pek("s2")),
        ]
    );

    // Bob storing his own copy of a delivered key replaces the delivery.
    assert_eq!(
        put_own(&router, &bob, &pid, &key_id(2), wrapped_pek("mine2")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &bob, &pid).await,
        vec![
            (key_id(1), "wrapped".into(), wrapped_pek("mine")),
            (key_id(2), "wrapped".into(), wrapped_pek("mine2")),
        ]
    );
}

#[tokio::test]
async fn own_key_requires_a_relationship_with_the_project() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let mallory = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // A stranger cannot store a key for someone else's project...
    assert_eq!(
        put_own(&router, &mallory, &pid, &key_id(9), wrapped_pek("m")).await,
        StatusCode::NOT_FOUND
    );
    // ...not even after planting the project's id in her own (caller-writable) partition: only
    // its creator may key an unshared project.
    let (status, _) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&mallory.token),
        json!({ "operations": [{
            "id": Uuid::now_v7().to_string(), "entity": "project", "entity_id": pid,
            "op": "set", "field": "name", "value": "mine",
            "ts": { "wall_ms": 2000, "counter": 0, "node": Uuid::now_v7().to_string() }
        }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        put_own(&router, &mallory, &pid, &key_id(9), wrapped_pek("m")).await,
        StatusCode::NOT_FOUND
    );

    // The creator of the unshared project can (they are about to share it).
    assert_eq!(
        put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await,
        StatusCode::NO_CONTENT
    );
    // Upserting the same key_id replaces it; a new key_id adds to the history.
    assert_eq!(
        put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a2")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_own(&router, &alice, &pid, &key_id(2), wrapped_pek("b")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &alice, &pid).await,
        vec![
            (key_id(1), "wrapped".into(), wrapped_pek("a2")),
            (key_id(2), "wrapped".into(), wrapped_pek("b")),
        ]
    );

    invite(&router, &alice, &bob, &pid, "commenter").await;
    // A pending invitee may store their own copy (after unsealing the delivery).
    assert_eq!(
        put_own(&router, &bob, &pid, &key_id(1), wrapped_pek("bob")).await,
        StatusCode::NO_CONTENT
    );
    // Once shared, only members may.
    assert_eq!(
        put_own(&router, &mallory, &pid, &key_id(9), wrapped_pek("m")).await,
        StatusCode::NOT_FOUND
    );
    assert!(rows_for(&router, &mallory, &pid).await.is_empty());
}

/// A project shared before project keys existed has none at all: its owner may give it a first
/// key, but once anyone holds one, a different new key is refused, since it would split the members.
#[tokio::test]
async fn a_shared_project_without_keys_takes_only_a_first_key() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;

    assert_eq!(
        put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_own(&router, &alice, &pid, &key_id(2), wrapped_pek("a2")).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        put_own(&router, &bob, &pid, &key_id(3), wrapped_pek("b")).await,
        StatusCode::CONFLICT
    );
    // Copies of the project's key are stored as before: the owner's delivery, the member's own.
    assert_eq!(
        put_member(&router, &alice, &pid, &bob.id, &key_id(1), sealed_pek("s")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_own(&router, &bob, &pid, &key_id(1), wrapped_pek("b1")).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        rows_for(&router, &alice, &pid).await,
        vec![(key_id(1), "wrapped".into(), wrapped_pek("a"))]
    );
}

#[tokio::test]
async fn key_id_must_be_a_32_hex_fingerprint() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    for bad in ["", "abc", &"A".repeat(32), &"g".repeat(32), &"a".repeat(33)] {
        let (status, body) = send(
            &router,
            "PUT",
            &format!("/projects/{pid}/keys"),
            Some(&alice.token),
            json!({ "encrypted_pek": wrapped_pek("a"), "key_id": bad }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}: {body}");
    }
    let (status, _) = send(
        &router,
        "PUT",
        &format!("/projects/{pid}/keys"),
        Some(&alice.token),
        json!({ "encrypted_pek": wrapped_pek("a") }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "key_id is required");
}

#[tokio::test]
async fn single_project_key_route_is_gone() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await;
    let (status, _) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/keys"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn list_returns_every_own_row_and_the_canonical_key() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let stranger = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    let private = push_project(&router, &alice).await;

    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;
    // Bob becomes a second owner, but Alice has been an owner longer.
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    invite(&router, &alice, &carol, &pid, "commenter").await;

    // Bob fingerprints first. Alice, the earliest owner, has no fingerprinted key yet, and Bob's key
    // must not become canonical in her place (it would flip once she stores hers).
    put_own(&router, &bob, &pid, &key_id(2), wrapped_pek("b")).await;
    let body = project_keys(&router, &carol).await;
    assert_eq!(body["canonical"], json!({}), "{body}");

    store_raw_key(&alice, &pid, &key_id(1), wrapped_pek("a")).await;
    store_raw_key(&alice, &pid, &key_id(3), wrapped_pek("a3")).await;
    put_own(&router, &alice, &private, &key_id(4), wrapped_pek("p")).await;

    // Every one of Alice's rows; canonical only for projects she is a member of, and it is her
    // first fingerprinted copy even though she added another later.
    let body = project_keys(&router, &alice).await;
    let mut listed: Vec<(String, String, String)> = body["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            assert_eq!(
                k.as_object().unwrap().len(),
                8,
                "project_id, key_id, kind, encrypted_pek and the signature fields: {k}"
            );
            (
                k["project_id"].as_str().unwrap().to_string(),
                k["key_id"].as_str().unwrap().to_string(),
                k["kind"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    listed.sort();
    let mut expected = vec![
        (pid.clone(), key_id(1), "wrapped".to_string()),
        (pid.clone(), key_id(3), "wrapped".to_string()),
        (private.clone(), key_id(4), "wrapped".to_string()),
    ];
    expected.sort();
    assert_eq!(listed, expected);
    assert_eq!(body["canonical"], json!({ pid.clone(): key_id(1) }));

    // Members (a pending invitee included) see the same canonical key; a stranger sees none.
    for user in [&bob, &carol] {
        assert_eq!(
            project_keys(&router, user).await["canonical"],
            json!({ pid.clone(): key_id(1) })
        );
    }
    assert_eq!(
        project_keys(&router, &stranger).await,
        json!({ "keys": [], "canonical": {}, "retired": {} })
    );
}

#[tokio::test]
async fn a_delivery_needs_a_signature_and_names_its_signer() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    invite(&router, &alice, &carol, &pid, "editor").await;

    // Unsigned, or signed in any other shape than 64 bytes of lowercase hex: refused.
    for signature in [
        Value::Null,
        json!("AB".repeat(64)),
        json!("ab".repeat(63)),
        json!("zz".repeat(64)),
    ] {
        let (status, body) = send(
            &router,
            "PUT",
            &format!("/projects/{pid}/member-keys/{}", carol.id),
            Some(&alice.token),
            json!({ "encrypted_pek": sealed_pek("s"), "key_id": key_id(1), "signature": signature }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{signature}: {body}");
    }
    assert!(rows_for(&router, &carol, &pid).await.is_empty());

    let row = |body: &Value| {
        body["keys"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["project_id"] == pid)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        put_member(
            &router,
            &alice,
            &pid,
            &carol.id,
            &key_id(1),
            sealed_pek("a")
        )
        .await,
        StatusCode::NO_CONTENT
    );
    let delivered = row(&project_keys(&router, &carol).await);
    assert_eq!(delivered["kind"], "sealed");
    assert_eq!(delivered["signature"], SIGNATURE);
    assert_eq!(delivered["signed_by"], alice.id);
    assert_eq!(delivered["signer_public_key"], PUBLIC_KEY);
    assert_eq!(delivered["signer_signing_key"], SIGNING_KEY);

    // The signer is whoever delivered, never a field of the request.
    let (status, _) = send(
        &router,
        "PUT",
        &format!("/projects/{pid}/member-keys/{}", carol.id),
        Some(&bob.token),
        json!({
            "encrypted_pek": sealed_pek("b"),
            "key_id": key_id(1),
            "signature": "cd".repeat(64),
            "signed_by": alice.id,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let redelivered = row(&project_keys(&router, &carol).await);
    assert_eq!(redelivered["encrypted_pek"], sealed_pek("b"));
    assert_eq!(redelivered["signature"], "cd".repeat(64));
    assert_eq!(redelivered["signed_by"], bob.id);

    // The member's own copy needs no signature: storing it clears the delivery's.
    put_own(&router, &carol, &pid, &key_id(1), wrapped_pek("c")).await;
    let own = row(&project_keys(&router, &carol).await);
    assert_eq!(own["kind"], "wrapped");
    assert_eq!(own["signature"], Value::Null);
    assert_eq!(own["signed_by"], Value::Null);
    assert_eq!(own["signer_signing_key"], Value::Null);
}

#[tokio::test]
async fn members_are_listed_with_their_public_keys() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    let (status, members) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let members = members.as_array().unwrap();
    assert_eq!(members.len(), 2);
    for m in members {
        assert_eq!(m["public_key"], PUBLIC_KEY, "{m}");
        assert_eq!(m["signing_public_key"], SIGNING_KEY, "{m}");
    }
}

#[tokio::test]
async fn missing_lists_members_without_the_canonical_key() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await; // active, no key at all
    let carol = new_user(&router).await; // pending, canonical key delivered
    let dave = new_user(&router).await; // pending, only a non-canonical key
    let erin = new_user(&router).await; // active, holds the canonical key herself
    let pid = push_project(&router, &alice).await;
    for (user, role) in [
        (&bob, "editor"),
        (&carol, "commenter"),
        (&dave, "editor"),
        (&erin, "editor"),
    ] {
        invite(&router, &alice, user, &pid, role).await;
    }
    accept(&router, &bob, &pid).await;
    accept(&router, &erin, &pid).await;

    // No canonical key yet: nothing can be reported missing.
    assert!(missing(&router, &alice).await.is_empty());

    put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await;
    put_member(
        &router,
        &alice,
        &pid,
        &carol.id,
        &key_id(1),
        sealed_pek("c"),
    )
    .await;
    put_member(&router, &alice, &pid, &dave.id, &key_id(7), sealed_pek("d")).await;
    put_own(&router, &erin, &pid, &key_id(1), wrapped_pek("e")).await;

    // A delivery counts only once the member's own client has opened it and stored its own copy:
    // the fingerprint on a sealed row is whatever the sender claimed.
    let list = missing(&router, &alice).await;
    let mut users: Vec<&str> = list
        .iter()
        .map(|m| {
            assert_eq!(m["project_id"], pid);
            assert_eq!(m["key_id"], key_id(1));
            assert_eq!(m["public_key"], PUBLIC_KEY);
            m["user_id"].as_str().unwrap()
        })
        .collect();
    users.sort();
    let mut expected = vec![bob.id.as_str(), carol.id.as_str(), dave.id.as_str()];
    expected.sort();
    assert_eq!(users, expected, "{list:?}");

    // Only owners are asked to deliver.
    assert!(missing(&router, &bob).await.is_empty());
    assert!(missing(&router, &carol).await.is_empty());

    // The member list reports who holds the canonical key.
    let (status, members) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for m in members.as_array().unwrap() {
        let id = m["user_id"].as_str().unwrap();
        let expected = [&alice.id, &erin.id].iter().any(|u| *u == id);
        assert_eq!(m["has_key"], expected, "{m}");
    }
}

#[tokio::test]
async fn a_sealed_row_claiming_the_canonical_id_does_not_hide_a_member() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    invite(&router, &alice, &bob, &pid, "editor").await;
    accept(&router, &bob, &pid).await;
    put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await;

    // Garbage under the canonical fingerprint: Bob cannot open it to the canonical key.
    put_member(
        &router,
        &alice,
        &pid,
        &bob.id,
        &key_id(1),
        sealed_pek("junk"),
    )
    .await;
    let list = missing(&router, &alice).await;
    assert_eq!(list.len(), 1, "{list:?}");
    assert_eq!(list[0]["user_id"], bob.id);

    // Once Bob's client stores its own copy, he is keyed.
    put_own(&router, &bob, &pid, &key_id(1), wrapped_pek("b")).await;
    assert!(missing(&router, &alice).await.is_empty());
}

#[tokio::test]
async fn claiming_ownership_keeps_the_key_the_members_share() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    for user in [&bob, &carol] {
        invite(&router, &alice, user, &pid, "editor").await;
        accept(&router, user, &pid).await;
    }
    put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await;
    // Carol first holds a copy of a key nobody else has (the API refuses it now, older versions
    // stored it), then the real one.
    assert_eq!(
        put_own(&router, &carol, &pid, &key_id(9), wrapped_pek("junk")).await,
        StatusCode::CONFLICT
    );
    store_raw_key(&carol, &pid, &key_id(9), wrapped_pek("junk")).await;
    put_own(&router, &carol, &pid, &key_id(1), wrapped_pek("c")).await;
    put_own(&router, &bob, &pid, &key_id(1), wrapped_pek("b")).await;

    let pool = db::connect(&test_database_url()).await.expect("connect");
    sqlx::query("UPDATE users SET deletion_scheduled_at = now() WHERE id = $1::uuid")
        .bind(&alice.id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/claim-ownership"),
        Some(&carol.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Carol's first row would name a key only she holds, and nobody could read her writes.
    for user in [&bob, &carol] {
        let body = project_keys(&router, user).await;
        assert_eq!(body["canonical"][&pid], key_id(1), "{body}");
    }
}

#[tokio::test]
async fn remove_and_decline_delete_the_members_keys() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    let other = push_project(&router, &alice).await;
    put_own(&router, &alice, &pid, &key_id(1), wrapped_pek("a")).await;

    invite(&router, &alice, &bob, &pid, "editor").await;
    invite(&router, &alice, &bob, &other, "editor").await;
    invite(&router, &alice, &carol, &pid, "editor").await;
    accept(&router, &bob, &pid).await;
    for (user, project) in [(&bob, &pid), (&bob, &other), (&carol, &pid)] {
        put_member(
            &router,
            &alice,
            project,
            &user.id,
            &key_id(1),
            sealed_pek("s"),
        )
        .await;
    }
    put_own(&router, &bob, &pid, &key_id(2), wrapped_pek("b")).await;

    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(rows_for(&router, &bob, &pid).await.is_empty());
    assert_eq!(
        rows_for(&router, &bob, &other).await.len(),
        1,
        "other projects' keys stay"
    );

    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        Some(&carol.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(rows_for(&router, &carol, &pid).await.is_empty());
    assert_eq!(
        rows_for(&router, &alice, &pid).await.len(),
        1,
        "the owner keeps hers"
    );
}

/// The migration that introduces `kind`/`key_id`, run over rows stored in the pre-migration shapes.
#[tokio::test]
async fn migration_classifies_legacy_sealed_rows() {
    const HISTORY_MIGRATION: i64 = 20260923000018;

    let base = test_database_url();
    let admin = db::connect(&base).await.expect("connect");
    let name = format!("atlas_mig_{}", Uuid::now_v7().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&admin)
        .await
        .expect("create scratch database");
    let (prefix, _) = base.split_once('?').unwrap_or((&base, ""));
    let url = format!("{}/{name}", &prefix[..prefix.rfind('/').unwrap()]);

    let scratch = name.clone();
    let result = async move {
        let name = scratch;
        let pool = db::connect(&url).await.expect("connect scratch");

        // Apply everything before the history migration, from copies of the same files so the
        // checksums match when the full set runs afterwards.
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
        let dir = std::env::temp_dir().join(&name);
        std::fs::create_dir_all(&dir).unwrap();
        for entry in std::fs::read_dir(&src).unwrap() {
            let path = entry.unwrap().path();
            let file = path.file_name().unwrap().to_str().unwrap().to_string();
            let version: i64 = file.split('_').next().unwrap().parse().unwrap();
            if version < HISTORY_MIGRATION {
                std::fs::copy(&path, dir.join(&file)).unwrap();
            }
        }
        sqlx::migrate::Migrator::new(dir.as_path())
            .await
            .unwrap()
            .run(&pool)
            .await
            .expect("migrate to the previous version");
        std::fs::remove_dir_all(&dir).ok();

        let user: Uuid = sqlx::query_scalar(
            "INSERT INTO users (email, password_hash) VALUES ('m@example.com', 'x') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let (wrapped, sealed, odd) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let sealed_ct = json!({ "iv": "C".repeat(16), "ct": "c" }).to_string();
        for (pid, pek) in [
            (wrapped, json!({ "iv": "B".repeat(16), "ct": "w" })),
            (sealed, json!({ "iv": "ab".repeat(32), "ct": sealed_ct })),
            (odd, json!({ "ct": "no iv" })),
        ] {
            sqlx::query(
                "INSERT INTO project_keys (project_id, user_id, encrypted_pek) VALUES ($1, $2, $3)",
            )
            .bind(pid)
            .bind(user)
            .bind(pek)
            .execute(&pool)
            .await
            .unwrap();
        }

        db::migrate(&pool)
            .await
            .expect("apply the history migration");

        let kinds: Vec<(Uuid, String, String)> =
            sqlx::query_as("SELECT project_id, kind, key_id FROM project_keys WHERE user_id = $1")
                .bind(user)
                .fetch_all(&pool)
                .await
                .unwrap();
        let kind_of = |pid| {
            kinds
                .iter()
                .find(|(p, _, _)| *p == pid)
                .map(|(_, k, id)| (k.as_str(), id.as_str()))
        };
        assert_eq!(kind_of(wrapped), Some(("wrapped", "")));
        assert_eq!(kind_of(sealed), Some(("sealed", "")));
        assert_eq!(kind_of(odd), Some(("wrapped", "")));

        let pk: Vec<String> = sqlx::query_scalar(
            "SELECT a.attname::text FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = 'project_keys'::regclass AND i.indisprimary
              ORDER BY array_position(i.indkey, a.attnum)",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(pk, ["project_id", "user_id", "key_id"]);
        pool.close().await;
    };
    // Drop the scratch database even when an assertion fails.
    let outcome = tokio::spawn(result).await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
    )))
    .execute(&admin)
    .await
    .expect("drop scratch database");
    if let Err(e) = outcome {
        std::panic::resume_unwind(e.into_panic());
    }
}
