//! Integration test for the realtime WebSocket sync channel (`/sync/ws`).
//!
//! Spins up a real server on an ephemeral port (WS needs a live socket), connects a client, then
//! pushes an op through a router that shares the same `AppState` (hence the same broadcast hub) and
//! asserts the op is delivered live. Also checks backfill-on-connect for a stale cursor, and that a
//! socket opens only with a fresh single-use ticket, never with the access token in its URL.

use std::time::Duration;

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;
use uuid::Uuid;

mod common;
use common::wire::{self, tag, value_of, SEALED};

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
        .header("x-atlas-sync-protocol", "7");
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

async fn signup(router: &Router) -> String {
    signup_with_id(router).await.0
}

async fn signup_with_id(router: &Router) -> (String, Uuid) {
    let (status, body) = http(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": format!("ws-{}@example.com", Uuid::now_v7()), "password": PASSWORD
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (
        body["access_token"].as_str().unwrap().to_string(),
        body["user"]["id"].as_str().unwrap().parse().unwrap(),
    )
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

/// A single-use ticket for a socket of `token`'s session (`POST /sync/ws-ticket`).
async fn ticket(router: &Router, token: &str) -> String {
    let (status, body) = http(router, "POST", "/sync/ws-ticket", Some(token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body["ticket"].as_str().unwrap().to_string()
}

fn ws_url(addr: std::net::SocketAddr, ticket: &str, since: i64) -> String {
    format!("ws://{addr}/sync/ws?ticket={ticket}&since={since}&protocol=7")
}

async fn connect(addr: std::net::SocketAddr, router: &Router, token: &str, since: i64) -> Ws {
    let ticket = ticket(router, token).await;
    tokio_tungstenite::connect_async(ws_url(addr, &ticket, since))
        .await
        .expect("ws connect")
        .0
}

/// The next pull-shaped text payload, skipping control frames; `None` on close or timeout.
async fn next_payload(ws: &mut Ws, secs: u64) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(secs), async {
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                WsMessage::Text(text) => return serde_json::from_str(&text).ok(),
                WsMessage::Close(_) => return None,
                _ => {}
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

fn set_op(entity_id: Uuid, field: &str, value: Value, wall: u64) -> Value {
    wire::set(
        SEALED,
        entity_id,
        None,
        field,
        value,
        (wall, 0, Uuid::now_v7()),
    )
}

/// Read WS text messages until one whose pull-payload contains a matching field/value, or time out.
async fn wait_for_field(
    ws: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
    field: &str,
    value: &str,
) -> bool {
    let deadline = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(msg)) = ws.next().await {
            if let WsMessage::Text(text) = msg {
                let payload: Value = serde_json::from_str(&text).unwrap();
                for op in payload["operations"].as_array().unwrap_or(&vec![]) {
                    if op["field"] == tag(field) && value_of(op) == value {
                        return true;
                    }
                }
            }
        }
        false
    });
    deadline.await.unwrap_or(false)
}

#[tokio::test]
async fn ws_delivers_pushed_op_live_to_another_device() {
    let state = make_state().await;

    // Real server for the WS connection.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = app(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });

    // Sign up + push over an in-process router sharing the same AppState (same hub).
    let control = app(state.clone());
    let token = signup(&control).await;

    // Connect the WS "device B".
    let mut ws = connect(addr, &control, &token, 0).await;

    // Drain the initial (empty) backfill message.
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.next()).await;

    // "Device A" pushes an op; the hub should fan it out to the WS.
    let tid = Uuid::now_v7();
    let (status, _) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("live-update"), 1000)]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert!(
        wait_for_field(&mut ws, "title", "live-update").await,
        "expected the pushed op to arrive over the WebSocket"
    );
}

#[tokio::test]
async fn ws_refuses_a_missing_or_unknown_ticket_and_the_access_token() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let token = signup(&control).await;

    let base = format!("ws://{addr}/sync/ws");
    for (url, what) in [
        (format!("{base}?since=0&protocol=7"), "no ticket"),
        (
            format!("{base}?ticket={}&since=0&protocol=7", "0".repeat(64)),
            "an unknown ticket",
        ),
        // The access token is no longer accepted in the URL, under either name.
        (
            format!("{base}?token={token}&since=0&protocol=7"),
            "the access token as `token`",
        ),
        (
            format!("{base}?ticket={token}&since=0&protocol=7"),
            "the access token as `ticket`",
        ),
    ] {
        assert_eq!(url_handshake_status(url).await, Some(401), "{what}");
    }
}

#[tokio::test]
async fn a_ticket_opens_one_socket() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let token = signup(&control).await;

    let ticket = ticket(&control, &token).await;
    assert_eq!(ticket.len(), 64, "256 random bits, hex");
    let mut ws = tokio_tungstenite::connect_async(ws_url(addr, &ticket, 0))
        .await
        .expect("a fresh ticket opens a socket")
        .0;
    next_payload(&mut ws, 5).await.expect("backfill");
    assert_eq!(
        url_handshake_status(ws_url(addr, &ticket, 0)).await,
        Some(401),
        "a used ticket opens nothing"
    );
}

#[tokio::test]
async fn a_ticket_takes_a_live_session() {
    let state = make_state().await;
    let control = app(state.clone());
    let (status, _) = http(&control, "POST", "/sync/ws-ticket", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no bearer token");
    let (status, _) = http(
        &control,
        "POST",
        "/sync/ws-ticket",
        Some("not-a-jwt"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a bad bearer token");

    let token = signup(&control).await;
    let (status, body) = http(
        &control,
        "POST",
        "/sync/ws-ticket",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["expires_in"], 30, "{body:?}");
}

#[tokio::test]
async fn ws_backfills_ops_since_cursor_on_connect() {
    let state = make_state().await;
    let control = app(state.clone());
    let token = signup(&control).await;

    // Commit an op BEFORE connecting.
    let tid = Uuid::now_v7();
    http(
        &control,
        "POST",
        "/sync/push",
        Some(&token),
        json!({
            "operations": [set_op(tid, "title", json!("earlier"), 500)]
        }),
    )
    .await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = app(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });

    // Connect with since=0 → the backfill should contain the earlier op.
    let mut ws = connect(addr, &control, &token, 0).await;
    assert!(
        wait_for_field(&mut ws, "title", "earlier").await,
        "expected backfill to include the op committed before connecting"
    );
}

#[tokio::test]
async fn live_payload_names_the_cursor_it_follows() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let token = signup(&control).await;

    let push = |wall: u64| {
        let control = control.clone();
        let token = token.clone();
        async move {
            let (status, body) = http(
                &control,
                "POST",
                "/sync/push",
                Some(&token),
                json!({ "operations": [set_op(Uuid::now_v7(), "title", json!("x"), wall)] }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body:?}");
            body["cursor"].as_i64().unwrap()
        }
    };
    let before = push(1000).await;
    let mut ws = connect(addr, &control, &token, before).await;
    let backfill = next_payload(&mut ws, 5).await.expect("backfill");
    assert_eq!(
        backfill["from"], before,
        "a backfill page starts at the requested cursor"
    );
    assert_eq!(backfill["cursor"], before);

    let after = push(2000).await;
    let live = next_payload(&mut ws, 5).await.expect("live payload");
    assert_eq!(
        live["from"], before,
        "the live payload covers exactly the seqs after `from`"
    );
    assert_eq!(live["cursor"], after);
}

#[tokio::test]
async fn ws_backfill_drains_more_than_one_page() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let token = signup(&control).await;

    let ops: Vec<Value> = (0..1200)
        .map(|i| set_op(Uuid::now_v7(), "title", json!(i), 1000 + i))
        .collect();
    let (status, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": ops }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let head = body["cursor"].as_i64().unwrap();

    let mut ws = connect(addr, &control, &token, 0).await;
    let mut seen = std::collections::HashSet::new();
    let mut cursor = 0;
    while cursor < head {
        let page = next_payload(&mut ws, 5)
            .await
            .unwrap_or_else(|| panic!("backfill stalled at {cursor} of {head}"));
        assert_eq!(page["from"], cursor, "backfill pages are contiguous");
        for op in page["operations"].as_array().unwrap() {
            seen.insert(op["id"].as_str().unwrap().to_string());
        }
        cursor = page["cursor"].as_i64().unwrap();
    }
    assert_eq!(seen.len(), 1200, "the backfill delivers every op");
}

#[tokio::test]
async fn a_lagging_socket_is_closed() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let (token, user) = signup_with_id(&control).await;

    let mut ws = connect(addr, &control, &token, 0).await;
    next_payload(&mut ws, 5).await.expect("backfill");

    // Overflow the channel before the socket task gets to run (the test runtime is single-threaded).
    for _ in 0..1000 {
        state.hub.publish(
            user,
            atlas_server::sync::PullResponse {
                operations: Vec::new(),
                cursor: 0,
                from: 0,
            },
        );
    }
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return true,
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(
        closed,
        "a lagged socket must close so the client reconnects and backfills"
    );
}

#[tokio::test]
async fn ws_cursor_below_the_purge_watermark_is_410() {
    use tokio_tungstenite::tungstenite::Error as WsError;

    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let (token, user) = signup_with_id(&control).await;
    let (_, body) = http(
        &control,
        "POST",
        "/sync/push",
        Some(&token),
        json!({ "operations": [set_op(Uuid::now_v7(), "title", json!("a"), 1000)] }),
    )
    .await;
    let first = body["cursor"].as_i64().unwrap();
    sqlx::query("INSERT INTO sync_purge_watermarks (user_id, purged_seq) VALUES ($1, $2)")
        .bind(user)
        .bind(first + 1)
        .execute(&state.pool)
        .await
        .unwrap();

    let url = ws_url(addr, &ticket(&control, &token).await, first);
    match tokio_tungstenite::connect_async(url).await {
        Err(WsError::Http(res)) => {
            assert_eq!(res.status().as_u16(), 410);
            let body: Value = serde_json::from_slice(res.body().as_deref().unwrap()).unwrap();
            assert_eq!(body["code"], "cursor_expired");
        }
        other => panic!("expected a 410 handshake rejection, got {other:?}"),
    }
    // A fresh device (since=0) bootstraps from the snapshot, so it is not refused.
    connect(addr, &control, &token, 0).await;
}

/// The socket's close code, waiting up to `secs`; `None` if it stays open (or ends without one).
async fn close_code(ws: &mut Ws, secs: u64) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(secs), async {
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

/// A second live session (refresh-token row) for `user`, and an access token for it.
async fn second_device(state: &AppState, user: Uuid, ttl_seconds: i64) -> (Uuid, String) {
    let device = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(user)
    .bind(device)
    .bind(format!("ws-test-{device}"))
    .execute(&state.pool)
    .await
    .unwrap();
    let token = atlas_server::auth::token::issue_access_token(
        user,
        device,
        ttl_seconds,
        &state.config.jwt_secret,
        time::OffsetDateTime::now_utc().unix_timestamp(),
    )
    .unwrap();
    (device, token)
}

/// The status a refused handshake answered with; `None` when the socket opened.
async fn url_handshake_status(url: String) -> Option<u16> {
    use tokio_tungstenite::tungstenite::Error as WsError;
    match tokio_tungstenite::connect_async(url).await {
        Err(WsError::Http(res)) => Some(res.status().as_u16()),
        Err(e) => panic!("unexpected handshake error {e:?}"),
        Ok(_) => None,
    }
}

#[tokio::test]
async fn ws_refuses_disabled_and_deletion_scheduled_accounts() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());

    // The handshake checks the account again: a ticket issued before the account was disabled or
    // scheduled for deletion opens nothing after, and no new ticket is issued.
    for (column, what) in [
        ("disabled_at", "disabled"),
        ("deletion_scheduled_at", "scheduled for deletion"),
    ] {
        let (token, user) = signup_with_id(&control).await;
        let earlier = ticket(&control, &token).await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE users SET {column} = now() WHERE id = $1"
        )))
        .bind(user)
        .execute(&state.pool)
        .await
        .unwrap();
        assert_eq!(
            url_handshake_status(ws_url(addr, &earlier, 0)).await,
            Some(403),
            "{what}"
        );
        let (status, _) = http(
            &control,
            "POST",
            "/sync/ws-ticket",
            Some(&token),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{what}: no new ticket");
    }
}

#[tokio::test]
async fn ws_closes_when_the_access_token_expires() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let (_, user) = signup_with_id(&control).await;
    let (_, token) = second_device(&state, user, 2).await;

    let mut ws = connect(addr, &control, &token, 0).await;
    assert_eq!(
        close_code(&mut ws, 6).await,
        Some(4401),
        "the socket closes once the token that asked for its ticket expires"
    );
}

#[tokio::test]
async fn sockets_close_on_request_per_device_or_per_user() {
    let state = make_state().await;
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let (_, user) = signup_with_id(&control).await;
    let (phone, phone_token) = second_device(&state, user, 900).await;
    let (_, laptop_token) = second_device(&state, user, 900).await;

    let mut phone_ws = connect(addr, &control, &phone_token, 0).await;
    let mut laptop_ws = connect(addr, &control, &laptop_token, 0).await;
    next_payload(&mut phone_ws, 5).await.expect("backfill");
    next_payload(&mut laptop_ws, 5).await.expect("backfill");

    assert_eq!(state.hub.close_device_sockets(user, phone), 1);
    assert_eq!(close_code(&mut phone_ws, 5).await, Some(4403));
    // The other device keeps streaming.
    state.hub.publish(
        user,
        atlas_server::sync::PullResponse {
            operations: Vec::new(),
            cursor: 0,
            from: 0,
        },
    );
    assert!(next_payload(&mut laptop_ws, 5).await.is_some());

    // A revoked session cannot simply reconnect with its still-unexpired access token.
    sqlx::query("UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = $1")
        .bind(phone)
        .execute(&state.pool)
        .await
        .unwrap();
    let (status, _) = http(
        &control,
        "POST",
        "/sync/ws-ticket",
        Some(&phone_token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    assert_eq!(state.hub.close_user_sockets(user), 1);
    assert_eq!(close_code(&mut laptop_ws, 5).await, Some(4403));
}

#[tokio::test]
async fn the_server_pings_an_idle_socket() {
    let base = make_state().await;
    let state = AppState {
        hub: std::sync::Arc::new(atlas_server::sync::SyncHub::with_ping_interval(
            Duration::from_millis(200),
        )),
        ..base
    };
    let addr = spawn_server(&state).await;
    let control = app(state.clone());
    let token = signup(&control).await;
    let mut ws = connect(addr, &control, &token, 0).await;

    let pinged = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(msg)) = ws.next().await {
            if let WsMessage::Ping(_) = msg {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(
        pinged,
        "an idle socket is pinged, keeping proxies from timing it out"
    );
}
