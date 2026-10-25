//! `GET /sync/legacy/keys` and `POST /sync/legacy/drop`: a client lists the rows written before
//! protocol 7 that its partition still holds, re-encodes them and drops the originals, with their
//! plaintext kind, field names and routing fields (`docs/decisions/0006-opaque-sync-metadata.md`).
//!
//! The drop is a hard delete from the caller's own partition: op log, field state and tombstone
//! of each named legacy entity. Nothing is relayed; the caller's devices hold the re-encoded copy,
//! which carries every field with its original stamp, so a device that never saw the legacy rows
//! loses nothing. Another member's copy of a shared project is theirs to drop.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::begin_sync_write;
use crate::apps::{RequestedApps, SessionApps};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use atlas_core::{Registry, WireKind};

/// Cap on entities in one drop, like a push batch.
const MAX_DROP: usize = 5000;

#[derive(Debug, Deserialize)]
pub struct LegacyKey {
    pub entity: String,
    pub entity_id: Uuid,
}

#[derive(Debug, Deserialize)]
pub struct DropRequest {
    pub entities: Vec<LegacyKey>,
}

#[derive(Debug, Serialize)]
pub struct DropResponse {
    /// How many of the named entities the partition still held rows of.
    pub dropped: usize,
}

pub(super) async fn drop(
    State(state): State<AppState>,
    user: AuthUser,
    requested: RequestedApps,
    Json(req): Json<DropRequest>,
) -> AppResult<Json<DropResponse>> {
    if req.entities.len() > MAX_DROP {
        return Err(AppError::BadRequest("too many entities in one drop".into()));
    }
    let apps = SessionApps::for_request(&state, &user, requested).await?;
    let (mut entities, mut ids) = (Vec::new(), Vec::new());
    for key in &req.entities {
        match WireKind::from_wire(&key.entity) {
            Some(WireKind::Legacy(_)) => {}
            _ => {
                return Err(AppError::BadRequest(format!(
                    "{} is not a protocol 6 kind",
                    key.entity
                )))
            }
        }
        if !apps.allows_kind(&key.entity) {
            return Err(AppError::Forbidden(format!(
                "{} is outside this session's apps",
                key.entity
            )));
        }
        entities.push(key.entity.as_str());
        ids.push(key.entity_id);
    }
    if entities.is_empty() {
        return Ok(Json(DropResponse { dropped: 0 }));
    }

    // Under the sync-write lock, like retention's purge: a pull reads the op log in seq order.
    let mut tx = begin_sync_write(&state.pool).await?;
    let dropped: i64 = sqlx::query_scalar(
        "WITH k AS (SELECT * FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)),
              ops AS (
                  DELETE FROM operations o USING k
                   WHERE o.user_id = $1 AND o.entity = k.entity AND o.entity_id = k.entity_id
                  RETURNING o.entity, o.entity_id),
              fields AS (
                  DELETE FROM entity_fields f USING k
                   WHERE f.user_id = $1 AND f.entity = k.entity AND f.entity_id = k.entity_id
                  RETURNING f.entity, f.entity_id),
              tombs AS (
                  DELETE FROM entity_tombstones t USING k
                   WHERE t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id
                  RETURNING t.entity, t.entity_id)
         SELECT count(*) FROM (
             SELECT entity, entity_id FROM ops
             UNION SELECT entity, entity_id FROM fields
             UNION SELECT entity, entity_id FROM tombs) gone",
    )
    .bind(user.user_id)
    .bind(&entities)
    .bind(&ids)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(DropResponse {
        dropped: dropped as usize,
    }))
}

/// Legacy keys per page of `GET /sync/legacy/keys`.
const MAX_KEYS_PER_PAGE: i64 = 500;

fn default_keys_limit() -> i64 {
    MAX_KEYS_PER_PAGE
}

#[derive(Debug, Deserialize)]
pub struct KeysQuery {
    /// The previous page's `next`, sent back verbatim.
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default = "default_keys_limit")]
    pub limit: i64,
}

#[derive(Debug, Serialize)]
pub struct LegacyKeyView {
    pub entity: String,
    pub entity_id: Uuid,
    /// The partition already holds a current copy at least as complete and as new: the key can be
    /// dropped without re-encoding it.
    pub covered: bool,
}

#[derive(Debug, Serialize)]
pub struct KeysResponse {
    pub entities: Vec<LegacyKeyView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// `GET /sync/legacy/keys?next=<token>&limit=<n>`: the legacy entities the caller's partition still
/// holds, of the session's apps, so a client knows what is left to re-encode and drop. Ordered by
/// key; `next` resumes after the page's last one.
///
/// `covered` is a heuristic for a key another device or member already re-encoded: current rows
/// of the same entity id that are at least as many as its legacy field rows and as new (wall clock),
/// or, for a legacy tombstone without fields, a current tombstone at least as new. A re-encoded
/// copy keeps every field and its stamp, so it passes; a client that sees `covered` drops the key.
pub(super) async fn keys(
    State(state): State<AppState>,
    user: AuthUser,
    requested: RequestedApps,
    Query(q): Query<KeysQuery>,
) -> AppResult<Json<KeysResponse>> {
    let apps = SessionApps::for_request(&state, &user, requested).await?;
    let registry = Registry::bundled();
    let (mut legacy, mut current) = (Vec::new(), Vec::new());
    for kind in apps.kinds() {
        match WireKind::from_wire(&kind) {
            Some(WireKind::Legacy(_)) => legacy.push(kind),
            Some(WireKind::ProjectMember) | None => {}
            Some(_) if registry.wire_kind(&kind).is_some() => current.push(kind),
            Some(_) => {}
        }
    }
    let limit = q.limit.clamp(1, MAX_KEYS_PER_PAGE);
    let (after_entity, after_id) = match &q.next {
        None => (String::new(), Uuid::nil()),
        Some(token) => {
            let bad = || AppError::BadRequest("malformed legacy keys token".into());
            let (entity, id) = token.split_once('/').ok_or_else(bad)?;
            (entity.to_owned(), Uuid::parse_str(id).map_err(|_| bad())?)
        }
    };
    let rows: Vec<(String, Uuid, bool)> = sqlx::query_as(
        "WITH page AS (
             SELECT entity, entity_id FROM entity_fields
              WHERE user_id = $1 AND entity = ANY($2) AND (entity, entity_id) > ($4, $5)
             UNION
             SELECT entity, entity_id FROM entity_tombstones
              WHERE user_id = $1 AND entity = ANY($2) AND (entity, entity_id) > ($4, $5)
             ORDER BY entity, entity_id
             LIMIT $6
         )
         SELECT p.entity, p.entity_id,
                COALESCE(CASE WHEN l.n > 0 THEN c.n >= l.n AND c.wall >= l.wall
                ELSE EXISTS (
                     SELECT 1 FROM entity_tombstones ct, entity_tombstones lt
                      WHERE ct.user_id = $1 AND ct.entity = ANY($3) AND ct.entity_id = p.entity_id
                        AND lt.user_id = $1 AND lt.entity = p.entity AND lt.entity_id = p.entity_id
                        AND ct.hlc_wall_ms >= lt.hlc_wall_ms)
                END, FALSE) AS covered
           FROM page p
           CROSS JOIN LATERAL (
                SELECT count(*) AS n, max(hlc_wall_ms) AS wall
                  FROM entity_fields
                 WHERE user_id = $1 AND entity = p.entity AND entity_id = p.entity_id) l
           CROSS JOIN LATERAL (
                SELECT count(*) AS n, max(hlc_wall_ms) AS wall
                  FROM entity_fields
                 WHERE user_id = $1 AND entity = ANY($3) AND entity_id = p.entity_id) c
          ORDER BY p.entity, p.entity_id",
    )
    .bind(user.user_id)
    .bind(&legacy)
    .bind(&current)
    .bind(&after_entity)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(&state.pool)
    .await?;
    let more = rows.len() as i64 > limit;
    let entities: Vec<LegacyKeyView> = rows
        .into_iter()
        .take(limit as usize)
        .map(|(entity, entity_id, covered)| LegacyKeyView {
            entity,
            entity_id,
            covered,
        })
        .collect();
    let next = more
        .then(|| {
            entities
                .last()
                .map(|k| format!("{}/{}", k.entity, k.entity_id))
        })
        .flatten();
    Ok(Json(KeysResponse { entities, next }))
}
