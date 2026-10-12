//! Atlas Todo server library.
//!
//! The HTTP surface is built in [`app`] so it can be exercised in tests with a real or lazy pool.
//! Route modules are merged there: auth, project keys, members, sync, reports, and admin.

pub mod admin;
pub mod admin_users;
pub mod attachments;
pub mod audit;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod invites;
pub mod members;
pub mod projects;
pub mod ratelimit;
pub mod reports;
pub mod restore;
pub mod retention;
pub mod settings;
pub mod state;
pub mod sync;
pub mod sync_limit;

use axum::extract::State;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderName, HeaderValue};
use axum::{routing::get, Json, Router};
use serde_json::json;
use tower_http::cors::{Any, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::{DefaultOnFailure, DefaultOnResponse, TraceLayer};

use state::AppState;

#[cfg(test)]
use crate::config::BlobBackend;

/// How long `/health` waits for the database before declaring it unreachable.
const HEALTH_DB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Build the application router with all routes and shared state.
pub fn app(state: AppState) -> Router {
    // Rate-limit only the unauthenticated, guessable auth endpoints.
    let rl_state = ratelimit::RateLimitState::from_config(ratelimit::RateLimitConfig::from_env());
    let auth_routes = auth::routes().layer(axum::middleware::from_fn_with_state(
        rl_state,
        ratelimit::enforce,
    ));

    // Sync keys its limiter on the verified user id, not the IP (shared NATs). Pushes and reads
    // have separate budgets; see `sync_limit`.
    let sync_rl = sync_limit::SyncRateLimit::from_env(&state.config);

    // The push body cap (MAX_PUSH_BYTES) is scoped to the sync routes and sits inside the rate
    // limiter so a 429 costs no body read. The protocol gate is outermost: an outdated client
    // gets its 426 before spending budget.
    let sync_routes = sync::routes()
        .layer(axum::extract::DefaultBodyLimit::max(
            state.config.max_push_bytes,
        ))
        .layer(axum::middleware::from_fn_with_state(
            sync_rl,
            sync_limit::enforce,
        ))
        .layer(axum::middleware::from_fn(sync::require_sync_protocol));

    // `POST /reports` accepts anonymous callers, so it gets its own tighter bucket (a crash loop
    // must not burn a user's login budget). `BUG_REPORTS_ENABLED=false` never mounts the routes.
    let report_routes = if state.config.bug_reports_enabled {
        let report_rl =
            ratelimit::RateLimitState::from_config(ratelimit::RateLimitConfig::from_env_keyed(
                "REPORT_RATE_LIMIT_MAX",
                "REPORT_RATE_LIMIT_WINDOW_SECS",
                10,
                300,
            ));
        reports::routes()
            .layer(axum::middleware::from_fn_with_state(
                report_rl,
                ratelimit::enforce,
            ))
            .layer(axum::extract::DefaultBodyLimit::max(128 * 1024))
    } else {
        Router::new()
    };

    // Attachments, behind `ATTACHMENTS_ENABLED`. When off, only `GET /attachments/config` and a
    // JSON 404 for other `/attachments/*` paths are mounted. When on, uploads and downloads have
    // per-user rate limits (`UPLOAD_RATE_LIMIT_*`, `DOWNLOAD_RATE_LIMIT_*`) keyed like `/sync/*`.
    let attachment_routes = if state.config.attachments_enabled {
        let upload_rl = ratelimit::UserRateLimitState::from_config(
            ratelimit::RateLimitConfig::from_env_keyed(
                "UPLOAD_RATE_LIMIT_MAX",
                "UPLOAD_RATE_LIMIT_WINDOW_SECS",
                60,
                60,
            ),
            &state.config,
        );
        let download_rl = ratelimit::UserRateLimitState::from_config(
            ratelimit::RateLimitConfig::from_env_keyed(
                "DOWNLOAD_RATE_LIMIT_MAX",
                "DOWNLOAD_RATE_LIMIT_WINDOW_SECS",
                600,
                60,
            ),
            &state.config,
        );
        attachments::routes(upload_rl, download_rl, state.config.max_blob_transfers)
    } else {
        attachments::disabled_routes()
    };

    // Invites per user (`INVITE_RATE_LIMIT_*`): each one probes whether an email has an account.
    let invite_rl = ratelimit::UserRateLimitState::from_config(
        ratelimit::RateLimitConfig::from_env_keyed(
            "INVITE_RATE_LIMIT_MAX",
            "INVITE_RATE_LIMIT_WINDOW_SECS",
            60,
            3600,
        ),
        &state.config,
    );

    let api = Router::new()
        .route("/health", get(health))
        .merge(auth_routes)
        .merge(projects::routes())
        .merge(members::routes(invite_rl))
        .merge(sync_routes)
        .merge(attachment_routes)
        .merge(report_routes)
        .merge(admin::routes());

    let api_404 = || async {
        (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": "not found" })),
        )
    };

    Router::new()
        .merge(api.clone())
        .nest("/api", api.fallback(api_404))
        .fallback(static_fallback_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            spa_navigation,
        ))
        .with_state(state)
        .layer(cors_layer())
        .layer(PropagateRequestIdLayer::x_request_id())
        // One `request` span per request, carrying its `x-request-id` (made up when the client
        // sent none, and echoed in the response), so an error logged while serving it names the
        // request. Responses log at debug, server errors (5xx) at error. The path is logged
        // without its query: a socket ticket travels there.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|req: &axum::http::Request<axum::body::Body>| {
                    let id = req
                        .headers()
                        .get("x-request-id")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    tracing::info_span!("request", id, method = %req.method(), path = req.uri().path())
                })
                .on_request(())
                .on_response(DefaultOnResponse::new().level(tracing::Level::DEBUG))
                .on_failure(DefaultOnFailure::new().level(tracing::Level::ERROR)),
        )
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
}

/// The admin API shares `/admin/*` with what used to be the web app's admin pages (now a Settings
/// section), so a page load there (GET/HEAD asking for HTML with no bearer token) still gets the
/// SPA, which shows its not-found page, rather than a JSON 401; everything else reaches the API.
/// Only when a static dir is served.
async fn spa_navigation(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if state.config.static_dir.is_some() && is_admin_page_navigation(&req) {
        return static_fallback_handler(State(state), req).await;
    }
    next.run(req).await
}

fn is_admin_page_navigation(req: &axum::extract::Request) -> bool {
    let path = req.uri().path();
    let header = |name| req.headers().get(name).and_then(|v| v.to_str().ok());
    matches!(*req.method(), axum::http::Method::GET | axum::http::Method::HEAD)
        && (path == "/admin" || path.starts_with("/admin/"))
        && header(axum::http::header::ACCEPT).is_some_and(|a| a.contains("text/html"))
        // A proxy's Basic auth rides page loads too; only a bearer token marks an API call.
        && !header(AUTHORIZATION).is_some_and(|a| a.starts_with("Bearer "))
}

/// Fallback when no API route matches: JSON 404 for `/api/*`; otherwise the static asset or
/// `index.html` (SPA fallback) with security and caching headers; else a plain 404.
async fn static_fallback_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    mut req: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    let path = req.uri().path().to_owned();

    if path.starts_with("/api") {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": "not found" })),
        )
            .into_response();
    }

    if let Some(ref static_dir) = state.config.static_dir {
        if static_dir.is_dir() {
            // A missing hashed asset is a stale URL: 404, not the SPA, which would be cached as immutable.
            let hashed_asset = path.starts_with("/_expo/") || path.starts_with("/assets/");
            let serve_dir = tower_http::services::ServeDir::new(static_dir);
            let res = if hashed_asset {
                tower::ServiceExt::oneshot(serve_dir, req)
                    .await
                    .map(|r| r.map(axum::body::Body::new))
            } else {
                // Store paths (Nix) carry a fixed 1970 mtime and index.html keeps its length
                // across releases, so both a date check and ServeDir's mtime+size ETag would
                // answer 304 with a previous release's index.html. Always send the current bytes.
                let headers = req.headers_mut();
                for name in [
                    axum::http::header::IF_MODIFIED_SINCE,
                    axum::http::header::IF_UNMODIFIED_SINCE,
                    axum::http::header::IF_NONE_MATCH,
                    axum::http::header::IF_MATCH,
                ] {
                    headers.remove(name);
                }
                let index_file = static_dir.join("index.html");
                let with_spa = serve_dir.fallback(tower_http::services::ServeFile::new(index_file));
                tower::ServiceExt::oneshot(with_spa, req)
                    .await
                    .map(|r| r.map(axum::body::Body::new))
            };

            let mut response = match res {
                Ok(resp) => resp,
                Err(_) => (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
                    .into_response(),
            };

            let immutable = hashed_asset && response.status().is_success();
            let headers = response.headers_mut();

            // Scripts get no 'unsafe-inline'; styles keep it for react-native-web's runtime
            // injection. 'wasm-unsafe-eval' lets the bundle compile its Argon2id WebAssembly
            // and allows no JavaScript eval.
            headers.insert(
                "Content-Security-Policy",
                HeaderValue::from_static(
                    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
                ),
            );
            headers.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
            headers.insert(
                "X-Content-Type-Options",
                HeaderValue::from_static("nosniff"),
            );
            headers.insert(
                "Referrer-Policy",
                HeaderValue::from_static("strict-origin-when-cross-origin"),
            );
            headers.insert(
                "Permissions-Policy",
                HeaderValue::from_static("geolocation=(), microphone=(), camera=(), payment=()"),
            );

            if immutable {
                headers.insert(
                    axum::http::header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                );
            } else {
                headers.remove(axum::http::header::LAST_MODIFIED);
                headers.remove(axum::http::header::ETAG);
                headers.insert(
                    axum::http::header::CACHE_CONTROL,
                    HeaderValue::from_static("no-cache, must-revalidate"),
                );
            }

            return response;
        }
    }

    (axum::http::StatusCode::NOT_FOUND, "Not Found").into_response()
}

/// Cross-origin policy for the web client, which may be served from another origin than the API.
/// Auth is bearer-token based, so allowing any origin is safe and keeps self-hosting turnkey;
/// `CORS_ALLOWED_ORIGINS` (comma-separated exact origins) restricts it.
fn cors_layer() -> CorsLayer {
    cors_layer_from(std::env::var("CORS_ALLOWED_ORIGINS").ok())
}

/// Build the CORS layer from the raw `CORS_ALLOWED_ORIGINS` value (`None`/empty allows any
/// origin). Split out so it is testable without mutating process-global env.
fn cors_layer_from(allowed: Option<String>) -> CorsLayer {
    // A wildcard allow-headers does not cover `Authorization` per the Fetch spec, so list it,
    // `Content-Type` and the sync protocol header explicitly.
    let base = CorsLayer::new()
        .allow_methods(Any)
        .allow_headers([
            AUTHORIZATION,
            CONTENT_TYPE,
            HeaderName::from_static(sync::SYNC_PROTOCOL_HEADER),
        ])
        // Not CORS-safelisted; without it a cross-origin client cannot read a 429's back-off.
        .expose_headers([RETRY_AFTER]);
    match allowed {
        Some(v) if !v.trim().is_empty() => {
            let origins: Vec<HeaderValue> =
                v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
            base.allow_origin(origins)
        }
        _ => base.allow_origin(Any),
    }
}

/// Liveness and readiness probe for healthchecks. Verifies the database with `SELECT 1`; a
/// failure is a `503` with `status: "error"`, and the probe never hangs ([`HEALTH_DB_TIMEOUT`]).
async fn health(State(state): State<AppState>) -> axum::response::Response {
    use axum::response::IntoResponse;

    let db_ok = tokio::time::timeout(
        HEALTH_DB_TIMEOUT,
        sqlx::query("SELECT 1").execute(&state.pool),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    let (status, code) = if db_ok {
        ("ok", axum::http::StatusCode::OK)
    } else {
        tracing::warn!("health check: database unreachable");
        ("error", axum::http::StatusCode::SERVICE_UNAVAILABLE)
    };
    (
        code,
        Json(json!({
            "status": status,
            "service": "atlas-server",
            "database": if db_ok { "ok" } else { "unreachable" },
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;
    use uuid::Uuid;

    fn test_config(static_dir: Option<std::path::PathBuf>) -> Config {
        Config {
            database_url: "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into(),
            jwt_secret: b"test-secret-at-least-32-bytes-long!!".to_vec(),
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
            static_dir,
        }
    }

    /// A lazily-connected pool for the pure-routing tests; database behaviour is in `tests/`.
    fn test_app() -> Router {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://atlas:atlas@127.0.0.1:5432/atlas_test")
            .unwrap();
        let config = test_config(None);
        app(AppState::new(pool, config))
    }

    #[tokio::test]
    async fn unknown_route_is_404() {
        let response = test_app()
            .oneshot(Request::builder().uri("/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn sync_rate_limit_is_per_user() {
        use crate::ratelimit::{RateLimitConfig, UserRateLimitState};
        use std::time::Duration;

        let config = test_config(None);
        let rl_state = UserRateLimitState::from_config(
            RateLimitConfig {
                max_requests: 2,
                window: Duration::from_secs(60),
                trust_forwarded: true,
            },
            &config,
        );
        let router = Router::new()
            .route("/sync/pull", axum::routing::get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                rl_state,
                crate::ratelimit::enforce_per_user,
            ));

        let jwt_for = |uid: Uuid| {
            crate::auth::token::issue_access_token(
                uid,
                Uuid::now_v7(),
                900,
                &config.jwt_secret,
                time::OffsetDateTime::now_utc().unix_timestamp(),
            )
            .unwrap()
        };
        let hit = |jwt: String| {
            router.clone().oneshot(
                Request::builder()
                    .uri("/sync/pull")
                    .header("authorization", format!("Bearer {jwt}"))
                    .body(Body::empty())
                    .unwrap(),
            )
        };

        // Two requests from one user are allowed; the third is rate-limited...
        let alice = jwt_for(Uuid::now_v7());
        assert_eq!(hit(alice.clone()).await.unwrap().status(), StatusCode::OK);
        assert_eq!(hit(alice.clone()).await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            hit(alice).await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        // ...while another user's budget is untouched: sync is billed to the user, not the IP.
        let bob = jwt_for(Uuid::now_v7());
        assert_eq!(hit(bob).await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cors_preflight_allows_cross_origin_web_client() {
        // A preflight from the Vite dev origin must carry an allow-origin header.
        let response = test_app()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/auth/signup")
                    .header(header::ORIGIN, "http://localhost:5173")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert!(response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert!(response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_METHODS));
    }

    /// A minimal router carrying only the CORS layer under test.
    fn cors_only_app(allowed: Option<&str>) -> Router {
        Router::new()
            .route("/auth/signup", axum::routing::post(|| async { "ok" }))
            .layer(cors_layer_from(allowed.map(str::to_owned)))
    }

    async fn preflight(app: Router, origin: &str) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/auth/signup")
                .header(header::ORIGIN, origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "authorization,content-type",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn cors_allowlist_echoes_a_listed_origin() {
        // A preflight from an allowed origin is echoed back in Access-Control-Allow-Origin.
        let origin = "https://app.todo.example.com";
        let response = preflight(cors_only_app(Some(origin)), origin).await;
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            origin,
        );
    }

    #[tokio::test]
    async fn cors_allowlist_rejects_an_unlisted_origin() {
        // An origin outside the allowlist gets no allow-origin header.
        let response = preflight(
            cors_only_app(Some("https://app.todo.example.com")),
            "https://evil.example",
        )
        .await;
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[tokio::test]
    async fn cors_allows_the_sync_protocol_header() {
        // Every sync call carries this header; without it in the allow-list preflight fails.
        let response = preflight(cors_only_app(None), "https://anything.example").await;
        let allowed = response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .expect("allow-headers on the preflight")
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(allowed.contains(sync::SYNC_PROTOCOL_HEADER), "{allowed}");
    }

    #[tokio::test]
    async fn cors_unset_allows_any_origin() {
        // The turnkey default (no allowlist) reflects any origin.
        let response = preflight(cors_only_app(None), "https://anything.example").await;
        assert!(response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[tokio::test]
    async fn auth_rate_limit_returns_429_over_the_limit() {
        use crate::ratelimit::{RateLimitState, RateLimiter};
        use std::sync::Arc;
        use std::time::Duration;

        let rl_state = RateLimitState {
            limiter: Arc::new(RateLimiter::new(2, Duration::from_secs(60))),
            trust_forwarded: true,
        };
        let router = Router::new()
            .route("/auth/login", axum::routing::post(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                rl_state,
                crate::ratelimit::enforce,
            ));

        let hit = |ip: &str| {
            router.clone().oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/auth/login")
                    .header("x-forwarded-for", ip)
                    .body(Body::empty())
                    .unwrap(),
            )
        };

        // The first two requests from an IP are allowed; the third is rate-limited.
        assert_eq!(hit("1.2.3.4").await.unwrap().status(), StatusCode::OK);
        assert_eq!(hit("1.2.3.4").await.unwrap().status(), StatusCode::OK);
        assert_eq!(
            hit("1.2.3.4").await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        // A different client IP has its own budget.
        assert_eq!(hit("5.6.7.8").await.unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn me_without_token_is_401() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/auth/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unknown_api_route_is_json_404() {
        let response = test_app()
            .oneshot(
                Request::builder()
                    .uri("/api/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "not found");
    }

    #[tokio::test]
    async fn static_file_serving_and_spa_fallback() {
        let temp_dir =
            std::env::temp_dir().join(format!("atlas_test_static_{}", rand::random::<u64>()));
        std::fs::create_dir_all(temp_dir.join("assets")).unwrap();
        std::fs::write(temp_dir.join("index.html"), "<html>Atlas SPA</html>").unwrap();
        std::fs::write(temp_dir.join("assets/style.css"), "body { color: blue; }").unwrap();

        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://atlas:atlas@127.0.0.1:5432/atlas_test")
            .unwrap();
        let config = test_config(Some(temp_dir.clone()));
        let static_app = app(AppState::new(pool, config));

        // 1. Root serves index.html with no-cache and security headers
        let res = static_app
            .clone()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache, must-revalidate"
        );
        assert_eq!(res.headers().get("x-frame-options").unwrap(), "DENY");
        assert!(res.headers().contains_key("content-security-policy"));
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"<html>Atlas SPA</html>");

        // 1b. A date revalidation still gets the full page: store files share one mtime, so
        // a 304 could keep a previous release's index.html alive.
        let res = static_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::IF_MODIFIED_SINCE, "Thu, 01 Jan 2099 00:00:00 GMT")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!res.headers().contains_key(header::LAST_MODIFIED));

        // 1c. Nor does an ETag revalidation: the mtime+size ETag is the same for every release.
        let res = static_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::IF_NONE_MATCH, "*")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!res.headers().contains_key(header::ETAG));

        // 2. Static asset under /assets/ serves with immutable cache
        let res = static_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/assets/style.css")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"body { color: blue; }");

        // 3. Client route falls back to index.html with no-cache
        let res = static_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/inbox/today")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache, must-revalidate"
        );
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"<html>Atlas SPA</html>");

        // 4. Unknown /api/* route returns JSON 404, never index.html
        let res = static_app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/random_route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "not found");

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
