//! Integration tests for shared-project membership, roles, and invites.

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

async fn setup() -> Router {
    setup_with_pool().await.0
}

async fn setup_with_pool() -> (Router, sqlx::PgPool) {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let config = Config {
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
        static_dir: None,
    };
    (app(AppState::new(pool.clone(), config)), pool)
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
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

struct User {
    token: String,
    id: String,
    email: String,
}

/// Adds the E2EE key material every signup must carry. Placeholders: these tests never decrypt.
fn with_keys(mut body: Value) -> Value {
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let fields = body.as_object_mut().unwrap();
    fields.insert("salt".into(), json!("00".repeat(16)));
    fields.insert("public_key".into(), json!("11".repeat(32)));
    fields.insert("recovery_public_key".into(), json!("22".repeat(32)));
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
    let email = format!("m-{}@example.com", Uuid::now_v7());
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

/// Create a project in `owner`'s sync store by pushing a single field op, so membership endpoints
/// (which check store-ownership) recognise them as the owner. Returns the project id.
async fn push_project(router: &Router, owner: &User) -> String {
    let pid = Uuid::now_v7().to_string();
    let (status, _) = send(
        router,
        "POST",
        "/sync/push",
        Some(&owner.token),
        json!({
            "operations": [{
                "id": Uuid::now_v7().to_string(),
                "entity": "project",
                "entity_id": pid,
                "op": "set",
                "field": "name",
                "value": "Shared",
                "ts": { "wall_ms": 1000, "counter": 0, "node": Uuid::now_v7().to_string() }
            }]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    pid
}

#[tokio::test]
async fn invite_accept_and_list() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // Alice invites Bob as editor -> pending.
    let (status, view) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "invite: {view}");
    assert_eq!(view["role"], "editor");
    assert_eq!(view["state"], "pending");
    assert_eq!(view["user_id"], bob.id);

    // Bob accepts.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Bob can now list members: himself (active editor) + Alice (owner).
    let (status, list) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let members = list.as_array().unwrap();
    assert_eq!(members.len(), 2);
    let owner = members.iter().find(|m| m["role"] == "owner").unwrap();
    assert_eq!(owner["user_id"], alice.id);
    assert_eq!(owner["state"], "active");
    let editor = members.iter().find(|m| m["role"] == "editor").unwrap();
    assert_eq!(editor["state"], "active");
}

#[tokio::test]
async fn invite_decline_removes_the_pending_invite() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // Alice invites Bob -> Bob has one pending invite.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, invites) = send(&router, "GET", "/invites", Some(&bob.token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(invites.as_array().unwrap().len(), 1);

    // Bob declines.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The invite is gone, and Bob is not a member (still a non-member -> 404 on the member list).
    let (_, invites) = send(&router, "GET", "/invites", Some(&bob.token), json!({})).await;
    assert_eq!(invites.as_array().unwrap().len(), 0);
    let (status, _) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Declining again (nothing pending) is a 404.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn non_member_cannot_list() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    let (status, _) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&carol.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invite_unknown_email_is_404() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": "nobody@example.com", "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn non_owner_cannot_invite_or_change_roles() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let carol = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // Alice invites Bob (commenter) and he accepts.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "commenter" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;

    // Bob (commenter) cannot invite Carol.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&bob.token),
        json!({ "email": carol.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Bob cannot promote himself.
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&bob.token),
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn owner_can_change_role_and_remove() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "commenter" }),
    )
    .await;

    // Promote Bob to editor.
    let (status, view) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["role"], "editor");

    // Remove Bob.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Bob is gone from the list.
    let (status, list) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn cannot_invite_to_a_project_you_dont_own() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    // A project id Alice never created in her store.
    let pid = Uuid::now_v7().to_string();

    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn cannot_remove_or_demote_the_last_owner() {
    // The sole owner of a shared project can't self-leave or self-demote: that would orphan the
    // project (no one could then manage members). Promoting a second owner
    // lifts the guard.
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    // Bootstrap Alice as owner + add Bob as editor.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Alice is the sole owner: she can neither self-leave...
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", alice.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "last owner cannot leave");

    // ...nor demote herself.
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", alice.id),
        Some(&alice.token),
        json!({ "role": "editor" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "last owner cannot be demoted"
    );

    // Promote Bob to a second owner; now Alice may leave.
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", alice.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "with a second owner, the first can leave"
    );
}

async fn pull_ops(router: &Router, user: &User) -> Vec<Value> {
    let (status, body) = send(
        router,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&user.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    body["operations"].as_array().unwrap().clone()
}

/// The entity id of `user`'s own `project_member` row for `pid` in `ops`, if one was delivered.
fn member_row_id(ops: &[Value], pid: &str, user: &User) -> Option<String> {
    let ids = |field: &str, value: &str| -> Vec<String> {
        ops.iter()
            .filter(|o| {
                o["entity"] == "project_member" && o["field"] == field && o["value"] == value
            })
            .map(|o| o["entity_id"].as_str().unwrap().to_string())
            .collect()
    };
    let for_project = ids("project_id", pid);
    ids("user_id", &user.id)
        .into_iter()
        .find(|id| for_project.contains(id))
}

fn deleted(ops: &[Value], entity: &str, id: &str) -> bool {
    ops.iter()
        .any(|o| o["op"] == "delete" && o["entity"] == entity && o["entity_id"] == id)
}

#[tokio::test]
async fn invites_carry_raw_project_fields_and_the_sealed_key() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    let envelope = json!({ "__enc": 1, "iv": "AAAAAAAAAAAAAAAA", "ct": "bmFtZQ==" });
    let (status, _) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&alice.token),
        json!({ "operations": [
            { "id": Uuid::now_v7(), "entity": "project", "entity_id": pid, "op": "set",
              "field": "name", "value": envelope,
              "ts": { "wall_ms": 2000, "counter": 0, "node": Uuid::now_v7() } },
            { "id": Uuid::now_v7(), "entity": "project", "entity_id": pid, "op": "set",
              "field": "icon", "value": "star",
              "ts": { "wall_ms": 2000, "counter": 0, "node": Uuid::now_v7() } },
        ] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;

    let (status, invites) = send(&router, "GET", "/invites", Some(&bob.token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let invite = &invites.as_array().unwrap()[0];
    let mut keys: Vec<&str> = invite
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "invited_at",
            "inviter",
            "project",
            "project_id",
            "role",
            "sealed_key"
        ]
    );
    assert_eq!(invite["project_id"], pid);
    assert_eq!(invite["role"], "editor");
    assert!(invite["invited_at"].as_i64().unwrap() > 1_700_000_000_000);
    assert_eq!(invite["inviter"]["user_id"], alice.id);
    assert_eq!(invite["inviter"]["email"], alice.email);
    assert!(invite["inviter"]["display_name"].is_string());
    // Values are handed over as stored: an envelope stays an object, never its JSON text.
    assert_eq!(
        invite["project"],
        json!({ "name": envelope, "icon": "star", "color": null, "kind": null })
    );
    assert_eq!(invite["sealed_key"], Value::Null);

    // After deliveries, the newest sealed key rides along.
    for (n, ct) in [(1u8, "first"), (2, "second")] {
        let (status, _) = send(
            &router,
            "PUT",
            &format!("/projects/{pid}/member-keys/{}", bob.id),
            Some(&alice.token),
            json!({
                "encrypted_pek": { "iv": "e".repeat(64), "ct": ct },
                "key_id": format!("{n:02x}").repeat(16),
                "signature": "ab".repeat(64),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }
    let (_, invites) = send(&router, "GET", "/invites", Some(&bob.token), json!({})).await;
    assert_eq!(
        invites[0]["sealed_key"],
        json!({
            "key_id": "02".repeat(16),
            "encrypted_pek": { "iv": "e".repeat(64), "ct": "second" },
        })
    );
}

#[tokio::test]
async fn invitee_receives_its_pending_member_row_until_it_declines() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;

    // Right after the invite, Bob's partition holds his own pending row, and nothing else of the
    // project: not its data, not the owner's membership.
    let ops = pull_ops(&router, &bob).await;
    let row = member_row_id(&ops, &pid, &bob).expect("the invitee's own member row");
    let field = |name: &str| {
        ops.iter()
            .find(|o| o["entity_id"] == row && o["field"] == name)
            .map(|o| o["value"].clone())
    };
    assert_eq!(field("state"), Some(json!("pending")));
    assert_eq!(field("role"), Some(json!("editor")));
    assert!(member_row_id(&ops, &pid, &alice).is_none());
    assert!(!ops.iter().any(|o| o["entity"] == "project"));

    // Declining tombstones the row for Bob and for the members who were shown the invite.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/decline"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(deleted(
        &pull_ops(&router, &bob).await,
        "project_member",
        &row
    ));
    assert!(deleted(
        &pull_ops(&router, &alice).await,
        "project_member",
        &row
    ));
}

#[tokio::test]
async fn revoking_an_invite_removes_the_invitees_row_only() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "commenter" }),
    )
    .await;
    let row = member_row_id(&pull_ops(&router, &bob).await, &pid, &bob).unwrap();

    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let ops = pull_ops(&router, &bob).await;
    assert!(deleted(&ops, "project_member", &row));
    // Bob never held the project, so it isn't tombstoned in his partition: that tombstone would
    // outrank the backfill and hide the project if he is invited again and accepts.
    assert!(!deleted(&ops, "project", &pid));
}

/// A failed backfill leaves the invite pending: the accept and the backfill commit together, so
/// the invitee can accept again instead of meeting a 404 and a project that never arrived.
#[tokio::test]
async fn a_failed_accept_leaves_the_invite_pending() {
    let (router, pool) = setup_with_pool().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // A stored HLC the backfill cannot copy makes it fail.
    let set_counter = |counter: i32| {
        let pool = pool.clone();
        let (alice, pid) = (
            alice.id.parse::<Uuid>().unwrap(),
            pid.parse::<Uuid>().unwrap(),
        );
        async move {
            sqlx::query(
                "UPDATE entity_fields SET hlc_counter = $3
                  WHERE user_id = $1 AND entity = 'project' AND entity_id = $2",
            )
            .bind(alice)
            .bind(pid)
            .bind(counter)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    set_counter(-1).await;
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert!(!status.is_success(), "the backfill fails: {status}");
    let (_, invites) = send(&router, "GET", "/invites", Some(&bob.token), json!({})).await;
    assert_eq!(invites[0]["project_id"], pid, "the invite is still pending");
    assert!(!pull_ops(&router, &bob)
        .await
        .iter()
        .any(|o| o["entity"] == "project"));

    set_counter(0).await;
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "accepting again works");
    let ops = pull_ops(&router, &bob).await;
    assert!(ops
        .iter()
        .any(|o| o["entity_id"] == pid.as_str() && o["value"] == "Shared"));
    let row = member_row_id(&ops, &pid, &bob).unwrap();
    assert!(ops.iter().any(|o| o["entity_id"] == row.as_str()
        && o["field"] == "state"
        && o["value"] == "active"));
}

/// Inviting someone who is already an active member is refused and leaves their role alone; a
/// pending invite can still be re-sent with another role.
#[tokio::test]
async fn inviting_an_active_member_is_a_conflict() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    let invite = |role: &'static str| {
        let (router, token, email, pid) = (
            router.clone(),
            alice.token.clone(),
            bob.email.clone(),
            pid.clone(),
        );
        async move {
            send(
                &router,
                "POST",
                &format!("/projects/{pid}/members"),
                Some(&token),
                json!({ "email": email, "role": role }),
            )
            .await
        }
    };

    assert_eq!(invite("commenter").await.0, StatusCode::CREATED);
    let (status, view) = invite("editor").await;
    assert_eq!(status, StatusCode::CREATED, "a pending invite is updated");
    assert_eq!(view["role"], "editor");

    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = invite("commenter").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "already_member");

    let (_, list) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    let row = list
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == bob.id.as_str())
        .unwrap();
    assert_eq!(row["role"], "editor", "the role is unchanged");
    assert_eq!(row["state"], "active");
}

/// Two owners taken out at once — one demoted, the other removed — cannot leave the project with
/// no owner: the second request sees the first one's change and is refused.
#[tokio::test]
async fn concurrent_demotion_and_removal_keep_an_owner() {
    let (router, pool) = setup_with_pool().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    send(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "owner" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Hold the membership rows, so both requests are in flight before either can write.
    let project: Uuid = pid.parse().unwrap();
    let mut hold = pool.begin().await.unwrap();
    let holder: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *hold)
        .await
        .unwrap();
    sqlx::query("SELECT 1 FROM project_members WHERE project_id = $1 FOR UPDATE")
        .bind(project)
        .execute(&mut *hold)
        .await
        .unwrap();
    let demote = tokio::spawn({
        let (router, uri, token) = (
            router.clone(),
            format!("/projects/{pid}/members/{}", bob.id),
            alice.token.clone(),
        );
        async move {
            send(
                &router,
                "PATCH",
                &uri,
                Some(&token),
                json!({ "role": "editor" }),
            )
            .await
        }
    });
    let remove = tokio::spawn({
        let (router, uri, token) = (
            router.clone(),
            format!("/projects/{pid}/members/{}", alice.id),
            bob.token.clone(),
        );
        async move { send(&router, "DELETE", &uri, Some(&token), json!({})).await }
    });
    wait_for_blocked(&pool, holder, 2).await;
    hold.commit().await.unwrap();

    let statuses = [demote.await.unwrap().0, remove.await.unwrap().0];
    assert_eq!(
        statuses.iter().filter(|s| s.is_success()).count(),
        1,
        "one goes through: {statuses:?}"
    );
    assert!(
        statuses.contains(&StatusCode::BAD_REQUEST),
        "the other is refused: {statuses:?}"
    );
    let owners: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_members
          WHERE project_id = $1 AND role = 'owner' AND state = 'active'",
    )
    .bind(project)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owners, 1, "the project keeps an owner ({statuses:?})");
}

/// `user`'s partition past `since`, and its new cursor.
async fn pull_since(router: &Router, user: &User, since: i64) -> (Vec<Value>, i64) {
    let (status, body) = send(
        router,
        "GET",
        &format!("/sync/pull?since={since}&limit=1000"),
        Some(&user.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (
        body["operations"].as_array().unwrap().clone(),
        body["cursor"].as_i64().unwrap(),
    )
}

/// Whose `project_member` rows `ops` carry, sorted and deduplicated (a joiner's backfill copies the
/// rows too), checking that each row came whole.
fn member_rows(ops: &[Value]) -> Vec<String> {
    let member_ops: Vec<&Value> = ops
        .iter()
        .filter(|o| o["entity"] == "project_member")
        .collect();
    let mut users: Vec<String> = member_ops
        .iter()
        .filter(|o| o["field"] == "user_id")
        .map(|o| o["value"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        member_ops.len(),
        users.len() * 7,
        "whole rows: {member_ops:?}"
    );
    users.sort();
    users.dedup();
    users
}

fn sorted(ids: &[&User]) -> Vec<String> {
    let mut ids: Vec<String> = ids.iter().map(|u| u.id.clone()).collect();
    ids.sort();
    ids
}

async fn invite(router: &Router, owner: &User, pid: &str, invitee: &User) {
    let (status, body) = send(
        router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&owner.token),
        json!({ "email": invitee.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
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
    assert_eq!(status, StatusCode::NO_CONTENT);
}

/// A membership change delivers the one row it changed, not the whole list to every member; only a
/// joiner gets the whole list, which it did not have.
#[tokio::test]
async fn a_membership_change_delivers_only_the_changed_row() {
    let router = setup().await;
    let [alice, bob, carol, dave] = [
        new_user(&router).await,
        new_user(&router).await,
        new_user(&router).await,
        new_user(&router).await,
    ];
    let pid = push_project(&router, &alice).await;

    // The first share: the owner gets its own new row, the invitee only its pending row.
    invite(&router, &alice, &pid, &bob).await;
    let (ops, _) = pull_since(&router, &alice, 0).await;
    assert_eq!(member_rows(&ops), sorted(&[&alice]));
    let (ops, _) = pull_since(&router, &bob, 0).await;
    assert_eq!(member_rows(&ops), sorted(&[&bob]));
    accept(&router, &bob, &pid).await;
    invite(&router, &alice, &pid, &carol).await;

    let (_, alice_at) = pull_since(&router, &alice, 0).await;
    let (_, bob_at) = pull_since(&router, &bob, 0).await;
    let (_, carol_at) = pull_since(&router, &carol, 0).await;

    // Carol joins: she gets every active member's row, the others only hers.
    accept(&router, &carol, &pid).await;
    let (ops, alice_at) = pull_since(&router, &alice, alice_at).await;
    assert_eq!(member_rows(&ops), sorted(&[&carol]));
    let (ops, bob_at) = pull_since(&router, &bob, bob_at).await;
    assert_eq!(member_rows(&ops), sorted(&[&carol]));
    let (ops, carol_at) = pull_since(&router, &carol, carol_at).await;
    assert_eq!(member_rows(&ops), sorted(&[&alice, &bob, &carol]));

    // A role change goes out as that member's row, to every active member.
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({ "role": "commenter" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut cursors = Vec::new();
    for (user, since) in [(&alice, alice_at), (&bob, bob_at), (&carol, carol_at)] {
        let (ops, at) = pull_since(&router, user, since).await;
        assert_eq!(member_rows(&ops), sorted(&[&bob]));
        assert!(ops
            .iter()
            .any(|o| o["field"] == "role" && o["value"] == "commenter"));
        cursors.push(at);
    }

    // A new invite reaches only the invitee.
    invite(&router, &alice, &pid, &dave).await;
    for (user, since) in [&alice, &bob, &carol].into_iter().zip(cursors) {
        let (ops, _) = pull_since(&router, user, since).await;
        assert!(member_rows(&ops).is_empty(), "{ops:?}");
    }
    let (ops, _) = pull_since(&router, &dave, 0).await;
    assert_eq!(member_rows(&ops), sorted(&[&dave]));
}

/// A first invite that fails leaves the project unshared, so the next one still delivers the
/// owner's own row.
#[tokio::test]
async fn a_failed_first_invite_does_not_share_the_project() {
    let router = setup().await;
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let pid = push_project(&router, &alice).await;

    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": format!("nobody-{}@example.com", Uuid::now_v7()), "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, list) = send(
        &router,
        "GET",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, json!([]), "still private");

    invite(&router, &alice, &pid, &bob).await;
    let (ops, _) = pull_since(&router, &alice, 0).await;
    assert_eq!(member_rows(&ops), sorted(&[&alice]));
}

/// Wait until `n` backends are blocked behind `holder` (a `pg_backend_pid()`), so concurrent
/// requests are known to be queued on a held lock instead of guessing with a sleep. Gives up
/// after ten seconds; the test's own assertions then decide.
async fn wait_for_blocked(pool: &sqlx::PgPool, holder: i32, n: i64) {
    for _ in 0..1000 {
        let blocked: i64 = sqlx::query_scalar(
            // Directly or through another waiter: a second request for the same row queues
            // behind the first.
            "WITH RECURSIVE blocked(pid) AS (
                 SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
                 UNION
                 SELECT a.pid FROM pg_stat_activity a, blocked b
                  WHERE b.pid = ANY(pg_blocking_pids(a.pid)))
             SELECT count(*) FROM blocked",
        )
        .bind(holder)
        .fetch_one(pool)
        .await
        .unwrap();
        if blocked >= n {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}
