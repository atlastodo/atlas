//! Integration tests for Atlas Vault on the server: its owner-only kinds, and the API token
//! policy its manifest asks for (an expiry of at most a year, read-only unless writes are opted
//! in), enforced when a token is made, at the exchange and on every request. Runs against the
//! Postgres in `TEST_DATABASE_URL`; each test signs up its own accounts.

use atlas_server::config::{BlobBackend, Config};
use atlas_server::{app, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
        passkeys: None,
        android_asset_links: None,
    }
}

/// An instance over the test database offering todo and vault.
async fn suite() -> (AppState, Router) {
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    let state = AppState::new(pool, config(&["todo", "vault"]));
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
}

/// Sign up a current client's account (root key, todo key) and enable vault the way a client
/// does: its key under the root, then the app.
async fn vault_user(router: &Router) -> User {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        None,
        json!({
            "email": format!("vault-{}@example.com", Uuid::now_v7()),
            "password": PASSWORD,
            "salt": hex::encode(random_bytes::<16>()),
            "public_key": hex::encode(random_bytes::<32>()),
            "recovery_public_key": hex::encode(random_bytes::<32>()),
            "encrypted_dek": wrap(),
            "encrypted_private_key": wrap(),
            "recovery_encrypted_dek": wrap(),
            "recovery_encrypted_private_key": wrap(),
            "user_id": Uuid::new_v4(),
            "encrypted_root_key": wrap(),
            "recovery_encrypted_root_key": wrap(),
            "app_keys": [{ "app": "todo", "wrapped_key": wrap(), "wrapped_private_key": wrap() }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let user = User {
        token: body["access_token"].as_str().unwrap().to_string(),
    };
    let (status, body) = send(
        router,
        "PUT",
        "/auth/app-keys/vault",
        Some(&user.token),
        None,
        json!({ "wrapped_key": wrap(), "wrapped_private_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let (status, body) = send(
        router,
        "PUT",
        "/auth/apps/vault",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    user
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
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

fn vault_keys() -> Value {
    json!({ "vault": { "wrapped_key": wrap(), "wrapped_private_key": wrap() } })
}

/// `POST /auth/api-tokens` for a vault token, plus `extra` fields.
async fn create_vault_token(
    router: &Router,
    user: &User,
    token: &ApiToken,
    extra: Value,
) -> (StatusCode, Value) {
    let mut body = json!({
        "id": token.id, "name": "ci", "auth": token.auth,
        "apps": ["vault"], "app_keys": vault_keys(),
    });
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

async fn exchange(router: &Router, token: &ApiToken) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        "/auth/api-token/session",
        None,
        None,
        json!({ "token_id": token.id, "auth": token.auth }),
    )
    .await
}

async fn open(router: &Router, token: &ApiToken) -> Value {
    let (status, body) = exchange(router, token).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body
}

/// A vault token made and opened: (token, its session's access token).
async fn vault_session(router: &Router, user: &User, extra: Value) -> (ApiToken, String) {
    let token = new_token();
    let (status, body) = create_vault_token(router, user, &token, extra).await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let session = open(router, &token).await;
    let access = session["access_token"].as_str().unwrap().to_owned();
    (token, access)
}

fn code(body: &Value) -> &str {
    body["code"].as_str().unwrap_or("")
}

#[tokio::test]
async fn discovery_offers_vault_and_token_policies() {
    let (_, router) = suite().await;
    let (status, body) = send(&router, "GET", "/discovery", None, None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["apps"],
        json!([
            { "id": "todo", "name": "Atlas Todo", "version": 1 },
            { "id": "vault", "name": "Atlas Vault", "version": 2 },
        ])
    );
    let caps = body["capabilities"].as_array().unwrap();
    for cap in [
        "app_scoped_sync",
        "app_scoped_api_tokens",
        "api_token_policies",
    ] {
        assert!(caps.contains(&json!(cap)), "{cap}");
    }
}

#[tokio::test]
async fn vault_items_sync_in_the_vault_scope_only() {
    let (_, router) = suite().await;
    let user = vault_user(&router).await;
    let item = Uuid::now_v7();
    // Every field is opaque to the server, even one named like todo's links.
    let ops = vec![
        set_op("vault.item", item, "name", json!({ "__enc": 2, "ct": "x" })),
        set_op("vault.item", item, "project_id", json!(Uuid::now_v7())),
        set_op("vault.folder", Uuid::now_v7(), "name", json!("ct")),
    ];
    let (status, body) = push(&router, &user.token, None, ops.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a todo session: {body:?}");
    assert_eq!(body["scope"], "session");
    let (status, body) = push(&router, &user.token, Some("vault"), ops).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let (_, todo) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(todo["operations"], json!([]));
    let (_, vault) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&user.token),
        Some("vault"),
        Value::Null,
    )
    .await;
    assert_eq!(vault["operations"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn a_vault_token_needs_an_expiry_of_at_most_a_year() {
    let (_, router) = suite().await;
    let user = vault_user(&router).await;
    for (extra, expected) in [
        (json!({}), "api_token_expiry_required"),
        (json!({ "expires_at": null }), "api_token_expiry_required"),
        (
            json!({ "expires_at": now_ms() - 1000 }),
            "api_token_expiry_in_past",
        ),
        (
            json!({ "expires_at": now_ms() + 366 * DAY_MS }),
            "api_token_expiry_too_far",
        ),
        // A vault token is for the vault alone, whatever its expiry.
        (
            json!({ "apps": ["todo", "vault"], "wrapped_dek": wrap(), "wrapped_private_key": wrap() }),
            "api_token_app_exclusive",
        ),
        (
            json!({
                "apps": ["todo", "vault"], "wrapped_dek": wrap(), "wrapped_private_key": wrap(),
                "expires_at": now_ms() + DAY_MS,
            }),
            "api_token_app_exclusive",
        ),
    ] {
        let (status, body) = create_vault_token(&router, &user, &new_token(), extra.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{extra} {body:?}");
        assert_eq!(code(&body), expected, "{extra} {body:?}");
    }

    let expires_at = now_ms() + 30 * DAY_MS;
    let token = new_token();
    let (status, made) =
        create_vault_token(&router, &user, &token, json!({ "expires_at": expires_at })).await;
    assert_eq!(status, StatusCode::CREATED, "{made:?}");
    assert_eq!(made["apps"], json!(["vault"]));
    assert_eq!(made["expires_at"], json!(expires_at));
    assert_eq!(made["write"], json!(false), "read-only by default");

    let session = open(&router, &token).await;
    assert_eq!(session["expires_at"], json!(expires_at));
    assert_eq!(session["write"], json!(false));
    assert_eq!(session["apps"], json!(["vault"]));
    assert!(session.get("wrapped_dek").is_none());

    let (status, listed) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let row = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == json!(token.id))
        .unwrap();
    assert_eq!(row["expires_at"], json!(expires_at));
    assert_eq!(row["write"], json!(false));

    // A todo token keeps today's defaults, and may opt in to an expiry or out of writes.
    let todo = new_token();
    let (status, made) = send(
        &router,
        "POST",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        json!({ "id": todo.id, "name": "n8n", "auth": todo.auth,
                "wrapped_dek": wrap(), "wrapped_private_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made:?}");
    assert_eq!(made["write"], json!(true));
    assert!(made.get("expires_at").is_none());
    let session = open(&router, &todo).await;
    assert_eq!(session["write"], json!(true));
    assert!(session.get("expires_at").is_none());
}

#[tokio::test]
async fn a_read_only_token_reads_but_never_writes() {
    let (_, router) = suite().await;
    let user = vault_user(&router).await;
    let item = Uuid::now_v7();
    let (status, _) = push(
        &router,
        &user.token,
        Some("vault"),
        vec![set_op("vault.item", item, "name", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, pat) = vault_session(&router, &user, json!({ "expires_at": now_ms() + DAY_MS })).await;

    // Reads: pull, the snapshot, the socket ticket, project keys.
    for (method, uri) in [
        ("GET", "/sync/pull?since=0"),
        ("GET", "/sync/snapshot"),
        ("POST", "/sync/ws-ticket"),
        ("POST", "/api/sync/ws-ticket"),
        ("GET", "/api/sync/pull?since=0"),
    ] {
        let (status, body) =
            send(&router, method, uri, Some(&pat), Some("vault"), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{method} {uri}: {body:?}");
    }
    let (_, pulled) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&pat),
        Some("vault"),
        Value::Null,
    )
    .await;
    assert_eq!(pulled["operations"].as_array().unwrap().len(), 1);

    // Writes, of every kind a token session otherwise reaches, are refused before the handler.
    let project = Uuid::now_v7();
    for (method, uri, body) in [
        (
            "POST",
            "/sync/push".to_owned(),
            json!({ "operations": [set_op("vault.item", item, "name", json!("changed"))] }),
        ),
        (
            "POST",
            "/api/sync/push".to_owned(),
            json!({ "operations": [set_op("vault.item", item, "name", json!("changed"))] }),
        ),
        ("PUT", format!("/projects/{project}/keys"), json!({})),
        ("POST", format!("/projects/{project}/accept"), Value::Null),
        (
            "DELETE",
            format!("/projects/{project}/members/{}", Uuid::now_v7()),
            Value::Null,
        ),
    ] {
        let (status, refused) = send(&router, method, &uri, Some(&pat), Some("vault"), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {refused:?}");
        assert_eq!(code(&refused), "api_token_read_only", "{method} {uri}");
    }
    // Nothing changed.
    let (_, after) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&user.token),
        Some("vault"),
        Value::Null,
    )
    .await;
    assert_eq!(after["operations"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn writes_are_opted_in_per_token() {
    let (_, router) = suite().await;
    let user = vault_user(&router).await;
    let (_, pat) = vault_session(
        &router,
        &user,
        json!({ "expires_at": now_ms() + DAY_MS, "write": true }),
    )
    .await;
    let (status, body) = push(
        &router,
        &pat,
        Some("vault"),
        vec![set_op("vault.item", Uuid::now_v7(), "name", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    // Still a vault token: no todo.
    let (status, body) = push(
        &router,
        &pat,
        None,
        vec![set_op("task", Uuid::now_v7(), "title", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["scope"], "token");

    // A todo token may give up writes too.
    let todo = new_token();
    let (status, made) = send(
        &router,
        "POST",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        json!({ "id": todo.id, "name": "reader", "auth": todo.auth, "write": false,
                "wrapped_dek": wrap(), "wrapped_private_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made:?}");
    let session = open(&router, &todo).await;
    let (status, body) = push(
        &router,
        session["access_token"].as_str().unwrap(),
        None,
        vec![set_op("task", Uuid::now_v7(), "title", json!("ct"))],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&body), "api_token_read_only");
}

/// Move a token's expiry into the past, as time would.
async fn expire(state: &AppState, token: &ApiToken) {
    sqlx::query(
        "UPDATE api_tokens
            SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
          WHERE id = $1",
    )
    .bind(token.id)
    .execute(&state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_expired_token_opens_nothing_and_its_sessions_end() {
    let (state, router) = suite().await;
    let user = vault_user(&router).await;
    let (token, pat) =
        vault_session(&router, &user, json!({ "expires_at": now_ms() + DAY_MS })).await;
    let (status, _) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&pat),
        Some("vault"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    expire(&state, &token).await;
    // The open session's next request is refused with the typed error, reads and writes alike.
    for (method, uri) in [("GET", "/sync/pull?since=0"), ("POST", "/sync/ws-ticket")] {
        let (status, body) =
            send(&router, method, uri, Some(&pat), Some("vault"), Value::Null).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        assert_eq!(code(&body), "api_token_expired", "{uri}");
    }
    // And the exchange.
    let (status, body) = exchange(&router, &token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code(&body), "api_token_expired");
    // A wrong auth value still learns nothing.
    let (status, body) = exchange(
        &router,
        &ApiToken {
            id: token.id,
            auth: hex::encode(random_bytes::<32>()),
        },
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("code").is_none(), "{body:?}");

    // It stays listed until revoked, and revoking works as for any token.
    let (_, listed) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["id"] == json!(token.id)));
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/api-tokens/{}", token.id),
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = exchange(&router, &token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        body.get("code").is_none(),
        "revoked is a plain 401: {body:?}"
    );
    let wraps: (Option<Value>,) = sqlx::query_as("SELECT app_keys FROM api_tokens WHERE id = $1")
        .bind(token.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(wraps.0.is_none(), "revoking drops the wraps");
}

#[tokio::test]
async fn the_sweep_drops_an_expired_tokens_keys_and_keeps_its_row() {
    let (state, router) = suite().await;
    let user = vault_user(&router).await;
    let (expired, _) =
        vault_session(&router, &user, json!({ "expires_at": now_ms() + DAY_MS })).await;
    let (live, _) = vault_session(&router, &user, json!({ "expires_at": now_ms() + DAY_MS })).await;
    expire(&state, &expired).await;

    atlas_server::auth::api_tokens::scrub_expired(&state.pool)
        .await
        .unwrap();
    let keys = |id: Uuid| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_as::<_, (bool, bool)>(
                "SELECT app_keys IS NOT NULL, revoked_at IS NULL FROM api_tokens WHERE id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        keys(expired.id).await,
        (false, true),
        "keys gone, not revoked"
    );
    assert_eq!(
        keys(live.id).await,
        (true, true),
        "a live token keeps its keys"
    );

    // Its holder still learns that it expired, and it stays listed until revoked.
    let (status, body) = exchange(&router, &expired).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code(&body), "api_token_expired");
    open(&router, &live).await;
    let (_, list) = send(
        &router,
        "GET",
        "/auth/api-tokens",
        Some(&user.token),
        None,
        Value::Null,
    )
    .await;
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["id"] == json!(expired.id)));
}

#[tokio::test]
async fn a_session_ends_no_later_than_its_token() {
    let (_, router) = suite().await;
    let user = vault_user(&router).await;
    let token = new_token();
    let (status, body) = create_vault_token(
        &router,
        &user,
        &token,
        json!({ "expires_at": now_ms() + 60_000 }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let session = open(&router, &token).await;
    let ttl = session["expires_in"].as_i64().unwrap();
    assert!((1..=60).contains(&ttl), "{ttl}");
}

#[tokio::test]
async fn expired_tokens_do_not_count_against_the_cap() {
    let (state, router) = suite().await;
    let user = vault_user(&router).await;
    let (first, _) =
        vault_session(&router, &user, json!({ "expires_at": now_ms() + DAY_MS })).await;
    // Fill the account up to the cap directly (the API would hit the /auth rate limit first).
    let (user_id,): (Uuid,) = sqlx::query_as("SELECT user_id FROM api_tokens WHERE id = $1")
        .bind(first.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    for _ in 1..atlas_server::auth::api_tokens::MAX_LIVE_TOKENS {
        sqlx::query(
            "INSERT INTO api_tokens (id, user_id, name, auth_hash, apps, app_keys, expires_at)
             VALUES ($1, $2, 'filler', $3, '{vault}', '{}', now() + interval '1 day')",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(hex::encode(random_bytes::<32>()))
        .execute(&state.pool)
        .await
        .unwrap();
    }
    let later = json!({ "expires_at": now_ms() + DAY_MS });
    let (status, _) = create_vault_token(&router, &user, &new_token(), later.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT, "the cap holds");
    expire(&state, &first).await;
    let (status, body) = create_vault_token(&router, &user, &new_token(), later).await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
}
