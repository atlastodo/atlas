//! Integration tests for the sync op-log endpoints (`/sync/push`, `/sync/pull`).

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
    app(setup_state().await)
}

async fn setup_state() -> AppState {
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
    AppState::new(pool, config)
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    send_with_protocol(router, method, uri, token, Some("6"), body).await
}

/// [`send`] with explicit control over the `x-atlas-sync-protocol` header (`None` omits it).
async fn send_with_protocol(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    protocol: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(p) = protocol {
        b = b.header("x-atlas-sync-protocol", p);
    }
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

async fn new_user_token(router: &Router) -> String {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": format!("s-{}@example.com", Uuid::now_v7()), "password": PASSWORD
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    body["access_token"].as_str().unwrap().to_string()
}

/// Build a Set operation JSON with the given HLC components.
fn set_op(
    entity_id: Uuid,
    field: &str,
    value: Value,
    wall: u64,
    counter: u32,
    node: Uuid,
) -> Value {
    json!({
        "id": Uuid::now_v7(),
        "entity": "task",
        "entity_id": entity_id,
        "op": "set",
        "field": field,
        "value": value,
        "ts": { "wall_ms": wall, "counter": counter, "node": node },
    })
}

fn delete_op(entity_id: Uuid, wall: u64, counter: u32, node: Uuid) -> Value {
    json!({
        "id": Uuid::now_v7(),
        "entity": "task",
        "entity_id": entity_id,
        "op": "delete",
        "ts": { "wall_ms": wall, "counter": counter, "node": node },
    })
}

#[tokio::test]
async fn push_then_pull_round_trips_ops() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let tid = Uuid::now_v7();
    let node = Uuid::now_v7();

    let (status, resp) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("Buy milk"), 100, 0, node)]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert_eq!(resp["applied"], 1);

    let (status, pulled) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ops = pulled["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["field"], "title");
    assert_eq!(ops[0]["value"], "Buy milk");
    assert!(pulled["cursor"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn push_is_idempotent_on_op_id() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let op = set_op(Uuid::now_v7(), "title", json!("x"), 1, 0, Uuid::now_v7());

    let (_, first) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [op.clone()] }),
    )
    .await;
    assert_eq!(first["applied"], 1);
    // Re-pushing the exact same op (same op_id) applies nothing new.
    let (_, second) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [op] }),
    )
    .await;
    assert_eq!(second["applied"], 0);

    let (_, pulled) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(pulled["operations"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn pull_since_cursor_returns_only_newer_ops() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let tid = Uuid::now_v7();
    let node = Uuid::now_v7();

    send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("a"), 1, 0, node)]
        }),
    )
    .await;
    let (_, mid) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    let cursor = mid["cursor"].as_i64().unwrap();

    send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "notes", json!("b"), 2, 0, node)]
        }),
    )
    .await;

    let (_, after) = send(
        &router,
        "GET",
        &format!("/sync/pull?since={cursor}"),
        Some(&token),
        Value::Null,
    )
    .await;
    let ops = after["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "only the op after the cursor");
    assert_eq!(ops[0]["field"], "notes");
}

#[tokio::test]
async fn ops_are_isolated_between_users() {
    let router = setup().await;
    let alice = new_user_token(&router).await;
    let bob = new_user_token(&router).await;

    send(
        &router,
        "POST",
        "/sync/push",
        Some(&alice),
        json!({
            "operations": [set_op(Uuid::now_v7(), "title", json!("alice"), 1, 0, Uuid::now_v7())]
        }),
    )
    .await;

    let (_, bobs) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&bob),
        Value::Null,
    )
    .await;
    assert_eq!(
        bobs["operations"].as_array().unwrap().len(),
        0,
        "bob sees none of alice's ops"
    );
}

#[tokio::test]
async fn push_requires_auth() {
    let router = setup().await;
    let (status, _) = send(
        &router,
        "POST",
        "/sync/push",
        None,
        json!({ "operations": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn empty_push_is_ok() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let (status, resp) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resp["applied"], 0);
    assert_eq!(resp["cursor"], 0);
}

// --- LWW-resolved state (queried via a tiny SQL peek helper on the shared pool) ---

/// Read the LWW-resolved value of one field straight from the materialized state.
async fn resolved_field(pool: &sqlx::PgPool, entity_id: Uuid, field: &str) -> Option<Value> {
    sqlx::query_scalar::<_, Value>(
        "SELECT value FROM entity_fields WHERE entity = 'task' AND entity_id = $1 AND field = $2",
    )
    .bind(entity_id)
    .bind(field)
    .fetch_optional(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn lww_higher_hlc_wins_regardless_of_arrival_order() {
    let pool = db::connect(&test_database_url()).await.unwrap();
    db::migrate(&pool).await.unwrap();
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
    let router = app(AppState::new(pool.clone(), config));
    let token = new_user_token(&router).await;
    let tid = Uuid::now_v7();
    let node = Uuid::now_v7();

    // Apply the higher-HLC op first, then a lower-HLC op for the same field.
    send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("new"), 10, 0, node)]
        }),
    )
    .await;
    send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("old"), 5, 0, node)]
        }),
    )
    .await;

    assert_eq!(
        resolved_field(&pool, tid, "title").await,
        Some(json!("new")),
        "higher HLC must win"
    );
}

#[tokio::test]
async fn tombstone_records_delete() {
    let pool = db::connect(&test_database_url()).await.unwrap();
    db::migrate(&pool).await.unwrap();
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
    let router = app(AppState::new(pool.clone(), config));
    let token = new_user_token(&router).await;
    let tid = Uuid::now_v7();
    let node = Uuid::now_v7();

    send(&router, "POST", "/sync/push", Some(&token), json!({
        "operations": [set_op(tid, "title", json!("doomed"), 1, 0, node), delete_op(tid, 2, 0, node)]
    })).await;

    let tomb: Option<i64> = sqlx::query_scalar(
        "SELECT hlc_wall_ms FROM entity_tombstones WHERE entity = 'task' AND entity_id = $1",
    )
    .bind(tid)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(tomb, Some(2), "delete is tombstoned at its HLC wall time");
}

#[tokio::test]
async fn oversized_push_body_answers_413() {
    // The explicit body limit (MAX_PUSH_BYTES) replaces axum's implicit 2 MB on the sync routes:
    // a push past it is refused with 413 before any op is parsed.
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let mut config = Config {
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
    config.max_push_bytes = 1024;
    let router = app(AppState::new(pool, config));

    let token = new_user_token(&router).await;
    // Well-formed JSON whose body simply exceeds the (tiny) configured limit. The limit rejection
    // is axum's plain-text body-limit error, so this reads the status without parsing a body.
    let pad = "x".repeat(4096);
    let req = Request::builder()
        .method("POST")
        .uri("/sync/push")
        .header("content-type", "application/json")
        .header("x-atlas-sync-protocol", "6")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(
            serde_json::to_vec(&json!({ "operations": [], "pad": pad })).unwrap(),
        ))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

// --- Sync protocol gate: outdated clients are refused before they can write ---

fn assert_upgrade_required(status: StatusCode, body: &Value, ctx: &str) {
    assert_eq!(status, StatusCode::UPGRADE_REQUIRED, "{ctx}: {body:?}");
    assert_eq!(
        body,
        &json!({ "error": "client update required", "code": "upgrade_required", "min_protocol": 6 }),
        "{ctx}"
    );
}

const SYNC_CALLS: [(&str, &str); 4] = [
    ("POST", "/sync/push"),
    ("GET", "/sync/pull?since=0"),
    ("GET", "/sync/snapshot"),
    ("POST", "/sync/ws-ticket"),
];

#[tokio::test]
async fn sync_without_protocol_header_is_426() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    for (method, uri) in SYNC_CALLS {
        let (status, body) = send_with_protocol(
            &router,
            method,
            uri,
            Some(&token),
            None,
            json!({ "operations": [] }),
        )
        .await;
        assert_upgrade_required(status, &body, uri);
    }
    // The gate runs before authentication, so even an anonymous old client learns it must update.
    let (status, body) = send_with_protocol(
        &router,
        "POST",
        "/sync/push",
        None,
        None,
        json!({ "operations": [] }),
    )
    .await;
    assert_upgrade_required(status, &body, "anonymous push");
}

#[tokio::test]
async fn sync_with_old_or_unparsable_protocol_is_426() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    for protocol in [
        "5",
        "4",
        "3",
        "2",
        "1",
        "0",
        "-3",
        "",
        "three",
        "3.0",
        "99999999999999999999",
    ] {
        for (method, uri) in SYNC_CALLS {
            let (status, body) = send_with_protocol(
                &router,
                method,
                uri,
                Some(&token),
                Some(protocol),
                json!({ "operations": [] }),
            )
            .await;
            assert_upgrade_required(status, &body, &format!("{uri} with protocol {protocol:?}"));
        }
    }
}

#[tokio::test]
async fn sync_with_current_or_newer_protocol_is_served() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    for protocol in ["6", "7", " 6 "] {
        for (method, uri) in SYNC_CALLS {
            let (status, body) = send_with_protocol(
                &router,
                method,
                uri,
                Some(&token),
                Some(protocol),
                json!({ "operations": [] }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{uri} with {protocol:?}: {body:?}");
        }
    }
}

#[tokio::test]
async fn api_mount_is_gated_too() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let (status, body) = send_with_protocol(
        &router,
        "GET",
        "/api/sync/pull?since=0",
        Some(&token),
        None,
        Value::Null,
    )
    .await;
    assert_upgrade_required(status, &body, "/api/sync/pull without header");
    let (status, body) = send_with_protocol(
        &router,
        "GET",
        "/api/sync/pull?since=0",
        Some(&token),
        Some("5"),
        Value::Null,
    )
    .await;
    assert_upgrade_required(status, &body, "/api/sync/pull with protocol 5");
    let (status, _) = send_with_protocol(
        &router,
        "GET",
        "/api/sync/pull?since=0",
        Some(&token),
        Some("6"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn protocol_gate_is_scoped_to_sync() {
    // Sign-in and account routes must keep working for an old build, or it could never reach the
    // "update required" screen (or log out) at all.
    let router = setup().await;
    let token = new_user_token(&router).await;
    let (status, _) =
        send_with_protocol(&router, "GET", "/auth/me", Some(&token), None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn ws_requires_the_protocol_query_param() {
    use tokio_tungstenite::tungstenite::Error as WsError;

    let router = setup().await;
    let token = new_user_token(&router).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = router.clone();
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });

    // Browsers cannot set headers on a WebSocket, so the version rides as `protocol=`.
    for (path, query) in [
        ("/sync/ws", ""),
        ("/sync/ws", "&protocol=1"),
        ("/sync/ws", "&protocol=2"),
        ("/sync/ws", "&protocol=3"),
        ("/sync/ws", "&protocol=4"),
        ("/sync/ws", "&protocol=5"),
        ("/sync/ws", "&protocol=x"),
        ("/api/sync/ws", ""),
        ("/api/sync/ws", "&protocol=2"),
    ] {
        // The gate answers before the ticket is looked at.
        let url = format!("ws://{addr}{path}?ticket=unchecked&since=0{query}");
        match tokio_tungstenite::connect_async(url).await {
            Err(WsError::Http(res)) => {
                assert_eq!(res.status().as_u16(), 426, "{path}{query}");
                let body: Value = serde_json::from_slice(res.body().as_deref().unwrap()).unwrap();
                assert_eq!(body["code"], "upgrade_required", "{path}{query}");
                assert_eq!(body["min_protocol"], 6, "{path}{query}");
            }
            other => panic!("{path}{query}: expected a 426 handshake rejection, got {other:?}"),
        }
    }

    for path in ["/sync/ws", "/api/sync/ws"] {
        let (status, body) = send(
            &router,
            "POST",
            "/sync/ws-ticket",
            Some(&token),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        let ticket = body["ticket"].as_str().unwrap();
        let url = format!("ws://{addr}{path}?ticket={ticket}&since=0&protocol=6");
        tokio_tungstenite::connect_async(url)
            .await
            .unwrap_or_else(|e| panic!("{path} with protocol=6 must connect: {e:?}"));
    }
}

#[tokio::test]
async fn pull_below_the_purge_watermark_is_410() {
    let state = setup_state().await;
    let router = app(state.clone());
    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": format!("s-{}@example.com", Uuid::now_v7()), "password": PASSWORD
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = body["access_token"].as_str().unwrap().to_string();
    let user: Uuid = body["user"]["id"].as_str().unwrap().parse().unwrap();

    let node = Uuid::now_v7();
    let mut cursors = Vec::new();
    for i in 0..3 {
        let (status, body) = send(
            &router,
            "POST",
            "/sync/push",
            Some(&token),
            json!({ "operations": [set_op(Uuid::now_v7(), "title", json!(i), 100 + i, 0, node)] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        cursors.push(body["cursor"].as_i64().unwrap());
    }
    // As if retention purged everything up to the second op.
    sqlx::query("INSERT INTO sync_purge_watermarks (user_id, purged_seq) VALUES ($1, $2)")
        .bind(user)
        .bind(cursors[1])
        .execute(&state.pool)
        .await
        .unwrap();

    let pull = |since: i64| {
        let (router, token) = (router.clone(), token.clone());
        async move {
            let uri = format!("/sync/pull?since={since}");
            send(&router, "GET", &uri, Some(&token), Value::Null).await
        }
    };
    let (status, body) = pull(cursors[0]).await;
    assert_eq!(status, StatusCode::GONE, "{body:?}");
    assert_eq!(body["code"], "cursor_expired");

    let (status, body) = pull(cursors[1]).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a cursor at the watermark missed nothing"
    );
    assert_eq!(body["operations"].as_array().unwrap().len(), 1);
    let (status, _) = pull(0).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "since=0 is a bootstrap, not a stale cursor"
    );
}

/// Status and `Retry-After` of one sync request.
async fn status_and_retry_after(
    router: &Router,
    method: &str,
    uri: &str,
    token: &str,
) -> (StatusCode, Option<u64>) {
    let body = if method == "POST" {
        Body::from(json!({ "operations": [] }).to_string())
    } else {
        Body::empty()
    };
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-atlas-sync-protocol", "6")
        .header("authorization", format!("Bearer {token}"))
        .body(body)
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let retry_after = res
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    (res.status(), retry_after)
}

/// A bootstrap walks many snapshot and pull pages in a row; those reads must not spend the budget
/// that pushes (and other devices) share, and a refusal must say when to come back.
#[tokio::test]
async fn reads_have_their_own_budget_and_a_429_names_retry_after() {
    let router = setup().await;
    let token = new_user_token(&router).await;

    for i in 0..100 {
        let uri = if i % 2 == 0 {
            "/sync/pull?since=0"
        } else {
            "/sync/snapshot?limit=1000"
        };
        let (status, _) = status_and_retry_after(&router, "GET", uri, &token).await;
        assert_eq!(status, StatusCode::OK, "read {i} ({uri})");
    }

    let mut refused = None;
    for i in 0..61 {
        let (status, retry_after) =
            status_and_retry_after(&router, "POST", "/sync/push", &token).await;
        if i < 60 {
            assert_eq!(status, StatusCode::OK, "push {i} is within the push budget");
        } else {
            refused = Some((status, retry_after));
        }
    }
    let (status, retry_after) = refused.unwrap();
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let secs = retry_after.expect("a 429 carries Retry-After");
    assert!(
        (1..=60).contains(&secs),
        "Retry-After {secs}s is within the window"
    );
}

/// One batch folds exactly like its ops applied one at a time: several writes to one field, a
/// repeated op, and competing deletes, in an order that disagrees with their HLCs.
#[tokio::test]
async fn a_batch_folds_like_its_ops_applied_one_by_one() {
    let state = setup_state().await;
    let router = app(state.clone());
    let token = new_user_token(&router).await;
    let (tid, gone) = (Uuid::now_v7(), Uuid::now_v7());
    let node = Uuid::now_v7();

    let repeated = set_op(tid, "notes", json!("n"), 7, 0, node);
    let ops = vec![
        set_op(tid, "title", json!("middle"), 20, 0, node),
        set_op(tid, "title", json!("newest"), 20, 1, node),
        set_op(tid, "title", json!("oldest"), 10, 0, node),
        repeated.clone(),
        repeated,
        delete_op(gone, 30, 0, node),
        delete_op(gone, 50, 0, node),
        delete_op(gone, 40, 0, node),
    ];
    let (status, body) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": ops }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["applied"], 7, "the repeated op applies once");

    assert_eq!(
        resolved_field(&state.pool, tid, "title").await,
        Some(json!("newest"))
    );
    assert_eq!(
        resolved_field(&state.pool, tid, "notes").await,
        Some(json!("n"))
    );
    let tomb: i64 = sqlx::query_scalar(
        "SELECT hlc_wall_ms FROM entity_tombstones WHERE entity = 'task' AND entity_id = $1",
    )
    .bind(gone)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(tomb, 50, "the newest delete wins");

    // The log keeps every new op, in batch order.
    let (_, pulled) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    let walls: Vec<u64> = pulled["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|op| op["ts"]["wall_ms"].as_u64().unwrap())
        .collect();
    assert_eq!(walls, vec![20, 20, 10, 7, 30, 50, 40]);
}

#[tokio::test]
async fn push_response_names_the_cursor_it_follows() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let node = Uuid::now_v7();
    let op = set_op(Uuid::now_v7(), "title", json!("a"), 100, 0, node);

    let (_, first) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [op.clone()] }),
    )
    .await;
    assert_eq!(first["from"], 0, "an empty partition's head is 0");
    let head = first["cursor"].as_i64().unwrap();
    assert!(head > 0);

    let (_, second) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [set_op(Uuid::now_v7(), "title", json!("b"), 200, 0, node)] }),
    )
    .await;
    assert_eq!(second["from"], head);
    assert!(second["cursor"].as_i64().unwrap() > head);

    // A replayed batch adds nothing: from == cursor.
    let (_, replay) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [op] }),
    )
    .await;
    assert_eq!(replay["applied"], 0);
    assert_eq!(replay["from"], replay["cursor"]);
}

#[tokio::test]
async fn push_rejects_counters_above_the_clock_maximum() {
    let router = setup().await;
    let token = new_user_token(&router).await;
    let max = atlas_core::hlc::MAX_COUNTER;

    for counter in [max + 1, i32::MAX as u32] {
        let op = set_op(
            Uuid::now_v7(),
            "title",
            json!("x"),
            1,
            counter,
            Uuid::now_v7(),
        );
        let (status, body) = send(
            &router,
            "POST",
            "/sync/push",
            Some(&token),
            json!({ "operations": [op] }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "counter {counter}: {body:?}"
        );
    }

    let op = set_op(Uuid::now_v7(), "title", json!("x"), 1, max, Uuid::now_v7());
    let (status, body) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [op] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}
