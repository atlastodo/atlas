//! The admin surface: the [`AdminUser`] authorization seam, the `/admin/*` route group, and the
//! operator-side ways to grant the role (startup promotion of `ADMIN_EMAILS`, `promote`/`demote` CLI).
//! Each resource (`reports`, `admin_users`, `invites`, `settings`, `audit`) exposes
//! `admin_routes()`, merged once below.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::Router;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::InteractiveAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::{admin_users, audit, invites, reports, settings};

/// Every route under `/admin`; mounted here so adding a resource is one merge call.
pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(reports::admin_routes())
        .merge(admin_users::admin_routes())
        .merge(invites::admin_routes())
        .merge(settings::admin_routes())
        .merge(audit::admin_routes())
}

/// Extractor that authenticates a request and requires `users.is_admin`.
///
/// Re-reads the column on every request: the token carries only `sub`, so the client's flag is a
/// UI hint. A non-admin gets 403 (not 404 as in `members.rs::ensure_can_manage`), so the app can
/// tell "not an admin" from "server predates the feature".
pub struct AdminUser {
    pub user_id: Uuid,
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let InteractiveAuthUser(user) =
            InteractiveAuthUser::from_request_parts(parts, state).await?;
        let is_admin: Option<bool> = sqlx::query_scalar("SELECT is_admin FROM users WHERE id = $1")
            .bind(user.user_id)
            .fetch_optional(&state.pool)
            .await?;
        match is_admin {
            Some(true) => Ok(AdminUser {
                user_id: user.user_id,
            }),
            _ => Err(AppError::Forbidden("admin access required".into())),
        }
    }
}

/// Apply `ADMIN_EMAILS` at startup: promote the listed addresses that already have an account,
/// auditing each, and return how many were promoted.
///
/// Never demotes and never acts at signup: the list must not reserve an address for whoever
/// registers it first, nor undo panel changes for admins it does not name. A listed admin
/// demoted in the panel is promoted again at next start (`managed_by_env`). The first admin is
/// bootstrapped with `atlas-server promote <email>` ([`set_admin_by_email`]). Takes a slice so
/// tests need not mutate process-global env.
pub async fn sync_admins(pool: &PgPool, emails: &[String]) -> AppResult<u64> {
    if emails.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await?;
    // `email` is CITEXT, so the array is cast to match.
    let promoted: Vec<(Uuid, String)> = sqlx::query_as(
        "UPDATE users SET is_admin = TRUE, updated_at = now()
          WHERE email = ANY($1::citext[]) AND is_admin = FALSE
      RETURNING id, email::TEXT",
    )
    .bind(emails)
    .fetch_all(&mut *tx)
    .await?;
    for (id, email) in &promoted {
        audit::record_system(
            &mut *tx,
            "user.promote",
            Some(*id),
            serde_json::json!({ "is_admin": true, "source": "env", "target_email": email }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(promoted.len() as u64)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminChange {
    Changed,
    Unchanged,
    NotFound,
}

/// Promote or demote the account with `email`, audited with no actor and `source`. The
/// operator's tool: it needs only database access, so it makes the first admin and recovers an
/// instance whose admins are locked out, which is why it skips the panel's last-admin guard.
pub async fn set_admin_by_email(
    pool: &PgPool,
    email: &str,
    is_admin: bool,
    source: &str,
) -> AppResult<AdminChange> {
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "SELECT id, email::TEXT, is_admin FROM users WHERE email = $1::citext FOR UPDATE",
    )
    .bind(email.trim())
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, email, current)) = row else {
        return Ok(AdminChange::NotFound);
    };
    if current == is_admin {
        return Ok(AdminChange::Unchanged);
    }
    sqlx::query("UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(is_admin)
        .execute(&mut *tx)
        .await?;
    audit::record_system(
        &mut *tx,
        if is_admin {
            "user.promote"
        } else {
            "user.demote"
        },
        Some(id),
        serde_json::json!({ "is_admin": is_admin, "source": source, "target_email": email }),
    )
    .await?;
    tx.commit().await?;
    Ok(AdminChange::Changed)
}
