//! The suite's apps on this server: discovery, and which apps an instance and an account have
//! enabled.
//!
//! Each app is a first-party manifest compiled into the build (`manifests/<app>.json`, read by
//! [`atlas_core::Registry`]). An instance offers the bundled apps `ATLAS_APPS` names
//! ([`crate::config::Config::apps`]); an account uses the ones in its `account_apps` rows (todo
//! for every account, added by a trigger when the user row is created).
//!
//! Each sync session also names the apps it works with ([`SYNC_APPS_HEADER`], todo when absent):
//! a Journal client syncs journal ops only, a Todo client todo ops only, though both share the
//! account's one partition and cursor space. Push refuses an op outside the session's enabled
//! scope, and pull, the snapshot, the socket (backfill and live) and the export leave such ops out
//! ([`SessionApps`]).
//!
//! `GET /discovery` is public: it tells a client, before sign-in, which server version and sync
//! protocol it is talking to, what it supports and which apps it offers.

use std::collections::HashSet;

use atlas_core::{Operation, Registry};
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::InteractiveAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Features a client may check for in [`Discovery::capabilities`] before relying on them.
/// Append a name when a feature lands; never remove one a released client may check for.
pub const CAPABILITIES: &[&str] = &[
    "api_tokens",
    "app_manifests",
    "account_apps",
    "root_key",
    "app_scoped_sync",
    "app_scoped_api_tokens",
];

/// Advertised next to [`CAPABILITIES`] when the instance has passkeys on (`WEBAUTHN_RP_ID`).
pub const PASSKEYS_CAPABILITY: &str = "passkeys";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/discovery", get(discovery))
        .route("/auth/apps", get(list_account_apps))
        .route("/auth/apps/{app}", put(enable_account_app))
}

#[derive(Debug, Serialize)]
pub struct DiscoveryApp {
    pub id: String,
    pub name: String,
    /// The manifest version this server enforces.
    pub version: u32,
}

#[derive(Debug, Serialize)]
pub struct Discovery {
    pub service: &'static str,
    /// The server's release version.
    pub version: &'static str,
    /// The newest sync protocol the server speaks ([`crate::sync::SYNC_PROTOCOL`]).
    pub protocol_version: u32,
    /// The oldest client protocol `/sync/*` accepts ([`crate::sync::MIN_SYNC_PROTOCOL`]).
    pub min_protocol_version: u32,
    pub capabilities: Vec<&'static str>,
    /// The apps this instance offers.
    pub apps: Vec<DiscoveryApp>,
}

fn instance_apps(state: &AppState) -> impl Iterator<Item = &'static atlas_core::AppManifest> + '_ {
    let registry = Registry::bundled();
    state.config.apps.iter().filter_map(|id| registry.app(id))
}

/// `GET /discovery`: what this server is and offers. Unauthenticated, no database read.
pub async fn discovery(State(state): State<AppState>) -> Json<Discovery> {
    Json(Discovery {
        service: "atlas-server",
        version: env!("CARGO_PKG_VERSION"),
        protocol_version: crate::sync::SYNC_PROTOCOL,
        min_protocol_version: crate::sync::MIN_SYNC_PROTOCOL,
        capabilities: CAPABILITIES
            .iter()
            .copied()
            .chain(
                state
                    .config
                    .passkeys
                    .is_some()
                    .then_some(PASSKEYS_CAPABILITY),
            )
            .collect(),
        apps: instance_apps(&state)
            .map(|m| DiscoveryApp {
                id: m.app.clone(),
                name: m.name.clone(),
                version: m.version,
            })
            .collect(),
    })
}

#[derive(Debug, Serialize)]
pub struct AccountAppView {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub enabled: bool,
    /// Unix millis, when enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AccountAppsResponse {
    pub apps: Vec<AccountAppView>,
}

async fn account_rows(pool: &sqlx::PgPool, user: Uuid) -> AppResult<Vec<(String, OffsetDateTime)>> {
    Ok(
        sqlx::query_as("SELECT app, enabled_at FROM account_apps WHERE user_id = $1")
            .bind(user)
            .fetch_all(pool)
            .await?,
    )
}

/// The instance's apps with the caller's enablement of each.
async fn account_apps(state: &AppState, user: Uuid) -> AppResult<Vec<AccountAppView>> {
    let rows = account_rows(&state.pool, user).await?;
    Ok(instance_apps(state)
        .map(|m| {
            let enabled_at = rows
                .iter()
                .find(|(app, _)| *app == m.app)
                .map(|(_, at)| at.unix_timestamp() * 1000);
            AccountAppView {
                id: m.app.clone(),
                name: m.name.clone(),
                version: m.version,
                enabled: enabled_at.is_some(),
                enabled_at,
            }
        })
        .collect())
}

/// `GET /auth/apps`: the instance's apps and whether the caller's account has each enabled.
/// Interactive sessions only: an API token acts within the apps, it does not choose them.
pub async fn list_account_apps(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
) -> AppResult<Json<AccountAppsResponse>> {
    Ok(Json(AccountAppsResponse {
        apps: account_apps(&state, user.user_id).await?,
    }))
}

/// `PUT /auth/apps/:app`: enable an app the instance offers for the caller's account.
/// Idempotent; answers the app's entry. 404 for an app this build does not bundle, 403
/// `app_not_enabled` for one the instance does not offer.
pub async fn enable_account_app(
    State(state): State<AppState>,
    InteractiveAuthUser(user): InteractiveAuthUser,
    Path(app): Path<String>,
) -> AppResult<Json<AccountAppView>> {
    if Registry::bundled().app(&app).is_none() {
        return Err(AppError::NotFound);
    }
    if !state.config.apps.contains(&app) {
        return Err(AppError::AppNotEnabled {
            app,
            scope: "instance",
        });
    }
    sqlx::query(
        "INSERT INTO account_apps (user_id, app) VALUES ($1, $2)
         ON CONFLICT (user_id, app) DO NOTHING",
    )
    .bind(user.user_id)
    .bind(&app)
    .execute(&state.pool)
    .await?;
    account_apps(&state, user.user_id)
        .await?
        .into_iter()
        .find(|view| view.id == app)
        .map(Json)
        .ok_or(AppError::Internal)
}

/// Header naming the apps a sync session works with, comma-separated (`x-atlas-sync-apps:
/// journal`). Every `/sync/*` request and the account export read it. A request without it is a
/// todo session ([`DEFAULT_SYNC_APPS`]), which every client predating app-scoped sync is.
pub const SYNC_APPS_HEADER: &str = "x-atlas-sync-apps";

/// The scope of a request that names none.
pub const DEFAULT_SYNC_APPS: &[&str] = &["todo"];

/// Parse a [`SYNC_APPS_HEADER`] value: bundled app ids, comma-separated, at least one; sorted and
/// deduplicated. 400 for anything else.
pub fn parse_sync_apps(raw: &str) -> AppResult<Vec<String>> {
    let registry = Registry::bundled();
    let mut apps: Vec<String> = Vec::new();
    for id in raw.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        if registry.app(id).is_none() {
            return Err(AppError::BadRequest(format!(
                "{SYNC_APPS_HEADER} names an app this server does not bundle"
            )));
        }
        if !apps.iter().any(|a| a == id) {
            apps.push(id.to_owned());
        }
    }
    if apps.is_empty() {
        return Err(AppError::BadRequest(format!(
            "{SYNC_APPS_HEADER} must name at least one app"
        )));
    }
    apps.sort();
    Ok(apps)
}

/// The apps a request asked to sync ([`SYNC_APPS_HEADER`]); `None` when it names none.
#[derive(Debug, Clone, Default)]
pub struct RequestedApps(pub Option<Vec<String>>);

impl<S: Send + Sync> FromRequestParts<S> for RequestedApps {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let Some(value) = parts.headers.get(SYNC_APPS_HEADER) else {
            return Ok(Self(None));
        };
        let raw = value
            .to_str()
            .map_err(|_| AppError::BadRequest(format!("{SYNC_APPS_HEADER} must be ASCII")))?;
        Ok(Self(Some(parse_sync_apps(raw)?)))
    }
}

/// The apps enabled for the instance and for one account.
#[derive(Debug, Clone)]
pub(crate) struct EnabledApps {
    instance: HashSet<String>,
    account: HashSet<String>,
}

impl EnabledApps {
    pub(crate) async fn load(state: &AppState, user: Uuid) -> AppResult<Self> {
        let account = account_rows(&state.pool, user)
            .await?
            .into_iter()
            .map(|(app, _)| app)
            .collect();
        Ok(Self {
            instance: state.config.apps.iter().cloned().collect(),
            account,
        })
    }

    fn allows_app(&self, app: &str) -> bool {
        self.instance.contains(app) && self.account.contains(app)
    }

    /// 403 `app_not_enabled` naming where `app` is off.
    fn check_app(&self, app: &str) -> AppResult<()> {
        let scope = if !self.instance.contains(app) {
            "instance"
        } else if !self.account.contains(app) {
            "account"
        } else {
            return Ok(());
        };
        Err(AppError::AppNotEnabled {
            app: app.to_owned(),
            scope,
        })
    }
}

/// What one sync session may read and write: the apps of its scope that the instance and the
/// account have enabled. Pull, the snapshot, the socket (backfill and live) and the export serve
/// only ops of those apps, walking the cursor past the rest; push refuses any other op.
#[derive(Debug, Clone)]
pub(crate) struct SessionApps {
    scope: Vec<String>,
    enabled: EnabledApps,
}

impl SessionApps {
    /// Resolve a session's scope: the `requested` apps, or [`DEFAULT_SYNC_APPS`].
    ///
    /// - An API-token session (`token_apps`) may only name apps its token carries keys for:
    ///   403 `app_not_enabled` with scope `token`, the implicit todo scope included.
    /// - An app named explicitly must be enabled for the instance and the account (403 with
    ///   scope `instance` or `account`): a cursor that walked past its ops unseen would lose them
    ///   for that client. The implicit todo scope keeps hiding a disabled todo silently, as before
    ///   app-scoped sync.
    pub(crate) async fn resolve(
        state: &AppState,
        user: Uuid,
        token_apps: Option<&[String]>,
        requested: Option<Vec<String>>,
    ) -> AppResult<Self> {
        let explicit = requested.is_some();
        let scope =
            requested.unwrap_or_else(|| DEFAULT_SYNC_APPS.iter().map(|a| a.to_string()).collect());
        if let Some(token_apps) = token_apps {
            if let Some(app) = scope.iter().find(|a| !token_apps.contains(a)) {
                return Err(AppError::AppNotEnabled {
                    app: app.clone(),
                    scope: "token",
                });
            }
        }
        let enabled = EnabledApps::load(state, user).await?;
        if explicit {
            for app in &scope {
                enabled.check_app(app)?;
            }
        }
        Ok(Self { scope, enabled })
    }

    /// [`Self::resolve`] for an authenticated request.
    pub(crate) async fn for_request(
        state: &AppState,
        user: &crate::auth::AuthUser,
        requested: RequestedApps,
    ) -> AppResult<Self> {
        Self::resolve(state, user.user_id, user.token_apps.as_deref(), requested.0).await
    }

    /// The apps this session syncs, enabled or not.
    pub(crate) fn scope(&self) -> &[String] {
        &self.scope
    }

    /// The wire names of every kind this session reads, for SQL filters.
    pub(crate) fn kinds(&self) -> Vec<String> {
        Registry::bundled()
            .apps()
            .iter()
            .filter(|m| self.scope.contains(&m.app) && self.enabled.allows_app(&m.app))
            .flat_map(|m| m.kinds.keys().cloned())
            .collect()
    }

    /// Whether ops of the kind with this wire name reach this session. A kind no bundled manifest
    /// lists does not.
    pub(crate) fn allows_kind(&self, kind: &str) -> bool {
        Registry::bundled()
            .app_of(kind)
            .is_some_and(|m| self.scope.contains(&m.app) && self.enabled.allows_app(&m.app))
    }

    /// Refuse the first op this session may not write: 403 `app_not_enabled` with scope
    /// `instance` or `account` for an app switched off there, `session` for an enabled app
    /// outside the session's scope.
    pub(crate) fn check_ops(&self, ops: &[Operation]) -> AppResult<()> {
        for op in ops {
            let app = op.entity.app();
            self.enabled.check_app(app)?;
            if !self.scope.iter().any(|a| a == app) {
                return Err(AppError::AppNotEnabled {
                    app: app.to_owned(),
                    scope: "session",
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_header_names_bundled_apps() {
        assert_eq!(parse_sync_apps("journal").unwrap(), ["journal"]);
        assert_eq!(
            parse_sync_apps(" todo , journal,todo,").unwrap(),
            ["journal", "todo"]
        );
        for bad in ["", " , ", "notes", "todo,Journal", "todo;journal"] {
            assert!(parse_sync_apps(bad).is_err(), "{bad:?}");
        }
    }

    fn session(scope: &[&str], instance: &[&str], account: &[&str]) -> SessionApps {
        let set = |apps: &[&str]| apps.iter().map(|a| a.to_string()).collect();
        SessionApps {
            scope: scope.iter().map(|a| a.to_string()).collect(),
            enabled: EnabledApps {
                instance: set(instance),
                account: set(account),
            },
        }
    }

    #[test]
    fn a_session_sees_and_writes_only_its_enabled_scope() {
        let both = ["todo", "journal"];
        let journal = session(&["journal"], &both, &both);
        assert!(journal.allows_kind("journal.entry"));
        assert!(!journal.allows_kind("task"));
        assert!(!journal.allows_kind("no_such_kind"));
        let mut kinds = journal.kinds();
        kinds.sort();
        assert_eq!(kinds, ["journal.entry", "journal.preference"]);

        let todo = session(&["todo"], &both, &both);
        assert!(todo.allows_kind("task") && todo.allows_kind("preference"));
        assert!(!todo.allows_kind("journal.preference"));

        let off = session(&["journal", "todo"], &both, &["todo"]);
        assert!(off.allows_kind("task"));
        assert!(!off.allows_kind("journal.entry"));
        assert!(off.kinds().iter().all(|k| !k.starts_with("journal.")));
        assert!(session(&["todo"], &[], &["todo"]).kinds().is_empty());
    }
}
