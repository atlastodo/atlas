//! Integration tests for the account's Ed25519 identity signing key (`auth::identity`).
//!
//! The server stores the public half and the private half wrapped under the account's DEK. It is
//! set once: at signup, or by `PUT /auth/signing-key` for an account created before these keys
//! existed. Afterwards the server refuses to replace it.

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> Router {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    app(AppState::new(
        pool,
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
        },
    ))
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
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn wrapped(tag: &str) -> Value {
    json!({ "iv": "A".repeat(16), "ct": tag })
}

/// A signup body with the E2EE key material every account carries, plus `extra` fields.
fn signup_body(email: &str, extra: Value) -> Value {
    let mut body = json!({
        "email": email,
        "password": PASSWORD,
        "salt": "00".repeat(16),
        "public_key": "11".repeat(32),
        "recovery_public_key": "22".repeat(32),
        "encrypted_dek": wrapped("dek"),
        "encrypted_private_key": wrapped("priv"),
        "recovery_encrypted_dek": wrapped("rdek"),
        "recovery_encrypted_private_key": wrapped("rpriv"),
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    body
}

fn unique_email() -> String {
    format!("id-{}@example.com", Uuid::now_v7())
}

async fn signup(router: &Router, email: &str, extra: Value) -> Value {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        signup_body(email, extra),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body}");
    body
}

async fn signing_key(router: &Router, token: &str) -> Value {
    let (status, body) = send(router, "GET", "/auth/signing-key", Some(token), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn put_signing_key(
    router: &Router,
    token: &str,
    public: &str,
    wrap: Value,
) -> (StatusCode, Value) {
    send(
        router,
        "PUT",
        "/auth/signing-key",
        Some(token),
        json!({ "signing_public_key": public, "encrypted_signing_key": wrap }),
    )
    .await
}

#[tokio::test]
async fn a_signup_signing_key_is_returned_at_login_and_published() {
    let router = setup().await;
    let email = unique_email();
    let created = signup(
        &router,
        &email,
        json!({ "signing_public_key": "AB".repeat(32), "encrypted_signing_key": wrapped("sig") }),
    )
    .await;
    // Stored lowercase, like every hex key the server compares.
    assert_eq!(created["signing_public_key"], "ab".repeat(32));
    assert_eq!(created["encrypted_signing_key"], wrapped("sig"));

    let (status, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(login["signing_public_key"], "ab".repeat(32));
    assert_eq!(login["encrypted_signing_key"], wrapped("sig"));

    let token = login["access_token"].as_str().unwrap();
    assert_eq!(
        signing_key(&router, token).await,
        json!({ "signing_public_key": "ab".repeat(32), "encrypted_signing_key": wrapped("sig") })
    );

    // Anyone signed in finds it next to the X25519 key.
    let other = signup(&router, &unique_email(), json!({})).await;
    let (status, found) = send(
        &router,
        "GET",
        &format!("/users/public-key?email={email}"),
        other["access_token"].as_str(),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found["public_key"], "11".repeat(32));
    assert_eq!(found["signing_public_key"], "ab".repeat(32));
}

#[tokio::test]
async fn signup_takes_both_signing_fields_or_neither() {
    let router = setup().await;
    for extra in [
        json!({ "signing_public_key": "ab".repeat(32) }),
        json!({ "encrypted_signing_key": wrapped("sig") }),
        json!({ "signing_public_key": "zz".repeat(32), "encrypted_signing_key": wrapped("sig") }),
        json!({ "signing_public_key": "ab".repeat(32), "encrypted_signing_key": "flat" }),
    ] {
        let (status, body) = send(
            &router,
            "POST",
            "/auth/signup",
            None,
            signup_body(&unique_email(), extra.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}: {body}");
    }
}

#[tokio::test]
async fn an_account_without_a_signing_key_uploads_one_once() {
    let router = setup().await;
    let email = unique_email();
    let created = signup(&router, &email, json!({})).await;
    let token = created["access_token"].as_str().unwrap();
    assert!(created.get("signing_public_key").is_none(), "{created}");
    assert_eq!(
        signing_key(&router, token).await,
        json!({ "signing_public_key": null, "encrypted_signing_key": null })
    );

    // Malformed keys are refused before anything is stored.
    for (public, wrap) in [
        ("ab".repeat(31), wrapped("sig")),
        ("ab".repeat(32), json!({ "iv": "A" })),
        ("ab".repeat(32), json!({ "iv": "A", "ct": "B".repeat(600) })),
    ] {
        let (status, body) = put_signing_key(&router, token, &public, wrap).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }

    let (status, _) = put_signing_key(&router, token, &"cd".repeat(32), wrapped("first")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    // The same key again is a no-op that keeps the first wrap.
    let (status, _) = put_signing_key(&router, token, &"CD".repeat(32), wrapped("second")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        signing_key(&router, token).await,
        json!({ "signing_public_key": "cd".repeat(32), "encrypted_signing_key": wrapped("first") })
    );

    // Any other key is refused: the server cannot be asked to swap an identity.
    let (status, body) = put_signing_key(&router, token, &"ef".repeat(32), wrapped("other")).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "signing_key_already_set");
    assert_eq!(
        signing_key(&router, token).await["signing_public_key"],
        "cd".repeat(32)
    );

    let (status, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(login["signing_public_key"], "cd".repeat(32));
    assert_eq!(login["encrypted_signing_key"], wrapped("first"));
}

#[tokio::test]
async fn the_signing_key_routes_need_a_session() {
    let router = setup().await;
    let (status, _) = send(&router, "GET", "/auth/signing-key", None, json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/signing-key",
        None,
        json!({ "signing_public_key": "ab".repeat(32), "encrypted_signing_key": wrapped("x") }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
