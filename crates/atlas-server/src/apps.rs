//! The suite's apps on this server: discovery, and which apps an instance and an account have
//! enabled.
//!
//! Each app is a first-party manifest compiled into the build (`manifests/<app>.json`, read by
//! [`atlas_core::Registry`]). An instance offers the bundled apps `ATLAS_APPS` names
//! ([`crate::config::Config::apps`]); an account uses the ones in its `account_apps` rows (todo
//! for every account, added by a trigger when the user row is created). Sync push refuses an op
//! whose kind belongs to an app not enabled for both, and pull, the socket backfill and the
//! snapshot leave such ops out ([`EnabledApps`]).
//!
//! `GET /discovery` is public: it tells a client, before sign-in, which server version and sync
//! protocol it is talking to, what it supports and which apps it offers.

use std::collections::HashSet;

use atlas_core::{Operation, Registry};
use axum::extract::{Path, State};
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
pub const CAPABILITIES: &[&str] = &["api_tokens", "app_manifests", "account_apps", "root_key"];

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
    pub capabilities: &'static [&'static str],
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
        capabilities: CAPABILITIES,
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

/// The apps a user may sync: enabled for the instance and for the account.
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

    /// Whether ops of the kind with this wire name may be synced. A kind no bundled manifest
    /// lists is not.
    pub(crate) fn allows_kind(&self, kind: &str) -> bool {
        Registry::bundled()
            .app_of(kind)
            .is_some_and(|m| self.instance.contains(&m.app) && self.account.contains(&m.app))
    }

    /// Refuse the first op whose app is not enabled, naming the app and where it is off.
    pub(crate) fn check_ops(&self, ops: &[Operation]) -> AppResult<()> {
        for op in ops {
            let app = op.entity.app();
            let scope = if !self.instance.contains(app) {
                "instance"
            } else if !self.account.contains(app) {
                "account"
            } else {
                continue;
            };
            return Err(AppError::AppNotEnabled {
                app: app.to_owned(),
                scope,
            });
        }
        Ok(())
    }
}
