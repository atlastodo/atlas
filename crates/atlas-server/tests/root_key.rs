//! Integration tests for the account root key and app keys (`/auth/root-key`, `/auth/app-keys`,
//! and the root slots that signup, login, password change and recovery carry). The server only
//! stores opaque wraps, so the wraps here are random. Runs against `TEST_DATABASE_URL`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use atlas_server::{app, config::Config, db, state::AppState};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use hkdf::Hkdf;
use http_body_util::BodyExt;
use rand::Rng;
use serde_json::{json, Value};
use sha2::Sha256;
use tower::ServiceExt;
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const NEW_PASSWORD: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const THIRD_PASSWORD: &str = "1111111111111111222222222222222233333333333333334444444444444444";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> Router {
    setup_with(&["todo", "journal"]).await
}

async fn setup_with(apps: &[&str]) -> Router {
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
        static_dir: None,
        apps: apps.iter().map(|a| a.to_string()).collect(),
        passkeys: None,
        android_asset_links: None,
    };
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    app(AppState::new(pool, config))
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-atlas-sync-protocol", "6");
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let request = builder
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// A wrapped 32-byte key as the client writes one.
fn wrap() -> Value {
    json!({
        "v": 1,
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

/// A legacy wrap (`wrapKey`, no version), as the deprecated MEK and recovery slots hold.
fn legacy_wrap() -> Value {
    json!({
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

fn sealed_wrap() -> Value {
    let mut w = wrap();
    w["epk"] = json!(hex::encode(random_bytes::<32>()));
    w
}

fn todo_key() -> Value {
    json!({ "app": "todo", "wrapped_key": wrap(), "wrapped_private_key": wrap() })
}

struct Account {
    email: String,
    access: String,
    user_id: String,
    recovery_secret: StaticSecret,
    recovery_public_key: String,
}

/// Sign up. `root` adds the root key fields a current client sends; without them the account
/// is one a client predating root keys created.
async fn signup(router: &Router, root: bool) -> (Account, Value) {
    let email = format!("root-{}@example.com", Uuid::now_v7());
    let recovery_secret = StaticSecret::from(random_bytes::<32>());
    let recovery_public_key = hex::encode(PublicKey::from(&recovery_secret).as_bytes());
    let mut body = json!({
        "email": email,
        "password": PASSWORD,
        "salt": hex::encode(random_bytes::<16>()),
        "public_key": hex::encode(random_bytes::<32>()),
        "recovery_public_key": recovery_public_key,
        "encrypted_dek": wrap(),
        "encrypted_private_key": wrap(),
        "recovery_encrypted_dek": legacy_wrap(),
        "recovery_encrypted_private_key": legacy_wrap(),
    });
    if root {
        body["user_id"] = json!(Uuid::new_v4());
        body["encrypted_root_key"] = wrap();
        body["recovery_encrypted_root_key"] = wrap();
        body["app_keys"] = json!([todo_key()]);
    }
    let (status, resp) = send(router, "POST", "/auth/signup", None, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{resp:?}");
    if root {
        assert_eq!(resp["user"]["id"], body["user_id"], "the client-chosen id");
    }
    (
        Account {
            email,
            access: resp["access_token"].as_str().unwrap().to_string(),
            user_id: resp["user"]["id"].as_str().unwrap().to_string(),
            recovery_secret,
            recovery_public_key,
        },
        body,
    )
}

async fn login(router: &Router, email: &str, password: &str) -> (StatusCode, Value) {
    send(
        router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": password }),
    )
    .await
}

fn migrate_body(acct: &Account) -> Value {
    json!({
        "current_password": PASSWORD,
        "encrypted_root_key": wrap(),
        "recovery_encrypted_root_key": sealed_wrap(),
        "recovery_public_key": acct.recovery_public_key,
        "app_keys": [todo_key()],
    })
}

/// Unseal a recovery challenge (as the client's `unsealKey` does) and answer it.
fn answer_challenge(challenge: &Value, secret: &StaticSecret) -> String {
    let sealed = &challenge["sealed"];
    let ephemeral: [u8; 32] = hex::decode(sealed["ephemeralPublicKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let shared = secret.diffie_hellman(&PublicKey::from(ephemeral));
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(None, shared.as_bytes())
        .expand(b"atlas-seal-v1", &mut key)
        .unwrap();
    let iv = BASE64
        .decode(sealed["encryptedKey"]["iv"].as_str().unwrap())
        .unwrap();
    let ct = BASE64
        .decode(sealed["encryptedKey"]["ct"].as_str().unwrap())
        .unwrap();
    let nonce = Aes256Gcm::new(&key.into())
        .decrypt(&Nonce::try_from(iv.as_slice()).unwrap(), ct.as_slice())
        .unwrap();
    hex::encode(nonce)
}

async fn recovery_keys(router: &Router, email: &str) -> Value {
    let (status, body) = send(
        router,
        "GET",
        &format!("/auth/recovery-keys?email={email}"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body
}

fn recover_body(acct: &Account, keys: &Value, new_password: &str) -> Value {
    json!({
        "email": acct.email,
        "challenge_token": keys["challenge"]["token"],
        "challenge_response": answer_challenge(&keys["challenge"], &acct.recovery_secret),
        "new_auth_hash": new_password,
        "encrypted_dek": wrap(),
        "encrypted_private_key": wrap(),
    })
}

#[tokio::test]
async fn signup_with_a_root_key_returns_its_slots_and_app_keys_at_login() {
    let router = setup().await;
    let (acct, sent) = signup(&router, true).await;

    let (status, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert_eq!(resp["encrypted_root_key"], sent["encrypted_root_key"]);
    assert_eq!(resp["has_root_key"], true);
    assert_eq!(resp["has_recovery_root_key"], true);
    assert_eq!(resp["recovery_public_key"], acct.recovery_public_key);
    assert_eq!(resp["app_keys"], sent["app_keys"]);
    // The legacy wraps are still there for older clients.
    assert_eq!(resp["encrypted_dek"], sent["encrypted_dek"]);

    let (status, keys) = send(
        &router,
        "GET",
        "/auth/root-key",
        Some(&acct.access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(keys["encrypted_root_key"], sent["encrypted_root_key"]);
    assert_eq!(keys["app_keys"][0]["app"], "todo");
    assert!(
        keys.get("recovery_encrypted_root_key").is_none(),
        "the slot itself stays put"
    );

    // The recovery lookup carries the slot and the todo key, for the client's check.
    let rec = recovery_keys(&router, &acct.email).await;
    assert_eq!(rec["user_id"], acct.user_id);
    let slot = &rec["recovery_encrypted_root_key"];
    assert_eq!(slot["ct"], sent["recovery_encrypted_root_key"]["ct"]);
    assert!(
        slot["epk"].is_string(),
        "a phrase-form slot is padded to the sealed shape"
    );
    assert_eq!(rec["todo_app_key"], sent["app_keys"][0]["wrapped_key"]);
}

#[tokio::test]
async fn signup_root_fields_go_together_and_need_the_todo_key() {
    let router = setup().await;
    let (_, mut body) = signup(&router, true).await;
    body["email"] = json!(format!("root-{}@example.com", Uuid::now_v7()));
    body["user_id"] = json!(Uuid::new_v4());
    let mut partial = body.clone();
    partial
        .as_object_mut()
        .unwrap()
        .remove("recovery_encrypted_root_key");
    let (status, _) = send(&router, "POST", "/auth/signup", None, partial).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut no_todo = body.clone();
    no_todo["app_keys"] = json!([{ "app": "journal", "wrapped_key": wrap() }]);
    let (status, _) = send(&router, "POST", "/auth/signup", None, no_todo).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A key for an app this build does not bundle is refused too.
    let mut unbundled = body.clone();
    let todo = body["app_keys"][0].clone();
    unbundled["app_keys"] = json!([todo, { "app": "notes", "wrapped_key": wrap() }]);
    let (status, _) = send(&router, "POST", "/auth/signup", None, unbundled).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_legacy_account_migrates_once() {
    let router = setup().await;
    let (acct, _) = signup(&router, false).await;
    let (_, resp) = login(&router, &acct.email, PASSWORD).await;
    assert!(resp.get("encrypted_root_key").is_none());
    assert_eq!(resp["has_root_key"], false);
    assert!(resp.get("app_keys").is_none());

    // A wrong password installs nothing.
    let mut wrong = migrate_body(&acct);
    wrong["current_password"] = json!(NEW_PASSWORD);
    let (status, _) = send(&router, "POST", "/auth/root-key", Some(&acct.access), wrong).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let body = migrate_body(&acct);
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/root-key",
        Some(&acct.access),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");

    let (status, resp) = send(
        &router,
        "POST",
        "/auth/root-key",
        Some(&acct.access),
        migrate_body(&acct),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "root_key_exists");

    let (_, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(resp["encrypted_root_key"], body["encrypted_root_key"]);
    assert_eq!(resp["app_keys"], body["app_keys"]);
    assert_eq!(resp["has_recovery_root_key"], true);
}

#[tokio::test]
async fn a_sealed_slot_for_a_stale_recovery_key_is_not_kept() {
    let router = setup().await;
    let (acct, _) = signup(&router, false).await;
    let mut body = migrate_body(&acct);
    body["recovery_public_key"] = json!(hex::encode(random_bytes::<32>()));
    let (status, _) = send(&router, "POST", "/auth/root-key", Some(&acct.access), body).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(resp["has_root_key"], true);
    assert_eq!(resp["has_recovery_root_key"], false);

    // The repair route fills it, once, for the account's own recovery key.
    let put = |key: &str| {
        json!({
            "current_password": PASSWORD,
            "recovery_public_key": key,
            "recovery_encrypted_root_key": sealed_wrap(),
        })
    };
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/root-key/recovery",
        Some(&acct.access),
        put(&hex::encode(random_bytes::<32>())),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/root-key/recovery",
        Some(&acct.access),
        put(&acct.recovery_public_key),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, resp) = send(
        &router,
        "PUT",
        "/auth/root-key/recovery",
        Some(&acct.access),
        put(&acct.recovery_public_key),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "key_already_stored");
}

#[tokio::test]
async fn concurrent_migrations_install_exactly_one_root() {
    let router = setup().await;
    let (acct, _) = signup(&router, false).await;
    let (a, b) = (migrate_body(&acct), migrate_body(&acct));
    let ((sa, _), (sb, _)) = tokio::join!(
        send(
            &router,
            "POST",
            "/auth/root-key",
            Some(&acct.access),
            a.clone()
        ),
        send(
            &router,
            "POST",
            "/auth/root-key",
            Some(&acct.access),
            b.clone()
        ),
    );
    let mut statuses = [sa, sb];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::NO_CONTENT, StatusCode::CONFLICT]);

    // The loser loads the winner's root, whose app keys are the winner's.
    let winner = if sa == StatusCode::NO_CONTENT { a } else { b };
    let (_, keys) = send(
        &router,
        "GET",
        "/auth/root-key",
        Some(&acct.access),
        Value::Null,
    )
    .await;
    assert_eq!(keys["encrypted_root_key"], winner["encrypted_root_key"]);
    assert_eq!(keys["app_keys"], winner["app_keys"]);
}

#[tokio::test]
async fn a_password_change_moves_the_root_slot_with_the_legacy_wraps() {
    let router = setup().await;
    let (acct, _) = signup(&router, true).await;
    let (new_root, new_dek) = (wrap(), wrap());
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": new_dek,
            "encrypted_private_key": wrap(),
            "encrypted_root_key": new_root,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");
    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["encrypted_root_key"], new_root);
    assert_eq!(resp["encrypted_dek"], new_dek);
    assert_eq!(
        resp["has_recovery_root_key"], true,
        "the recovery slot is untouched"
    );
    assert_eq!(resp["app_keys"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_password_change_cannot_install_a_root() {
    let router = setup().await;
    let (acct, _) = signup(&router, false).await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": wrap(),
            "encrypted_private_key": wrap(),
            "encrypted_root_key": wrap(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["has_root_key"], false);
    assert!(resp.get("encrypted_root_key").is_none());
}

#[tokio::test]
async fn an_old_client_password_change_drops_the_root_unless_another_app_holds_a_key() {
    let router = setup().await;
    let legacy_change = |current: &str, new: &str| {
        json!({
            "current_password": current,
            "new_password": new,
            "encrypted_dek": wrap(),
            "encrypted_private_key": wrap(),
        })
    };

    // Only the todo key: the root goes, and the next current client re-creates it.
    let (acct, _) = signup(&router, true).await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        legacy_change(PASSWORD, NEW_PASSWORD),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["has_root_key"], false);
    assert_eq!(resp["has_recovery_root_key"], false);
    assert!(resp.get("app_keys").is_none());

    // Another app's key only the root reaches: refused, and nothing changes.
    let (acct, _) = signup(&router, true).await;
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/app-keys/journal",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        legacy_change(PASSWORD, THIRD_PASSWORD),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "root_key_required");
    let (status, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "the old password still works");
    assert_eq!(resp["app_keys"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn app_keys_are_set_once_and_need_a_root() {
    let router = setup().await;
    let (legacy, _) = signup(&router, false).await;
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/app-keys/journal",
        Some(&legacy.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (acct, _) = signup(&router, true).await;
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/app-keys/Notes",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/app-keys/journal",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, resp) = send(
        &router,
        "PUT",
        "/auth/app-keys/journal",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "key_already_stored");
    let (status, _) = send(
        &router,
        "PUT",
        "/auth/app-keys/todo",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn app_keys_are_only_for_bundled_apps_the_instance_offers() {
    // Not bundled by this build: 400, however well-formed the id.
    let router = setup().await;
    let (acct, _) = signup(&router, true).await;
    for app in ["notes", "bookmarks", "x"] {
        let (status, _) = send(
            &router,
            "PUT",
            &format!("/auth/app-keys/{app}"),
            Some(&acct.access),
            json!({ "wrapped_key": wrap() }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{app}");
    }

    // Bundled, but this instance offers todo only: 403 app_not_enabled, scope instance.
    let todo_only = setup_with(&["todo"]).await;
    let (acct, _) = signup(&todo_only, true).await;
    let (status, resp) = send(
        &todo_only,
        "PUT",
        "/auth/app-keys/journal",
        Some(&acct.access),
        json!({ "wrapped_key": wrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(resp["code"], "app_not_enabled");
    assert_eq!(resp["app"], "journal");
    assert_eq!(resp["scope"], "instance");
    // Nothing was stored: the account still holds only its todo key.
    let (_, resp) = login(&todo_only, &acct.email, PASSWORD).await;
    let apps: Vec<&str> = resp["app_keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k["app"].as_str().unwrap())
        .collect();
    assert_eq!(apps, ["todo"]);
}

#[tokio::test]
async fn recovery_rewraps_the_recovered_root_and_takes_the_phrase_slot() {
    let router = setup().await;
    let (acct, sent) = signup(&router, true).await;
    let keys = recovery_keys(&router, &acct.email).await;
    let (new_root, new_slot) = (wrap(), wrap());
    let mut body = recover_body(&acct, &keys, NEW_PASSWORD);
    body["encrypted_root_key"] = new_root.clone();
    body["recovery_encrypted_root_key"] = new_slot.clone();
    let (status, resp) = send(&router, "POST", "/auth/recover", None, body).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");

    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["encrypted_root_key"], new_root);
    assert_eq!(
        resp["app_keys"], sent["app_keys"],
        "the app keys stay under the same root"
    );
    let rec = recovery_keys(&router, &acct.email).await;
    assert_eq!(rec["recovery_encrypted_root_key"]["ct"], new_slot["ct"]);
}

#[tokio::test]
async fn recovery_re_roots_only_an_account_whose_root_is_unrecoverable() {
    let router = setup().await;
    // A root with a recovery slot is never replaced.
    let (acct, _) = signup(&router, true).await;
    let keys = recovery_keys(&router, &acct.email).await;
    let mut body = recover_body(&acct, &keys, NEW_PASSWORD);
    body["encrypted_root_key"] = wrap();
    body["app_keys"] = json!([todo_key()]);
    let (status, _) = send(&router, "POST", "/auth/recover", None, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(status, StatusCode::OK, "a refused recovery changes nothing");

    // A legacy account (no root at all) gets one with its recovery.
    let (acct, _) = signup(&router, false).await;
    let keys = recovery_keys(&router, &acct.email).await;
    assert!(
        keys["recovery_encrypted_root_key"].is_object(),
        "a dummy, not a null"
    );
    let mut body = recover_body(&acct, &keys, NEW_PASSWORD);
    let (root, app_keys) = (wrap(), json!([todo_key()]));
    body["encrypted_root_key"] = root.clone();
    body["recovery_encrypted_root_key"] = wrap();
    body["app_keys"] = app_keys.clone();
    let (status, resp) = send(&router, "POST", "/auth/recover", None, body).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");
    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["encrypted_root_key"], root);
    assert_eq!(resp["app_keys"], app_keys);
    assert_eq!(resp["has_recovery_root_key"], true);
}

#[tokio::test]
async fn an_old_client_recovery_drops_the_root() {
    let router = setup().await;
    let (acct, _) = signup(&router, true).await;
    let keys = recovery_keys(&router, &acct.email).await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(&acct, &keys, NEW_PASSWORD),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, resp) = login(&router, &acct.email, NEW_PASSWORD).await;
    assert_eq!(resp["has_root_key"], false);
}

#[tokio::test]
async fn replacing_the_phrase_replaces_or_empties_the_recovery_slot() {
    let router = setup().await;
    let (acct, _) = signup(&router, true).await;
    let replace = |slot: Option<Value>| {
        let mut body = json!({
            "current_password": PASSWORD,
            "recovery_public_key": hex::encode(random_bytes::<32>()),
            "recovery_encrypted_dek": legacy_wrap(),
            "recovery_encrypted_private_key": legacy_wrap(),
        });
        if let Some(slot) = slot {
            body["recovery_encrypted_root_key"] = slot;
        }
        body
    };
    let slot = wrap();
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recovery-key/replace",
        Some(&acct.access),
        replace(Some(slot.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        recovery_keys(&router, &acct.email).await["recovery_encrypted_root_key"]["ct"],
        slot["ct"]
    );

    // An old client sends no slot: the old phrase's one must not survive.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recovery-key/replace",
        Some(&acct.access),
        replace(None),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(resp["has_root_key"], true);
    assert_eq!(resp["has_recovery_root_key"], false);
}

#[tokio::test]
async fn an_api_token_session_never_reaches_the_root_key() {
    let router = setup().await;
    let (acct, _) = signup(&router, false).await;
    let token_id = Uuid::new_v4();
    let auth = hex::encode(random_bytes::<32>());
    let (status, _) = send(
        &router,
        "POST",
        "/auth/api-tokens",
        Some(&acct.access),
        json!({
            "id": token_id, "name": "n8n", "auth": auth,
            "wrapped_dek": wrap(), "wrapped_private_key": wrap(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, session) = send(
        &router,
        "POST",
        "/auth/api-token/session",
        None,
        json!({ "token_id": token_id, "auth": auth }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a token session still opens");
    assert!(session.get("encrypted_root_key").is_none() && session.get("app_keys").is_none());
    let pat = session["access_token"].as_str().unwrap();

    let attempts = [
        ("GET", "/auth/root-key", Value::Null),
        ("POST", "/auth/root-key", migrate_body(&acct)),
        (
            "PUT",
            "/auth/root-key/recovery",
            json!({
                "current_password": PASSWORD,
                "recovery_public_key": acct.recovery_public_key,
                "recovery_encrypted_root_key": sealed_wrap(),
            }),
        ),
        (
            "PUT",
            "/auth/app-keys/journal",
            json!({ "wrapped_key": wrap() }),
        ),
    ];
    for (method, uri, body) in attempts {
        let (status, resp) = send(&router, method, uri, Some(pat), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
        assert_eq!(resp["code"], "interactive_session_required");
    }
    // And the account is still unmigrated: nothing above landed.
    let (_, resp) = login(&router, &acct.email, PASSWORD).await;
    assert_eq!(resp["has_root_key"], false);
}

/// Every string leaf replaced by its length.
fn shape(value: &Value) -> Value {
    match value {
        Value::String(s) => json!(s.len()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), shape(v))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(shape).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn the_recovery_lookup_does_not_tell_a_migrated_account_or_its_slot_form() {
    let router = setup().await;
    let (phrase_form, _) = signup(&router, true).await;
    let (sealed_form, _) = signup(&router, false).await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/root-key",
        Some(&sealed_form.access),
        migrate_body(&sealed_form),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (legacy, _) = signup(&router, false).await;
    let unknown = format!("root-{}@example.com", Uuid::now_v7());

    let reference = shape(&recovery_keys(&router, &phrase_form.email).await);
    for email in [&sealed_form.email, &legacy.email, &unknown] {
        assert_eq!(
            shape(&recovery_keys(&router, email).await),
            reference,
            "{email}"
        );
    }
    let dummy = recovery_keys(&router, &unknown).await;
    let again = recovery_keys(&router, &unknown).await;
    for field in ["user_id", "recovery_encrypted_root_key", "todo_app_key"] {
        assert_eq!(dummy[field], again[field], "{field} is deterministic");
    }
}
