//! `GET /sync/pull`: a partition's op log after a cursor, in pages the socket backfill reuses.

use atlas_core::{Change, Hlc, Operation};
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use sqlx::PgConnection;
use uuid::Uuid;

use super::{entity_from_str, PullResponse, SyncError, SyncResult};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    #[serde(default)]
    pub since: i64,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    500
}

#[derive(sqlx::FromRow)]
struct OpRow {
    server_seq: i64,
    op_id: Uuid,
    entity: String,
    entity_id: Uuid,
    field: Option<String>,
    value: Option<serde_json::Value>,
    is_delete: bool,
    hlc_wall_ms: i64,
    hlc_counter: i32,
    hlc_node: Uuid,
}

impl OpRow {
    fn into_operation(self) -> AppResult<Operation> {
        let change = if self.is_delete {
            Change::Delete
        } else {
            Change::Set {
                field: self.field.ok_or(AppError::Internal)?,
                value: self.value.unwrap_or(serde_json::Value::Null),
            }
        };
        Ok(Operation {
            id: self.op_id,
            entity: entity_from_str(&self.entity)?,
            entity_id: self.entity_id,
            change,
            ts: Hlc {
                wall_ms: self.hlc_wall_ms as u64,
                counter: self.hlc_counter as u32,
                node: self.hlc_node,
            },
        })
    }
}

pub(super) async fn partition_head(conn: &mut PgConnection, user: Uuid) -> AppResult<i64> {
    Ok(
        sqlx::query_scalar(
            "SELECT COALESCE(MAX(server_seq), 0) FROM operations WHERE user_id = $1",
        )
        .bind(user)
        .fetch_one(conn)
        .await?,
    )
}

/// Fetch a user's ops after `since` (ordered, bounded), for `/sync/pull` and WS backfill.
///
/// Answers [`SyncError::CursorExpired`] when retention purged ops above a non-zero `since`; the
/// watermark is read after the ops so any purge that thinned the page is visible.
pub(super) async fn ops_page(
    pool: &sqlx::PgPool,
    user: Uuid,
    since: i64,
    limit: i64,
) -> SyncResult<PullResponse> {
    let limit = limit.clamp(1, MAX_PULL_LIMIT);
    let rows = sqlx::query_as::<_, OpRow>(
        "SELECT server_seq, op_id, entity, entity_id, field, value, is_delete,
                hlc_wall_ms, hlc_counter, hlc_node
         FROM operations
         WHERE user_id = $1 AND server_seq > $2
         ORDER BY server_seq
         LIMIT $3",
    )
    .bind(user)
    .bind(since)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    if since > 0 {
        let watermark: Option<i64> =
            sqlx::query_scalar("SELECT purged_seq FROM sync_purge_watermarks WHERE user_id = $1")
                .bind(user)
                .fetch_optional(pool)
                .await?;
        if watermark.is_some_and(|w| since < w) {
            return Err(SyncError::CursorExpired);
        }
    }

    let cursor = rows.last().map(|r| r.server_seq).unwrap_or(since);
    let operations = rows
        .into_iter()
        .map(OpRow::into_operation)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(PullResponse {
        operations,
        cursor,
        from: since,
    })
}

pub(super) const MAX_PULL_LIMIT: i64 = 1000;

/// `GET /sync/pull?since=<cursor>&limit=<n>`: ops committed after the cursor, in order.
pub(super) async fn pull(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<PullQuery>,
) -> SyncResult<Json<PullResponse>> {
    Ok(Json(
        ops_page(&state.pool, user.user_id, q.since, q.limit).await?,
    ))
}
