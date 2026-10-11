//! Runtime configuration, loaded from the environment.

use std::fmt;

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
        };
        // Only fires when a caller hands us an enabled config with no root at all.
        if cfg.attachments_enabled && cfg.blob_dir.is_none() {
            return Err("BLOB_DIR is required when ATTACHMENTS_ENABLED is set".into());
        }
        // An S3 store that cannot be built (a malformed endpoint, say) fails here, not later.
        crate::attachments::BlobStore::from_config(&cfg)?;
        Ok(cfg)
    }
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
