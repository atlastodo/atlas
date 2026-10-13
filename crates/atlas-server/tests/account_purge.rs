//! The purge of accounts whose 30-day deletion grace period is over. Runs against the shared test
//! database: every account here has a unique email, and the purge only ever takes accounts that are
//! past their grace period, so parallel tests cannot lose rows they depend on.

use atlas_server::auth::account_purge::purge_expired_accounts;
use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config() -> Config {
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
    }
}

async fn setup() -> (AppState, Router) {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let state = AppState::new(pool, config());
    (state.clone(), app(state))
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct Account {
    id: Uuid,
    email: String,
    token: String,
}

async fn signup(router: &Router) -> Account {
    let email = format!("purge-{}@example.com", Uuid::now_v7());
    let wrapped = json!({ "iv": "A".repeat(16), "ct": "A".repeat(64) });
    let (status, body) = send(
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
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    Account {
        id: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        email,
        token: body["access_token"].as_str().unwrap().to_string(),
    }
}

async fn schedule_deletion(pool: &PgPool, id: Uuid, days_ago: i32) {
    sqlx::query(
        "UPDATE users SET deletion_scheduled_at = now() - make_interval(days => $2) WHERE id = $1",
    )
    .bind(id)
    .bind(days_ago)
    .execute(pool)
    .await
    .unwrap();
}

async fn count(pool: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn accounts_past_the_grace_period_are_purged_with_everything_they_own() {
    let (state, router) = setup().await;
    let pool = state.pool.clone();

    let expired = signup(&router).await;
    let (status, _) = send(
        &router,
        "POST",
        "/sync/push",
        Some(&expired.token),
        json!({ "operations": [{
            "id": Uuid::now_v7(), "entity": "task", "entity_id": Uuid::now_v7(), "op": "set",
            "field": "title", "value": "x",
            "ts": { "wall_ms": 100, "counter": 0, "node": Uuid::now_v7() }
        }]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // A disabled account can never sign in to trigger anything; it must be purged all the same.
    let disabled = signup(&router).await;
    sqlx::query("UPDATE users SET disabled_at = now() WHERE id = $1")
        .bind(disabled.id)
        .execute(&pool)
        .await
        .unwrap();
    let still_in_grace = signup(&router).await;
    // The expired account is a member of someone else's shared project.
    let owner = signup(&router).await;
    let project = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role, state)
         VALUES ($1, $2, 'owner', 'active'), ($1, $3, 'editor', 'active')",
    )
    .bind(project)
    .bind(owner.id)
    .bind(expired.id)
    .execute(&pool)
    .await
    .unwrap();

    schedule_deletion(&pool, expired.id, 31).await;
    schedule_deletion(&pool, disabled.id, 31).await;
    schedule_deletion(&pool, still_in_grace.id, 29).await;

    // The purge is database-wide, and other tests purge concurrently, so which run removed these two
    // accounts (and the returned count) is not ours to assert; the per-account checks below are.
    purge_expired_accounts(&state).await.unwrap();

    for gone in [&expired, &disabled] {
        let id = gone.id;
        assert_eq!(
            count(&pool, "SELECT count(*) FROM users WHERE id = $1", id).await,
            0
        );
        assert_eq!(
            count(
                &pool,
                "SELECT count(*) FROM refresh_tokens WHERE user_id = $1",
                id
            )
            .await,
            0
        );
        let audited: Option<(Option<Uuid>, Value)> = sqlx::query_as(
            "SELECT actor_id, details FROM admin_actions
              WHERE action = 'user.purge' AND details->>'target_email' = $1",
        )
        .bind(&gone.email)
        .fetch_optional(&pool)
        .await
        .unwrap();
        let (actor, details) = audited.expect("the purge is audited");
        assert_eq!(actor, None, "no admin acted");
        assert_eq!(details["target_user_id"], json!(id));
    }
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM operations WHERE user_id = $1",
            expired.id
        )
        .await,
        0,
        "the op log goes with the account"
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM project_members WHERE user_id = $1",
            expired.id
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM users WHERE id = $1",
            still_in_grace.id
        )
        .await,
        1,
        "day 29 is still cancellable"
    );
    // The remaining member's collaborator list drops the purged account.
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM operations
              WHERE user_id = $1 AND entity = 'project_member' AND is_delete",
            owner.id
        )
        .await,
        1
    );
}

#[tokio::test]
async fn past_the_grace_period_login_and_cancel_get_a_typed_error_and_delete_nothing() {
    let (state, router) = setup().await;
    let account = signup(&router).await;
    schedule_deletion(&state.pool, account.id, 31).await;

    for uri in ["/auth/login", "/auth/account/cancel-deletion"] {
        let (status, body) = send(
            &router,
            "POST",
            uri,
            None,
            json!({ "email": account.email, "password": PASSWORD }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body:?}");
        assert_eq!(body["code"], "account_deleted", "{uri}");
    }
    // Deleting is the purge task's job, not a side effect of a request.
    assert_eq!(
        count(
            &state.pool,
            "SELECT count(*) FROM users WHERE id = $1",
            account.id
        )
        .await,
        1
    );

    // The still-live access token is refused too.
    let (status, body) = send(
        &router,
        "GET",
        "/auth/me",
        Some(&account.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "account_deleted");
}
