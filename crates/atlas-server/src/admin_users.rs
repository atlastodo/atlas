//! Admin user management: the account list and lifecycle actions on it.
//!
//! Actions: promote/demote, disable/re-enable (a reversible ban; E2EE means nobody can reset a
//! password, so "disable + re-invite" is the recovery story), force-sign-out, and the same
//! 30-day scheduled deletion a user could run. Guardrails: an admin cannot disable, force-logout
//! or delete their own account, and no action may leave no active admin
//! ([`lock_admins_and_guard`]). Every action commits with its audit entry, which names the
//! target's email so it stays readable after a purge.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin::AdminUser;
use crate::audit;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_LIST_LIMIT: i64 = 50;

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/admin/users", get(list_users))
        .route(
            "/admin/users/{id}",
            axum::routing::patch(update_user).delete(delete_user),
        )
        .route("/admin/users/{id}/logout", post(force_logout))
}

/// A row in the admin user list. Its own view rather than the auth module's `UserRow`, which
/// selects `password_hash`: the admin surface must never be one column from leaking it.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AdminUserView {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub deletion_scheduled: bool,
    /// Days until the scheduled deletion is purged; `None` when none is scheduled.
    #[sqlx(skip)]
    pub deletion_days_remaining: Option<i64>,
    #[serde(skip)]
    pub deletion_scheduled_at: Option<time::OffsetDateTime>,
    pub created_at_ms: i64,
    pub last_login_at_ms: Option<i64>,
    /// Listed in `ADMIN_EMAILS`: startup promotes it again, so a panel demotion lasts until restart.
    #[sqlx(skip)]
    pub managed_by_env: bool,
}

impl AdminUserView {
    fn with_derived(mut self, state: &AppState) -> Self {
        let email = self.email.to_lowercase();
        self.managed_by_env = state.config.admin_emails.contains(&email);
        self.deletion_days_remaining = self
            .deletion_scheduled_at
            .map(crate::auth::account_purge::days_remaining);
        self
    }
}

/// Wire columns for [`AdminUserView`]: boolean flags, timestamps as Unix ms.
const USER_SUMMARY: &str = "u.id, u.email, u.display_name, u.is_admin, \
     (u.disabled_at IS NOT NULL) AS disabled, \
     (u.deletion_scheduled_at IS NOT NULL) AS deletion_scheduled, u.deletion_scheduled_at, \
     (EXTRACT(EPOCH FROM u.created_at) * 1000)::BIGINT AS created_at_ms, \
     (EXTRACT(EPOCH FROM u.last_login_at) * 1000)::BIGINT AS last_login_at_ms";

/// Lock every admin row and the target's, and return the target's (email, is_admin). With
/// `removes_admin`, refuse when the change would leave no active admin (neither disabled nor
/// scheduled for deletion).
///
/// All admin rows are locked, in id order, so two concurrent actions cannot each count the other
/// admin as still there and lose the last one, and guards queue instead of deadlocking.
async fn lock_admins_and_guard(
    tx: &mut sqlx::PgConnection,
    target: Uuid,
    removes_admin: impl FnOnce(bool) -> bool,
) -> AppResult<(String, bool)> {
    sqlx::query("SELECT id FROM users WHERE is_admin OR id = $1 ORDER BY id FOR UPDATE")
        .bind(target)
        .execute(&mut *tx)
        .await?;
    let (email, is_admin): (String, bool) =
        sqlx::query_as("SELECT email::TEXT, is_admin FROM users WHERE id = $1")
            .bind(target)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound)?;
    if removes_admin(is_admin) {
        let others: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM users
              WHERE is_admin AND id <> $1 AND disabled_at IS NULL AND deletion_scheduled_at IS NULL",
        )
        .bind(target)
        .fetch_one(&mut *tx)
        .await?;
        if others == 0 {
            return Err(AppError::BadRequest(
                "the last active admin cannot be demoted, disabled or deleted".into(),
            ));
        }
    }
    Ok((email, is_admin))
}

async fn fetch_user_view(state: &AppState, id: Uuid) -> AppResult<Option<AdminUserView>> {
    let sql = format!("SELECT {USER_SUMMARY} FROM users u WHERE u.id = $1");
    Ok(sqlx::query_as::<_, AdminUserView>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .map(|view| view.with_derived(state)))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    /// Substring match against email or display name (ILIKE); `%`/`_` are wildcards.
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    /// Keyset cursor: users with an id strictly below this one. Ids are UUIDv7, so below means
    /// created earlier, and unique, so the cursor never ties.
    #[serde(default)]
    before_id: Option<Uuid>,
}

/// `GET /admin/users`: newest-first, searchable, keyset-paginated.
async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<AdminUserView>>> {
    // Nullable binds rather than assembled SQL (the `list_reports` precedent).
    let pattern = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let sql = format!(
        "SELECT {USER_SUMMARY}
           FROM users u
          WHERE ($1::TEXT IS NULL OR u.email ILIKE $1 OR u.display_name ILIKE $1)
            AND ($2::UUID IS NULL OR u.id < $2)
          ORDER BY u.id DESC
          LIMIT $3"
    );
    let rows = sqlx::query_as::<_, AdminUserView>(sqlx::AssertSqlSafe(sql))
        .bind(pattern)
        .bind(q.before_id)
        .bind(q.limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, 100))
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(
        rows.into_iter().map(|r| r.with_derived(&state)).collect(),
    ))
}

#[derive(Debug, Deserialize)]
struct PatchUserRequest {
    #[serde(default)]
    is_admin: Option<bool>,
    #[serde(default)]
    disabled: Option<bool>,
}

/// `PATCH /admin/users/:id`: promote/demote and/or disable/enable, atomically.
///
/// Disabling your own account is refused; demoting yourself is allowed. A demotion or disable
/// that would leave no active admin is refused whoever the target is.
async fn update_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(req): Json<PatchUserRequest>,
) -> AppResult<Json<AdminUserView>> {
    if req.is_admin.is_none() && req.disabled.is_none() {
        return Err(AppError::BadRequest("nothing to update".into()));
    }
    if id == admin.user_id && req.disabled == Some(true) {
        return Err(AppError::BadRequest(
            "an admin cannot disable their own account".into(),
        ));
    }

    let mut tx = state.pool.begin().await?;
    let (target_email, _) = lock_admins_and_guard(&mut tx, id, |is_admin| {
        is_admin && (req.is_admin == Some(false) || req.disabled == Some(true))
    })
    .await?;

    if let Some(next) = req.is_admin {
        sqlx::query("UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(next)
            .execute(&mut *tx)
            .await?;
        audit::record(
            &mut *tx,
            admin.user_id,
            if next { "user.promote" } else { "user.demote" },
            Some(id),
            serde_json::json!({ "is_admin": next, "target_email": target_email }),
        )
        .await?;
    }

    if let Some(next) = req.disabled {
        sqlx::query(
            "UPDATE users
                SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END,
                    updated_at = now()
              WHERE id = $1",
        )
        .bind(id)
        .bind(next)
        .execute(&mut *tx)
        .await?;
        // Disabling revokes the refresh tokens; a live access token dies at its next request
        // (the `AuthUser` extractor re-checks the column).
        if next {
            sqlx::query(
                "UPDATE refresh_tokens SET revoked_at = now()
                  WHERE user_id = $1 AND revoked_at IS NULL",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        audit::record(
            &mut *tx,
            admin.user_id,
            if next { "user.disable" } else { "user.enable" },
            Some(id),
            serde_json::json!({ "disabled": next, "target_email": target_email }),
        )
        .await?;
    }

    tx.commit().await?;
    if req.disabled == Some(true) {
        state.hub.close_user_sockets(id);
    }
    fetch_user_view(&state, id)
        .await?
        .ok_or(AppError::NotFound)
        .map(Json)
}

/// `POST /admin/users/:id/logout`: revoke every refresh token the user holds. Not for the
/// caller's own account, which would sign the admin out mid-action.
async fn force_logout(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if id == admin.user_id {
        return Err(AppError::BadRequest(
            "an admin cannot force-logout their own account".into(),
        ));
    }
    let mut tx = state.pool.begin().await?;
    // Distinguish "no tokens to revoke" (204) from "no such user" (404).
    let email: String = sqlx::query_scalar("SELECT email::TEXT FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        admin.user_id,
        "user.force_logout",
        Some(id),
        serde_json::json!({ "target_email": email }),
    )
    .await?;
    tx.commit().await?;
    state.hub.close_user_sockets(id);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /admin/users/:id`: trigger the 30-day scheduled deletion on the user's behalf
/// (sessions revoked, members notified). Reversible within the window. Answers with the updated
/// account, so the panel shows the days left without reloading the list.
async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<AdminUserView>> {
    if id == admin.user_id {
        return Err(AppError::BadRequest(
            "an admin cannot delete their own account from the panel".into(),
        ));
    }
    let mut tx = state.pool.begin().await?;
    // An admin awaiting deletion no longer counts as one, so the guard applies here too.
    let (email, _) = lock_admins_and_guard(&mut tx, id, |is_admin| is_admin).await?;
    // An already-scheduled user is fine (the original date stands).
    sqlx::query(
        "UPDATE users SET deletion_scheduled_at = now() WHERE id = $1 AND deletion_scheduled_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        admin.user_id,
        "user.delete",
        Some(id),
        serde_json::json!({ "target_email": email }),
    )
    .await?;
    tx.commit().await?;
    state.hub.close_user_sockets(id);

    // After the commit: a failed broadcast must not undo a deletion that took effect.
    if let Err(e) = crate::members::broadcast_members_for_user_projects(&state, id).await {
        tracing::warn!(error = ?e, user_id = %id, "could not broadcast a membership change");
    }
    fetch_user_view(&state, id)
        .await?
        .ok_or(AppError::NotFound)
        .map(Json)
}
