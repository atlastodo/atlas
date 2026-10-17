//! Bug and crash reports: the public filing endpoint plus the admin read surface.
//!
//! `POST /reports` takes a diagnostics-only payload (the client allowlists and redacts it) and
//! needs no session, since startup and login crashes have no token. As the only unauthenticated
//! write in the API it is rate-limited per IP in [`crate::app`], length-capped, and keeps only
//! the newest [`MAX_STORED_REPORTS`].

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::admin::AdminUser;
use crate::audit;
use crate::auth::OptionalAuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/reports", post(create_report))
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/admin/reports",
            get(list_reports).delete(delete_all_reports),
        )
        .route(
            "/admin/reports/{id}",
            get(get_report).patch(set_resolved).delete(delete_report),
        )
}

// Field caps; the client truncates to the same limits (`@atlastodo/shared/bugReport`). Over-long
// fields are truncated, not rejected, since a report that 400s is never seen. Only
// structurally broken payloads are refused.
const MAX_MESSAGE_LEN: usize = 2_000;
const MAX_STACK_LEN: usize = 16 * 1024;
const MAX_DESCRIPTION_LEN: usize = 4_000;
const MAX_SHORT_FIELD_LEN: usize = 200;
const MAX_BREADCRUMBS: usize = 50;
/// Breadcrumb codes are short identifiers (`nav`, `sync_error`, ...).
const MAX_BREADCRUMB_CODE_LEN: usize = 64;
/// Reports kept; older ones are deleted as new ones arrive, bounding the anonymous endpoint.
pub const MAX_STORED_REPORTS: i64 = 1000;
const MAX_DIAGNOSTICS_BYTES: usize = 16 * 1024;
const DEFAULT_LIST_LIMIT: i64 = 50;

/// Truncate to at most `max` bytes without splitting a UTF-8 code point (`String::truncate`
/// would panic off a char boundary and 500 the crash reporter).
fn truncate_utf8(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s
}

fn truncate_opt(value: Option<String>, max: usize) -> Option<String> {
    value.map(|v| truncate_utf8(v, max))
}

/// Reduce breadcrumbs to `{at, code, ref}`, keeping the newest [`MAX_BREADCRUMBS`] well-formed
/// ones with strings capped. Anything else is dropped so one odd entry cannot break the
/// admin detail view.
fn sanitize_breadcrumbs(raw: Vec<Value>) -> Vec<Value> {
    let crumbs: Vec<Value> = raw
        .into_iter()
        .filter_map(|crumb| {
            let Value::Object(mut crumb) = crumb else {
                return None;
            };
            let at = crumb.remove("at").filter(Value::is_number)?;
            let Some(Value::String(code)) = crumb.remove("code") else {
                return None;
            };
            let reference = match crumb.remove("ref") {
                Some(Value::String(r)) => Value::String(truncate_utf8(r, MAX_SHORT_FIELD_LEN)),
                _ => Value::Null,
            };
            Some(serde_json::json!({
                "at": at,
                "code": truncate_utf8(code, MAX_BREADCRUMB_CODE_LEN),
                "ref": reference,
            }))
        })
        .collect();
    let skip = crumbs.len().saturating_sub(MAX_BREADCRUMBS);
    crumbs.into_iter().skip(skip).collect()
}

#[derive(Debug, Deserialize)]
pub struct CreateReportRequest {
    /// Client-generated UUIDv7; the insert is idempotent on it, so offline retries add no rows.
    pub id: Uuid,
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub app_version: String,
    pub platform: String,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub diagnostics: Value,
    #[serde(default)]
    pub breadcrumbs: Vec<Value>,
    /// When the error happened (Unix ms), distinct from `created_at`: reports may be queued offline.
    pub occurred_at: i64,
}

/// A row in the admin list, without the bulky stack/diagnostics blobs.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReportSummaryView {
    pub id: Uuid,
    pub user_id: Option<Uuid>,
    pub user_email: Option<String>,
    pub kind: String,
    pub message: String,
    pub app_version: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub route: Option<String>,
    pub occurred_at_ms: i64,
    pub created_at_ms: i64,
    pub resolved_at_ms: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ReportView {
    pub id: Uuid,
    pub user_id: Option<Uuid>,
    pub user_email: Option<String>,
    pub kind: String,
    pub message: String,
    pub stack: Option<String>,
    pub description: Option<String>,
    pub app_version: String,
    pub platform: String,
    pub os_version: Option<String>,
    pub route: Option<String>,
    pub device_id: Option<String>,
    pub diagnostics: Value,
    pub breadcrumbs: Value,
    pub occurred_at_ms: i64,
    pub created_at_ms: i64,
    pub resolved_at_ms: Option<i64>,
}

// Timestamps go out as Unix milliseconds like every other wire timestamp.
const SUMMARY_COLUMNS: &str = "r.id, r.user_id, u.email AS user_email, r.kind, r.message, \
     r.app_version, r.platform, r.os_version, r.route, \
     (EXTRACT(EPOCH FROM r.occurred_at) * 1000)::BIGINT AS occurred_at_ms, \
     (EXTRACT(EPOCH FROM r.created_at) * 1000)::BIGINT AS created_at_ms, \
     (EXTRACT(EPOCH FROM r.resolved_at) * 1000)::BIGINT AS resolved_at_ms";

const FULL_COLUMNS: &str = "r.id, r.user_id, u.email AS user_email, r.kind, r.message, r.stack, \
     r.description, r.app_version, r.platform, r.os_version, r.route, r.device_id, r.diagnostics, \
     r.breadcrumbs, \
     (EXTRACT(EPOCH FROM r.occurred_at) * 1000)::BIGINT AS occurred_at_ms, \
     (EXTRACT(EPOCH FROM r.created_at) * 1000)::BIGINT AS created_at_ms, \
     (EXTRACT(EPOCH FROM r.resolved_at) * 1000)::BIGINT AS resolved_at_ms";

/// Reject only what is structurally broken; length is handled by truncation.
fn validate(req: &CreateReportRequest) -> AppResult<()> {
    if req.kind != "crash" && req.kind != "manual" {
        return Err(AppError::BadRequest("unknown report kind".into()));
    }
    if req.message.trim().is_empty() {
        return Err(AppError::BadRequest("message is required".into()));
    }
    if req.app_version.trim().is_empty() || req.platform.trim().is_empty() {
        return Err(AppError::BadRequest(
            "app_version and platform are required".into(),
        ));
    }
    // Truncating JSON would only produce an unparseable column.
    if serde_json::to_string(&req.diagnostics)
        .map(|s| s.len())
        .unwrap_or(0)
        > MAX_DIAGNOSTICS_BYTES
    {
        return Err(AppError::BadRequest("diagnostics is too large".into()));
    }
    Ok(())
}

/// `POST /reports`: file a crash or manual bug report. Anonymous when no valid token is presented.
async fn create_report(
    State(state): State<AppState>,
    OptionalAuthUser(user_id): OptionalAuthUser,
    Json(req): Json<CreateReportRequest>,
) -> AppResult<StatusCode> {
    validate(&req)?;

    let message = truncate_utf8(req.message, MAX_MESSAGE_LEN);
    let stack = truncate_opt(req.stack, MAX_STACK_LEN);
    let description = truncate_opt(req.description, MAX_DESCRIPTION_LEN);
    let app_version = truncate_utf8(req.app_version, MAX_SHORT_FIELD_LEN);
    let platform = truncate_utf8(req.platform, MAX_SHORT_FIELD_LEN);
    let os_version = truncate_opt(req.os_version, MAX_SHORT_FIELD_LEN);
    let route = truncate_opt(req.route, MAX_SHORT_FIELD_LEN);
    let device_id = truncate_opt(req.device_id, MAX_SHORT_FIELD_LEN);
    let breadcrumbs = sanitize_breadcrumbs(req.breadcrumbs);

    // An omitted field arrives as `Value::Null`; the column is a JSON object, so normalize.
    let diagnostics = if req.diagnostics.is_null() {
        Value::Object(Default::default())
    } else {
        req.diagnostics
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO bug_reports
            (id, user_id, kind, message, stack, description, app_version, platform, os_version,
             route, device_id, diagnostics, breadcrumbs, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14 / 1000.0))
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(req.id)
    .bind(user_id)
    .bind(&req.kind)
    .bind(&message)
    .bind(&stack)
    .bind(&description)
    .bind(&app_version)
    .bind(&platform)
    .bind(&os_version)
    .bind(&route)
    .bind(&device_id)
    .bind(diagnostics)
    .bind(Value::Array(breadcrumbs))
    .bind(req.occurred_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM bug_reports WHERE id IN (
            SELECT id FROM bug_reports ORDER BY created_at DESC, id DESC OFFSET $1)",
    )
    .bind(MAX_STORED_REPORTS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // Also a log line so `docker logs` shows reports arrive. Not the message: an anonymous caller
    // writes it, and it belongs in the admin panel.
    tracing::info!(
        report_id = %req.id,
        kind = %req.kind,
        user_id = ?user_id,
        app_version = %app_version,
        platform = %platform,
        "bug report filed"
    );

    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    before_ms: Option<i64>,
}

/// `GET /admin/reports`: newest-first, optionally filtered by resolved state, keyset-paginated.
async fn list_reports(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<ReportSummaryView>>> {
    // Nullable binds rather than assembled SQL: one query string, nothing interpolated.
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS}
           FROM bug_reports r
           LEFT JOIN users u ON u.id = r.user_id
          WHERE ($1::BOOLEAN IS NULL OR (r.resolved_at IS NOT NULL) = $1)
            AND ($2::BIGINT IS NULL OR r.created_at < to_timestamp($2 / 1000.0))
          ORDER BY r.created_at DESC
          LIMIT $3"
    );
    let rows = sqlx::query_as::<_, ReportSummaryView>(sqlx::AssertSqlSafe(sql))
        .bind(q.resolved)
        .bind(q.before_ms)
        .bind(q.limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, 100))
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows))
}

async fn get_report(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ReportView>> {
    let sql = format!(
        "SELECT {FULL_COLUMNS}
           FROM bug_reports r
           LEFT JOIN users u ON u.id = r.user_id
          WHERE r.id = $1"
    );
    let row = sqlx::query_as::<_, ReportView>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(row))
}

#[derive(Debug, Deserialize)]
struct ResolveRequest {
    resolved: bool,
}

async fn set_resolved(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(req): Json<ResolveRequest>,
) -> AppResult<Json<ReportView>> {
    let mut tx = state.pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE bug_reports
            SET resolved_at = CASE WHEN $2 THEN now() ELSE NULL END,
                resolved_by = CASE WHEN $2 THEN $3 ELSE NULL END
          WHERE id = $1",
    )
    .bind(id)
    .bind(req.resolved)
    .bind(admin.user_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(
        &mut *tx,
        admin.user_id,
        if req.resolved {
            "report.resolve"
        } else {
            "report.reopen"
        },
        None,
        serde_json::json!({ "report_id": id }),
    )
    .await?;
    tx.commit().await?;
    get_report(State(state), admin, Path(id)).await
}

async fn delete_report(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let deleted = sqlx::query("DELETE FROM bug_reports WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(
        &mut *tx,
        admin.user_id,
        "report.delete",
        None,
        serde_json::json!({ "report_id": id }),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct DeleteAllQuery {
    /// The list filter the admin is looking at: `false` open only, `true` resolved only, absent
    /// everything, so "clear" deletes what the confirmation counted.
    #[serde(default)]
    resolved: Option<bool>,
}

/// `DELETE /admin/reports[?resolved=...]`: permanently delete every report matching the filter.
async fn delete_all_reports(
    State(state): State<AppState>,
    admin: AdminUser,
    Query(q): Query<DeleteAllQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.pool.begin().await?;
    let deleted = sqlx::query(
        "DELETE FROM bug_reports WHERE ($1::BOOLEAN IS NULL OR (resolved_at IS NOT NULL) = $1)",
    )
    .bind(q.resolved)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    audit::record(
        &mut *tx,
        admin.user_id,
        "report.delete_all",
        None,
        serde_json::json!({ "deleted": deleted, "resolved": q.resolved }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_utf8_never_splits_a_code_point() {
        // A multi-byte message landing on the cap is ordinary input.
        let s = "æøå".repeat(10); // 2 bytes per char
        let out = truncate_utf8(s, 5);
        assert!(out.len() <= 5);
        assert_eq!(out, "æø", "walks back to the nearest char boundary");
    }

    #[test]
    fn truncate_utf8_leaves_short_values_alone() {
        assert_eq!(truncate_utf8("hello".into(), 200), "hello");
        assert_eq!(truncate_opt(None, 10), None);
    }
}
