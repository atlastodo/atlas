//! Integration tests for `GET /sync/snapshot` — bootstrapping a device from the materialized
//! state (instead of replaying the whole op log) with the cursor to resume from.

use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::collections::HashSet;
use tower::ServiceExt;
use uuid::Uuid;

mod common;
use common::wire::{self, tag, value_of};

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn make_state() -> AppState {
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
    };
    AppState::new(pool, config)
}

async fn http(
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
        .header("x-atlas-sync-protocol", "7");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    let req = b
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
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

async fn new_user(router: &Router) -> (String, String) {
    let email = format!("snap-{}@example.com", Uuid::now_v7());
    let (status, body) = http(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email, "password": PASSWORD
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    (body["access_token"].as_str().unwrap().to_string(), email)
}

/// A set op of `field` on an entity of the real `kind`, as its client sends it (no scope).
fn set_op(kind: &str, entity_id: &str, field: &str, value: Value, wall: u64) -> Value {
    wire::set_of_kind(kind, entity_id, field, value, wall)
}

fn delete_op(kind: &str, entity_id: &str, wall: u64) -> Value {
    wire::delete(
        wire::wire_kind(kind),
        entity_id,
        None,
        (wall, 0, Uuid::now_v7()),
    )
}

async fn push(router: &Router, token: &str, ops: Vec<Value>) {
    let (status, body) = http(
        router,
        "POST",
        "/sync/push",
        Some(token),
        json!({ "operations": ops }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}

#[tokio::test]
async fn snapshot_requires_auth() {
    let state = make_state().await;
    let router = app(state);
    let (status, _) = http(&router, "GET", "/sync/snapshot", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn snapshot_of_empty_user_is_empty_with_zero_cursor() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;

    let (status, body) = http(&router, "GET", "/sync/snapshot", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert_eq!(body["operations"].as_array().unwrap().len(), 0);
    assert_eq!(body["cursor"], 0);
    assert!(body.get("next").is_none(), "a short page has no next token");
}

#[tokio::test]
async fn snapshot_returns_materialized_state_with_tombstones() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;

    let live = Uuid::now_v7().to_string();
    let doomed = Uuid::now_v7().to_string();
    push(
        &router,
        &token,
        vec![
            set_op("task", &live, "title", json!("keep me"), 100),
            set_op("task", &live, "priority", json!(3), 100),
            set_op("task", &doomed, "title", json!("doomed"), 200),
            delete_op("task", &doomed, 300),
        ],
    )
    .await;

    let (status, body) = http(&router, "GET", "/sync/snapshot", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert!(body["cursor"].as_i64().unwrap() > 0);

    let ops = body["operations"].as_array().unwrap();
    // Every op is the same wire shape pull returns, with an HLC.
    for op in ops {
        assert!(op["id"].as_str().is_some());
        assert!(op["entity"].as_str().is_some());
        assert!(op["ts"]["wall_ms"].as_u64().is_some());
    }
    // The live task's fields are present as Set ops with their values.
    let live_ops: Vec<&Value> = ops
        .iter()
        .filter(|o| o["entity_id"] == live.as_str())
        .collect();
    assert_eq!(live_ops.len(), 2, "title + priority of the live task");
    assert!(live_ops
        .iter()
        .any(|o| o["field"] == tag("title") && value_of(o) == "keep me"));
    assert!(live_ops
        .iter()
        .any(|o| o["field"] == tag("priority") && value_of(o) == 3));
    // The deleted task is represented as its field Set AND its Delete op — the client's HLC-based
    // visibility rule resolves them exactly like a log replay would.
    let doomed_ops: Vec<&Value> = ops
        .iter()
        .filter(|o| o["entity_id"] == doomed.as_str())
        .collect();
    assert!(doomed_ops
        .iter()
        .any(|o| o["op"] == "set" && o["field"] == tag("title")));
    assert!(
        doomed_ops.iter().any(|o| o["op"] == "delete"),
        "the tombstone must be represented as a Delete op"
    );
}

#[tokio::test]
async fn snapshot_includes_shared_project_fan_in() {
    let state = make_state().await;
    let router = app(state);

    let (alice, _) = new_user(&router).await;
    let (bob, bob_email) = new_user(&router).await;

    let pid = Uuid::now_v7().to_string();
    let tid = Uuid::now_v7().to_string();
    push(
        &router,
        &alice,
        vec![set_op("project", &pid, "name", json!("Team"), 100)],
    )
    .await;
    let (status, body) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/members"),
        Some(&alice),
        json!({ "email": bob_email, "role": "editor" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let (status, _) = http(
        &router,
        "POST",
        &format!("/projects/{pid}/accept"),
        Some(&bob),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A later edit by Alice, in the project's scope, fans out into Bob's partition; his snapshot
    // must contain it.
    let in_project = |field: &str, value: Value| {
        wire::set(
            wire::SEALED,
            &tid,
            Some(&pid),
            field,
            value,
            (500, 0, Uuid::now_v7()),
        )
    };
    push(
        &router,
        &alice,
        vec![
            in_project("project_id", json!(pid)),
            in_project("title", json!("shared work")),
        ],
    )
    .await;

    let (status, body) = http(&router, "GET", "/sync/snapshot", Some(&bob), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let has_shared_task = body["operations"].as_array().unwrap().iter().any(|o| {
        o["entity"] == wire::SEALED && o["field"] == tag("title") && value_of(o) == "shared work"
    });
    assert!(
        has_shared_task,
        "snapshot must include fan-in from shared projects, like pull"
    );
}

#[tokio::test]
async fn snapshot_cursor_pulls_only_newer_ops() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;

    let tid = Uuid::now_v7().to_string();
    push(
        &router,
        &token,
        vec![set_op("task", &tid, "title", json!("first"), 100)],
    )
    .await;

    let (status, snap) = http(&router, "GET", "/sync/snapshot", Some(&token), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let cursor = snap["cursor"].as_i64().unwrap();
    assert!(cursor > 0);

    // An op committed after the snapshot is delivered exactly once by resuming from its cursor.
    push(
        &router,
        &token,
        vec![set_op("task", &tid, "notes", json!("second"), 200)],
    )
    .await;
    let (status, pull) = http(
        &router,
        "GET",
        &format!("/sync/pull?since={cursor}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let ops = pull["operations"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "only the op committed after the snapshot");
    assert_eq!(ops[0]["field"], tag("notes"));
    assert_eq!(value_of(&ops[0]), "second");
}

#[tokio::test]
async fn snapshot_pages_through_every_entity() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;

    // Six tasks × two fields: 12 materialized Set ops to page through.
    let mut all: HashSet<(String, String, Value)> = HashSet::new();
    let mut ops = Vec::new();
    for i in 0..6 {
        let tid = Uuid::now_v7().to_string();
        all.insert((tid.clone(), "title".into(), json!(format!("t{i}"))));
        all.insert((tid.clone(), "priority".into(), json!(i)));
        ops.push(set_op(
            "task",
            &tid,
            "title",
            json!(format!("t{i}")),
            100 + i,
        ));
        ops.push(set_op("task", &tid, "priority", json!(i), 100 + i));
    }
    push(&router, &token, ops).await;

    let mut seen: HashSet<(String, String, Value)> = HashSet::new();
    let mut next: Option<String> = None;
    let mut cursor_seen: Option<i64> = None;
    let mut pages = 0;
    loop {
        let uri = match &next {
            Some(token) => format!("/sync/snapshot?next={token}&limit=2"),
            None => "/sync/snapshot?limit=2".to_string(),
        };
        let (status, page) = http(&router, "GET", &uri, Some(&token), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{page:?}");
        let cursor = page["cursor"].as_i64().unwrap();
        assert_eq!(
            Some(cursor),
            cursor_seen.or(Some(cursor)),
            "the resume cursor is stable across pages"
        );
        cursor_seen = Some(cursor);
        for op in page["operations"].as_array().unwrap() {
            let field = op["field"].as_str().unwrap();
            let name = ["title", "priority"]
                .into_iter()
                .find(|n| tag(n) == field)
                .expect("a field of the fixture");
            seen.insert((
                op["entity_id"].as_str().unwrap().to_string(),
                name.to_string(),
                value_of(op),
            ));
        }
        pages += 1;
        match page["next"].as_str() {
            Some(token) => next = Some(token.to_string()),
            None => break,
        }
    }
    assert!(pages > 1, "12 keys at limit=2 must paginate");
    assert_eq!(
        seen, all,
        "walking pages must cover every field exactly once"
    );
}

/// Every page reports the FIRST page's cursor: ops committed while a device walks the pages are
/// then re-delivered by its overlap pull instead of being skipped by a later page's newer cursor.
#[tokio::test]
async fn snapshot_cursor_is_pinned_to_the_first_page() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;
    let tids: Vec<String> = (0..3).map(|_| Uuid::now_v7().to_string()).collect();
    push(
        &router,
        &token,
        tids.iter()
            .map(|t| set_op("task", t, "title", json!("t"), 100))
            .collect(),
    )
    .await;

    let (status, first) = http(
        &router,
        "GET",
        "/sync/snapshot?limit=1",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first:?}");
    let pinned = first["cursor"].as_i64().unwrap();
    let token_1 = first["next"].as_str().unwrap().to_string();

    // A write lands mid-bootstrap.
    let late = Uuid::now_v7().to_string();
    push(
        &router,
        &token,
        vec![set_op("task", &late, "title", json!("late"), 200)],
    )
    .await;

    // The token passed back opaquely...
    let (status, second) = http(
        &router,
        "GET",
        &format!("/sync/snapshot?limit=1&next={token_1}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second:?}");
    assert_eq!(
        second["cursor"], pinned,
        "a later page keeps the first page's cursor"
    );
    let entities = |page: &Value| -> Vec<Value> {
        page["operations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op["entity_id"].clone())
            .collect()
    };
    assert_ne!(
        entities(&second),
        entities(&first),
        "the token resumes after the first page"
    );

    // A token without its pinned cursor is refused, so the client restarts the walk.
    let (entity_and_id, _) = token_1.rsplit_once('/').unwrap();
    let (status, _) = http(
        &router,
        "GET",
        &format!("/sync/snapshot?limit=1&next={entity_and_id}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_snapshot_page_holds_up_to_1000_keys() {
    let state = make_state().await;
    let router = app(state);
    let (token, _) = new_user(&router).await;
    let ops: Vec<Value> = (0..700)
        .map(|i| set_op("task", &Uuid::now_v7().to_string(), "title", json!(i), 100))
        .collect();
    push(&router, &token, ops).await;

    let (status, page) = http(
        &router,
        "GET",
        "/sync/snapshot?limit=1000",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page:?}");
    assert_eq!(page["operations"].as_array().unwrap().len(), 700);
    assert!(page.get("next").is_none(), "700 keys fit one page of 1000");
}

/// Every snapshot page of the caller's partition, concatenated.
async fn snapshot_ops(router: &Router, token: &str) -> Vec<Value> {
    let mut ops = Vec::new();
    let mut uri = "/sync/snapshot".to_string();
    loop {
        let (status, body) = http(router, "GET", &uri, Some(token), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{body:?}");
        ops.extend(body["operations"].as_array().unwrap().iter().cloned());
        match body["next"].as_str() {
            Some(next) => uri = format!("/sync/snapshot?next={next}"),
            None => return ops,
        }
    }
}

fn hlc_key(ts: &Value) -> (u64, u64, String) {
    (
        ts["wall_ms"].as_u64().unwrap(),
        ts["counter"].as_u64().unwrap(),
        ts["node"].as_str().unwrap().to_string(),
    )
}

/// `test-vectors/conflict_vectors.json` through the server's own fold: each scenario's ops,
/// pushed one at a time in order and as one batch in reverse, must snapshot to the state the
/// client resolves, read with the client's rule (a field shows when newer than the tombstone).
#[tokio::test]
async fn the_server_fold_resolves_the_shared_conflict_vectors() {
    let vectors: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/conflict_vectors.json"
    )))
    .unwrap();
    let router = app(make_state().await);
    let (token, _) = new_user(&router).await;

    let mut expected = Vec::new();
    for scenario in vectors["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let ops = scenario["ops"].as_array().unwrap();
        for one_at_a_time in [true, false] {
            let entity_id = Uuid::now_v7();
            let wire: Vec<Value> = ops
                .iter()
                .map(|op| {
                    let mut w = json!({
                        "id": Uuid::now_v7(),
                        "entity": wire::SEALED,
                        "entity_id": entity_id,
                        "scope": null,
                        "ts": op["ts"],
                    });
                    if op["delete"].as_bool() == Some(true) {
                        w["op"] = json!("delete");
                    } else {
                        w["op"] = json!("set");
                        w["field"] = json!(tag(op["field"].as_str().unwrap()));
                        w["value"] = wire::sealed(op["value"].clone());
                    }
                    w
                })
                .collect();
            let batches: Vec<Vec<Value>> = if one_at_a_time {
                wire.into_iter().map(|w| vec![w]).collect()
            } else {
                vec![wire.into_iter().rev().collect()]
            };
            for batch in batches {
                let (status, body) = http(
                    &router,
                    "POST",
                    "/sync/push",
                    Some(&token),
                    json!({ "operations": batch }),
                )
                .await;
                assert_eq!(status, StatusCode::OK, "{name}: {body:?}");
            }
            expected.push((name, entity_id, &scenario["expected"]));
        }
    }

    // The vectors' field names, by the tags they travel as.
    let names: std::collections::HashMap<String, String> = vectors["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["ops"].as_array().unwrap())
        .filter_map(|op| op["field"].as_str())
        .map(|f| (tag(f), f.to_owned()))
        .collect();
    let snapshot = snapshot_ops(&router, &token).await;
    for (name, entity_id, want) in expected {
        let id = entity_id.to_string();
        let ops: Vec<&Value> = snapshot.iter().filter(|o| o["entity_id"] == id).collect();
        let tomb = ops
            .iter()
            .filter(|o| o["op"] == "delete")
            .map(|o| hlc_key(&o["ts"]))
            .max();
        let mut fields = serde_json::Map::new();
        for op in ops.iter().filter(|o| o["op"] == "set") {
            if tomb.as_ref().is_none_or(|t| hlc_key(&op["ts"]) > *t) {
                fields.insert(names[op["field"].as_str().unwrap()].clone(), value_of(op));
            }
        }
        let deleted = tomb.is_some() && fields.is_empty();
        assert_eq!(deleted, want["deleted"].as_bool().unwrap(), "{name}");
        assert_eq!(Value::Object(fields), want["fields"], "{name}");
    }
}
