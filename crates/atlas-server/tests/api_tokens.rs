//! Integration tests for personal API tokens (`/auth/api-tokens`, `/auth/api-token/session`).
//! Runs against the Postgres in `TEST_DATABASE_URL`; each test signs up its own account.

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> Router {
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
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    app(AppState::new(pool, config))
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
    let request = builder
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
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

/// Sign a fresh account up; returns its access token.
async fn signup(router: &Router) -> String {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": format!("pat-{}@example.com", Uuid::now_v7()),
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
    body["access_token"].as_str().unwrap().to_string()
}

struct Token {
    id: Uuid,
    auth: String,
    wrapped_dek: Value,
}

async fn create_token(router: &Router, access: &str, name: &str) -> Token {
    let token = Token {
        id: Uuid::new_v4(),
        auth: random_hex::<32>(),
        wrapped_dek: wrapped_key(),
    };
    let (status, body) = send(
        router,
        "POST",
        "/auth/api-tokens",
        Some(access),
        json!({
            "id": token.id, "name": name, "auth": token.auth,
            "wrapped_dek": token.wrapped_dek, "wrapped_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    assert_eq!(body["name"], name);
    token
}

async fn open_session(router: &Router, token: &Token) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        "/auth/api-token/session",
        None,
        json!({ "token_id": token.id, "auth": token.auth }),
    )
    .await
}

async fn token_access(router: &Router, token: &Token) -> String {
    let (status, body) = open_session(router, token).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body["access_token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_token_opens_a_session_that_carries_its_wrapped_keys_and_reaches_sync() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;

    let (status, body) = open_session(&router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["token_id"], json!(token.id));
    assert_eq!(body["wrapped_dek"], token.wrapped_dek);
    assert!(
        body.get("refresh_token").is_none(),
        "a token session has no refresh token"
    );
    let pat = body["access_token"].as_str().unwrap();

    let (status, _) = send(&router, "GET", "/sync/pull?since=0", Some(pat), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&router, "GET", "/auth/me", Some(pat), Value::Null).await;
    assert_eq!(status, StatusCode::OK);

    let (status, list) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], json!(token.id));
    assert!(
        list[0]["last_used_at"].is_i64(),
        "the exchange stamps last use"
    );
    assert!(list[0].get("auth").is_none() && list[0].get("wrapped_dek").is_none());
}

#[tokio::test]
async fn a_wrong_or_unknown_token_is_unauthorized() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;

    let wrong = Token {
        id: token.id,
        auth: random_hex::<32>(),
        wrapped_dek: Value::Null,
    };
    assert_eq!(
        open_session(&router, &wrong).await.0,
        StatusCode::UNAUTHORIZED
    );
    let unknown = Token {
        id: Uuid::new_v4(),
        auth: token.auth.clone(),
        wrapped_dek: Value::Null,
    };
    assert_eq!(
        open_session(&router, &unknown).await.0,
        StatusCode::UNAUTHORIZED
    );
    let malformed = Token {
        id: token.id,
        auth: "nope".into(),
        wrapped_dek: Value::Null,
    };
    assert_eq!(
        open_session(&router, &malformed).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn revoking_a_token_ends_its_live_session_and_drops_its_keys() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;
    let pat = token_access(&router, &token).await;

    let uri = format!("/auth/api-tokens/{}", token.id);
    let (status, _) = send(&router, "DELETE", &uri, Some(&access), Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&router, "DELETE", &uri, Some(&access), Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "already revoked");

    let (status, _) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&pat),
        Value::Null,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the access token dies with the token"
    );
    assert_eq!(
        open_session(&router, &token).await.0,
        StatusCode::UNAUTHORIZED
    );

    let pool = db::connect(&test_database_url()).await.unwrap();
    let wrapped: Option<Value> =
        sqlx::query_scalar("SELECT wrapped_dek FROM api_tokens WHERE id = $1")
            .bind(token.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(wrapped, None, "revoking drops the wrapped keys");

    let (_, list) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&access),
        Value::Null,
    )
    .await;
    assert!(list.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_token_session_is_refused_on_account_critical_routes() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;
    let pat = token_access(&router, &token).await;

    let guarded = [
        ("GET", "/auth/api-tokens".to_string(), Value::Null),
        (
            "POST",
            "/auth/api-tokens".into(),
            json!({ "id": Uuid::new_v4(), "name": "x", "auth": random_hex::<32>(),
                    "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key() }),
        ),
        (
            "DELETE",
            format!("/auth/api-tokens/{}", token.id),
            Value::Null,
        ),
        ("GET", "/auth/sessions".into(), Value::Null),
        ("POST", "/auth/sessions/revoke-others".into(), Value::Null),
        ("GET", "/auth/export".into(), Value::Null),
        (
            "DELETE",
            "/auth/account".into(),
            json!({ "password": PASSWORD }),
        ),
        (
            "POST",
            "/auth/change-password".into(),
            json!({ "current_password": PASSWORD, "new_password": PASSWORD }),
        ),
        ("GET", "/admin/users".into(), Value::Null),
    ];
    for (method, uri, body) in guarded {
        let (status, response) = send(&router, method, &uri, Some(&pat), body).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{method} {uri}: {response:?}"
        );
        assert_eq!(
            response["code"], "interactive_session_required",
            "{method} {uri}"
        );
    }
    // The token survived all of that.
    let (status, _) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&pat),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_account_holds_at_most_25_live_tokens_and_ids_are_unique() {
    let router = setup().await;
    let access = signup(&router).await;
    let mut first = None;
    for i in 0..25 {
        let token = create_token(&router, &access, &format!("t{i}")).await;
        first.get_or_insert(token.id);
    }
    let body = json!({
        "id": Uuid::new_v4(), "name": "one too many", "auth": random_hex::<32>(),
        "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key(),
    });
    let (status, _) = send(&router, "POST", "/auth/api-tokens", Some(&access), body).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let uri = format!("/auth/api-tokens/{}", first.unwrap());
    send(&router, "DELETE", &uri, Some(&access), Value::Null).await;
    let reused = json!({
        "id": first.unwrap(), "name": "reused id", "auth": random_hex::<32>(),
        "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key(),
    });
    let (status, _) = send(&router, "POST", "/auth/api-tokens", Some(&access), reused).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a revoked token's id is not reused"
    );
}

#[tokio::test]
async fn create_validates_its_input() {
    let router = setup().await;
    let access = signup(&router).await;
    let bad = [
        json!({ "id": Uuid::new_v4(), "name": " ", "auth": random_hex::<32>(),
                "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key() }),
        json!({ "id": Uuid::new_v4(), "name": "x", "auth": "ABCD",
                "wrapped_dek": wrapped_key(), "wrapped_private_key": wrapped_key() }),
        json!({ "id": Uuid::new_v4(), "name": "x", "auth": random_hex::<32>(),
                "wrapped_dek": "not an object", "wrapped_private_key": wrapped_key() }),
    ];
    for body in bad {
        let (status, _) = send(
            &router,
            "POST",
            "/auth/api-tokens",
            Some(&access),
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
}

#[tokio::test]
async fn scheduling_the_account_deletion_revokes_its_tokens() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;

    let (status, _) = send(
        &router,
        "DELETE",
        "/auth/account",
        Some(&access),
        json!({ "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        open_session(&router, &token).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_token_is_stored_only_as_a_hash_of_its_auth_value() {
    let router = setup().await;
    let access = signup(&router).await;
    let token = create_token(&router, &access, "n8n").await;
    let pool = db::connect(&test_database_url()).await.unwrap();
    let stored: String = sqlx::query_scalar("SELECT auth_hash FROM api_tokens WHERE id = $1")
        .bind(token.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, hex::encode(Sha256::digest(token.auth.as_bytes())));
}
