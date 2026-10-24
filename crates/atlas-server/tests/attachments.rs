//! Integration tests for attachments: blob transport, the `attachment` sync entity, download
//! authorization, size caps and quota, and blob GC.

use std::time::Duration;

use atlas_server::{
    app,
    attachments::{BlobStore, FsBlobStore},
    config::BlobBackend,
    config::Config,
    db,
    state::AppState,
};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use uuid::Uuid;

mod common;
use common::wire;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Blob content no earlier run has stored. The test database outlives a run, and a blob row
/// keeps its first uploader, so fixed content would belong to some earlier run's user.
fn unique(label: &str) -> Vec<u8> {
    format!("{label} {}", Uuid::now_v7()).into_bytes()
}

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

/// Attachment-enabled config: every test mounts the routes on a fresh temp BLOB_DIR so tests are
/// hermetic, with per-test size/quota caps injected via the parameters.
async fn make_state_enabled(
    max_blob_bytes: usize,
    quota_bytes: u64,
    grace_days: i64,
) -> (AppState, std::path::PathBuf) {
    make_state_with_transfers(max_blob_bytes, quota_bytes, grace_days, 16).await
}

async fn make_state_with_transfers(
    max_blob_bytes: usize,
    quota_bytes: u64,
    grace_days: i64,
    max_blob_transfers: usize,
) -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("atlas_blobs_test_{}", Uuid::now_v7()));
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    let config = Config {
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
        static_dir: None,
        attachments_enabled: true,
        blob_backend: BlobBackend::Fs,
        blob_dir: Some(dir.clone()),
        max_blob_bytes,
        blob_quota_bytes: quota_bytes,
        blob_gc_grace_days: grace_days,
        max_blob_transfers,
        apps: vec!["todo".into()],
        passkeys: None,
        android_asset_links: None,
    };
    (AppState::new(pool, config), dir)
}

/// Default-cap attachment config (the production defaults are what the flag flip will ship with).
async fn make_state() -> (AppState, std::path::PathBuf) {
    make_state_enabled(25 * 1024 * 1024, 1024 * 1024 * 1024, 7).await
}

fn drop_router(state: AppState) -> Router {
    app(state)
}

async fn http_raw(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Vec<u8>,
    content_type: &str,
) -> (StatusCode, Vec<u8>) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", content_type)
        .header("x-atlas-sync-protocol", "7");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let res = router
        .clone()
        .oneshot(b.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes)
}

async fn http(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let (status, bytes) = http_raw(
        router,
        method,
        uri,
        token,
        serde_json::to_vec(&body).unwrap(),
        "application/json",
    )
    .await;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

#[derive(Debug)]
struct User {
    token: String,
    id: String,
    email: String,
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
    let email = format!("att-{}@example.com", Uuid::now_v7());
    let (status, body) = http(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    User {
        token: body["access_token"].as_str().unwrap().to_string(),
        id: body["user"]["id"].as_str().unwrap().to_string(),
        email,
    }
}

/// Each entity's scope, as a client knows it from its links: a task's project, an attachment's
/// task's project. Ids are unique across tests, so one map serves them all.
static SCOPES: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);

fn scope_of(entity_id: &str) -> Option<String> {
    SCOPES.lock().unwrap().get(entity_id).cloned().flatten()
}

/// A set op of `field` on an entity of the real `entity` kind, as a client sends it: under its
/// wire kind and its scope (a link field moves it, as the client re-scopes on a move). A kind no
/// manifest names goes out as it is.
fn op(entity: &str, entity_id: &str, field: &str, value: Value, wall: u64) -> Value {
    if !["project", "task", "attachment"].contains(&entity) {
        return json!({
            "id": Uuid::now_v7(), "entity": entity, "entity_id": entity_id,
            "op": "set", "field": field, "value": value,
            "ts": { "wall_ms": wall, "counter": 0, "node": Uuid::now_v7() },
        });
    }
    let linked = match (entity, field) {
        ("task", "project_id") => Some(value.as_str().map(str::to_owned)),
        ("attachment", "task_id") => Some(value.as_str().and_then(scope_of)),
        _ => None,
    };
    if let Some(scope) = linked {
        SCOPES.lock().unwrap().insert(entity_id.to_owned(), scope);
    }
    let scope = scope_of(entity_id);
    wire::set(
        wire::wire_kind(entity),
        entity_id,
        scope.as_deref(),
        field,
        value,
        (wall, 0, Uuid::now_v7()),
    )
}

fn tombstone_op(entity: &str, entity_id: &str, wall: u64) -> Value {
    let scope = scope_of(entity_id);
    wire::delete(
        wire::wire_kind(entity),
        entity_id,
        scope.as_deref(),
        (wall, 0, Uuid::now_v7()),
    )
}

async fn push_ops(router: &Router, token: &str, ops: Vec<Value>) -> StatusCode {
    let (status, _) = http(
        router,
        "POST",
        "/sync/push",
        Some(token),
        json!({ "operations": ops }),
    )
    .await;
    status
}

async fn setup_project_with_task(
    router: &Router,
    owner: &User,
    tid: &str,
    shared_with: Option<&User>,
) -> String {
    let pid = Uuid::now_v7().to_string();
    assert_eq!(
        push_ops(
            router,
            &owner.token,
            vec![op("project", &pid, "name", json!("Team"), 100)],
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        push_ops(
            router,
            &owner.token,
            vec![
                op("task", tid, "project_id", json!(pid), 200),
                op("task", tid, "title", json!("Ship it"), 200),
            ],
        )
        .await,
        StatusCode::OK
    );
    if let Some(member) = shared_with {
        let (status, _) = http(
            router,
            "POST",
            &format!("/projects/{pid}/members"),
            Some(&owner.token),
            json!({ "email": member.email, "role": "commenter" }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "invite");
        let (status, _) = http(
            router,
            "POST",
            &format!("/projects/{pid}/accept"),
            Some(&member.token),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "accept");
    }
    pid
}

/// Push the attachment metadata ops (task link + blob sha + encrypted-marker meta) for `blob_sha`.
async fn push_attachment_meta(
    router: &Router,
    user: &User,
    task_id: &str,
    attachment_id: &str,
    blob_sha: &str,
    wall: u64,
) -> StatusCode {
    push_ops(
        router,
        &user.token,
        vec![
            op("attachment", attachment_id, "task_id", json!(task_id), wall),
            op(
                "attachment",
                attachment_id,
                "blob_sha",
                json!(blob_sha),
                wall + 1,
            ),
            op(
                "attachment",
                attachment_id,
                "meta",
                json!({ "__aenc": 1, "iv": "b64", "ct": "b64" }),
                wall + 2,
            ),
        ],
    )
    .await
}

/// The E2EE constraint: the bytes the server holds on disk are the ciphertext bytes the client
/// PUT — verified by reading BLOB_DIR directly.
async fn stored_bytes_on_disk(dir: &std::path::Path, sha: &str) -> Option<Vec<u8>> {
    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));
    store.read(sha).await.ok()
}

// ---------- The attachment entity in the sync log ----------

/// Anchors the entity wiring: push an attachment op with a hypothetical unknown-kind sibling must
/// still be rejected (the mirror map is exhaustive).
#[tokio::test]
async fn unknown_entity_kind_is_rejected_but_attachment_is_known() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state);
    let user = new_user(&router).await;
    // "blobstore" is not a kind: the server's kind map must reject it (the 'attachment' arm is
    // exercised by wire_roundtrip below).
    let (status, _) = http_raw(
        &router,
        "POST",
        "/sync/push",
        Some(&user.token),
        serde_json::to_vec(&json!({ "operations": [
            op("blobstore", &Uuid::now_v7().to_string(), "edge", json!("x"), 1)
        ] }))
        .unwrap(),
        "application/json",
    )
    .await;
    assert!(
        !matches!(status, StatusCode::OK | StatusCode::CREATED),
        "unknown entity kind is rejected ({status})"
    );

    let (status, _) = http(
        &router,
        "POST",
        "/sync/push",
        Some(&user.token),
        json!({ "operations": [op("attachment", &Uuid::now_v7().to_string(), "blob_sha", json!("a".repeat(64)), 1)] }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "attachment is a known sync entity kind"
    );
}

/// push → pull (co-member) → snapshot fan-in roundtrip for the 'attachment' entity kind.
#[tokio::test]
async fn wire_roundtrip_push_pull_and_snapshot_backfill() {
    let (state, dir) = make_state().await;
    let router = drop_router(state);
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    // Bob joins as Commenter: exactly the minimum role attachments push should require.
    let pid = setup_project_with_task(&router, &alice, &tid, Some(&bob)).await;

    let content = b"attachment ciphertext v1".to_vec();
    let sha = hex(&Sha256::digest(&content));
    let aid = Uuid::now_v7().to_string();

    // 1. Blob first (loose auth), then the metadata op on the shared project fans out.
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&alice.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "blob stored");
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );

    // 2. The co-member's push (as Commenter), pull, and snapshot all see the attachment metadata.
    let aid2 = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &bob, &tid, &aid2, &sha, 400).await,
        StatusCode::OK,
        "a commenter may author attachment ops on the shared project"
    );

    // Bob pulls: both attachment sets (his own and the fanned-in one) are in his partition.
    let (status, body) = http(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&bob.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let fields: Vec<&Value> = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["op"] == "set" && o["entity"] == wire::SEALED)
        .collect();
    assert!(
        fields.iter().any(|o| o["value"] == json!(sha)),
        "fanned-in attachment blob_sha reaches the member's pull"
    );

    // 3. Snapshot bootstrap for a fresh member partition carries the attachment fields. A
    // /projects/:id/accept with a brand-new invite is the backfill that exercises
    // snapshot_project_ops' child query with 'attachment' included.
    let bob2 = new_user(&router).await;
    let (status, _) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob2.email, "role": "commenter" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob2.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = http(
        &router,
        "GET",
        "/sync/snapshot",
        Some(&bob2.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let fields: Vec<&Value> = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["op"] == "set" && o["entity"] == wire::SEALED)
        .collect();
    assert!(
        fields.iter().any(|o| o["value"] == json!(sha)),
        "snapshot backfill includes attachment metadata for the shared project"
    );

    // 4. E2EE constraint, end to end: reading the store directly returns exactly the bytes PUT.
    assert_eq!(stored_bytes_on_disk(&dir, &sha).await.unwrap(), content);

    // 5. The meta payload's `__aenc:1` marker is opaque to the server — it round-trips the JSON
    // any-value untouched (the generic `__enc` wire path is client-core's concern; nothing here
    // repurposes `__enc` server-side).
    let (status, body) = http(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(&alice.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let metas: Vec<&Value> = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| {
            o["op"] == "set" && o["entity"] == wire::SEALED && o["field"] == wire::tag("meta")
        })
        .collect();
    assert!(
        metas.iter().any(|o| wire::value_of(o)["__aenc"] == 1),
        "__aenc meta rides opaquely"
    );
}

/// A shared-project member who has been removed can no longer download the blob, even though their
/// historical partition once contained the fanned-in attachment op — removing a member from the
/// project tombstones their copy of the attachment away, and live-reference download authz reads
/// exactly the live set.
#[tokio::test]
async fn download_authorization_and_member_removal_revocation() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    let pid = setup_project_with_task(&router, &alice, &tid, Some(&bob)).await;

    let content = unique("ciphertext bytes");
    let sha = hex(&Sha256::digest(&content));
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&alice.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Before any attachment metadata exists, nobody can download — even the uploader. Download
    // authz is data-derived (a live attachment in YOUR partition), not "who put it there".
    let (status, _) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&alice.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );

    // Owner still authorized. (200, byte-for-byte)
    let (status, body) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&alice.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, content, "download returns the exact ciphertext");

    // Fanned-in member is authorized too.
    let (status, body) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&bob.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, content);

    // A third user, never a member of anything: 403.
    let eve = new_user(&router).await;
    let (status, _) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&eve.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Remove Bob from the project: his fanned-in attachment op is tombstoned away, so his access
    // is revoked for free — with zero new revocation machinery in this module.
    let (status, _) = http(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&bob.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "member removal revokes blob access"
    );

    // Invited back and accepted, Bob sees the project again, and with it the attachment.
    let (status, _) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice.token),
        json!({ "email": bob.email, "role": "commenter" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "re-invite");
    let (status, _) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "accept again");
    let (status, body) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&bob.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a returning member downloads again");
    assert_eq!(body, content);
}

// ---------- The blob transport ----------

#[tokio::test]
async fn roundtrip_and_sha_mismatch() {
    let (state, dir) = make_state().await;
    let router = drop_router(state);
    let user = new_user(&router).await;
    let content = b"server-agnostic ciphertext #1".to_vec();
    let sha = hex(&Sha256::digest(&content));

    // Re-upload BEFORE any write: the CAS is content-addressed, so a repeat PUT is idempotent
    // (200, same bytes) — the offline queue relies on this for retries.
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "idempotent re-upload is accepted");
    assert_eq!(stored_bytes_on_disk(&dir, &sha).await.unwrap(), content);

    // Wrong bytes for the named address: 409, and the stored copy is not corrupted.
    let other = b"tampered-payload".to_vec();
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        other.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "sha mismatch is a 409");
    assert_eq!(
        stored_bytes_on_disk(&dir, &sha).await.unwrap(),
        content,
        "CAS never overwritten"
    );

    // Malformed path segment (not 64 hex chars): 400 — also proves no traversal reach.
    let (status, _) = http_raw(
        &router,
        "PUT",
        "/attachments/blobs/..%2Fetc%2Fpasswd",
        Some(&user.token),
        other,
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn size_cap_answers_413() {
    // max_blob_bytes = 64 for a tiny test budget.
    let (state, _dir) = make_state_enabled(64, 1024 * 1024 * 1024, 7).await;
    let router = drop_router(state);
    let user = new_user(&router).await;
    let content = vec![7u8; 65]; // one byte over the cap
    let sha = hex(&Sha256::digest(&content));
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content,
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn quota_exhaustion_answers_413() {
    // 1024-byte per-uploader quota: two 600-byte blobs cannot both fit.
    let (state, _dir) = make_state_enabled(1024 * 1024, 1024, 7).await;
    let router = drop_router(state);
    let user = new_user(&router).await;
    // Unique per-run padding: the blobs table persists across test runs, so stable content would
    // collide with a leftover row from an earlier run and silently break quota accounting.
    let n = Uuid::now_v7().to_string();
    let c1 = n.as_bytes().repeat(19);
    let c2 = format!("{n}x").repeat(12).into_bytes();
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{}", hex(&Sha256::digest(&c1))),
        Some(&user.token),
        c1.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{}", hex(&Sha256::digest(&c2))),
        Some(&user.token),
        c2,
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "quota exhausted");
    // A different uploader's budget is independent, and a same caller's idempotent PUT of the
    // already-owned blob passes (a retry never counts twice).
    let other = new_user(&router).await;
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{}", hex(&Sha256::digest(&c1))),
        Some(&other.token),
        // Re-uploads must present the same bytes: the CAS verifies the digest even on the
        // idempotent path (an accepted retry never counts against the new uploader's quota).
        c1.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "idempotent re-upload accepts regardless of quota"
    );
}

#[tokio::test]
async fn attachments_disabled_is_a_clean_404() {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    // The web app is served too, as in the Docker image: disabled attachment paths must not fall
    // through to it (a PUT got 405, which clients retried forever, and a GET got index.html).
    let web = std::env::temp_dir().join(format!("atlas_web_test_{}", Uuid::now_v7()));
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>app</title>").unwrap();
    let config = Config {
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
        static_dir: Some(web.clone()),
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
    let router = drop_router(AppState::new(pool, config));
    let token = new_user(&router).await.token;
    for prefix in ["", "/api"] {
        for (method, path) in [
            (
                "PUT",
                format!("{prefix}/attachments/blobs/{}", "a".repeat(64)),
            ),
            (
                "GET",
                format!("{prefix}/attachments/blobs/{}", "a".repeat(64)),
            ),
        ] {
            let (status, body) = http_raw(
                &router,
                method,
                &path,
                Some(&token),
                b"bytes".to_vec(),
                "application/octet-stream",
            )
            .await;
            assert_eq!(
                status,
                StatusCode::NOT_FOUND,
                "{method} {path} when disabled"
            );
            let json: Value = serde_json::from_slice(&body).expect("a JSON error, not the web app");
            assert!(json["error"].is_string());
        }
        let (status, body) = http(
            &router,
            "GET",
            &format!("{prefix}/attachments/config"),
            None,
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["enabled"],
            json!(false),
            "clients learn attachments are off"
        );
    }
    let _ = std::fs::remove_dir_all(&web);
}

#[tokio::test]
async fn config_advertises_attachments_and_the_size_cap() {
    let (state, _dir) = make_state_enabled(4096, 1024 * 1024, 30).await;
    let router = drop_router(state);
    let (status, body) = http(&router, "GET", "/attachments/config", None, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": true, "max_blob_bytes": 4096 }));
}

#[tokio::test]
async fn upload_rate_limit_returns_429_per_user() {
    // Stand up the attachment routes in production wiring, but with a tight per-user limiter, so
    // the second PUT from one user is rejected without the store (keyed on the verified user id,
    // exactly as lib.rs layers it). Users are created on the full app router first, since the
    // test router below only mounts the attachment surface.
    use atlas_server::ratelimit::{RateLimitConfig, UserRateLimitState};
    let (state, _dir) = make_state().await;
    let user = new_user(&drop_router(state.clone())).await;
    let other = new_user(&drop_router(state.clone())).await;
    let rl = UserRateLimitState::from_config(
        RateLimitConfig {
            max_requests: 1,
            window: Duration::from_secs(60),
            trust_forwarded: false,
        },
        &state.config,
    );
    let downloads = UserRateLimitState::from_config(
        RateLimitConfig {
            max_requests: 5,
            window: Duration::from_secs(60),
            trust_forwarded: false,
        },
        &state.config,
    );
    let router = Router::new()
        .merge(atlas_server::attachments::routes(
            rl,
            downloads,
            1024 * 1024,
        ))
        .with_state(state);

    let content = b"one-shot".to_vec();
    let sha = hex(&Sha256::digest(&content));
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "second upload in window is 429"
    );
    // Downloads draw on their own budget: a spent upload budget does not block them (this one
    // answers 403 because nothing references the blob, not 429).
    let (status, _) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "downloads have their own budget"
    );
    // The next user is unaffected (per-user keying, same as /sync).
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&other.token),
        content.clone(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "per-user budget, shared store");
}

// ---------- Blob GC ----------

#[tokio::test]
async fn blob_gc_respects_all_partitions_and_tombstones() {
    let (state, dir) = make_state_enabled(1024 * 1024, 1024 * 1024 * 1024, 7).await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    let _pid = setup_project_with_task(&router, &alice, &tid, Some(&bob)).await;

    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));

    let live_content = b"still referenced by alice's live attachment".to_vec();
    let live_sha = hex(&Sha256::digest(&live_content));
    store
        .write_streaming(&live_sha, &live_content)
        .await
        .unwrap();

    let tomb_content = b"referenced only by a deleted attachment".to_vec();
    let tomb_sha = hex(&Sha256::digest(&tomb_content));
    store
        .write_streaming(&tomb_sha, &tomb_content)
        .await
        .unwrap();

    // Registry rows, backdated past the grace window (gc_once is called with days => 8 below).
    // write_streaming alone writes only the file; the test inserts rows directly.
    // Scoped cleanup: only these addresses. A blanket DELETE FROM blobs would race other
    // tests' rows — they share the sample DB and run concurrently (observed: the quota test's
    // fresh rows vanished mid-test). Disk shards are fresh per-run (temp BLOB_DIR), so only the
    // registry rows need sweeping.
    sqlx::query("DELETE FROM blobs WHERE sha256 = ANY($1)")
        .bind(vec![live_sha.clone(), tomb_sha.clone()])
        .execute(&state.pool)
        .await
        .unwrap();
    for (sha, uploader) in [(&live_sha, alice.id.clone()), (&tomb_sha, alice.id.clone())] {
        sqlx::query(
            "INSERT INTO blobs (sha256, size, uploader_id, created_at)
             VALUES ($1, $2, $3::uuid, now() - make_interval(days => 8::int))",
        )
        .bind(sha)
        .bind(64i64)
        .bind(uploader.parse::<Uuid>().unwrap())
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let live_aid = Uuid::now_v7().to_string();
    let tomb_aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![
                op("attachment", &live_aid, "task_id", json!(tid), 300),
                op("attachment", &live_aid, "blob_sha", json!(live_sha), 301),
            ],
        )
        .await,
        StatusCode::OK
    );
    // Live in ALICE's partition only — but fanned to Bob's too via the shared project, testing
    // the all-partition live-set exactly as the GC predicate will see it.
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![
                op("attachment", &tomb_aid, "task_id", json!(tid), 310),
                op("attachment", &tomb_aid, "blob_sha", json!(tomb_sha), 311),
                // A trailing field write at HLC 390 is still OLDER than the tombstone at 420, so
                // nothing rescues the entity: tombstoned-attachment-only references are dead.
                op("attachment", &tomb_aid, "sort_order", json!(1), 390),
            ],
        )
        .await,
        StatusCode::OK
    );
    // Now tombstone it: blob references exist as a tombstoned attachment — and a tombstone that
    // outranks every field is dead everywhere.
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![tombstone_op("attachment", &tomb_aid, 420)],
        )
        .await,
        StatusCode::OK
    );

    let ns = sample_blob_count(&dir).await;
    assert_eq!(ns, 2, "both blobs on disk before GC");

    // Pass 1 — nothing older than the grace window *and* dead matches our blobs, except the
    // tombstoned-only one. Run a same-day sanity pass first (0 blobs).
    // The grace runs from when the blob lost its last reference, not from its upload: a blob
    // uploaded long ago whose attachment was just deleted must survive the restore window.
    // GC is database-wide and other tests run passes of their own at the same time, so the checks
    // below look at this test's blobs, never at how many blobs a pass freed.
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
    assert!(
        store.read(&tomb_sha).await.is_ok(),
        "a just-deleted attachment keeps its blob"
    );
    backdate(&state.pool, &tomb_sha).await;
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
    // The live one survives BOTH partitions' gate.
    assert!(
        store.read(&live_sha).await.is_ok(),
        "live attachment in any partition protects the blob"
    );
    assert!(
        store.read(&tomb_sha).await.is_err(),
        "tombstoned-only blob freed"
    );
    // Same containment: a fresh unreferenced blob inside grace survives (row created "now").
    let fresh = b"fresh unreferenced within grace".to_vec();
    let fresh_sha = hex(&Sha256::digest(&fresh));
    store.write_streaming(&fresh_sha, &fresh).await.unwrap();
    sqlx::query("INSERT INTO blobs (sha256, size, uploader_id) VALUES ($1, $2, $3::uuid)")
        .bind(&fresh_sha)
        .bind(16i64)
        .bind(alice.id.parse::<Uuid>().unwrap())
        .execute(&state.pool)
        .await
        .unwrap();
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
    assert!(
        store.read(&fresh_sha).await.is_ok(),
        "grace window protects fresh blobs"
    );
    backdate(&state.pool, &fresh_sha).await;
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
    assert!(
        store.read(&fresh_sha).await.is_err(),
        "past the grace window, unreferenced is freed"
    );

    // GC respects days <= 0 as inert (the BLOB_GC_GRACE_DAYS disabled-shape).
    backdate(&state.pool, &live_sha).await;
    let stats = atlas_server::attachments::gc_once(&state.pool, &store, 0)
        .await
        .unwrap();
    assert_eq!(stats.blobs, 0, "grace_days <= 0 never frees anything");
    assert!(store.read(&live_sha).await.is_ok());
}

/// A stored link that is not a uuid (data from before push validated these fields) must not break
/// the live-reference check: it answered 500 on every download and failed every GC pass.
#[tokio::test]
async fn malformed_links_do_not_break_downloads_or_gc() {
    let (state, dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let alice_id: Uuid = alice.id.parse().unwrap();
    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));

    let mut shas = Vec::new();
    for content in [
        unique("linked to a malformed task id"),
        unique("linked to a malformed project"),
    ] {
        let sha = hex(&Sha256::digest(&content));
        let (status, _) = http_raw(
            &router,
            "PUT",
            &format!("/attachments/blobs/{sha}"),
            Some(&alice.token),
            content.to_vec(),
            "application/octet-stream",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        shas.push(sha);
    }

    // One attachment whose task_id is not a uuid, and one whose task's project_id is not either.
    let (bad_link, via_task, task) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
    let rows = [
        (
            "attachment",
            bad_link,
            "task_id",
            json!({ "__enc": 1, "iv": "x", "ct": "y" }),
        ),
        ("attachment", bad_link, "blob_sha", json!(shas[0])),
        ("attachment", via_task, "task_id", json!(task.to_string())),
        ("attachment", via_task, "blob_sha", json!(shas[1])),
        ("task", task, "project_id", json!("not-a-uuid")),
    ];
    for (entity, id, field, value) in &rows {
        sqlx::query(
            "INSERT INTO entity_fields
                (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node)
             VALUES ($1, $2, $3, $4, $5, 1, 0, $6)",
        )
        .bind(alice_id)
        .bind(entity)
        .bind(id)
        .bind(field)
        .bind(value)
        .bind(Uuid::now_v7())
        .execute(&state.pool)
        .await
        .unwrap();
    }
    // Any project tombstone in the partition, as most accounts hold one, puts the casts to work.
    sqlx::query(
        "INSERT INTO entity_tombstones
            (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, 'project', $2, 1, 0, $3)",
    )
    .bind(alice_id)
    .bind(Uuid::now_v7())
    .bind(Uuid::now_v7())
    .execute(&state.pool)
    .await
    .unwrap();

    for sha in &shas {
        let (status, _) = http_raw(
            &router,
            "GET",
            &format!("/attachments/blobs/{sha}"),
            Some(&alice.token),
            Vec::new(),
            "application/octet-stream",
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "an unresolvable link counts as live"
        );
    }

    // A GC pass that has to judge both references runs, keeps them, and frees what is unreferenced.
    let unreferenced = b"referenced by nothing".to_vec();
    let unreferenced_sha = hex(&Sha256::digest(&unreferenced));
    store
        .write_streaming(&unreferenced_sha, &unreferenced)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blobs (sha256, size, uploader_id) VALUES ($1, $2, $3)")
        .bind(&unreferenced_sha)
        .bind(unreferenced.len() as i64)
        .bind(alice_id)
        .execute(&state.pool)
        .await
        .unwrap();
    // Older than the 8-day window the other GC test uses, so the two passes never contend for more
    // than this test's own unreferenced row. A first pass marks it unreferenced; aging that mark
    // lets the second one free it.
    atlas_server::attachments::gc_once(&state.pool, &store, 30)
        .await
        .expect("the GC pass runs");
    sqlx::query(
        "UPDATE blobs SET created_at = now() - make_interval(days => 31),
                          unreferenced_since = now() - make_interval(days => 31)
          WHERE sha256 = ANY($1)",
    )
    .bind(
        shas.iter()
            .chain([&unreferenced_sha])
            .cloned()
            .collect::<Vec<_>>(),
    )
    .execute(&state.pool)
    .await
    .unwrap();
    atlas_server::attachments::gc_once(&state.pool, &store, 30)
        .await
        .expect("the GC pass runs");
    for sha in &shas {
        assert!(
            store.read(sha).await.is_ok(),
            "a live reference keeps its blob"
        );
    }
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE sha256 = $1")
        .bind(&unreferenced_sha)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "the unreferenced blob is freed");

    // The rows are shared test data for every other GC pass; do not leave them behind.
    for table in ["entity_fields", "entity_tombstones"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE user_id = $1"
        )))
        .bind(alice_id)
        .execute(&state.pool)
        .await
        .unwrap();
    }
}

/// Age a blob past the 8-day test grace, both since its upload and since a GC pass found it
/// unreferenced (a referenced blob has its mark cleared again by the next pass).
async fn backdate(pool: &sqlx::PgPool, sha: &str) {
    sqlx::query(
        "UPDATE blobs SET created_at = now() - make_interval(days => 8::int),
                          unreferenced_since = now() - make_interval(days => 8::int)
          WHERE sha256 = $1",
    )
    .bind(sha)
    .execute(pool)
    .await
    .unwrap();
}

async fn sample_blob_count(dir: &std::path::Path) -> usize {
    // Count the shard dirs' hex-named files (temp-dot files excluded).
    let mut n = 0;
    let mut rd = tokio::fs::read_dir(dir).await.unwrap();
    while let Some(entry) = rd.next_entry().await.unwrap() {
        if entry.file_name().to_string_lossy().len() == 2 {
            let mut sub = tokio::fs::read_dir(entry.path()).await.unwrap();
            while let Some(f) = sub.next_entry().await.unwrap() {
                let name = f.file_name().to_string_lossy().to_string();
                if name.len() == 64 && !name.starts_with('.') {
                    n += 1;
                }
            }
        }
    }
    n
}

/// Attachments metadata purges with the ordinary op retention stream: this is the settled decision
/// to NOT extend `OP_RETENTION_DAYS` exclusions, recorded as a test so a future change here needs
/// an explicit decision.
#[tokio::test]
async fn attachment_ops_purge_ordinarily_with_retention() {
    use atlas_server::retention;
    let (state, _dir) = make_state().await;
    let user_id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(user_id)
        .bind(format!("purge-{}@example.com", user_id))
        .execute(&state.pool)
        .await
        .unwrap();
    let entity_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO operations
            (op_id, user_id, entity, entity_id, field, value, is_delete, hlc_wall_ms, hlc_counter, hlc_node, created_at)
         VALUES ($1, $2, 'attachment', $3, 'blob_sha', $4::jsonb, FALSE, 1, 0, $5, now() - make_interval(days => 9))",
    )
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(entity_id)
    .bind(json!("a".repeat(64)).to_string())
    .bind(Uuid::now_v7())
    .execute(&state.pool)
    .await
    .unwrap();
    let stats = retention::purge_once(&state.pool, 7).await.unwrap();
    assert!(
        stats.operations >= 1,
        "attachment ops are not retention-exempt"
    );
}

// ---------- Blob lifecycle and reference rules ----------

async fn put(router: &Router, user: &User, content: &[u8]) -> (StatusCode, String) {
    let sha = hex(&Sha256::digest(content));
    let (status, _) = http_raw(
        router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        content.to_vec(),
        "application/octet-stream",
    )
    .await;
    (status, sha)
}

async fn get_status(router: &Router, user: &User, sha: &str) -> StatusCode {
    http_raw(
        router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&user.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await
    .0
}

async fn blob_row_exists(pool: &sqlx::PgPool, sha: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM blobs WHERE sha256 = $1)")
        .bind(sha)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Two GC passes with the blob's clocks aged in between: the first marks it unreferenced, the
/// second frees it if it still is.
async fn gc_twice(state: &AppState, dir: &std::path::Path, sha: &str) {
    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
    backdate(&state.pool, sha).await;
    atlas_server::attachments::gc_once(&state.pool, &store, 8)
        .await
        .unwrap();
}

#[tokio::test]
async fn deleting_a_task_revokes_and_frees_its_attachments() {
    let (state, dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &alice, &tid, None).await;
    let (status, sha) = put(
        &router,
        &alice,
        &unique("attached to a task that gets purged"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );
    assert_eq!(get_status(&router, &alice, &sha).await, StatusCode::OK);

    // Purging the task tombstones its attachments too: the server cannot link the two, the
    // client does.
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![
                tombstone_op("task", &tid, 500),
                tombstone_op("attachment", &aid, 500)
            ]
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        get_status(&router, &alice, &sha).await,
        StatusCode::FORBIDDEN
    );
    gc_twice(&state, &dir, &sha).await;
    assert!(
        !blob_row_exists(&state.pool, &sha).await,
        "the blob is freed"
    );
}

#[tokio::test]
async fn a_forged_reference_grants_neither_access_nor_gc_protection() {
    let (state, dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let eve = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &alice, &tid, None).await;
    let (_, sha) = put(&router, &alice, &unique("alice's private attachment")).await;
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );

    // Eve learned the sha and pushes an attachment naming it on a task of her own.
    let eve_task = Uuid::now_v7().to_string();
    assert_eq!(
        push_ops(
            &router,
            &eve.token,
            vec![op("task", &eve_task, "title", json!("mine"), 100)]
        )
        .await,
        StatusCode::OK
    );
    let forged = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &eve, &eve_task, &forged, &sha, 200).await,
        StatusCode::OK
    );
    assert_eq!(
        get_status(&router, &eve, &sha).await,
        StatusCode::FORBIDDEN,
        "a forged reference grants no download"
    );

    // Alice deletes her attachment; the forged reference must not keep the blob alive.
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![tombstone_op("attachment", &aid, 900)]
        )
        .await,
        StatusCode::OK
    );
    gc_twice(&state, &dir, &sha).await;
    assert!(
        !blob_row_exists(&state.pool, &sha).await,
        "a forged reference does not pin the blob"
    );
}

#[tokio::test]
async fn a_removed_member_stays_revoked_after_retention_purges_the_project_tombstone() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    let pid = setup_project_with_task(&router, &alice, &tid, Some(&bob)).await;
    let (_, sha) = put(&router, &alice, &unique("shared, then revoked")).await;
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );
    assert_eq!(get_status(&router, &bob, &sha).await, StatusCode::OK);

    let (status, _) = http(
        &router,
        "DELETE",
        &format!("/projects/{pid}/members/{}", bob.id),
        Some(&alice.token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(get_status(&router, &bob, &sha).await, StatusCode::FORBIDDEN);

    // Retention purges the stale project tombstone (with the project's fields) from Bob's
    // partition; his copies of the task and attachment remain.
    let bob_id: Uuid = bob.id.parse().unwrap();
    let pid_uuid: Uuid = pid.parse().unwrap();
    for table in ["entity_tombstones", "entity_fields"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE user_id = $1 AND entity = 'todo.project' AND entity_id = $2"
        )))
        .bind(bob_id)
        .bind(pid_uuid)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    assert_eq!(
        get_status(&router, &bob, &sha).await,
        StatusCode::FORBIDDEN,
        "revocation must not depend on the tombstone surviving"
    );
}

#[tokio::test]
async fn a_blob_follows_its_task_into_a_shared_project() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let bob = new_user(&router).await;
    // An inbox task (no project) with an attachment: the blob is private to Alice.
    let tid = Uuid::now_v7().to_string();
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![op("task", &tid, "title", json!("inbox"), 100)]
        )
        .await,
        StatusCode::OK
    );
    let (_, sha) = put(&router, &alice, &unique("moves with its task")).await;
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 150).await,
        StatusCode::OK
    );

    // Alice moves the task into a project shared with Bob and re-publishes the attachment there,
    // as the client does when it re-wraps the file key for the new project.
    let other_task = Uuid::now_v7().to_string();
    let pid = setup_project_with_task(&router, &alice, &other_task, Some(&bob)).await;
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![op("task", &tid, "project_id", json!(pid), 400)]
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 410).await,
        StatusCode::OK
    );
    assert_eq!(get_status(&router, &bob, &sha).await, StatusCode::OK);
}

#[tokio::test]
async fn uppercase_shas_are_rejected_and_thumbnails_count() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let tid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &alice, &tid, None).await;
    let (_, sha) = put(&router, &alice, &unique("full-size image")).await;
    let (_, thumb) = put(&router, &alice, &unique("its thumbnail")).await;

    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha.to_ascii_uppercase(), 300).await,
        StatusCode::BAD_REQUEST,
        "an uppercase address would never match its blob"
    );
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );
    assert_eq!(
        push_ops(
            &router,
            &alice.token,
            vec![op("attachment", &aid, "thumb_sha", json!(thumb), 310)]
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(get_status(&router, &alice, &thumb).await, StatusCode::OK);
}

#[tokio::test]
async fn a_repeat_upload_restarts_the_grace_clock() {
    let (state, _dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let content = unique("uploaded, metadata still on an offline device");
    let (status, sha) = put(&router, &alice, &content).await;
    assert_eq!(status, StatusCode::CREATED);
    backdate(&state.pool, &sha).await;
    let (status, _) = put(&router, &alice, &content).await;
    assert_eq!(status, StatusCode::OK);
    let (fresh, unmarked): (bool, bool) = sqlx::query_as(
        "SELECT created_at > now() - interval '1 hour', unreferenced_since IS NULL
           FROM blobs WHERE sha256 = $1",
    )
    .bind(&sha)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(fresh && unmarked, "the repeat upload restarts both clocks");
}

#[tokio::test]
async fn concurrent_uploads_cannot_overshoot_the_quota() {
    // Room for one 60-byte blob, not two: however the two PUTs interleave, one must fail.
    let (state, _dir) = make_state_enabled(1024, 100, 30).await;
    let router = drop_router(state.clone());
    for round in 0..5u8 {
        let user = new_user(&router).await;
        let mut a = unique(&format!("quota round {round} a"));
        let mut b = unique(&format!("quota round {round} b"));
        a.resize(60, b'.');
        b.resize(60, b'.');
        let ((sa, _), (sb, _)) = tokio::join!(put(&router, &user, &a), put(&router, &user, &b));
        let created = [sa, sb]
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count();
        assert_eq!(created, 1, "round {round}: {sa} / {sb}");
    }
}

#[tokio::test]
async fn the_sweep_removes_orphaned_and_temporary_files_only() {
    let (state, dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));
    let (_, kept) = put(&router, &alice, &unique("has a row")).await;

    let orphan_content = unique("row lost after a crash");
    let orphan = hex(&Sha256::digest(&orphan_content));
    store
        .write_streaming(&orphan, &orphan_content)
        .await
        .unwrap();
    let young_content = unique("a PUT still in flight");
    let young = hex(&Sha256::digest(&young_content));
    store.write_streaming(&young, &young_content).await.unwrap();
    let tmp = dir
        .join(&orphan[..2])
        .join(format!(".tmp-{orphan}-crashed"));
    std::fs::write(&tmp, b"partial").unwrap();

    let old = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
    for path in [
        dir.join(&orphan[..2]).join(&orphan),
        dir.join(&kept[..2]).join(&kept),
        tmp.clone(),
    ] {
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }

    let removed = atlas_server::attachments::sweep_orphans(&state.pool, &store)
        .await
        .unwrap();
    assert_eq!(removed, 2, "the old orphan and the stale temp file");
    assert!(store.read(&orphan).await.is_err());
    assert!(!tmp.exists());
    assert!(store.read(&kept).await.is_ok(), "a blob with a row stays");
    assert!(
        store.read(&young).await.is_ok(),
        "a young file may be a PUT in flight"
    );
}

#[tokio::test]
async fn an_account_purge_deletes_the_accounts_blob_files() {
    let (state, dir) = make_state().await;
    let router = drop_router(state.clone());
    let alice = new_user(&router).await;
    let (_, sha) = put(&router, &alice, &unique("goes with the account")).await;
    let store = BlobStore::from(FsBlobStore::new(dir.to_path_buf()));
    assert!(store.read(&sha).await.is_ok());
    sqlx::query(
        "UPDATE users SET deletion_scheduled_at = now() - make_interval(days => 31) WHERE id = $1",
    )
    .bind(alice.id.parse::<Uuid>().unwrap())
    .execute(&state.pool)
    .await
    .unwrap();
    atlas_server::auth::account_purge::purge_expired_accounts(&state)
        .await
        .unwrap();
    assert!(!blob_row_exists(&state.pool, &sha).await);
    assert!(store.read(&sha).await.is_err(), "the file is gone too");
}

// ---------- Streaming and the transfer cap ----------

/// PUT a body that arrives in `pieces` with no declared length, as a streamed upload does.
async fn put_streamed(router: &Router, user: &User, sha: &str, pieces: Vec<Vec<u8>>) -> StatusCode {
    let chunks = pieces
        .into_iter()
        .map(|p| Ok::<_, std::io::Error>(axum::body::Bytes::from(p)));
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/attachments/blobs/{sha}"))
        .header("content-type", "application/octet-stream")
        .header("authorization", format!("Bearer {}", user.token))
        .body(Body::from_stream(futures_util::stream::iter(chunks)))
        .unwrap();
    router.clone().oneshot(request).await.unwrap().status()
}

/// Every temp file left anywhere under the blob root.
fn temp_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(shards) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    shards
        .flatten()
        .filter(|s| s.path().is_dir())
        .flat_map(|s| std::fs::read_dir(s.path()).unwrap().flatten())
        .map(|f| f.path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".tmp-")
        })
        .collect()
}

fn get_request(user: &User, sha: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(format!("/attachments/blobs/{sha}"))
        .header("authorization", format!("Bearer {}", user.token))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn a_streamed_upload_is_stored_and_served_with_its_length() {
    let (state, dir) = make_state().await;
    let router = drop_router(state);
    let alice = new_user(&router).await;
    let content: Vec<u8> = unique("streamed").repeat(5000);
    let sha = hex(&Sha256::digest(&content));
    let pieces = content.chunks(7000).map(<[u8]>::to_vec).collect();
    assert_eq!(
        put_streamed(&router, &alice, &sha, pieces).await,
        StatusCode::CREATED
    );
    assert_eq!(stored_bytes_on_disk(&dir, &sha).await.unwrap(), content);

    let tid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &alice, &tid, None).await;
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 1_000).await,
        StatusCode::OK
    );
    let res = router
        .clone()
        .oneshot(get_request(&alice, &sha))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers()["content-length"],
        content.len().to_string().as_str()
    );
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), content.as_slice());
    assert!(temp_files(&dir).is_empty());
}

#[tokio::test]
async fn an_oversized_upload_stops_at_the_cap_and_leaves_nothing_behind() {
    let (state, dir) = make_state_enabled(64, 1024 * 1024 * 1024, 7).await;
    let pool = state.pool.clone();
    let router = drop_router(state);
    let user = new_user(&router).await;
    let content = unique("over the cap").repeat(3);
    assert!(content.len() > 64);
    let sha = hex(&Sha256::digest(&content));

    // No declared length: counted as it streams, and refused once past the cap.
    let pieces = content.chunks(40).map(<[u8]>::to_vec).collect();
    assert_eq!(
        put_streamed(&router, &user, &sha, pieces).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(temp_files(&dir).is_empty(), "the partial file is removed");
    assert!(stored_bytes_on_disk(&dir, &sha).await.is_none());
    assert!(!blob_row_exists(&pool, &sha).await);

    // A declared length over the cap is refused before the body is read.
    let request = Request::builder()
        .method("PUT")
        .uri(format!("/attachments/blobs/{sha}"))
        .header("content-type", "application/octet-stream")
        .header("content-length", content.len().to_string())
        .header("authorization", format!("Bearer {}", user.token))
        .body(Body::from(content))
        .unwrap();
    let res = router.clone().oneshot(request).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_mismatched_upload_leaves_no_temp_file() {
    let (state, dir) = make_state().await;
    let router = drop_router(state);
    let user = new_user(&router).await;
    let sha = hex(&Sha256::digest(b"what the path names"));
    let pieces = vec![b"something ".to_vec(), b"else".to_vec()];
    assert_eq!(
        put_streamed(&router, &user, &sha, pieces).await,
        StatusCode::CONFLICT
    );
    assert!(temp_files(&dir).is_empty());
    assert!(stored_bytes_on_disk(&dir, &sha).await.is_none());
}

#[tokio::test]
async fn transfers_past_the_cap_are_refused_until_a_slot_frees() {
    let (state, _dir) = make_state_with_transfers(25 * 1024 * 1024, 1024 * 1024 * 1024, 7, 1).await;
    let router = drop_router(state);
    let alice = new_user(&router).await;
    let content = unique("one at a time");
    let (status, sha) = put(&router, &alice, &content).await;
    assert_eq!(status, StatusCode::CREATED);
    let tid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &alice, &tid, None).await;
    let aid = Uuid::now_v7().to_string();
    assert_eq!(
        push_attachment_meta(&router, &alice, &tid, &aid, &sha, 1_000).await,
        StatusCode::OK
    );

    // A download whose body has not been read yet holds the only slot.
    let held = router
        .clone()
        .oneshot(get_request(&alice, &sha))
        .await
        .unwrap();
    assert_eq!(held.status(), StatusCode::OK);

    let refused = router
        .clone()
        .oneshot(get_request(&alice, &sha))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(refused.headers().contains_key("retry-after"));
    let (status, _) = put(&router, &alice, &unique("waits too")).await;
    assert_eq!(
        status,
        StatusCode::SERVICE_UNAVAILABLE,
        "uploads share the cap"
    );

    // Once the first body is sent in full, its slot is free again.
    let body = held.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), content.as_slice());
    assert_eq!(get_status(&router, &alice, &sha).await, StatusCode::OK);
    let (status, _) = put(&router, &alice, &unique("now it fits")).await;
    assert_eq!(status, StatusCode::CREATED);
}

/// The S3 backend's store logic, over an in-memory object store: uploads land at their key only
/// once verified, downloads stream the exact bytes, a blob larger than one upload part arrives
/// whole, and the GC frees the object with its row.
#[tokio::test]
async fn the_object_store_backend_keeps_the_blob_store_guarantees() {
    use object_store::memory::InMemory;
    use object_store::path::Path as ObjectPath;
    use object_store::ObjectStoreExt;

    let (state, dir) = make_state().await;
    let memory = std::sync::Arc::new(InMemory::new());
    let store = atlas_server::attachments::ObjectBlobStore::new(
        memory.clone(),
        "/atlas/blobs/",
        dir.clone(),
    );
    let state = state.with_blob_store(store.into());
    let router = drop_router(state.clone());
    let owner = new_user(&router).await;
    let key = |sha: &str| ObjectPath::from(format!("atlas/blobs/{}/{sha}", &sha[..2]));
    let object = |sha: String| {
        let memory = memory.clone();
        async move {
            match memory.get(&key(&sha)).await {
                Ok(got) => Some(got.bytes().await.unwrap().to_vec()),
                Err(_) => None,
            }
        }
    };

    // Larger than one part of a multipart upload (5 MiB).
    let content: Vec<u8> = (0..6 * 1024 * 1024 + 7)
        .map(|i: usize| (i % 251) as u8)
        .collect();
    let (status, sha) = put(&router, &owner, &content).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        object(sha.clone()).await.unwrap(),
        content,
        "stored byte for byte"
    );
    let (status, _) = put(&router, &owner, &content).await;
    assert_eq!(status, StatusCode::OK, "idempotent re-upload");

    // Wrong bytes for the address: refused, the object untouched.
    let (status, _) = http_raw(
        &router,
        "PUT",
        &format!("/attachments/blobs/{sha}"),
        Some(&owner.token),
        b"tampered".to_vec(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(object(sha.clone()).await.unwrap(), content);
    // No upload left a temp file behind.
    let mut staged = tokio::fs::read_dir(&dir).await.unwrap();
    assert!(
        staged.next_entry().await.unwrap().is_none(),
        "staging is empty"
    );

    // A live attachment grants the download, which streams the exact bytes.
    let tid = Uuid::now_v7().to_string();
    let aid = Uuid::now_v7().to_string();
    setup_project_with_task(&router, &owner, &tid, None).await;
    assert_eq!(
        push_attachment_meta(&router, &owner, &tid, &aid, &sha, 300).await,
        StatusCode::OK
    );
    let (status, body) = http_raw(
        &router,
        "GET",
        &format!("/attachments/blobs/{sha}"),
        Some(&owner.token),
        Vec::new(),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, content);

    // A fresh object with no row, and an object that is not a blob, survive the sweep.
    let stray = hex(&Sha256::digest(b"stray"));
    memory
        .put(&key(&stray), b"stray".to_vec().into())
        .await
        .unwrap();
    let foreign = ObjectPath::from("atlas/blobs/README");
    memory.put(&foreign, b"hi".to_vec().into()).await.unwrap();
    let blobs = state.blobs.as_ref().unwrap();
    atlas_server::attachments::sweep_orphans(&state.pool, blobs)
        .await
        .unwrap();
    assert!(object(stray).await.is_some(), "too young to be an orphan");
    assert!(memory.head(&foreign).await.is_ok(), "not a blob key");

    // Deleting the attachment frees the object with its row.
    assert_eq!(
        push_ops(
            &router,
            &owner.token,
            vec![tombstone_op("attachment", &aid, 400)]
        )
        .await,
        StatusCode::OK
    );
    atlas_server::attachments::gc_once(&state.pool, blobs, 8)
        .await
        .unwrap();
    backdate(&state.pool, &sha).await;
    atlas_server::attachments::gc_once(&state.pool, blobs, 8)
        .await
        .unwrap();
    assert!(!blob_row_exists(&state.pool, &sha).await);
    assert!(object(sha).await.is_none(), "object deleted");
    let _ = tokio::fs::remove_dir_all(&dir).await;
}
