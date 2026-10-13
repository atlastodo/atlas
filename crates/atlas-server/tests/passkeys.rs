//! Integration tests for passkeys (`/auth/passkeys/*`, passkey signup, re-authentication proofs,
//! passkey-only accounts). Responses come from the software authenticator in
//! `atlas_server::auth::webauthn::soft`; the root wraps are random, as the server only stores
//! them. Runs against `TEST_DATABASE_URL`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use atlas_server::auth::webauthn::soft::SoftAuthenticator;
use atlas_server::config::{AndroidAssetLinks, Config, PasskeyConfig};
use atlas_server::{app, db, state::AppState};
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
const RP_ID: &str = "todo.example.com";
const ORIGIN: &str = "https://todo.example.com";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

fn config(passkeys: bool) -> Config {
    Config {
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
        apps: vec!["todo".into()],
        passkeys: passkeys.then(|| PasskeyConfig {
            rp_id: RP_ID.into(),
            rp_name: "Atlas Todo".into(),
            origins: vec![ORIGIN.into(), "android:apk-key-hash:abc".into()],
        }),
        android_asset_links: passkeys.then(|| AndroidAssetLinks {
            package: "dev.example.atlas".into(),
            cert_fingerprints: vec!["AB".repeat(32)],
        }),
    }
}

async fn setup_with(passkeys: bool) -> Router {
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    app(AppState::new(pool, config(passkeys)))
}

async fn setup() -> Router {
    setup_with(true).await
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
        .header("content-type", "application/json");
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
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

fn wrap() -> Value {
    json!({
        "v": 1,
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

fn legacy_wrap() -> Value {
    json!({
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

struct Account {
    email: String,
    user_id: Uuid,
    access: String,
    recovery_secret: StaticSecret,
}

fn base_signup(email: &str, user_id: Uuid, recovery_secret: &StaticSecret) -> Value {
    json!({
        "email": email,
        "salt": hex::encode(random_bytes::<16>()),
        "public_key": hex::encode(random_bytes::<32>()),
        "recovery_public_key": hex::encode(PublicKey::from(recovery_secret).as_bytes()),
        "recovery_encrypted_dek": legacy_wrap(),
        "recovery_encrypted_private_key": legacy_wrap(),
        "user_id": user_id,
        "recovery_encrypted_root_key": wrap(),
        "app_keys": [{ "app": "todo", "wrapped_key": wrap(), "wrapped_private_key": wrap() }],
    })
}

fn new_email() -> String {
    format!("passkey-{}@example.com", Uuid::now_v7())
}

/// Sign up with a password and a root key.
async fn password_signup(router: &Router) -> Account {
    let email = new_email();
    let user_id = Uuid::new_v4();
    let recovery_secret = StaticSecret::from(random_bytes::<32>());
    let mut body = base_signup(&email, user_id, &recovery_secret);
    body["password"] = json!(PASSWORD);
    body["encrypted_dek"] = wrap();
    body["encrypted_private_key"] = wrap();
    body["encrypted_root_key"] = wrap();
    let (status, resp) = send(router, "POST", "/auth/signup", None, body).await;
    assert_eq!(status, StatusCode::CREATED, "{resp:?}");
    assert_eq!(resp["user"]["has_password"], true);
    Account {
        email,
        user_id,
        access: resp["access_token"].as_str().unwrap().into(),
        recovery_secret,
    }
}

async fn signup_options(router: &Router, email: &str, user_id: Uuid) -> Value {
    let (status, resp) = send(
        router,
        "POST",
        "/auth/passkeys/signup/options",
        None,
        json!({ "user_id": user_id, "email": email, "display_name": "Ann" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    resp["options"].clone()
}

/// Sign up with a passkey instead of a password. Returns the account, its authenticator and the
/// wrap it stored.
async fn passkey_signup(router: &Router, seed: u8) -> (Account, SoftAuthenticator, Value) {
    let email = new_email();
    let user_id = Uuid::new_v4();
    let recovery_secret = StaticSecret::from(random_bytes::<32>());
    let options = signup_options(router, &email, user_id).await;
    assert_eq!(options["user"]["name"], email);
    assert_eq!(options["rp"]["id"], RP_ID);
    let mut auth = SoftAuthenticator::p256(seed, user_id.as_bytes());
    auth.credential_id = random_bytes::<16>().to_vec();
    let slot_wrap = wrap();
    let mut body = base_signup(&email, user_id, &recovery_secret);
    body["passkey"] = json!({
        "credential": auth.register(&options, ORIGIN, true),
        "name": "Laptop",
        "encrypted_root_key": slot_wrap,
    });
    let (status, resp) = send(router, "POST", "/auth/signup", None, body).await;
    assert_eq!(status, StatusCode::CREATED, "{resp:?}");
    assert_eq!(resp["user"]["has_password"], false);
    assert!(resp.get("encrypted_root_key").is_none());
    assert!(resp.get("encrypted_dek").is_none());
    assert_eq!(resp["passkey"]["credential_id"], auth.credential_id_b64());
    assert_eq!(resp["passkey"]["encrypted_root_key"], slot_wrap);
    (
        Account {
            email,
            user_id,
            access: resp["access_token"].as_str().unwrap().into(),
            recovery_secret,
        },
        auth,
        slot_wrap,
    )
}

async fn login_options(router: &Router, email: Option<&str>) -> Value {
    let body = match email {
        Some(e) => json!({ "email": e }),
        None => json!({}),
    };
    let (status, resp) = send(router, "POST", "/auth/passkeys/login/options", None, body).await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    resp["options"].clone()
}

async fn passkey_login(router: &Router, auth: &mut SoftAuthenticator) -> (StatusCode, Value) {
    let options = login_options(router, None).await;
    let credential = auth.assert(&options, RP_ID, ORIGIN, true);
    send(
        router,
        "POST",
        "/auth/passkeys/login",
        None,
        json!({ "credential": credential, "device_name": "Phone" }),
    )
    .await
}

async fn reauth(router: &Router, access: &str, auth: &mut SoftAuthenticator) -> String {
    let (status, resp) = send(
        router,
        "POST",
        "/auth/passkeys/reauth/options",
        Some(access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    let credential = auth.assert(&resp["options"], RP_ID, ORIGIN, true);
    let (status, resp) = send(
        router,
        "POST",
        "/auth/passkeys/reauth",
        Some(access),
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert_eq!(resp["passkey"]["credential_id"], auth.credential_id_b64());
    resp["reauth_token"].as_str().unwrap().into()
}

/// Add a passkey to a signed-in account, proving it with `proof` (`current_password` or
/// `reauth_token`).
async fn add_passkey(
    router: &Router,
    acct: &Account,
    seed: u8,
    proof: Value,
) -> (StatusCode, Value, SoftAuthenticator) {
    let (status, resp) = send(
        router,
        "POST",
        "/auth/passkeys/register/options",
        Some(&acct.access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    let options = resp["options"].clone();
    let mut auth = SoftAuthenticator::ed25519(seed, acct.user_id.as_bytes());
    auth.credential_id = random_bytes::<20>().to_vec();
    let mut body = json!({
        "credential": auth.register(&options, ORIGIN, true),
        "name": "Security key",
        "encrypted_root_key": wrap(),
    });
    for (k, v) in proof.as_object().unwrap() {
        body[k] = v.clone();
    }
    let (status, resp) = send(router, "POST", "/auth/passkeys", Some(&acct.access), body).await;
    (status, resp, auth)
}

async fn list(router: &Router, access: &str) -> Vec<Value> {
    let (status, resp) = send(router, "GET", "/auth/passkeys", Some(access), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    resp.as_array().unwrap().clone()
}

#[tokio::test]
async fn routes_are_off_without_an_rp_id_and_discovery_says_so() {
    let off = setup_with(false).await;
    let (status, resp) = send(
        &off,
        "POST",
        "/auth/passkeys/login/options",
        None,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(resp["code"], "passkeys_disabled");
    let (_, disc) = send(&off, "GET", "/discovery", None, Value::Null).await;
    assert!(!disc["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("passkeys")));
    let (status, _) = send(
        &off,
        "GET",
        "/.well-known/assetlinks.json",
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let on = setup().await;
    let (_, disc) = send(&on, "GET", "/discovery", None, Value::Null).await;
    assert!(disc["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("passkeys")));
    let (status, links) = send(
        &on,
        "GET",
        "/.well-known/assetlinks.json",
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        links[0]["relation"][0],
        "delegate_permission/common.get_login_creds"
    );
    assert_eq!(links[0]["target"]["package_name"], "dev.example.atlas");
}

#[tokio::test]
async fn a_passkey_only_account_signs_in_with_its_passkey_and_not_a_password() {
    let router = setup().await;
    let (acct, mut auth, slot_wrap) = passkey_signup(&router, 11).await;

    // No password to guess: a password login answers like a wrong one.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": acct.email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Discoverable sign-in: a full session plus the passkey's root slot.
    let (status, resp) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert_eq!(resp["user"]["id"], acct.user_id.to_string());
    assert!(resp["refresh_token"].is_string());
    assert_eq!(resp["passkey"]["encrypted_root_key"], slot_wrap);
    assert_eq!(resp["app_keys"][0]["app"], "todo");
    assert_eq!(resp["has_root_key"], true);
    assert_eq!(resp["device_name"], "Phone");

    // Email-first sign-in names the account's passkey, with its PRF input.
    let options = login_options(&router, Some(&acct.email)).await;
    let id = auth.credential_id_b64();
    assert_eq!(options["allowCredentials"][0]["id"], id);
    assert!(options["extensions"]["prf"]["evalByCredential"][&id]["first"].is_string());
    let credential = auth.assert(&options, RP_ID, ORIGIN, true);
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/passkeys/login",
        None,
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");

    // An unknown email gets a stand-in credential, not an empty list.
    let options = login_options(&router, Some(&new_email())).await;
    assert_eq!(options["allowCredentials"].as_array().unwrap().len(), 1);

    let listed = list(&router, &acct.access).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "Laptop");
    assert!(listed[0]["last_used_at"].is_number());
}

#[tokio::test]
async fn ceremonies_are_single_use_and_bound_to_origin_and_account() {
    let router = setup().await;
    let (acct, mut auth, _) = passkey_signup(&router, 12).await;

    let options = login_options(&router, None).await;
    let credential = auth.assert(&options, RP_ID, ORIGIN, true);
    let body = json!({ "credential": credential });
    let (status, _) = send(&router, "POST", "/auth/passkeys/login", None, body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&router, "POST", "/auth/passkeys/login", None, body).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a replay");

    // Another origin.
    let options = login_options(&router, None).await;
    let credential = auth.assert(&options, RP_ID, "https://evil.example", true);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/passkeys/login",
        None,
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The Android app's origin is allowed.
    let options = login_options(&router, None).await;
    let credential = auth.assert(&options, RP_ID, "android:apk-key-hash:abc", true);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/passkeys/login",
        None,
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A signup ceremony belongs to the account id it was begun for.
    let email = new_email();
    let options = signup_options(&router, &email, Uuid::new_v4()).await;
    let other_id = Uuid::new_v4();
    let secret = StaticSecret::from(random_bytes::<32>());
    let mut body = base_signup(&email, other_id, &secret);
    let mut other = SoftAuthenticator::p256(13, other_id.as_bytes());
    other.credential_id = random_bytes::<16>().to_vec();
    body["passkey"] = json!({
        "credential": other.register(&options, ORIGIN, true),
        "encrypted_root_key": wrap(),
    });
    let (status, resp) = send(&router, "POST", "/auth/signup", None, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{resp:?}");
    assert_eq!(resp["code"], "passkey_invalid");

    // A user handle that is not the passkey's account.
    let options = login_options(&router, None).await;
    auth.user_handle = Uuid::new_v4().as_bytes().to_vec();
    let credential = auth.assert(&options, RP_ID, ORIGIN, true);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/passkeys/login",
        None,
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = acct;
}

#[tokio::test]
async fn registration_requires_prf_and_never_takes_its_output() {
    let router = setup().await;
    let email = new_email();
    let user_id = Uuid::new_v4();
    let secret = StaticSecret::from(random_bytes::<32>());
    let options = signup_options(&router, &email, user_id).await;
    let auth = SoftAuthenticator::p256(14, user_id.as_bytes());
    let mut body = base_signup(&email, user_id, &secret);
    body["passkey"] = json!({
        "credential": auth.register(&options, ORIGIN, false),
        "encrypted_root_key": wrap(),
    });
    let (status, resp) = send(&router, "POST", "/auth/signup", None, body.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(resp["code"], "passkey_prf_unsupported");

    let mut leaked = auth.register(&options, ORIGIN, true);
    leaked["clientExtensionResults"]["prf"]["results"] = json!({ "first": "AAAA" });
    body["passkey"]["credential"] = leaked;
    let (status, _) = send(&router, "POST", "/auth/signup", None, body.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A passkey signup carries no password slot.
    body["passkey"]["credential"] = auth.register(&options, ORIGIN, true);
    body["encrypted_root_key"] = wrap();
    let (status, _) = send(&router, "POST", "/auth/signup", None, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn adding_a_passkey_needs_a_proof_and_reauth_proofs_are_single_use() {
    let router = setup().await;
    let acct = password_signup(&router).await;

    let (status, _, _) = add_passkey(&router, &acct, 21, json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no proof");
    let (status, _, _) = add_passkey(
        &router,
        &acct,
        22,
        json!({ "current_password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a wrong password");
    let (status, view, mut auth) =
        add_passkey(&router, &acct, 23, json!({ "current_password": PASSWORD })).await;
    assert_eq!(status, StatusCode::CREATED, "{view:?}");
    assert_eq!(view["name"], "Security key");

    // Rename.
    let id = view["id"].as_str().unwrap();
    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/auth/passkeys/{id}"),
        Some(&acct.access),
        json!({ "name": "YubiKey" }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(list(&router, &acct.access).await[0]["name"], "YubiKey");

    // A proof stands in for the password once.
    let token = reauth(&router, &acct.access, &mut auth).await;
    let (status, _, _) = add_passkey(&router, &acct, 24, json!({ "reauth_token": token })).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = add_passkey(&router, &acct, 25, json!({ "reauth_token": token })).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "spent");
    assert_eq!(list(&router, &acct.access).await.len(), 2);

    // Another account's passkey cannot re-authenticate this one.
    let other = password_signup(&router).await;
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/passkeys/reauth/options",
        Some(&acct.access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let credential = auth.assert(&resp["options"], RP_ID, ORIGIN, true);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/passkeys/reauth",
        Some(&other.access),
        json!({ "credential": credential }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A password account removes passkeys freely (with a proof), down to none.
    let token = reauth(&router, &acct.access, &mut auth).await;
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/passkeys/{id}"),
        Some(&acct.access),
        json!({ "reauth_token": token }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let remaining = list(&router, &acct.access).await;
    let last = remaining[0]["id"].as_str().unwrap();
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/passkeys/{last}"),
        Some(&acct.access),
        json!({ "current_password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn the_last_way_in_cannot_be_removed() {
    let router = setup().await;
    let (acct, mut auth, _) = passkey_signup(&router, 31).await;
    let id = list(&router, &acct.access).await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let token = reauth(&router, &acct.access, &mut auth).await;
    let (status, resp) = send(
        &router,
        "DELETE",
        &format!("/auth/passkeys/{id}"),
        Some(&acct.access),
        json!({ "reauth_token": token }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "last_unlock_method");
    assert_eq!(list(&router, &acct.access).await.len(), 1);

    // A password account without passkeys cannot drop its password.
    let pw = password_signup(&router).await;
    let (status, resp) = send(
        &router,
        "DELETE",
        "/auth/password",
        Some(&pw.access),
        json!({ "current_password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(resp["code"], "last_unlock_method");
}

#[tokio::test]
async fn a_passkey_only_account_adds_a_password_and_can_drop_it_again() {
    let router = setup().await;
    let (acct, mut auth, slot_wrap) = passkey_signup(&router, 41).await;

    // Adding a password needs a proof (there is no current password) and the root's new slot.
    let mut body = json!({
        "new_password": NEW_PASSWORD,
        "encrypted_dek": wrap(),
        "encrypted_private_key": wrap(),
        "kdf_version": 1,
        "kdf_params": { "iterations": 600000 },
    });
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    body["reauth_token"] = json!(reauth(&router, &acct.access, &mut auth).await);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no encrypted_root_key");
    body["reauth_token"] = json!(reauth(&router, &acct.access, &mut auth).await);
    body["encrypted_root_key"] = wrap();
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&acct.access),
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");

    let (status, resp) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": acct.email, "password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    assert_eq!(resp["user"]["has_password"], true);
    assert_eq!(resp["encrypted_root_key"], body["encrypted_root_key"]);
    // The passkey kept its slot (the root did not change), and the session survived.
    let (status, resp) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resp["passkey"]["encrypted_root_key"], slot_wrap);
    let (status, _) = send(&router, "GET", "/auth/me", Some(&acct.access), Value::Null).await;
    assert_eq!(status, StatusCode::OK);

    // And back to passkey-only, with the password as the proof.
    let (status, _) = send(
        &router,
        "DELETE",
        "/auth/password",
        Some(&acct.access),
        json!({ "current_password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, me) = send(&router, "GET", "/auth/me", Some(&acct.access), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["has_password"], false);
    let (status, resp) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::OK);
    assert!(resp.get("encrypted_root_key").is_none());
    assert!(resp.get("encrypted_dek").is_none());
}

#[tokio::test]
async fn sensitive_routes_take_a_passkey_proof_instead_of_the_password() {
    let router = setup().await;
    let (acct, mut auth, _) = passkey_signup(&router, 51).await;

    let new_key = StaticSecret::from(random_bytes::<32>());
    let replace = |token: String| {
        json!({
            "reauth_token": token,
            "recovery_public_key": hex::encode(PublicKey::from(&new_key).as_bytes()),
            "recovery_encrypted_dek": legacy_wrap(),
            "recovery_encrypted_private_key": legacy_wrap(),
            "recovery_encrypted_root_key": wrap(),
        })
    };
    let token = reauth(&router, &acct.access, &mut auth).await;
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/recovery-key/replace",
        Some(&acct.access),
        replace(token.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recovery-key/replace",
        Some(&acct.access),
        replace(token),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a spent proof");
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recovery-key/replace",
        Some(&acct.access),
        replace("made-up".into()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Scheduling the deletion drops the passkeys: they no longer sign in.
    let token = reauth(&router, &acct.access, &mut auth).await;
    let (status, _) = send(
        &router,
        "DELETE",
        "/auth/account",
        Some(&acct.access),
        json!({ "reauth_token": token }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_api_token_session_reaches_no_passkey_route() {
    let router = setup().await;
    let acct = password_signup(&router).await;
    let token_id = Uuid::new_v4();
    let auth_value = hex::encode(random_bytes::<32>());
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/api-tokens",
        Some(&acct.access),
        json!({
            "id": token_id,
            "name": "n8n",
            "auth": auth_value,
            "wrapped_dek": wrap(),
            "wrapped_private_key": wrap(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{resp:?}");
    let (status, session) = send(
        &router,
        "POST",
        "/auth/api-token/session",
        None,
        json!({ "token_id": token_id, "auth": auth_value }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session:?}");
    let api = session["access_token"].as_str().unwrap();
    for (method, uri) in [
        ("GET", "/auth/passkeys"),
        ("POST", "/auth/passkeys"),
        ("POST", "/auth/passkeys/register/options"),
        ("POST", "/auth/passkeys/reauth/options"),
        ("POST", "/auth/passkeys/reauth"),
        (
            "PATCH",
            "/auth/passkeys/00000000-0000-0000-0000-000000000000",
        ),
        (
            "DELETE",
            "/auth/passkeys/00000000-0000-0000-0000-000000000000",
        ),
        ("DELETE", "/auth/password"),
    ] {
        let (status, resp) = send(&router, method, uri, Some(api), json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {resp:?}");
        assert_eq!(
            resp["code"], "interactive_session_required",
            "{method} {uri}"
        );
    }
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

#[tokio::test]
async fn recovery_of_a_passkey_only_account_sets_a_password_and_drops_the_passkeys() {
    let router = setup().await;
    let (acct, mut auth, _) = passkey_signup(&router, 61).await;
    let (status, keys) = send(
        &router,
        "GET",
        &format!("/auth/recovery-keys?email={}", acct.email),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        json!({
            "email": acct.email,
            "challenge_token": keys["challenge"]["token"],
            "challenge_response": answer_challenge(&keys["challenge"], &acct.recovery_secret),
            "new_auth_hash": NEW_PASSWORD,
            "encrypted_dek": wrap(),
            "encrypted_private_key": wrap(),
            "encrypted_root_key": wrap(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");
    let (status, _) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the passkey is gone");
    let (status, resp) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": acct.email, "password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp:?}");
    let access = resp["access_token"].as_str().unwrap();
    assert!(list(&router, access).await.is_empty());
}

#[tokio::test]
async fn a_password_change_keeps_the_passkeys() {
    let router = setup().await;
    let acct = password_signup(&router).await;
    let (status, _, mut auth) =
        add_passkey(&router, &acct, 71, json!({ "current_password": PASSWORD })).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, resp) = send(
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
    assert_eq!(status, StatusCode::NO_CONTENT, "{resp:?}");
    let (status, _) = passkey_login(&router, &mut auth).await;
    assert_eq!(status, StatusCode::OK);
}
