//! Integration tests for the multi-app sync: Atlas Journal's owner-only kinds, app-scoped
//! sessions (`x-atlas-sync-apps` on pull, snapshot, the socket and push), the export by app, and
//! API tokens scoped to apps. Runs against the Postgres in `TEST_DATABASE_URL`; each test signs up
//! its own accounts.

use std::time::Duration;

use atlas_server::config::{BlobBackend, Config};
use atlas_server::{app, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;
use uuid::Uuid;

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
        .header("x-atlas-sync-protocol", "6");
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

fn set_op(entity: &str, entity_id: Uuid, field: &str, value: Value) -> Value {
    json!({
        "id": Uuid::now_v7(),
        "entity": entity,
        "entity_id": entity_id,
        "op": "set",
        "field": field,
        "value": value,
        "ts": { "wall_ms": now_ms(), "counter": 0, "node": Uuid::now_v7() },
    })
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

fn refused(body: &Value, app: &str, scope: &str) {
    assert_eq!(body["code"], "app_not_enabled", "{body:?}");
    assert_eq!(body["app"], app, "{body:?}");
    assert_eq!(body["scope"], scope, "{body:?}");
}

#[tokio::test]
async fn discovery_offers_journal_and_app_scoped_sync() {
    let (_, router) = suite().await;
    let (status, body) = send(&router, "GET", "/discovery", None, None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["apps"],
        json!([
            { "id": "todo", "name": "Atlas Todo", "version": 1 },
            { "id": "journal", "name": "Atlas Journal", "version": 1 },
        ])
    );
    let caps = body["capabilities"].as_array().unwrap();
    for cap in ["app_scoped_sync", "app_scoped_api_tokens"] {
        assert!(caps.contains(&json!(cap)), "{cap}");
    }
}

#[tokio::test]
async fn journal_must_be_enabled_and_in_the_sessions_scope_to_push() {
    let (_, router) = suite().await;
    let user = signup(&router).await;
    let entry = || set_op("journal.entry", Uuid::now_v7(), "body", json!("ct"));

    // Not enabled for the account yet: refused, and naming it in a scope is refused too.
    let (status, body) = push(&router, &user.token, Some("journal"), vec![entry()]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "account");
    let (status, body) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&user.token),
        Some("journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "account");

    enable_journal(&router, &user).await;

    // A todo session (no header: every client predating app-scoped sync) cannot write journal.
    let (status, body) = push(&router, &user.token, None, vec![entry()]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "session");
    // Nor a journal session todo.
    let task = set_op("task", Uuid::now_v7(), "title", json!("ct"));
    let (status, body) = push(&router, &user.token, Some("journal"), vec![task]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "todo", "session");

    let (status, body) = push(&router, &user.token, Some("journal"), vec![entry()]).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["applied"], 1);

    // A bad scope header is a 400.
    for bad in ["", "notes", "todo;journal"] {
        let (status, _) = push(&router, &user.token, Some(bad), vec![]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}");
    }

    // An instance that does not offer journal refuses it by name.
    let todo_only = app(AppState::new(pool().await, config(&["todo"])));
    let (status, body) = push(&todo_only, &user.token, Some("journal"), vec![entry()]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "instance");
}

#[tokio::test]
async fn pull_and_snapshot_serve_only_the_sessions_apps() {
    let (_, router) = suite().await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;

    let task = Uuid::now_v7();
    let entry = Uuid::now_v7();
    let pref = Uuid::now_v7();
    let (status, _) = push(
        &router,
        &user.token,
        None,
        vec![set_op("task", task, "title", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![
            set_op("journal.entry", entry, "body", json!("ct")),
            set_op("journal.entry", entry, "date", json!("ct")),
            set_op("journal.preference", pref, "value", json!("ct")),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = push(
        &router,
        &user.token,
        Some("todo"),
        vec![set_op("task", task, "notes", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A todo session (implicit or named) sees todo only, a journal session journal only, and
    // both pulls reach the partition's head, past the other app's ops.
    let (todo_ops, todo_cursor) = pull(&router, &user.token, None).await;
    assert_eq!(entities(&todo_ops), ["task"]);
    assert_eq!(todo_ops.len(), 2);
    assert_eq!(pull(&router, &user.token, Some("todo")).await.0, todo_ops);
    let (journal_ops, journal_cursor) = pull(&router, &user.token, Some("journal")).await;
    assert_eq!(
        entities(&journal_ops),
        ["journal.entry", "journal.preference"]
    );
    assert_eq!(journal_ops.len(), 3);
    assert_eq!(todo_cursor, journal_cursor);
    let (both, both_cursor) = pull(&router, &user.token, Some("todo,journal")).await;
    assert_eq!(both.len(), 5);
    assert_eq!(both_cursor, todo_cursor);

    // A cursor past the last journal op: a journal pull is caught up, cursor at the head.
    let (status, body) = send(
        &router,
        "GET",
        "/sync/pull?since=0&limit=1",
        Some(&user.token),
        Some("journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["operations"].as_array().unwrap().len(), 1);
    assert!(
        body["cursor"].as_i64().unwrap() < todo_cursor,
        "a full page stops at its last op"
    );

    assert_eq!(
        entities(&snapshot(&router, &user.token, None).await),
        ["task"]
    );
    assert_eq!(
        entities(&snapshot(&router, &user.token, Some("journal")).await),
        ["journal.entry", "journal.preference"]
    );
    assert_eq!(
        snapshot(&router, &user.token, Some("journal,todo"))
            .await
            .len(),
        5
    );

    // The snapshot pages by key within the scope: one key per page walks only journal keys.
    let mut next: Option<String> = None;
    let mut pages = 0;
    loop {
        let uri = match &next {
            Some(t) => format!("/sync/snapshot?limit=1&next={}", urlencode(t)),
            None => "/sync/snapshot?limit=1".to_string(),
        };
        let (status, body) = send(
            &router,
            "GET",
            &uri,
            Some(&user.token),
            Some("journal"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        pages += 1;
        assert!(body["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|op| op["entity"].as_str().unwrap().starts_with("journal.")));
        match body["next"].as_str() {
            Some(t) => next = Some(t.to_string()),
            None => break,
        }
    }
    assert_eq!(pages, 2, "two journal keys");
}

fn urlencode(s: &str) -> String {
    s.replace('/', "%2F")
}

#[tokio::test]
async fn journal_ops_stay_with_their_owner_even_naming_a_shared_project() {
    let (_, router) = suite().await;
    let alice = signup(&router).await;
    let bob = signup(&router).await;
    enable_journal(&router, &alice).await;
    enable_journal(&router, &bob).await;

    // Alice shares a project with Bob, who accepts.
    let project = Uuid::now_v7();
    let (status, _) = push(
        &router,
        &alice.token,
        None,
        vec![set_op("project", project, "name", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = send(
        &router,
        "POST",
        &format!("/projects/{project}/members"),
        Some(&alice.token),
        None,
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{project}/accept"),
        Some(&bob.token),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A journal entry whose fields name the shared project and one of its tasks, and whose id
    // is that task's: none of it is a link the server follows.
    let task = Uuid::now_v7();
    let (status, _) = push(
        &router,
        &alice.token,
        None,
        vec![
            set_op("task", task, "project_id", json!(project.to_string())),
            set_op("task", task, "title", json!("ct")),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = push(
        &router,
        &alice.token,
        Some("journal"),
        vec![
            set_op(
                "journal.entry",
                task,
                "project_id",
                json!(project.to_string()),
            ),
            set_op("journal.entry", task, "task_id", json!(task.to_string())),
            set_op(
                "journal.entry",
                Uuid::now_v7(),
                "project_id",
                json!(project.to_string()),
            ),
            set_op("journal.preference", project, "value", json!("ct")),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let (bob_journal, _) = pull(&router, &bob.token, Some("journal")).await;
    assert!(
        bob_journal.is_empty(),
        "journal never fans out: {bob_journal:?}"
    );
    let (bob_todo, _) = pull(&router, &bob.token, Some("todo,journal")).await;
    assert!(
        bob_todo
            .iter()
            .any(|op| op["entity"] == "task" && op["entity_id"] == json!(task)),
        "the shared task still reaches Bob"
    );
    assert!(bob_todo
        .iter()
        .all(|op| !op["entity"].as_str().unwrap().starts_with("journal.")));
    let (alice_journal, _) = pull(&router, &alice.token, Some("journal")).await;
    assert_eq!(alice_journal.len(), 4);
}

#[tokio::test]
async fn fan_out_skips_members_without_the_app() {
    let (state, router) = suite().await;
    let alice = signup(&router).await;
    let bob = signup(&router).await;
    let project = Uuid::now_v7();
    let (status, _) = push(
        &router,
        &alice.token,
        None,
        vec![set_op("project", project, "name", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{project}/members"),
        Some(&alice.token),
        None,
        json!({ "email": bob.email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = send(
        &router,
        "POST",
        &format!("/projects/{project}/accept"),
        Some(&bob.token),
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let bob_id = bob.id;
    let delivered = |task: Uuid| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM operations WHERE user_id = $1 AND entity_id = $2",
            )
            .bind(bob_id)
            .bind(task)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let shared_task = |task: Uuid| {
        vec![
            set_op("task", task, "project_id", json!(project.to_string())),
            set_op("task", task, "title", json!("ct")),
        ]
    };

    let first = Uuid::now_v7();
    let (status, _) = push(&router, &alice.token, None, shared_task(first)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(delivered(first).await, 2);

    // Without todo, Bob's partition no longer receives todo ops.
    sqlx::query("DELETE FROM account_apps WHERE user_id = $1 AND app = 'todo'")
        .bind(bob.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let second = Uuid::now_v7();
    let (status, _) = push(&router, &alice.token, None, shared_task(second)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(delivered(second).await, 0);
}

#[tokio::test]
async fn export_follows_the_scope_and_the_enabled_apps() {
    let (_, router) = suite().await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;
    push(
        &router,
        &user.token,
        None,
        vec![set_op("task", Uuid::now_v7(), "title", json!("ct"))],
    )
    .await;
    push(
        &router,
        &user.token,
        Some("journal"),
        vec![set_op("journal.entry", Uuid::now_v7(), "body", json!("ct"))],
    )
    .await;

    let export = |apps: Option<&'static str>| {
        let router = router.clone();
        let token = user.token.clone();
        async move {
            let (status, body) = send(
                &router,
                "GET",
                "/auth/export",
                Some(&token),
                apps,
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body:?}");
            body
        }
    };
    let todo = export(None).await;
    assert_eq!(todo["data"]["apps"], json!(["todo"]));
    assert_eq!(
        entities(todo["data"]["operations"].as_array().unwrap()),
        ["task"]
    );
    let journal = export(Some("journal")).await;
    assert_eq!(journal["data"]["apps"], json!(["journal"]));
    assert_eq!(
        entities(journal["data"]["operations"].as_array().unwrap()),
        ["journal.entry"]
    );
    let both = export(Some("todo,journal")).await;
    assert_eq!(both["data"]["operations"].as_array().unwrap().len(), 2);
    // The account's app keys travel with every export: they open under the root.
    assert_eq!(both["account"]["app_keys"].as_array().unwrap().len(), 2);

    // An instance that stopped offering journal exports none of it.
    let todo_only = app(AppState::new(pool().await, config(&["todo"])));
    let (status, body) = send(
        &todo_only,
        "GET",
        "/auth/export",
        Some(&user.token),
        Some("journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "instance");
}

async fn spawn_server(state: &AppState) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = app(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });
    addr
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(
    addr: std::net::SocketAddr,
    router: &Router,
    token: &str,
    apps: Option<&str>,
) -> Ws {
    let (status, body) = send(
        router,
        "POST",
        "/sync/ws-ticket",
        Some(token),
        apps,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let ticket = body["ticket"].as_str().unwrap();
    tokio_tungstenite::connect_async(format!(
        "ws://{addr}/sync/ws?ticket={ticket}&since=0&protocol=6"
    ))
    .await
    .expect("ws connect")
    .0
}

async fn next_payload(ws: &mut Ws) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                WsMessage::Text(text) => return serde_json::from_str(&text).unwrap(),
                WsMessage::Close(frame) => panic!("closed: {frame:?}"),
                _ => {}
            }
        }
        panic!("socket ended")
    })
    .await
    .expect("a payload in time")
}

#[tokio::test]
async fn sockets_backfill_and_stream_only_their_apps() {
    let (state, router) = suite().await;
    let addr = spawn_server(&state).await;
    let user = signup(&router).await;
    enable_journal(&router, &user).await;
    let (status, _) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![set_op(
            "journal.entry",
            Uuid::now_v7(),
            "body",
            json!("old"),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let mut todo_ws = connect(addr, &router, &user.token, None).await;
    let mut journal_ws = connect(addr, &router, &user.token, Some("journal")).await;
    let backfill = next_payload(&mut todo_ws).await;
    assert_eq!(backfill["operations"], json!([]));
    assert!(
        backfill["cursor"].as_i64().unwrap() > 0,
        "walked past journal"
    );
    let backfill = next_payload(&mut journal_ws).await;
    assert_eq!(
        entities(backfill["operations"].as_array().unwrap()),
        ["journal.entry"]
    );

    // A todo push: the todo socket gets the op, the journal socket only the cursor move.
    let (status, pushed) = push(
        &router,
        &user.token,
        None,
        vec![set_op("task", Uuid::now_v7(), "title", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let live = next_payload(&mut todo_ws).await;
    assert_eq!(entities(live["operations"].as_array().unwrap()), ["task"]);
    let live = next_payload(&mut journal_ws).await;
    assert_eq!(live["operations"], json!([]));
    assert_eq!(live["cursor"], pushed["cursor"]);
    assert_eq!(live["from"], pushed["from"]);

    // And the other way round.
    let (status, pushed) = push(
        &router,
        &user.token,
        Some("journal"),
        vec![set_op(
            "journal.entry",
            Uuid::now_v7(),
            "body",
            json!("new"),
        )],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let live = next_payload(&mut journal_ws).await;
    assert_eq!(
        entities(live["operations"].as_array().unwrap()),
        ["journal.entry"]
    );
    let live = next_payload(&mut todo_ws).await;
    assert_eq!(live["operations"], json!([]));
    assert_eq!(live["cursor"], pushed["cursor"]);

    // A ticket for a scope the account has not enabled is refused before any socket exists.
    let other = signup(&router).await;
    let (status, body) = send(
        &router,
        "POST",
        "/sync/ws-ticket",
        Some(&other.token),
        Some("journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "account");
}

struct ApiToken {
    id: Uuid,
    auth: String,
}

fn new_token() -> ApiToken {
    ApiToken {
        id: Uuid::new_v4(),
        auth: hex::encode(random_bytes::<32>()),
    }
}

async fn create_token(
    router: &Router,
    user: &User,
    token: &ApiToken,
    extra: Value,
) -> (StatusCode, Value) {
    let mut body = json!({ "id": token.id, "name": "journal sync", "auth": token.auth });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    send(
        router,
        "POST",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        body,
    )
    .await
}

async fn open_token(router: &Router, token: &ApiToken) -> Value {
    let (status, body) = send(
        router,
        "POST",
        "/auth/api-token/session",
        None,
        None,
        json!({ "token_id": token.id, "auth": token.auth }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body
}

#[tokio::test]
async fn api_tokens_sync_only_the_apps_they_carry_keys_for() {
    let (_, router) = suite().await;
    let user = signup(&router).await;
    let journal_keys =
        json!({ "journal": { "wrapped_key": wrap(), "wrapped_private_key": wrap() } });

    // Journal is not enabled yet: no journal token.
    let (status, body) = create_token(
        &router,
        &user,
        &new_token(),
        json!({ "apps": ["journal"], "app_keys": journal_keys }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    refused(&body, "journal", "account");
    enable_journal(&router, &user).await;

    // Malformed scopes.
    for extra in [
        json!({ "apps": [] }),
        json!({ "apps": ["notes"] }),
        // The todo wraps are required for todo and refused without it.
        json!({ "apps": ["todo"] }),
        json!({ "apps": ["journal"], "app_keys": journal_keys, "wrapped_dek": wrap(),
                "wrapped_private_key": wrap() }),
        // Every other app needs its entry, and no entry for an app the token is not for.
        json!({ "apps": ["journal"] }),
        json!({ "wrapped_dek": wrap(), "wrapped_private_key": wrap(), "app_keys": journal_keys }),
    ] {
        let (status, body) = create_token(&router, &user, &new_token(), extra.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{extra} {body:?}");
    }

    // A journal token.
    let journal = new_token();
    let (status, body) = create_token(
        &router,
        &user,
        &journal,
        json!({ "apps": ["journal"], "app_keys": journal_keys }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    assert_eq!(body["apps"], json!(["journal"]));
    let session = open_token(&router, &journal).await;
    assert_eq!(session["apps"], json!(["journal"]));
    assert!(
        session.get("wrapped_dek").is_none(),
        "no todo key: {session:?}"
    );
    assert_eq!(session["app_keys"], journal_keys);
    let pat = session["access_token"].as_str().unwrap();

    // Its sessions sync journal only: the implicit todo scope and any scope naming todo are 403.
    let (status, body) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(pat),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "todo", "token");
    let (status, body) = send(
        &router,
        "GET",
        "/sync/snapshot",
        Some(pat),
        Some("todo,journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "todo", "token");
    let (status, _) = push(
        &router,
        pat,
        Some("journal"),
        vec![set_op("journal.entry", Uuid::now_v7(), "body", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pull(&router, pat, Some("journal")).await.0.len(), 1);
    let (status, body) = send(
        &router,
        "POST",
        "/sync/ws-ticket",
        Some(pat),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "todo", "token");

    // A token made the old way is a todo token: it cannot reach journal.
    let todo = new_token();
    let (status, body) = create_token(
        &router,
        &user,
        &todo,
        json!({ "wrapped_dek": wrap(), "wrapped_private_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    assert_eq!(body["apps"], json!(["todo"]));
    let session = open_token(&router, &todo).await;
    assert_eq!(session["apps"], json!(["todo"]));
    assert!(session.get("app_keys").is_none());
    let pat = session["access_token"].as_str().unwrap();
    assert!(pull(&router, pat, None).await.0.is_empty());
    let (status, body) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(pat),
        Some("journal"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    refused(&body, "journal", "token");

    // Both, and the listing shows each token's apps.
    let both = new_token();
    let (status, body) = create_token(
        &router,
        &user,
        &both,
        json!({ "apps": ["todo", "journal"], "wrapped_dek": wrap(), "wrapped_private_key": wrap(),
                "app_keys": journal_keys }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    assert_eq!(body["apps"], json!(["journal", "todo"]));
    let pat = open_token(&router, &both).await["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(pull(&router, &pat, Some("todo,journal")).await.0.len(), 1);
    let (status, list) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let apps_of = |id: Uuid| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == json!(id))
            .unwrap()["apps"]
            .clone()
    };
    assert_eq!(apps_of(journal.id), json!(["journal"]));
    assert_eq!(apps_of(todo.id), json!(["todo"]));

    // Revoking drops the app wraps with the todo ones.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/api-tokens/{}", journal.id),
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/api-token/session",
        None,
        None,
        json!({ "token_id": journal.id, "auth": journal.auth }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_journal_token_needs_the_accounts_journal_key() {
    let (state, router) = suite().await;
    let user = signup(&router).await;
    // Enabled without a key (as a client that skipped the key step would leave it).
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/apps/journal",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = create_token(
        &router,
        &user,
        &new_token(),
        json!({ "apps": ["journal"],
                "app_keys": { "journal": { "wrapped_key": wrap(), "wrapped_private_key": wrap() } } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    let stored: i64 = sqlx::query_scalar("SELECT count(*) FROM api_tokens WHERE user_id = $1")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(stored, 0);
}
