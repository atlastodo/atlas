//! Ending a session also closes its live sync sockets: an open WebSocket otherwise keeps streaming
//! to a device that was just signed out, disabled or deleted, until its access token expires.

use std::time::Duration;

use atlas_server::{admin, app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::Request;
use axum::Router;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;
use uuid::Uuid;

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
/// A second derived credential, for password changes.
const NEW_PASSWORD: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/// The close code the registry uses for a revoked session.
const SESSION_REVOKED: u16 = 4403;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> (AppState, Router, std::net::SocketAddr) {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let state = AppState::new(
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
            static_dir: None,
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = app(state.clone());
    tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    (state.clone(), app(state), addr)
}

async fn send(router: &Router, method: &str, uri: &str, token: Option<&str>, body: Value) -> Value {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let res = router
        .clone()
        .oneshot(
            b.body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert!(status.is_success(), "{method} {uri}: {status} {bytes:?}");
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

struct Session {
    email: String,
    user: Uuid,
    token: String,
}

async fn signup(router: &Router) -> Session {
    let email = format!("sock-{}@example.com", Uuid::now_v7());
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let body = send(
        router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": email, "password": PASSWORD,
            "salt": "00".repeat(16), "public_key": "11".repeat(32),
            "recovery_public_key": "22".repeat(32),
            "encrypted_dek": wrapped, "encrypted_private_key": wrapped,
            "recovery_encrypted_dek": wrapped, "recovery_encrypted_private_key": wrapped,
        }),
    )
    .await;
    Session {
        user: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        token: body["access_token"].as_str().unwrap().to_string(),
        email,
    }
}

async fn login(router: &Router, session: &Session) -> Session {
    let body = send(
        router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": session.email, "password": PASSWORD }),
    )
    .await;
    Session {
        email: session.email.clone(),
        user: session.user,
        token: body["access_token"].as_str().unwrap().to_string(),
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A single-use ticket for a socket of `token`'s session.
async fn ws_ticket(router: &Router, token: &str) -> String {
    let res = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/sync/ws-ticket")
                .header("x-atlas-sync-protocol", "6")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(res.status().is_success(), "ws-ticket: {}", res.status());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    body["ticket"].as_str().unwrap().to_string()
}

/// An open socket, past its connect-time backfill.
async fn open_socket(addr: std::net::SocketAddr, router: &Router, token: &str) -> Ws {
    let ticket = ws_ticket(router, token).await;
    let url = format!("ws://{addr}/sync/ws?ticket={ticket}&since=0&protocol=6");
    let mut ws = tokio_tungstenite::connect_async(url).await.expect("ws").0;
    assert!(next_text(&mut ws, 5).await, "backfill");
    ws
}

async fn next_text(ws: &mut Ws, secs: u64) -> bool {
    tokio::time::timeout(Duration::from_secs(secs), async {
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                WsMessage::Text(_) => return true,
                WsMessage::Close(_) => return false,
                _ => {}
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

async fn close_code(ws: &mut Ws) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(msg) = ws.next().await {
            match msg {
                Ok(WsMessage::Close(frame)) => return frame.map(|f| u16::from(f.code)),
                Ok(_) => {}
                Err(_) => return None,
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Still streaming: a published payload arrives.
async fn still_open(state: &AppState, user: Uuid, ws: &mut Ws) -> bool {
    state.hub.publish(
        user,
        json!({ "operations": [], "cursor": 0, "from": 0 }).to_string(),
    );
    next_text(ws, 5).await
}

#[tokio::test]
async fn signing_other_devices_out_closes_their_sockets_but_not_the_callers() {
    let (state, router, addr) = setup().await;
    let caller = signup(&router).await;
    let other = login(&router, &caller).await;
    let mut caller_ws = open_socket(addr, &router, &caller.token).await;
    let mut other_ws = open_socket(addr, &router, &other.token).await;

    send(
        &router,
        "POST",
        "/auth/sessions/revoke-others",
        Some(&caller.token),
        Value::Null,
    )
    .await;
    assert_eq!(close_code(&mut other_ws).await, Some(SESSION_REVOKED));
    assert!(still_open(&state, caller.user, &mut caller_ws).await);
}

#[tokio::test]
async fn revoking_one_session_or_changing_the_password_closes_the_other_sockets() {
    let (state, router, addr) = setup().await;
    let caller = signup(&router).await;
    let revoked = login(&router, &caller).await;
    let mut revoked_ws = open_socket(addr, &router, &revoked.token).await;
    let sessions = send(
        &router,
        "GET",
        "/auth/sessions",
        Some(&caller.token),
        Value::Null,
    )
    .await;
    let device = sessions
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["current"] == false)
        .unwrap()["device_id"]
        .as_str()
        .unwrap()
        .to_string();
    send(
        &router,
        "DELETE",
        &format!("/auth/sessions/{device}"),
        Some(&caller.token),
        Value::Null,
    )
    .await;
    assert_eq!(close_code(&mut revoked_ws).await, Some(SESSION_REVOKED));

    let other = login(&router, &caller).await;
    let mut caller_ws = open_socket(addr, &router, &caller.token).await;
    let mut other_ws = open_socket(addr, &router, &other.token).await;
    send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&caller.token),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": { "iv": "A".repeat(16), "ct": "B".repeat(64) },
            "encrypted_private_key": { "iv": "A".repeat(16), "ct": "B".repeat(64) },
        }),
    )
    .await;
    assert_eq!(close_code(&mut other_ws).await, Some(SESSION_REVOKED));
    assert!(still_open(&state, caller.user, &mut caller_ws).await);
}

#[tokio::test]
async fn deleting_the_account_closes_its_sockets() {
    let (_, router, addr) = setup().await;
    let user = signup(&router).await;
    let mut ws = open_socket(addr, &router, &user.token).await;
    send(
        &router,
        "DELETE",
        "/auth/account",
        Some(&user.token),
        json!({ "password": PASSWORD }),
    )
    .await;
    assert_eq!(close_code(&mut ws).await, Some(SESSION_REVOKED));
}

/// The admin tests' cross-process lock: they rewrite `is_admin` table-wide.
async fn admin_lock(pool: &PgPool) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(818)")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

#[tokio::test]
async fn an_admin_disable_or_force_logout_closes_the_users_sockets() {
    let (state, router, addr) = setup().await;
    let _guard = admin_lock(&state.pool).await;
    let admin_session = signup(&router).await;
    admin::set_admin_by_email(&state.pool, &admin_session.email, true, "test")
        .await
        .unwrap();

    for body in [json!({ "disabled": true }), Value::Null] {
        let user = signup(&router).await;
        let mut ws = open_socket(addr, &router, &user.token).await;
        let (method, uri) = if body.is_null() {
            ("POST", format!("/admin/users/{}/logout", user.user))
        } else {
            ("PATCH", format!("/admin/users/{}", user.user))
        };
        send(&router, method, &uri, Some(&admin_session.token), body).await;
        assert_eq!(
            close_code(&mut ws).await,
            Some(SESSION_REVOKED),
            "{method} {uri}"
        );
    }
}
