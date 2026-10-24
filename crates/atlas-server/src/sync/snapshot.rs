//! `GET /sync/snapshot`: a partition's materialized state as ops, for a fresh device, plus the
//! unpaged reads behind the account export and the accept backfill.

use std::collections::HashMap;

use atlas_core::{Change, Hlc, WireOperation};
use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use super::entity_from_str;
use super::pull::partition_head;
use crate::apps::{RequestedApps, SessionApps};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Entity keys per snapshot page (each expands to its fields plus at most one tombstone op).
const MAX_SNAPSHOT_KEYS_PER_PAGE: i64 = 1000;

fn default_snapshot_limit() -> i64 {
    100
}

#[derive(Debug, Deserialize)]
pub struct SnapshotQuery {
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default = "default_snapshot_limit")]
    pub limit: i64,
}

#[derive(Debug, Serialize)]
pub struct SnapshotResponse {
    pub operations: Vec<WireOperation>,
    /// Cursor to pass as `since` on the pull after the last page: the partition's max
    /// `server_seq` when the first page was served. Ops committed during the walk are
    /// re-delivered by that pull (idempotent), not skipped.
    pub cursor: i64,
    /// Opaque token for the next page; absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

struct SnapshotResume {
    entity: String,
    id: Uuid,
    cursor: i64,
}

impl SnapshotResume {
    fn token(entity: &str, id: Uuid, cursor: i64) -> String {
        format!("{entity}/{id}/{cursor}")
    }

    /// A token that does not parse answers 400; the client restarts from page one.
    fn parse(q: &SnapshotQuery) -> AppResult<Option<Self>> {
        let Some(token) = &q.next else {
            return Ok(None);
        };
        let bad = || AppError::BadRequest("malformed snapshot token".into());
        let (entity, rest) = token.split_once('/').ok_or_else(bad)?;
        let (id, cursor) = rest.split_once('/').ok_or_else(bad)?;
        let id = Uuid::parse_str(id).map_err(|_| bad())?;
        let cursor = cursor
            .parse::<i64>()
            .ok()
            .filter(|c| *c >= 0)
            .ok_or_else(bad)?;
        Ok(Some(Self {
            entity: entity.to_string(),
            id,
            cursor,
        }))
    }
}

/// `GET /sync/snapshot?next=<token>&limit=<keys>`: the caller's current materialized state plus
/// the cursor to resume from, so a fresh device folds one bounded snapshot instead of replaying
/// the op log. Same wire shape as pull; pagination is keyset-based and `limit` bounds entity keys
/// per page, clamped to [`MAX_SNAPSHOT_KEYS_PER_PAGE`].
pub(super) async fn snapshot(
    State(state): State<AppState>,
    user: AuthUser,
    requested: RequestedApps,
    Query(q): Query<SnapshotQuery>,
) -> AppResult<Json<SnapshotResponse>> {
    let caller = user.user_id;
    let apps = SessionApps::for_request(&state, &user, requested).await?;
    let limit = q.limit.clamp(1, MAX_SNAPSHOT_KEYS_PER_PAGE);
    let resume = SnapshotResume::parse(&q)?;

    // The walk's cursor, read on the first page before anything is materialized. Safe because
    // every seq up to this max is committed (SYNC_WRITE_LOCK).
    let cursor = match &resume {
        Some(r) => r.cursor,
        None => partition_head(&mut *state.pool.acquire().await?, caller).await?,
    };
    let (after_entity, after_id) = resume
        .as_ref()
        .map(|r| (r.entity.as_str(), r.id))
        .unwrap_or(("", Uuid::nil()));

    // One key past the page, to know whether a next page exists. Only the session's enabled
    // apps' kinds are read.
    let mut keys: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT entity, entity_id FROM entity_fields
          WHERE user_id = $1 AND (entity, entity_id) > ($2, $3) AND entity = ANY($5)
         UNION
         SELECT entity, entity_id FROM entity_tombstones
          WHERE user_id = $1 AND (entity, entity_id) > ($2, $3) AND entity = ANY($5)
         ORDER BY entity, entity_id
         LIMIT $4",
    )
    .bind(caller)
    .bind(after_entity)
    .bind(after_id)
    .bind(limit + 1)
    .bind(apps.kinds())
    .fetch_all(&state.pool)
    .await?;
    let more = keys.len() as i64 > limit;
    keys.truncate(limit as usize);

    // The token names the last key of the page, not the peeked one, so nothing between pages is
    // skipped.
    let next = if more {
        keys.last()
            .map(|(entity, id)| SnapshotResume::token(entity, *id, cursor))
    } else {
        None
    };
    let operations = keys_ops(&mut *state.pool.acquire().await?, caller, &keys).await?;
    Ok(Json(SnapshotResponse {
        operations,
        cursor,
        next,
    }))
}

/// The user's materialized state of the kinds named `kinds` as snapshot-shaped ops, unpaged, for
/// `GET /auth/export`.
pub(crate) async fn partition_ops(
    pool: &sqlx::PgPool,
    user: Uuid,
    kinds: &[String],
) -> AppResult<Vec<WireOperation>> {
    let keys: Vec<(String, Uuid)> = sqlx::query_as(
        "SELECT entity, entity_id FROM entity_fields
          WHERE user_id = $1 AND entity = ANY($2)
         UNION
         SELECT entity, entity_id FROM entity_tombstones
          WHERE user_id = $1 AND entity = ANY($2)",
    )
    .bind(user)
    .bind(kinds)
    .fetch_all(pool)
    .await?;
    keys_ops(&mut *pool.acquire().await?, user, &keys).await
}

/// Materialize `(entity, entity_id)` keys from `user`'s partition as ops: every stored field
/// Set with its HLC, scope and pusher, plus the tombstone Delete. Folding them with field-level LWW reproduces the
/// server's view. Shared by the accept backfill, `GET /sync/snapshot` and the account export;
/// reads a bounded chunk of keys per query.
pub(super) async fn keys_ops(
    conn: &mut PgConnection,
    user: Uuid,
    keys: &[(String, Uuid)],
) -> AppResult<Vec<WireOperation>> {
    type Key = (String, Uuid);
    type FieldRow = (
        String,
        Uuid,
        String,
        Value,
        i64,
        i32,
        Uuid,
        Option<Uuid>,
        Option<Uuid>,
    );
    let mut ops = Vec::new();
    for chunk in keys.chunks(MAX_SNAPSHOT_KEYS_PER_PAGE as usize) {
        let entities: Vec<&str> = chunk.iter().map(|(e, _)| e.as_str()).collect();
        let ids: Vec<Uuid> = chunk.iter().map(|(_, id)| *id).collect();
        let fields: Vec<FieldRow> = sqlx::query_as(
            "SELECT f.entity, f.entity_id, f.field, f.value,
                    f.hlc_wall_ms, f.hlc_counter, f.hlc_node, f.scope, f.pushed_by
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               JOIN entity_fields f
                 ON f.user_id = $1 AND f.entity = k.entity AND f.entity_id = k.entity_id
              ORDER BY f.entity, f.entity_id, f.field",
        )
        .bind(user)
        .bind(&entities)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
        let tombs: Vec<(String, Uuid, i64, i32, Uuid)> = sqlx::query_as(
            "SELECT t.entity, t.entity_id, t.hlc_wall_ms, t.hlc_counter, t.hlc_node
               FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
               JOIN entity_tombstones t
                 ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id",
        )
        .bind(user)
        .bind(&entities)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;

        let hlc = |wall: i64, counter: i32, node: Uuid| Hlc {
            wall_ms: wall as u64,
            counter: counter as u32,
            node,
        };
        let mut by_key: HashMap<Key, Vec<WireOperation>> = HashMap::new();
        for (entity, entity_id, field, value, wall, counter, node, scope, pushed_by) in fields {
            let op = WireOperation {
                id: Uuid::now_v7(),
                entity: entity_from_str(&entity)?,
                entity_id,
                scope,
                change: Change::Set { field, value },
                ts: hlc(wall, counter, node),
                pushed_by,
            };
            by_key.entry((entity, entity_id)).or_default().push(op);
        }
        for (entity, entity_id, wall, counter, node) in tombs {
            let op = WireOperation::delete(
                entity_from_str(&entity)?,
                entity_id,
                None,
                hlc(wall, counter, node),
            );
            by_key.entry((entity, entity_id)).or_default().push(op);
        }
        for key in chunk {
            if let Some(key_ops) = by_key.remove(key) {
                ops.extend(key_ops);
            }
        }
    }
    Ok(ops)
}
