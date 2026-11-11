//! Password sign-in (`Session::login`), keeping and resuming it (`Session::credentials`,
//! `Session::resume`), refresh-token rotation and sign-out, against the `FakeServer`; and
//! `open_account_keys`, which opens the keys a sign-in returns.

use atlas_client::crypto::{
    open_account_keys, random_bytes, wrap_app_key, wrap_app_private_key, wrap_key, wrap_root_key,
    AccountKeySource, AppKeyRow, TODO_APP,
};
use atlas_client::session::{LoginOptions, ResumeOptions, Session};
use atlas_client::testing::{FakeServer, PasswordKeys, USER_ID};
use atlas_client::Error;
use serde_json::json;

const EMAIL: &str = "alex@example.com";
const PASSWORD: &str = "correct horse battery staple";

fn login_opts(server: &FakeServer, email: &str, password: &str) -> LoginOptions {
    let mut opts = LoginOptions::new("http://atlas.test", email, password);
    opts.transport = Some(server.transport());
    opts.device_name = Some("Atlas Todo desktop on test".into());
    opts.install_key = Some("install-1".into());
    opts
}

fn login(server: &FakeServer) -> Session {
    Session::login(login_opts(server, EMAIL, PASSWORD)).expect("signs in")
}

fn resume(server: &FakeServer, session: &Session) -> atlas_client::Result<Session> {
    let mut opts = ResumeOptions::new(session.credentials().expect("password session"));
    opts.transport = Some(server.transport());
    Session::resume(opts)
}

#[test]
fn signs_in_through_the_root_key_and_sends_only_the_auth_hash() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let session = login(&server);
    assert_eq!(session.user_id, USER_ID);
    assert_eq!(session.keyring.dek(), &server.dek);
    assert_eq!(session.keyring.private_key(), Some(&server.private_key));
    assert!(session.can_write);

    let st = server.state.lock().unwrap();
    let body = &st.password.as_ref().unwrap().logins[0];
    assert_eq!(body["email"], json!(EMAIL));
    assert_ne!(
        body["password"],
        json!(PASSWORD),
        "the password itself is never sent"
    );
    assert_eq!(body["device_name"], json!("Atlas Todo desktop on test"));
    assert_eq!(body["install_key"], json!("install-1"));
    // Signed in, then synced with the access token the login issued.
    assert!(st.log.iter().any(|l| l == "GET /auth/salt"));
    assert!(st.log.iter().any(|l| l.starts_with("GET /sync/")));
}

#[test]
fn signs_in_an_account_from_before_root_keys_through_its_legacy_wraps() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Legacy);
    let session = login(&server);
    assert_eq!(session.keyring.dek(), &server.dek);
}

#[test]
fn normalizes_the_email() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    Session::login(login_opts(&server, "  Alex@Example.COM ", PASSWORD)).expect("signs in");
}

#[test]
fn a_wrong_password_is_the_servers_401() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let err = Session::login(login_opts(&server, EMAIL, "wrong"))
        .err()
        .expect("refused");
    assert!(matches!(err, Error::Api { status: 401, .. }), "{err:?}");
}

#[test]
fn resumes_from_its_credentials_without_the_password_and_rotates_the_refresh_token() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let first = login(&server);
    let kept = first.credentials().unwrap();
    assert_eq!(kept.user_id, USER_ID);
    assert!(
        !format!("{kept:?}").contains(&kept.refresh_token),
        "Debug hides secrets"
    );

    let resumed = resume(&server, &first).expect("resumes");
    assert_eq!(resumed.keyring.dek(), &server.dek);
    assert_eq!(resumed.keyring.private_key(), Some(&server.private_key));
    let rotated = resumed.credentials().unwrap();
    assert_ne!(rotated.refresh_token, kept.refresh_token);

    // The kept, now rotated, token no longer resumes (and ends the family, as the server does).
    let mut stale = ResumeOptions::new(kept);
    stale.transport = Some(server.transport());
    let err = Session::resume(stale).err().expect("refused");
    assert!(matches!(err, Error::Api { status: 401, .. }), "{err:?}");
}

#[test]
fn an_expired_access_token_is_refreshed_and_the_new_refresh_token_kept() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let mut session = login(&server);
    let before = session.credentials().unwrap().refresh_token;
    server
        .state
        .lock()
        .unwrap()
        .expired
        .push("password-access-1".into());
    session.sync_now().expect("syncs after a refresh");
    let after = session.credentials().unwrap().refresh_token;
    assert_ne!(after, before);
    assert!(server
        .state
        .lock()
        .unwrap()
        .log
        .iter()
        .any(|l| l == "POST /auth/refresh"));
}

#[test]
fn logout_ends_the_session() {
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let session = login(&server);
    session.logout().expect("signs out");
    let err = resume(&server, &session).err().expect("ended");
    assert!(matches!(err, Error::Api { status: 401, .. }), "{err:?}");
}

#[test]
fn caches_the_synced_state_per_device() {
    let dir = std::env::temp_dir().join(format!("atlas-password-state-{}", std::process::id()));
    let server = FakeServer::with_password(EMAIL, PASSWORD, PasswordKeys::Root);
    let mut opts = login_opts(&server, EMAIL, PASSWORD);
    opts.state_dir = Some(dir.clone());
    let session = Session::login(opts).expect("signs in");
    assert!(session.save_state().expect("writes"));
    assert!(dir
        .join("session-01920000-0000-7000-8000-0000000000dd.state")
        .exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_api_token_session_has_no_credentials_to_keep() {
    let server = FakeServer::new();
    let mut opts =
        atlas_client::session::ConnectOptions::new("http://atlas.test", &server.token_string());
    opts.transport = Some(server.transport());
    let session = Session::connect(opts).expect("connects");
    assert!(session.credentials().is_none());
}

/// The keys of an account: a root with the todo row, and the legacy wraps.
struct Account {
    mek: [u8; 32],
    dek: [u8; 32],
    private_key: [u8; 32],
    root: [u8; 32],
}

fn account() -> Account {
    Account {
        mek: random_bytes(),
        dek: random_bytes(),
        private_key: random_bytes(),
        root: random_bytes(),
    }
}

fn todo_row(a: &Account, with_identity: bool) -> AppKeyRow {
    AppKeyRow {
        app: TODO_APP.into(),
        wrapped_key: wrap_app_key(&a.dek, &a.root, USER_ID, TODO_APP).unwrap(),
        wrapped_private_key: with_identity
            .then(|| wrap_app_private_key(&a.private_key, &a.dek, USER_ID, TODO_APP).unwrap()),
    }
}

#[test]
fn open_account_keys_prefers_the_root_key() {
    let a = account();
    let wrap = wrap_root_key(&a.root, &a.mek, USER_ID, "password").unwrap();
    let keys = open_account_keys(
        USER_ID,
        &a.mek,
        Some(&wrap),
        &[todo_row(&a, true)],
        None,
        None,
    )
    .unwrap();
    assert_eq!(keys.source, AccountKeySource::Root);
    assert_eq!((keys.dek, keys.private_key), (a.dek, a.private_key));
    assert_eq!(keys.root_key, Some(a.root));
}

#[test]
fn open_account_keys_takes_a_rowless_identity_from_the_legacy_wrap() {
    let a = account();
    let wrap = wrap_root_key(&a.root, &a.mek, USER_ID, "password").unwrap();
    let legacy_private = wrap_key(&a.private_key, &a.mek).unwrap();
    let keys = open_account_keys(
        USER_ID,
        &a.mek,
        Some(&wrap),
        &[todo_row(&a, false)],
        None,
        Some(&legacy_private),
    )
    .unwrap();
    assert_eq!(keys.source, AccountKeySource::Root);
    assert_eq!(keys.private_key, a.private_key);
}

#[test]
fn open_account_keys_falls_back_to_the_legacy_wraps_past_a_stale_root_slot() {
    let a = account();
    // Wrapped under another password's MEK: it does not open with this one.
    let stale = wrap_root_key(&a.root, &random_bytes(), USER_ID, "password").unwrap();
    let dek = wrap_key(&a.dek, &a.mek).unwrap();
    let private_key = wrap_key(&a.private_key, &a.mek).unwrap();
    let keys = open_account_keys(
        USER_ID,
        &a.mek,
        Some(&stale),
        &[todo_row(&a, true)],
        Some(&dek),
        Some(&private_key),
    )
    .unwrap();
    assert_eq!(keys.source, AccountKeySource::Legacy);
    assert_eq!((keys.dek, keys.private_key), (a.dek, a.private_key));
}

#[test]
fn open_account_keys_fails_when_nothing_opens() {
    let a = account();
    let other_mek: [u8; 32] = random_bytes();
    let dek = wrap_key(&a.dek, &other_mek).unwrap();
    let private_key = wrap_key(&a.private_key, &other_mek).unwrap();
    assert!(open_account_keys(USER_ID, &a.mek, None, &[], Some(&dek), Some(&private_key)).is_err());
    assert!(open_account_keys(USER_ID, &a.mek, None, &[], None, None).is_err());
}
