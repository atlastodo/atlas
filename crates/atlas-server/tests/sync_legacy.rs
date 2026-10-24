//! Integration tests for what sync protocol 7 (`docs/decisions/0006-opaque-sync-metadata.md`)
//! keeps of the rows written before it: legacy rows stay readable, a client drops the ones it
//! re-encoded (`POST /sync/legacy/drop`), the legacy read paths still revoke and backfill a shared
//! project, and nothing a current client writes leaves a field name the server does not act on.
//! Legacy rows are seeded straight into partitions, as protocol 6 left them.

use atlas_server::config::{BlobBackend, Config};
use atlas_server::{app, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

mod common;
use common::legacy::{legacy_push, record_creator, seed_legacy};
use common::wire::{self, sealed, value_of};

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config(apps: &[&str]) -> Config {
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
        blob_backend: BlobBackend::Fs,
        blob_dir: None,
        max_blob_bytes: 25 * 1024 * 1024,
        blob_quota_bytes: 1024 * 1024 * 1024,
        blob_gc_grace_days: 7,
        max_blob_transfers: 16,
        static_dir: None,
        apps: apps.iter().map(|a| a.to_string()).collect(),
        passkeys: None,
        android_asset_links: None,
    }
}

async fn pool() -> PgPool {
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    pool
}

/// An instance over the test database offering todo and journal.
async fn suite() -> (AppState, Router) {
    let state = AppState::new(pool().await, config(&["todo", "journal"]));
    let router = app(state.clone());
    (state, router)
}

/// A request; `apps` is the `x-atlas-sync-apps` header, when set.
async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    apps: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-atlas-sync-protocol", "7");
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    if let Some(a) = apps {
        builder = builder.header("x-atlas-sync-apps", a);
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(serde_json::to_vec(&body).unwrap())
    };
    let response = router
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

fn wrap() -> Value {
    json!({
        "v": 1,
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

struct User {
    token: String,
    id: Uuid,
    email: String,
}

/// Sign up a current client's account: with a root key and the todo app key under it.
async fn signup(router: &Router) -> User {
    let email = format!("multi-{}@example.com", Uuid::now_v7());
    let id = Uuid::new_v4();
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        None,
        json!({
            "email": email,
            "password": PASSWORD,
            "salt": hex::encode(random_bytes::<16>()),
            "public_key": hex::encode(random_bytes::<32>()),
            "recovery_public_key": hex::encode(random_bytes::<32>()),
            "encrypted_dek": wrap(),
            "encrypted_private_key": wrap(),
            "recovery_encrypted_dek": wrap(),
            "recovery_encrypted_private_key": wrap(),
            "user_id": id,
            "encrypted_root_key": wrap(),
            "recovery_encrypted_root_key": wrap(),
            "app_keys": [{ "app": "todo", "wrapped_key": wrap(), "wrapped_private_key": wrap() }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id,
        email,
    }
}

/// Enable journal for `user` the way a client does: its key under the root, then the app.
async fn enable_journal(router: &Router, user: &User) {
    let (status, body) = send(
        router,
        "PUT",
        "/auth/app-keys/journal",
        Some(&user.token),
        None,
        json!({ "wrapped_key": wrap(), "wrapped_private_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let (status, body) = send(
        router,
        "PUT",
        "/auth/apps/journal",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["enabled"], true);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// A set op of `field` on an entity of the real `kind`, as its client sends it (no scope).
fn set_op(kind: &str, entity_id: Uuid, field: &str, value: Value) -> Value {
    wire::set_of_kind(kind, entity_id, field, value, now_ms())
}

/// A set op of `field` on todo item `entity_id` in shared `project` (its key, its scope).
fn in_project(entity_id: Uuid, project: Uuid, field: &str, value: Value) -> Value {
    wire::set(
        wire::SEALED,
        entity_id,
        Some(&project.to_string()),
        field,
        value,
        (now_ms(), 0, Uuid::now_v7()),
    )
}

async fn push(
    router: &Router,
    token: &str,
    apps: Option<&str>,
    ops: Vec<Value>,
) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        "/sync/push",
        Some(token),
        apps,
        json!({ "operations": ops }),
    )
    .await
}

/// The whole pull from 0 in the given scope: (ops, cursor).
async fn pull(router: &Router, token: &str, apps: Option<&str>) -> (Vec<Value>, i64) {
    let (status, body) = send(
        router,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(token),
        apps,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    (
        body["operations"].as_array().unwrap().clone(),
        body["cursor"].as_i64().unwrap(),
    )
}

async fn snapshot(router: &Router, token: &str, apps: Option<&str>) -> Vec<Value> {
    let (status, body) = send(
        router,
        "GET",
        "/sync/snapshot?limit=1000",
        Some(token),
        apps,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert!(body.get("next").is_none());
    body["operations"].as_array().unwrap().clone()
}

fn entities(ops: &[Value]) -> Vec<String> {
    let mut kinds: Vec<String> = ops
        .iter()
        .map(|op| op["entity"].as_str().unwrap().to_string())
        .collect();
    kinds.sort();
    kinds.dedup();
    kinds
}

async fn share(router: &Router, owner: &User, member: &User, project: Uuid) {
    let (status, body) = send(
        router,
        "POST",
        &format!("/projects/{project}/members"),
        Some(&owner.token),
        None,
        json!({ "email": member.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let (status, _) = send(
        router,
        "POST",
        &format!("/projects/{project}/accept"),
        Some(&member.token),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

async fn drop_legacy(
    router: &Router,
    user: &User,
    apps: Option<&str>,
    keys: &[(&str, Uuid)],
) -> (StatusCode, Value) {
    let entities: Vec<Value> = keys
        .iter()
        .map(|(entity, id)| json!({ "entity": entity, "entity_id": id }))
        .collect();
    send(
        router,
        "POST",
        "/sync/legacy/drop",
        Some(&user.token),
        apps,
        json!({ "entities": entities }),
    )
    .await
}

fn legacy_set(entity: &str, id: Uuid, field: &str, value: Value, wall: u64) -> Value {
    json!({
        "entity": entity, "entity_id": id.to_string(), "op": "set", "field": field, "value": value,
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

/// Whether `ops` hide `id`: a Delete newer than every Set of it.
fn hidden(ops: &[Value], id: Uuid) -> bool {
    let key = |o: &Value| {
        (
            o["ts"]["wall_ms"].as_u64().unwrap(),
            o["ts"]["counter"].as_u64().unwrap(),
            o["ts"]["node"].as_str().unwrap().to_string(),
        )
    };
    let of = || ops.iter().filter(move |o| o["entity_id"] == id.to_string());
    let Some(delete) = of().filter(|o| o["op"] == "delete").map(key).max() else {
        return false;
    };
    of().filter(|o| o["op"] == "set").all(|o| key(o) < delete)
}

/// A protocol 6 client's journal entry and todo task are served as they were written, to every
/// session of their app, until the client that re-encoded them drops them: then neither the log
/// nor the snapshot holds a trace, while the re-encoded copy stays.
#[tokio::test]
async fn legacy_rows_are_served_until_their_client_drops_them() {
    let (state, router) = suite().await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;
    let (entry, task) = (Uuid::now_v7(), Uuid::now_v7());
    let envelope = json!({ "__enc": 2, "kid": "dek", "iv": "aXY=", "ct": "Y3Q=" });
    seed_legacy(
        &state.pool,
        user.id,
        "journal.entry",
        entry,
        "body",
        envelope.clone(),
        100,
    )
    .await;
    seed_legacy(
        &state.pool,
        user.id,
        "task",
        task,
        "title",
        envelope.clone(),
        100,
    )
    .await;

    let (journal, _) = pull(&router, &user.token, Some("journal")).await;
    assert_eq!(entities(&journal), ["journal.entry"]);
    assert_eq!(journal[0]["field"], "body");
    assert_eq!(journal[0]["value"], envelope);
    assert!(journal[0]["scope"].is_null() && journal[0]["pushed_by"].is_null());
    assert_eq!(
        entities(&snapshot(&router, &user.token, None).await),
        ["task"]
    );

    // Legacy kinds are read-only.
    let (status, body) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![json!({
            "id": Uuid::now_v7(), "entity": "journal.entry", "entity_id": entry,
            "op": "delete", "ts": { "wall_ms": 200, "counter": 0, "node": Uuid::now_v7() },
        })],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");

    // The client re-encodes the entry, then drops the original.
    let (status, body) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![set_op("journal.entry", entry, "body", json!("dear diary"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let (status, body) =
        drop_legacy(&router, &user, Some("journal"), &[("journal.entry", entry)]).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["dropped"], 1);
    let (journal, _) = pull(&router, &user.token, Some("journal")).await;
    assert_eq!(entities(&journal), ["journal.sealed"]);
    assert_eq!(value_of(&journal[0]), "dear diary");
    let rows: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM operations WHERE user_id = $1 AND entity = 'journal.entry')
              + (SELECT count(*) FROM entity_fields WHERE user_id = $1 AND entity = 'journal.entry')",
    )
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(rows, 0, "nothing of the legacy entry is left");

    // Dropping again finds nothing; the task, another app's, was not touched.
    let (_, body) = drop_legacy(&router, &user, Some("journal"), &[("journal.entry", entry)]).await;
    assert_eq!(body["dropped"], 0);
    assert_eq!(
        entities(&pull(&router, &user.token, None).await.0),
        ["task"]
    );
}

#[tokio::test]
async fn a_drop_names_legacy_kinds_of_the_sessions_apps_only() {
    let (state, router) = suite().await;
    let user = signup(&router).await;
    let other = signup(&router).await;
    let task = Uuid::now_v7();
    seed_legacy(
        &state.pool,
        other.id,
        "task",
        task,
        "title",
        json!("theirs"),
        100,
    )
    .await;

    // Current kinds are not dropped this way (a delete is a push), unknown ones not at all.
    for kind in [
        "todo.sealed",
        "todo.project",
        "project_member",
        "notes.note",
    ] {
        let (status, body) = drop_legacy(&router, &user, None, &[(kind, task)]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{kind}: {body:?}");
    }
    // A journal kind is outside a todo session.
    let (status, _) = drop_legacy(&router, &user, None, &[("journal.entry", task)]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Naming another account's entity drops nothing of theirs.
    let (status, body) = drop_legacy(&router, &user, None, &[("task", task)]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["dropped"], 0);
    assert_eq!(pull(&router, &other.token, None).await.0.len(), 1);
}

/// A shared project not yet migrated: its legacy rows reach a new member through the accept
/// backfill and leave a removed one's partition, by the plaintext links they still carry. Rows the
/// member's own client drops after re-encoding are gone from their partition only.
#[tokio::test]
async fn a_legacy_shared_project_is_backfilled_and_revoked_by_its_links() {
    let (state, router) = suite().await;
    let alice = signup(&router).await;
    let bob = signup(&router).await;
    let (project, task, comment) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let name = json!({ "__enc": 2, "kid": "dek", "iv": "aXY=", "ct": "bmFtZQ==" });
    legacy_push(
        &state.pool,
        &[alice.id],
        &[
            legacy_set("project", project, "name", name, 100),
            legacy_set("task", task, "project_id", json!(project.to_string()), 110),
            legacy_set("task", task, "title", json!("legacy"), 110),
            legacy_set("comment", comment, "task_id", json!(task.to_string()), 120),
        ],
    )
    .await;
    record_creator(&state.pool, project, alice.id).await;

    share(&router, &alice, &bob, project).await;
    let (bob_ops, _) = pull(&router, &bob.token, None).await;
    for id in [project, task, comment] {
        assert!(
            bob_ops.iter().any(|o| o["entity_id"] == id.to_string()),
            "{id} reaches the new member"
        );
    }

    // Alice re-encodes the task into the project's scope; Bob's partition gets the copy too.
    let (status, body) = push(
        &router,
        &alice.token,
        None,
        vec![
            in_project(task, project, "project_id", json!(project.to_string())),
            in_project(task, project, "title", json!("legacy")),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let (status, _) = drop_legacy(&router, &alice, None, &[("task", task)]).await;
    assert_eq!(status, StatusCode::OK);
    let (bob_ops, _) = pull(&router, &bob.token, None).await;
    assert!(bob_ops
        .iter()
        .any(|o| o["entity"] == "task" && o["entity_id"] == task.to_string()));
    assert!(bob_ops
        .iter()
        .any(|o| o["entity"] == wire::SEALED && o["entity_id"] == task.to_string()));

    // Removing Bob revokes all of it from his partition: the legacy rows and the current ones.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/projects/{project}/members/{}", bob.id),
        Some(&alice.token),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (bob_ops, _) = pull(&router, &bob.token, None).await;
    for id in [project, task, comment] {
        assert!(hidden(&bob_ops, id), "{id} is revoked");
    }
}

/// What a current client's pushes leave in the server's tables names no field the server does not
/// act on: tags and the manifests' public fields only, under wire kinds, every value sealed but
/// the blob addresses.
#[tokio::test]
async fn stored_rows_name_no_field_and_hold_no_plaintext() {
    let (state, router) = suite().await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;
    let (project, task, attachment, entry) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    let sha = "c".repeat(64);
    let ops = vec![
        set_op("project", project, "name", json!("Groceries")),
        set_op("project", project, "archived_at", Value::Null),
        set_op("task", task, "title", json!("Buy milk")),
        set_op("task", task, "project_id", json!(project.to_string())),
        set_op("task", task, "assignee_id", json!(user.id.to_string())),
        set_op("attachment", attachment, "task_id", json!(task.to_string())),
        set_op("attachment", attachment, "blob_sha", json!(sha)),
    ];
    let (status, body) = push(&router, &user.token, None, ops).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let entry_op = set_op("journal.entry", entry, "body", json!("dear diary"));
    let (status, _) = push(&router, &user.token, Some("journal"), vec![entry_op]).await;
    assert_eq!(status, StatusCode::OK);

    let rows: Vec<(String, String, Value)> = sqlx::query_as(
        "SELECT entity, field, value FROM entity_fields WHERE user_id = $1
         UNION ALL
         SELECT entity, field, value FROM operations WHERE user_id = $1",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 16);
    for (entity, field, value) in rows {
        assert!(
            ["todo.project", "todo.sealed", "journal.sealed"].contains(&entity.as_str()),
            "{entity}"
        );
        match field.as_str() {
            "archived_at" => assert_eq!(entity, "todo.project"),
            "blob_sha" => {
                assert_eq!(value, json!(sha));
                continue;
            }
            tagged => assert_eq!(tagged.len(), 32, "{tagged} is a tag"),
        }
        assert_eq!(value["__enc"], 3, "{value}");
        assert_eq!(value, sealed(value_of(&json!({ "value": value }))));
    }
}

async fn legacy_keys(router: &Router, user: &User, apps: Option<&str>, query: &str) -> Value {
    let (status, body) = send(
        router,
        "GET",
        &format!("/sync/legacy/keys{query}"),
        Some(&user.token),
        apps,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body
}

/// A client learns what its partition still holds of the session's legacy kinds, page by page, and
/// which keys a current copy already covers.
#[tokio::test]
async fn legacy_keys_list_what_is_left_and_what_is_covered() {
    let (state, router) = suite().await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;
    let (a, b, gone, task) = (
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    );
    for id in [a, b] {
        seed_legacy(
            &state.pool,
            user.id,
            "journal.entry",
            id,
            "body",
            json!("x"),
            100,
        )
        .await;
        seed_legacy(
            &state.pool,
            user.id,
            "journal.entry",
            id,
            "date",
            json!("y"),
            100,
        )
        .await;
    }
    legacy_push(
        &state.pool,
        &[user.id],
        &[json!({
            "entity": "journal.entry", "entity_id": gone.to_string(), "op": "delete",
            "ts": { "wall_ms": 150, "counter": 0, "node": Uuid::now_v7() },
        })],
    )
    .await;
    seed_legacy(&state.pool, user.id, "task", task, "title", json!("z"), 100).await;

    let all = legacy_keys(&router, &user, Some("journal"), "").await;
    let listed: Vec<(String, bool)> = all["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            (
                k["entity_id"].as_str().unwrap().to_owned(),
                k["covered"].as_bool().unwrap(),
            )
        })
        .collect();
    let mut want = vec![
        (a.to_string(), false),
        (b.to_string(), false),
        (gone.to_string(), false),
    ];
    want.sort();
    let mut listed_sorted = listed.clone();
    listed_sorted.sort();
    assert_eq!(listed_sorted, want, "the journal's keys only");
    assert!(all.get("next").is_none());

    // One re-encoded in full, one only in part, the deleted one as a current tombstone.
    let (status, body) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![
            set_op("journal.entry", a, "body", json!("x")),
            set_op("journal.entry", a, "date", json!("y")),
            set_op("journal.entry", b, "body", json!("x")),
            wire::delete("journal.sealed", gone, None, (now_ms(), 0, Uuid::now_v7())),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let covered: std::collections::HashMap<String, bool> =
        legacy_keys(&router, &user, Some("journal"), "").await["entities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                (
                    k["entity_id"].as_str().unwrap().to_owned(),
                    k["covered"].as_bool().unwrap(),
                )
            })
            .collect();
    assert!(covered[&a.to_string()]);
    assert!(!covered[&b.to_string()], "a partial copy is not enough");
    assert!(covered[&gone.to_string()]);

    // Pages of one key resume after the last.
    let first = legacy_keys(&router, &user, Some("journal"), "?limit=1").await;
    assert_eq!(first["entities"].as_array().unwrap().len(), 1);
    let next = first["next"].as_str().expect("more pages").to_owned();
    let second = legacy_keys(
        &router,
        &user,
        Some("journal"),
        &format!("?limit=1&next={next}"),
    )
    .await;
    assert_ne!(
        second["entities"][0]["entity_id"],
        first["entities"][0]["entity_id"]
    );

    // A todo session sees the task.
    let todo = legacy_keys(&router, &user, None, "").await;
    assert_eq!(todo["entities"][0]["entity"], "task");
    assert_eq!(todo["entities"].as_array().unwrap().len(), 1);
}
