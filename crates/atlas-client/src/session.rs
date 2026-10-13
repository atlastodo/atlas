//! A signed-in account held in memory (`AtlasClient.connect` in `packages/sdk`): an API-token
//! session, the keys the token carries, the store and its sync.

use std::sync::Arc;

use uuid::Uuid;

use crate::api::{ApiClient, Transport, UreqTransport};
use crate::crypto::{
    derive_api_token_keys, parse_api_token, unwrap_api_token_keys, unwrap_signing_key, Keyring,
};
use crate::discovery::{describe_incompatibility, server_incompatibility, ServerRequirements};
use crate::error::{Error, Result};
use crate::project_keys::{hydrate_project_keys, HydrateOptions};
use crate::scope::{is_project_creator, revive_locked_values};
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
        }
    }
}

/// The oldest sync protocol this client works with and what it needs from the server.
pub const REQUIRED_PROTOCOL: i64 = 6;

pub struct Session {
    pub api: ApiClient,
    pub store: Store,
    pub sync: SyncClient,
    pub keyring: Keyring,
    pub user_id: String,
}

impl Session {
    pub fn connect(opts: ConnectOptions) -> Result<Self> {
        let parts = Arc::new(parse_api_token(&opts.token)?);
        let auth = derive_api_token_keys(&parts).auth;
        let transport = opts
            .transport
            .unwrap_or_else(|| Box::new(UreqTransport::default()));
        let mut api = ApiClient::new(&opts.server_url, transport);
        if opts.check_discovery {
            let discovery = api.get_discovery()?;
            let required = ServerRequirements {
                min_protocol: Some(REQUIRED_PROTOCOL),
                capabilities: &["api_tokens"],
                apps: &["todo"],
            };
            // A legacy server (no discovery) still gets its chance: an old one fails the token
            // exchange with its own error.
            if !discovery.legacy {
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

        let (dek, private_key) = unwrap_api_token_keys(
            &parts,
            &session.user_id,
            &session.wrapped_dek,
            &session.wrapped_private_key,
        )?;
        let mut keyring = Keyring::new(dek, private_key, session.public_key.clone());
        if let (Some(wrapped), Some(public)) =
            (&session.encrypted_signing_key, &session.signing_public_key)
        {
            // Only needed to rotate or deliver project keys, which this client never does.
            if let Ok(secret) = unwrap_signing_key(wrapped, &dek, public) {
                keyring.set_signing_key(secret);
            }
        }
        // The token id is this client's device: its HLC node and its session's device id.
        let node = Uuid::parse_str(&parts.id).map_err(|_| Error::Protocol("token id".into()))?;
        let store = match opts.store {
            Some(make) => make(node),
            None => Store::new(node),
        };
        let mut s = Session {
            api,
            store,
            sync: SyncClient::new(0),
            keyring,
            user_id: session.user_id,
        };
        s.initial_sync()?;
        Ok(s)
    }

    /// Pull everything, then load the shared projects' keys under the synced trust state.
    fn initial_sync(&mut self) -> Result<()> {
        self.sync_now()?;
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
