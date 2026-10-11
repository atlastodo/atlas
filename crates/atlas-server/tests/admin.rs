//! Integration tests for the admin surface: bug-report ingest and read, user management, signup
//! invites, runtime settings, and the audit trail.
//!
//! A report is accepted without a session; the whole `/admin/*` group requires the admin flag.

use atlas_server::{admin, app, config::Config, db, state::AppState};
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

/// Serialize the tests that touch `users.is_admin` across processes.
///
/// `sync_admins` and the guardrail tests are deployment-wide by design: they write the whole
/// `is_admin` column, while nextest runs every test in its own process against one shared
/// database. An in-process mutex serializes nothing under that model, and the repo's
/// isolation-by-unique-email convention does not help against a table-wide UPDATE.
///
/// A Postgres transaction-scoped advisory lock serializes across processes against the same
/// database, and is panic-safe: the holding transaction is rolled back (releasing the lock)
/// however the test ends, because the guard is simply dropped. The held transaction touches no
/// tables, so it never blocks non-admin tests' queries. Take it in every test that creates an admin
/// or writes admin flags table-wide; everything else keeps running in parallel.
async fn admin_lock(pool: &PgPool) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin admin-lock transaction");
    sqlx::query("SELECT pg_advisory_xact_lock(818)")
        .execute(&mut *tx)
        .await
        .expect("advisory lock");
    tx
}

/// Serialize the tests that read back, prune or wipe `bug_reports` (the same cross-process advisory
/// lock pattern as [`admin_lock`]): "clear all" and the retention cap act table-wide, and would
/// otherwise delete a row another test is about to read back. Take it after [`admin_lock`] when a
/// test needs both.
async fn reports_lock(pool: &PgPool) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin reports-lock transaction");
    sqlx::query("SELECT pg_advisory_xact_lock(819)")
        .execute(&mut *tx)
        .await
        .expect("advisory lock");
    tx
}

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config_with_admins(admin_emails: Vec<String>) -> Config {
    Config {
        database_url: test_database_url(),
        jwt_secret: b"integration-test-secret-32-bytes-x".to_vec(),
        access_ttl_seconds: 900,
        refresh_ttl_seconds: 3600,
        port: 8080,
        admin_emails,
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
    }
}

async fn pool() -> PgPool {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    pool
}

async fn setup() -> Router {
    app(AppState::new(pool().await, config_with_admins(Vec::new())))
}

async fn setup_without_reports() -> Router {
    app(AppState::new(
        pool().await,
        Config {
            bug_reports_enabled: false,
            ..config_with_admins(Vec::new())
        },
    ))
}

/// A router whose config lists `admin_emails`. Listing an address never makes its signup an admin;
/// only startup (`admin::sync_admins`) or the CLI promotes.
async fn setup_with_admins(emails: Vec<String>) -> Router {
    app(AppState::new(pool().await, config_with_admins(emails)))
}

/// Promote an existing account the way `atlas-server promote <email>` does.
async fn promote(email: &str) {
    let outcome = admin::set_admin_by_email(&pool().await, email, true, "cli")
        .await
        .unwrap();
    assert_ne!(outcome, admin::AdminChange::NotFound, "{email}");
}

async fn is_admin(pool: &PgPool, email: &str) -> bool {
    sqlx::query_scalar("SELECT is_admin FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The tests are explicit about `Config` (no env mutation), so a variant that overrides a flag is how
/// a closed-signup instance is simulated (the auth tests' precedent).
async fn setup_with(config: Config) -> Router {
    app(AppState::new(pool().await, config))
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
        .header("content-type", "application/json");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let req = b
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    // Not every 404 carries a JSON body; an unmounted route falls through to the root fallback's
    // plain-text "Not Found"; so an unparseable body is a null rather than a panic.
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

struct User {
    token: String,
    id: String,
    email: String,
    /// Present so tests can exercise the refresh flow (rotation, revocation).
    refresh_token: String,
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

async fn new_user(router: &Router) -> User {
    let email = format!("r-{}@example.com", Uuid::now_v7());
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email,
        refresh_token: body["refresh_token"].as_str().unwrap().to_string(),
    }
}

fn report_body(id: &str) -> Value {
    json!({
        "id": id,
        "kind": "crash",
        "message": "Cannot read property of undefined",
        "stack": "at render (bundle.js:1:2)",
        "app_version": "0.17.1",
        "platform": "ios",
        "os_version": "18.0",
        "route": "/task/0198ab00-0000-7000-8000-000000000001",
        "device_id": "device-1",
        "diagnostics": { "pending": 3, "syncStatus": "offline" },
        "breadcrumbs": [{ "at": 1, "code": "nav", "ref": "/today" }],
        "occurred_at": 1_754_300_000_000i64,
    })
}

/// Fetch a report by id straight from the database, so a test can assert on stored state without
/// needing an admin session.
async fn stored(pool: &PgPool, id: &str) -> Option<(Option<Uuid>, String, Option<String>)> {
    sqlx::query_as::<_, (Option<Uuid>, String, Option<String>)>(
        "SELECT user_id, message, stack FROM bug_reports WHERE id = $1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_optional(pool)
    .await
    .expect("query")
}

#[tokio::test]
async fn anonymous_report_is_accepted_and_stored() {
    // The whole point of the endpoint: a crash on the login screen has no token, and dropping it
    // would lose exactly the reports that matter most.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();

    let (status, body) = send(&router, "POST", "/reports", None, report_body(&id)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "anonymous report: {body}");

    let row = stored(&pool, &id).await.expect("report stored");
    assert_eq!(row.0, None, "no session means no user attribution");
}

#[tokio::test]
async fn authenticated_report_is_attributed() {
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let user = new_user(&router).await;
    let id = Uuid::now_v7().to_string();

    let (status, _) = send(
        &router,
        "POST",
        "/reports",
        Some(&user.token),
        report_body(&id),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let row = stored(&pool, &id).await.expect("report stored");
    assert_eq!(row.0, Some(Uuid::parse_str(&user.id).unwrap()));
}

#[tokio::test]
async fn duplicate_id_is_idempotent() {
    // The client's offline queue re-flushes on every launch, so a report delivered twice must not
    // become two rows.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();

    for _ in 0..2 {
        let (status, _) = send(&router, "POST", "/reports", None, report_body(&id)).await;
        assert_eq!(
            status,
            StatusCode::ACCEPTED,
            "a repeat delivery still succeeds"
        );
    }

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM bug_reports WHERE id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn unknown_kind_is_rejected() {
    let router = setup().await;
    let mut body = report_body(&Uuid::now_v7().to_string());
    body["kind"] = json!("nonsense");
    let (status, _) = send(&router, "POST", "/reports", None, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn oversized_fields_are_truncated_not_rejected() {
    // Losing a crash report to a 400 defeats the endpoint, so length is capped by truncation.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();
    let mut body = report_body(&id);
    body["stack"] = json!("at frame (bundle.js:1:1)\n".repeat(4_000));

    let (status, _) = send(&router, "POST", "/reports", None, body).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let row = stored(&pool, &id).await.expect("report stored");
    assert_eq!(row.2.expect("stack stored").len(), 16 * 1024);
}

#[tokio::test]
async fn multibyte_message_at_the_cap_does_not_panic() {
    // `String::truncate` panics off a char boundary; Danish is a shipped locale, so this is ordinary
    // input rather than an exotic edge case.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();
    let mut body = report_body(&id);
    body["message"] = json!("æ".repeat(3_000));

    let (status, _) = send(&router, "POST", "/reports", None, body).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let row = stored(&pool, &id).await.expect("report stored");
    assert!(row.1.len() <= 2_000);
}

#[tokio::test]
async fn breadcrumbs_are_reduced_to_well_formed_entries() {
    // The admin panel renders each breadcrumb's fields; a null or foreign-shaped entry must never
    // reach it, and an entry's size is bounded like every other field.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();
    let mut body = report_body(&id);
    let mut crumbs = vec![
        Value::Null,
        json!(5),
        json!({ "at": "yesterday", "code": "nav" }),
        json!({ "at": 1 }),
        json!({ "at": 2, "code": "nav", "ref": "/today", "extra": "dropped" }),
        json!({ "at": 3, "code": "x".repeat(500), "ref": 7 }),
    ];
    crumbs.extend((0..60).map(|n| json!({ "at": 100 + n, "code": "tap" })));
    body["breadcrumbs"] = Value::Array(crumbs);

    let (status, _) = send(&router, "POST", "/reports", None, body).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let stored: Value = sqlx::query_scalar("SELECT breadcrumbs FROM bug_reports WHERE id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    let stored = stored.as_array().unwrap();
    assert_eq!(stored.len(), 50, "capped, keeping the newest");
    assert_eq!(stored[49], json!({ "at": 159, "code": "tap", "ref": null }));
    assert!(stored.iter().all(|c| {
        let c = c.as_object().unwrap();
        c.len() == 3 && c["at"].is_number() && c["code"].is_string()
    }));

    // With few crumbs, the well-formed ones survive with their fields bounded.
    let small_id = Uuid::now_v7().to_string();
    let mut small = report_body(&small_id);
    small["breadcrumbs"] = json!([
        null,
        { "at": 2, "code": "nav", "ref": "/today", "extra": "dropped" },
        { "at": 3, "code": "x".repeat(500), "ref": 7 },
    ]);
    send(&router, "POST", "/reports", None, small).await;
    let stored: Value = sqlx::query_scalar("SELECT breadcrumbs FROM bug_reports WHERE id = $1")
        .bind(Uuid::parse_str(&small_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        stored[0],
        json!({ "at": 2, "code": "nav", "ref": "/today" })
    );
    assert_eq!(stored[1]["ref"], Value::Null, "a non-string ref is dropped");
    assert!(stored[1]["code"].as_str().unwrap().len() <= 64);
    assert_eq!(stored.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn only_the_newest_thousand_reports_are_kept() {
    // The one anonymous write in the API must not be able to grow the database without bound.
    let pool = pool().await;
    let _reports = reports_lock(&pool).await;
    let marker = format!("retention-fixture-{}", Uuid::now_v7());
    // One fixed base time for the fixtures and the check: `now()` moves on between statements, and
    // a slow run would otherwise count younger fixtures as the oldest.
    let base: String = sqlx::query_scalar("SELECT (now() - interval '1 day')::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO bug_reports (id, kind, message, app_version, platform, occurred_at, created_at)
         SELECT gen_random_uuid(), 'crash', $1, '0', 'ios', now(), $2::timestamptz - make_interval(secs => n)
           FROM generate_series(1, 1000) AS n",
    )
    .bind(&marker)
    .bind(&base)
    .execute(&pool)
    .await
    .unwrap();

    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let id = Uuid::now_v7().to_string();
    let (status, _) = send(&router, "POST", "/reports", None, report_body(&id)).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM bug_reports")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 1000);
    assert!(stored(&pool, &id).await.is_some(), "the new report is kept");
    let oldest_fixture_left: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bug_reports
          WHERE message = $1 AND created_at < $2::timestamptz - interval '999 seconds'",
    )
    .bind(&marker)
    .bind(&base)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(oldest_fixture_left, 0, "the oldest went first");
    sqlx::query("DELETE FROM bug_reports WHERE message = $1")
        .bind(&marker)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_non_admin_cannot_read_reports() {
    let router = setup().await;
    let user = new_user(&router).await;
    let (status, _) = send(
        &router,
        "GET",
        "/admin/reports",
        Some(&user.token),
        Value::Null,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "an ordinary account is refused the admin surface"
    );
}

#[tokio::test]
async fn reading_reports_without_a_token_is_401() {
    // Proves AdminUser still runs AuthUser first, rather than answering 403 to an anonymous caller.
    let router = setup().await;
    let (status, _) = send(&router, "GET", "/admin/reports", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bug_reports_disabled_mounts_no_filing_route() {
    // `BUG_REPORTS_ENABLED=false` is for a self-host with nobody reading the admin surface: the
    // only unauthenticated write in the API disappears entirely (a JSON 404 from the api fallback),
    // rather than staying mounted to record reports no one will ever see.
    let router = setup_without_reports().await;
    let (status, body) = send(
        &router,
        "POST",
        "/reports",
        None,
        json!({ "kind": "crash", "message": "boom" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body:?}");
}
#[tokio::test]
async fn an_admin_lists_filters_and_resolves() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let _reports = reports_lock(&pool).await;
    let (router, admin) = setup_with_fresh_admin().await;
    let token = admin.token;
    let admin_id = admin.id;

    let id = Uuid::now_v7().to_string();
    send(&router, "POST", "/reports", None, report_body(&id)).await;

    // The unresolved filter includes it, and the summary carries the reporter's email (null here).
    let (status, list) = send(
        &router,
        "GET",
        "/admin/reports?resolved=false&limit=100",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let found = list
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == json!(id))
        .expect("the new report is in the unresolved list");
    assert_eq!(found["user_email"], Value::Null);
    assert_eq!(found["platform"], "ios");

    // Detail carries the heavy fields the list omits.
    let (status, detail) = send(
        &router,
        "GET",
        &format!("/admin/reports/{id}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["diagnostics"]["pending"], 3);
    assert_eq!(detail["breadcrumbs"][0]["code"], "nav");

    // Resolving stamps resolved_at and drops it out of the unresolved filter.
    let (status, patched) = send(
        &router,
        "PATCH",
        &format!("/admin/reports/{id}"),
        Some(&token),
        json!({ "resolved": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(patched["resolved_at_ms"].is_i64());

    let (_, list) = send(
        &router,
        "GET",
        "/admin/reports?resolved=false&limit=100",
        Some(&token),
        Value::Null,
    )
    .await;
    assert!(
        !list
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == json!(id)),
        "a resolved report leaves the open list"
    );

    let (status, _) = send(
        &router,
        "GET",
        &format!("/admin/reports/{}", Uuid::now_v7()),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "an unknown report id is 404");

    // Deleting a single report removes it.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/admin/reports/{id}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = send(
        &router,
        "GET",
        &format!("/admin/reports/{id}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // "Clear" of the open list deletes only open reports; what the confirmation counted.
    let open_id = Uuid::now_v7().to_string();
    let resolved_id = Uuid::now_v7().to_string();
    for id in [&open_id, &resolved_id] {
        send(&router, "POST", "/reports", None, report_body(id)).await;
    }
    send(
        &router,
        "PATCH",
        &format!("/admin/reports/{resolved_id}"),
        Some(&token),
        json!({ "resolved": true }),
    )
    .await;
    let (status, resp) = send(
        &router,
        "DELETE",
        "/admin/reports?resolved=false",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert!(resp["deleted"].as_i64().unwrap() >= 1);
    assert!(stored(&pool, &open_id).await.is_none());
    assert!(
        stored(&pool, &resolved_id).await.is_some(),
        "a resolved report survives clearing the open list"
    );

    // Deleting all reports empties the table.
    let new_id = Uuid::now_v7().to_string();
    send(&router, "POST", "/reports", None, report_body(&new_id)).await;
    let (status, resp) = send(
        &router,
        "DELETE",
        "/admin/reports",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(resp["deleted"].as_i64().unwrap() >= 1);

    let (_, list_after) = send(
        &router,
        "GET",
        "/admin/reports?limit=100",
        Some(&token),
        Value::Null,
    )
    .await;
    assert!(
        !list_after
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == json!(new_id)),
        "the report created before bulk-delete is gone"
    );

    // Every one of those actions is in the audit trail, attributed to the admin.
    let actions: Vec<(String, Value)> = sqlx::query_as(
        "SELECT action, details FROM admin_actions
          WHERE actor_id = $1 AND action LIKE 'report.%' ORDER BY id",
    )
    .bind(Uuid::parse_str(&admin_id).unwrap())
    .fetch_all(&pool)
    .await
    .unwrap();
    let names: Vec<&str> = actions.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(
        names,
        [
            "report.resolve",
            "report.delete",
            "report.resolve",
            "report.delete_all",
            "report.delete_all"
        ],
        "{actions:?}"
    );
    assert_eq!(actions[0].1["report_id"], json!(id));
    assert_eq!(actions[3].1["resolved"], false);
}

#[tokio::test]
async fn the_startup_admin_list_promotes_existing_accounts_and_never_demotes() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let router = app(AppState::new(pool.clone(), config_with_admins(Vec::new())));
    let listed = new_user(&router).await;
    let panel_promoted = new_user(&router).await;
    promote(&panel_promoted.email).await;
    let not_yet_signed_up = format!("r-later-{}@example.com", Uuid::now_v7());

    assert!(
        !is_admin(&pool, &listed.email).await,
        "signup default is false"
    );
    let promoted = admin::sync_admins(&pool, &[listed.email.clone(), not_yet_signed_up.clone()])
        .await
        .unwrap();
    assert_eq!(promoted, 1, "only an existing account can be promoted");
    assert!(is_admin(&pool, &listed.email).await);
    assert!(
        is_admin(&pool, &panel_promoted.email).await,
        "an admin the list does not name keeps the role"
    );
    let audited: (Option<Uuid>, Value) = sqlx::query_as(
        "SELECT actor_id, details FROM admin_actions
          WHERE action = 'user.promote' AND target_user_id = $1",
    )
    .bind(Uuid::parse_str(&listed.id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited.0, None);
    assert_eq!(audited.1["source"], "env");
    assert_eq!(audited.1["target_email"], listed.email);

    // The panel says which admins the deploy config re-promotes at every start.
    let listing = setup_with_admins(vec![listed.email.clone()]).await;
    for (user, managed) in [(&listed, true), (&panel_promoted, false)] {
        let (status, rows) = send(
            &listing,
            "GET",
            &format!(
                "/admin/users?search={}",
                user.email.split('@').next().unwrap()
            ),
            Some(&listed.token),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{rows:?}");
        assert_eq!(rows[0]["managed_by_env"], managed, "{rows:?}");
    }

    // An address listed before its signup is not an admin when it signs up: listing names an
    // operator, it does not reserve the address for whoever registers it first.
    let later = signup_user(&router, &not_yet_signed_up).await;
    assert!(!is_admin(&pool, &later.email).await);
    assert_eq!(
        admin::sync_admins(&pool, &[]).await.unwrap(),
        0,
        "an empty list is a no-op"
    );
}

#[tokio::test]
async fn promote_and_demote_by_email_are_audited_as_the_cli() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let router = setup().await;
    let user = new_user(&router).await;
    let id = Uuid::parse_str(&user.id).unwrap();

    let change = admin::set_admin_by_email(&pool, &user.email.to_uppercase(), true, "cli")
        .await
        .unwrap();
    assert_eq!(change, admin::AdminChange::Changed);
    assert!(is_admin(&pool, &user.email).await);
    assert_eq!(
        admin::set_admin_by_email(&pool, &user.email, true, "cli")
            .await
            .unwrap(),
        admin::AdminChange::Unchanged
    );
    assert_eq!(
        admin::set_admin_by_email(&pool, "nobody-here@example.com", true, "cli")
            .await
            .unwrap(),
        admin::AdminChange::NotFound
    );
    let entries: Vec<(String, Option<Uuid>, Value)> = sqlx::query_as(
        "SELECT action, actor_id, details FROM admin_actions WHERE target_user_id = $1 ORDER BY id",
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        entries.len(),
        1,
        "a no-op writes no audit entry: {entries:?}"
    );
    assert_eq!(entries[0].0, "user.promote");
    assert_eq!(entries[0].1, None);
    assert_eq!(entries[0].2["source"], "cli");

    assert_eq!(
        admin::set_admin_by_email(&pool, &user.email, false, "cli")
            .await
            .unwrap(),
        admin::AdminChange::Changed
    );
    assert!(!is_admin(&pool, &user.email).await);
}

#[tokio::test]
async fn a_listed_email_gets_no_signup_privileges() {
    let email = format!("r-listed-{}@example.com", Uuid::now_v7());
    // On an open instance the signup works but is an ordinary account...
    let open = setup_with_admins(vec![email.clone()]).await;
    let user = signup_user(&open, &email).await;
    let (_, me) = send(&open, "GET", "/auth/me", Some(&user.token), Value::Null).await;
    assert_eq!(me["is_admin"], false);

    // ...and on a closed one it is refused like any other: the list is no key to the door.
    let other = format!("r-listed-{}@example.com", Uuid::now_v7());
    let closed = setup_with(Config {
        signup_enabled: false,
        ..config_with_admins(vec![other.clone()])
    })
    .await;
    let (status, body) = send(
        &closed,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": other, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["error"], "signup_disabled");
}

// -----------------------------------------------------------------------------
// User management, invites, settings, audit (the standalone admin panel)
// -----------------------------------------------------------------------------

/// Sign a fresh address up on an open instance and promote it; the fresh-self-host bootstrap
/// (sign up, then `atlas-server promote <email>`), yielding (router, admin session).
async fn setup_with_fresh_admin() -> (Router, User) {
    let email = format!("r-admin-{}@example.com", Uuid::now_v7());
    let router = setup().await;
    let admin = signup_user(&router, &email).await;
    promote(&email).await;
    (router, admin)
}

/// Sign an address up, asserting the basics. Returns the session (token, id, refresh token).
async fn signup_user(router: &Router, email: &str) -> User {
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "signup: {body}");
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email: email.to_string(),
        refresh_token: body["refresh_token"].as_str().unwrap().to_string(),
    }
}

async fn patch_user(router: &Router, token: &str, id: &str, body: Value) -> (StatusCode, Value) {
    send(
        router,
        "PATCH",
        &format!("/admin/users/{id}"),
        Some(token),
        body,
    )
    .await
}

#[tokio::test]
async fn a_non_admin_is_refused_the_whole_admin_user_surface() {
    let router = setup().await;
    let user = new_user(&router).await;
    let some_id = Uuid::now_v7().to_string();

    let reads = [
        "/admin/users",
        "/admin/invites",
        "/admin/settings",
        "/admin/audit",
    ];
    for uri in reads {
        let (status, _) = send(&router, "GET", uri, Some(&user.token), Value::Null).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "GET {uri} must be refused");
    }

    let user_uri = format!("/admin/users/{some_id}");
    let logout_uri = format!("/admin/users/{some_id}/logout");
    let writes: Vec<(&str, &str, Value)> = vec![
        ("PATCH", &user_uri, json!({ "disabled": true })),
        ("POST", "/admin/invites", json!({})),
        ("PATCH", "/admin/settings", json!({"signup_enabled": true})),
        ("POST", &logout_uri, Value::Null),
    ];
    for (method, uri, body) in writes {
        let (status, _) = send(&router, method, uri, Some(&user.token), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }

    // And with no token at all it is 401, not 403; auth still runs before the admin check.
    let (status, _) = send(&router, "GET", "/admin/users", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_admin_lists_searches_and_paginates_users() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (router, _admin) = setup_with_fresh_admin().await;
    let a = new_user(&router).await;
    let _b = new_user(&router).await;

    // Search matches a substring of the email (here: the unique local part) and nothing else.
    let needle = a.email.split('@').next().unwrap();
    let (status, list) = send(
        &router,
        "GET",
        &format!("/admin/users?search={needle}"),
        Some(&_admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list = list.as_array().unwrap();
    assert_eq!(
        list.len(),
        1,
        "the unique needle matches one user: {list:?}"
    );
    assert_eq!(list[0]["email"], a.email);
    assert_eq!(list[0]["is_admin"], false);
    assert_eq!(list[0]["disabled"], false);
    assert_eq!(list[0]["deletion_scheduled"], false);
    assert!(list[0]["deletion_days_remaining"].is_null());
    assert!(list[0].get("deletion_scheduled_at").is_none());
    assert!(list[0]["created_at_ms"].is_i64());
    assert!(
        list[0]["last_login_at_ms"].is_i64(),
        "signup starts a session, so it stamps the activity column"
    );

    // Keyset pagination, same as the reports list: a page is strictly older than the cursor.
    let (status, page) = send(
        &router,
        "GET",
        "/admin/users?limit=1",
        Some(&_admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let newest = &page.as_array().unwrap()[0];
    let cursor = newest["id"].as_str().unwrap().to_string();
    let (status, next_page) = send(
        &router,
        "GET",
        &format!("/admin/users?limit=100&before_id={cursor}"),
        Some(&_admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cursor_id = Uuid::parse_str(&cursor).unwrap();
    assert!(
        next_page
            .as_array()
            .unwrap()
            .iter()
            .all(|u| Uuid::parse_str(u["id"].as_str().unwrap()).unwrap() < cursor_id),
        "the next page is strictly older than the cursor, and never repeats it"
    );
}

#[tokio::test]
async fn admin_user_actions_respect_their_guardrails() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    // Make "last active admin" deterministic in the shared database: every admin-surface test
    // takes the same cross-process advisory lock, so clearing the column here races nothing.
    sqlx::query("UPDATE users SET is_admin = FALSE")
        .execute(&pool)
        .await
        .unwrap();

    let (router, admin) = setup_with_fresh_admin().await;
    let user = new_user(&router).await;

    // Stepping down as the ONLY admin is refused; this is the lockout guard doing its real work.
    let (status, _) = patch_user(
        &router,
        &admin.token,
        &admin.id,
        json!({ "is_admin": false }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Disabling or deleting your own account from the panel is refused outright.
    let (status, _) = patch_user(
        &router,
        &admin.token,
        &admin.id,
        json!({ "disabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/admin/users/{}", admin.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Force-logout is for other accounts; signing yourself out is the app's own logout.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/admin/users/{}/logout", admin.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // An empty patch has nothing to do.
    let (status, _) = patch_user(&router, &admin.token, &user.id, json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // An unknown user is a 404, not a silent success.
    let (status, _) = patch_user(
        &router,
        &admin.token,
        &Uuid::now_v7().to_string(),
        json!({ "is_admin": true }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Promote the user; with a second active admin, stepping down is allowed.
    let (status, view) =
        patch_user(&router, &admin.token, &user.id, json!({ "is_admin": true })).await;
    assert_eq!(status, StatusCode::OK, "{view:?}");
    assert_eq!(view["is_admin"], true);

    // With a second active admin, the first admin steps down (allowed)...
    let (status, view) = patch_user(
        &router,
        &admin.token,
        &admin.id,
        json!({ "is_admin": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view:?}");
    assert_eq!(view["is_admin"], false);
    // ...and the new admin can administer too (this also restores the world for later tests).
    let (status, _) =
        patch_user(&router, &user.token, &admin.id, json!({ "is_admin": true })).await;
    assert_eq!(status, StatusCode::OK, "the new admin can administer too");
}

#[tokio::test]
async fn an_admin_awaiting_deletion_does_not_keep_the_instance_administrable() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    sqlx::query("UPDATE users SET is_admin = FALSE")
        .execute(&pool)
        .await
        .unwrap();
    let (router, admin) = setup_with_fresh_admin().await;
    let leaving = new_user(&router).await;
    promote(&leaving.email).await;
    sqlx::query("UPDATE users SET deletion_scheduled_at = now() WHERE email = $1")
        .bind(&leaving.email)
        .execute(&pool)
        .await
        .unwrap();

    // The other admin is on their way out: stepping down would leave nobody.
    let (status, body) = patch_user(
        &router,
        &admin.token,
        &admin.id,
        json!({ "is_admin": false }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
}

#[tokio::test]
async fn stepping_down_while_disabling_the_other_admin_leaves_one_standing() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    sqlx::query("UPDATE users SET is_admin = FALSE")
        .execute(&pool)
        .await
        .unwrap();
    let (router, a) = setup_with_fresh_admin().await;
    let b = new_user(&router).await;
    promote(&b.email).await;
    let ids = vec![
        Uuid::parse_str(&a.id).unwrap(),
        Uuid::parse_str(&b.id).unwrap(),
    ];

    // Hold both rows so the two requests pass authentication and then meet at the guard at the
    // same time: each would otherwise see the other admin still active and go ahead.
    let mut hold = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id = ANY($1) FOR UPDATE")
        .bind(&ids)
        .execute(&mut *hold)
        .await
        .unwrap();
    let patch = |target: String, body: Value| {
        let (router, token) = (router.clone(), a.token.clone());
        tokio::spawn(async move { patch_user(&router, &token, &target, body).await })
    };
    let step_down = patch(a.id.clone(), json!({ "is_admin": false }));
    let disable_b = patch(b.id.clone(), json!({ "disabled": true }));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    hold.commit().await.unwrap();
    let (step_down, disable_b) = (step_down.await.unwrap(), disable_b.await.unwrap());

    let succeeded = [step_down.0, disable_b.0]
        .iter()
        .filter(|s| **s == StatusCode::OK)
        .count();
    assert_eq!(succeeded, 1, "{step_down:?} {disable_b:?}");
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE is_admin AND disabled_at IS NULL AND id = ANY($1)",
    )
    .bind(&ids)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(active, 1);
}

#[tokio::test]
async fn disabling_a_user_blocks_login_refresh_and_api() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (router, admin) = setup_with_fresh_admin().await;
    let user = signup_user(&router, &format!("r-{}@example.com", Uuid::now_v7())).await;
    let refresh_token = user.refresh_token.clone();

    // Sanity: the account works before the ban.
    let (status, _) = send(&router, "GET", "/auth/me", Some(&user.token), Value::Null).await;
    assert_eq!(status, StatusCode::OK);

    let (status, view) =
        patch_user(&router, &admin.token, &user.id, json!({ "disabled": true })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["disabled"], true);

    // The still-valid access token dies at the very next request; typed, so the client can show
    // "account disabled" instead of bouncing through its refresh loop.
    let (status, body) = send(&router, "GET", "/auth/me", Some(&user.token), Value::Null).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "account_disabled");

    // Login is blocked with the same typed error...
    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": user.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "account_disabled");

    // ...and the refresh tokens went with the ban.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh_token }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Re-enabling restores login (it is a ban, not a deletion).
    let (status, view) = patch_user(
        &router,
        &admin.token,
        &user.id,
        json!({ "disabled": false }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["disabled"], false);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": user.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn force_logout_revokes_every_refresh_token() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (router, admin) = setup_with_fresh_admin().await;
    let user = signup_user(&router, &format!("r-{}@example.com", Uuid::now_v7())).await;

    // Rotate once so the token under test is not the signup one.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": user.refresh_token }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rotated = body["refresh_token"].as_str().unwrap().to_string();

    let (status, _) = send(
        &router,
        "POST",
        &format!("/admin/users/{}/logout", user.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": rotated }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Not a ban: login still works.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": user.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // An unknown user is 404, not a silent 204.
    let (status, _) = send(
        &router,
        "POST",
        &format!("/admin/users/{}/logout", Uuid::now_v7()),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_delete_schedules_the_users_own_deletion_flow() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (router, admin) = setup_with_fresh_admin().await;
    let user = signup_user(&router, &format!("r-{}@example.com", Uuid::now_v7())).await;

    let (status, view) = send(
        &router,
        "DELETE",
        &format!("/admin/users/{}", user.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["deletion_scheduled"], true);
    assert_eq!(view["deletion_days_remaining"], 30);

    // The user sees exactly what a self-service deletion looks like: the typed 30-day window.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": user.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "account_scheduled_deletion");
    assert!(
        body["days_remaining"].as_i64().unwrap() <= 30,
        "the window is the usual 30 days"
    );

    // The list says so, too.
    let (status, list) = send(
        &router,
        "GET",
        &format!(
            "/admin/users?search={}",
            user.email.split('@').next().unwrap()
        ),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let row = &list.as_array().unwrap()[0];
    assert_eq!(row["deletion_scheduled"], true);
    assert_eq!(
        row["deletion_days_remaining"], 30,
        "just scheduled: the full grace period"
    );

    // Re-deleting an already-scheduled account is idempotent; self-delete stays refused.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/admin/users/{}", user.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/admin/users/{}", admin.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_invite_admits_one_person_to_a_closed_instance() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (_, admin) = setup_with_fresh_admin().await;
    let router = setup_with(Config {
        signup_enabled: false,
        ..config_with_admins(Vec::new())
    })
    .await;

    // Anyone else is refused, with the typed error the client translates.
    let closed_email = format!("r-{}@example.com", Uuid::now_v7());
    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": closed_email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "signup_disabled");

    // An invite opens the door for exactly one signup.
    let (status, invite) = send(
        &router,
        "POST",
        "/admin/invites",
        Some(&admin.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{invite:?}");
    let code = invite["code"].as_str().unwrap().to_string();
    let used_code = code.clone();
    let used_id = invite["id"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 64, "256 bits of entropy, hex-encoded");
    assert!(invite["expires_at_ms"].is_i64());

    let (status, _) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": closed_email,
            "password": PASSWORD,
            "invite": code,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "the invite admits one person");

    // ...and then the code is spent: a second use rolls back, creating no user.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": format!("r-{}@example.com", Uuid::now_v7()),
            "password": PASSWORD,
            "invite": code,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "invite_invalid");

    // A revoked invite is equally dead.
    let (status, invite) = send(
        &router,
        "POST",
        "/admin/invites",
        Some(&admin.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let invite_id = invite["id"].as_str().unwrap().to_string();
    let revoked_code = invite["code"].as_str().unwrap().to_string();
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/admin/invites/{invite_id}"),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": format!("r-{}@example.com", Uuid::now_v7()),
            "password": PASSWORD,
            "invite": invite["code"],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "invite_invalid");

    // Codes are stored hashed: shown once at creation, never listed again.
    let stored_hash: String = sqlx::query_scalar("SELECT code_hash FROM invites WHERE id = $1")
        .bind(Uuid::parse_str(&used_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        stored_hash,
        atlas_server::auth::token::hash_refresh_token(&used_code)
    );
    // The migration hashed pre-existing codes with the same function the lookup uses.
    let sql_hash: String =
        sqlx::query_scalar("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex')")
            .bind(&used_code)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sql_hash, stored_hash);

    // The invite list records both fates. The shared database accumulates rows across runs, so the
    // assertions filter to the two invites this test created rather than counting the table.
    let (status, invites) = send(
        &router,
        "GET",
        "/admin/invites?limit=100",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mine: Vec<&Value> = invites
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["id"] == json!(used_id) || i["id"] == json!(invite_id))
        .collect();
    assert_eq!(mine.len(), 2, "both invites of this test are listed");
    assert!(
        mine.iter().all(|i| i["code"].is_null()),
        "listed without codes"
    );
    let rendered = serde_json::to_string(&invites).unwrap();
    assert!(!rendered.contains(&used_code) && !rendered.contains(&revoked_code));
    let used = mine.iter().find(|i| i["id"] == json!(used_id)).unwrap();
    assert!(used["used_at_ms"].is_i64(), "the consumed invite says so");
    assert_eq!(used["used_by_email"], closed_email);
    let revoked = mine.iter().find(|i| i["id"] == json!(invite_id)).unwrap();
    assert!(revoked["revoked_at_ms"].is_i64());
    assert_eq!(revoked["used_at_ms"], Value::Null, "never used");
}

#[tokio::test]
async fn a_bad_invite_code_does_not_reveal_whether_an_email_has_an_account() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (open, admin) = setup_with_fresh_admin().await;
    let existing = new_user(&open).await;
    let closed = setup_with(Config {
        signup_enabled: false,
        ..config_with_admins(Vec::new())
    })
    .await;
    let signup_with = |email: String, invite: Value| {
        let closed = closed.clone();
        async move {
            send(
                &closed,
                "POST",
                "/auth/signup",
                None,
                with_keys(json!({ "email": email, "password": PASSWORD, "invite": invite })),
            )
            .await
        }
    };

    // Taken or free, a bogus code gets the same answer: the invite is checked first.
    for email in [
        existing.email.clone(),
        format!("r-{}@example.com", Uuid::now_v7()),
    ] {
        let (status, body) = signup_with(email, json!("not-a-real-invite")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
        assert_eq!(body["error"], "invite_invalid");
    }

    // Only a valid invite gets as far as the duplicate check, and that does not spend it.
    let (_, invite) = send(
        &closed,
        "POST",
        "/admin/invites",
        Some(&admin.token),
        json!({}),
    )
    .await;
    let (status, _) = signup_with(existing.email.clone(), invite["code"].clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, body) = signup_with(
        format!("r-{}@example.com", Uuid::now_v7()),
        invite["code"].clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
}

#[tokio::test]
async fn the_settings_override_beats_the_env_default() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    // Start clean and end clean: the settings row is deployment-wide state in one shared
    // database, so a leftover override would silently re-configure every other test's (and every
    // other binary's) signup. The row this test writes can only ever *open* signup; an
    // env-closed instance is the safe direction to test precedence from; writing `false` here and
    // asserting a 403 would close signup for every concurrently-running suite. Cleanup at both
    // ends also makes the test self-healing after a failed run.
    sqlx::query("DELETE FROM instance_settings")
        .execute(&pool)
        .await
        .unwrap();

    let (_, admin) = setup_with_fresh_admin().await;
    let router = setup_with(Config {
        signup_enabled: false,
        ..config_with_admins(Vec::new())
    })
    .await;

    // The panel reflects the env default while no override exists.
    let (status, view) = send(
        &router,
        "GET",
        "/admin/settings",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["signup_enabled"], false, "env default, no row yet");

    // The panel's override beats the env: opening signup needs no restart or env edit.
    let (status, view) = send(
        &router,
        "PATCH",
        "/admin/settings",
        Some(&admin.token),
        json!({ "signup_enabled": true }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["signup_enabled"], true);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(
            json!({ "email": format!("r-{}@example.com", Uuid::now_v7()), "password": PASSWORD }),
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "the database row overrode the closed env"
    );

    // Dropping the override reverts to the env default (documented escape hatch).
    sqlx::query("DELETE FROM instance_settings")
        .execute(&pool)
        .await
        .unwrap();
    let (status, view) = send(
        &router,
        "GET",
        "/admin/settings",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["signup_enabled"], false, "the env default is back");
}

#[tokio::test]
async fn admin_actions_land_in_the_audit_trail() {
    let pool = pool().await;
    let _guard = admin_lock(&pool).await;
    let (router, admin) = setup_with_fresh_admin().await;
    let user = new_user(&router).await;

    // A few actions across resources, in a known order.
    patch_user(&router, &admin.token, &user.id, json!({ "is_admin": true })).await;
    patch_user(&router, &admin.token, &user.id, json!({ "disabled": true })).await;
    send(
        &router,
        "POST",
        &format!("/admin/users/{}/logout", user.id),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    send(
        &router,
        "POST",
        "/admin/invites",
        Some(&admin.token),
        json!({}),
    )
    .await;
    send(
        &router,
        "PATCH",
        "/admin/settings",
        Some(&admin.token),
        json!({ "signup_enabled": true }),
    )
    .await;
    // The settings row is deployment-wide state. Writing `true` (the safe direction: every other
    // test's instance is open anyway) keeps concurrent signups working; the closed-instance tests
    // that such a row would affect share a serial nextest group with this one
    // (`.config/nextest.toml`). Clean up so the shared database goes back to "the env decides".
    sqlx::query("DELETE FROM instance_settings")
        .execute(&pool)
        .await
        .unwrap();

    let (status, audit) = send(
        &router,
        "GET",
        "/admin/audit?limit=100",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = audit.as_array().unwrap();
    let actions: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    // The shared database accumulates entries across runs (and the settings test runs concurrently),
    // so the assertion is containment rather than an exact snapshot of the table.
    for expected in [
        "user.promote",
        "user.disable",
        "user.force_logout",
        "invite.create",
        "settings.update",
    ] {
        assert!(
            actions.contains(&expected),
            "{expected} missing from {actions:?}"
        );
    }
    let settings_entry = entries
        .iter()
        .find(|e| e["action"] == "settings.update")
        .unwrap();
    assert!(settings_entry["details"]["signup_enabled"].is_boolean());
    // Attribution is full: who acted, on whom.
    let promote = entries
        .iter()
        .find(|e| e["action"] == "user.promote")
        .unwrap();
    assert_eq!(promote["actor_email"], admin.email);
    assert_eq!(promote["target_email"], user.email);
    assert_eq!(promote["details"]["is_admin"], true);
    // The target's email is kept in the details too, so the entry still names them after the
    // account is purged (the target column is nulled then).
    for action in ["user.promote", "user.disable", "user.force_logout"] {
        let entry = entries.iter().find(|e| e["action"] == action).unwrap();
        assert_eq!(entry["details"]["target_email"], user.email, "{action}");
    }

    // Keyset pagination on the identity cursor.
    let cursor = entries[0]["id"].as_i64().unwrap();
    let (status, older) = send(
        &router,
        "GET",
        &format!("/admin/audit?limit=100&before_id={cursor}"),
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(older
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["id"].as_i64().unwrap() < cursor));
}
