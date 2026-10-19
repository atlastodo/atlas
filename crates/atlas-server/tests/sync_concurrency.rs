//! Concurrency tests for the sync cursor visibility race.
//!
//! `operations.server_seq` is a bigserial allocated at INSERT time inside each push transaction,
//! but rows only become visible to other transactions at COMMIT. Without serialization of sync
//! writes (see `sync::SYNC_WRITE_LOCK`), push A can allocate seq 10 while push B allocates seq 11
//! and commits first; a pull advances the client cursor to 11, A commits, and seq 10 is never
//! delivered — a permanent, silent op loss. These tests drive that interleaving through the real
//! `/sync/push` path — once for one user's two devices, once for two pushers fanning out into a
//! shared project — and assert the invariant: after both pushes complete, cumulative pulls
//! following cursors deliver every pushed op exactly once.

use std::collections::HashSet;
use std::time::Duration;

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
    let email = format!("cc-{}@example.com", Uuid::now_v7());
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
        email,
    }
}

/// Share `owner`'s project with `invitee` (invite + accept), mirroring `sync_share.rs`.
async fn invite_and_accept(router: &Router, owner: &User, invitee: &User, pid: &str, role: &str) {
    let (status, body) = http(
        router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&owner.token),
        json!({ "email": invitee.email, "role": role }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let (status, body) = http(
        router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&invitee.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn op(id: &str, entity: &str, entity_id: &str, field: &str, value: Value, wall: u64) -> Value {
    json!({
        "id": id, "entity": entity, "entity_id": entity_id,
        "op": "set", "field": field, "value": value,
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

/// Follow pull cursors from `since` until the log is drained; returns the delivered op ids and the
/// final cursor, so a later walk can resume exactly where this one stopped.
async fn drain(router: &Router, token: &str, since: i64) -> (HashSet<String>, i64) {
    let mut cursor = since;
    let mut delivered = HashSet::new();
    loop {
        let (status, page) = http(
            router,
            "GET",
            &format!("/sync/pull?since={cursor}&limit=1000"),
            Some(token),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page:?}");
        let ops = page["operations"].as_array().unwrap().clone();
        if ops.is_empty() {
            break;
        }
        for op in &ops {
            delivered.insert(op["id"].as_str().unwrap().to_string());
        }
        let next = page["cursor"].as_i64().unwrap();
        assert!(next > cursor, "pull cursor must strictly advance");
        cursor = next;
        if ops.len() < 1000 {
            break;
        }
    }
    (delivered, cursor)
}

/// The bigserial's `last_value` — the one allocation signal visible from OUTSIDE an in-flight push
/// transaction (op rows themselves are invisible until commit). Other concurrently-running tests
/// may also advance the shared sequence, so waiting on it only biases the legacy interleaving;
/// the assertions below hold under any interleaving now that sync writes serialize.
async fn seq_last_value(pool: &sqlx::PgPool) -> i64 {
    sqlx::query_scalar("SELECT last_value FROM operations_server_seq_seq")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Wait until at least ten seqs have been allocated since `baseline` (bounded, non-fatal: a missed
/// interleaving only weakens the legacy-bug demonstration, never a passing test's validity).
async fn wait_for_allocations(pool: &sqlx::PgPool, baseline: i64) {
    for _ in 0..2500 {
        if seq_last_value(pool).await >= baseline + 10 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[tokio::test]
async fn concurrent_pushes_by_one_user_never_lose_ops() {
    let state = make_state().await;
    let control = app(state.clone());
    let token = new_user(&control).await.token;
    let pool = db::connect(&test_database_url()).await.unwrap();
    let baseline = seq_last_value(&pool).await;

    // Device A pushes a large batch — slow enough to still be in flight after device B's tiny
    // push commits, which is the interleaving that silently lost ops before serialization.
    let mut expected: HashSet<String> = HashSet::new();
    let batch: Vec<Value> = (0..200)
        .map(|i| {
            let id = Uuid::now_v7().to_string();
            expected.insert(id.clone());
            op(
                &id,
                "task",
                &Uuid::now_v7().to_string(),
                "notes",
                json!(i),
                now_ms(),
            )
        })
        .collect();
    let b_id = Uuid::now_v7().to_string();
    let b_op = op(
        &b_id,
        "task",
        &Uuid::now_v7().to_string(),
        "notes",
        json!("late"),
        now_ms(),
    );
    expected.insert(b_id.clone());

    let a_router = control.clone();
    let a_token = token.clone();
    let a = tokio::spawn(async move {
        let (status, body) = http(
            &a_router,
            "POST",
            "/sync/push",
            Some(&a_token),
            json!({ "operations": batch }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
    });

    // Let A allocate (its rows stay invisible), then fire B.
    wait_for_allocations(&pool, baseline).await;
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [b_op] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    // Pull inside the loss window: on the unsynchronized code this response's cursor skips A's
    // allocated-but-uncommitted seqs, so the ops below it can never be delivered again.
    let (mut delivered, cursor) = drain(&control, &token, 0).await;
    a.await.unwrap();
    let (rest, _) = drain(&control, &token, cursor).await;
    delivered.extend(rest);

    assert_eq!(
        delivered, expected,
        "after both pushes complete, a cursor walk must deliver every pushed op exactly once"
    );
}

#[tokio::test]
async fn concurrent_pushers_to_a_shared_project_lose_no_fan_out() {
    let state = make_state().await;
    let control = app(state.clone());
    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();

    // Alice creates a project and shares it with Bob, so each pusher's transaction fans rows into
    // the OTHER's partition. Serialization must cover those cross-partition writes too, not just
    // the caller's own rows.
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&alice.token),
        json!({ "operations": [op(&Uuid::now_v7().to_string(), "project", &pid, "name", json!("P"), 100)] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    let pool = db::connect(&test_database_url()).await.unwrap();
    let baseline = seq_last_value(&pool).await;

    // Alice: 200 distinct tasks on the shared project, each fanning out into Bob's partition.
    let mut alice_ids: HashSet<String> = HashSet::new();
    let batch: Vec<Value> = (0..200)
        .map(|_| {
            let id = Uuid::now_v7().to_string();
            alice_ids.insert(id.clone());
            op(
                &id,
                "task",
                &Uuid::now_v7().to_string(),
                "project_id",
                json!(pid),
                now_ms(),
            )
        })
        .collect();
    let b_id = Uuid::now_v7().to_string();
    let b_op = op(
        &b_id,
        "task",
        &Uuid::now_v7().to_string(),
        "project_id",
        json!(pid),
        now_ms(),
    );

    let a_router = control.clone();
    let a_token = alice.token.clone();
    let a = tokio::spawn(async move {
        let (status, body) = http(
            &a_router,
            "POST",
            "/sync/push",
            Some(&a_token),
            json!({ "operations": batch }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
    });

    // Let Alice allocate, then fire Bob's tiny push into the same shared project.
    wait_for_allocations(&pool, baseline).await;
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&bob.token),
        json!({ "operations": [b_op] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    // Pull both partitions inside the loss window: on the unsynchronized code these responses'
    // cursors skip the other pusher's allocated-but-uncommitted fan-out seqs.
    let (mut bob_delivered, bob_cursor) = drain(&control, &bob.token, 0).await;
    let (mut alice_delivered, alice_cursor) = drain(&control, &alice.token, 0).await;
    a.await.unwrap();
    let (bob_rest, _) = drain(&control, &bob.token, bob_cursor).await;
    let (alice_rest, _) = drain(&control, &alice.token, alice_cursor).await;
    bob_delivered.extend(bob_rest);
    alice_delivered.extend(alice_rest);

    // Bob must receive every one of Alice's fanned-out ops plus Bob's own op.
    for id in &alice_ids {
        assert!(
            bob_delivered.contains(id),
            "bob's partition must deliver alice's fanned-out op {id}"
        );
    }
    assert!(bob_delivered.contains(&b_id), "bob must deliver his own op");
    // Alice must receive her own batch plus Bob's op fanned in.
    for id in &alice_ids {
        assert!(
            alice_delivered.contains(id),
            "alice's partition must deliver her own op {id}"
        );
    }
    assert!(
        alice_delivered.contains(&b_id),
        "alice must receive bob's fanned-out op"
    );
}

/// A push holds its transaction's connection (and the global sync-write lock) for its whole
/// duration, so every read it makes must ride that same connection. Were it to take a second one
/// from the pool, pushes queued on the lock would pin the remaining connections and the lock
/// holder could never finish: the server convoys into acquire timeouts and 500s.
#[tokio::test]
async fn concurrent_pushes_on_a_tiny_pool_all_complete() {
    let acquire_timeout = Duration::from_secs(10);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(acquire_timeout)
        .connect(&test_database_url())
        .await
        .unwrap();
    db::migrate(&pool).await.unwrap();
    let base = make_state().await;
    let state = AppState::new(pool, (*base.config).clone());
    let control = app(state.clone());

    let alice = new_user(&control).await;
    let bob = new_user(&control).await;
    let pid = Uuid::now_v7().to_string();
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&alice.token),
        json!({ "operations": [op(&Uuid::now_v7().to_string(), "project", &pid, "name", json!("P"), now_ms())] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    invite_and_accept(&control, &alice, &bob, &pid, "editor").await;

    // Pushes carrying `project_id` ops: each resolves the project's sharing, the caller's role and
    // the fan-out members while it holds the lock.
    let started = std::time::Instant::now();
    let mut pushes = Vec::new();
    for i in 0..8 {
        let token = if i % 2 == 0 { &alice.token } else { &bob.token }.clone();
        let router = control.clone();
        let pid = pid.clone();
        pushes.push(tokio::spawn(async move {
            let ops: Vec<Value> = (0..20)
                .map(|_| {
                    let tid = Uuid::now_v7().to_string();
                    op(
                        &Uuid::now_v7().to_string(),
                        "task",
                        &tid,
                        "project_id",
                        json!(pid),
                        now_ms(),
                    )
                })
                .collect();
            http(
                &router,
                "POST",
                "/sync/push",
                Some(&token),
                json!({ "operations": ops }),
            )
            .await
        }));
    }
    for push in pushes {
        let (status, body) = push.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{body:?}");
    }
    assert!(
        started.elapsed() < acquire_timeout / 2,
        "pushes must not wait on pool acquisition ({:?})",
        started.elapsed()
    );
}
