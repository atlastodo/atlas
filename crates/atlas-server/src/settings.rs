//! Instance settings: deployment flags an admin can toggle at runtime instead of editing the env.
//!
//! The database row **overrides** the env default (`SIGNUP_ENABLED`, `ACTIVITY_RETENTION_DAYS`),
//! never replaces its role: with no row -- the state of every pre-existing deploy, and of a fresh
//! one -- the env value stands, and deleting the row reverts to it. That keeps the env file the seed
//! and the panel the day-to-day control, so closing signup stops meaning "ssh in and restart".

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::admin::AdminUser;
use crate::audit;
use crate::auth::AuthUser;
use crate::config::MAX_ACTIVITY_RETENTION_DAYS;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Whether `POST /auth/signup` accepts new accounts.
const SIGNUP_ENABLED_KEY: &str = "signup_enabled";
/// Days after which clients delete their users' activity entries; 0 keeps them.
const ACTIVITY_RETENTION_KEY: &str = "activity_retention_days";

/// Admin routes, mounted under the `/admin` group by [`crate::admin::routes`].
pub fn admin_routes() -> Router<AppState> {
    Router::new().route("/admin/settings", get(get_settings).patch(patch_settings))
}

/// What every signed-in client reads: the instance's policies it must enforce itself.
pub fn routes() -> Router<AppState> {
    Router::new().route("/instance/policy", get(get_policy))
}

async fn stored(state: &AppState, key: &str) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT value FROM instance_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// The **effective** value of the signup gate: the stored override when there is one, the env
/// default otherwise. An unparseable stored value is treated as "no row" rather than an error -- the
/// panel writes only `"true"`/`"false"`, so reaching that state means a hand-edit, and falling back
/// to the env default is safer than locking every signup out of the instance.
pub async fn signup_enabled(state: &AppState) -> AppResult<bool> {
    Ok(match stored(state, SIGNUP_ENABLED_KEY).await?.as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => state.config.signup_enabled,
    })
}

/// The **effective** activity retention in days (0: no limit), resolved like [`signup_enabled`].
pub async fn activity_retention_days(state: &AppState) -> AppResult<i64> {
    Ok(stored(state, ACTIVITY_RETENTION_KEY)
        .await?
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| (0..=MAX_ACTIVITY_RETENTION_DAYS).contains(d))
        .unwrap_or(state.config.activity_retention_days))
}

#[derive(Debug, Serialize)]
pub struct SettingsView {
    /// The effective value -- what a signup attempt right now would see -- so the panel's toggle
    /// always reflects reality even when the env default, not the panel, is in charge.
    pub signup_enabled: bool,
    /// The effective activity retention in days; 0 keeps activity.
    pub activity_retention_days: i64,
}

/// A partial update: each field present is stored as an override, the others are left alone.
#[derive(Debug, Deserialize)]
pub struct PatchSettingsRequest {
    pub signup_enabled: Option<bool>,
    pub activity_retention_days: Option<i64>,
}

/// The instance policies a client enforces (`GET /instance/policy`). Activity is end-to-end
/// encrypted and travels as an anonymous sealed row, so the server cannot delete it by age itself:
/// it publishes the limit and each client deletes its own user's entries past it.
#[derive(Debug, Serialize)]
pub struct PolicyView {
    pub activity_retention_days: i64,
}

/// `GET /admin/settings`
async fn get_settings(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<SettingsView>> {
    Ok(Json(SettingsView {
        signup_enabled: signup_enabled(&state).await?,
        activity_retention_days: activity_retention_days(&state).await?,
    }))
}

/// `GET /instance/policy`
async fn get_policy(State(state): State<AppState>, _user: AuthUser) -> AppResult<Json<PolicyView>> {
    Ok(Json(PolicyView {
        activity_retention_days: activity_retention_days(&state).await?,
    }))
}

/// `PATCH /admin/settings` — upsert the overrides sent and return the effective view.
async fn patch_settings(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(req): Json<PatchSettingsRequest>,
) -> AppResult<Json<SettingsView>> {
    if let Some(days) = req.activity_retention_days {
        if !(0..=MAX_ACTIVITY_RETENTION_DAYS).contains(&days) {
            return Err(AppError::BadRequest(format!(
                "activity_retention_days must be between 0 and {MAX_ACTIVITY_RETENTION_DAYS}"
            )));
        }
    }
    let mut writes: Vec<(&str, String)> = Vec::new();
    let mut details = serde_json::Map::new();
    if let Some(on) = req.signup_enabled {
        writes.push((SIGNUP_ENABLED_KEY, on.to_string()));
        details.insert("signup_enabled".into(), on.into());
    }
    if let Some(days) = req.activity_retention_days {
        writes.push((ACTIVITY_RETENTION_KEY, days.to_string()));
        details.insert("activity_retention_days".into(), days.into());
    }
    // The changes and their audit entry commit together.
    let mut tx = state.pool.begin().await?;
    for (key, value) in &writes {
        sqlx::query(
            "INSERT INTO instance_settings (key, value, updated_by) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3",
        )
        .bind(key)
        .bind(value)
        .bind(admin.user_id)
        .execute(&mut *tx)
        .await?;
    }
    if !writes.is_empty() {
        audit::record(
            &mut *tx,
            admin.user_id,
            "settings.update",
            None,
            serde_json::Value::Object(details),
        )
        .await?;
    }
    tx.commit().await?;
    get_settings(State(state), admin).await
}
