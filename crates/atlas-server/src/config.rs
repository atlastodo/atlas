//! Runtime configuration, loaded from the environment.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr};

/// The default cap on a single `/sync/push` request body: 2 MiB, the ceiling axum applied
/// implicitly. Larger batches are rejected with `413`.
pub const DEFAULT_MAX_PUSH_BYTES: usize = 2 * 1024 * 1024;

/// The default refresh-token retention window: dead rows still answer "was this token ever
/// issued?", the reuse-detection signal, so they are kept this long before purging.
pub const DEFAULT_REFRESH_TOKEN_RETENTION_DAYS: i64 = 30;

/// The default op-log retention window in days. Fresh devices fold `GET /sync/snapshot` instead
/// of replaying `since=0`, so purging old history is safe. `0` disables.
pub const DEFAULT_OP_RETENTION_DAYS: i64 = 30;

/// The default fs blob-store root (`BLOB_DIR`), matching the Docker `/app` layout.
pub const DEFAULT_BLOB_DIR: &str = "/app/data/blobs";

/// The default cap on blob transfers in progress at once, across all users (`MAX_BLOB_TRANSFERS`).
/// Transfers stream in small chunks, so it bounds open files and disk bandwidth, not memory.
pub const DEFAULT_MAX_BLOB_TRANSFERS: usize = 16;

/// The default size of the PostgreSQL connection pool (`DB_MAX_CONNECTIONS`).
pub const DEFAULT_DB_MAX_CONNECTIONS: u32 = 10;

/// `DB_MAX_CONNECTIONS`, at least 1. Read apart from [`Config`] (only the server's own pool uses
/// it), but checked by [`Config::from_env`] like every other number.
pub fn db_max_connections() -> Result<u32, String> {
    Ok(env_number("DB_MAX_CONNECTIONS", DEFAULT_DB_MAX_CONNECTIONS)?.max(1))
}

/// The default listen address: every IPv4 interface, which the container needs to be reachable.
pub const DEFAULT_BIND_ADDR: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

/// `BIND_ADDR`, the address the listener binds (any IPv4 or IPv6 address, e.g. `127.0.0.1` or
/// `::`). Read apart from [`Config`] like [`db_max_connections`], and checked by
/// [`Config::from_env`] too.
pub fn bind_addr() -> Result<IpAddr, String> {
    env_value("BIND_ADDR").map_or(Ok(DEFAULT_BIND_ADDR), |v| parse_bind_addr(&v))
}

/// Parse `BIND_ADDR`: a bare IP address, surrounding whitespace ignored. Host names and a port
/// are refused (the port is `PORT`), so a typo fails at startup instead of binding elsewhere.
fn parse_bind_addr(raw: &str) -> Result<IpAddr, String> {
    raw.trim().parse().map_err(|_| {
        format!(
            "BIND_ADDR must be an IP address such as 0.0.0.0, 127.0.0.1 or :: (got {:?})",
            raw.trim()
        )
    })
}

/// Placeholder JWT secrets that must never reach production (they make access tokens forgeable).
const KNOWN_WEAK_JWT_SECRETS: &[&str] = &[
    "change-me-please-32-bytes-minimum",
    "change-me",
    "changeme",
    "secret",
    "your-secret-here",
];

/// Blob store backend for attachments ([`Config::blob_backend`], `BLOB_BACKEND` env).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobBackend {
    /// Sharded content-addressed directories under `BLOB_DIR` (see `attachments::FsBlobStore`).
    Fs,
    /// An S3 or S3-compatible bucket (`S3_BUCKET`), keys under `S3_PREFIX` (see
    /// `attachments::ObjectBlobStore`). Uploads are staged under `BLOB_DIR`. Credentials, region
    /// and endpoint come from the standard `AWS_*` variables.
    S3 { bucket: String, prefix: String },
}

/// Runtime configuration. Cloneable and cheap to share via [`crate::state::AppState`].
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: Vec<u8>,
    pub access_ttl_seconds: i64,
    pub refresh_ttl_seconds: i64,
    pub port: u16,
    /// Emails that should hold the `users.is_admin` flag (`ADMIN_EMAILS`); the column is the
    /// source of truth, this list is what startup applies.
    pub admin_emails: Vec<String>,
    /// Whether `POST /auth/signup` accepts new accounts (`SIGNUP_ENABLED`, default true).
    pub signup_enabled: bool,
    /// Whether the anonymous `POST /reports` endpoint is mounted (`BUG_REPORTS_ENABLED`, default true).
    pub bug_reports_enabled: bool,
    /// Days of sync-operation history to keep (`OP_RETENTION_DAYS`, default 30). 0 or negative
    /// disables the purge. A client whose cursor predates it gets `410 cursor_expired` (see
    /// `retention.rs`).
    pub op_retention_days: i64,
    /// Cap on a `/sync/push` body in bytes (`MAX_PUSH_BYTES`, default
    /// [`DEFAULT_MAX_PUSH_BYTES`]); larger answers `413`. Values below 1 are floored to 1.
    pub max_push_bytes: usize,
    /// Days an expired or revoked `refresh_tokens` row is kept (`REFRESH_TOKEN_RETENTION_DAYS`,
    /// default [`DEFAULT_REFRESH_TOKEN_RETENTION_DAYS`]). On by default; 0 or negative disables.
    pub refresh_token_retention_days: i64,
    /// Optional directory containing static assets (e.g. the exported web SPA) to serve.
    pub static_dir: Option<std::path::PathBuf>,
    /// Whether `/attachments/*` is mounted (`ATTACHMENTS_ENABLED`, default true). When false the
    /// API fallback answers a JSON 404.
    pub attachments_enabled: bool,
    /// Which blob store backend to use (`BLOB_BACKEND`: `fs`, the default, or `s3`).
    pub blob_backend: BlobBackend,
    /// Root of the on-disk CAS (`BLOB_DIR`, default `/app/data/blobs`); created by the store.
    /// With `s3` it only holds uploads in flight.
    pub blob_dir: Option<std::path::PathBuf>,
    /// Largest accepted blob in bytes (`MAX_BLOB_BYTES`, default 25 MiB); larger answers 413.
    pub max_blob_bytes: usize,
    /// Per-uploader total stored bytes (`BLOB_QUOTA_BYTES`, default 1 GiB), enforced at PUT.
    pub blob_quota_bytes: u64,
    /// Days an unreferenced blob is kept before the GC frees it (`BLOB_GC_GRACE_DAYS`, default
    /// 30); never less than `OP_RETENTION_DAYS`. 0 disables the GC.
    pub blob_gc_grace_days: i64,
    /// Blob transfers in progress at once (`MAX_BLOB_TRANSFERS`, default
    /// [`DEFAULT_MAX_BLOB_TRANSFERS`]); one more answers `503`. Values below 1 are floored to 1.
    pub max_blob_transfers: usize,
    /// The bundled apps this instance offers (`ATLAS_APPS`, comma-separated, default
    /// [`DEFAULT_APPS`]), checked against the manifests compiled in (`atlas_core::manifest`).
    /// Sync refuses and hides the kinds of every other app.
    pub apps: Vec<String>,
    /// Passkey sign-in and unlock (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `WEBAUTHN_RP_NAME`);
    /// `None`, the default, leaves every `/auth/passkeys` route off.
    pub passkeys: Option<PasskeyConfig>,
    /// The Android app `/.well-known/assetlinks.json` vouches for (`ANDROID_APP_PACKAGE`,
    /// `ANDROID_APP_CERT_SHA256`), which Credential Manager needs before the app may use this
    /// domain's passkeys. `None` serves no file.
    pub android_asset_links: Option<AndroidAssetLinks>,
}

/// The WebAuthn relying party passkeys belong to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasskeyConfig {
    /// The RP ID: the domain passkeys are bound to (`WEBAUTHN_RP_ID`, e.g. `todo.example.com`).
    /// Every web origin must be this domain or a subdomain of it.
    pub rp_id: String,
    /// Shown by the authenticator next to the passkey (`WEBAUTHN_RP_NAME`, default `Atlas Todo`).
    pub rp_name: String,
    /// Exact origins a ceremony may come from (`WEBAUTHN_ORIGINS`, comma-separated, default
    /// `https://<rp id>`), plus `android:apk-key-hash:` origins of [`AndroidAssetLinks`].
    pub origins: Vec<String>,
}

/// The Android app allowed to use this domain's passkeys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AndroidAssetLinks {
    pub package: String,
    /// Signing certificate SHA-256 fingerprints, `AA:BB:…` uppercase.
    pub cert_fingerprints: Vec<String>,
}

impl AndroidAssetLinks {
    /// The WebAuthn origins Android reports for the app: `android:apk-key-hash:` and the
    /// unpadded base64url of each certificate's SHA-256.
    pub fn origins(&self) -> Vec<String> {
        use base64::Engine;
        self.cert_fingerprints
            .iter()
            .filter_map(|fp| hex::decode(fp.replace(':', "")).ok())
            .map(|bytes| {
                format!(
                    "android:apk-key-hash:{}",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
                )
            })
            .collect()
    }
}

/// Parse the passkey settings. Unset `WEBAUTHN_RP_ID` turns passkeys off (and the other two are
/// then ignored). The RP ID is a bare lowercase domain; each origin is `https://host[:port]`
/// whose host is the RP ID or under it, `http://localhost[:port]` for development, or an
/// `android:apk-key-hash:` origin. A typo fails startup instead of every ceremony.
pub fn parse_passkeys(
    rp_id: Option<String>,
    origins: Option<String>,
    rp_name: Option<String>,
    android: Option<&AndroidAssetLinks>,
) -> Result<Option<PasskeyConfig>, String> {
    let Some(rp_id) = rp_id else {
        return Ok(None);
    };
    let rp_id = rp_id.trim().to_ascii_lowercase();
    let domain_ok = !rp_id.is_empty()
        && rp_id.len() <= 253
        && rp_id
            .split('.')
            .all(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    if !domain_ok {
        return Err(format!(
            "WEBAUTHN_RP_ID must be a bare domain such as todo.example.com (got {rp_id:?})"
        ));
    }
    let raw = origins.unwrap_or_else(|| format!("https://{rp_id}"));
    let mut list: Vec<String> = Vec::new();
    for origin in raw.split(',') {
        let origin = origin.trim().trim_end_matches('/').to_owned();
        if origin.is_empty() || list.contains(&origin) {
            continue;
        }
        if !origin_allowed(&origin, &rp_id) {
            return Err(format!(
                "WEBAUTHN_ORIGINS: {origin:?} is not https://{rp_id} (or a subdomain), \
                 http://localhost or an android:apk-key-hash: origin"
            ));
        }
        list.push(origin);
    }
    for origin in android.map(AndroidAssetLinks::origins).unwrap_or_default() {
        if !list.contains(&origin) {
            list.push(origin);
        }
    }
    if list.is_empty() {
        return Err("WEBAUTHN_ORIGINS must name at least one origin".into());
    }
    Ok(Some(PasskeyConfig {
        rp_id,
        rp_name: rp_name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Atlas Todo".into()),
        origins: list,
    }))
}

fn origin_allowed(origin: &str, rp_id: &str) -> bool {
    if let Some(hash) = origin.strip_prefix("android:apk-key-hash:") {
        return !hash.is_empty()
            && hash
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    }
    let (scheme, rest) = match origin.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    let host = match rest.rsplit_once(':') {
        Some((host, port)) if port.parse::<u16>().is_ok() => host,
        Some(_) => return false,
        None => rest,
    };
    if host.contains('/') {
        return false;
    }
    match scheme {
        "https" => host == rp_id || host.ends_with(&format!(".{rp_id}")),
        "http" => host == "localhost" && rp_id == "localhost",
        _ => false,
    }
}

/// Parse `ANDROID_APP_PACKAGE` and `ANDROID_APP_CERT_SHA256` (comma-separated SHA-256
/// fingerprints, with or without colons). Both or neither.
pub fn parse_asset_links(
    package: Option<String>,
    fingerprints: Option<String>,
) -> Result<Option<AndroidAssetLinks>, String> {
    let (package, fingerprints) = match (package, fingerprints) {
        (None, None) => return Ok(None),
        (Some(p), Some(f)) => (p.trim().to_owned(), f),
        _ => {
            return Err(
                "ANDROID_APP_PACKAGE and ANDROID_APP_CERT_SHA256 must be set together".into(),
            )
        }
    };
    let package_ok = package.split('.').count() >= 2
        && package.split('.').all(|seg| {
            seg.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        });
    if !package_ok {
        return Err(format!(
            "ANDROID_APP_PACKAGE must be an Android package name (got {package:?})"
        ));
    }
    let mut cert_fingerprints = Vec::new();
    for fp in fingerprints.split(',') {
        let hex_only: String = fp.trim().chars().filter(|c| *c != ':').collect();
        if hex_only.is_empty() {
            continue;
        }
        if hex_only.len() != 64 || hex::decode(&hex_only).is_err() {
            return Err(format!(
                "ANDROID_APP_CERT_SHA256 entries must be SHA-256 fingerprints (got {:?})",
                fp.trim()
            ));
        }
        let upper = hex_only.to_ascii_uppercase();
        let colons: Vec<&str> = (0..32).map(|i| &upper[i * 2..i * 2 + 2]).collect();
        cert_fingerprints.push(colons.join(":"));
    }
    if cert_fingerprints.is_empty() {
        return Err("ANDROID_APP_CERT_SHA256 must name at least one fingerprint".into());
    }
    Ok(Some(AndroidAssetLinks {
        package,
        cert_fingerprints,
    }))
}

// Manual `Debug` that never prints the JWT secret or the database URL (it carries the password).
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("database_url", &"<redacted>")
            .field("jwt_secret", &"<redacted>")
            .field("access_ttl_seconds", &self.access_ttl_seconds)
            .field("refresh_ttl_seconds", &self.refresh_ttl_seconds)
            .field("port", &self.port)
            .field("op_retention_days", &self.op_retention_days)
            .field("max_push_bytes", &self.max_push_bytes)
            .field(
                "refresh_token_retention_days",
                &self.refresh_token_retention_days,
            )
            .field("admin_emails", &self.admin_emails)
            .field("static_dir", &self.static_dir)
            .field("attachments_enabled", &self.attachments_enabled)
            .field("blob_backend", &self.blob_backend)
            .field("blob_dir", &self.blob_dir)
            .field("max_blob_bytes", &self.max_blob_bytes)
            .field("blob_quota_bytes", &self.blob_quota_bytes)
            .field("blob_gc_grace_days", &self.blob_gc_grace_days)
            .field("max_blob_transfers", &self.max_blob_transfers)
            .field("apps", &self.apps)
            .field("passkeys", &self.passkeys)
            .field("android_asset_links", &self.android_asset_links)
            .finish()
    }
}

impl Config {
    /// Build config from environment variables. `DATABASE_URL` and `JWT_SECRET` are required.
    ///
    /// Parsing is strict: a set but unparseable flag or number is a startup error naming the
    /// variable (`SIGNUP_ENABLED=ture` must not leave a public instance open). Empty values count
    /// as unset. The rate-limit knobs are checked here too ([`crate::ratelimit::validate_env`]).
    pub fn from_env() -> Result<Self, String> {
        let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
        let jwt_secret = std::env::var("JWT_SECRET").map_err(|_| "JWT_SECRET is required")?;
        validate_jwt_secret(&jwt_secret)?;
        db_max_connections()?;
        bind_addr()?;
        crate::ratelimit::validate_env(
            std::env::vars_os()
                .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
        )?;
        let cfg = Self {
            database_url,
            jwt_secret: jwt_secret.into_bytes(),
            access_ttl_seconds: env_number("ACCESS_TOKEN_TTL_SECONDS", 900)?,
            refresh_ttl_seconds: env_number("REFRESH_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 30)?,
            port: env_number("PORT", 8080)?,
            admin_emails: parse_admin_emails(std::env::var("ADMIN_EMAILS").ok()),
            signup_enabled: env_bool("SIGNUP_ENABLED", true)?,
            bug_reports_enabled: env_bool("BUG_REPORTS_ENABLED", true)?,
            op_retention_days: env_number("OP_RETENTION_DAYS", DEFAULT_OP_RETENTION_DAYS)?,
            max_push_bytes: env_number("MAX_PUSH_BYTES", DEFAULT_MAX_PUSH_BYTES)?.max(1),
            refresh_token_retention_days: env_number(
                "REFRESH_TOKEN_RETENTION_DAYS",
                DEFAULT_REFRESH_TOKEN_RETENTION_DAYS,
            )?,
            static_dir: env_value("STATIC_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    let default_path = std::path::PathBuf::from("/app/dist");
                    if default_path.is_dir() {
                        Some(default_path)
                    } else {
                        None
                    }
                }),
            attachments_enabled: env_bool("ATTACHMENTS_ENABLED", true)?,
            blob_backend: parse_blob_backend(
                env_value("BLOB_BACKEND"),
                env_value("S3_BUCKET"),
                env_value("S3_PREFIX"),
            )?,
            blob_dir: env_value("BLOB_DIR")
                .map(std::path::PathBuf::from)
                .or_else(|| Some(std::path::PathBuf::from(DEFAULT_BLOB_DIR))),
            max_blob_bytes: env_number("MAX_BLOB_BYTES", 25 * 1024 * 1024)?,
            blob_quota_bytes: env_number("BLOB_QUOTA_BYTES", 1024 * 1024 * 1024)?,
            blob_gc_grace_days: env_number("BLOB_GC_GRACE_DAYS", 30)?,
            max_blob_transfers: env_number("MAX_BLOB_TRANSFERS", DEFAULT_MAX_BLOB_TRANSFERS)?
                .max(1),
            apps: parse_apps(env_value("ATLAS_APPS").as_deref())?,
            passkeys: None,
            android_asset_links: parse_asset_links(
                env_value("ANDROID_APP_PACKAGE"),
                env_value("ANDROID_APP_CERT_SHA256"),
            )?,
        };
        let mut cfg = cfg;
        cfg.passkeys = parse_passkeys(
            env_value("WEBAUTHN_RP_ID"),
            env_value("WEBAUTHN_ORIGINS"),
            env_value("WEBAUTHN_RP_NAME"),
            cfg.android_asset_links.as_ref(),
        )?;
        // Only fires when a caller hands us an enabled config with no root at all.
        if cfg.attachments_enabled && cfg.blob_dir.is_none() {
            return Err("BLOB_DIR is required when ATTACHMENTS_ENABLED is set".into());
        }
        // An S3 store that cannot be built (a malformed endpoint, say) fails here, not later.
        crate::attachments::BlobStore::from_config(&cfg)?;
        Ok(cfg)
    }
}

/// The apps an instance offers when `ATLAS_APPS` is unset.
pub const DEFAULT_APPS: &str = "todo";

/// Parse `ATLAS_APPS` (comma-separated app ids; unset or empty is [`DEFAULT_APPS`]): trimmed,
/// lowercased, deduplicated, and each one a manifest bundled in this build. An id the build does
/// not bundle is a startup error, so a typo cannot silently turn an app off.
pub fn parse_apps(raw: Option<&str>) -> Result<Vec<String>, String> {
    let registry = atlas_core::Registry::bundled();
    let mut apps: Vec<String> = Vec::new();
    for id in raw.unwrap_or(DEFAULT_APPS).split(',') {
        let id = id.trim().to_ascii_lowercase();
        if id.is_empty() || apps.contains(&id) {
            continue;
        }
        if registry.app(&id).is_none() {
            let known: Vec<&str> = registry.apps().iter().map(|a| a.app.as_str()).collect();
            return Err(format!(
                "ATLAS_APPS names {id:?}, which this server does not bundle (it bundles: {})",
                known.join(", ")
            ));
        }
        apps.push(id);
    }
    if apps.is_empty() {
        return Err("ATLAS_APPS must name at least one app".into());
    }
    Ok(apps)
}

/// Parse `ADMIN_EMAILS` (comma-separated) into trimmed, lowercased addresses with empties
/// dropped (matching the `CITEXT` email column). Split out so it is testable without mutating
/// process-global env.
fn parse_admin_emails(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Validate a `JWT_SECRET`: at least 32 bytes and not a known placeholder.
fn validate_jwt_secret(secret: &str) -> Result<(), String> {
    if secret.len() < 32 {
        return Err("JWT_SECRET must be at least 32 bytes".into());
    }
    if KNOWN_WEAK_JWT_SECRETS
        .iter()
        .any(|weak| secret.eq_ignore_ascii_case(weak))
    {
        return Err(
            "JWT_SECRET is a known placeholder value; set a real secret (openssl rand -hex 32)"
                .into(),
        );
    }
    Ok(())
}

/// Parse a boolean setting: `1/0`, `true/false`, `yes/no`, `on/off` in any case; else an error naming `key`.
pub fn parse_bool(key: &str, raw: &str) -> Result<bool, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!(
            "{key} must be one of 1/0, true/false, yes/no, on/off (got {other:?})"
        )),
    }
}

/// Parse a numeric setting, surrounding whitespace ignored. Anything else is an error naming `key`.
pub fn parse_number<T: std::str::FromStr>(key: &str, raw: &str) -> Result<T, String> {
    raw.trim()
        .parse()
        .map_err(|_| format!("{key} must be a number (got {:?})", raw.trim()))
}

/// The value of `key`, or `None` when unset or empty.
pub fn env_value(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// A boolean env setting (see [`parse_bool`]); `default` when unset or empty.
pub fn env_bool(key: &str, default: bool) -> Result<bool, String> {
    env_value(key).map_or(Ok(default), |v| parse_bool(key, &v))
}

/// A numeric env setting (see [`parse_number`]); `default` when unset or empty.
pub fn env_number<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String> {
    env_value(key).map_or(Ok(default), |v| parse_number(key, &v))
}

/// Parse `BLOB_BACKEND` (unset is `fs`). `s3` needs `S3_BUCKET`; `S3_PREFIX` is optional.
fn parse_blob_backend(
    raw: Option<String>,
    bucket: Option<String>,
    prefix: Option<String>,
) -> Result<BlobBackend, String> {
    match raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        None | Some("fs") => Ok(BlobBackend::Fs),
        Some("s3") => {
            let bucket = bucket
                .map(|b| b.trim().to_owned())
                .filter(|b| !b.is_empty())
                .ok_or("BLOB_BACKEND=s3 needs S3_BUCKET")?;
            Ok(BlobBackend::S3 {
                bucket,
                prefix: prefix.unwrap_or_default().trim().to_owned(),
            })
        }
        Some(other) => Err(format!("unknown BLOB_BACKEND: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_secret_and_db_url() {
        let cfg = Config {
            database_url: "postgres://user:hunter2@host/db".into(),
            jwt_secret: b"super-secret-jwt-value-32-bytes-x!".to_vec(),
            access_ttl_seconds: 900,
            refresh_ttl_seconds: 3600,
            port: 8080,
            admin_emails: Vec::new(),
            signup_enabled: true,
            bug_reports_enabled: true,
            op_retention_days: 0,
            max_push_bytes: DEFAULT_MAX_PUSH_BYTES,
            refresh_token_retention_days: DEFAULT_REFRESH_TOKEN_RETENTION_DAYS,
            static_dir: None,
            attachments_enabled: false,
            blob_backend: BlobBackend::Fs,
            blob_dir: None,
            max_blob_bytes: 25 * 1024 * 1024,
            blob_quota_bytes: 1024 * 1024 * 1024,
            blob_gc_grace_days: 7,
            max_blob_transfers: 16,
            apps: vec!["todo".into()],
            passkeys: None,
            android_asset_links: None,
        };
        let rendered = format!("{cfg:?}");
        assert!(!rendered.contains("hunter2"), "db password must not print");
        assert!(
            !rendered.contains("super-secret"),
            "jwt secret must not print"
        );
        assert!(rendered.contains("<redacted>"));
        assert!(rendered.contains("8080"), "non-secret fields still print");
    }

    #[test]
    fn rejects_short_and_placeholder_jwt_secrets() {
        assert!(validate_jwt_secret("too-short").is_err());
        assert!(
            validate_jwt_secret("change-me-please-32-bytes-minimum").is_err(),
            "the .env.example placeholder must be rejected"
        );
        assert!(
            validate_jwt_secret("CHANGE-ME-PLEASE-32-BYTES-MINIMUM").is_err(),
            "placeholder match is case-insensitive"
        );
        assert!(validate_jwt_secret("f3a1c9e07b5d24689a1c0ffee1234567").is_ok());
    }

    #[test]
    fn parses_and_normalizes_admin_emails() {
        assert_eq!(
            parse_admin_emails(Some(" Admin@Example.com , second@example.com ".into())),
            vec!["admin@example.com", "second@example.com"],
            "entries are trimmed and lowercased to match the CITEXT email column"
        );
    }

    #[test]
    fn admin_emails_unset_or_blank_is_empty() {
        // A missing or blank env var must never parse into a one-element list containing "".
        assert!(parse_admin_emails(None).is_empty());
        assert!(parse_admin_emails(Some(String::new())).is_empty());
        assert!(parse_admin_emails(Some("  ,  ,".into())).is_empty());
    }

    #[test]
    fn env_bool_falls_back_to_default_when_unset() {
        // Unset keeps the caller's default; parsing is covered by `parse_bool` tests.
        assert_eq!(env_bool("ATLAS_TEST_ENV_BOOL", true), Ok(true));
        assert_eq!(env_bool("ATLAS_TEST_ENV_BOOL", false), Ok(false));
        assert_eq!(env_number("ATLAS_TEST_ENV_NUMBER", 7u16), Ok(7));
    }

    #[test]
    fn booleans_accept_the_usual_spellings_and_nothing_else() {
        for yes in ["1", "true", "TRUE", " yes ", "On"] {
            assert_eq!(parse_bool("FLAG", yes), Ok(true), "{yes:?}");
        }
        for no in ["0", "false", "No", "off\n"] {
            assert_eq!(parse_bool("FLAG", no), Ok(false), "{no:?}");
        }
        for bad in ["ture", "2", "enabled", ""] {
            let err = parse_bool("SIGNUP_ENABLED", bad).unwrap_err();
            assert!(err.contains("SIGNUP_ENABLED"), "{err}");
        }
    }

    #[test]
    fn numbers_are_trimmed_and_otherwise_strict() {
        assert_eq!(parse_number::<u16>("PORT", " 8081 "), Ok(8081));
        assert_eq!(parse_number::<i64>("OP_RETENTION_DAYS", "-1"), Ok(-1));
        assert!(parse_number::<u16>("PORT", "80a")
            .unwrap_err()
            .contains("PORT"));
        assert!(
            parse_number::<u16>("PORT", "70000").is_err(),
            "out of range"
        );
        assert!(parse_number::<usize>("MAX_PUSH_BYTES", "2MB").is_err());
    }

    #[test]
    fn bind_addr_takes_any_ip_and_nothing_else() {
        assert_eq!(
            parse_bind_addr(" 127.0.0.1 "),
            Ok(IpAddr::from([127, 0, 0, 1]))
        );
        assert_eq!(parse_bind_addr("0.0.0.0"), Ok(DEFAULT_BIND_ADDR));
        for v6 in ["::", "::1", "fd00::7"] {
            assert_eq!(parse_bind_addr(v6), Ok(v6.parse().unwrap()), "{v6:?}");
        }
        for bad in ["localhost", "0.0.0.0:8080", "[::1]", "256.0.0.1", "*"] {
            let err = parse_bind_addr(bad).unwrap_err();
            assert!(err.contains("BIND_ADDR"), "{err}");
        }
    }

    #[test]
    fn apps_default_to_todo_and_must_be_bundled() {
        assert_eq!(parse_apps(None), Ok(vec!["todo".to_string()]));
        assert_eq!(parse_apps(Some(" TODO , todo,")), Ok(vec!["todo".into()]));
        let err = parse_apps(Some("todo,notes")).unwrap_err();
        assert!(err.contains("ATLAS_APPS") && err.contains("notes"), "{err}");
        assert!(err.contains("bundles: todo"), "{err}");
        assert!(parse_apps(Some(" , "))
            .unwrap_err()
            .contains("at least one"));
    }

    #[test]
    fn passkeys_are_off_without_an_rp_id_and_origins_default_to_it() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(
            parse_passkeys(None, s("https://x.example"), None, None),
            Ok(None)
        );
        let cfg = parse_passkeys(s(" Todo.Example.com "), None, None, None)
            .unwrap()
            .unwrap();
        assert_eq!(cfg.rp_id, "todo.example.com");
        assert_eq!(cfg.rp_name, "Atlas Todo");
        assert_eq!(cfg.origins, vec!["https://todo.example.com"]);
    }

    #[test]
    fn passkey_origins_must_belong_to_the_rp_id() {
        let s = |v: &str| Some(v.to_owned());
        let cfg = parse_passkeys(
            s("example.com"),
            s("https://example.com/, https://app.example.com:8443,android:apk-key-hash:AbC-_1"),
            s("My Atlas"),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            cfg.origins,
            vec![
                "https://example.com",
                "https://app.example.com:8443",
                "android:apk-key-hash:AbC-_1"
            ]
        );
        assert_eq!(cfg.rp_name, "My Atlas");
        for bad in [
            "https://evil.com",
            "http://example.com",
            "https://notexample.com",
            "https://example.com/path",
            "ftp://example.com",
            "android:apk-key-hash:",
        ] {
            let err = parse_passkeys(s("example.com"), s(bad), None, None).unwrap_err();
            assert!(err.contains("WEBAUTHN_ORIGINS"), "{bad}: {err}");
        }
        assert!(parse_passkeys(s("https://example.com"), None, None, None)
            .unwrap_err()
            .contains("WEBAUTHN_RP_ID"));
        // Local development: RP ID localhost over plain http.
        let local = parse_passkeys(s("localhost"), s("http://localhost:8081"), None, None)
            .unwrap()
            .unwrap();
        assert_eq!(local.origins, vec!["http://localhost:8081"]);
    }

    #[test]
    fn asset_links_need_both_settings_and_add_android_origins() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(parse_asset_links(None, None), Ok(None));
        assert!(parse_asset_links(s("dev.example.app"), None).is_err());
        assert!(parse_asset_links(s("not a package"), s(&"ab".repeat(32))).is_err());
        assert!(parse_asset_links(s("dev.example.app"), s("AB:CD")).is_err());
        let fp = "fa:c6:17:45:dc:09:03:78:6f:b9:ed:e6:2a:96:2b:39:9f:73:48:f0:bb:6f:89:9b:83:32:66:75:91:03:3b:9c";
        let links = parse_asset_links(s("dev.example.app"), s(fp))
            .unwrap()
            .unwrap();
        assert_eq!(links.cert_fingerprints, vec![fp.to_ascii_uppercase()]);
        // The same fingerprint without colons, as `keytool` prints neither way consistently.
        let bare = parse_asset_links(s("dev.example.app"), s(&fp.replace(':', "")))
            .unwrap()
            .unwrap();
        assert_eq!(bare, links);
        assert_eq!(
            links.origins(),
            vec!["android:apk-key-hash:-sYXRdwJA3hvue3mKpYrOZ9zSPC7b4mbgzJmdZEDO5w"]
        );
        let cfg = parse_passkeys(s("example.com"), None, None, Some(&links))
            .unwrap()
            .unwrap();
        assert_eq!(cfg.origins.len(), 2);
        assert!(cfg.origins[1].starts_with("android:apk-key-hash:"));
    }

    #[test]
    fn blob_backends_parse_and_s3_needs_a_bucket() {
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(parse_blob_backend(None, None, None), Ok(BlobBackend::Fs));
        assert_eq!(
            parse_blob_backend(s(" FS "), None, None),
            Ok(BlobBackend::Fs)
        );
        assert_eq!(
            parse_blob_backend(s("s3"), s(" atlas "), s("blobs/")),
            Ok(BlobBackend::S3 {
                bucket: "atlas".into(),
                prefix: "blobs/".into()
            })
        );
        assert!(parse_blob_backend(s("s3"), None, None)
            .unwrap_err()
            .contains("S3_BUCKET"));
        assert!(parse_blob_backend(s("s3"), s(" "), None).is_err());
        assert!(parse_blob_backend(s("gcs"), None, None).is_err());
    }
}
