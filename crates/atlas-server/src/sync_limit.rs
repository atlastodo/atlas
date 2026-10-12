//! Per-user rate limits for the `/sync/*` surface, keyed on the verified user id, with
//! `Retry-After` on refusal (`429`).
//!
//! - push (`POST /sync/push`): `SYNC_RATE_LIMIT_MAX` per `SYNC_RATE_LIMIT_WINDOW_SECS` (default 60 per 60 s).
//! - read (`/sync/pull`, `/sync/snapshot`, `/sync/ws-ticket`): `SYNC_READ_RATE_LIMIT_MAX` per
//!   `SYNC_READ_RATE_LIMIT_WINDOW_SECS` (default 600 per 60 s). A bootstrap walks many pages back
//!   to back, so sharing the push budget would livelock a large account on 429s. The `/sync/ws`
//!   handshake carries no token, only the ticket that `ws-ticket` request paid for.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::header::{AUTHORIZATION, RETRY_AFTER};
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use uuid::Uuid;

use crate::auth::token;
use crate::ratelimit::RateLimitConfig;

/// Default read budget: enough for a large bootstrap at 1000 keys per snapshot page.
const DEFAULT_READ_MAX: u32 = 600;
const DEFAULT_WINDOW_SECS: u64 = 60;
const DEFAULT_PUSH_MAX: u32 = 60;

pub struct WindowLimiter {
    max: u32,
    window: Duration,
    state: Mutex<HashMap<Uuid, (Instant, u32)>>,
}

impl WindowLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max: max.max(1),
            window,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Count one request from `user` at `now`: `Err(wait)` over the limit, with the time until
    /// the window resets.
    pub fn check(&self, user: Uuid, now: Instant) -> Result<(), Duration> {
        let mut map = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        // Drop elapsed windows so the map stays bounded.
        map.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        let (start, count) = map.entry(user).or_insert((now, 0));
        *count += 1;
        if *count <= self.max {
            Ok(())
        } else {
            Err(self.window.saturating_sub(now.duration_since(*start)))
        }
    }
}

#[derive(Clone)]
pub struct SyncRateLimit {
    push: Arc<WindowLimiter>,
    read: Arc<WindowLimiter>,
    jwt_secret: Arc<Vec<u8>>,
}

impl SyncRateLimit {
    pub fn new(push: RateLimitConfig, read: RateLimitConfig, jwt_secret: &[u8]) -> Self {
        Self {
            push: Arc::new(WindowLimiter::new(push.max_requests, push.window)),
            read: Arc::new(WindowLimiter::new(read.max_requests, read.window)),
            jwt_secret: Arc::new(jwt_secret.to_vec()),
        }
    }

    pub fn from_env(config: &crate::config::Config) -> Self {
        Self::new(
            RateLimitConfig::from_env_keyed(
                "SYNC_RATE_LIMIT_MAX",
                "SYNC_RATE_LIMIT_WINDOW_SECS",
                DEFAULT_PUSH_MAX,
                DEFAULT_WINDOW_SECS,
            ),
            RateLimitConfig::from_env_keyed(
                "SYNC_READ_RATE_LIMIT_MAX",
                "SYNC_READ_RATE_LIMIT_WINDOW_SECS",
                DEFAULT_READ_MAX,
                DEFAULT_WINDOW_SECS,
            ),
            &config.jwt_secret,
        )
    }
}

/// The verified user a sync request is attributable to; `None` (no or invalid token, as on the
/// WebSocket handshake) passes through and the handler's own auth rejects it.
fn request_subject(headers: &HeaderMap, secret: &[u8]) -> Option<Uuid> {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))?;
    token::verify_access_token(token, secret)
        .ok()
        .map(|c| c.sub)
}

pub async fn enforce(
    State(rl): State<SyncRateLimit>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if let Some(user) = request_subject(req.headers(), &rl.jwt_secret) {
        let limiter = if req.uri().path().ends_with("/sync/push") {
            &rl.push
        } else {
            &rl.read
        };
        if let Err(wait) = limiter.check(user, Instant::now()) {
            return too_many_requests(wait);
        }
    }
    next.run(req).await
}

fn too_many_requests(wait: Duration) -> Response {
    // Whole seconds, rounded up and at least 1, so an honouring client is never early.
    let secs = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": "too many requests" })),
    )
        .into_response();
    res.headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from(secs.max(1)));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_reports_the_rest_of_the_window() {
        let rl = WindowLimiter::new(2, Duration::from_secs(60));
        let user = Uuid::now_v7();
        let t0 = Instant::now();
        assert!(rl.check(user, t0).is_ok());
        assert!(rl.check(user, t0 + Duration::from_secs(10)).is_ok());
        assert_eq!(
            rl.check(user, t0 + Duration::from_secs(15)),
            Err(Duration::from_secs(45))
        );
        assert!(
            rl.check(Uuid::now_v7(), t0).is_ok(),
            "each user has a budget"
        );
        assert!(
            rl.check(user, t0 + Duration::from_secs(60)).is_ok(),
            "a new window starts once the old one elapses"
        );
    }

    #[test]
    fn retry_after_rounds_up_to_whole_seconds() {
        let res = too_many_requests(Duration::from_millis(1500));
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers()[RETRY_AFTER], "2");
        assert_eq!(
            too_many_requests(Duration::ZERO).headers()[RETRY_AFTER],
            "1"
        );
    }
}
