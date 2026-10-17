//! Integration tests for shared-project sync fan-out.
//!
//! A push on a shared project must replicate to every active member's partition and live channel,
//! be gated by the caller's role, and stop reaching a member once they're removed. Invite-accept
//! backfills the project's current state into the new member.

use std::collections::HashSet;
use std::time::Duration;

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;
use uuid::Uuid;

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn make_state() -> AppState {
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
        apps: vec!["todo".into()],
        passkeys: None,
        android_asset_links: None,
        static_dir: None,
    };
    AppState::new(pool, config)
}

async fn http(
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
    let email = format!("s-{}@example.com", Uuid::now_v7());
    let (status, body) = http(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email,
    }
}

fn op(entity: &str, entity_id: &str, field: &str, value: Value, wall: u64) -> Value {
    json!({
        "id": Uuid::now_v7(), "entity": entity, "entity_id": entity_id,
        "op": "set", "field": field, "value": value,
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

async fn push(router: &Router, token: &str, ops: Vec<Value>) -> StatusCode {
    let (status, _) = http(
        router,
        "POST",
        "/sync/push",
        Some(token),
        json!({ "operations": ops }),
    )
    .await;
    status
}

async fn invite_and_accept(router: &Router, owner: &User, invitee: &User, pid: &str, role: &str) {
    let (status, _) = http(
        router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&owner.token),
        json!({ "email": invitee.email, "role": role }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "invite");
    let (status, _) = http(
        router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&invitee.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "accept");
}

/// Read WS messages until one carries a matching field/value, or time out.
async fn wait_for_field(
    ws: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
    field: &str,
    value: &str,
    secs: u64,
) -> bool {
    tokio::time::timeout(Duration::from_secs(secs), async {
        while let Some(Ok(msg)) = ws.next().await {
            if let WsMessage::Text(text) = msg {
                let payload: Value = serde_json::from_str(&text).unwrap();
                for op in payload["operations"].as_array().unwrap_or(&vec![]) {
                    if op["field"] == field && op["value"] == value {
                        return true;
                    }
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

async fn spawn_server(state: &AppState) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = app(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });
    addr.to_string()
}

#[tokio::test]
async fn accept_backfills_and_edits_fan_out_to_member() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    // Alice creates a project and a task inside it.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("project", &pid, "name", json!("Team"), 100)]
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "project_id", json!(pid), 200),
                op("task", &tid, "title", json!("orig"), 200),
            ],
        )
        .await,
        StatusCode::OK
    );

    // Share with Bob (editor) and accept.
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // Bob connects: the accept backfill should have delivered the task into his partition.
    let (status, ticket) = http(
        &control,
        "POST",
        "/sync/ws-ticket",
        Some(&bob.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ticket:?}");
    let url = format!(
        "ws://{addr}/sync/ws?ticket={}&since=0&protocol=6",
        ticket["ticket"].as_str().unwrap()
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("ws");
    assert!(
        wait_for_field(&mut ws, "title", "orig", 5).await,
        "accept should backfill the existing task to the new member"
    );

    // A live edit by Alice fans out to Bob.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "title", json!("updated"), 300)]
        )
        .await,
        StatusCode::OK
    );
    assert!(
        wait_for_field(&mut ws, "title", "updated", 5).await,
        "a shared-project edit should reach the co-member live"
    );
}

#[tokio::test]
async fn task_title_fans_out_when_emitted_before_project_id() {
    // The real client emits a task's `title` op BEFORE its `project_id` op. Fan-out
    // must resolve the owning project from the whole batch, not only fields folded earlier, or the
    // co-member receives a nameless task.
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    // Alice creates and shares a project with Bob.
    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("Team"), 100)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // Alice adds a task AFTER sharing, in one batch with `title` before `project_id`.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "title", json!("Buy milk"), 500),
                op("task", &tid, "priority", json!(4), 500),
                op("task", &tid, "project_id", json!(pid), 500),
            ],
        )
        .await,
        StatusCode::OK
    );

    // Bob's partition must receive the task's title.
    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&bob.token),
        json!({}),
    )
    .await;
    let has_title = pull["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["entity"] == "task" && o["field"] == "title" && o["value"] == "Buy milk");
    assert!(
        has_title,
        "task title must fan out to co-members even when emitted before project_id"
    );
}

#[tokio::test]
async fn any_active_member_can_edit_tasks_but_not_the_project_entity() {
    // Every active member (even a commenter-role) has full admin over tasks and sections, but
    // editing the project entity's own fields still needs Editor+.
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let carol = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![
            op("task", &tid, "project_id", json!(pid), 200),
            op("task", &tid, "title", json!("orig"), 200),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &carol, &pid, "commenter").await;

    // A commenter-role member may now edit a task field...
    assert_eq!(
        push(
            &control,
            &carol.token,
            vec![op("task", &tid, "title", json!("edited"), 400)]
        )
        .await,
        StatusCode::OK
    );

    // ...and create a section...
    let sid = Uuid::now_v7().to_string();
    assert_eq!(
        push(
            &control,
            &carol.token,
            vec![op("section", &sid, "project_id", json!(pid), 450)]
        )
        .await,
        StatusCode::OK
    );

    // ...but may NOT edit the project entity itself (rename needs Editor+).
    assert_eq!(
        push(
            &control,
            &carol.token,
            vec![op("project", &pid, "name", json!("renamed"), 460)]
        )
        .await,
        StatusCode::FORBIDDEN
    );

    // And may still post a comment.
    let cid = Uuid::now_v7().to_string();
    assert_eq!(
        push(
            &control,
            &carol.token,
            vec![
                op("comment", &cid, "task_id", json!(tid), 500),
                op("comment", &cid, "body", json!("looks good"), 500),
            ],
        )
        .await,
        StatusCode::OK
    );

    // The comment reached the owner's partition (fanned out).
    let (status, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let has_comment =
        pull["operations"].as_array().unwrap().iter().any(|o| {
            o["entity"] == "comment" && o["field"] == "body" && o["value"] == "looks good"
        });
    assert!(has_comment, "comment should fan out to the project owner");
}

#[tokio::test]
async fn only_owner_can_delete_or_archive_a_shared_project() {
    // Deleting/archiving the project entity itself is owner-only, so an editor can't remove a shared
    // project out from under its owner (they leave instead). Editors keep rename/restyle.
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // An editor may rename/restyle the project entity...
    assert_eq!(
        push(
            &control,
            &bob.token,
            vec![op("project", &pid, "name", json!("renamed by editor"), 300)]
        )
        .await,
        StatusCode::OK,
        "editor may rename a shared project"
    );

    // ...but may NOT soft-delete it...
    assert_eq!(
        push(
            &control,
            &bob.token,
            vec![op("project", &pid, "deleted_at", json!(400), 400)]
        )
        .await,
        StatusCode::FORBIDDEN,
        "editor must not soft-delete a shared project"
    );

    // ...nor archive it.
    assert_eq!(
        push(
            &control,
            &bob.token,
            vec![op("project", &pid, "archived_at", json!(500), 500)]
        )
        .await,
        StatusCode::FORBIDDEN,
        "editor must not archive a shared project"
    );

    // The owner may soft-delete it, and it fans out to the editor's partition.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("project", &pid, "deleted_at", json!(600), 600)]
        )
        .await,
        StatusCode::OK,
        "owner may soft-delete a shared project"
    );
    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&bob.token),
        json!({}),
    )
    .await;
    let deleted_fanned_out = pull["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["entity"] == "project" && o["field"] == "deleted_at" && o["value"] == 600);
    assert!(
        deleted_fanned_out,
        "the owner's delete should reach every member"
    );
}

#[tokio::test]
async fn owner_can_delete_a_private_project() {
    // A project with no members is private to its creator: no membership gate applies, so the owner
    // can soft-delete it freely.
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("private"), 100)],
    )
    .await;
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("project", &pid, "deleted_at", json!(200), 200)]
        )
        .await,
        StatusCode::OK,
        "an unshared project's owner may delete it"
    );
}

#[tokio::test]
async fn removed_member_stops_receiving_ops() {
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![op("task", &tid, "project_id", json!(pid), 200)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // Remove Bob.
    let (status, _) = http(
        &control,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Alice edits after the removal.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "title", json!("after-removal"), 900)]
        )
        .await,
        StatusCode::OK
    );

    // Bob's partition never receives the post-removal edit.
    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&bob.token),
        json!({}),
    )
    .await;
    let leaked = pull["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["value"] == "after-removal");
    assert!(!leaked, "a removed member must not receive further ops");
}

/// A project with a section, a task and a comment on it, shared by Alice with Bob. Returns the
/// project id and the ids of its items.
async fn shared_project_with_items(
    control: &Router,
    alice: &User,
    bob: &User,
) -> (String, Vec<String>) {
    let pid = Uuid::now_v7().to_string();
    let sid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();
    let cid = Uuid::now_v7().to_string();
    let ops = vec![
        op("project", &pid, "name", json!("P"), 100),
        op("section", &sid, "project_id", json!(pid), 110),
        op("task", &tid, "project_id", json!(pid), 120),
        op("comment", &cid, "task_id", json!(tid), 130),
    ];
    assert_eq!(push(control, &alice.token, ops).await, StatusCode::OK);
    invite_and_accept(control, alice, bob, &pid, "editor").await;
    (pid.clone(), vec![pid, sid, tid, cid])
}

/// Every item of the project and every membership row is hidden in `ops`.
fn project_revoked(ops: &[Value], items: &[String]) {
    for id in items {
        assert!(task_hidden(ops, id), "item {id} still shows");
    }
    let members: HashSet<&str> = ops
        .iter()
        .filter(|o| o["entity"] == "project_member")
        .map(|o| o["entity_id"].as_str().unwrap())
        .collect();
    assert!(members.len() >= 2, "the leaver held both memberships");
    for id in members {
        assert!(task_hidden(ops, id), "membership {id} still shows");
    }
}

#[tokio::test]
async fn leaving_a_project_revokes_all_of_it_from_the_leaver() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (pid, items) = shared_project_with_items(&control, &alice, &bob).await;

    let (status, _) = http(
        &control,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    project_revoked(&partition_ops(&control, &bob).await, &items);
    // Alice keeps her copy.
    let alice_ops = partition_ops(&control, &alice).await;
    assert!(items.iter().all(|id| !task_hidden(&alice_ops, id)));
}

/// Members who left before leaving revoked everything kept the project's items and the other
/// memberships; the startup sweep revokes them.
#[tokio::test]
async fn the_sweep_revokes_what_earlier_leavers_kept() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (pid, items) = shared_project_with_items(&control, &alice, &bob).await;

    // The old leave: Bob's membership goes, his partition gets only a project tombstone.
    let (project_id, bob_id) = (
        Uuid::parse_str(&pid).unwrap(),
        Uuid::parse_str(&bob.id).unwrap(),
    );
    sqlx::query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(bob_id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO entity_tombstones (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, 'project', $2, 1, 0, $3)",
    )
    .bind(bob_id)
    .bind(project_id)
    .bind(Uuid::nil())
    .execute(&state.pool)
    .await
    .unwrap();
    assert!(!task_hidden(
        &partition_ops(&control, &bob).await,
        &items[2]
    ));

    // At least this one: other tests share the database.
    assert!(
        atlas_server::sync::revoke_left_projects(&state)
            .await
            .unwrap()
            >= 1
    );
    project_revoked(&partition_ops(&control, &bob).await, &items);

    // A second run finds nothing left to revoke, and says so.
    let before = partition_ops(&control, &bob).await.len();
    assert_eq!(
        atlas_server::sync::revoke_left_projects(&state)
            .await
            .unwrap(),
        0
    );
    assert_eq!(partition_ops(&control, &bob).await.len(), before);
}

#[tokio::test]
async fn assignee_must_be_a_project_member() {
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let stranger = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![op("task", &tid, "project_id", json!(pid), 200)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // Assigning a member succeeds.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "assignee_id", json!(bob.id), 300)]
        )
        .await,
        StatusCode::OK
    );

    // Assigning a non-member is rejected.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "assignee_id", json!(stranger.id), 400)]
        )
        .await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn activity_actor_is_server_stamped_to_the_caller() {
    // An activity's actor_id must be stamped to the authenticated caller, so a member
    // cannot forge activity-feed history attributed to another member.
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let carol = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![
            op("task", &tid, "project_id", json!(pid), 200),
            op("task", &tid, "title", json!("t"), 200),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &carol, &pid, "commenter").await;

    // Carol pushes an activity forging Alice as the actor.
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push(
            &control,
            &carol.token,
            vec![
                op("activity", &aid, "task_id", json!(tid), 500),
                op("activity", &aid, "actor_id", json!(alice.id), 500),
                op("activity", &aid, "kind", json!("status"), 500),
            ],
        )
        .await,
        StatusCode::OK
    );

    // When Alice pulls, the activity's actor_id is Carol (server-stamped), not the forged Alice.
    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&alice.token),
        json!({}),
    )
    .await;
    let actor = pull["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["entity"] == "activity" && o["field"] == "actor_id")
        .and_then(|o| o["value"].as_str())
        .map(str::to_string);
    assert_eq!(
        actor.as_deref(),
        Some(carol.id.as_str()),
        "actor_id must be server-stamped to the pushing member, not the forged value"
    );
}

#[tokio::test]
async fn rejects_implausibly_future_hlc_wall_clock() {
    // An op timestamped far in the future would win field-level LWW forever. On a shared
    // project that lets any member pin a field's value against every co-member permanently, so the
    // push path rejects a wall clock beyond a small future skew. Past timestamps stay fine.
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let tid = Uuid::now_v7().to_string();

    // wall_ms in the year ~2255 — a valid i64, but far past any plausible clock skew.
    let far_future: u64 = 9_000_000_000_000;
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&alice.token),
        json!({ "operations": [op("task", &tid, "title", json!("pinned"), far_future)] }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a far-future HLC wall clock must be rejected"
    );
    // Coded, with the server's clock, so a client can tell a skewed clock (transient: fix the
    // clock and retry) from a permanently bad batch.
    assert_eq!(body["code"], "clock_skew", "{body:?}");
    let server_time = body["server_time"].as_i64().expect("server_time");
    let local = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!(
        (server_time - local).abs() < 60_000,
        "{server_time} vs {local}"
    );

    // A current-time timestamp is accepted.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "title", json!("ok"), now_ms)]
        )
        .await,
        StatusCode::OK,
        "a current-time HLC wall clock is fine"
    );
}

#[tokio::test]
async fn cannot_hijack_ownership_of_another_users_private_project() {
    // A client may push a `project` Set op with ANY entity_id into its own partition. Ownership
    // of a not-yet-shared project must NOT be inferred from that caller-writable partition, or an
    // attacker who learns a victim's project UUID could plant a matching op and then bootstrap
    // themselves as owner via the invite endpoint — locking the real owner out of their own project.
    let state = make_state().await;
    let control = app(state.clone());

    let alice = new_user(&control).await; // genuine creator
    let mallory = new_user(&control).await; // attacker
    let carol = new_user(&control).await; // invite target
    let pid = Uuid::now_v7().to_string();

    // Alice creates a private project (committed first → lowest server_seq for this project entity).
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("project", &pid, "name", json!("Secret"), 100)]
        )
        .await,
        StatusCode::OK
    );

    // Mallory plants a project op with Alice's project UUID in her own partition.
    assert_eq!(
        push(
            &control,
            &mallory.token,
            vec![op("project", &pid, "name", json!("Pwned"), 200)]
        )
        .await,
        StatusCode::OK
    );

    // Mallory tries to bootstrap herself as owner by inviting someone → must be rejected (404):
    // she did not create this project, so she can't manage it.
    let (status, _) = http(
        &control,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&mallory.token),
        json!({ "email": carol.email, "role": "editor" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "an attacker must not manage a project they didn't create"
    );

    // And Alice retains sync access to her own project (project is not silently marked shared).
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op(
                "task",
                &Uuid::now_v7().to_string(),
                "project_id",
                json!(pid),
                300
            )]
        )
        .await,
        StatusCode::OK
    );

    // The genuine creator can still share it.
    let (status, _) = http(
        &control,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": carol.email, "role": "editor" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "the real creator can still share the project"
    );
}

/// The shape of a client field-encryption envelope (`{"__enc":1,"iv","ct"}`).
fn envelope() -> Value {
    json!({ "__enc": 1, "iv": "AAAAAAAAAAAAAAAA", "ct": "Y2lwaGVydGV4dA==" })
}

#[tokio::test]
async fn envelopes_in_server_read_fields_are_rejected() {
    // Fan-out, the assignee membership check and blob authz read these values. An envelope there
    // is invisible to the server (an encrypted assignee_id skipped the membership check, an
    // encrypted project_id kept a task from fanning out), so push refuses it outright.
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();
    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", envelope(), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![op("task", &tid, "project_id", json!(pid), 200)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    let sha = "ab".repeat(32);
    let cases: [(&str, &str, Value); 12] = [
        ("task", "assignee_id", envelope()),
        ("task", "project_id", envelope()),
        ("task", "project_id", json!("inbox")),
        ("task", "assignee_id", json!(42)),
        ("section", "project_id", envelope()),
        ("comment", "task_id", envelope()),
        ("activity", "task_id", envelope()),
        ("activity", "actor_id", envelope()),
        ("attachment", "task_id", envelope()),
        ("attachment", "blob_sha", envelope()),
        ("attachment", "thumb_sha", json!(pid)),
        ("attachment", "blob_sha", json!(format!("{sha}0"))),
    ];
    for (entity, field, value) in cases {
        let eid = if entity == "task" {
            tid.clone()
        } else {
            Uuid::now_v7().to_string()
        };
        let (status, body) = http(
            &control,
            "POST",
            "/sync/push",
            Some(&alice.token),
            json!({ "operations": [
                op(entity, &eid, "title", json!("fine"), 300),
                op(entity, &eid, field, value.clone(), 300),
            ] }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{entity}.{field} = {value}: {body}"
        );
        let msg = body["error"].as_str().unwrap_or_default();
        assert!(
            msg.contains(&format!("{entity}.{field}")),
            "the error names the field: {msg}"
        );
    }

    // The whole batch was refused: nothing from it reached Bob (or Alice's own partition).
    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert!(
        !pull["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["value"] == "fine"),
        "a rejected batch must not be partially applied"
    );

    // Plaintext uuids, a lowercase sha and null all pass.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "assignee_id", json!(bob.id), 400),
                op("task", &tid, "assignee_id", Value::Null, 401),
                op(
                    "attachment",
                    &Uuid::now_v7().to_string(),
                    "task_id",
                    json!(tid),
                    402
                ),
                op(
                    "attachment",
                    &Uuid::now_v7().to_string(),
                    "blob_sha",
                    json!(sha),
                    402
                ),
                op(
                    "attachment",
                    &Uuid::now_v7().to_string(),
                    "thumb_sha",
                    Value::Null,
                    402
                ),
            ],
        )
        .await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn encrypted_title_with_plaintext_project_id_still_fans_out() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();
    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", envelope(), 100)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // The real client's order: the encrypted title first, the plaintext link after it.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "title", envelope(), 500),
                op("task", &tid, "project_id", json!(pid), 500),
            ],
        )
        .await,
        StatusCode::OK
    );

    let (_, pull) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&bob.token),
        json!({}),
    )
    .await;
    let title = pull["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["entity"] == "task" && o["entity_id"] == tid && o["field"] == "title")
        .map(|o| o["value"].clone());
    assert_eq!(
        title,
        Some(envelope()),
        "the envelope reaches the co-member unchanged"
    );
}

/// Server-authored ops (membership rows, revocation tombstones) must order after the client writes
/// they follow, even when the writer's clock runs a little ahead of the server's.
#[tokio::test]
async fn server_authored_ops_order_after_accepted_client_writes() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();

    // Alice's clock runs four minutes fast: inside the tolerated skew, so the write is accepted.
    let ahead = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 4 * 60 * 1000;
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("project", &pid, "name", json!("P"), ahead)]
        )
        .await,
        StatusCode::OK
    );
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    let (status, page) = http(
        &control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&alice.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let member_walls: Vec<u64> = page["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|op| op["entity"] == "project_member")
        .map(|op| op["ts"]["wall_ms"].as_u64().unwrap())
        .collect();
    assert!(!member_walls.is_empty());
    assert!(
        member_walls.iter().all(|w| *w >= ahead),
        "membership ops {member_walls:?} must not order before the accepted write at {ahead}"
    );
}

/// Every op in `user`'s partition (one pull page is enough for these fixtures).
async fn partition_ops(control: &Router, user: &User) -> Vec<Value> {
    let (status, page) = http(
        control,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&user.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page:?}");
    page["operations"].as_array().unwrap().clone()
}

fn hlc_of(op: &Value) -> (u64, u64, String) {
    (
        op["ts"]["wall_ms"].as_u64().unwrap(),
        op["ts"]["counter"].as_u64().unwrap(),
        op["ts"]["node"].as_str().unwrap().to_string(),
    )
}

/// Whether `ops` leave `task` hidden: a Delete newer than every Set of it.
fn task_hidden(ops: &[Value], task: &str) -> bool {
    let of_task = || ops.iter().filter(move |o| o["entity_id"] == task);
    let Some(delete) = of_task().filter(|o| o["op"] == "delete").map(hlc_of).max() else {
        return false;
    };
    of_task()
        .filter(|o| o["op"] == "set")
        .all(|o| hlc_of(o) < delete)
}

/// Moving a task between projects re-scopes it: members of the project it left who cannot see its
/// new project get the move and a tombstone, while members of the new project get the task.
#[tokio::test]
async fn moving_a_task_out_of_a_shared_project_revokes_it_for_members_left_behind() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await; // project A only
    let carol = new_user(&control).await; // project B only
    let dave = new_user(&control).await; // both
    let (a, b) = (Uuid::now_v7().to_string(), Uuid::now_v7().to_string());
    let tid = Uuid::now_v7().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    push(
        &control,
        &alice.token,
        vec![
            op("project", &a, "name", json!("A"), now),
            op("project", &b, "name", json!("B"), now),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &a, "editor").await;
    invite_and_accept(&control, &alice, &dave, &a, "editor").await;
    invite_and_accept(&control, &alice, &carol, &b, "editor").await;
    invite_and_accept(&control, &alice, &dave, &b, "editor").await;
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "project_id", json!(a), now + 1),
                op("task", &tid, "title", json!("in A"), now + 1),
            ],
        )
        .await,
        StatusCode::OK
    );
    assert!(!task_hidden(&partition_ops(&control, &bob).await, &tid));

    // Alice moves the task to B, re-writing its fields under the new scope.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![
                op("task", &tid, "title", json!("in B"), now + 2),
                op("task", &tid, "project_id", json!(b), now + 2),
            ],
        )
        .await,
        StatusCode::OK
    );

    let bob_ops = partition_ops(&control, &bob).await;
    assert!(
        bob_ops.iter().any(|o| o["entity_id"] == tid.as_str()
            && o["field"] == "project_id"
            && o["value"] == b.as_str()),
        "a member of the old project learns of the move"
    );
    assert!(
        task_hidden(&bob_ops, &tid),
        "a member who cannot see the new project loses the task"
    );
    assert!(
        !bob_ops.iter().any(|o| o["value"] == "in B"),
        "the re-scoped fields stay with the new project's members"
    );

    let dave_ops = partition_ops(&control, &dave).await;
    assert!(
        !task_hidden(&dave_ops, &tid),
        "a member of both keeps the task"
    );
    let carol_ops = partition_ops(&control, &carol).await;
    assert!(!task_hidden(&carol_ops, &tid));
    assert!(carol_ops.iter().any(|o| o["value"] == "in B"));
}

/// A revocation tombstone must beat whatever a member holds, but a far-future stamp stored in a
/// partition (one written before pushes were bounded) must not carry the server clock with it:
/// every later server-authored op would inherit it.
#[tokio::test]
async fn a_far_future_stored_stamp_does_not_advance_the_server_clock() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (a, b) = (Uuid::now_v7().to_string(), Uuid::now_v7().to_string());
    let tid = Uuid::now_v7().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    push(
        &control,
        &alice.token,
        vec![
            op("project", &a, "name", json!("A"), now),
            op("project", &b, "name", json!("B"), now),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &a, "editor").await;
    push(
        &control,
        &alice.token,
        vec![
            op("task", &tid, "project_id", json!(a), now + 1),
            op("task", &tid, "title", json!("in A"), now + 1),
        ],
    )
    .await;

    // A year ahead, planted straight into Bob's materialized state.
    let far = now + 365 * 24 * 60 * 60 * 1000;
    let planted_node = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO entity_fields
             (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, 'task', $2, 'notes', '\"late\"', $3, 0, $4)",
    )
    .bind(Uuid::parse_str(&bob.id).unwrap())
    .bind(Uuid::parse_str(&tid).unwrap())
    .bind(far as i64)
    .bind(planted_node)
    .execute(&state.pool)
    .await
    .unwrap();

    // Moving the task to B, which Bob cannot see, revokes it for him.
    assert_eq!(
        push(
            &control,
            &alice.token,
            vec![op("task", &tid, "project_id", json!(b), now + 2)],
        )
        .await,
        StatusCode::OK
    );

    let (wall, counter, node): (i64, i32, Uuid) = sqlx::query_as(
        "SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_tombstones
          WHERE user_id = $1 AND entity = 'task' AND entity_id = $2",
    )
    .bind(Uuid::parse_str(&bob.id).unwrap())
    .bind(Uuid::parse_str(&tid).unwrap())
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(
        (wall as u64, counter, node) > (far, 0, planted_node),
        "the tombstone beats the far-future field"
    );

    let next = state.clock.lock().unwrap().now(now);
    assert!(
        next.wall_ms < far,
        "the server clock stayed near real time, not at {far}: {next:?}"
    );
}

/// Taking a task out of a shared project removes it for the members left behind, so it needs more
/// than the commenter role that editing a task needs.
#[tokio::test]
async fn only_an_editor_may_move_a_task_out_of_a_shared_project() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (a, private) = (Uuid::now_v7().to_string(), Uuid::now_v7().to_string());
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &a, "name", json!("A"), 100)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &a, "commenter").await;
    push(
        &control,
        &alice.token,
        vec![op("task", &tid, "project_id", json!(a), 200)],
    )
    .await;
    push(
        &control,
        &bob.token,
        vec![op("project", &private, "name", json!("mine"), 300)],
    )
    .await;

    assert_eq!(
        push(
            &control,
            &bob.token,
            vec![op("task", &tid, "title", json!("still commenting"), 400)],
        )
        .await,
        StatusCode::OK,
        "a commenter still edits the task in place"
    );
    assert_eq!(
        push(
            &control,
            &bob.token,
            vec![op("task", &tid, "project_id", json!(private), 500)],
        )
        .await,
        StatusCode::FORBIDDEN,
        "a commenter may not move the task out"
    );
    assert!(
        !task_hidden(&partition_ops(&control, &alice).await, &tid),
        "the refused move revoked nothing"
    );
}

/// The value a device folding `ops` shows for `id`'s `field`: its newest Set, unless a newer
/// Delete of `id` hides it.
fn visible_value(ops: &[Value], id: &str, field: &str) -> Option<Value> {
    let delete = ops
        .iter()
        .filter(|o| o["entity_id"] == id && o["op"] == "delete")
        .map(hlc_of)
        .max();
    let set = ops
        .iter()
        .filter(|o| o["entity_id"] == id && o["op"] == "set" && o["field"] == field)
        .max_by_key(|o| hlc_of(o))?;
    match delete {
        Some(d) if hlc_of(set) <= d => None,
        _ => Some(set["value"].clone()),
    }
}

/// The entity id of `user_id`'s `project_member` row for `pid` in `ops`.
fn member_row(ops: &[Value], pid: &str, user_id: &str) -> Option<String> {
    let ids = |field: &str, value: &str| -> Vec<String> {
        ops.iter()
            .filter(|o| {
                o["entity"] == "project_member" && o["field"] == field && o["value"] == value
            })
            .map(|o| o["entity_id"].as_str().unwrap().to_string())
            .collect()
    };
    let for_project = ids("project_id", pid);
    ids("user_id", user_id)
        .into_iter()
        .find(|id| for_project.contains(id))
}

async fn remove_member(control: &Router, owner: &User, pid: &str, member: &User) {
    let (status, _) = http(
        control,
        "DELETE",
        &format!("/projects/{pid}/members/{}", member.id),
        Some(&owner.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "remove");
}

/// A member who was removed and accepts a new invite sees the project again: the removal left a
/// project tombstone newer than every field the owner holds, which the backfill must outrank.
#[tokio::test]
async fn a_removed_member_who_accepts_again_sees_the_project() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let carol = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![
            op("task", &tid, "project_id", json!(pid), 200),
            op("task", &tid, "title", json!("before"), 200),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;
    invite_and_accept(&control, &alice, &carol, &pid, "editor").await;

    remove_member(&control, &alice, &pid, &bob).await;
    assert_eq!(
        visible_value(&partition_ops(&control, &bob).await, &pid, "name"),
        None,
        "the removal hides the project"
    );

    // While Bob is away, the task changes and Carol leaves.
    push(
        &control,
        &alice.token,
        vec![op("task", &tid, "title", json!("while away"), 300)],
    )
    .await;
    remove_member(&control, &alice, &pid, &carol).await;

    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;
    let ops = partition_ops(&control, &bob).await;
    assert_eq!(visible_value(&ops, &pid, "name"), Some(json!("P")));
    assert_eq!(
        visible_value(&ops, &tid, "title"),
        Some(json!("while away"))
    );
    assert_eq!(visible_value(&ops, &tid, "project_id"), Some(json!(pid)));
    let carol_row = member_row(&ops, &pid, &carol.id).expect("carol's old row");
    assert_eq!(
        visible_value(&ops, &carol_row, "state"),
        None,
        "a collaborator who left meanwhile is gone"
    );

    // The rewrite outranks the tombstone and nothing later: an edit after the accept still wins.
    let rewrite = ops
        .iter()
        .filter(|o| o["entity_id"] == pid.as_str() && o["field"] == "name")
        .map(hlc_of)
        .max()
        .unwrap();
    let removal = ops
        .iter()
        .filter(|o| o["entity_id"] == pid.as_str() && o["op"] == "delete")
        .map(hlc_of)
        .max()
        .unwrap();
    assert_eq!(
        (rewrite.0, rewrite.1),
        (removal.0, removal.1),
        "the rewrite lands just above the removal's tombstone"
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("renamed"), now)],
    )
    .await;
    assert_eq!(
        visible_value(&partition_ops(&control, &bob).await, &pid, "name"),
        Some(json!("renamed"))
    );
}

/// Retention can purge the removal's tombstone row while a device still holds the tombstone; the
/// project's Delete op stays in the log, and the backfill outranks it all the same.
#[tokio::test]
async fn a_returning_member_sees_the_project_after_its_tombstone_row_was_purged() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();

    push(
        &control,
        &alice.token,
        vec![op("project", &pid, "name", json!("P"), 100)],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;
    remove_member(&control, &alice, &pid, &bob).await;

    // What retention leaves of the removal: the fields it hid and its row are gone.
    let (bob_id, project) = (
        bob.id.parse::<Uuid>().unwrap(),
        pid.parse::<Uuid>().unwrap(),
    );
    for table in ["entity_fields", "entity_tombstones"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE user_id = $1 AND entity = 'project' AND entity_id = $2"
        )))
        .bind(bob_id)
        .bind(project)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;
    assert_eq!(
        visible_value(&partition_ops(&control, &bob).await, &pid, "name"),
        Some(json!("P")),
        "a device replaying the removal's Delete still sees the project"
    );
}

/// Alice's shared project `pid` with Bob as editor, a task `tid` in it that Bob's device holds
/// (`held`), and `private`, a project of Alice's that Bob is not in.
struct AwayWorld {
    state: AppState,
    control: Router,
    alice: User,
    bob: User,
    pid: String,
    private: String,
    tid: String,
    held: Vec<Value>,
    now: u64,
}

async fn away_world() -> AwayWorld {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (pid, private) = (Uuid::now_v7().to_string(), Uuid::now_v7().to_string());
    let tid = Uuid::now_v7().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    push(
        &control,
        &alice.token,
        vec![
            op("project", &pid, "name", json!("P"), 100),
            op("project", &private, "name", json!("mine"), 100),
        ],
    )
    .await;
    push(
        &control,
        &alice.token,
        vec![
            op("task", &tid, "project_id", json!(pid), 200),
            op("task", &tid, "title", json!("t"), 200),
        ],
    )
    .await;
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;
    let held = partition_ops(&control, &bob).await;
    AwayWorld {
        state,
        control,
        alice,
        bob,
        pid,
        private,
        tid,
        held,
        now,
    }
}

/// Alice moves the task to `target` (null: her Inbox) as her client writes it: the move at `wall`,
/// and the task's fields rewritten under the new scope just above their old stamps.
async fn alice_moves(w: &AwayWorld, target: Value, wall: u64) {
    assert_eq!(
        push(
            &w.control,
            &w.alice.token,
            vec![
                op("task", &w.tid, "project_id", target, wall),
                op("task", &w.tid, "title", json!("rescoped"), 201),
            ],
        )
        .await,
        StatusCode::OK
    );
}

/// A member whose device was offline while a task moved out of the project gets the move and the
/// revocation when it syncs again. An edit it made to the task meanwhile, newer than the
/// revocation, must not bring the task back, in its partition or on its device: the server refuses
/// it, like an edit of a task that moved to a shared project the member is not in. What the member
/// added to the task, such as a comment, is still taken.
#[tokio::test]
async fn an_edit_made_while_away_does_not_bring_back_a_task_moved_out() {
    for to_inbox in [false, true] {
        let w = away_world().await;
        let target = if to_inbox {
            Value::Null
        } else {
            json!(w.private)
        };
        let (_, head) = http(
            &w.control,
            "GET",
            "/sync/pull?since=0",
            Some(&w.bob.token),
            Value::Null,
        )
        .await;
        let cursor = head["cursor"].as_i64().unwrap();
        alice_moves(&w, target, w.now).await;

        // What the device pulls on its return hides the task it holds.
        let (_, page) = http(
            &w.control,
            "GET",
            &format!("/sync/pull?since={cursor}"),
            Some(&w.bob.token),
            Value::Null,
        )
        .await;
        let mut device = w.held.clone();
        device.extend(page["operations"].as_array().unwrap().iter().cloned());
        assert!(task_hidden(&device, &w.tid), "to inbox: {to_inbox}");

        // The device pushes first, though: its edit from after the move is refused.
        assert_eq!(
            push(
                &w.control,
                &w.bob.token,
                vec![op(
                    "task",
                    &w.tid,
                    "title",
                    json!("edited while away"),
                    w.now + 1000
                )],
            )
            .await,
            StatusCode::FORBIDDEN,
            "to inbox: {to_inbox}"
        );
        let partition = partition_ops(&w.control, &w.bob).await;
        assert!(task_hidden(&partition, &w.tid), "to inbox: {to_inbox}");
        assert!(!partition.iter().any(|o| o["value"] == "edited while away"));

        let comment = Uuid::now_v7().to_string();
        assert_eq!(
            push(
                &w.control,
                &w.bob.token,
                vec![
                    op("comment", &comment, "task_id", json!(w.tid), w.now + 1000),
                    op("comment", &comment, "body", json!("hi"), w.now + 1000),
                ],
            )
            .await,
            StatusCode::OK,
            "to inbox: {to_inbox}: what the member created is kept"
        );
    }
}

/// Retention purges the revocation's tombstone with the fields it hid. An edit the member made
/// before the move, which the tombstone would have hidden, must not bring the task back either.
#[tokio::test]
async fn a_task_moved_out_stays_gone_once_retention_purged_its_tombstone() {
    let w = away_world().await;
    alice_moves(&w, json!(w.private), w.now).await;

    let bob: Uuid = w.bob.id.parse().unwrap();
    sqlx::query("UPDATE operations SET created_at = now() - interval '60 days' WHERE user_id = $1")
        .bind(bob)
        .execute(&w.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE entity_tombstones SET received_at = now() - interval '60 days' WHERE user_id = $1",
    )
    .bind(bob)
    .execute(&w.state.pool)
    .await
    .unwrap();
    atlas_server::retention::purge_once(&w.state.pool, 30)
        .await
        .unwrap();
    let (_, snapshot) = http(
        &w.control,
        "GET",
        "/sync/snapshot?limit=1000",
        Some(&w.bob.token),
        Value::Null,
    )
    .await;
    assert!(
        !snapshot["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["entity_id"] == w.tid.as_str()),
        "retention took the tombstone and the fields it hid"
    );

    assert_eq!(
        push(
            &w.control,
            &w.bob.token,
            vec![op(
                "task",
                &w.tid,
                "title",
                json!("edited before the move"),
                300
            )],
        )
        .await,
        StatusCode::FORBIDDEN
    );
    let (_, snapshot) = http(
        &w.control,
        "GET",
        "/sync/snapshot?limit=1000",
        Some(&w.bob.token),
        Value::Null,
    )
    .await;
    assert!(!snapshot["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["entity_id"] == w.tid.as_str()));
}

/// A task that comes back within a member's reach is theirs to edit again: moved back into the
/// project, or by the member joining the project it went to. Once back, the member may also move
/// it out themselves, into their own Inbox, and keep editing it there.
#[tokio::test]
async fn a_task_back_within_reach_can_be_edited_again() {
    let w = away_world().await;
    alice_moves(&w, json!(w.private), w.now).await;
    alice_moves(&w, json!(w.pid), w.now + 1).await;
    let edit = |title: &str, wall: u64| op("task", &w.tid, "title", json!(title), wall);
    assert_eq!(
        push(&w.control, &w.bob.token, vec![edit("back", w.now + 2)]).await,
        StatusCode::OK
    );
    assert_eq!(
        push(
            &w.control,
            &w.bob.token,
            vec![op("task", &w.tid, "project_id", Value::Null, w.now + 3)],
        )
        .await,
        StatusCode::OK,
        "an editor may move it out"
    );
    assert_eq!(
        push(&w.control, &w.bob.token, vec![edit("mine now", w.now + 4)]).await,
        StatusCode::OK
    );

    // Moved to a project Bob then joins.
    let w = away_world().await;
    alice_moves(&w, json!(w.private), w.now).await;
    invite_and_accept(&w.control, &w.alice, &w.bob, &w.private, "editor").await;
    assert_eq!(
        push(
            &w.control,
            &w.bob.token,
            vec![op("task", &w.tid, "title", json!("joined"), w.now + 1)],
        )
        .await,
        StatusCode::OK
    );
    assert!(!task_hidden(
        &partition_ops(&w.control, &w.bob).await,
        &w.tid
    ));
}

/// Accepting copies the project without the sync-write lock and catches up under it. Pushes that
/// land while the accept is under way must go through (the lock is not held for the copy) and
/// reach the joiner exactly once, with the result a copy made under the lock would give: an edit's
/// new value, a new task, a task moved out gone, and a task moved in with its comment, which the
/// move did not send again.
#[tokio::test]
async fn pushes_during_an_accept_reach_the_joiner_exactly_once() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let (pid, private) = (Uuid::now_v7().to_string(), Uuid::now_v7().to_string());
    let [edited, moved_out, moved_in, comment] = [(); 4].map(|_| Uuid::now_v7().to_string());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    push(
        &control,
        &alice.token,
        vec![
            op("project", &pid, "name", json!("P"), 100),
            op("project", &private, "name", json!("mine"), 100),
            op("task", &edited, "project_id", json!(pid), 200),
            op("task", &edited, "title", json!("before"), 200),
            op("task", &moved_out, "project_id", json!(pid), 200),
            op("task", &moved_out, "title", json!("leaving"), 200),
            op("task", &moved_in, "project_id", json!(private), 200),
            op("task", &moved_in, "title", json!("arriving"), 200),
            op("comment", &comment, "task_id", json!(moved_in), 200),
            op(
                "comment",
                &comment,
                "body",
                json!("along for the ride"),
                200,
            ),
        ],
    )
    .await;
    let (status, _) = http(
        &control,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Hold the invite's row: the accept reads the project, then waits here, short of the lock.
    let mut blocker = state.pool.begin().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::query("SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE")
        .bind(pid.parse::<Uuid>().unwrap())
        .bind(bob.id.parse::<Uuid>().unwrap())
        .execute(&mut *blocker)
        .await
        .unwrap();
    let accept = {
        let (control, token, pid) = (control.clone(), bob.token.clone(), pid.clone());
        tokio::spawn(async move {
            http(
                &control,
                "POST",
                &format!("/projects/{pid}/accept"),
                Some(&token),
                json!({}),
            )
            .await
            .0
        })
    };
    let waiting = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                                 WHERE $1 = ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker_pid)
            .fetch_one(&state.pool)
            .await
            .unwrap();
            if blocked {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(waiting.is_ok(), "the accept never reached the invite row");

    let during = |ops: Vec<Value>| {
        let (control, token) = (control.clone(), alice.token.clone());
        async move {
            // Would hang (and time out) if the accept held the sync-write lock while it waits.
            tokio::time::timeout(Duration::from_secs(10), push(&control, &token, ops))
                .await
                .expect("a push during the accept goes through")
        }
    };
    let new_tasks: Vec<String> = (0..3).map(|_| Uuid::now_v7().to_string()).collect();
    for (i, task) in new_tasks.iter().enumerate() {
        let title = format!("new {i}");
        let ops = vec![
            op("task", task, "project_id", json!(pid), now),
            op("task", task, "title", json!(title), now),
        ];
        assert_eq!(during(ops).await, StatusCode::OK);
    }
    let ops = vec![op("task", &edited, "title", json!("during"), now)];
    assert_eq!(during(ops).await, StatusCode::OK);
    let ops = vec![op("task", &moved_out, "project_id", json!(private), now)];
    assert_eq!(during(ops).await, StatusCode::OK);
    let ops = vec![
        op("task", &moved_in, "project_id", json!(pid), now),
        op("task", &moved_in, "title", json!("arrived"), now),
    ];
    assert_eq!(during(ops).await, StatusCode::OK);

    blocker.rollback().await.unwrap();
    assert_eq!(accept.await.unwrap(), StatusCode::NO_CONTENT);
    let after = Uuid::now_v7().to_string();
    push(
        &control,
        &alice.token,
        vec![
            op("task", &after, "project_id", json!(pid), now + 1),
            op("task", &after, "title", json!("after"), now + 1),
        ],
    )
    .await;

    let ops = partition_ops(&control, &bob).await;
    for title in ["new 0", "new 1", "new 2", "during", "arrived", "after"] {
        let copies = ops.iter().filter(|o| o["value"] == title).count();
        assert_eq!(copies, 1, "{title:?} reaches the joiner exactly once");
    }
    for (i, task) in new_tasks.iter().enumerate() {
        assert_eq!(
            visible_value(&ops, task, "title"),
            Some(json!(format!("new {i}")))
        );
    }
    assert_eq!(visible_value(&ops, &edited, "title"), Some(json!("during")));
    assert!(
        !ops.iter().any(|o| o["entity_id"] == moved_out.as_str()),
        "a task that left before the accept committed is not copied"
    );
    assert_eq!(
        visible_value(&ops, &moved_in, "project_id"),
        Some(json!(pid))
    );
    assert_eq!(
        visible_value(&ops, &comment, "body"),
        Some(json!("along for the ride")),
        "the moved-in task's comment comes with it"
    );
    assert_eq!(visible_value(&ops, &after, "title"), Some(json!("after")));
}
