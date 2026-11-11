//! A signed-in account held in memory: an API-token session (`TokenSession.connect` in
//! `packages/sdk`), or a password sign-in ([`Session::login`]) that a client can keep and resume
//! ([`Session::credentials`], [`Session::resume`]); the keys either carries, the store and its sync.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::{ApiClient, AuthResponse, Transport, UreqTransport};
use crate::crypto::{
    derive_api_token_keys, derive_auth_and_mek, kdf_from_wire, open_account_keys, open_app_keys,
    parse_api_token, unwrap_api_token_app_keys, unwrap_api_token_keys, unwrap_root_key,
    unwrap_signing_key, x25519_public_key, ApiTokenParts, Keyring, LEGACY_KDF, TODO_APP,
};
use crate::discovery::{describe_incompatibility, server_incompatibility, ServerRequirements};
use crate::error::{Error, Result};
use crate::project_keys::{hydrate_project_keys, HydrateOptions};
use crate::scope::{is_project_creator, revive_locked_values};
use crate::state;
use crate::store::Store;
use crate::sync::{SyncClient, SyncContext, SyncResult};
use crate::trust::read_key_trust;

pub struct ConnectOptions {
    /// The server, e.g. `https://app.atlastodo.dev` (an `/api` suffix is fine too).
    pub server_url: String,
    /// An `atlas_pat_…` token.
    pub token: String,
    /// IANA zone for due dates and recurrence; the system's when `None`.
    pub time_zone: Option<String>,
    /// How requests travel; HTTPS by default.
    pub transport: Option<Box<dyn Transport>>,
    /// Check `GET /discovery` before signing in.
    pub check_discovery: bool,
    /// For tests: the store's clock and id source.
    pub store: Option<Box<dyn FnOnce(Uuid) -> Store>>,
    /// Where the synced account is cached between runs ([`crate::state`]).
    pub state_dir: Option<PathBuf>,
    /// The app this session syncs (`todo`, `journal`): its key opens the session's data, and every
    /// sync request names it in `x-atlas-sync-apps`.
    pub app: String,
}

impl ConnectOptions {
    pub fn new(server_url: &str, token: &str) -> Self {
        Self {
            server_url: server_url.to_owned(),
            token: token.to_owned(),
            time_zone: None,
            transport: None,
            check_discovery: true,
            store: None,
            state_dir: None,
            app: TODO_APP.to_owned(),
        }
    }
}

/// The bundled app's display name (`Atlas Journal`), or its id.
pub fn app_name(app: &str) -> String {
    atlas_core::Registry::bundled()
        .app(app)
        .map_or_else(|| app.to_owned(), |m| m.name.clone())
}

/// The oldest sync protocol this client works with and what it needs from the server.
pub const REQUIRED_PROTOCOL: i64 = 6;

pub struct Session {
    pub api: ApiClient,
    pub store: Store,
    pub sync: SyncClient,
    pub keyring: Keyring,
    pub user_id: String,
    /// The app this session syncs.
    pub app: String,
    /// Whether the token may write; a read-only one (the default for an Atlas Vault token) is
    /// refused every write by the server, so the client refuses it first.
    pub can_write: bool,
    /// When the token expires (unix ms), if it does.
    pub token_expires_at: Option<i64>,
    credential: Credential,
    server_url: String,
    state_dir: Option<PathBuf>,
}

/// How a session authenticates: an API token, or the refresh token of a password sign-in (rotated
/// at every refresh, hence shared with the API client's re-authentication).
enum Credential {
    Token(Arc<ApiTokenParts>),
    Password {
        refresh_token: Arc<Mutex<String>>,
        device_id: String,
    },
}

/// What [`Session::login`] takes.
pub struct LoginOptions {
    /// The server, e.g. `https://app.atlastodo.dev` (an `/api` suffix is fine too).
    pub server_url: String,
    pub email: String,
    pub password: String,
    /// How this installation shows in the account's sessions, e.g. `Atlas Todo desktop on ideapad`.
    pub device_name: Option<String>,
    /// A stable random id of this installation: signing in again ends its older sessions instead
    /// of adding one.
    pub install_key: Option<String>,
    /// How requests travel; HTTPS by default.
    pub transport: Option<Box<dyn Transport>>,
    /// Check `GET /discovery` before signing in.
    pub check_discovery: bool,
    /// For tests: the store's clock and id source.
    pub store: Option<Box<dyn FnOnce(Uuid) -> Store>>,
    /// Where the synced account is cached between runs ([`crate::state`]).
    pub state_dir: Option<PathBuf>,
    /// The app this session syncs.
    pub app: String,
}

impl LoginOptions {
    pub fn new(server_url: &str, email: &str, password: &str) -> Self {
        Self {
            server_url: server_url.to_owned(),
            email: email.to_owned(),
            password: password.to_owned(),
            device_name: None,
            install_key: None,
            transport: None,
            check_discovery: true,
            store: None,
            state_dir: None,
            app: TODO_APP.to_owned(),
        }
    }
}

/// A password session to keep between runs ([`Session::credentials`]): its refresh token and the
/// keys the password opened. As secret as the password: keep it in the platform's secret store.
/// The refresh token rotates at every use, so keep the newest (after [`Session::resume`] and
/// whenever the session may have refreshed); an older one ends the session when presented.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCredentials {
    pub v: u8,
    pub server_url: String,
    pub app: String,
    pub user_id: String,
    pub device_id: String,
    pub refresh_token: String,
    /// The app's key (todo's is the DEK), hex.
    pub key: String,
    /// The app's X25519 identity, hex.
    pub private_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// The todo identity's Ed25519 signing key, hex, when the account has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_key: Option<String>,
}

const CREDENTIALS_VERSION: u8 = 1;

impl std::fmt::Debug for SessionCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionCredentials")
            .field("server_url", &self.server_url)
            .field("app", &self.app)
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

/// What [`Session::resume`] takes.
pub struct ResumeOptions {
    pub credentials: SessionCredentials,
    pub transport: Option<Box<dyn Transport>>,
    pub check_discovery: bool,
    pub store: Option<Box<dyn FnOnce(Uuid) -> Store>>,
    pub state_dir: Option<PathBuf>,
}

impl ResumeOptions {
    pub fn new(credentials: SessionCredentials) -> Self {
        Self {
            credentials,
            transport: None,
            check_discovery: true,
            store: None,
            state_dir: None,
        }
    }
}

fn check_app(app: &str) -> Result<()> {
    if atlas_core::Registry::bundled().app(app).is_none() {
        return Err(Error::atlas(
            "unknown_app",
            format!("\"{app}\" is not an Atlas app this client knows"),
        ));
    }
    Ok(())
}

/// Refuse a server this client cannot sync `app` with. A token session also needs API tokens.
fn check_server(api: &ApiClient, app: &str, token: bool) -> Result<()> {
    let todo = app == TODO_APP;
    let discovery = api.get_discovery()?;
    let mut capabilities: Vec<&str> = Vec::new();
    if token {
        capabilities.push("api_tokens");
    }
    if !todo {
        // An app other than todo needs sessions scoped to it (and tokens that carry its key).
        capabilities.push("app_scoped_sync");
        if token {
            capabilities.push("app_scoped_api_tokens");
        }
    }
    let required = ServerRequirements {
        min_protocol: Some(REQUIRED_PROTOCOL),
        capabilities: &capabilities,
        apps: &[app],
    };
    // A legacy server (no discovery) still gets its chance with todo: an old one fails the sign-in
    // with its own error. It offers no other app.
    if !discovery.legacy || !todo {
        if let Some(problem) = server_incompatibility(&discovery, &required) {
            return Err(Error::atlas(
                "server_incompatible",
                describe_incompatibility(&problem, &discovery),
            ));
        }
    }
    Ok(())
}

fn bad_key(what: &str) -> Error {
    Error::atlas(
        "bad_credentials",
        format!("the saved session's {what} is not a key"),
    )
}

fn hex32(hex_str: &str, what: &str) -> Result<[u8; 32]> {
    hex::decode(hex_str)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| bad_key(what))
}

/// A password session's access tokens come from its refresh token, which rotates every time.
fn refresh_with(api: &mut ApiClient, refresh_token: &Arc<Mutex<String>>) {
    let shared = refresh_token.clone();
    api.set_reauthenticate(Box::new(move |api: &ApiClient| {
        let mut current = shared.lock().expect("refresh token lock");
        let next = api.refresh(&current)?;
        *current = next.refresh_token;
        Ok(next.access_token)
    }));
}

impl Session {
    pub fn connect(opts: ConnectOptions) -> Result<Self> {
        let parts = Arc::new(parse_api_token(&opts.token)?);
        let app = opts.app.clone();
        check_app(&app)?;
        let todo = app == TODO_APP;
        let auth = derive_api_token_keys(&parts).auth;
        let transport = opts
            .transport
            .unwrap_or_else(|| Box::new(UreqTransport::default()));
        let mut api = ApiClient::new(&opts.server_url, transport);
        if opts.check_discovery {
            check_server(&api, &app, true)?;
        }
        // Token sessions have no refresh token: an expired one is opened again.
        let (id, again) = (parts.id.clone(), auth.clone());
        api.set_reauthenticate(Box::new(move |api: &ApiClient| {
            Ok(api.open_api_token_session(&id, &again)?.access_token)
        }));
        let session = api.open_api_token_session(&parts.id, &auth)?;
        api.set_token(Some(session.access_token.clone()));
        api.set_sync_apps(Some(app.clone()));

        if !session.apps.contains(&app) {
            let carried: Vec<String> = session.apps.iter().map(|a| app_name(a)).collect();
            return Err(Error::atlas(
                "app_not_in_token",
                format!(
                    "this API token is not for {} (it is for {}); make a token that includes it",
                    app_name(&app),
                    carried.join(", ")
                ),
            ));
        }
        let missing_key = || {
            Error::atlas(
                "app_not_in_token",
                format!(
                    "the server sent no {} key for this API token",
                    app_name(&app)
                ),
            )
        };
        let keyring = if todo {
            let (Some(wrapped_dek), Some(wrapped_private_key)) =
                (&session.wrapped_dek, &session.wrapped_private_key)
            else {
                return Err(missing_key());
            };
            let (dek, private_key) =
                unwrap_api_token_keys(&parts, &session.user_id, wrapped_dek, wrapped_private_key)?;
            let mut keyring = Keyring::new(dek, private_key, session.public_key.clone());
            if let (Some(wrapped), Some(public)) =
                (&session.encrypted_signing_key, &session.signing_public_key)
            {
                // Only needed to rotate or deliver project keys, which this client never does.
                if let Ok(secret) = unwrap_signing_key(wrapped, &dek, public) {
                    keyring.set_signing_key(secret);
                }
            }
            keyring
        } else {
            // Another app's key plays the DEK's part for that app's data: its values are
            // personal-scope field envelopes under the app key (`kid` "dek"). Personal only: no
            // shared projects, no values from before field envelopes, no key trust state.
            let wraps = session.app_keys.get(&app).ok_or_else(missing_key)?;
            let (app_key, private_key) =
                unwrap_api_token_app_keys(&parts, &session.user_id, &app, wraps)?;
            api.set_legacy_migrated(true);
            Keyring::new(app_key, private_key, Some(x25519_public_key(&private_key)))
        };
        // The token id is this client's device: its HLC node and its session's device id.
        let node = Uuid::parse_str(&parts.id).map_err(|_| Error::Protocol("token id".into()))?;
        Self::assemble(Assembly {
            api,
            keyring,
            user_id: session.user_id,
            app,
            node,
            can_write: session.write,
            token_expires_at: session.expires_at,
            credential: Credential::Token(parts),
            server_url: opts.server_url,
            state_dir: opts.state_dir,
            store: opts.store,
        })
    }

    /// Sign in with an email and password, as the apps' sign-in screen does: derive the auth hash
    /// and the MEK with the account's KDF (`GET /auth/salt`), sign in (`POST /auth/login`), and
    /// open the account's keys through its root key or, before root keys, its legacy wraps. Never
    /// changes the account (no root-key migration or KDF upgrade: the apps do those).
    ///
    /// A wrong email or password fails with the server's 401. Keep [`Session::credentials`] to
    /// [`Session::resume`] later without the password.
    pub fn login(opts: LoginOptions) -> Result<Self> {
        let app = opts.app.clone();
        check_app(&app)?;
        let transport = opts
            .transport
            .unwrap_or_else(|| Box::new(UreqTransport::default()));
        let mut api = ApiClient::new(&opts.server_url, transport);
        if opts.check_discovery {
            check_server(&api, &app, false)?;
        }
        let email = opts.email.trim().to_lowercase();
        let salt = api.get_salt(&email)?;
        let kdf = kdf_from_wire(&salt.kdf_version, &salt.kdf_params)?.unwrap_or(LEGACY_KDF);
        let derived = derive_auth_and_mek(&opts.password, &salt.salt, kdf)?;
        let auth = api.login(
            &email,
            &derived.auth_hash,
            opts.device_name.as_deref(),
            opts.install_key.as_deref(),
        )?;
        let keyring = keyring_of(&auth, &derived.mek, &app)?;
        if app != TODO_APP {
            api.set_legacy_migrated(true);
        }
        let refresh_token = Arc::new(Mutex::new(auth.refresh_token.clone()));
        refresh_with(&mut api, &refresh_token);
        api.set_token(Some(auth.access_token.clone()));
        api.set_sync_apps(Some(app.clone()));
        Self::assemble_password(
            api,
            keyring,
            auth,
            app,
            refresh_token,
            opts.server_url,
            opts.state_dir,
            opts.store,
        )
    }

    /// Resume a password session from [`Session::credentials`]: a fresh access token from the
    /// refresh token (which rotates: keep [`Session::credentials`] again afterwards) and the keys
    /// the credentials carry. Fails with the server's 401 when the session has ended (signed out,
    /// expired, revoked): sign in again.
    pub fn resume(opts: ResumeOptions) -> Result<Self> {
        let c = opts.credentials;
        if c.v != CREDENTIALS_VERSION {
            return Err(Error::atlas(
                "bad_credentials",
                "the saved session is from another version of this client; sign in again",
            ));
        }
        check_app(&c.app)?;
        let key = hex32(&c.key, "app key")?;
        let private_key = hex32(&c.private_key, "private key")?;
        let mut keyring = Keyring::new(
            key,
            private_key,
            Some(
                c.public_key
                    .clone()
                    .unwrap_or_else(|| x25519_public_key(&private_key)),
            ),
        );
        if let Some(signing) = &c.signing_key {
            keyring.set_signing_key(hex32(signing, "signing key")?);
        }
        let transport = opts
            .transport
            .unwrap_or_else(|| Box::new(UreqTransport::default()));
        let mut api = ApiClient::new(&c.server_url, transport);
        if opts.check_discovery {
            check_server(&api, &c.app, false)?;
        }
        let auth = api.refresh(&c.refresh_token)?;
        if auth.user.id != c.user_id {
            return Err(Error::atlas(
                "bad_credentials",
                "the saved session belongs to another account",
            ));
        }
        if c.app != TODO_APP {
            api.set_legacy_migrated(true);
        }
        let refresh_token = Arc::new(Mutex::new(auth.refresh_token.clone()));
        refresh_with(&mut api, &refresh_token);
        api.set_token(Some(auth.access_token.clone()));
        api.set_sync_apps(Some(c.app.clone()));
        Self::assemble_password(
            api,
            keyring,
            auth,
            c.app,
            refresh_token,
            c.server_url,
            opts.state_dir,
            opts.store,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn assemble_password(
        api: ApiClient,
        keyring: Keyring,
        auth: AuthResponse,
        app: String,
        refresh_token: Arc<Mutex<String>>,
        server_url: String,
        state_dir: Option<PathBuf>,
        store: Option<Box<dyn FnOnce(Uuid) -> Store>>,
    ) -> Result<Self> {
        // The device the server keeps for this sign-in is this client's HLC node.
        let node =
            Uuid::parse_str(&auth.device_id).map_err(|_| Error::Protocol("device id".into()))?;
        Self::assemble(Assembly {
            api,
            keyring,
            user_id: auth.user.id,
            app,
            node,
            can_write: true,
            token_expires_at: None,
            credential: Credential::Password {
                refresh_token,
                device_id: auth.device_id,
            },
            server_url,
            state_dir,
            store,
        })
    }

    fn assemble(a: Assembly) -> Result<Self> {
        let mut store = match a.store {
            Some(make) => make(a.node),
            None => Store::new(a.node),
        };
        let mut s = Session {
            api: a.api,
            store: Store::new(a.node),
            sync: SyncClient::new(0),
            keyring: a.keyring,
            user_id: a.user_id,
            app: a.app,
            can_write: a.can_write,
            token_expires_at: a.token_expires_at,
            credential: a.credential,
            server_url: a.server_url,
            state_dir: a.state_dir,
        };
        let mut cursor = 0;
        if let Some(dir) = &s.state_dir {
            if let Some(cached) = state::load_keyed(dir, &s.state_key(), &s.server_url, &s.app) {
                if cached.user_id == s.user_id {
                    store.apply_remote_batch(&cached.ops);
                    for pending in cached.sealed {
                        store.add_sealed(pending);
                    }
                    cursor = cached.cursor;
                }
            }
        }
        s.store = store;
        s.sync = SyncClient::new(cursor);
        s.initial_sync()?;
        Ok(s)
    }

    fn state_key(&self) -> state::StateKey {
        match &self.credential {
            Credential::Token(parts) => state::StateKey::for_token(parts),
            Credential::Password { device_id, .. } => {
                state::StateKey::for_device(device_id, self.keyring.dek())
            }
        }
    }

    /// A password session's credentials to keep between runs, with the newest refresh token;
    /// `None` for an API-token session (the token is its own credential).
    pub fn credentials(&self) -> Option<SessionCredentials> {
        let Credential::Password {
            refresh_token,
            device_id,
        } = &self.credential
        else {
            return None;
        };
        Some(SessionCredentials {
            v: CREDENTIALS_VERSION,
            server_url: self.server_url.clone(),
            app: self.app.clone(),
            user_id: self.user_id.clone(),
            device_id: device_id.clone(),
            refresh_token: refresh_token.lock().expect("refresh token lock").clone(),
            key: hex::encode(self.keyring.dek()),
            private_key: hex::encode(self.keyring.private_key()?),
            public_key: self.keyring.public_key().map(str::to_owned),
            signing_key: self.keyring.signing_key().map(hex::encode),
        })
    }

    /// Sign a password session out on the server (`POST /auth/logout`); forget its credentials
    /// too. Nothing to do for an API-token session (revoke the token in Settings).
    pub fn logout(&self) -> Result<()> {
        if let Credential::Password { refresh_token, .. } = &self.credential {
            let token = refresh_token.lock().expect("refresh token lock").clone();
            self.api.logout(&token)?;
        }
        Ok(())
    }

    /// Pull everything, then load the shared projects' keys under the synced trust state.
    fn initial_sync(&mut self) -> Result<()> {
        self.sync_now()?;
        if self.app != TODO_APP {
            // Shared projects and their keys are todo's.
            return Ok(());
        }
        let user_id = self.user_id.clone();
        let trust = read_key_trust(&self.store);
        // `isProjectCreator` is false for a project neither in the store nor in a member row.
        let members = self.store.list(atlas_core::EntityKind::ProjectMember);
        let creators: Vec<String> = self
            .store
            .list(atlas_core::EntityKind::Project)
            .into_iter()
            .map(|e| e.id)
            .chain(members.into_iter().filter_map(|e| {
                e.fields
                    .get("project_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned)
            }))
            .filter(|p| is_project_creator(&self.store, p, &user_id))
            .collect();
        let is_creator = move |p: &str| creators.iter().any(|c| c == p);
        let result = hydrate_project_keys(
            &self.api,
            &mut self.keyring,
            &mut self.store,
            HydrateOptions {
                is_creator: &is_creator,
                trust,
                user_id: Some(&user_id),
                record: true,
            },
        )?;
        if result.changed {
            let legacy = !self.api.is_legacy_migrated(&self.store);
            revive_locked_values(&mut self.store, &self.keyring, Some(&user_id), legacy);
            self.sync_now()?;
        }
        Ok(())
    }

    /// One sync cycle. Refused while writes of an app with shared projects wait and the app has
    /// registered no definition (`crate::apps::assert_apps_defined`).
    pub fn sync_now(&mut self) -> Result<SyncResult> {
        if !self.store.unsynced_ops().is_empty() {
            crate::apps::assert_apps_defined([self.app.as_str()]).map_err(Error::Protocol)?;
        }
        let mut cx = SyncContext {
            api: &self.api,
            store: &mut self.store,
            keyring: &self.keyring,
            user_id: Some(&self.user_id),
        };
        self.sync.sync(&mut cx)
    }

    /// Cache the synced state in the state directory, when there is one and nothing is pending.
    /// Returns whether it was written.
    pub fn save_state(&self) -> std::io::Result<bool> {
        let Some(dir) = &self.state_dir else {
            return Ok(false);
        };
        if !self.store.unsynced_ops().is_empty() {
            return Ok(false);
        }
        let cached = state::CachedState {
            user_id: self.user_id.clone(),
            cursor: self.sync.cursor(),
            ops: self.store.winning_ops(),
            sealed: self.store.sealed().to_vec(),
        };
        state::save_keyed(dir, &self.state_key(), &self.server_url, &self.app, &cached)?;
        Ok(true)
    }

    /// Fail with `api_token_read_only` before a write a read-only token could not push.
    pub fn require_write(&self) -> Result<()> {
        if self.can_write {
            return Ok(());
        }
        Err(Error::atlas(
            "api_token_read_only",
            format!(
                "this API token is read-only: changing {} data needs a token made with write access",
                app_name(&self.app)
            ),
        ))
    }

    /// Push pending writes; fails when any did not reach the server.
    pub fn push(&mut self) -> Result<()> {
        self.sync_now()?;
        let pending = self.store.unsynced_ops().len();
        if pending > 0 {
            return Err(Error::atlas(
                "not_pushed",
                format!(
                    "{pending} change(s) did not reach the server (a shared project whose key is missing?)"
                ),
            ));
        }
        Ok(())
    }
}

/// What every way of signing in hands [`Session::assemble`].
struct Assembly {
    api: ApiClient,
    keyring: Keyring,
    user_id: String,
    app: String,
    node: Uuid,
    can_write: bool,
    token_expires_at: Option<i64>,
    credential: Credential,
    server_url: String,
    state_dir: Option<PathBuf>,
    store: Option<Box<dyn FnOnce(Uuid) -> Store>>,
}

/// The keyring a password sign-in opens for `app`: todo's through [`open_account_keys`] (the root
/// key, else the legacy wraps), with the signing key when the account has one; another app's under
/// the root key alone.
fn keyring_of(auth: &AuthResponse, mek: &[u8; 32], app: &str) -> Result<Keyring> {
    let wrong = |e: crate::crypto::CryptoError| {
        Error::atlas(
            "keys_not_opened",
            format!("the account's keys did not open with this password: {e}"),
        )
    };
    let user_id = &auth.user.id;
    if app == TODO_APP {
        let keys = open_account_keys(
            user_id,
            mek,
            auth.encrypted_root_key.as_ref(),
            &auth.app_keys,
            auth.encrypted_dek.as_ref(),
            auth.encrypted_private_key.as_ref(),
        )
        .map_err(wrong)?;
        let public_key = auth
            .public_key
            .clone()
            .unwrap_or_else(|| x25519_public_key(&keys.private_key));
        let mut keyring = Keyring::new(keys.dek, keys.private_key, Some(public_key));
        if let (Some(wrapped), Some(public)) =
            (&auth.encrypted_signing_key, &auth.signing_public_key)
        {
            if let Ok(secret) = unwrap_signing_key(wrapped, &keys.dek, public) {
                keyring.set_signing_key(secret);
            }
        }
        return Ok(keyring);
    }
    let wrap = auth.encrypted_root_key.as_ref().ok_or_else(|| {
        Error::atlas(
            "root_key_required",
            format!(
                "{} needs the account's root key: sign in once in the app to set it up",
                app_name(app)
            ),
        )
    })?;
    let root = unwrap_root_key(wrap, mek, user_id, "password").map_err(wrong)?;
    let (app_key, private_key) =
        open_app_keys(&root, user_id, app, &auth.app_keys).map_err(wrong)?;
    Ok(Keyring::new(
        app_key,
        private_key,
        Some(x25519_public_key(&private_key)),
    ))
}
