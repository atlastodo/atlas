//! Integration tests for `GET /health`.
//!
//! The JSON shape (`status`/`service`, `status: "ok"` when healthy) is read by healthchecks and
//! uptime monitors, and a database failure must answer `503` with `status: "error"`.

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config(database_url: &str) -> Config {
    Config {
        database_url: database_url.to_string(),
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

async fn send(router: &Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
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

#[tokio::test]
async fn health_verifies_the_database_and_stays_backward_compatible() {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let router = app(AppState::new(pool, config(&test_database_url())));

    let (status, body) = send(&router, "/health").await;
    assert_eq!(status, StatusCode::OK);
    // The pre-existing fields keep their meaning; `database` is the new, additive signal.
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "atlas-server");
    assert_eq!(body["database"], "ok");

    // The /api-prefixed mount answers identically (same handler, same shape).
    let (status, body) = send(&router, "/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["database"], "ok");
}

#[tokio::test]
async fn health_answers_503_with_status_error_when_the_database_is_unreachable() {
    // A lazy pool pointed at a refused port: the SELECT 1 fails fast, exercising the failure arm
    // without a real outage.
    let dead_url = "postgres://atlas:atlas@127.0.0.1:59999/atlas_test";
    let pool = PgPoolOptions::new().connect_lazy(dead_url).unwrap();
    let router = app(AppState::new(pool, config(dead_url)));

    let (status, body) = send(&router, "/health").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "error");
    assert_eq!(
        body["service"], "atlas-server",
        "the envelope survives the failure"
    );
    assert_eq!(body["database"], "unreachable");
}
