//! Integration tests for the auth flow. Runs against a real Postgres given by
//! `TEST_DATABASE_URL` (default: local devenv `atlas_test`). Each test uses a unique email so the
//! shared database needs no per-test reset.

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

/// The credential a client sends for the account password: the auth hash it derives from it
/// (64 lowercase hex characters), which is what the server stores and compares.
const PASSWORD: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
/// A second derived credential, for password changes.
const NEW_PASSWORD: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn setup() -> Router {
    setup_with(Config {
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
    })
    .await
}

/// The tests are deliberately explicit about `Config` (no env mutation, which would race), so a
/// variant that overrides flags is how a closed-signup or silent-reports instance is simulated.
async fn setup_with(config: Config) -> Router {
    let pool = db::connect(&test_database_url())
        .await
        .expect("connect to test db");
    db::migrate(&pool).await.expect("migrate test db");
    app(AppState::new(pool, config))
}

fn unique_email() -> String {
    format!("user-{}@example.com", Uuid::now_v7())
}

/// A direct handle on the test database, for rows the API can no longer create.
async fn test_pool() -> sqlx::PgPool {
    db::connect(&test_database_url())
        .await
        .expect("connect to test db")
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

/// A wrapped 32-byte key the way the client stores one: base64 of a 12-byte IV and 32 + 16 bytes
/// of AES-GCM ciphertext.
fn wrapped_key() -> Value {
    json!({
        "iv": BASE64.encode(random_bytes::<12>()),
        "ct": BASE64.encode(random_bytes::<48>()),
    })
}

/// A fresh X25519 public key, hex.
fn random_public_key() -> String {
    hex::encode(PublicKey::from(&StaticSecret::from(random_bytes::<32>())).as_bytes())
}

/// Adds the E2EE key material every signup must carry to a `{email, password, ...}` body.
fn with_keys(mut body: Value) -> Value {
    let secret = StaticSecret::from(random_bytes::<32>());
    let fields = body.as_object_mut().unwrap();
    fields.insert("salt".into(), json!(hex::encode(random_bytes::<16>())));
    fields.insert(
        "public_key".into(),
        json!(hex::encode(PublicKey::from(&secret).as_bytes())),
    );
    fields.insert("recovery_public_key".into(), json!(random_public_key()));
    fields.insert("encrypted_dek".into(), wrapped_key());
    fields.insert("encrypted_private_key".into(), wrapped_key());
    fields.insert("recovery_encrypted_dek".into(), wrapped_key());
    fields.insert("recovery_encrypted_private_key".into(), wrapped_key());
    body
}

/// A pre-E2EE account's password: those clients sent the password itself, not a derived hash.
const LEGACY_PASSWORD: &str = "hunter2hunter";

/// A pre-E2EE account row. Signup can no longer create one; the database may still hold some.
async fn insert_legacy_user(pool: &sqlx::PgPool, email: &str, password: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, '') RETURNING id",
    )
    .bind(email)
    .bind(atlas_server::auth::password::hash_password(password).unwrap())
    .fetch_one(pool)
    .await
    .unwrap()
}

/// An E2EE account as the client creates it. Both X25519 secrets stay with the test: the device
/// key every signed-in device holds, and the recovery key only the phrase derives.
struct E2eeAccount {
    email: String,
    auth_hash: String,
    salt: String,
    secret: StaticSecret,
    public_key: String,
    recovery_secret: StaticSecret,
    recovery_public_key: String,
    recovery_dek: Value,
    recovery_priv: Value,
}

impl E2eeAccount {
    fn new() -> Self {
        let secret = StaticSecret::from(random_bytes::<32>());
        let public_key = hex::encode(PublicKey::from(&secret).as_bytes());
        let recovery_secret = StaticSecret::from(random_bytes::<32>());
        let recovery_public_key = hex::encode(PublicKey::from(&recovery_secret).as_bytes());
        E2eeAccount {
            email: unique_email(),
            auth_hash: hex::encode(random_bytes::<32>()),
            salt: hex::encode(random_bytes::<16>()),
            secret,
            public_key,
            recovery_secret,
            recovery_public_key,
            recovery_dek: wrapped_key(),
            recovery_priv: wrapped_key(),
        }
    }

    fn signup_body(&self) -> Value {
        json!({
            "email": self.email,
            "password": self.auth_hash,
            "salt": self.salt,
            "public_key": self.public_key,
            "recovery_public_key": self.recovery_public_key,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
            "recovery_encrypted_dek": self.recovery_dek,
            "recovery_encrypted_private_key": self.recovery_priv,
        })
    }

    async fn signup(&self, router: &Router) -> Value {
        let (status, body) = send(router, "POST", "/auth/signup", None, self.signup_body()).await;
        assert_eq!(status, StatusCode::CREATED, "signup: {body:?}");
        body
    }

    /// Signed up as an account from before phrase-bound recovery keys: no recovery public key.
    async fn signup_unmigrated(&self, router: &Router) -> Value {
        let body = self.signup(router).await;
        sqlx::query("UPDATE users SET recovery_public_key = NULL WHERE email = $1")
            .bind(&self.email)
            .execute(&test_pool().await)
            .await
            .unwrap();
        body
    }
}

/// Unseal a recovery challenge the way the client's `unsealKey` does (X25519 ECDH, HKDF-SHA256
/// with info `atlas-seal-v1`, AES-256-GCM) and return the answer `POST /auth/recover` expects.
fn answer_challenge(challenge: &Value, secret: &StaticSecret) -> String {
    try_answer_challenge(challenge, secret)
        .expect("the challenge is sealed to this account's recovery key")
}

/// [`answer_challenge`], or `None` when `secret` cannot unseal it.
fn try_answer_challenge(challenge: &Value, secret: &StaticSecret) -> Option<String> {
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

/// The exact `POST /auth/recover` body.
fn recover_body(
    email: &str,
    challenge: &Value,
    response: &str,
    new_auth_hash: &str,
    encrypted_dek: &Value,
    encrypted_private_key: &Value,
) -> Value {
    json!({
        "email": email,
        "challenge_token": challenge["token"],
        "challenge_response": response,
        "new_auth_hash": new_auth_hash,
        "encrypted_dek": encrypted_dek,
        "encrypted_private_key": encrypted_private_key,
    })
}

/// Every string leaf replaced by its length: two responses with the same shape are the same bytes
/// long field for field.
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
async fn signup_then_me_returns_the_user() {
    let router = setup().await;
    let email = unique_email();

    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email, "password": PASSWORD, "display_name": "Ada"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    let access = body["access_token"].as_str().unwrap();

    let (status, me) = send(&router, "GET", "/auth/me", Some(access), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["email"], email);
    assert_eq!(me["display_name"], "Ada");
    assert_eq!(
        me["is_admin"], false,
        "an ordinary signup is not an administrator"
    );
}

#[tokio::test]
async fn signup_closed_by_flag_returns_typed_error_while_login_still_works() {
    // A public instance that wants to stop accepting accounts sets SIGNUP_ENABLED=false: the
    // typed `signup_disabled` body is what the client maps to a friendly message, and existing
    // accounts keep working; closing signup must not close the server.
    let open = setup().await;
    let email = unique_email();
    let (status, _) = send(
        &open,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let closed = setup_with(Config {
        signup_enabled: false,
        ..Config {
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
        }
    })
    .await;

    let (status, body) = send(
        &closed,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": unique_email(), "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["error"], "signup_disabled");

    let (status, _) = send(
        &closed,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "login survives closed signup");
}

#[tokio::test]
async fn signup_rejects_duplicate_email_and_weak_password() {
    let router = setup().await;
    let email = unique_email();
    let ok = with_keys(json!({ "email": email, "password": PASSWORD }));

    let (status, _) = send(&router, "POST", "/auth/signup", None, ok.clone()).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = send(&router, "POST", "/auth/signup", None, ok).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": unique_email(), "password": "short"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn login_succeeds_only_with_correct_password() {
    let router = setup().await;
    let email = unique_email();
    send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({
            "email": email, "password": "wrong-password"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({
            "email": email, "password": PASSWORD
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].as_str().is_some());
}

#[tokio::test]
async fn login_with_unknown_email_is_unauthorized() {
    let router = setup().await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({
            "email": unique_email(), "password": "whatever12"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn refresh_rotates_and_old_token_is_rejected() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email, "password": PASSWORD
        })),
    )
    .await;
    let first_refresh = signup["refresh_token"].as_str().unwrap().to_string();

    let (status, refreshed) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({
            "refresh_token": first_refresh
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let second_refresh = refreshed["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(first_refresh, second_refresh, "token should rotate");

    // The rotation chain keeps working without any replay: the new token rotates again.
    let (status, refreshed2) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": second_refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let third_refresh = refreshed2["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(second_refresh, third_refresh, "token should rotate again");

    // Reusing the long-revoked first token must fail.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({
            "refresh_token": first_refresh
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn replaying_a_revoked_refresh_token_revokes_the_whole_family() {
    // A consumed (rotated) refresh token is single-use, so presenting it again after the grace
    // window signals theft; even from a client that asks for the grace. Since attacker and victim
    // are indistinguishable, reuse revokes the device's entire active token family: the
    // freshly-rotated token stops working too, forcing a password login.
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    let r1 = signup["refresh_token"].as_str().unwrap().to_string();

    // r1 -> r2 (legitimate rotation).
    let (status, rotated) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let r2 = rotated["refresh_token"].as_str().unwrap().to_string();
    backdate_rotation(&r1, 11).await;

    // Replaying the now-revoked r1 past the grace window is a reuse signal -> rejected...
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1, "grace": true }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("code").is_none(), "{body:?}");

    // ...and the family revocation means the freshly-rotated r2 is now dead as well.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r2 }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "reuse must revoke the whole device token family, including the newest token"
    );
}

/// Move a rotated refresh token's rotation `secs` into the past.
async fn backdate_rotation(refresh_token: &str, secs: i32) {
    let moved = sqlx::query(
        "UPDATE refresh_tokens SET rotated_at = rotated_at - make_interval(secs => $2)
          WHERE token_hash = $1 AND rotated_at IS NOT NULL",
    )
    .bind(atlas_server::auth::token::hash_refresh_token(refresh_token))
    .bind(f64::from(secs))
    .execute(&test_pool().await)
    .await
    .unwrap();
    assert_eq!(moved.rows_affected(), 1, "the token was rotated");
}

#[tokio::test]
async fn a_refresh_token_reused_just_after_rotation_is_superseded_not_theft() {
    // Two tabs share one session: tab A rotates r1, then tab B presents the r1 it still holds. Tab B
    // is a web client without `navigator.locks`, the one kind that asks for the grace.
    let router = setup().await;
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": unique_email(), "password": PASSWORD })),
    )
    .await;
    let r1 = signup["refresh_token"].as_str().unwrap().to_string();
    let (status, rotated) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let r2 = rotated["refresh_token"].as_str().unwrap().to_string();

    // Tab B is told its token was superseded, and gets no tokens of its own...
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1, "grace": true }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body:?}");
    assert_eq!(body["code"], "refresh_superseded");
    assert!(body.get("refresh_token").is_none());

    // ...while the family survives: tab A's r2 still rotates.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
}

#[tokio::test]
async fn a_reused_refresh_token_without_the_grace_opt_in_is_theft() {
    // Only a client that cannot serialize its rotations asks for the grace; for everyone else a
    // reuse, however quick, is what a thief racing the victim looks like.
    let router = setup().await;
    let (_, signup) = signup_account(&router).await;
    let r1 = signup["refresh_token"].clone();
    let (status, rotated) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("code").is_none(), "no grace: {body:?}");
    assert_eq!(
        refresh_status(&router, &rotated["refresh_token"]).await,
        StatusCode::UNAUTHORIZED,
        "the family is revoked"
    );
}

#[tokio::test]
async fn refresh_refuses_disabled_and_deletion_scheduled_accounts() {
    // Disabling and scheduling a deletion both revoke the tokens, but a refresh racing that
    // revocation must not slip a new session out.
    let router = setup().await;
    let pool = test_pool().await;
    let (email, signup) = signup_account(&router).await;
    let refresh = signup["refresh_token"].clone();

    sqlx::query("UPDATE users SET disabled_at = now() WHERE email = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["error"], "account_disabled");

    sqlx::query(
        "UPDATE users SET disabled_at = NULL, deletion_scheduled_at = now() WHERE email = $1",
    )
    .bind(&email)
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["error"], "account_scheduled_deletion");

    // Neither refusal spent the token: nothing was issued in its place.
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM refresh_tokens t JOIN users u ON u.id = t.user_id
          WHERE u.email = $1 AND t.revoked_at IS NULL",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
}

#[tokio::test]
async fn a_deletion_scheduled_account_is_refused_by_the_api_except_the_export() {
    let router = setup().await;
    let (email, signup) = signup_account(&router).await;
    let access = signup["access_token"].as_str().unwrap();
    sqlx::query("UPDATE users SET deletion_scheduled_at = now() WHERE email = $1")
        .bind(&email)
        .execute(&test_pool().await)
        .await
        .unwrap();

    // Typed, so the client does not bounce through a refresh it cannot win.
    let (status, body) = send(&router, "GET", "/auth/me", Some(access), Value::Null).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["error"], "account_scheduled_deletion");
    assert_eq!(body["days_remaining"], 30);
    let (status, _) = send(
        &router,
        "GET",
        "/sync/pull?since=0",
        Some(access),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The grace period is when a user most needs their data out.
    let (status, _) = send(&router, "GET", "/auth/export", Some(access), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn logout_revokes_the_device_family_even_with_an_already_rotated_token() {
    let router = setup().await;
    let (email, signup) = signup_account(&router).await;
    let r1 = signup["refresh_token"].clone();
    let (_, rotated) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    let (_, other_device) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;

    // A tab still holding the rotated r1 signs out: the device's live r2 goes with it.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/logout",
        None,
        json!({ "refresh_token": r1 }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        refresh_status(&router, &rotated["refresh_token"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        refresh_status(&router, &other_device["refresh_token"]).await,
        StatusCode::OK,
        "another device's family is untouched"
    );
}

#[tokio::test]
async fn the_refresh_token_hash_index_covers_revoked_rows() {
    // The reuse lookup filters on revoked rows; a partial index over live rows cannot serve it.
    let pool = test_pool().await;
    atlas_server::db::migrate(&pool).await.unwrap();
    let def: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'refresh_tokens_token_hash_idx'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!def.contains("WHERE"), "{def}");
}

#[tokio::test]
async fn a_logged_out_refresh_token_gets_no_grace() {
    // Logout revokes without rotating: presenting that token again is not a lost race between
    // tabs, so it keeps the theft response.
    let router = setup().await;
    let (_, signup) = signup_account(&router).await;
    let logged_out = signup["refresh_token"].as_str().unwrap().to_string();

    let (status, _) = send(
        &router,
        "POST",
        "/auth/logout",
        None,
        json!({ "refresh_token": logged_out }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": logged_out }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("code").is_none(), "no grace: {body:?}");
}

#[tokio::test]
async fn logout_revokes_refresh_token() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email, "password": PASSWORD
        })),
    )
    .await;
    let refresh = signup["refresh_token"].as_str().unwrap().to_string();

    let (status, _) = send(
        &router,
        "POST",
        "/auth/logout",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_rejects_garbage_token() {
    let router = setup().await;
    let (status, _) = send(&router, "GET", "/auth/me", Some("not-a-jwt"), Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn e2ee_signup_and_login_roundtrip() {
    let router = setup().await;
    let email = unique_email();

    let (s_status, s_body) = send(
        &router,
        "GET",
        &format!("/auth/salt?email={email}"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(s_status, StatusCode::OK);
    assert!(s_body["salt"].as_str().is_some());
    assert_eq!(s_body["is_e2ee"].as_bool(), Some(true));

    let salt = "0123456789abcdef0123456789abcdef";
    let auth_hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    let pub_key = "1111222233334444555566667777888811112222333344445555666677778888";
    let dek_payload = json!({ "iv": "iv123", "ct": "ct123" });
    let priv_payload = json!({ "iv": "ivpriv", "ct": "ctpriv" });
    let rec_dek = json!({ "iv": "ivrec", "ct": "ctrec" });

    let (status, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": email,
            "password": auth_hash,
            "display_name": "E2EE User",
            "salt": salt,
            "public_key": pub_key,
            "recovery_public_key": random_public_key(),
            "encrypted_dek": dek_payload,
            "encrypted_private_key": priv_payload,
            "recovery_encrypted_dek": rec_dek,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(signup["is_e2ee"].as_bool(), Some(true));
    assert_eq!(signup["salt"].as_str(), Some(salt));
    assert_eq!(signup["public_key"].as_str(), Some(pub_key));
    assert_eq!(signup["encrypted_dek"], dek_payload);
    assert_eq!(signup["encrypted_private_key"], priv_payload);

    let (s_status2, s_body2) = send(
        &router,
        "GET",
        &format!("/auth/salt?email={email}"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(s_status2, StatusCode::OK);
    assert_eq!(s_body2["salt"].as_str(), Some(salt));
    assert_eq!(s_body2["is_e2ee"].as_bool(), Some(true));

    let (l_status, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({
            "email": email,
            "password": auth_hash,
        }),
    )
    .await;
    assert_eq!(l_status, StatusCode::OK);
    assert_eq!(login["is_e2ee"].as_bool(), Some(true));
    assert_eq!(login["salt"].as_str(), Some(salt));
    assert_eq!(login["encrypted_dek"], dek_payload);
}

#[tokio::test]
async fn salt_does_not_tell_a_legacy_account_from_an_unknown_address() {
    let router = setup().await;
    let pool = test_pool().await;
    let legacy_email = unique_email();
    insert_legacy_user(&pool, &legacy_email, LEGACY_PASSWORD).await;
    let unknown_email = unique_email();

    let salt = |email: String| {
        let router = router.clone();
        async move {
            let (status, body) = send(
                &router,
                "GET",
                &format!("/auth/salt?email={email}"),
                None,
                Value::Null,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            body
        }
    };
    let legacy = salt(legacy_email.clone()).await;
    let unknown = salt(unknown_email.clone()).await;

    // The same fields, the same types and the same salt length as the unknown-address dummy, and
    // just as stable.
    assert_eq!(legacy["is_e2ee"], true, "{legacy:?}");
    assert_eq!(unknown["is_e2ee"], true);
    let legacy_salt = legacy["salt"].as_str().unwrap();
    let unknown_salt = unknown["salt"].as_str().unwrap();
    assert_eq!(legacy_salt.len(), unknown_salt.len());
    assert!(legacy_salt.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(salt(legacy_email.clone()).await, legacy);
    // It is the dummy the recovery lookup reports for the address too.
    assert_eq!(
        recovery_keys(&router, &legacy_email).await["salt"],
        legacy["salt"]
    );

    // A credential derived from that salt fails as it does for an unknown address.
    let derived = hex::encode(random_bytes::<32>());
    let mut answers = Vec::new();
    for email in [&legacy_email, &unknown_email] {
        let (status, body) = send(
            &router,
            "POST",
            "/auth/login",
            None,
            json!({ "email": email, "password": derived }),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body:?}");
        answers.push(body);
    }
    assert_eq!(answers[0], answers[1]);
}

#[tokio::test]
async fn the_e2ee_upgrade_route_is_gone() {
    // It replaced the password hash and all key material on the strength of a bearer token alone.
    let router = setup().await;
    let account = E2eeAccount::new();
    let signup = account.signup(&router).await;
    // Raw request: an unmatched non-`/api` path answers the static fallback's bodiless 404.
    let request = Request::builder()
        .method("POST")
        .uri("/auth/upgrade-e2ee")
        .header("content-type", "application/json")
        .header(
            "authorization",
            format!("Bearer {}", signup["access_token"].as_str().unwrap()),
        )
        .body(Body::from(
            serde_json::to_vec(&json!({
                "new_auth_hash": hex::encode(random_bytes::<32>()),
                "salt": hex::encode(random_bytes::<16>()),
                "public_key": hex::encode(random_bytes::<32>()),
                "encrypted_dek": wrapped_key(),
                "encrypted_private_key": wrapped_key(),
            }))
            .unwrap(),
        ))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": account.auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the credential is untouched");
}

#[tokio::test]
async fn signup_without_e2ee_key_material_is_rejected() {
    let router = setup().await;
    let email = unique_email();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");

    // Every piece is required.
    for field in [
        "salt",
        "public_key",
        "encrypted_dek",
        "encrypted_private_key",
    ] {
        let mut body = with_keys(json!({ "email": email, "password": PASSWORD }));
        body.as_object_mut().unwrap().remove(field);
        let (status, _) = send(&router, "POST", "/auth/signup", None, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "signup without {field}");
    }

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "no account was created");
}

#[tokio::test]
async fn a_legacy_account_is_refused_with_a_typed_403() {
    let router = setup().await;
    let pool = test_pool().await;
    let email = unique_email();
    let user_id = insert_legacy_user(&pool, &email, LEGACY_PASSWORD).await;

    // A wrong password is the ordinary 401: the typed refusal is only for the credential's owner.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": "wrong-password" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": LEGACY_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "legacy_account");
    assert!(body["error"].is_string());

    let (status, body) = send(
        &router,
        "POST",
        "/auth/account/cancel-deletion",
        None,
        json!({ "email": email, "password": LEGACY_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "legacy_account");

    // A session issued before the cutover cannot be extended either.
    let refresh = format!("legacy-session-{}", Uuid::now_v7());
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')",
    )
    .bind(user_id)
    .bind(Uuid::now_v7())
    .bind(atlas_server::auth::token::hash_refresh_token(&refresh))
    .execute(&pool)
    .await
    .unwrap();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "legacy_account");
}

#[tokio::test]
async fn e2ee_account_recovery_flow() {
    let router = setup().await;
    let account = E2eeAccount::new();
    let signup = account.signup(&router).await;
    let old_refresh = signup["refresh_token"].as_str().unwrap().to_string();

    // The recovery keys come back as stored, with a challenge sealed to the phrase-derived
    // recovery key (version 2).
    let keys = recovery_keys(&router, &account.email).await;
    assert_eq!(keys["salt"].as_str(), Some(account.salt.as_str()));
    assert_eq!(keys["recovery_encrypted_dek"], account.recovery_dek);
    assert_eq!(
        keys["recovery_encrypted_private_key"],
        account.recovery_priv
    );
    assert_eq!(keys["recovery_key_version"], 2, "{keys:?}");
    let challenge = &keys["challenge"];
    assert!(challenge["token"].is_string(), "{keys:?}");
    let response = answer_challenge(challenge, &account.recovery_secret);
    assert_eq!(response.len(), 64, "32 nonce bytes, hex");

    // Holding the recovery key is the proof: the password and primary wraps are replaced.
    let new_auth_hash = hex::encode(random_bytes::<32>());
    let new_dek = wrapped_key();
    let new_priv = wrapped_key();
    let (status, body) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            challenge,
            &response,
            &new_auth_hash,
            &new_dek,
            &new_priv,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": account.auth_hash }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the old credential is dead"
    );

    let (status, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": new_auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{login:?}");
    assert_eq!(
        login["salt"].as_str(),
        Some(account.salt.as_str()),
        "the client re-derives with the existing salt"
    );
    assert_eq!(
        login["public_key"].as_str(),
        Some(account.public_key.as_str())
    );
    assert_eq!(login["encrypted_dek"], new_dek);
    assert_eq!(login["encrypted_private_key"], new_priv);

    // Recovery signs every existing session out.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": old_refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn recover_rejects_a_wrong_challenge_response_and_changes_nothing() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;

    // The takeover the endpoint must refuse: an email plus fresh credentials, with no proof of
    // holding the account's recovery key behind them.
    let mut takeover = recover_body(
        &account.email,
        &json!({ "token": "not-a-jwt" }),
        &hex::encode(random_bytes::<32>()),
        &hex::encode(random_bytes::<32>()),
        &wrapped_key(),
        &wrapped_key(),
    );
    takeover["salt"] = json!(hex::encode(random_bytes::<16>()));
    takeover["public_key"] = json!(hex::encode(random_bytes::<32>()));
    takeover["recovery_encrypted_dek"] = wrapped_key();
    takeover["recovery_encrypted_private_key"] = wrapped_key();
    let (status, forged) = send(&router, "POST", "/auth/recover", None, takeover).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{forged:?}");
    assert_eq!(forged, json!({ "error": "unauthorized" }));

    // Nor is a genuine challenge answered without the key.
    let keys = recovery_keys(&router, &account.email).await;
    let (status, body) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &keys["challenge"],
            &hex::encode(random_bytes::<32>()),
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body:?}");
    assert_eq!(body, forged, "one indistinguishable rejection");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": account.auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the account is untouched");
}

#[tokio::test]
async fn recover_for_an_unknown_email_is_the_same_401() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;
    let real = recovery_keys(&router, &account.email).await;
    let (_, known) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &real["challenge"],
            &hex::encode(random_bytes::<32>()),
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;

    let unknown_email = unique_email();
    let dummy = recovery_keys(&router, &unknown_email).await;
    let (status, unknown) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &unknown_email,
            &dummy["challenge"],
            &hex::encode(random_bytes::<32>()),
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{unknown:?}");
    assert_eq!(
        unknown, known,
        "no account enumeration through the rejection"
    );
}

#[tokio::test]
async fn a_recovery_challenge_is_single_use() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;
    let keys = recovery_keys(&router, &account.email).await;
    let response = answer_challenge(&keys["challenge"], &account.recovery_secret);

    let first_hash = hex::encode(random_bytes::<32>());
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &keys["challenge"],
            &response,
            &first_hash,
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Replaying the answered challenge (a captured request) is refused: the password hash it was
    // bound to is gone.
    let second_hash = hex::encode(random_bytes::<32>());
    let (status, body) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &keys["challenge"],
            &response,
            &second_hash,
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body:?}");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": first_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the first recovery stands");
}

#[tokio::test]
async fn a_recovery_challenge_only_recovers_the_email_it_was_issued_for() {
    let router = setup().await;
    // The attacker holds account A's key (their own) and targets B.
    let attacker = E2eeAccount::new();
    let victim = E2eeAccount::new();
    attacker.signup(&router).await;
    victim.signup(&router).await;

    let keys = recovery_keys(&router, &attacker.email).await;
    let response = answer_challenge(&keys["challenge"], &attacker.recovery_secret);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &victim.email,
            &keys["challenge"],
            &response,
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": victim.email, "password": victim.auth_hash }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the victim's credential is untouched"
    );
}

#[tokio::test]
async fn recover_ignores_salt_public_key_and_recovery_blobs_in_the_body() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;
    let keys = recovery_keys(&router, &account.email).await;
    let response = answer_challenge(&keys["challenge"], &account.recovery_secret);

    // A body carrying fields the endpoint must not overwrite: only the password hash and the
    // primary wraps may change.
    let new_auth_hash = hex::encode(random_bytes::<32>());
    let mut body = recover_body(
        &account.email,
        &keys["challenge"],
        &response,
        &new_auth_hash,
        &wrapped_key(),
        &wrapped_key(),
    );
    let other_secret = StaticSecret::from(random_bytes::<32>());
    body["salt"] = json!(hex::encode(random_bytes::<16>()));
    body["public_key"] = json!(hex::encode(PublicKey::from(&other_secret).as_bytes()));
    body["recovery_encrypted_dek"] = wrapped_key();
    body["recovery_encrypted_private_key"] = wrapped_key();
    let (status, _) = send(&router, "POST", "/auth/recover", None, body).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": new_auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(login["salt"].as_str(), Some(account.salt.as_str()));
    assert_eq!(
        login["public_key"].as_str(),
        Some(account.public_key.as_str())
    );

    let after = recovery_keys(&router, &account.email).await;
    assert_eq!(after["salt"].as_str(), Some(account.salt.as_str()));
    assert_eq!(after["recovery_encrypted_dek"], account.recovery_dek);
    assert_eq!(
        after["recovery_encrypted_private_key"],
        account.recovery_priv
    );
    // The original recovery key still answers the next challenge: nothing was swapped.
    answer_challenge(&after["challenge"], &account.recovery_secret);
}

#[tokio::test]
async fn change_password_requires_the_current_credential_and_rotates_login() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    let access = signup["access_token"].as_str().unwrap();

    // A wrong current credential is rejected, and nothing changes.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": "wrong-password",
            "new_password": NEW_PASSWORD,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    // Not a 401: the session is fine, and a 401 would send the client into refresh-and-retry.
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "invalid_credentials");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "nothing has changed yet");

    // The correct current credential rotates it.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the old password is dead");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": NEW_PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the new password logs in");
}

#[tokio::test]
async fn a_new_credential_must_be_a_derived_auth_hash() {
    let router = setup().await;
    // What a client never sends: the password itself, a hash of the wrong length, or uppercase
    // hex (login compares the exact string, and clients send lowercase).
    let malformed = [
        LEGACY_PASSWORD.to_string(),
        PASSWORD[..63].to_string(),
        format!("{PASSWORD}0"),
        PASSWORD.to_uppercase(),
    ];

    for bad in &malformed {
        let (status, body) = send(
            &router,
            "POST",
            "/auth/signup",
            None,
            with_keys(json!({ "email": unique_email(), "password": bad })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "signup with {bad}: {body:?}"
        );
    }

    let account = E2eeAccount::new();
    let signup = account.signup(&router).await;
    let access = signup["access_token"].as_str().unwrap();
    for bad in &malformed {
        let (status, body) = send(
            &router,
            "POST",
            "/auth/change-password",
            Some(access),
            json!({
                "current_password": account.auth_hash,
                "new_password": bad,
                "encrypted_dek": wrapped_key(),
                "encrypted_private_key": wrapped_key(),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "change to {bad}: {body:?}");
    }

    let keys = recovery_keys(&router, &account.email).await;
    let response = answer_challenge(&keys["challenge"], &account.recovery_secret);
    for bad in &malformed {
        let (status, body) = send(
            &router,
            "POST",
            "/auth/recover",
            None,
            recover_body(
                &account.email,
                &keys["challenge"],
                &response,
                bad,
                &wrapped_key(),
                &wrapped_key(),
            ),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "recover to {bad}: {body:?}"
        );
    }

    // Nothing was stored: the original credential still signs in.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": account.auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn change_password_needs_no_session_free_access() {
    let router = setup().await;
    // Unauthenticated (no bearer) — must not even be able to reach verification.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        None,
        json!({
            "current_password": "x",
            "new_password": "y",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn change_password_for_an_e2ee_account_swaps_hash_and_wrapped_keys_together() {
    let router = setup().await;
    let email = unique_email();
    let salt = "salt123456789abcdef0123456789abc";
    let auth_hash = "1111222233334444555566667777888811112222333344445555666677778888";
    send(
        &router,
        "POST",
        "/auth/signup",
        None,
        json!({
            "email": email,
            "password": auth_hash,
            "salt": salt,
            "public_key": "pub",
            "recovery_public_key": random_public_key(),
            "encrypted_dek": { "iv": "iv", "ct": "dek" },
            "encrypted_private_key": { "iv": "iv", "ct": "priv" },
            "recovery_encrypted_dek": { "iv": "ivr", "ct": "recdek" },
            "recovery_encrypted_private_key": { "iv": "ivrp", "ct": "recpriv" },
        }),
    )
    .await;
    let (_, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": auth_hash }),
    )
    .await;
    let access = login["access_token"].as_str().unwrap();

    // Missing re-wrap blobs are refused: the hash swap alone would leave the account unloggable.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": auth_hash,
            "new_password": "2222222233334444555566667777888822222222333344445555666677778888",
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");

    // The full payload: new auth hash plus key material re-wrapped under the new password's MEK.
    let new_auth_hash = "bbbb2222333344445555666677778888bbbb2222333344445555666677778888";
    let new_dek = json!({ "iv": "newiv", "ct": "newdek" });
    let new_priv = json!({ "iv": "newivp", "ct": "newpriv" });
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(access),
        json!({
            "current_password": auth_hash,
            "new_password": new_auth_hash,
            "encrypted_dek": new_dek,
            "encrypted_private_key": new_priv,
            "recovery_encrypted_dek": { "iv": "newivr", "ct": "newrecdek" },
            "recovery_encrypted_private_key": { "iv": "newivrp", "ct": "newrecpriv" },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The old auth hash no longer logs in; the new one returns the NEW wrapped blobs, proving
    // hash and keys moved together — with the salt untouched, so recovery copies stay valid.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": new_auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["is_e2ee"].as_bool(), Some(true));
    assert_eq!(body["salt"].as_str(), Some(salt), "the salt is kept");
    assert_eq!(body["encrypted_dek"], new_dek);
    assert_eq!(body["encrypted_private_key"], new_priv);
}

#[tokio::test]
async fn change_password_keeps_the_current_device_session_and_revokes_others() {
    let router = setup().await;
    let (email, signup) = signup_account(&router).await;
    let refresh_a = signup["refresh_token"].as_str().unwrap().to_string();
    let access_a = signup["access_token"].as_str().unwrap().to_string();

    let (_, second) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    let refresh_b = second["refresh_token"].as_str().unwrap().to_string();

    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(&access_a),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The device that proved the credential keeps its session...
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh_a }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the current device's session survives"
    );

    // ...every other family is revoked...
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh_b }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "other devices are signed out"
    );

    // ...including a second session of the same account started from another login.
    let email2 = unique_email();
    let (_, signup2) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email2, "password": PASSWORD })),
    )
    .await;
    let (_, again) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email2, "password": PASSWORD }),
    )
    .await;
    let (status, _) = send(
        &router,
        "POST",
        "/auth/change-password",
        Some(signup2["access_token"].as_str().unwrap()),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": again["refresh_token"].as_str().unwrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_account_requires_the_password_then_schedules_and_revokes() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    let access = signup["access_token"].as_str().unwrap();
    let refresh = signup["refresh_token"].as_str().unwrap().to_string();

    // A wrong password schedules nothing.
    let (status, body) = send(
        &router,
        "DELETE",
        "/auth/account",
        Some(access),
        json!({ "password": "not-the-password" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "invalid_credentials");
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "no deletion was scheduled");

    // The correct password schedules the deletion and revokes the sessions.
    let (status, _) = send(
        &router,
        "DELETE",
        "/auth/account",
        Some(access),
        json!({ "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": refresh }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "sessions are revoked");

    // The grace period: login reports the scheduled deletion instead of working or denying.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "account_scheduled_deletion");
    assert_eq!(body["days_remaining"].as_i64(), Some(30));
}

#[tokio::test]
async fn cancel_deletion_rejects_a_wrong_password_and_succeeds_with_the_right_one() {
    let router = setup().await;
    let email = unique_email();
    send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    let (_, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    let access = login["access_token"].as_str().unwrap();
    send(
        &router,
        "DELETE",
        "/auth/account",
        Some(access),
        json!({ "password": PASSWORD }),
    )
    .await;

    // A wrong password does not restore anything.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/account/cancel-deletion",
        None,
        json!({ "email": email, "password": "wrong-password" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "still scheduled for deletion"
    );

    // The right password cancels the deletion, after which login works again.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/account/cancel-deletion",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the account is restored");
}

#[tokio::test]
async fn recovery_keys_does_not_leak_account_existence_or_e2ee_status() {
    let router = setup().await;
    let pool = test_pool().await;

    // A legacy (non-E2EE) row and an E2EE row without a public key: neither can be recovered, and
    // neither may be told apart from an address with no account at all.
    let legacy_email = unique_email();
    insert_legacy_user(&pool, &legacy_email, LEGACY_PASSWORD).await;
    let keyless_email = unique_email();
    sqlx::query(
        "INSERT INTO users (email, password_hash, display_name, salt, encrypted_dek, is_e2ee)
         VALUES ($1, $2, '', $3, $4, TRUE)",
    )
    .bind(&keyless_email)
    .bind(atlas_server::auth::password::hash_password(PASSWORD).unwrap())
    .bind(hex::encode(random_bytes::<16>()))
    .bind(wrapped_key())
    .execute(&pool)
    .await
    .unwrap();
    let account = E2eeAccount::new();
    account.signup(&router).await;
    let unknown_email = unique_email();

    let real = recovery_keys(&router, &account.email).await;
    let unknown = recovery_keys(&router, &unknown_email).await;
    let legacy = recovery_keys(&router, &legacy_email).await;
    let keyless = recovery_keys(&router, &keyless_email).await;

    // Same keys, same types, same string lengths, all the way down (challenge included), and the
    // same recovery key version as a real account.
    assert!(
        real["challenge"]["sealed"]["encryptedKey"]["ct"].is_string(),
        "{real:?}"
    );
    assert_eq!(real["recovery_key_version"], 2);
    assert_eq!(shape(&unknown), shape(&real), "{unknown:?} vs {real:?}");
    assert_eq!(shape(&legacy), shape(&real));
    assert_eq!(shape(&keyless), shape(&real));

    // The dummy is as stable as real stored data (only the challenge is fresh per request), and
    // its salt is the one `/auth/salt` reports for the same address.
    let unknown_again = recovery_keys(&router, &unknown_email).await;
    for field in [
        "salt",
        "recovery_encrypted_dek",
        "recovery_encrypted_private_key",
    ] {
        assert_eq!(
            unknown_again[field], unknown[field],
            "{field} is deterministic"
        );
    }
    assert_ne!(unknown_again["challenge"], unknown["challenge"]);
    let (_, salt) = send(
        &router,
        "GET",
        &format!("/auth/salt?email={unknown_email}"),
        None,
        Value::Null,
    )
    .await;
    assert_eq!(salt["salt"], unknown["salt"]);

    // A real account is distinguishable only by holding its actual key material.
    assert_eq!(real["recovery_encrypted_dek"], account.recovery_dek);
    assert_ne!(
        real["recovery_encrypted_dek"],
        unknown["recovery_encrypted_dek"]
    );
}

// ---------- Per-account failure limits ----------

/// Failures an account absorbs before it is locked (the `AUTH_ACCOUNT_FAILURE_MAX` default).
const ACCOUNT_FAILURE_MAX: usize = 10;

#[tokio::test]
async fn repeated_login_failures_lock_the_account_not_everyone() {
    let router = setup().await;
    let (email, _) = signup_account(&router).await;
    let (other, _) = signup_account(&router).await;
    for _ in 0..ACCOUNT_FAILURE_MAX {
        let (status, _) = send(
            &router,
            "POST",
            "/auth/login",
            None,
            json!({ "email": email, "password": "wrong-password" }),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // Locked before the password is even checked: the right one does not get through either.
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": other, "password": PASSWORD }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "another account is unaffected");
}

#[tokio::test]
async fn repeated_recovery_failures_lock_the_account() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;
    let keys = recovery_keys(&router, &account.email).await;
    let attempt = |response: String| {
        let router = router.clone();
        let body = recover_body(
            &account.email,
            &keys["challenge"],
            &response,
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        );
        async move { send(&router, "POST", "/auth/recover", None, body).await.0 }
    };
    for _ in 0..ACCOUNT_FAILURE_MAX {
        assert_eq!(
            attempt(hex::encode(random_bytes::<32>())).await,
            StatusCode::UNAUTHORIZED
        );
    }
    let right = answer_challenge(&keys["challenge"], &account.recovery_secret);
    assert_eq!(attempt(right).await, StatusCode::TOO_MANY_REQUESTS);
}

// ---------- Phrase-bound recovery keys ----------

async fn register_recovery_key(
    router: &Router,
    access: &str,
    password: &str,
    recovery_public_key: &str,
) -> (StatusCode, Value) {
    send(
        router,
        "PUT",
        "/auth/recovery-key",
        Some(access),
        json!({ "current_password": password, "recovery_public_key": recovery_public_key }),
    )
    .await
}

async fn stored_recovery_public_key(email: &str) -> Option<String> {
    sqlx::query_scalar("SELECT recovery_public_key FROM users WHERE email = $1")
        .bind(email)
        .fetch_one(&test_pool().await)
        .await
        .unwrap()
}

#[tokio::test]
async fn signup_requires_a_well_formed_recovery_public_key() {
    let router = setup().await;
    let base = || with_keys(json!({ "email": unique_email(), "password": PASSWORD }));

    let mut missing = base();
    missing
        .as_object_mut()
        .unwrap()
        .remove("recovery_public_key");
    let (status, body) = send(&router, "POST", "/auth/signup", None, missing).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");

    let mut malformed = base();
    malformed["recovery_public_key"] = json!("not-hex");
    let (status, _) = send(&router, "POST", "/auth/signup", None, malformed).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The device key as the recovery key would hand recovery back to every signed-in device.
    let mut reused = base();
    reused["recovery_public_key"] = reused["public_key"].clone();
    let (status, _) = send(&router, "POST", "/auth/signup", None, reused).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let account = E2eeAccount::new();
    let signup = account.signup(&router).await;
    assert_eq!(signup["user"]["has_recovery_key"], true, "{signup:?}");
    assert_eq!(
        stored_recovery_public_key(&account.email).await.as_deref(),
        Some(account.recovery_public_key.as_str())
    );
}

#[tokio::test]
async fn with_a_recovery_key_the_device_private_key_cannot_recover() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup(&router).await;

    // A stolen device holds the X25519 private key, never the phrase: the challenge is not sealed
    // to anything it has.
    let keys = recovery_keys(&router, &account.email).await;
    assert_eq!(keys["recovery_key_version"], 2);
    assert!(try_answer_challenge(&keys["challenge"], &account.secret).is_none());
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &keys["challenge"],
            &hex::encode(random_bytes::<32>()),
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": account.auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the account is untouched");
}

#[tokio::test]
async fn an_unmigrated_account_falls_back_to_the_device_key_only_until_it_registers() {
    let router = setup().await;
    let account = E2eeAccount::new();
    let signup = account.signup_unmigrated(&router).await;
    let access = signup["access_token"].as_str().unwrap().to_string();

    let (status, me) = send(&router, "GET", "/auth/me", Some(&access), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        me["has_recovery_key"], false,
        "the client should ask for the phrase"
    );

    // Version 1: sealed to the account's public key, answered with the device private key.
    let v1 = recovery_keys(&router, &account.email).await;
    assert_eq!(v1["recovery_key_version"], 1, "{v1:?}");
    let v1_answer = answer_challenge(&v1["challenge"], &account.secret);

    let (status, _) = register_recovery_key(
        &router,
        &access,
        &account.auth_hash,
        &account.recovery_public_key,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // A version-1 challenge issued before the registration is dead after it...
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &v1["challenge"],
            &v1_answer,
            &hex::encode(random_bytes::<32>()),
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // ...and every new challenge is version 2, which only the phrase-derived key answers.
    let v2 = recovery_keys(&router, &account.email).await;
    assert_eq!(v2["recovery_key_version"], 2);
    assert!(try_answer_challenge(&v2["challenge"], &account.secret).is_none());
    let new_auth_hash = hex::encode(random_bytes::<32>());
    let (status, _) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &v2["challenge"],
            &answer_challenge(&v2["challenge"], &account.recovery_secret),
            &new_auth_hash,
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn an_unmigrated_account_still_recovers_with_version_1() {
    let router = setup().await;
    let account = E2eeAccount::new();
    account.signup_unmigrated(&router).await;

    let keys = recovery_keys(&router, &account.email).await;
    assert_eq!(keys["recovery_key_version"], 1);
    let new_auth_hash = hex::encode(random_bytes::<32>());
    let (status, body) = send(
        &router,
        "POST",
        "/auth/recover",
        None,
        recover_body(
            &account.email,
            &keys["challenge"],
            &answer_challenge(&keys["challenge"], &account.secret),
            &new_auth_hash,
            &wrapped_key(),
            &wrapped_key(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    let (status, _) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": account.email, "password": new_auth_hash }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn registering_the_recovery_key_needs_the_password_and_happens_once() {
    let router = setup().await;
    let account = E2eeAccount::new();
    let signup = account.signup_unmigrated(&router).await;
    let access = signup["access_token"].as_str().unwrap().to_string();

    let (status, _) = send(
        &router,
        "PUT",
        "/auth/recovery-key",
        None,
        json!({ "current_password": account.auth_hash, "recovery_public_key": account.recovery_public_key }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a session is required");

    let (status, body) = register_recovery_key(
        &router,
        &access,
        "wrong-password",
        &account.recovery_public_key,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body:?}");
    assert_eq!(body["code"], "invalid_credentials");
    assert_eq!(stored_recovery_public_key(&account.email).await, None);

    let (status, body) =
        register_recovery_key(&router, &access, &account.auth_hash, "not-hex").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
    let (status, _) =
        register_recovery_key(&router, &access, &account.auth_hash, &account.public_key).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the device key is not a recovery key"
    );

    let (status, _) = register_recovery_key(
        &router,
        &access,
        &account.auth_hash,
        &account.recovery_public_key,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        stored_recovery_public_key(&account.email).await.as_deref(),
        Some(account.recovery_public_key.as_str())
    );

    // Repeating the same registration is harmless; replacing it is not allowed, or a password
    // thief could plant a recovery key that outlives the next password change.
    let (status, _) = register_recovery_key(
        &router,
        &access,
        &account.auth_hash,
        &account.recovery_public_key,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) =
        register_recovery_key(&router, &access, &account.auth_hash, &random_public_key()).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body:?}");
    assert_eq!(body["code"], "recovery_key_already_set");
    assert_eq!(
        stored_recovery_public_key(&account.email).await.as_deref(),
        Some(account.recovery_public_key.as_str())
    );
}

// ---------- Sessions (per-device refresh-token families) ----------

/// One account signed in from two devices; returns the access tokens and (server-minted) device
/// ids for both.
async fn two_devices(router: &Router) -> (String, String, Uuid, Uuid) {
    let (email, signup) = signup_account(router).await;
    let (_, login) = send(
        router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD }),
    )
    .await;
    assert!(login["access_token"].is_string(), "{login:?}");
    let device = |v: &Value| Uuid::parse_str(v["device_id"].as_str().unwrap()).unwrap();
    (
        signup["access_token"].as_str().unwrap().to_string(),
        login["access_token"].as_str().unwrap().to_string(),
        device(&signup),
        device(&login),
    )
}

#[tokio::test]
async fn sessions_lists_devices_and_marks_the_current_one() {
    let router = setup().await;
    let (access_a, access_b, device_a, device_b) = two_devices(&router).await;

    let (status, sessions) = send(
        &router,
        "GET",
        "/auth/sessions",
        Some(&access_b),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sessions = sessions.as_array().unwrap();
    assert_eq!(sessions.len(), 2, "both devices' live families are listed");
    let a = sessions
        .iter()
        .find(|s| s["device_id"] == device_a.to_string())
        .unwrap();
    let b = sessions
        .iter()
        .find(|s| s["device_id"] == device_b.to_string())
        .unwrap();
    assert_eq!(a["current"], false, "device_a is not the caller");
    assert_eq!(b["current"], true, "the caller's own family is marked");
    // The expiry/last-used info the row carries, as unix millis the client can render relatively.
    assert!(a["created_at"].is_i64() && a["last_used_at"].is_i64() && a["expires_at"].is_i64());
    assert!(
        a["expires_at"].as_i64().unwrap() > a["last_used_at"].as_i64().unwrap(),
        "the live token outlives its issue moment"
    );

    // An unauthenticated caller gets 401, like every other /auth endpoint.
    let (status, _) = send(&router, "GET", "/auth/sessions", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = access_a;
}

#[tokio::test]
async fn signing_in_again_from_the_same_install_replaces_its_old_session() {
    let router = setup().await;
    let (email, signup) = signup_account(&router).await;
    let login = |install_key: Value| {
        let router = router.clone();
        let email = email.clone();
        async move {
            let (status, body) = send(
                &router,
                "POST",
                "/auth/login",
                None,
                json!({ "email": email, "password": PASSWORD, "install_key": install_key }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body:?}");
            body
        }
    };
    let live_devices = |access: String| {
        let router = router.clone();
        async move {
            let (_, sessions) =
                send(&router, "GET", "/auth/sessions", Some(&access), Value::Null).await;
            sessions
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["device_id"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        }
    };

    // The phone, then the same phone after a reinstall: one row, the new one.
    let first = login(json!("phone-install-key")).await;
    let reinstalled = login(json!("phone-install-key")).await;
    let devices = live_devices(reinstalled["access_token"].as_str().unwrap().into()).await;
    assert_eq!(
        devices.len(),
        2,
        "the signup's session and the reinstalled phone: {devices:?}"
    );
    assert!(devices.contains(&reinstalled["device_id"].as_str().unwrap().to_string()));
    assert!(!devices.contains(&first["device_id"].as_str().unwrap().to_string()));
    let (status, _) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": first["refresh_token"] }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the replaced family is dead"
    );

    // The key rides the rotation: a refreshed session is still replaced by the next sign-in.
    let (status, rotated) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": reinstalled["refresh_token"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rotated:?}");
    let again = login(json!("phone-install-key")).await;
    let devices = live_devices(again["access_token"].as_str().unwrap().into()).await;
    assert_eq!(devices.len(), 2, "{devices:?}");
    assert!(!devices.contains(&reinstalled["device_id"].as_str().unwrap().to_string()));

    // Another key, or none (web, desktop), is another device.
    login(json!("tablet-install-key")).await;
    let browser = login(Value::Null).await;
    let devices = live_devices(browser["access_token"].as_str().unwrap().into()).await;
    assert_eq!(devices.len(), 4, "{devices:?}");
    assert!(devices.contains(&signup["device_id"].as_str().unwrap().to_string()));
}

#[tokio::test]
async fn session_revocation_signs_the_other_device_out_but_refuses_the_current_one() {
    let router = setup().await;
    let (access_a, _, device_a, device_b) = two_devices(&router).await;

    // Revoking the CURRENT device via this route is refused: the route signs *other* devices out,
    // and a stray click must not lock the user out of the device they are holding.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/sessions/{device_a}"),
        Some(&access_a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Revoking the other device succeeds and kills its refresh-token family.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/sessions/{device_b}"),
        Some(&access_a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // An unknown (or already dead) family is a 404 — there is no session to end.
    let (status, _) = send(
        &router,
        "DELETE",
        &format!("/auth/sessions/{}", Uuid::now_v7()),
        Some(&access_a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn revoke_others_keeps_the_caller_signed_in() {
    let router = setup().await;
    let (access_a, access_b, device_a, _device_b) = two_devices(&router).await;

    let (status, _) = send(
        &router,
        "POST",
        "/auth/sessions/revoke-others",
        Some(&access_a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The caller's family survives...
    let (status, body) = send(
        &router,
        "GET",
        "/auth/sessions",
        Some(&access_a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sessions = body.as_array().unwrap();
    assert_eq!(sessions.len(), 1, "only the caller's family remains");
    assert_eq!(sessions[0]["device_id"], device_a.to_string());
    assert_eq!(sessions[0]["current"], true);

    // ...the other device's access token still works until it expires, but its refresh family is
    // gone: its next refresh is rejected (the signed-out signal clients act on).
    let (status, _) = send(&router, "GET", "/auth/me", Some(&access_b), Value::Null).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "access tokens are stateless and live on"
    );
}

#[tokio::test]
async fn sessions_record_and_preserve_device_name() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email,
            "password": PASSWORD,
            "device_name": "Desktop (arch-linux)",
        })),
    )
    .await;
    let (_, login) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({
            "email": email,
            "password": PASSWORD,
            "device_name": "Mobile (Pixel 8)",
        }),
    )
    .await;

    let (status, sessions) = send(
        &router,
        "GET",
        "/auth/sessions",
        login["access_token"].as_str(),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sessions = sessions.as_array().unwrap();
    let desktop = sessions
        .iter()
        .find(|s| s["device_id"] == signup["device_id"])
        .unwrap();
    let mobile = sessions
        .iter()
        .find(|s| s["device_id"] == login["device_id"])
        .unwrap();
    assert_eq!(desktop["device_name"], "Desktop (arch-linux)");
    assert_eq!(mobile["device_name"], "Mobile (Pixel 8)");

    let (_, refreshed) = send(
        &router,
        "POST",
        "/auth/refresh",
        None,
        json!({ "refresh_token": signup["refresh_token"] }),
    )
    .await;
    assert_eq!(refreshed["device_name"], "Desktop (arch-linux)");

    let (_, sessions_after) = send(
        &router,
        "GET",
        "/auth/sessions",
        login["access_token"].as_str(),
        Value::Null,
    )
    .await;
    let desktop_after = sessions_after
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["device_id"] == signup["device_id"])
        .unwrap();
    assert_eq!(desktop_after["device_name"], "Desktop (arch-linux)");
}

#[tokio::test]
async fn sessions_rename_device() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({
            "email": email,
            "password": PASSWORD,
            "device_name": "Initial Name",
        })),
    )
    .await;
    let token = signup["access_token"].as_str();
    let device_id = signup["device_id"].as_str().unwrap();

    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/auth/sessions/{device_id}"),
        token,
        json!({ "name": "Work Laptop" }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, sessions) = send(&router, "GET", "/auth/sessions", token, Value::Null).await;
    assert_eq!(sessions[0]["device_name"], "Work Laptop");

    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/auth/sessions/{device_id}"),
        token,
        json!({ "name": "   " }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &router,
        "PATCH",
        &format!("/auth/sessions/{}", Uuid::now_v7()),
        token,
        json!({ "name": "Whatever" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// Sign an account up and return (email, signup response).
async fn signup_account(router: &Router) -> (String, Value) {
    let email = unique_email();
    let (status, body) = send(
        router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body:?}");
    (email, body)
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

#[tokio::test]
async fn a_login_cannot_claim_another_devices_id_to_survive_revoke_others() {
    let router = setup().await;
    let (email, victim) = signup_account(&router).await;
    let victim_device = victim["device_id"].clone();

    // Someone who once learned the password asks to be the victim's device.
    let (status, attacker) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD, "device_id": victim_device }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{attacker:?}");
    assert_ne!(
        attacker["device_id"], victim_device,
        "the server mints the device id"
    );

    let (_, sessions) = send(
        &router,
        "GET",
        "/auth/sessions",
        victim["access_token"].as_str(),
        Value::Null,
    )
    .await;
    assert_eq!(sessions.as_array().unwrap().len(), 2, "{sessions:?}");

    let (status, _) = send(
        &router,
        "POST",
        "/auth/sessions/revoke-others",
        victim["access_token"].as_str(),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        refresh_status(&router, &attacker["refresh_token"]).await,
        StatusCode::UNAUTHORIZED,
        "the attacker's family is another family"
    );
    assert_eq!(
        refresh_status(&router, &victim["refresh_token"]).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn change_password_spares_only_the_tokens_device_not_a_body_field() {
    let router = setup().await;
    let (email, victim) = signup_account(&router).await;
    let (status, attacker) = send(
        &router,
        "POST",
        "/auth/login",
        None,
        json!({ "email": email, "password": PASSWORD, "device_id": victim["device_id"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The body names the attacker's device; only the token's device may be spared.
    let (status, body) = send(
        &router,
        "POST",
        "/auth/change-password",
        victim["access_token"].as_str(),
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "device_id": attacker["device_id"],
            "encrypted_dek": wrapped_key(),
            "encrypted_private_key": wrapped_key(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body:?}");
    assert_eq!(
        refresh_status(&router, &attacker["refresh_token"]).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        refresh_status(&router, &victim["refresh_token"]).await,
        StatusCode::OK
    );
}

// ---------- Data export ----------

#[tokio::test]
async fn export_returns_account_and_materialized_state_as_an_attachment() {
    let router = setup().await;
    let email = unique_email();
    let (_, signup) = send(
        &router,
        "POST",
        "/auth/signup",
        None,
        with_keys(json!({ "email": email, "password": PASSWORD })),
    )
    .await;
    let access = signup["access_token"].as_str().unwrap();

    // Push ops so the materialized state is non-empty (one live task title, one deleted task).
    let tid = Uuid::now_v7();
    let (status, _) = send(
        &router,
        "POST",
        "/sync/push",
        Some(access),
        json!({
            "operations": [
                { "id": Uuid::now_v7(), "entity": "task", "entity_id": tid, "op": "set",
                  "field": "title", "value": "Buy milk",
                  "ts": { "wall_ms": 100, "counter": 0, "node": Uuid::now_v7() } }
            ]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, disposition, body_bytes) = {
        let req = Request::builder()
            .method("GET")
            .uri("/auth/export")
            .header("authorization", format!("Bearer {access}"))
            .body(Body::empty())
            .unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let disposition = res
            .headers()
            .get("content-disposition")
            .map(|v| v.to_str().unwrap().to_string());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, disposition, bytes)
    };
    assert_eq!(status, StatusCode::OK);
    let disposition = disposition.expect("the export is served as a named attachment download");
    assert!(
        disposition.starts_with("attachment; filename=\"atlas-export-")
            && disposition.ends_with(".json\""),
        "{disposition}"
    );

    let body: Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(body["account"]["email"], email);
    assert_eq!(body["account"]["is_admin"], false);
    assert!(body["account"]["created_at"].is_i64());
    assert!(
        body.get("account").unwrap().get("password_hash").is_none(),
        "the export never carries the password hash"
    );
    let rendered = serde_json::to_string(&body).unwrap();
    assert!(
        !rendered.contains("password_hash") && !rendered.contains("recovery_encrypted"),
        "neither the hash nor the recovery blobs appear anywhere in the export"
    );

    // The materialized state rides the snapshot machinery's op shape.
    let ops = body["data"]["operations"].as_array().unwrap();
    assert!(
        ops.iter()
            .any(|op| op["op"] == "set" && op["field"] == "title" && op["value"] == "Buy milk"),
        "the pushed task title is in the export: {ops:?}"
    );

    // Without a token the export is unreachable.
    let (status, _) = send(&router, "GET", "/auth/export", None, Value::Null).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
