//! Revocation: tombstones for whatever of a shared project a former member's partition still
//! shows, so leaving or being removed takes the project off their devices.

use std::sync::PoisonError;

use atlas_core::{Hlc, Operation};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use super::apply::{apply_to_members, publish_batches};
use super::{
    begin_sync_write, cap_future_skew, entity_from_str, physical_now_ms, server_ts, successor_hlc,
    EntityKey,
};
use crate::error::AppResult;
use crate::state::AppState;

/// The entity keys that make up `project_id` in `owner`'s partition, in backfill order: the
/// project, sections, tasks, their comments/activity/attachments, and membership rows (with
/// tombstones, so a returning member drops collaborators who left).
pub(super) async fn project_keys(
    conn: &mut PgConnection,
    owner: Uuid,
    project_id: Uuid,
) -> AppResult<Vec<EntityKey>> {
    let pid_json = Value::String(project_id.to_string());

    let task_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'task' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;
    let section_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'section' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;
    let member_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM entity_fields
         WHERE user_id = $1 AND entity = 'project_member' AND field = 'project_id' AND value = $2",
    )
    .bind(owner)
    .bind(&pid_json)
    .fetch_all(&mut *conn)
    .await?;

    let task_id_strs: Vec<String> = task_ids.iter().map(|u| u.to_string()).collect();
    let child_ids: Vec<EntityKey> = if task_id_strs.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT entity, entity_id FROM entity_fields
             WHERE user_id = $1 AND entity IN ('comment', 'activity', 'attachment') AND field = 'task_id'
               AND (value #>> '{}') = ANY($2)",
        )
        .bind(owner)
        .bind(&task_id_strs)
        .fetch_all(&mut *conn)
        .await?
    };

    let mut keys: Vec<EntityKey> = vec![("project".to_string(), project_id)];
    keys.extend(
        section_ids
            .into_iter()
            .map(|id| ("section".to_string(), id)),
    );
    keys.extend(task_ids.into_iter().map(|id| ("task".to_string(), id)));
    keys.extend(child_ids);
    keys.extend(
        member_ids
            .into_iter()
            .map(|id| ("project_member".to_string(), id)),
    );
    Ok(keys)
}

/// Tombstones for whatever of `project_id` `user`'s partition still shows, for a member who
/// left or was removed. Each beats the newest field and tombstone of its entity; an entity
/// already hidden gets none. Runs inside a [`begin_sync_write`] transaction.
pub(crate) async fn revoke_project_ops(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    user: Uuid,
    project_id: Uuid,
) -> AppResult<Vec<Operation>> {
    let keys = project_keys(tx, user, project_id).await?;
    let entities: Vec<&str> = keys.iter().map(|(e, _)| e.as_str()).collect();
    let ids: Vec<Uuid> = keys.iter().map(|(_, id)| *id).collect();
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        Uuid,
        Option<i64>,
        Option<i32>,
        Option<Uuid>,
        Option<i64>,
        Option<i32>,
        Option<Uuid>,
    )> = sqlx::query_as(
        "SELECT k.entity, k.entity_id, f.hlc_wall_ms, f.hlc_counter, f.hlc_node,
                    t.hlc_wall_ms, t.hlc_counter, t.hlc_node
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               LEFT JOIN LATERAL (
                    SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
                     WHERE user_id = $1 AND entity = k.entity AND entity_id = k.entity_id
                     ORDER BY hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC LIMIT 1
               ) f ON true
               LEFT JOIN entity_tombstones t
                 ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id",
    )
    .bind(user)
    .bind(&entities)
    .bind(&ids)
    .fetch_all(&mut **tx)
    .await?;
    let hlc = |wall: Option<i64>, counter: Option<i32>, node: Option<Uuid>| {
        Some(Hlc {
            wall_ms: wall? as u64,
            counter: counter? as u32,
            node: node?,
        })
    };
    let mut ops = Vec::new();
    for (entity, entity_id, fw, fc, fnode, tw, tc, tnode) in rows {
        let field = hlc(fw, fc, fnode);
        let tomb = hlc(tw, tc, tnode);
        if tomb.is_some() && tomb >= field {
            continue;
        }
        let ts = match field.max(tomb) {
            Some(floor) => {
                let now = physical_now_ms();
                state
                    .clock
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .update(cap_future_skew(floor, now), now)
                    .max(successor_hlc(floor))
            }
            None => server_ts(state),
        };
        ops.push(Operation::delete(entity_from_str(&entity)?, entity_id, ts));
    }
    Ok(ops)
}

pub(crate) async fn revoke_project(
    state: &AppState,
    user: Uuid,
    project_id: Uuid,
) -> AppResult<usize> {
    let mut tx = begin_sync_write(&state.pool).await?;
    let ops = revoke_project_ops(&mut tx, state, user, project_id).await?;
    if ops.is_empty() {
        return Ok(0);
    }
    let batches = apply_to_members(&mut tx, &[user], &ops).await?;
    tx.commit().await?;
    publish_batches(state, batches);
    Ok(ops.len())
}

/// Once per start, revoke shared projects that earlier leavers' partitions still show. A
/// candidate has a project tombstone, is still shared, and has no membership for `user`.
/// Idempotent; returns how many candidates still needed tombstones, so a fully revoked one
/// does not count again on every start.
pub async fn revoke_left_projects(state: &AppState) -> AppResult<usize> {
    let candidates: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT t.user_id, t.entity_id FROM entity_tombstones t
          WHERE t.entity = 'project'
            AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = t.entity_id)
            AND NOT EXISTS (SELECT 1 FROM project_members m
                             WHERE m.project_id = t.entity_id AND m.user_id = t.user_id)",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut revoked = 0;
    for (user, project_id) in &candidates {
        if revoke_project(state, *user, *project_id).await? > 0 {
            revoked += 1;
        }
    }
    Ok(revoked)
}
