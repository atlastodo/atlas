//! `POST /sync/legacy/drop`: a client that re-encoded rows written before protocol 7 drops the
//! originals, with their plaintext kind, field names and routing fields
//! (`docs/decisions/0006-opaque-sync-metadata.md`).
//!
//! The drop is a hard delete from the caller's own partition: op log, field state and tombstone
//! of each named legacy entity. Nothing is relayed; the caller's devices hold the re-encoded copy,
//! which carries every field with its original stamp, so a device that never saw the legacy rows
//! loses nothing. Another member's copy of a shared project is theirs to drop.

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::begin_sync_write;
use crate::apps::{RequestedApps, SessionApps};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use atlas_core::WireKind;

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
