//! Operation-log and refresh-token retention: periodic compaction of append-only tables.
//!
//! Every client bootstraps from `GET /sync/snapshot`, so old rows in `operations`,
//! `entity_fields` and `entity_tombstones` can be purged (`OP_RETENTION_DAYS`, default 30, 0
//! disables). The refresh-token purge (`REFRESH_TOKEN_RETENTION_DAYS`) only removes rows dead for
//! longer than the window, so a live token can never be touched. The task ([`spawn_if_enabled`])
//! deletes in bounded batches. Project creators, which the first share is authorized by, are
//! recorded in `project_creators`, so no op has to be kept for them.

use std::time::Duration;

use sqlx::PgPool;

use crate::error::AppResult;
use crate::state::AppState;

/// How often the enabled purge task runs; the first pass fires at startup.
const PURGE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 6);

/// Rows deleted per pass, per table, so a large backlog drains over several passes.
const PURGE_BATCH: i64 = 10_000;

/// Upper bound on a retention window, keeping the SQL day parameter in range.
const MAX_RETENTION_DAYS: i32 = 36_500;

/// Start the periodic purge task when either retention is configured, else `None`.
pub fn spawn_if_enabled(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    if state.config.op_retention_days <= 0 && state.config.refresh_token_retention_days <= 0 {
        return None;
    }
    let state = state.clone();
    Some(tokio::spawn(async move {
        let op_days = state.config.op_retention_days;
        let token_days = state.config.refresh_token_retention_days;
        tracing::info!(
            op_retention_days = op_days,
            refresh_token_retention_days = token_days,
            "retention task enabled"
        );
        let mut interval = tokio::time::interval(PURGE_INTERVAL);
        loop {
            interval.tick().await;
            if op_days > 0 {
                match purge_once(&state.pool, op_days).await {
                    Ok(stats) if stats.operations > 0 || stats.tombstones > 0 => {
                        tracing::debug!(
                            operations = stats.operations,
                            tombstones = stats.tombstones,
                            "purged expired sync rows"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "operation-log purge failed"),
                }
            }
            if token_days > 0 {
                match purge_tokens_once(&state.pool, token_days).await {
                    Ok(tokens) if tokens > 0 => {
                        tracing::debug!(tokens, "purged expired refresh tokens");
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "refresh-token purge failed"),
                }
            }
        }
    }))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PurgeStats {
    pub operations: u64,
    pub tombstones: u64,
}

/// Delete one bounded batch of expired rows; a no-op when `days <= 0`.
///
/// A stale tombstone takes the fields it hides with it (HLC not newer than the delete) and is
/// itself removed only when no field of the key is newer; a newer field means the entity was
/// restored and must survive. A restored legacy (protocol 6) entity keeps its hidden scope links
/// (`project_id`, `task_id`): clients pick the key its fields open with from them, so purging one
/// would lock the surviving encrypted fields. Protocol 7 fields carry their scope on the row, and
/// a purged entity's `entity_scopes` row goes with it.
/// Age is the server's receipt time, never the client's HLC.
pub async fn purge_once(pool: &PgPool, days: i64) -> AppResult<PurgeStats> {
    if days <= 0 {
        return Ok(PurgeStats::default());
    }

    // Old operations. The same statement raises each user's purge watermark, so an older pull
    // cursor gets `cursor_expired`.
    let ops: i64 = sqlx::query_scalar(
        "WITH gone AS (
             DELETE FROM operations
              WHERE server_seq IN (
                  SELECT server_seq FROM operations
                   WHERE created_at < now() - make_interval(days => $1)
                   ORDER BY server_seq
                   LIMIT $2
              )
             RETURNING user_id, server_seq
         ),
         marks AS (
             INSERT INTO sync_purge_watermarks (user_id, purged_seq)
             SELECT user_id, MAX(server_seq) FROM gone GROUP BY user_id
             ON CONFLICT (user_id) DO UPDATE
                SET purged_seq = GREATEST(sync_purge_watermarks.purged_seq, EXCLUDED.purged_seq)
         )
         SELECT count(*) FROM gone",
    )
    .bind(days.clamp(1, i64::from(MAX_RETENTION_DAYS)) as i32)
    .bind(PURGE_BATCH)
    .fetch_one(pool)
    .await?;

    // `stale` is materialized once so both deletes act on the same keys, and only picks
    // tombstones with work left (a kept scope link is none) so kept ones cannot starve the batch. It runs under the
    // sync-write lock: a push landing mid-statement could resurrect the entity.
    let mut tx = crate::sync::begin_sync_write(pool).await?;
    let tombstones = sqlx::query(
        "WITH stale AS MATERIALIZED (
             SELECT t.user_id, t.entity, t.entity_id,
                    t.hlc_wall_ms, t.hlc_counter, t.hlc_node, NOT k.has_newer AS purgeable
               FROM entity_tombstones t
               CROSS JOIN LATERAL (
                   SELECT COALESCE(bool_or((f.hlc_wall_ms, f.hlc_counter, f.hlc_node)
                                         > (t.hlc_wall_ms, t.hlc_counter, t.hlc_node)), FALSE)
                              AS has_newer,
                          COALESCE(bool_or((f.hlc_wall_ms, f.hlc_counter, f.hlc_node)
                                        <= (t.hlc_wall_ms, t.hlc_counter, t.hlc_node)
                                       AND f.field NOT IN ('project_id', 'task_id')), FALSE)
                              AS has_hidden
                     FROM entity_fields f
                    WHERE f.user_id = t.user_id AND f.entity = t.entity
                      AND f.entity_id = t.entity_id
               ) k
              WHERE t.received_at < now() - make_interval(days => $1)
                AND (NOT k.has_newer OR k.has_hidden)
              ORDER BY t.user_id, t.entity, t.entity_id
              LIMIT $2
         ),
         gone_fields AS (
             DELETE FROM entity_fields f USING stale s
              WHERE f.user_id = s.user_id AND f.entity = s.entity AND f.entity_id = s.entity_id
                AND (f.hlc_wall_ms, f.hlc_counter, f.hlc_node)
                 <= (s.hlc_wall_ms, s.hlc_counter, s.hlc_node)
                AND (s.purgeable OR f.field NOT IN ('project_id', 'task_id'))
         ),
         gone_scopes AS (
             DELETE FROM entity_scopes e USING stale s
              WHERE s.purgeable
                AND e.user_id = s.user_id AND e.entity = s.entity AND e.entity_id = s.entity_id
         )
         DELETE FROM entity_tombstones t USING stale s
          WHERE s.purgeable
            AND t.user_id = s.user_id AND t.entity = s.entity AND t.entity_id = s.entity_id",
    )
    .bind(days.clamp(1, i64::from(MAX_RETENTION_DAYS)) as i32)
    .bind(PURGE_BATCH)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(PurgeStats {
        operations: ops as u64,
        tombstones: tombstones.rows_affected(),
    })
}

/// Delete one bounded batch of refresh-token rows that died more than `days` days ago (past
/// `expires_at`, or `revoked_at` older than the cutoff). A no-op when `days <= 0`. A live token
/// matches neither arm (`revoked_at` is NULL), so this can never sign a working device out.
pub async fn purge_tokens_once(pool: &PgPool, days: i64) -> AppResult<u64> {
    if days <= 0 {
        return Ok(0);
    }
    let res = sqlx::query(
        "DELETE FROM refresh_tokens
          WHERE id IN (
              SELECT id FROM refresh_tokens
               WHERE expires_at < now() - make_interval(days => $1)
                  OR revoked_at < now() - make_interval(days => $1)
               ORDER BY expires_at
               LIMIT $2
          )",
    )
    .bind(days.clamp(1, i64::from(MAX_RETENTION_DAYS)) as i32)
    .bind(PURGE_BATCH)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}
