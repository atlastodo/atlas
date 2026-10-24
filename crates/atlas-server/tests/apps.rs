//! Integration tests for the suite's apps: `GET /discovery`, `ATLAS_APPS`, the account's apps
//! (`/auth/apps`) and sync refusing and hiding the ops of an app that is not enabled.
//! Runs against the Postgres in `TEST_DATABASE_URL`; each test signs up its own account.

use atlas_server::config::{parse_apps, BlobBackend, Config};
use atlas_server::{app, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config(apps: Vec<String>) -> Config {
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
        apps,
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

/// A router over the test database offering `apps` (what `ATLAS_APPS` would name).
fn instance(pool: &PgPool, apps: &[&str]) -> Router {
    app(AppState::new(
        pool.clone(),
        config(apps.iter().map(|a| a.to_string()).collect()),
    ))
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
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

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn wrapped_key() -> Value {
    json!({ "v": 1, "iv": random_hex::<12>(), "ct": random_hex::<48>() })
}

/// Sign a fresh account up; returns its access token and user id.
async fn signup(router: &Router) -> (String, Uuid) {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": format!("apps-{}@example.com", Uuid::now_v7()),
            "password": PASSWORD,
            "salt": random_hex::<16>(),
            "public_key": "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
            "recovery_public_key": "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
            "recovery_encrypted_dek": wrapped_key(),
            "recovery_encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let id = body["user"]["id"].as_str().unwrap().parse().unwrap();
    (body["access_token"].as_str().unwrap().to_string(), id)
}

fn task_op(entity_id: Uuid, field: &str, value: Value) -> Value {
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    json!({
        "id": Uuid::now_v7(),
        "entity": "task",
        "entity_id": entity_id,
        "op": "set",
        "field": field,
        "value": value,
        "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
    })
}

async fn push(router: &Router, token: &str, ops: Vec<Value>) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        "/sync/push",
        Some(token),
        json!({ "operations": ops }),
    )
    .await
}

async fn pulled(router: &Router, token: &str) -> Vec<Value> {
    let (status, body) = send(
        router,
        "GET",
        "/sync/pull?since=0",
        Some(token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body["operations"].as_array().unwrap().clone()
}

async fn snapshot(router: &Router, token: &str) -> Vec<Value> {
    let (status, body) = send(router, "GET", "/sync/snapshot", Some(token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body["operations"].as_array().unwrap().clone()
}

#[tokio::test]
async fn discovery_is_public_and_describes_the_server() {
    let pool = pool().await;
    let router = instance(&pool, &["todo"]);
    for path in ["/discovery", "/api/discovery"] {
        let (status, body) = send(&router, "GET", path, None, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body:?}");
        assert_eq!(body["service"], "atlas-server");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["protocol_version"], 7);
        assert_eq!(body["min_protocol_version"], 7);
        let capabilities: Vec<&str> = body["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap())
            .collect();
        for cap in ["api_tokens", "app_manifests", "account_apps", "root_key"] {
            assert!(capabilities.contains(&cap), "{cap} in {capabilities:?}");
        }
        assert_eq!(
            body["apps"],
            json!([{ "id": "todo", "name": "Atlas Todo", "version": 1 }])
        );
    }
    // No sync protocol header needed: discovery is how an old client learns it is old.
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/discovery")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let (_, body) = send(
        &instance(&pool, &[]),
        "GET",
        "/discovery",
        None,
        Value::Null,
    )
    .await;
    assert_eq!(
        body["apps"],
        json!([]),
        "only the instance's apps are listed"
    );
}

#[test]
fn instance_apps_are_checked_against_the_bundled_manifests() {
    assert_eq!(parse_apps(None).unwrap(), ["todo"]);
    assert_eq!(parse_apps(Some("todo")).unwrap(), ["todo"]);
    assert_eq!(
        parse_apps(Some(" Vault ,todo,vault")).unwrap(),
        ["vault", "todo"]
    );
    assert!(parse_apps(Some("todo,notes"))
        .unwrap_err()
        .contains("\"notes\""));
    assert!(parse_apps(Some(",")).is_err());
}

#[tokio::test]
async fn a_new_account_has_todo_and_can_list_and_enable_its_apps() {
    let pool = pool().await;
    let router = instance(&pool, &["todo"]);
    let (token, _) = signup(&router).await;

    let (status, body) = send(&router, "GET", "/auth/apps", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let apps = body["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["id"], "todo");
    assert_eq!(apps[0]["version"], 1);
    assert_eq!(apps[0]["enabled"], true);
    assert!(apps[0]["enabled_at"].is_i64());

    // Enabling is idempotent and answers the entry.
    let (status, body) = send(&router, "PUT", "/auth/apps/todo", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["id"], "todo");
    assert_eq!(body["enabled"], true);

    let (status, _) = send(
        &router,
        "PUT",
        "/auth/apps/notes",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an app this build lacks");

    let (status, _) = send(&router, "GET", "/auth/apps", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_app_the_instance_does_not_offer_cannot_be_enabled() {
    let pool = pool().await;
    let (token, _) = signup(&instance(&pool, &["todo"])).await;
    let closed = instance(&pool, &[]);
    let (status, body) = send(&closed, "PUT", "/auth/apps/todo", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "app_not_enabled");
    assert_eq!(body["scope"], "instance");
    let (_, body) = send(&closed, "GET", "/auth/apps", Some(&token), Value::Null).await;
    assert_eq!(body["apps"], json!([]));
}

#[tokio::test]
async fn an_api_token_session_cannot_list_or_enable_apps() {
    let pool = pool().await;
    let router = instance(&pool, &["todo"]);
    let (access, _) = signup(&router).await;
    let (token_id, auth) = (Uuid::new_v4(), random_hex::<32>());
    let (status, body) = send(
        &router,
        "POST",
        "/auth/api-tokens",
        Some(&access),
        json!({
            "id": token_id, "name": "n8n", "auth": auth,
            "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let (status, body) = send(
        &router,
        "POST",
        "/auth/api-token/session",
        None,
        json!({ "token_id": token_id, "auth": auth }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let pat = body["access_token"].as_str().unwrap();

    for (method, path) in [("GET", "/auth/apps"), ("PUT", "/auth/apps/todo")] {
        let (status, body) = send(&router, method, path, Some(pat), Value::Null).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(body["code"], "interactive_session_required");
    }
    // The token still syncs the account's apps, and discovery needs no session at all.
    let (status, body) = push(
        &router,
        pat,
        vec![task_op(Uuid::now_v7(), "title", json!("x"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}

#[tokio::test]
async fn sync_refuses_and_hides_an_app_the_account_has_not_enabled() {
    let pool = pool().await;
    let router = instance(&pool, &["todo"]);
    let (token, user) = signup(&router).await;
    let task = Uuid::now_v7();
    let (status, body) = push(&router, &token, vec![task_op(task, "title", json!("a"))]).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(pulled(&router, &token).await.len(), 1);

    sqlx::query("DELETE FROM account_apps WHERE user_id = $1 AND app = 'todo'")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) = push(&router, &token, vec![task_op(task, "title", json!("b"))]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "app_not_enabled");
    assert_eq!(body["app"], "todo");
    assert_eq!(body["scope"], "account");

    // Pull walks past the hidden ops (the cursor still moves) and serves none of them.
    let (status, body) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["operations"], json!([]));
    assert!(body["cursor"].as_i64().unwrap() > 0);
    assert!(snapshot(&router, &token).await.is_empty());

    let (_, body) = send(&router, "GET", "/auth/apps", Some(&token), Value::Null).await;
    assert_eq!(body["apps"][0]["enabled"], false);
    assert!(body["apps"][0].get("enabled_at").is_none());

    // Enabling it again brings the data back.
    let (status, _) = send(&router, "PUT", "/auth/apps/todo", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pulled(&router, &token).await.len(), 1);
    assert!(!snapshot(&router, &token).await.is_empty());
    let (status, body) = push(&router, &token, vec![task_op(task, "title", json!("c"))]).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}

#[tokio::test]
async fn sync_refuses_and_hides_an_app_the_instance_does_not_offer() {
    let pool = pool().await;
    let open = instance(&pool, &["todo"]);
    let (token, _) = signup(&open).await;
    let (status, _) = push(
        &open,
        &token,
        vec![task_op(Uuid::now_v7(), "title", json!("a"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The same database behind an instance whose ATLAS_APPS leaves todo out.
    let closed = instance(&pool, &[]);
    let (status, body) = push(
        &closed,
        &token,
        vec![task_op(Uuid::now_v7(), "title", json!("b"))],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "app_not_enabled");
    assert_eq!(body["scope"], "instance");
    assert!(pulled(&closed, &token).await.is_empty());
    assert!(snapshot(&closed, &token).await.is_empty());

    // An empty push names no app, so it is not refused.
    let (status, _) = push(&closed, &token, vec![]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn existing_and_directly_created_accounts_have_todo() {
    let pool = pool().await;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash) VALUES ($1, 'unused') RETURNING id",
    )
    .bind(format!("apps-direct-{}@example.com", Uuid::now_v7()))
    .fetch_one(&pool)
    .await
    .unwrap();
    let apps: Vec<String> = sqlx::query_scalar("SELECT app FROM account_apps WHERE user_id = $1")
        .bind(id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(apps, ["todo"]);
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM account_apps WHERE user_id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "deleting the account drops its apps");
}
