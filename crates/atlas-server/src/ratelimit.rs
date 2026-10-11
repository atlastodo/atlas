//! A small, dependency-free fixed-window in-memory rate limiter; over the cap answers 429.
//!
//! `/auth/*` and `POST /reports` are keyed per client IP (the only unforgeable handle for
//! unauthenticated callers, see [`client_ip`]). `/sync/*`, attachments and invites are keyed per
//! verified user id, which survives shared NATs and network changes. Password logins and recovery
//! also count failures per account and address ([`account_failures`]), with an account-wide cap so
//! guesses spread over many addresses still hit one.
//!
//! Behind a reverse proxy `AUTH_RATE_LIMIT_TRUST_FORWARDED=true` reads `X-Forwarded-For` from the
//! right: the entry `TRUSTED_PROXY_HOPS` from the end is the one the outermost trusted proxy
//! saw; everything left of it is client-written. Off by default for that reason.
//!
//! Each limiter tracks at most [`MAX_TRACKED_KEYS`] keys. When the map is full of live windows a
//! new key is refused (fails closed) rather than evicting one, which would let fresh keys reset
//! the counter of the key under attack.

use std::collections::HashMap;
use std::hash::Hash;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::auth::token;
use crate::config::{env_number, parse_bool, parse_number};
use crate::error::AppError;

#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    pub max_requests: u32,
    pub window: Duration,
    pub trust_forwarded: bool,
}

impl RateLimitConfig {
    /// `AUTH_RATE_LIMIT_MAX` (default 30) requests per `AUTH_RATE_LIMIT_WINDOW_SECS` (default 60)
    /// per client IP; `AUTH_RATE_LIMIT_TRUST_FORWARDED` (default false) honours forwarded-for.
    pub fn from_env() -> Self {
        Self::from_env_keyed("AUTH_RATE_LIMIT_MAX", "AUTH_RATE_LIMIT_WINDOW_SECS", 30, 60)
    }

    /// A second limited surface with its own knobs. `POST /reports` is unauthenticated and wants
    /// a tighter budget. `AUTH_RATE_LIMIT_TRUST_FORWARDED` stays shared: it describes the proxy,
    /// not a route.
    pub fn from_env_keyed(
        max_key: &str,
        window_key: &str,
        default_max: u32,
        default_window_secs: u64,
    ) -> Self {
        // Malformed values already failed startup (`validate_env`); defaults cover tests.
        let max_requests = env_number(max_key, default_max)
            .unwrap_or(default_max)
            .max(1);
        let window_secs = env_number(window_key, default_window_secs)
            .unwrap_or(default_window_secs)
            .max(1);
        let trust_forwarded =
            trust_forwarded_from(std::env::var("AUTH_RATE_LIMIT_TRUST_FORWARDED").ok());
        Self {
            max_requests,
            window: Duration::from_secs(window_secs),
            trust_forwarded,
        }
    }
}

/// `AUTH_RATE_LIMIT_TRUST_FORWARDED`: off unless enabled, since without a proxy the header is client-written.
fn trust_forwarded_from(raw: Option<String>) -> bool {
    raw.filter(|v| !v.trim().is_empty())
        .is_some_and(|v| parse_bool("AUTH_RATE_LIMIT_TRUST_FORWARDED", &v).unwrap_or(false))
}

/// Check every rate-limit setting in `vars` so a malformed value fails startup naming the
/// variable. Matches the `*_RATE_LIMIT_MAX` / `*_RATE_LIMIT_WINDOW_SECS` suffixes.
pub fn validate_env(vars: impl IntoIterator<Item = (String, String)>) -> Result<(), String> {
    for (key, value) in vars {
        if value.trim().is_empty() {
            continue;
        }
        if key == "AUTH_RATE_LIMIT_TRUST_FORWARDED" {
            parse_bool(&key, &value)?;
        } else if key.ends_with("_RATE_LIMIT_MAX") || key == "AUTH_ACCOUNT_FAILURE_MAX" {
            parse_number::<u32>(&key, &value)?;
        } else if key.ends_with("_RATE_LIMIT_WINDOW_SECS")
            || key == "AUTH_ACCOUNT_FAILURE_WINDOW_SECS"
        {
            parse_number::<u64>(&key, &value)?;
        } else if key == "TRUSTED_PROXY_HOPS" {
            parse_number::<usize>(&key, &value)?;
        }
    }
    Ok(())
}

/// Upper bound on the keys one limiter tracks.
pub const MAX_TRACKED_KEYS: usize = 100_000;

/// Expired windows are swept every this many checks.
pub const PRUNE_EVERY: u64 = 1024;

/// Fixed-window counters keyed by `K`, bounded in memory.
struct Windows<K> {
    map: HashMap<K, Window>,
    checks: u64,
    capacity: usize,
}

struct Window {
    start: Instant,
    count: u32,
}

impl<K: Eq + Hash + Clone> Windows<K> {
    fn new(capacity: usize) -> Self {
        Self {
            map: HashMap::new(),
            checks: 0,
            capacity: capacity.max(1),
        }
    }

    /// The live window for `key` at `now`, created or restarted as needed; `None` when the key is
    /// new and the map is full.
    fn window(&mut self, key: K, now: Instant, window: Duration) -> Option<&mut Window> {
        self.checks += 1;
        let full = self.map.len() >= self.capacity && !self.map.contains_key(&key);
        if self.checks.is_multiple_of(PRUNE_EVERY) || full {
            self.map.retain(|_, w| now.duration_since(w.start) < window);
            if self.map.len() >= self.capacity && !self.map.contains_key(&key) {
                return None;
            }
        }
        let w = self.map.entry(key).or_insert(Window {
            start: now,
            count: 0,
        });
        if now.duration_since(w.start) >= window {
            w.start = now;
            w.count = 0;
        }
        Some(w)
    }
}

/// Fixed-window request counter keyed by `K`. Windows reset lazily on access.
pub struct RateLimiter<K: Eq + Hash + Clone> {
    max: u32,
    window: Duration,
    state: Mutex<Windows<K>>,
}

impl<K: Eq + Hash + Clone> RateLimiter<K> {
    pub fn new(max: u32, window: Duration) -> Self {
        Self::with_capacity(max, window, MAX_TRACKED_KEYS)
    }

    pub fn with_capacity(max: u32, window: Duration, capacity: usize) -> Self {
        Self {
            max: max.max(1),
            window,
            state: Mutex::new(Windows::new(capacity)),
        }
    }

    /// Record a request from `key` at `now`; true if within the limit. `now` is injected for tests.
    pub fn check(&self, key: K, now: Instant) -> bool {
        match lock(&self.state).window(key, now, self.window) {
            Some(w) => {
                w.count += 1;
                w.count <= self.max
            }
            None => false,
        }
    }
}

/// How many times the per-address cap one account's failures may add up to across addresses.
pub const ACCOUNT_WIDE_FACTOR: u32 = 5;

/// Counts failed credential checks per account (a normalized email) and client address. An
/// address is blocked for an account at the cap, and the account for every address at
/// [`ACCOUNT_WIDE_FACTOR`] times it. Someone who knows an email therefore cannot lock its owner
/// out from one address, while guesses spread over many addresses still hit a cap. Only failures
/// count and a success clears both, so the owner is not locked out by their own sign-ins.
pub struct FailureLimiter {
    max_failures: u32,
    window: Duration,
    pairs: Mutex<Windows<(String, IpAddr)>>,
    accounts: Mutex<Windows<String>>,
}

impl FailureLimiter {
    pub fn new(max_failures: u32, window: Duration, capacity: usize) -> Self {
        Self {
            max_failures: max_failures.max(1),
            window,
            pairs: Mutex::new(Windows::new(capacity)),
            accounts: Mutex::new(Windows::new(capacity)),
        }
    }

    /// Whether `email` must be refused from `ip` before its credential is checked; also true for
    /// an untracked key while a map is full.
    pub fn is_blocked(&self, email: &str, ip: IpAddr, now: Instant) -> bool {
        let account_cap = self.max_failures.saturating_mul(ACCOUNT_WIDE_FACTOR);
        let account = match lock(&self.accounts).window(email.to_owned(), now, self.window) {
            Some(w) => w.count >= account_cap,
            None => true,
        };
        account
            || match lock(&self.pairs).window((email.to_owned(), ip), now, self.window) {
                Some(w) => w.count >= self.max_failures,
                None => true,
            }
    }

    pub fn record_failure(&self, email: &str, ip: IpAddr, now: Instant) {
        if let Some(w) = lock(&self.accounts).window(email.to_owned(), now, self.window) {
            w.count = w.count.saturating_add(1);
        }
        if let Some(w) = lock(&self.pairs).window((email.to_owned(), ip), now, self.window) {
            w.count = w.count.saturating_add(1);
        }
    }

    pub fn reset(&self, email: &str, ip: IpAddr) {
        lock(&self.accounts).map.remove(email);
        lock(&self.pairs).map.remove(&(email.to_owned(), ip));
    }
}

/// Lock a limiter's state, recovering it after a panic elsewhere: the counters stay usable, and
/// one panicking request must not turn every later one into a panic.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
/// The process-wide failure counter: `AUTH_ACCOUNT_FAILURE_MAX` (default 10) per
/// `AUTH_ACCOUNT_FAILURE_WINDOW_SECS` (default 900) per email and client IP, and
/// [`ACCOUNT_WIDE_FACTOR`] times that per email. Process-wide because the account, not the route,
/// is protected.
/// account, not the route, is protected.
pub fn account_failures() -> &'static FailureLimiter {
    static LIMITER: OnceLock<FailureLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| {
        FailureLimiter::new(
            env_number("AUTH_ACCOUNT_FAILURE_MAX", 10).unwrap_or(10),
            Duration::from_secs(env_number("AUTH_ACCOUNT_FAILURE_WINDOW_SECS", 900).unwrap_or(900)),
            MAX_TRACKED_KEYS,
        )
    })
}

/// `TRUSTED_PROXY_HOPS` (default 1, at least 1): reverse proxies in front that append to
/// `X-Forwarded-For`.
fn trusted_proxy_hops() -> usize {
    static HOPS: OnceLock<usize> = OnceLock::new();
    *HOPS.get_or_init(|| env_number("TRUSTED_PROXY_HOPS", 1).unwrap_or(1).max(1))
}

/// The client IP to rate-limit by: the forwarded address when `trust_forwarded`, else the peer
/// IP, else an unspecified-address fallback (one shared bucket when `ConnectInfo` is missing).
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trust_forwarded: bool) -> IpAddr {
    client_ip_behind(headers, peer, trust_forwarded.then(trusted_proxy_hops))
}

/// [`client_ip`] with the trusted hop count explicit (`None` = trust no forwarded header).
fn client_ip_behind(
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
    trusted_hops: Option<usize>,
) -> IpAddr {
    if let Some(hops) = trusted_hops {
        if let Some(ip) = forwarded_ip(headers, hops) {
            return ip;
        }
    }
    peer.map(|p| p.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// The `X-Forwarded-For` entry `hops` from the right. With fewer entries than trusted hops the
/// header is not believed at all. `X-Real-IP` is the fallback when there is no
/// `X-Forwarded-For`.
fn forwarded_ip(headers: &HeaderMap, hops: usize) -> Option<IpAddr> {
    let forwarded: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .collect();
    if !forwarded.is_empty() {
        let index = forwarded.len().checked_sub(hops)?;
        return forwarded[index].parse().ok();
    }
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
}

/// State of the rate-limit middleware: the shared limiter plus the forwarded-header trust flag.
#[derive(Clone)]
pub struct RateLimitState {
    pub limiter: Arc<RateLimiter<IpAddr>>,
    pub trust_forwarded: bool,
}

impl RateLimitState {
    pub fn from_config(cfg: RateLimitConfig) -> Self {
        Self {
            limiter: Arc::new(RateLimiter::new(cfg.max_requests, cfg.window)),
            trust_forwarded: cfg.trust_forwarded,
        }
    }
}

/// The client IP [`enforce`] limited a request by, for handlers that key on it too.
#[derive(Debug, Clone, Copy)]
pub struct ClientIp(pub IpAddr);

impl ClientIp {
    /// The address from a request's extensions, or the unspecified address without one.
    pub fn of(ext: Option<axum::Extension<ClientIp>>) -> IpAddr {
        ext.map(|e| e.0 .0)
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
    }
}

/// Middleware enforcing the limiter per client IP (429 when over), and recording that IP as a
/// [`ClientIp`] extension. Auth sub-router only; `ConnectInfo` is optional so a request without
/// peer info degrades gracefully.
pub async fn enforce(
    State(rl): State<RateLimitState>,
    mut req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Read from the extensions: axum 0.8's `Option<ConnectInfo<_>>` extractor no longer exists.
    let peer = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0);
    let ip = client_ip(req.headers(), peer, rl.trust_forwarded);
    if !rl.limiter.check(ip, Instant::now()) {
        return AppError::TooManyRequests.into_response();
    }
    req.extensions_mut().insert(ClientIp(ip));
    next.run(req).await
}

/// State for the per-user limiter on the sync surface. The middleware verifies the token itself
/// with the JWT secret rather than trusting a claim.
#[derive(Clone)]
pub struct UserRateLimitState {
    limiter: Arc<RateLimiter<Uuid>>,
    jwt_secret: Arc<Vec<u8>>,
}

impl UserRateLimitState {
    /// Build from a limit config (`SYNC_RATE_LIMIT_*`; the forwarded-header flag is ignored for
    /// a per-user key) and the application config supplying the JWT secret.
    pub fn from_config(cfg: RateLimitConfig, config: &crate::config::Config) -> Self {
        Self {
            limiter: Arc::new(RateLimiter::new(cfg.max_requests, cfg.window)),
            jwt_secret: Arc::new(config.jwt_secret.clone()),
        }
    }
}

/// The verified user id a request is attributable to. `None` (no token, malformed, bad
/// signature) passes through so the handlers' own auth rejects it.
fn request_subject(headers: &HeaderMap, secret: &[u8]) -> Option<Uuid> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))?;
    token::verify_access_token(token, secret)
        .ok()
        .map(|c| c.sub)
}

/// Middleware enforcing the limiter per authenticated user (429 when over). Sync sub-router only.
pub async fn enforce_per_user(
    State(rl): State<UserRateLimitState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if let Some(user) = request_subject(req.headers(), &rl.jwt_secret) {
        if !rl.limiter.check(user, Instant::now()) {
            return AppError::TooManyRequests.into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, n))
    }

    #[test]
    fn allows_up_to_the_limit_then_blocks() {
        let rl = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.check(ip(1), t0));
        assert!(rl.check(ip(1), t0));
        assert!(rl.check(ip(1), t0));
        assert!(
            !rl.check(ip(1), t0),
            "the 4th request in the window is blocked"
        );
    }

    #[test]
    fn window_resets_after_it_elapses() {
        let rl = RateLimiter::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.check(ip(1), t0));
        assert!(rl.check(ip(1), t0));
        assert!(!rl.check(ip(1), t0));
        let later = t0 + Duration::from_secs(61);
        assert!(rl.check(ip(1), later));
    }

    #[test]
    fn counts_are_per_ip() {
        let rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.check(ip(1), t0));
        assert!(!rl.check(ip(1), t0));
        assert!(rl.check(ip(2), t0));
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", value.parse().unwrap());
        h
    }

    fn peer() -> Option<SocketAddr> {
        Some(SocketAddr::from(([127, 0, 0, 1], 5000)))
    }

    fn addr(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn behind_one_proxy_the_rightmost_forwarded_entry_is_the_client() {
        let h = forwarded("1.1.1.1, 203.0.113.9");
        assert_eq!(client_ip_behind(&h, peer(), Some(1)), addr("203.0.113.9"));
    }

    #[test]
    fn each_trusted_hop_moves_one_entry_left() {
        let h = forwarded("1.1.1.1, 198.51.100.7, 10.0.0.1");
        assert_eq!(client_ip_behind(&h, peer(), Some(2)), addr("198.51.100.7"));
        let mut split = forwarded("1.1.1.1, 198.51.100.7");
        split.append("x-forwarded-for", "10.0.0.1".parse().unwrap());
        assert_eq!(
            client_ip_behind(&split, peer(), Some(2)),
            addr("198.51.100.7")
        );
    }

    #[test]
    fn a_forwarded_header_shorter_than_the_proxy_chain_is_not_believed() {
        let h = forwarded("203.0.113.9");
        assert_eq!(client_ip_behind(&h, peer(), Some(2)), addr("127.0.0.1"));
        let garbage = forwarded("not-an-ip");
        assert_eq!(
            client_ip_behind(&garbage, peer(), Some(1)),
            addr("127.0.0.1")
        );
    }

    #[test]
    fn x_real_ip_is_the_fallback_without_forwarded_for() {
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "203.0.113.9".parse().unwrap());
        assert_eq!(client_ip_behind(&h, peer(), Some(1)), addr("203.0.113.9"));
    }

    #[test]
    fn client_ip_ignores_forwarded_when_untrusted() {
        let h = forwarded("203.0.113.9");
        assert_eq!(
            client_ip(&h, peer(), false),
            addr("127.0.0.1"),
            "an untrusted forwarded header must not override the peer IP"
        );
    }

    #[test]
    fn malformed_rate_limit_settings_fail_validation_by_name() {
        let vars = |k: &str, v: &str| vec![(k.to_owned(), v.to_owned())];
        assert!(validate_env(vars("AUTH_RATE_LIMIT_MAX", " 50 ")).is_ok());
        assert!(validate_env(vars("SYNC_READ_RATE_LIMIT_WINDOW_SECS", "")).is_ok());
        assert!(validate_env(vars("UNRELATED", "whatever")).is_ok());
        for (key, value) in [
            ("AUTH_RATE_LIMIT_TRUST_FORWARDED", "ture"),
            ("REPORT_RATE_LIMIT_MAX", "ten"),
            ("SYNC_RATE_LIMIT_WINDOW_SECS", "-1"),
            ("TRUSTED_PROXY_HOPS", "one"),
            ("AUTH_ACCOUNT_FAILURE_MAX", "1e3"),
        ] {
            let err = validate_env(vars(key, value)).unwrap_err();
            assert!(err.contains(key), "{err}");
        }
    }

    #[test]
    fn forwarded_headers_are_not_trusted_unless_configured() {
        assert!(!trust_forwarded_from(None));
        assert!(!trust_forwarded_from(Some(String::new())));
        assert!(trust_forwarded_from(Some("true".into())));
        assert!(trust_forwarded_from(Some("yes".into())));
        assert!(!trust_forwarded_from(Some("0".into())));
    }

    #[test]
    fn client_ip_falls_back_without_peer_or_header() {
        let h = HeaderMap::new();
        assert_eq!(client_ip(&h, None, true), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }

    #[test]
    fn a_full_limiter_refuses_new_keys_until_windows_expire() {
        let rl = RateLimiter::with_capacity(5, Duration::from_secs(60), 2);
        let t0 = Instant::now();
        assert!(rl.check(ip(1), t0));
        assert!(rl.check(ip(2), t0));
        assert!(!rl.check(ip(3), t0), "a third key does not fit");
        assert!(rl.check(ip(1), t0), "known keys keep working");
        let later = t0 + Duration::from_secs(61);
        assert!(rl.check(ip(3), later), "expired windows make room");
    }

    #[test]
    fn expired_windows_are_swept_periodically_not_per_check() {
        let rl = RateLimiter::with_capacity(1_000_000, Duration::from_secs(60), 10_000);
        let t0 = Instant::now();
        for n in 0..100u8 {
            rl.check(ip(n), t0);
        }
        let len = || rl.state.lock().unwrap().map.len();
        let later = t0 + Duration::from_secs(61);
        rl.check(ip(200), later);
        assert_eq!(len(), 101, "one check does not sweep the map");
        for _ in 0..PRUNE_EVERY {
            rl.check(ip(200), later);
        }
        assert_eq!(len(), 1, "the periodic sweep dropped the expired windows");
    }

    #[test]
    fn failures_block_one_account_until_success_or_the_window_ends() {
        let limiter = FailureLimiter::new(3, Duration::from_secs(900), 100);
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(!limiter.is_blocked("a@example.com", ip(1), t0));
            limiter.record_failure("a@example.com", ip(1), t0);
        }
        assert!(limiter.is_blocked("a@example.com", ip(1), t0));
        assert!(
            !limiter.is_blocked("b@example.com", ip(1), t0),
            "per account"
        );
        assert!(!limiter.is_blocked("a@example.com", ip(1), t0 + Duration::from_secs(901)));

        limiter.record_failure("b@example.com", ip(1), t0);
        limiter.record_failure("b@example.com", ip(1), t0);
        limiter.reset("b@example.com", ip(1));
        limiter.record_failure("b@example.com", ip(1), t0);
        assert!(
            !limiter.is_blocked("b@example.com", ip(1), t0),
            "a success clears the count"
        );
    }

    #[test]
    fn one_address_cannot_lock_the_owner_out_but_many_addresses_hit_the_account_cap() {
        let limiter = FailureLimiter::new(3, Duration::from_secs(900), 100);
        let t0 = Instant::now();
        for _ in 0..3 {
            limiter.record_failure("a@example.com", ip(1), t0);
        }
        assert!(limiter.is_blocked("a@example.com", ip(1), t0));
        assert!(
            !limiter.is_blocked("a@example.com", ip(2), t0),
            "the owner's address"
        );

        // Spread over addresses, the account closes at ACCOUNT_WIDE_FACTOR times the cap.
        for n in 0..(3 * ACCOUNT_WIDE_FACTOR - 3) {
            limiter.record_failure("a@example.com", ip(10 + n as u8), t0);
        }
        assert!(limiter.is_blocked("a@example.com", ip(2), t0));
    }

    #[test]
    fn a_full_failure_limiter_fails_closed() {
        let limiter = FailureLimiter::new(3, Duration::from_secs(900), 1);
        let t0 = Instant::now();
        limiter.record_failure("a@example.com", ip(1), t0);
        assert!(limiter.is_blocked("b@example.com", ip(1), t0));
        assert!(!limiter.is_blocked("a@example.com", ip(1), t0));
    }

    fn user(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn per_user_limiter_counts_each_user_separately() {
        let rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(rl.check(user(1), t0));
        assert!(
            !rl.check(user(1), t0),
            "the same user's 2nd request is blocked"
        );
        assert!(
            rl.check(user(2), t0),
            "a different user has their own budget"
        );
    }

    #[test]
    fn request_subject_verifies_the_bearer_token() {
        let secret = b"test-secret-at-least-32-bytes-long!!";
        let uid = Uuid::now_v7();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let jwt = token::issue_access_token(uid, Uuid::now_v7(), 900, secret, now).unwrap();

        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {jwt}").parse().unwrap());
        assert_eq!(request_subject(&h, secret), Some(uid));

        // A garbage or missing token is not attributable: the limiter lets it through and the
        // handlers' own auth rejects it.
        assert_eq!(request_subject(&HeaderMap::new(), secret), None);
        let mut bad = HeaderMap::new();
        bad.insert("authorization", "Bearer nope".parse().unwrap());
        assert_eq!(request_subject(&bad, secret), None);
        // A token signed with a different secret must not be keyed as its claimed user.
        assert_eq!(
            request_subject(&bad_h(jwt), b"another-secret-at-least-32-bytes!"),
            None
        );
    }

    fn bad_h(jwt: String) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {jwt}").parse().unwrap());
        h
    }
}
