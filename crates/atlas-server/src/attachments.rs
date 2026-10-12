//! Attachments: the out-of-band binary transport for task attachments.
//!
//! Metadata syncs through the op log (`EntityKind::Attachment`); this module serves
//! `PUT/GET /attachments/blobs/:sha256` over a content-addressed store (files under `BLOB_DIR`
//! or an S3 bucket). The server only ever sees AES-GCM ciphertext and verifies its sha256.
//! Downloads are authorized by a live attachment reference in the caller's partition; uploads
//! are bounded by size cap, quota and rate limit. Blob formats and the full auth model are in
//! `docs/architecture.md`.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, put, MethodRouter};
use axum::{Extension, Json, Router};
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt, WriteMultipart};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::ratelimit::{self, UserRateLimitState};
use crate::state::AppState;

pub use crate::config::BlobBackend;

/// How often the enabled blob-GC task runs; the first pass fires at startup.
const GC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60 * 60 * 6);

/// Blobs GC'd per pass, so a large backlog drains over several passes.
const GC_BATCH: i64 = 10_000;

/// Upper bound on a sensible grace window, keeping the SQL day parameter in range.
const MAX_GRACE_DAYS: i32 = 36_500;

/// Class id of the per-uploader advisory lock serializing a quota check with the write it admits.
const QUOTA_LOCK_CLASS: i32 = 0x6174_6271;

/// Temp and registry-less blob files younger than this may belong to a PUT in flight.
const ORPHAN_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Bytes per read of a download, and the write buffer of an upload.
const IO_CHUNK: usize = 64 * 1024;

/// Parts of an object-store upload in flight at once.
const UPLOAD_PARTS_IN_FLIGHT: usize = 2;

/// `Retry-After` seconds for a refused transfer.
const TRANSFER_RETRY_AFTER_SECS: u64 = 5;

/// The global cap on blob bodies in flight, shared by uploads and downloads. A slot is held
/// until the body is stored, fully sent, or the client goes away.
#[derive(Clone)]
pub struct TransferSlots(Arc<Semaphore>);

impl TransferSlots {
    pub fn new(max: usize) -> Self {
        Self(Arc::new(Semaphore::new(max.max(1))))
    }

    /// Take a slot, or refuse at once with 503: waiting would let slow clients hold other
    /// requests open.
    fn acquire(&self) -> AppResult<OwnedSemaphorePermit> {
        self.0
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::Busy(TRANSFER_RETRY_AFTER_SECS))
    }
}

/// The blob routes when attachments are enabled. Uploads and downloads have separate per-user
/// budgets so one cannot starve the other.
pub fn routes(
    upload_rl: UserRateLimitState,
    download_rl: UserRateLimitState,
    max_transfers: usize,
) -> Router<AppState> {
    let upload: MethodRouter<AppState> = put(put_blob).layer(axum::middleware::from_fn_with_state(
        upload_rl,
        ratelimit::enforce_per_user,
    ));
    let download = get(get_blob).layer(axum::middleware::from_fn_with_state(
        download_rl,
        ratelimit::enforce_per_user,
    ));
    Router::new()
        .route(
            "/attachments/blobs/{sha256}",
            upload
                .merge(download)
                .layer(Extension(TransferSlots::new(max_transfers))),
        )
        .route("/attachments/config", get(attachment_config))
        .route("/attachments/{*rest}", any(unknown_attachment_route))
}

/// The routes when attachments are disabled: every `/attachments/*` path answers a JSON 404
/// (otherwise a PUT got a 405 that clients retried forever and a GET got `index.html`).
pub fn disabled_routes() -> Router<AppState> {
    Router::new()
        .route("/attachments/config", get(attachment_config))
        .route("/attachments/{*rest}", any(attachments_disabled))
}

/// `GET /attachments/config`: whether attachments are stored and the largest accepted blob.
async fn attachment_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let enabled = state.blobs.is_some();
    Json(serde_json::json!({
        "enabled": enabled,
        "max_blob_bytes": if enabled { state.config.max_blob_bytes } else { 0 },
    }))
}

async fn attachments_disabled() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "attachments are disabled on this server" })),
    )
}

async fn unknown_attachment_route() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "not found" })),
    )
}

/// Validate a path segment as an exact sha256 digest: 64 lowercase hex chars, so no traversal.
pub fn validate_sha256(sha: &str) -> AppResult<String> {
    let bytes = sha.as_bytes();
    if bytes.len() != 64 || !bytes.iter().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest(
            "sha256 must be 64 hex characters".into(),
        ));
    }
    Ok(sha.to_ascii_lowercase())
}

/// Filesystem store under `BLOB_DIR`, sharded two hex chars deep. Keys are validated hex, so
/// nothing attacker-controlled reaches a path position.
#[derive(Clone)]
pub struct FsBlobStore {
    root: std::path::PathBuf,
}

/// Object storage (`BLOB_BACKEND=s3`) with the same sharding as [`FsBlobStore`]. Uploads are
/// staged in `staging` (`BLOB_DIR`) and only a complete, verified body is written to its key.
#[derive(Clone)]
pub struct ObjectBlobStore {
    store: Arc<dyn ObjectStore>,
    /// Empty, or ending in `/`.
    prefix: String,
    staging: std::path::PathBuf,
}

/// Where blobs live: on disk or in an object store.
#[derive(Clone)]
pub enum BlobStore {
    Fs(FsBlobStore),
    Object(ObjectBlobStore),
}

impl From<FsBlobStore> for BlobStore {
    fn from(store: FsBlobStore) -> Self {
        Self::Fs(store)
    }
}

impl From<ObjectBlobStore> for BlobStore {
    fn from(store: ObjectBlobStore) -> Self {
        Self::Object(store)
    }
}

/// Outcome of a `PUT`; an existing blob is accepted idempotently.
pub enum PutOutcome {
    /// Already present; nothing was written.
    Existing,
    /// Written and its registry row inserted (or raced in).
    Stored,
}

/// A stored blob's bytes as a body stream.
type BlobStream = futures_util::stream::BoxStream<'static, std::io::Result<Bytes>>;

impl FsBlobStore {
    pub fn new(root: std::path::PathBuf) -> Self {
        Self { root }
    }

    /// The shard path for a validated sha: `root/ab/abcdef…`.
    fn path_for(&self, sha: &str) -> std::path::PathBuf {
        self.root.join(&sha[..2]).join(sha)
    }
}

impl ObjectBlobStore {
    /// A store over `store`, with keys under `prefix` (slashes at either end are dropped) and
    /// uploads staged in `staging`.
    pub fn new(store: Arc<dyn ObjectStore>, prefix: &str, staging: std::path::PathBuf) -> Self {
        let prefix = prefix.trim_matches('/');
        Self {
            store,
            prefix: if prefix.is_empty() {
                String::new()
            } else {
                format!("{prefix}/")
            },
            staging,
        }
    }

    /// An S3 (or compatible) bucket. Credentials, region and endpoint come from the standard
    /// `AWS_*` environment variables.
    pub fn s3(bucket: &str, prefix: &str, staging: std::path::PathBuf) -> Result<Self, String> {
        let s3 = AmazonS3Builder::from_env()
            .with_bucket_name(bucket)
            .build()
            .map_err(|e| format!("S3 blob store: {e}"))?;
        Ok(Self::new(Arc::new(s3), prefix, staging))
    }

    /// The object key of a validated sha: `prefix/ab/abcdef…`.
    fn key(&self, sha: &str) -> ObjectPath {
        ObjectPath::from(format!("{}{}/{sha}", self.prefix, &sha[..2]))
    }

    /// Upload the staged file at `tmp` to `sha`'s key in parts, bounding memory.
    async fn upload(&self, tmp: &std::path::Path, sha: &str) -> AppResult<()> {
        let mut upload = WriteMultipart::new(self.store.put_multipart(&self.key(sha)).await?);
        let mut file = tokio::fs::File::open(tmp).await?;
        let mut buf = vec![0u8; IO_CHUNK];
        let written = async {
            loop {
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    return Ok::<_, AppError>(());
                }
                upload.wait_for_capacity(UPLOAD_PARTS_IN_FLIGHT).await?;
                upload.write(&buf[..n]);
            }
        }
        .await;
        match written {
            Ok(()) => {
                upload.finish().await?;
                Ok(())
            }
            Err(e) => {
                let _ = upload.abort().await;
                Err(e)
            }
        }
    }
}

impl BlobStore {
    /// The store the config names, or `None` when attachments are off.
    pub fn from_config(config: &crate::config::Config) -> Result<Option<Self>, String> {
        if !config.attachments_enabled {
            return Ok(None);
        }
        let Some(dir) = config.blob_dir.clone() else {
            return Ok(None);
        };
        Ok(Some(match &config.blob_backend {
            BlobBackend::Fs => FsBlobStore::new(dir).into(),
            BlobBackend::S3 { bucket, prefix } => ObjectBlobStore::s3(bucket, prefix, dir)?.into(),
        }))
    }

    /// Where an upload body is staged: beside its address on disk (atomic rename), or in the
    /// staging directory of an object store.
    fn staging_dir(&self, sha: &str) -> std::path::PathBuf {
        match self {
            Self::Fs(fs) => fs.root.join(&sha[..2]),
            Self::Object(object) => object.staging.clone(),
        }
    }

    /// Write `bytes` to this blob's address without the registry, for maintenance tools and
    /// tests. A body that does not hash to `sha` is refused (409).
    pub async fn write_streaming(&self, sha: &str, bytes: &[u8]) -> AppResult<()> {
        let body = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(
            Bytes::copy_from_slice(bytes),
        )]);
        let staged = self.stage(sha, body, usize::MAX).await?;
        let committed = self.commit(&staged, sha).await;
        let _ = tokio::fs::remove_file(&staged.tmp).await;
        committed
    }

    /// Stream `body` into a fresh temp file, hashing and counting on the way. Stops with 413
    /// over `max_bytes`, 409 on a hash mismatch, 400 if the body breaks off; the temp file is
    /// removed then. On success the caller commits or removes it. A partial blob never reaches
    /// the address.
    async fn stage<S, E>(&self, sha: &str, body: S, max_bytes: usize) -> AppResult<StagedBlob>
    where
        S: Stream<Item = Result<Bytes, E>>,
        E: std::fmt::Display,
    {
        let dir = self.staging_dir(sha);
        tokio::fs::create_dir_all(&dir).await?;
        let tmp = dir.join(format!(".tmp-{sha}-{}", Uuid::now_v7()));
        match write_body(&tmp, sha, body, max_bytes).await {
            Ok(size) => Ok(StagedBlob { tmp, size }),
            Err(e) => {
                // Do not leave the partial temp file behind.
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// Put a staged, verified body at `sha`'s address.
    async fn commit(&self, staged: &StagedBlob, sha: &str) -> AppResult<()> {
        match self {
            Self::Fs(fs) => Ok(tokio::fs::rename(&staged.tmp, fs.path_for(sha)).await?),
            Self::Object(object) => object.upload(&staged.tmp, sha).await,
        }
    }

    async fn exists(&self, sha: &str) -> AppResult<bool> {
        match self {
            Self::Fs(fs) => Ok(tokio::fs::try_exists(fs.path_for(sha)).await?),
            Self::Object(object) => match object.store.head(&object.key(sha)).await {
                Ok(_) => Ok(true),
                Err(object_store::Error::NotFound { .. }) => Ok(false),
                Err(e) => Err(e.into()),
            },
        }
    }

    /// Open a stored blob for streaming, with its size. 404 when it is not stored.
    pub async fn open(&self, sha: &str) -> AppResult<(BlobStream, u64)> {
        match self {
            Self::Fs(fs) => {
                let file =
                    tokio::fs::File::open(fs.path_for(sha))
                        .await
                        .map_err(|e| match e.kind() {
                            std::io::ErrorKind::NotFound => AppError::NotFound,
                            _ => AppError::Filesystem(e),
                        })?;
                let size = file.metadata().await?.len();
                Ok((file_stream(file).boxed(), size))
            }
            Self::Object(object) => {
                let got = object
                    .store
                    .get(&object.key(sha))
                    .await
                    .map_err(|e| match e {
                        object_store::Error::NotFound { .. } => AppError::NotFound,
                        e => e.into(),
                    })?;
                let size = got.meta.size;
                let body = got
                    .into_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other));
                Ok((body.boxed(), size))
            }
        }
    }

    /// Read a blob whole, for maintenance tools and tests.
    pub async fn read(&self, sha: &str) -> AppResult<Vec<u8>> {
        let (mut body, _) = self.open(sha).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            bytes.extend_from_slice(&chunk.map_err(|_| AppError::Internal)?);
        }
        Ok(bytes)
    }

    /// Delete a stored blob; whether it was there, where the store can tell.
    pub async fn remove(&self, sha: &str) -> AppResult<bool> {
        match self {
            Self::Fs(fs) => match tokio::fs::remove_file(fs.path_for(sha)).await {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(_) => Err(AppError::Internal),
            },
            // Deleting a missing object succeeds, so a head first tells the two apart.
            Self::Object(object) => {
                if !self.exists(sha).await? {
                    return Ok(false);
                }
                object.store.delete(&object.key(sha)).await?;
                Ok(true)
            }
        }
    }

    /// Store the streamed `body` addressed at `sha` for `uploader`, keeping the `blobs` row in sync.
    ///
    /// Checks run so abuse is rejected earliest and nothing unverified is kept: sha validation,
    /// streaming under the size cap with hashing, idempotency, per-uploader quota, commit, row
    /// insert. Everything after staging runs under a per-uploader advisory lock so concurrent
    /// PUTs cannot together overshoot the quota; the body streams before the lock is taken.
    pub async fn put<S, E>(
        &self,
        pool: &sqlx::PgPool,
        uploader: Uuid,
        sha: &str,
        body: S,
        max_blob_bytes: usize,
        quota_bytes: u64,
    ) -> AppResult<PutOutcome>
    where
        S: Stream<Item = Result<Bytes, E>>,
        E: std::fmt::Display,
    {
        let sha = validate_sha256(sha)?;
        // The address must hash to its content. An existing blob is accepted only after the body
        // verified against the named sha; different bytes for the same address answer 409.
        let staged = self.stage(&sha, body, max_blob_bytes).await?;
        let outcome = self.admit(pool, uploader, &sha, &staged, quota_bytes).await;
        let _ = tokio::fs::remove_file(&staged.tmp).await;
        outcome
    }

    /// The locked part of [`BlobStore::put`].
    async fn admit(
        &self,
        pool: &sqlx::PgPool,
        uploader: Uuid,
        sha: &str,
        staged: &StagedBlob,
        quota_bytes: u64,
    ) -> AppResult<PutOutcome> {
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1, hashtext($2::text))")
            .bind(QUOTA_LOCK_CLASS)
            .bind(uploader)
            .execute(&mut *tx)
            .await?;
        let existing_row: Option<Uuid> =
            sqlx::query_scalar("SELECT uploader_id FROM blobs WHERE sha256 = $1")
                .bind(sha)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(owner) = existing_row {
            if self.exists(sha).await? {
                if owner == uploader {
                    // Restart the grace clock so the GC cannot free the blob before an offline
                    // device publishes its metadata.
                    sqlx::query(
                        "UPDATE blobs SET created_at = now(), unreferenced_since = NULL
                          WHERE sha256 = $1",
                    )
                    .bind(sha)
                    .execute(&mut *tx)
                    .await?;
                    bind_blobs(&mut tx, uploader, &[], &[], &[sha.to_owned()]).await?;
                }
                tx.commit().await?;
                return Ok(PutOutcome::Existing);
            }
        }
        // The quota counts the ROW total, so the idempotent path above must pass first.
        // SUM(bigint) is NUMERIC in Postgres; the decode needs an explicit ::bigint.
        let used: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(size), 0)::bigint FROM blobs WHERE uploader_id = $1",
        )
        .bind(uploader)
        .fetch_one(&mut *tx)
        .await?;
        let size = i64::try_from(staged.size).unwrap_or(i64::MAX);
        if used.saturating_add(size) > i64::try_from(quota_bytes).unwrap_or(i64::MAX) {
            return Err(AppError::PayloadTooLarge);
        }
        self.commit(staged, sha).await?;
        sqlx::query(
            "INSERT INTO blobs (sha256, size, uploader_id) VALUES ($1, $2, $3)
             ON CONFLICT (sha256) DO NOTHING",
        )
        .bind(sha)
        .bind(size)
        .bind(uploader)
        .execute(&mut *tx)
        .await?;
        // Metadata may have been pushed before this upload finished; bind to it now.
        bind_blobs(&mut tx, uploader, &[], &[], &[sha.to_owned()]).await?;
        tx.commit().await?;
        Ok(PutOutcome::Stored)
    }
}

/// A complete, verified upload body in a temp file.
struct StagedBlob {
    tmp: std::path::PathBuf,
    size: u64,
}

/// Write `body` to `tmp`, hashing and counting as it goes. Returns the body's size.
async fn write_body<S, E>(
    tmp: &std::path::Path,
    sha: &str,
    body: S,
    max_bytes: usize,
) -> AppResult<u64>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::fmt::Display,
{
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut file =
        tokio::io::BufWriter::with_capacity(IO_CHUNK, tokio::fs::File::create(tmp).await?);
    let mut body = std::pin::pin!(body);
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| AppError::BadRequest(format!("upload body failed: {e}")))?;
        size += chunk.len() as u64;
        if size > max_bytes as u64 {
            return Err(AppError::PayloadTooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let digest = hex(&hasher.finalize());
    if digest != sha {
        // Never commit a mismatched body: a later GET would serve bytes the address does not promise.
        return Err(AppError::Conflict(format!(
            "sha256 mismatch: path names {sha}, body hashes to {digest}"
        )));
    }
    Ok(size)
}

/// A file as a stream of [`IO_CHUNK`]-sized pieces.
fn file_stream(file: tokio::fs::File) -> impl Stream<Item = std::io::Result<Bytes>> {
    futures_util::stream::unfold(Some(file), |state| async move {
        let mut file = state?;
        let mut buf = vec![0u8; IO_CHUNK];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), Some(file)))
            }
            Err(e) => Some((Err(e), None)),
        }
    })
}

/// A download body that holds its transfer slot until the stream ends or is dropped.
fn slotted(
    body: BlobStream,
    slot: OwnedSemaphorePermit,
) -> impl Stream<Item = std::io::Result<Bytes>> {
    body.map(move |chunk| {
        let _ = &slot;
        chunk
    })
}

/// The request's declared `Content-Length`, when it has a valid one.
fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `PUT /attachments/blobs/:sha256`: store a ciphertext blob addressed by the sha256 of the
/// exact bytes sent. The uploader is the authenticated caller.
///
/// A declared `Content-Length` over the cap is refused before a slot is taken; a body without
/// one is counted as it streams.
async fn put_blob(
    State(state): State<AppState>,
    Extension(slots): Extension<TransferSlots>,
    Path(sha): Path<String>,
    user: AuthUser,
    headers: HeaderMap,
    body: Body,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    let sha = validate_sha256(&sha)?;
    let store = blob_store(&state)?;
    let max = state.config.max_blob_bytes;
    if content_length(&headers).is_some_and(|len| len > max as u64) {
        return Err(AppError::PayloadTooLarge);
    }
    let _slot = slots.acquire()?;
    let outcome = store
        .put(
            &state.pool,
            user.user_id,
            &sha,
            body.into_data_stream(),
            max,
            state.config.blob_quota_bytes,
        )
        .await?;
    let stored = matches!(outcome, PutOutcome::Stored);
    tracing::debug!(sha = %sha, existing = !stored, "blob put");
    Ok((
        if stored {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(serde_json::json!({ "sha256": sha })),
    ))
}

/// `GET /attachments/blobs/:sha256`: fetch a stored ciphertext blob, authorized only by a live
/// attachment op naming it in the caller's partition that counts for the blob.
///
/// 403 for every failure (removed member, deleted attachment, forged reference, outsider), so
/// nothing about who else can see the blob leaks. 404 when a live reference exists but the blob
/// is not stored; clients retry lazily.
async fn get_blob(
    State(state): State<AppState>,
    Extension(slots): Extension<TransferSlots>,
    Path(sha): Path<String>,
    user: AuthUser,
) -> AppResult<Response> {
    let sha = validate_sha256(&sha)?;
    let sql = "SELECT b.sha256 IS NOT NULL, (b.sha256 IS NOT NULL AND ".to_owned()
        + COUNTING_REFERENCE
        + ")
           FROM entity_fields f LEFT JOIN blobs b ON b.sha256 = (f.value #>> '{}')
          WHERE f.user_id = $1 AND f.entity = 'attachment' AND f.field IN ('blob_sha', 'thumb_sha')
            AND (f.value #>> '{}') = $2
            AND "
        + LIVE_ATTACHMENT_PREDICATE;
    let refs: Vec<(bool, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(user.user_id)
        .bind(&sha)
        .fetch_all(&state.pool)
        .await?;
    let stored = refs.iter().any(|(stored, _)| *stored);
    let authorized = refs.iter().any(|(_, counts)| *counts);
    tracing::debug!(sha = %sha, authorized, "blob download authz");
    if !refs.is_empty() && !stored {
        return Err(AppError::NotFound);
    }
    if !authorized {
        return Err(AppError::Forbidden(
            "no live attachment references this blob in your account".into(),
        ));
    }
    let store = blob_store(&state)?;
    let slot = slots.acquire()?;
    let (body, size) = store.open(&sha).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(slotted(body, slot)),
    )
        .into_response())
}

/// The configured store; errors if attachments are disabled (defense in depth, the routes are
/// not mounted then).
fn blob_store(state: &AppState) -> AppResult<&BlobStore> {
    state.blobs.as_ref().ok_or(AppError::NotFound)
}

/// A text SQL expression cast to uuid, or NULL when it is not one. A bare `::uuid` cast would
/// fail every download and GC pass on the first malformed stored value.
macro_rules! uuid_or_null {
    ($text:literal) => {
        concat!(
            "(CASE WHEN ",
            $text,
            " ~* '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$' THEN (",
            $text,
            ")::uuid END)"
        )
    };
}

/// SQL fragment checking that the attachment entity aliased `f` is live in its partition (per
/// `(user_id, entity_id)`, like the LWW fold in `sync/apply.rs`).
///
/// Live means no tombstone, or a field with an HLC newer than the tombstone's. Data-plane SQL
/// only: it never touches `__enc`/`__aenc` markers.
pub(crate) const LIVE_ATTACHMENT_PREDICATE: &str = concat!(
    // The outer parens matter: the whole disjunction must sit under the project-revocation AND.
    "( (NOT EXISTS (",
    "  SELECT 1 FROM entity_tombstones t",
    "   WHERE t.user_id = f.user_id AND t.entity = 'attachment' AND t.entity_id = f.entity_id",
    ") OR EXISTS (",
    "  SELECT 1 FROM entity_fields g",
    "   WHERE g.user_id = f.user_id AND g.entity = 'attachment' AND g.entity_id = f.entity_id",
    "   AND EXISTS (",
    "     SELECT 1 FROM entity_tombstones t2",
    "      WHERE t2.user_id = g.user_id AND t2.entity = 'attachment' AND t2.entity_id = g.entity_id",
    "        AND (g.hlc_wall_ms, g.hlc_counter, g.hlc_node) > (t2.hlc_wall_ms, t2.hlc_counter, t2.hlc_node)",
    ")))",
    " )",
    // An attachment dies with its task; a task field written after the tombstone revives it.
    " AND NOT EXISTS (",
    "  SELECT 1 FROM entity_fields tl",
    "   JOIN entity_tombstones tt",
    "     ON tt.user_id = tl.user_id AND tt.entity = 'task'",
    "    AND tt.entity_id = ",
    uuid_or_null!("(tl.value #>> '{}')"),
    "   WHERE tl.user_id = f.user_id AND tl.entity = 'attachment'",
    "     AND tl.entity_id = f.entity_id AND tl.field = 'task_id'",
    "     AND NOT EXISTS (",
    "       SELECT 1 FROM entity_fields tf",
    "        WHERE tf.user_id = tt.user_id AND tf.entity = 'task' AND tf.entity_id = tt.entity_id",
    "          AND (tf.hlc_wall_ms, tf.hlc_counter, tf.hlc_node) > (tt.hlc_wall_ms, tt.hlc_counter, tt.hlc_node)",
    "     )",
    ")",
    // Member removal tombstones the member's whole copy of the project (`members.rs`), so an
    // attachment is also dead when its task's `project_id` names a project a tombstone hides;
    // a later project field (re-accepted invite) revives it. Orphaned chains (no project row,
    // or a non-uuid link) stay live so private data remains reachable.
    " AND NOT EXISTS (",
    "  SELECT 1 FROM entity_fields ta",
    "   JOIN entity_fields tp",
    "     ON tp.user_id = ta.user_id AND tp.entity = 'task'",
    "    AND tp.entity_id = ",
    uuid_or_null!("(ta.value #>> '{}')"),
    "    AND tp.field = 'project_id'",
    "   JOIN entity_tombstones pt",
    "     ON pt.user_id = tp.user_id AND pt.entity = 'project'",
    "    AND pt.entity_id = ",
    uuid_or_null!("(tp.value #>> '{}')"),
    "   WHERE ta.user_id = f.user_id AND ta.entity = 'attachment'",
    "     AND ta.entity_id = f.entity_id AND ta.field = 'task_id'",
    "     AND NOT EXISTS (",
    "       SELECT 1 FROM entity_fields pf",
    "        WHERE pf.user_id = pt.user_id AND pf.entity = 'project' AND pf.entity_id = pt.entity_id",
    "          AND (pf.hlc_wall_ms, pf.hlc_counter, pf.hlc_node) > (pt.hlc_wall_ms, pt.hlc_counter, pt.hlc_node)",
    "     )",
    ")"
);

/// SQL fragment checking that reference `f` counts for blob `b`: it sits in the partition of an
/// active member of the blob's project, or in the uploader's own partition while the project is
/// unshared or the blob is bound to none.
pub(crate) const COUNTING_REFERENCE: &str = concat!(
    "(EXISTS (",
    "  SELECT 1 FROM project_members bm",
    "   WHERE bm.project_id = b.project_id AND bm.user_id = f.user_id AND bm.state = 'active'",
    ") OR (f.user_id = b.uploader_id AND NOT EXISTS (",
    "  SELECT 1 FROM project_members bs WHERE bs.project_id = b.project_id",
    ")))"
);

/// `EXISTS` over the counting, live references to blob `b`, in any partition.
fn referenced_sql() -> String {
    "EXISTS (SELECT 1 FROM entity_fields f
              WHERE f.entity = 'attachment' AND f.field IN ('blob_sha', 'thumb_sha')
                AND (f.value #>> '{}') = b.sha256
                AND "
        .to_owned()
        + COUNTING_REFERENCE
        + " AND "
        + LIVE_ATTACHMENT_PREDICATE
        + ")"
}

/// Bind blobs to the project their attachments now live in, as `caller` sees it after a write.
///
/// Considers the caller's attachments in `attachment_ids`, those on `task_ids` (just moved),
/// and those naming one of `shas`. A blob is rebound only when the caller may already read it,
/// so a stranger's blob can never be handed to a project of the caller's choosing.
pub(crate) async fn bind_blobs(
    conn: &mut PgConnection,
    caller: Uuid,
    attachment_ids: &[Uuid],
    task_ids: &[Uuid],
    shas: &[String],
) -> AppResult<()> {
    let sql = concat!(
        "UPDATE blobs b SET project_id = src.project_id",
        "  FROM (",
        "    SELECT DISTINCT ON (r.value #>> '{}') r.value #>> '{}' AS sha, ",
        uuid_or_null!("(tp.value #>> '{}')"),
        " AS project_id",
        "      FROM entity_fields r",
        "      JOIN entity_fields tl",
        "        ON tl.user_id = r.user_id AND tl.entity = 'attachment'",
        "       AND tl.entity_id = r.entity_id AND tl.field = 'task_id'",
        "      LEFT JOIN entity_fields tp",
        "        ON tp.user_id = tl.user_id AND tp.entity = 'task' AND tp.field = 'project_id'",
        "       AND tp.entity_id = ",
        uuid_or_null!("(tl.value #>> '{}')"),
        "     WHERE r.user_id = $1 AND r.entity = 'attachment'",
        "       AND r.field IN ('blob_sha', 'thumb_sha')",
        "       AND (r.entity_id = ANY($2) OR (r.value #>> '{}') = ANY($4) OR ",
        uuid_or_null!("(tl.value #>> '{}')"),
        " = ANY($3))",
        "     ORDER BY r.value #>> '{}', r.hlc_wall_ms DESC, r.hlc_counter DESC, r.hlc_node DESC",
        "  ) src",
        " WHERE b.sha256 = src.sha",
        "   AND b.project_id IS DISTINCT FROM src.project_id",
        "   AND (b.uploader_id = $1 OR EXISTS (",
        "     SELECT 1 FROM project_members m",
        "      WHERE m.project_id = b.project_id AND m.user_id = $1 AND m.state = 'active'))"
    );
    sqlx::query(sql)
        .bind(caller)
        .bind(attachment_ids)
        .bind(task_ids)
        .bind(shas)
        .execute(conn)
        .await?;
    Ok(())
}

pub struct GcStats {
    pub blobs: u64,
    pub bytes: u64,
}

/// Free one bounded batch of blobs with no counting live reference across all partitions and an
/// expired grace window.
///
/// The reference check is partition-independent (it scans `entity_fields`/`entity_tombstones`),
/// so a blob referenced only in another member's partition survives. The grace runs from when a
/// pass first found the blob unreferenced (`unreferenced_since`) and the blob must also be older
/// than the window, so an admin restore or an offline device can still reach it.
///
/// Rows go first, files second: a crash can leak an orphan file ([`sweep_orphans`]) but never
/// delete bytes a row still advertises.
pub async fn gc_once(
    pool: &sqlx::PgPool,
    store: &BlobStore,
    grace_days: i64,
) -> AppResult<GcStats> {
    if grace_days <= 0 {
        return Ok(GcStats { blobs: 0, bytes: 0 });
    }
    let referenced = referenced_sql();
    sqlx::query(sqlx::AssertSqlSafe(
        "UPDATE blobs b SET unreferenced_since = NULL
            WHERE b.unreferenced_since IS NOT NULL AND "
            .to_owned()
            + &referenced,
    ))
    .execute(pool)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(
        "UPDATE blobs b SET unreferenced_since = now()
            WHERE b.unreferenced_since IS NULL AND NOT "
            .to_owned()
            + &referenced,
    ))
    .execute(pool)
    .await?;
    let gc_sql = "WITH dead AS (
       SELECT b.sha256 FROM blobs b
        WHERE b.unreferenced_since < now() - make_interval(days => $1)
          AND b.created_at < now() - make_interval(days => $1)
          AND NOT "
        .to_owned()
        + &referenced
        + "
        ORDER BY b.unreferenced_since
        LIMIT $2
      )
      DELETE FROM blobs WHERE sha256 IN (SELECT sha256 FROM dead)
      RETURNING sha256, size";
    let rows: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(gc_sql))
        .bind(grace_days.clamp(1, i64::from(MAX_GRACE_DAYS)) as i32)
        .bind(GC_BATCH)
        .fetch_all(pool)
        .await?;
    let mut freed_files = 0u64;
    let mut bytes = 0u64;
    for (sha, size) in &rows {
        match store.remove(sha).await {
            Ok(true) => {
                freed_files += 1;
                bytes += *size as u64;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(sha = %sha, error = %e, "blob GC could not delete file"),
        }
    }
    Ok(GcStats {
        blobs: freed_files,
        bytes,
    })
}

/// Delete what no registry row accounts for: temp files from failed writes and stored blobs
/// whose row is gone. Anything younger than [`ORPHAN_MIN_AGE`] is left alone. Returns how many
/// files or objects were removed.
pub async fn sweep_orphans(pool: &sqlx::PgPool, store: &BlobStore) -> AppResult<u64> {
    match store {
        BlobStore::Fs(fs) => sweep_fs_orphans(pool, fs).await,
        BlobStore::Object(object) => sweep_object_orphans(pool, object).await,
    }
}

async fn sweep_fs_orphans(pool: &sqlx::PgPool, store: &FsBlobStore) -> AppResult<u64> {
    let mut removed = 0u64;
    let mut shards = match tokio::fs::read_dir(&store.root).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    while let Some(shard) = shards.next_entry().await? {
        let shard_name = shard.file_name().to_string_lossy().into_owned();
        if shard_name.len() != 2 || !shard.file_type().await?.is_dir() {
            continue;
        }
        let mut candidates: Vec<(String, std::path::PathBuf)> = Vec::new();
        let mut files = tokio::fs::read_dir(shard.path()).await?;
        while let Some(file) = files.next_entry().await? {
            let meta = file.metadata().await?;
            if !meta.is_file() || !old_enough(&meta) {
                continue;
            }
            let name = file.file_name().to_string_lossy().into_owned();
            if name.starts_with(".tmp-") {
                if tokio::fs::remove_file(file.path()).await.is_ok() {
                    removed += 1;
                }
            } else if validate_sha256(&name).is_ok_and(|sha| sha == name) {
                candidates.push((name, file.path()));
            }
        }
        if candidates.is_empty() {
            continue;
        }
        let names: Vec<String> = candidates.iter().map(|(n, _)| n.clone()).collect();
        let known = known_shas(pool, &names).await?;
        for (name, path) in candidates {
            if !known.contains(&name) && tokio::fs::remove_file(&path).await.is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Objects are listed in pages of this many before their registry rows are looked up.
const ORPHAN_SWEEP_PAGE: usize = 1000;

async fn sweep_object_orphans(pool: &sqlx::PgPool, store: &ObjectBlobStore) -> AppResult<u64> {
    let mut removed = 0u64;
    match tokio::fs::read_dir(&store.staging).await {
        Ok(mut files) => {
            while let Some(file) = files.next_entry().await? {
                let meta = file.metadata().await?;
                let stale = meta.is_file() && old_enough(&meta);
                if stale
                    && file.file_name().to_string_lossy().starts_with(".tmp-")
                    && tokio::fs::remove_file(file.path()).await.is_ok()
                {
                    removed += 1;
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    // Anything else under the prefix is not ours to delete.
    let prefix = store.prefix.trim_end_matches('/');
    let prefix = (!prefix.is_empty()).then(|| ObjectPath::from(prefix));
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let min_age_ms = ORPHAN_MIN_AGE.as_millis() as i64;
    let mut listing = store.store.list(prefix.as_ref()).chunks(ORPHAN_SWEEP_PAGE);
    while let Some(page) = listing.next().await {
        let mut candidates: Vec<String> = Vec::new();
        for meta in page {
            let meta = meta?;
            let Some(name) = meta.location.filename() else {
                continue;
            };
            let is_blob = validate_sha256(name).is_ok_and(|sha| sha == name)
                && meta.location == store.key(name);
            if is_blob && now_ms - meta.last_modified.timestamp_millis() >= min_age_ms {
                candidates.push(name.to_owned());
            }
        }
        if candidates.is_empty() {
            continue;
        }
        let known = known_shas(pool, &candidates).await?;
        for sha in candidates.iter().filter(|sha| !known.contains(sha)) {
            if store.store.delete(&store.key(sha)).await.is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn old_enough(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|age| age >= ORPHAN_MIN_AGE)
}

/// Which of `shas` have a registry row.
async fn known_shas(pool: &sqlx::PgPool, shas: &[String]) -> AppResult<Vec<String>> {
    Ok(
        sqlx::query_scalar("SELECT sha256 FROM blobs WHERE sha256 = ANY($1)")
            .bind(shas)
            .fetch_all(pool)
            .await?,
    )
}

/// Remove the stored blobs whose rows an account purge just deleted.
pub async fn remove_files(store: &BlobStore, shas: &[String]) {
    for sha in shas {
        if let Err(e) = store.remove(sha).await {
            tracing::warn!(sha = %sha, error = %e, "could not delete blob");
        }
    }
}

/// The grace the GC applies: `BLOB_GC_GRACE_DAYS`, but never shorter than `OP_RETENTION_DAYS`,
/// since an admin restore can bring an attachment back until retention purges its tombstone.
/// Zero (or less) still disables the GC.
pub fn effective_grace_days(config: &crate::config::Config) -> i64 {
    if config.blob_gc_grace_days <= 0 {
        return config.blob_gc_grace_days;
    }
    config.blob_gc_grace_days.max(config.op_retention_days)
}

/// Start the periodic blob-GC task when attachments are enabled, or return `None`. Each pass
/// also sweeps orphaned files.
pub fn spawn_gc_if_enabled(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    let store = state.blobs.clone()?;
    let state = state.clone();
    Some(tokio::spawn(async move {
        let days = effective_grace_days(&state.config);
        tracing::info!(backend = ?state.config.blob_backend, blob_gc_grace_days = days, "blob GC task enabled");
        let mut interval = tokio::time::interval(GC_INTERVAL);
        loop {
            interval.tick().await;
            match sweep_orphans(&state.pool, &store).await {
                Ok(0) => {}
                Ok(files) => tracing::debug!(files, "blob sweep removed orphaned files"),
                Err(e) => tracing::warn!(error = %e, "blob orphan sweep failed"),
            }
            match gc_once(&state.pool, &store, days).await {
                Ok(stats) if stats.blobs > 0 => {
                    tracing::debug!(
                        blobs = stats.blobs,
                        bytes = stats.bytes,
                        "blob GC freed blobs"
                    );
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "blob GC pass failed"),
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs() -> FsBlobStore {
        FsBlobStore::new(std::env::temp_dir().join(format!("atlas_blob_test_{}", Uuid::now_v7())))
    }

    fn bytes_of(sha: &str) -> AppResult<()> {
        validate_sha256(sha).map(|_| ())
    }

    #[test]
    fn sha_validation_shape() {
        let good = "a".repeat(64);
        let mixed = format!("{}A", "a".repeat(63));
        assert!(bytes_of(&good).is_ok());
        assert!(bytes_of(&mixed).is_ok());
        assert!(bytes_of(&"a".repeat(63)).is_err(), "too short");
        assert!(bytes_of(&"a".repeat(65)).is_err(), "too long");
        assert!(bytes_of(&"g".repeat(64)).is_err(), "non-hex");
        assert!(bytes_of("../etc/passwd").is_err());
        assert!(bytes_of("").is_err());
    }

    #[tokio::test]
    async fn put_get_roundtrip_and_mismatch_are_byte_exact() {
        let fs = fs();
        let store = BlobStore::from(fs.clone());
        let content = b"not really encrypted, but the server must not care".to_vec();
        let sha = hex(&Sha256::digest(&content));
        store
            .write_streaming(&sha, &content)
            .await
            .expect("write ok");
        let read = store.read(&sha).await.expect("read ok");
        assert_eq!(read, content);
        let other = b"tampered".to_vec();
        let err = store.write_streaming(&sha, &other).await.unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "409 on mismatch");
        assert_eq!(store.read(&sha).await.unwrap(), content);
        let _ = tokio::fs::remove_dir_all(&fs.root).await;
    }

    #[tokio::test]
    async fn sharded_paths_live_under_the_root() {
        let store = fs();
        let content = b"x".to_vec();
        let sha = hex(&Sha256::digest(&content));
        BlobStore::from(store.clone())
            .write_streaming(&sha, &content)
            .await
            .unwrap();
        let path = store.path_for(&sha);
        assert!(path.starts_with(&store.root), "no escape from BLOB_DIR");
        assert_eq!(
            path.strip_prefix(&store.root).unwrap().components().count(),
            2
        );
        assert_eq!(store.root.join(&sha[..2]).join(&sha), path);
        let _ = tokio::fs::remove_dir_all(&store.root).await;
    }
}
