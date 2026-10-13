//! Integration tests for the admin task restore (`restore::restore_tasks`, the `restore-tasks`
//! subcommand): tasks hard-deleted by an outdated client come back, byte-identical, in every
//! current member's partition, while deliberate deletes and deletes outside the window stay put.

use std::collections::BTreeMap;

use atlas_server::restore::{restore_tasks, RestoreOptions, RestoreScope, SkipReason};
use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> (Router, PgPool) {
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
        static_dir: None,
    };
    (app(AppState::new(pool.clone(), config)), pool)
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
    id: Uuid,
    email: String,
}

async fn new_user(router: &Router) -> User {
    let email = format!("r-{}@example.com", Uuid::now_v7());
    // Placeholder key material in the client's shapes (hex salt and x25519 key, base64 wraps):
    // signup requires it, and the restore never reads it.
    let hex = |n: usize| -> String {
        (0..n)
            .map(|_| Uuid::now_v7().simple().to_string())
            .collect()
    };
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let (status, body) = http(
        router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": email, "password": PASSWORD,
            "salt": hex(1), "public_key": hex(2), "recovery_public_key": hex(2),
            "encrypted_dek": wrapped, "encrypted_private_key": wrapped,
            "recovery_encrypted_dek": wrapped, "recovery_encrypted_private_key": wrapped,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body:?}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        email,
    }
}

fn set(entity: &str, id: Uuid, field: &str, value: Value, wall: u64) -> Value {
    json!({
        "id": Uuid::now_v7(), "entity": entity, "entity_id": id,
        "op": "set", "field": field, "value": value,
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

fn delete(id: Uuid, wall: u64) -> Value {
    json!({
        "id": Uuid::now_v7(), "entity": "task", "entity_id": id, "op": "delete",
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

async fn push(router: &Router, user: &User, ops: Vec<Value>) {
    let (status, body) = http(
        router,
        "POST",
        "/sync/push",
        Some(&user.token),
        json!({ "operations": ops }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}

async fn share(router: &Router, owner: &User, invitee: &User, pid: Uuid) {
    let (status, _) = http(
        router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&owner.token),
        json!({ "email": invitee.email, "role": "editor" }),
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// An op's HLC as a comparable tuple (a canonical uuid string sorts like its bytes).
fn ts(op: &Value) -> (u64, u64, String) {
    (
        op["ts"]["wall_ms"].as_u64().unwrap(),
        op["ts"]["counter"].as_u64().unwrap(),
        op["ts"]["node"].as_str().unwrap().to_string(),
    )
}

/// Fold ops for one task with the clients' rule: a field is visible when its winning Set is newer
/// than the newest Delete. Empty means the task is gone.
fn fold(ops: &[Value], task: Uuid) -> BTreeMap<String, Value> {
    let ops: Vec<&Value> = ops
        .iter()
        .filter(|o| o["entity"] == "task" && o["entity_id"] == task.to_string())
        .collect();
    let tomb = ops
        .iter()
        .filter(|o| o["op"] == "delete")
        .map(|o| ts(o))
        .max();
    let mut fields: BTreeMap<String, (Value, (u64, u64, String))> = BTreeMap::new();
    for o in ops.iter().filter(|o| o["op"] == "set") {
        let field = o["field"].as_str().unwrap().to_string();
        if !matches!(fields.get(&field), Some((_, t)) if *t >= ts(o)) {
            fields.insert(field, (o["value"].clone(), ts(o)));
        }
    }
    fields
        .into_iter()
        .filter(|(_, (_, t))| !matches!(&tomb, Some(d) if t <= d))
        .map(|(f, (v, _))| (f, v))
        .collect()
}

/// The task as the user's snapshot and, separately, their full pull log resolve it. Both must agree.
async fn visible(router: &Router, user: &User, task: Uuid) -> BTreeMap<String, Value> {
    let (status, snap) = http(
        router,
        "GET",
        "/sync/snapshot?limit=500",
        Some(&user.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(snap.get("next").is_none(), "fits one page");
    let from_snapshot = fold(snap["operations"].as_array().unwrap(), task);

    let (status, pulled) = http(
        router,
        "GET",
        "/sync/pull?since=0&limit=1000",
        Some(&user.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let from_pull = fold(pulled["operations"].as_array().unwrap(), task);
    assert_eq!(from_snapshot, from_pull, "snapshot and pull disagree");
    from_snapshot
}

/// Stored field values as Postgres renders them, to prove the copy is byte-identical.
async fn stored_text(pool: &PgPool, user: Uuid, task: Uuid) -> BTreeMap<String, String> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT field, value::text FROM entity_fields
          WHERE user_id = $1 AND entity = 'task' AND entity_id = $2",
    )
    .bind(user)
    .bind(task)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .collect()
}

async fn op_rows(pool: &PgPool, task: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM operations WHERE entity_id = $1")
        .bind(task)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn envelope(tag: &str) -> Value {
    json!({ "__enc": 1, "iv": format!("iv-{tag}"), "ct": format!("ciphertext/{tag}+==") })
}

/// A project (created at `base`) holding one task (created at `base + 1`) with ciphertext fields.
async fn project_with_task(router: &Router, owner: &User, base: u64) -> (Uuid, Uuid) {
    let (pid, tid) = (Uuid::now_v7(), Uuid::now_v7());
    push(
        router,
        owner,
        vec![set("project", pid, "name", envelope("project"), base)],
    )
    .await;
    push(
        router,
        owner,
        vec![
            set("task", tid, "title", envelope("title"), base + 1),
            set("task", tid, "notes", envelope("notes"), base + 1),
            set("task", tid, "project_id", json!(pid.to_string()), base + 1),
            set("task", tid, "created_at", json!(base), base + 1),
        ],
    )
    .await;
    (pid, tid)
}

fn opts(scope: RestoreScope, since_ms: u64, until_ms: u64) -> RestoreOptions {
    RestoreOptions {
        scope,
        since_ms: since_ms as i64,
        until_ms: until_ms as i64,
        apply: false,
        all_deleters: false,
    }
}

#[tokio::test]
async fn member_delete_of_owners_task_is_restored_for_every_member() {
    let (router, pool) = setup().await;
    let (alice, bob) = (new_user(&router).await, new_user(&router).await);
    let base = now_ms() - 60_000;
    let (pid, tid) = project_with_task(&router, &alice, base).await;
    share(&router, &alice, &bob, pid).await;

    let original = visible(&router, &alice, tid).await;
    assert_eq!(original.len(), 4);
    assert_eq!(visible(&router, &bob, tid).await, original);
    let original_text = stored_text(&pool, alice.id, tid).await;

    // Bob's outdated client could not decrypt the task and deleted it; the delete fanned out.
    push(&router, &bob, vec![delete(tid, base + 100)]).await;
    assert!(visible(&router, &alice, tid).await.is_empty());
    assert!(visible(&router, &bob, tid).await.is_empty());

    // Dry run: reported, nothing written.
    let rows_before = op_rows(&pool, tid).await;
    let dry = opts(RestoreScope::Project(pid), base + 50, base + 200);
    let report = restore_tasks(&pool, &dry).await.unwrap();
    assert!(!report.applied);
    assert_eq!(report.tasks.len(), 1, "{report:?}");
    let task = &report.tasks[0];
    assert_eq!(task.task_id, tid);
    assert_eq!(task.project_id, Some(pid));
    assert_eq!(task.deleter, Some(bob.id));
    assert_eq!(task.creator, Some(alice.id));
    assert_eq!(task.skip, None);
    assert!(task.tombstone_at.is_some());
    assert!(task.notes.is_empty(), "{:?}", task.notes);
    assert_eq!(
        task.fields,
        ["created_at", "notes", "project_id", "title"].map(String::from)
    );
    let mut members = vec![alice.id, bob.id];
    members.sort();
    assert_eq!(task.partitions, members);
    assert_eq!(
        op_rows(&pool, tid).await,
        rows_before,
        "a dry run writes nothing"
    );
    assert!(visible(&router, &alice, tid).await.is_empty());

    // The same task is found when scoped to either member's partition.
    let by_user = opts(RestoreScope::User(alice.id), base + 50, base + 200);
    let report = restore_tasks(&pool, &by_user).await.unwrap();
    assert_eq!(report.tasks.len(), 1);
    assert_eq!(report.tasks[0].fields.len(), 4);

    // Apply: visible again for both, with the original bytes.
    let apply = RestoreOptions { apply: true, ..dry };
    let report = restore_tasks(&pool, &apply).await.unwrap();
    assert!(report.applied);
    assert_eq!(report.restored(), 1, "{report:?}");
    assert_eq!(visible(&router, &alice, tid).await, original);
    assert_eq!(visible(&router, &bob, tid).await, original);
    assert_eq!(stored_text(&pool, alice.id, tid).await, original_text);
    assert_eq!(stored_text(&pool, bob.id, tid).await, original_text);

    // Idempotent: a second run finds the task already restored and writes nothing.
    let rows_after = op_rows(&pool, tid).await;
    let report = restore_tasks(&pool, &apply).await.unwrap();
    assert_eq!(report.tasks.len(), 1);
    assert_eq!(report.tasks[0].skip, Some(SkipReason::AlreadyRestored));
    assert!(report.tasks[0].fields.is_empty());
    assert_eq!(op_rows(&pool, tid).await, rows_after);
    assert_eq!(visible(&router, &alice, tid).await, original);
}

#[tokio::test]
async fn a_creators_own_delete_is_skipped_unless_all_deleters() {
    let (router, pool) = setup().await;
    let alice = new_user(&router).await;
    let base = now_ms() - 60_000;
    // A private project: the restore must land in the owner's partition alone.
    let (pid, tid) = project_with_task(&router, &alice, base).await;
    let original = visible(&router, &alice, tid).await;
    push(&router, &alice, vec![delete(tid, base + 100)]).await;

    let mut o = opts(RestoreScope::User(alice.id), base + 50, base + 200);
    o.apply = true;
    let report = restore_tasks(&pool, &o).await.unwrap();
    assert_eq!(report.tasks.len(), 1);
    let task = &report.tasks[0];
    assert_eq!(task.skip, Some(SkipReason::DeletedByCreator));
    assert_eq!(
        (task.deleter, task.creator),
        (Some(alice.id), Some(alice.id))
    );
    assert!(visible(&router, &alice, tid).await.is_empty());

    o.all_deleters = true;
    let report = restore_tasks(&pool, &o).await.unwrap();
    let task = &report.tasks[0];
    assert_eq!(task.skip, None);
    assert_eq!(task.project_id, Some(pid));
    assert_eq!(task.partitions, vec![alice.id]);
    assert_eq!(visible(&router, &alice, tid).await, original);
}

#[tokio::test]
async fn a_delete_outside_the_window_is_left_alone() {
    let (router, pool) = setup().await;
    let (alice, bob) = (new_user(&router).await, new_user(&router).await);
    let base = now_ms() - 60_000;
    let (pid, tid) = project_with_task(&router, &alice, base).await;
    share(&router, &alice, &bob, pid).await;
    push(&router, &bob, vec![delete(tid, base + 100)]).await;
    let rows = op_rows(&pool, tid).await;

    for (since, until) in [(base + 101, base + 1000), (base, base + 99)] {
        let mut o = opts(RestoreScope::Project(pid), since, until);
        o.apply = true;
        o.all_deleters = true;
        let report = restore_tasks(&pool, &o).await.unwrap();
        assert!(report.tasks.is_empty(), "{report:?}");
    }
    assert_eq!(op_rows(&pool, tid).await, rows);
    assert!(visible(&router, &alice, tid).await.is_empty());
    assert!(visible(&router, &bob, tid).await.is_empty());
}

#[tokio::test]
async fn restore_beats_a_delete_stamped_by_a_clock_running_ahead() {
    // Push accepts up to 5 minutes of client clock skew, so a tombstone can sit in the server's
    // future; restored fields must still carry a newer HLC or the task stays hidden.
    let (router, pool) = setup().await;
    let (alice, bob) = (new_user(&router).await, new_user(&router).await);
    let base = now_ms() - 60_000;
    let (pid, tid) = project_with_task(&router, &alice, base).await;
    share(&router, &alice, &bob, pid).await;
    let original = visible(&router, &alice, tid).await;
    let ahead = now_ms() + 120_000;
    push(&router, &bob, vec![delete(tid, ahead)]).await;

    let mut o = opts(RestoreScope::Project(pid), ahead - 1, ahead + 1);
    o.apply = true;
    let report = restore_tasks(&pool, &o).await.unwrap();
    assert_eq!(report.restored(), 1, "{report:?}");
    assert_eq!(visible(&router, &alice, tid).await, original);
    assert_eq!(visible(&router, &bob, tid).await, original);
}

/// Whether an entity is visible in `user`'s partition: no tombstone, or a field newer than it.
async fn is_live(pool: &PgPool, user: Uuid, entity: &str, id: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM entity_fields f
                         WHERE f.user_id = $1 AND f.entity = $2 AND f.entity_id = $3
                           AND NOT EXISTS (
                             SELECT 1 FROM entity_tombstones t
                              WHERE t.user_id = f.user_id AND t.entity = f.entity
                                AND t.entity_id = f.entity_id
                                AND (t.hlc_wall_ms, t.hlc_counter, t.hlc_node)
                                    >= (f.hlc_wall_ms, f.hlc_counter, f.hlc_node)))",
    )
    .bind(user)
    .bind(entity)
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn delete_attachment(id: Uuid, wall: u64) -> Value {
    json!({
        "id": Uuid::now_v7(), "entity": "attachment", "entity_id": id, "op": "delete",
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

#[tokio::test]
async fn a_restored_task_brings_back_the_attachments_deleted_with_it() {
    let (router, pool) = setup().await;
    let (alice, bob) = (new_user(&router).await, new_user(&router).await);
    let base = now_ms() - 60_000;
    let (pid, tid) = project_with_task(&router, &alice, base).await;
    share(&router, &alice, &bob, pid).await;
    let attachment = |id: Uuid, sha: &str| {
        vec![
            set(
                "attachment",
                id,
                "task_id",
                json!(tid.to_string()),
                base + 2,
            ),
            set("attachment", id, "blob_sha", json!(sha), base + 2),
            set("attachment", id, "meta", envelope("meta"), base + 2),
        ]
    };
    let (kept, dropped) = (Uuid::now_v7(), Uuid::now_v7());
    push(&router, &alice, attachment(kept, &"a".repeat(64))).await;
    push(&router, &alice, attachment(dropped, &"b".repeat(64))).await;
    // One attachment was deleted on its own before the window; that delete must stand.
    push(&router, &alice, vec![delete_attachment(dropped, base + 10)]).await;
    // Bob's purge of the task takes its remaining attachment with it.
    push(
        &router,
        &bob,
        vec![delete(tid, base + 100), delete_attachment(kept, base + 100)],
    )
    .await;
    assert!(!is_live(&pool, alice.id, "attachment", kept).await);

    let apply = RestoreOptions {
        apply: true,
        ..opts(RestoreScope::Project(pid), base + 50, base + 200)
    };
    let report = restore_tasks(&pool, &apply).await.unwrap();
    assert_eq!(report.restored(), 1, "{report:?}");
    assert_eq!(report.tasks[0].attachments, vec![kept]);
    for user in [alice.id, bob.id] {
        assert!(is_live(&pool, user, "task", tid).await);
        assert!(
            is_live(&pool, user, "attachment", kept).await,
            "restored with its task"
        );
        assert!(
            !is_live(&pool, user, "attachment", dropped).await,
            "deleted on its own"
        );
    }
}
