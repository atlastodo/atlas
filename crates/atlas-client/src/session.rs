//! A signed-in account held in memory (`AtlasClient.connect` in `packages/sdk`): an API-token
//! session, the keys the token carries, the store and its sync.

use std::path::PathBuf;
use std::sync::Arc;

use uuid::Uuid;

use crate::api::{ApiClient, Transport, UreqTransport};
use crate::crypto::{
    derive_api_token_keys, parse_api_token, unwrap_api_token_app_keys, unwrap_api_token_keys,
    unwrap_signing_key, x25519_public_key, ApiTokenParts, Keyring, TODO_APP,
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
    token: Arc<ApiTokenParts>,
    server_url: String,
    state_dir: Option<PathBuf>,
}

impl Session {
    pub fn connect(opts: ConnectOptions) -> Result<Self> {
        let parts = Arc::new(parse_api_token(&opts.token)?);
        let app = opts.app.clone();
        if atlas_core::Registry::bundled().app(&app).is_none() {
            return Err(Error::atlas(
                "unknown_app",
                format!("\"{app}\" is not an Atlas app this client knows"),
            ));
        }
        let todo = app == TODO_APP;
        let auth = derive_api_token_keys(&parts).auth;
        let transport = opts
            .transport
            .unwrap_or_else(|| Box::new(UreqTransport::default()));
        let mut api = ApiClient::new(&opts.server_url, transport);
        if opts.check_discovery {
            let discovery = api.get_discovery()?;
            // An app other than todo needs sessions scoped to it and tokens that carry its key.
            let capabilities: &[&str] = if todo {
                &["api_tokens"]
            } else {
                &["api_tokens", "app_scoped_sync", "app_scoped_api_tokens"]
            };
            let required = ServerRequirements {
                min_protocol: Some(REQUIRED_PROTOCOL),
                capabilities,
                apps: &[app.as_str()],
            };
            // A legacy server (no discovery) still gets its chance with todo: an old one fails the
            // token exchange with its own error. It offers no other app.
            if !discovery.legacy || !todo {
                if let Some(problem) = server_incompatibility(&discovery, &required) {
                    return Err(Error::atlas(
                        "server_incompatible",
                        describe_incompatibility(&problem, &discovery),
                    ));
                }
            }
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
        let mut store = match opts.store {
            Some(make) => make(node),
            None => Store::new(node),
        };
        let mut cursor = 0;
        if let Some(dir) = &opts.state_dir {
            if let Some(cached) = state::load(dir, &parts, &opts.server_url, &app) {
                if cached.user_id == session.user_id {
                    store.apply_remote_batch(&cached.ops);
                    for pending in cached.sealed {
                        store.add_sealed(pending);
                    }
                    cursor = cached.cursor;
                }
            }
        }
        let mut s = Session {
            api,
            store,
            sync: SyncClient::new(cursor),
            keyring,
            user_id: session.user_id,
            app,
            can_write: session.write,
            token_expires_at: session.expires_at,
            token: parts.clone(),
            server_url: opts.server_url.clone(),
            state_dir: opts.state_dir,
        };
        s.initial_sync()?;
        Ok(s)
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

    /// One sync cycle.
    pub fn sync_now(&mut self) -> Result<SyncResult> {
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
        state::save(dir, &self.token, &self.server_url, &self.app, &cached)?;
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
