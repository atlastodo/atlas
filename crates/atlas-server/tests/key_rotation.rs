//! Integration tests for project key rotation (`projects::request_rotations`, the rotation routes).
//!
//! When someone who held a shared project's key leaves it, the project asks for a rotation. An
//! active owner's client mints a new key, stores its own copy, delivers it and completes the
//! rotation: the new key becomes canonical and every older one is retired, which clients still read
//! with but no longer write with.

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PUBLIC_KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> (AppState, Router) {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let state = AppState::new(
        pool,
        Config {
            database_url: test_database_url(),
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
        },
    );
    let router = app(state.clone());
    (state, router)
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

impl User {
    fn uuid(&self) -> Uuid {
        self.id.parse().unwrap()
    }
}

async fn new_user(router: &Router) -> User {
    let email = format!("rot-{}@example.com", Uuid::now_v7());
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": email, "password": PASSWORD,
            "salt": "00".repeat(16), "public_key": PUBLIC_KEY,
            "recovery_public_key": "22".repeat(32),
            "signing_public_key": "33".repeat(32), "encrypted_signing_key": wrapped,
            "encrypted_dek": wrapped, "encrypted_private_key": wrapped,
            "recovery_encrypted_dek": wrapped, "recovery_encrypted_private_key": wrapped,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email,
    }
}

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
            "value": { "__enc": 2, "kid": "dek", "iv": "AAAAAAAAAAAAAAAA", "ct": "bmFtZQ==" },
            "ts": { "wall_ms": 1000, "counter": 0, "node": Uuid::now_v7().to_string() }
        }] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    pid
}

async fn ok(router: &Router, method: &str, uri: &str, user: &User, body: Value) {
    let (status, res) = send(router, method, uri, Some(&user.token), body).await;
    assert!(status.is_success(), "{method} {uri}: {status} {res}");
}

fn key_id(n: u8) -> String {
    format!("{:02x}", n).repeat(16)
}

async fn put_own_status(router: &Router, user: &User, pid: &str, kid: &str) -> StatusCode {
    send(
        router,
        "PUT",
        &format!("/projects/{pid}/keys"),
        Some(&user.token),
        json!({ "encrypted_pek": { "v": 2, "iv": "B".repeat(16), "ct": "own" }, "key_id": kid }),
    )
    .await
    .0
}

async fn put_own(router: &Router, user: &User, pid: &str, kid: &str) {
    ok(
        router,
        "PUT",
        &format!("/projects/{pid}/keys"),
        user,
        json!({ "encrypted_pek": { "v": 2, "iv": "B".repeat(16), "ct": "own" }, "key_id": kid }),
    )
    .await;
}

async fn deliver(router: &Router, owner: &User, pid: &str, member: &User, kid: &str) {
    ok(
        router,
        "PUT",
        &format!("/projects/{pid}/member-keys/{}", member.id),
        owner,
        json!({
            "encrypted_pek": { "ephemeralPublicKey": "e".repeat(64), "encryptedKey": { "iv": "C", "ct": "D" } },
            "key_id": kid,
            "signature": "ab".repeat(64),
        }),
    )
    .await;
}

/// A shared project: `owner` keyed it with `key_id(1)`, and each member accepted and holds it.
async fn shared_project(router: &Router, owner: &User, members: &[&User]) -> String {
    let pid = push_project(router, owner).await;
    put_own(router, owner, &pid, &key_id(1)).await;
    for member in members {
        ok(
            router,
            "POST",
            &format!("/projects/{pid}/members"),
            owner,
            json!({ "email": member.email, "role": "editor" }),
        )
        .await;
        ok(
            router,
            "POST",
            &format!("/projects/{pid}/accept"),
            member,
            json!({}),
        )
        .await;
        put_own(router, member, &pid, &key_id(1)).await;
    }
    pid
}

async fn rotations(router: &Router, user: &User) -> Value {
    let (status, body) = send(
        router,
        "GET",
        "/project-keys/rotations",
        Some(&user.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn project_keys(router: &Router, user: &User) -> Value {
    let (status, body) = send(router, "GET", "/project-keys", Some(&user.token), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn complete(
    router: &Router,
    user: &User,
    pid: &str,
    kid: &str,
    request: i64,
) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        &format!("/projects/{pid}/key-rotation"),
        Some(&user.token),
        json!({ "key_id": kid, "request": request }),
    )
    .await
}

async fn remove(router: &Router, caller: &User, pid: &str, target: &User) {
    ok(
        router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", target.id),
        caller,
        json!({}),
    )
    .await;
}

async fn missing(router: &Router, user: &User) -> Vec<(String, String)> {
    let (status, body) = send(
        router,
        "GET",
        "/project-keys/missing",
        Some(&user.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["user_id"].as_str().unwrap().to_string(),
                m["key_id"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn removing_a_member_asks_the_owners_for_a_rotation() {
    let (_, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = shared_project(&router, &alice, &[&bob, &carol]).await;
    assert_eq!(rotations(&router, &alice).await, json!([]));

    remove(&router, &alice, &pid, &bob).await;
    assert_eq!(
        rotations(&router, &alice).await,
        json!([{ "project_id": pid, "request": 1 }])
    );
    // Only active owners are asked.
    assert_eq!(rotations(&router, &carol).await, json!([]));
}

#[tokio::test]
async fn completing_a_rotation_makes_the_new_key_canonical_and_retires_the_rest() {
    let (state, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let dave = new_user(&router).await;
    let pid = shared_project(&router, &alice, &[&bob, &carol]).await;
    // A forked key Carol holds alongside the canonical one, from before the server refused a second
    // key for a shared project: history too, after the rotation.
    sqlx::query(
        "INSERT INTO project_keys (project_id, user_id, key_id, kind, encrypted_pek, updated_at)
         VALUES ($1, $2, $3, 'wrapped', $4, now())",
    )
    .bind(Uuid::parse_str(&pid).unwrap())
    .bind(Uuid::parse_str(&carol.id).unwrap())
    .bind(key_id(9))
    .bind(json!({ "v": 2, "iv": "B".repeat(16), "ct": "own" }))
    .execute(&state.pool)
    .await
    .unwrap();
    remove(&router, &alice, &pid, &bob).await;

    let pool = &state.pool;
    let carol_rows_before = own_member_ops(pool, &carol, &pid).await;

    // Alice mints key 2, stores her copy, delivers it, and completes the request she was given.
    put_own(&router, &alice, &pid, &key_id(2)).await;
    deliver(&router, &alice, &pid, &carol, &key_id(2)).await;
    let (status, body) = complete(&router, &alice, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(rotations(&router, &alice).await, json!([]));

    for user in [&alice, &carol] {
        let keys = project_keys(&router, user).await;
        assert_eq!(keys["canonical"][&pid], key_id(2), "{keys}");
        let mut retired: Vec<String> = keys["retired"][&pid]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        retired.sort();
        assert_eq!(retired, vec![key_id(1), key_id(9)]);
    }
    // Bob is gone: no keys, no canonical, nothing retired for him.
    assert_eq!(
        project_keys(&router, &bob).await,
        json!({ "keys": [], "canonical": {}, "retired": {} })
    );
    // The remaining member was told (its own membership row, re-delivered to it alone).
    assert!(own_member_ops(pool, &carol, &pid).await > carol_rows_before);

    // Carol still lacks her own copy of the new key; a new member lacks it and the retired key Alice
    // holds, canonical first. Key 9, which Alice never held, she cannot deliver.
    ok(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        &alice,
        json!({ "email": dave.email, "role": "editor" }),
    )
    .await;
    let list = missing(&router, &alice).await;
    assert_eq!(
        list,
        vec![
            (carol.id.clone(), key_id(2)),
            (dave.id.clone(), key_id(2)),
            (dave.id.clone(), key_id(1)),
        ]
    );
    put_own(&router, &carol, &pid, &key_id(2)).await;
    assert_eq!(missing(&router, &alice).await.len(), 2);

    // The member list reports the new key.
    let (_, members) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    for m in members.as_array().unwrap() {
        let keyed = m["user_id"] == alice.id || m["user_id"] == carol.id;
        assert_eq!(m["has_key"], keyed, "{m}");
    }
}

/// How many ops for `user`'s own membership row of `pid` their partition holds.
async fn own_member_ops(pool: &PgPool, user: &User, pid: &str) -> i64 {
    // The server's deterministic id for a membership entity (`sync::member_entity_id`).
    const MEMBER_NAMESPACE: Uuid = Uuid::from_u128(0x4d35_5f70_726f_6a5f_6d65_6d62_6572_0001);
    let entity_id = Uuid::new_v5(&MEMBER_NAMESPACE, format!("{pid}:{}", user.id).as_bytes());
    sqlx::query_scalar(
        "SELECT count(*) FROM operations
          WHERE user_id = $1 AND entity = 'project_member' AND entity_id = $2",
    )
    .bind(user.uuid())
    .bind(entity_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_rotation_is_completed_once_by_an_owner_holding_the_key() {
    let (_, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let stranger = new_user(&router).await;
    let pid = shared_project(&router, &alice, &[&bob, &carol]).await;
    // Nothing is pending yet: a second key is refused, and there is nothing to complete.
    assert_eq!(
        put_own_status(&router, &alice, &pid, &key_id(2)).await,
        StatusCode::CONFLICT
    );
    let (status, body) = complete(&router, &alice, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "rotation_not_pending");

    remove(&router, &alice, &pid, &bob).await;
    // An editor may not mint the new key; the owner may.
    assert_eq!(
        put_own_status(&router, &carol, &pid, &key_id(5)).await,
        StatusCode::CONFLICT
    );
    put_own(&router, &alice, &pid, &key_id(2)).await;
    let (status, _) = complete(&router, &carol, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "an editor");
    let (status, _) = complete(&router, &stranger, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a stranger");
    let (status, _) = complete(&router, &alice, &pid, "nope", 1).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a malformed key id");
    let (status, _) = complete(&router, &alice, &pid, &key_id(3), 1).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a key Alice holds no copy of"
    );
    for request in [0, 2] {
        let (status, _) = complete(&router, &alice, &pid, &key_id(2), request).await;
        assert_eq!(status, StatusCode::CONFLICT, "request {request}");
    }

    let (status, _) = complete(&router, &alice, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Once it is done, another key is refused again, and a late completion loses: the first key
    // stays canonical.
    assert_eq!(
        put_own_status(&router, &alice, &pid, &key_id(4)).await,
        StatusCode::CONFLICT
    );
    let (status, body) = complete(&router, &alice, &pid, &key_id(4), 1).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "rotation_not_pending");
    assert_eq!(
        project_keys(&router, &alice).await["canonical"][&pid],
        key_id(2)
    );

    // A retired key never becomes canonical again.
    remove(&router, &alice, &pid, &carol).await;
    let (status, _) = complete(&router, &alice, &pid, &key_id(1), 2).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_removal_during_a_rotation_asks_for_another() {
    let (_, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let dave = new_user(&router).await;
    let pid = shared_project(&router, &alice, &[&bob, &carol, &dave]).await;
    remove(&router, &alice, &pid, &bob).await;
    // Alice's client works on request 1 while Carol is removed too.
    put_own(&router, &alice, &pid, &key_id(2)).await;
    remove(&router, &alice, &pid, &carol).await;
    let (status, _) = complete(&router, &alice, &pid, &key_id(2), 1).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // Carol may have received key 2: another rotation is still due.
    assert_eq!(
        rotations(&router, &alice).await,
        json!([{ "project_id": pid, "request": 2 }])
    );
    put_own(&router, &alice, &pid, &key_id(3)).await;
    let (status, _) = complete(&router, &alice, &pid, &key_id(3), 2).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(rotations(&router, &alice).await, json!([]));
    assert_eq!(
        project_keys(&router, &dave).await["canonical"][&pid],
        key_id(3)
    );
}

#[tokio::test]
async fn leaving_and_declining_rotate_only_when_a_key_was_held() {
    let (_, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let dave = new_user(&router).await;
    let erin = new_user(&router).await;
    let pid = shared_project(&router, &alice, &[&bob]).await;
    for user in [&carol, &dave, &erin] {
        ok(
            &router,
            "POST",
            &format!("/projects/{pid}/members"),
            &alice,
            json!({ "email": user.email, "role": "editor" }),
        )
        .await;
    }
    // Revoking, or declining, an invite whose key never reached the invitee rotates nothing.
    remove(&router, &alice, &pid, &carol).await;
    ok(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        &dave,
        json!({}),
    )
    .await;
    assert_eq!(rotations(&router, &alice).await, json!([]));

    // Declining after the key was delivered does.
    deliver(&router, &alice, &pid, &erin, &key_id(1)).await;
    ok(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        &erin,
        json!({}),
    )
    .await;
    assert_eq!(
        rotations(&router, &alice).await,
        json!([{ "project_id": pid, "request": 1 }])
    );

    // So does a member leaving by themselves.
    ok(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        &bob,
        json!({}),
    )
    .await;
    assert_eq!(
        rotations(&router, &alice).await,
        json!([{ "project_id": pid, "request": 2 }])
    );
}

#[tokio::test]
async fn an_unkeyed_project_never_asks_for_a_rotation() {
    let (_, router) = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    ok(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        &alice,
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    ok(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        &bob,
        json!({}),
    )
    .await;
    remove(&router, &alice, &pid, &bob).await;
    assert_eq!(rotations(&router, &alice).await, json!([]));
}
