//! Integration tests for the per-account password KDF (`kdf_version`, `kdf_params`) and for
//! replacing the recovery phrase. Runs against the Postgres given by `TEST_DATABASE_URL`; every
//! test uses fresh emails, so the shared database needs no reset.

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

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> Router {
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
        static_dir: None,
    };
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    app(AppState::new(pool, config))
}

async fn test_pool() -> sqlx::PgPool {
    db::connect(&test_database_url()).await.expect("connect")
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
        .header(
            atlas_server::sync::SYNC_PROTOCOL_HEADER,
            atlas_server::sync::MIN_SYNC_PROTOCOL.to_string(),
        );
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

fn unique_email() -> String {
    format!("kdf-{}@example.com", Uuid::now_v7())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// A derived credential: 32 bytes of hex, as every client sends.
fn auth_hash() -> String {
    hex::encode(random_bytes::<32>())
}

/// A wrapped 32-byte key as the client stores one.
fn wrapped_key() -> Value {
    json!({
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

fn public_key_of(secret: &StaticSecret) -> String {
    hex::encode(PublicKey::from(secret).as_bytes())
}

fn current_kdf() -> Value {
    json!({ "iterations": 3, "memory_kib": 65536, "parallelism": 1 })
}

fn legacy_kdf() -> Value {
    json!({ "iterations": 600000 })
}

/// An account as a client creates it, with both X25519 secrets kept by the test.
struct Account {
    email: String,
    auth_hash: String,
    device_secret: StaticSecret,
    recovery_secret: StaticSecret,
}

impl Account {
    fn new() -> Self {
        Account {
            email: unique_email(),
            auth_hash: auth_hash(),
            device_secret: StaticSecret::from(random_bytes::<32>()),
            recovery_secret: StaticSecret::from(random_bytes::<32>()),
        }
    }

    /// The signup body a client from before versioned KDFs sends: no KDF fields.
    fn legacy_signup_body(&self) -> Value {
        json!({
            "email": self.email,
            "password": self.auth_hash,
            "salt": hex::encode(random_bytes::<16>()),
            "public_key": public_key_of(&self.device_secret),
            "recovery_public_key": public_key_of(&self.recovery_secret),
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
            "recovery_encrypted_dek": wrapped_key(),
            "recovery_encrypted_private_key": wrapped_key(),
        })
    }

    fn signup_body(&self) -> Value {
        let mut body = self.legacy_signup_body();
        body["kdf_version"] = json!(2);
        body["kdf_params"] = current_kdf();
        body
    }

    async fn signup_with(&self, router: &Router, body: Value) -> Value {
        let (status, response) = send(router, "POST", "/auth/signup", None, body).await;
        assert_eq!(status, StatusCode::CREATED, "signup: {response:?}");
        response
    }

    async fn login(&self, router: &Router, password: &str) -> (StatusCode, Value) {
        send(
            router,
            "POST",
            "/auth/login",
            None,
            json!({ "email": self.email, "password": password }),
        )
        .await
    }
}

async fn salt_lookup(router: &Router, email: &str) -> Value {
    let (status, body) = send(
        router,
        "GET",
        &format!("/auth/salt?email={email}"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    body
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

async fn refresh_status(router: &Router, refresh_token: &Value) -> StatusCode {
    send(
        router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh_token }),
    )
    .await
    .0
}

/// Every string leaf replaced by its length, so two answers of the same shape compare equal.
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

/// Unseal a recovery challenge as the client's `unsealKey` does; `None` when `secret` cannot.
fn answer_challenge(challenge: &Value, secret: &StaticSecret) -> Option<String> {
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
        .decrypt(&Nonce::try_from(iv.as_slice()).ok()?, ct.as_slice())
        .ok()?;
    Some(hex::encode(nonce))
}

async fn recover(
    router: &Router,
    email: &str,
    challenge: &Value,
    response: &str,
    extra: Value,
) -> (StatusCode, Value) {
    let mut body = json!({
        "email": email,
        "challenge_token": challenge["token"],
        "challenge_response": response,
        "new_auth_hash": auth_hash(),
        "encrypted_dek": wrapped_key(),
        "encrypted_private_key": wrapped_key(),
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    send(router, "POST", "/auth/recover", None, body).await
}

// ---------- The KDF ----------

#[tokio::test]
async fn the_salt_lookup_names_the_accounts_kdf_and_the_current_one_for_unknown_addresses() {
    let router = setup().await;

    let unknown = salt_lookup(&router, &unique_email()).await;
    assert_eq!(unknown["kdf_version"], 2, "{unknown:?}");
    assert_eq!(unknown["kdf_params"], current_kdf());

    // An account a client from before versioned KDFs created is version 1.
    let legacy = Account::new();
    let signup = legacy
        .signup_with(&router, legacy.legacy_signup_body())
        .await;
    assert_eq!(signup["kdf_version"], 1, "{signup:?}");
    assert_eq!(signup["kdf_params"], legacy_kdf());
    let lookup = salt_lookup(&router, &legacy.email).await;
    assert_eq!(lookup["kdf_version"], 1);
    assert_eq!(lookup["kdf_params"], legacy_kdf());

    // A current account answers exactly like an unknown address, field for field.
    let current = Account::new();
    current.signup_with(&router, current.signup_body()).await;
    let lookup = salt_lookup(&router, &current.email).await;
    assert_eq!(lookup["kdf_version"], 2);
    assert_eq!(lookup["kdf_params"], current_kdf());
    assert_eq!(shape(&lookup), shape(&unknown));
    assert_eq!(
        serde_json::to_string(&lookup["kdf_params"]).unwrap(),
        serde_json::to_string(&unknown["kdf_params"]).unwrap(),
        "the same bytes, key order included"
    );

    // Login hands the KDF out with the wrapped keys it derives the unwrapping key for.
    let (status, login) = current.login(&router, &current.auth_hash).await;
    assert_eq!(status, StatusCode::OK, "{login:?}");
    assert_eq!(login["kdf_version"], 2);
    assert_eq!(login["kdf_params"], current_kdf());
    let (status, refreshed) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": login["refresh_token"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(refreshed["kdf_version"], 2);
}

#[tokio::test]
async fn signup_refuses_kdf_parameters_a_client_would_refuse() {
    let router = setup().await;
    let refused = [
        (
            json!(2),
            json!({ "iterations": 3, "memory_kib": 1024, "parallelism": 1 }),
        ),
        (
            json!(2),
            json!({ "iterations": 1, "memory_kib": 65536, "parallelism": 1 }),
        ),
        (json!(2), json!({ "iterations": 3, "memory_kib": 65536 })),
        (json!(1), json!({ "iterations": 1000 })),
        (json!(3), current_kdf()),
        (json!(2), Value::Null),
    ];
    for (version, params) in refused {
        let account = Account::new();
        let mut body = account.legacy_signup_body();
        body["kdf_version"] = version.clone();
        if !params.is_null() {
            body["kdf_params"] = params.clone();
        }
        let (status, response) = send(&router, "POST", "/auth/signup", None, body).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{version} {params}: {response:?}"
        );
        let (status, _) = account.login(&router, &account.auth_hash).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "no account was created");
    }
}

#[tokio::test]
async fn a_kdf_upgrade_moves_the_account_and_keeps_every_session() {
    let router = setup().await;
    let account = Account::new();
    let signup = account
        .signup_with(&router, account.legacy_signup_body())
        .await;
    let (_, other) = account.login(&router, &account.auth_hash).await;
    let access = other["access_token"].as_str().unwrap();

    let upgraded = auth_hash();
    let new_dek = wrapped_key();
    let new_priv = wrapped_key();
    let upgrade = |current: &str, new: &str| {
        json!({
            "current_password": current,
            "new_password": new,
            "encrypted_dek": new_dek,
            "encrypted_private_key": new_priv,
            "kdf_version": 2,
            "kdf_params": current_kdf(),
            "kdf_upgrade": true,
        })
    };
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        upgrade(&account.auth_hash, &upgraded),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

    // Nothing about the password changed, so no device is signed out.
    assert_eq!(
        refresh_status(&router, &signup["refresh_token"]).await,
        StatusCode::OK
    );
    assert_eq!(
        refresh_status(&router, &other["refresh_token"]).await,
        StatusCode::OK
    );

    let lookup = salt_lookup(&router, &account.email).await;
    assert_eq!(lookup["kdf_version"], 2);
    assert_eq!(lookup["salt"], signup["salt"], "the salt is kept");
    let (status, _) = account.login(&router, &account.auth_hash).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the version-1 credential is dead"
    );
    let (status, login) = account.login(&router, &upgraded).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(login["kdf_version"], 2);
    assert_eq!(login["encrypted_dek"], new_dek);
    assert_eq!(login["encrypted_private_key"], new_priv);
    let access = login["access_token"].as_str().unwrap();

    // Only ever to a newer version: once current, it is a plain password change or nothing.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        upgrade(&upgraded, &auth_hash()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    // A second device still holding the version-1 credential cannot upgrade over the first.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        upgrade(&account.auth_hash, &auth_hash()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "invalid_credentials");
    let (status, _) = account.login(&router, &upgraded).await;
    assert_eq!(status, StatusCode::OK, "the account is unchanged");
}

#[tokio::test]
async fn a_password_change_stores_the_kdf_it_names() {
    let router = setup().await;
    let account = Account::new();
    let signup = account.signup_with(&router, account.signup_body()).await;
    let access = signup["access_token"].as_str().unwrap();

    // A client from before versioned KDFs names none: it derived with version 1.
    let legacy_hash = auth_hash();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": account.auth_hash,
            "new_password": legacy_hash,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    assert_eq!(salt_lookup(&router, &account.email).await["kdf_version"], 1);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": legacy_hash,
            "new_password": auth_hash(),
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
            "kdf_version": 2,
            "kdf_params": { "iterations": 3, "memory_kib": 1024, "parallelism": 1 },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    assert_eq!(
        salt_lookup(&router, &account.email).await["kdf_version"],
        1,
        "a refused change stores nothing"
    );

    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": legacy_hash,
            "new_password": auth_hash(),
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
            "kdf_version": 2,
            "kdf_params": current_kdf(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let lookup = salt_lookup(&router, &account.email).await;
    assert_eq!(lookup["kdf_version"], 2);
    assert_eq!(lookup["kdf_params"], current_kdf());
}

#[tokio::test]
async fn recovery_stores_the_kdf_of_the_new_credential() {
    let router = setup().await;
    let account = Account::new();
    account
        .signup_with(&router, account.legacy_signup_body())
        .await;

    let keys = recovery_keys(&router, &account.email).await;
    let response = answer_challenge(&keys["challenge"], &account.recovery_secret).unwrap();
    let (status, body) = recover(
        &router,
        &account.email,
        &keys["challenge"],
        &response,
        json!({ "kdf_version": 2, "kdf_params": { "iterations": 3 } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");

    let (status, body) = recover(
        &router,
        &account.email,
        &keys["challenge"],
        &response,
        json!({ "kdf_version": 2, "kdf_params": current_kdf() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let lookup = salt_lookup(&router, &account.email).await;
    assert_eq!(lookup["kdf_version"], 2);
    assert_eq!(lookup["kdf_params"], current_kdf());
}

#[tokio::test]
async fn existing_rows_are_version_1() {
    let router = setup().await;
    let account = Account::new();
    account.signup_with(&router, account.signup_body()).await;
    // A row as it stood before the column existed gets the column defaults.
    sqlx::query("UPDATE users SET kdf_version = DEFAULT, kdf_params = DEFAULT WHERE email = $1")
        .bind(&account.email)
        .execute(&test_pool().await)
        .await
        .unwrap();
    let lookup = salt_lookup(&router, &account.email).await;
    assert_eq!(lookup["kdf_version"], 1);
    assert_eq!(lookup["kdf_params"], legacy_kdf());
}

#[tokio::test]
async fn the_export_carries_the_kdf_with_the_wrapped_keys() {
    let router = setup().await;
    let account = Account::new();
    let signup = account.signup_with(&router, account.signup_body()).await;
    let (status, export) = send(
        &router,
        "GET",
        "/auth/export",
        signup["access_token"].as_str(),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(export["account"]["kdf_version"], 2);
    assert_eq!(export["account"]["kdf_params"], current_kdf());
}

// ---------- Replacing the recovery phrase ----------

async fn replace_recovery_key(
    router: &Router,
    access: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    send(router, "POST", "/auth/recovery-key/replace", access, body).await
}

async fn stored_recovery(email: &str) -> (Option<String>, Option<Value>, Option<Value>) {
    sqlx::query_as(
        "SELECT recovery_public_key, recovery_encrypted_dek, recovery_encrypted_private_key
           FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_one(&test_pool().await)
    .await
    .unwrap()
}

#[tokio::test]
async fn replacing_the_recovery_phrase_needs_the_password_and_retires_the_old_phrase() {
    let router = setup().await;
    let account = Account::new();
    let signup = account.signup_with(&router, account.signup_body()).await;
    let (_, other) = account.login(&router, &account.auth_hash).await;
    let access = signup["access_token"].as_str().unwrap();
    let before = stored_recovery(&account.email).await;
    // A challenge fetched while the old phrase was current.
    let stale = recovery_keys(&router, &account.email).await;

    let new_secret = StaticSecret::from(random_bytes::<32>());
    let new_dek = wrapped_key();
    let new_priv = wrapped_key();
    let body = |password: &str, key: &str| {
        json!({
            "current_password": password,
            "recovery_public_key": key,
            "recovery_encrypted_dek": new_dek,
            "recovery_encrypted_private_key": new_priv,
        })
    };
    let new_key = public_key_of(&new_secret);

    let (status, _) = replace_recovery_key(&router, None, body(&account.auth_hash, &new_key)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a session is required");
    let (status, response) =
        replace_recovery_key(&router, Some(access), body(&auth_hash(), &new_key)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{response:?}");
    assert_eq!(response["code"], "invalid_credentials");
    let (status, _) =
        replace_recovery_key(&router, Some(access), body(&account.auth_hash, "not-hex")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = replace_recovery_key(
        &router,
        Some(access),
        body(&account.auth_hash, &public_key_of(&account.device_secret)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the device key is not a recovery key"
    );
    let (status, _) = replace_recovery_key(
        &router,
        Some(access),
        json!({ "current_password": account.auth_hash, "recovery_public_key": new_key }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the new blobs are required"
    );
    assert_eq!(
        stored_recovery(&account.email).await,
        before,
        "nothing refused changed anything"
    );

    let (status, response) =
        replace_recovery_key(&router, Some(access), body(&account.auth_hash, &new_key)).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{response:?}");
    assert_eq!(
        stored_recovery(&account.email).await,
        (
            Some(new_key.clone()),
            Some(new_dek.clone()),
            Some(new_priv.clone())
        )
    );
    assert_eq!(
        refresh_status(&router, &other["refresh_token"]).await,
        StatusCode::OK,
        "sessions are untouched"
    );

    // The challenge issued under the old phrase's key is dead, even answered correctly.
    let old_answer = answer_challenge(&stale["challenge"], &account.recovery_secret).unwrap();
    let (status, _) = recover(
        &router,
        &account.email,
        &stale["challenge"],
        &old_answer,
        json!({ "kdf_version": 2, "kdf_params": current_kdf() }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A fresh challenge carries the new blobs and only the new phrase answers it.
    let keys = recovery_keys(&router, &account.email).await;
    assert_eq!(keys["recovery_key_version"], 2);
    assert_eq!(keys["recovery_encrypted_dek"], new_dek);
    assert_eq!(keys["recovery_encrypted_private_key"], new_priv);
    assert!(answer_challenge(&keys["challenge"], &account.recovery_secret).is_none());
    let answer = answer_challenge(&keys["challenge"], &new_secret).unwrap();
    let (status, body) = recover(
        &router,
        &account.email,
        &keys["challenge"],
        &answer,
        json!({ "kdf_version": 2, "kdf_params": current_kdf() }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
}

#[tokio::test]
async fn replacing_the_recovery_phrase_registers_one_for_an_account_without() {
    let router = setup().await;
    let account = Account::new();
    let signup = account.signup_with(&router, account.signup_body()).await;
    sqlx::query("UPDATE users SET recovery_public_key = NULL WHERE email = $1")
        .bind(&account.email)
        .execute(&test_pool().await)
        .await
        .unwrap();
    let access = signup["access_token"].as_str().unwrap();
    let (_, me) = send(&router, "GET", "/auth/me", Some(access), Value::Null).await;
    assert_eq!(me["has_recovery_key"], false);
    assert_eq!(
        recovery_keys(&router, &account.email).await["recovery_key_version"],
        1
    );

    let new_secret = StaticSecret::from(random_bytes::<32>());
    let (status, body) = replace_recovery_key(
        &router,
        Some(access),
        json!({
            "current_password": account.auth_hash,
            "recovery_public_key": public_key_of(&new_secret),
            "recovery_encrypted_dek": wrapped_key(),
            "recovery_encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let (_, me) = send(&router, "GET", "/auth/me", Some(access), Value::Null).await;
    assert_eq!(me["has_recovery_key"], true);
    let keys = recovery_keys(&router, &account.email).await;
    assert_eq!(keys["recovery_key_version"], 2);
    assert!(
        answer_challenge(&keys["challenge"], &account.device_secret).is_none(),
        "the device key no longer answers"
    );
    assert!(answer_challenge(&keys["challenge"], &new_secret).is_some());
}
