//! The web app's `/admin/*` pages share their paths with the root-mounted admin API. A browser
//! navigation (a refresh, a pasted link) must get the SPA, while API calls keep getting the API.
//! No database is needed: every request here is answered before a handler queries it.

use atlas_server::{app, config::Config, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

fn config(static_dir: Option<std::path::PathBuf>) -> Config {
    Config {
        database_url: "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into(),
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
        static_dir,
    }
}

fn router(static_dir: Option<std::path::PathBuf>) -> Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://atlas:atlas@127.0.0.1:5432/atlas_test")
        .unwrap();
    app(AppState::new(pool, config(static_dir)))
}

fn static_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("atlas_spa_{}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<html>Atlas SPA</html>").unwrap();
    dir
}

async fn get(
    router: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut req = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let res = router
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&body).into_owned())
}

const BROWSER_ACCEPT: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

#[tokio::test]
async fn a_browser_navigation_to_an_admin_page_gets_the_spa() {
    let dir = static_dir();
    let app = router(Some(dir.clone()));
    for page in ["/admin/users", "/admin/reports", "/admin/settings"] {
        let (status, body) = get(&app, "GET", page, &[("accept", BROWSER_ACCEPT)]).await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(body, "<html>Atlas SPA</html>", "{page}");
    }
    // A reverse proxy's Basic auth rides every navigation; it is not an API credential.
    let (status, body) = get(
        &app,
        "GET",
        "/admin/users",
        &[("accept", BROWSER_ACCEPT), ("authorization", "Basic dTpw")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Atlas SPA"));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn api_calls_to_the_same_paths_still_reach_the_api() {
    let dir = static_dir();
    let app = router(Some(dir.clone()));
    type Case = (
        &'static str,
        &'static str,
        &'static [(&'static str, &'static str)],
    );
    let api_answers: [Case; 5] = [
        ("GET", "/admin/users", &[("accept", "application/json")]),
        ("GET", "/admin/users", &[("accept", "*/*")]),
        (
            "GET",
            "/admin/users",
            &[
                ("accept", BROWSER_ACCEPT),
                ("authorization", "Bearer not-a-jwt"),
            ],
        ),
        ("GET", "/api/admin/users", &[("accept", BROWSER_ACCEPT)]),
        ("POST", "/admin/invites", &[("accept", BROWSER_ACCEPT)]),
    ];
    for (method, uri, headers) in api_answers {
        let (status, body) = get(&app, method, uri, headers).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{method} {uri} {headers:?}"
        );
        assert!(body.contains("unauthorized"), "{method} {uri}: {body}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn without_a_static_dir_admin_paths_are_api_only() {
    let app = router(None);
    let (status, _) = get(&app, "GET", "/admin/users", &[("accept", BROWSER_ACCEPT)]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// Hashed build output (`/_expo/*`, `/assets/*`) is cached forever, so a missing file there must be
/// a 404: answering with the SPA would pin index.html in the browser cache as that "asset" for a
/// year. Client routes still fall back to the SPA.
#[tokio::test]
async fn a_missing_hashed_asset_is_a_404_not_the_spa() {
    let dir = static_dir();
    std::fs::create_dir_all(dir.join("_expo/static/js/web")).unwrap();
    std::fs::write(dir.join("_expo/static/js/web/entry-abc.js"), "run()").unwrap();
    let app = router(Some(dir.clone()));
    let send = |uri: &str| {
        app.clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
    };

    let found = send("/_expo/static/js/web/entry-abc.js").await.unwrap();
    assert_eq!(found.status(), StatusCode::OK);
    assert_eq!(
        found.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );

    for missing in [
        "/_expo/static/js/web/entry-old.js",
        "/assets/icon.0123abcd.png",
    ] {
        let res = send(missing).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{missing}");
        assert_eq!(
            res.headers()["cache-control"],
            "no-cache, must-revalidate",
            "{missing}"
        );
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert!(!body.starts_with(b"<html>"), "{missing} served the SPA");
    }

    let (status, body) = get(&app, "GET", "/inbox/today", &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "<html>Atlas SPA</html>");
    let _ = std::fs::remove_dir_all(dir);
}

/// The web export loads every script from a file, so the CSP allows no inline script and no eval.
/// It may compile WebAssembly, which the password KDF needs.
#[tokio::test]
async fn the_csp_allows_no_inline_scripts() {
    let dir = static_dir();
    let app = router(Some(dir.clone()));
    let res = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let csp = res.headers()["content-security-policy"].to_str().unwrap();
    let script_src = csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("script-src"))
        .expect("a script-src directive");
    assert_eq!(script_src, "script-src 'self' 'wasm-unsafe-eval'");
    let _ = std::fs::remove_dir_all(dir);
}
