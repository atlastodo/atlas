//! E2EE project-key distribution: the key-material exchange sharing needs and sync cannot carry.
//!
//! `project_keys` is an append-only history per `(project, user, key_id)`. A `wrapped` row is the
//! user's own copy; a `sealed` row is an owner's signed delivery sealed to the user's X25519 key.
//! A shared project has one canonical key ([`CANONICAL_KEYS`]); when a key holder leaves, a
//! rotation is requested ([`request_rotations`]) and an owner completes it. Details are in
//! `docs/architecture.md`.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::members::{self, MemberState, Role};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/keys", put(put_project_key))
        .route(
            "/projects/{id}/member-keys/{member_id}",
            put(put_member_project_key),
        )
        .route("/projects/{id}/key-rotation", post(complete_rotation))
        .route("/project-keys", get(list_project_keys))
        .route("/project-keys/missing", get(list_missing_keys))
        .route("/project-keys/rotations", get(list_rotations))
}

/// SQL yielding `(project_id, key_id)`: the canonical key of every shared project that has one.
///
/// After a rotation it is the key the rotation chose (`project_key_state`). Before, it is a
/// fingerprinted `wrapped` copy of the earliest active owner, preferring one another member also
/// holds. Both orderings are fixed once established so the key never flips and forks the project.
/// Without a fingerprinted key from the earliest owner there is no canonical key.
pub(crate) const CANONICAL_KEYS: &str = "
    SELECT s.project_id, s.canonical_key_id AS key_id
      FROM project_key_state s
     WHERE s.canonical_key_id IS NOT NULL
    UNION ALL
    (SELECT DISTINCT ON (o.project_id) o.project_id, pk.key_id
      FROM (SELECT DISTINCT ON (project_id) project_id, user_id
              FROM project_members
             WHERE role = 'owner' AND state = 'active'
             ORDER BY project_id, created_at, user_id) o
      JOIN project_keys pk
        ON pk.project_id = o.project_id AND pk.user_id = o.user_id
       AND pk.kind = 'wrapped' AND pk.key_id <> ''
     WHERE NOT EXISTS (SELECT 1 FROM project_key_state s
                        WHERE s.project_id = o.project_id AND s.canonical_key_id IS NOT NULL)
     ORDER BY o.project_id,
              NOT EXISTS (SELECT 1 FROM project_keys other
                           WHERE other.project_id = pk.project_id AND other.key_id = pk.key_id
                             AND other.kind = 'wrapped' AND other.user_id <> pk.user_id),
              pk.created_at, pk.key_id)";

#[derive(Debug, Deserialize)]
pub struct ProjectKeyPayload {
    pub encrypted_pek: Value,
    /// Defaulted so a missing fingerprint answers 400 from [`validate_key_id`], not 422.
    #[serde(default)]
    pub key_id: String,
    /// The owner's signature over a delivery; ignored on the caller's own copy.
    #[serde(default)]
    pub signature: Option<String>,
}

fn validate_key_id(key_id: &str) -> AppResult<()> {
    if key_id.len() == 32
        && key_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "key_id must be 32 lowercase hex characters".into(),
        ))
    }
}

/// An Ed25519 signature: 64 bytes as 128 lowercase hex characters. Only the shape is checked;
/// recipients verify it.
fn validate_signature(signature: Option<&str>) -> AppResult<&str> {
    match signature {
        Some(sig)
            if sig.len() == 128 && sig.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(sig)
        }
        _ => Err(AppError::BadRequest(
            "a key delivery needs a signature of 128 lowercase hex characters".into(),
        )),
    }
}

/// `PUT /projects/:id/keys`: store the caller's own `wrapped` copy of a PEK.
///
/// Allowed for anyone with a membership row and for the creator of a not-yet-shared project
/// (read from the operation log, see [`members::is_project_creator`]). Anyone else gets 404.
async fn put_project_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
    Json(req): Json<ProjectKeyPayload>,
) -> AppResult<StatusCode> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    validate_key_id(&req.key_id)?;
    let pool = &state.pool;
    let allowed = members::membership(pool, project_id, user.user_id)
        .await?
        .is_some()
        || (!members::is_shared(pool, project_id).await?
            && members::is_project_creator(pool, project_id, user.user_id).await?);
    if !allowed {
        return Err(AppError::NotFound);
    }
    // A shared project takes a new key only as its first, or one an active owner mints for a
    // pending rotation (`complete_rotation`); otherwise a second would split the members. Storing
    // a copy of an existing key is fine.
    if members::is_shared(pool, project_id).await? {
        let (has_keys, known, rotating): (bool, bool, bool) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM project_keys WHERE project_id = $1),
                    EXISTS (SELECT 1 FROM project_keys
                             WHERE project_id = $1
                               AND (key_id = $2 OR (user_id = $3 AND key_id = ''))),
                    EXISTS (SELECT 1 FROM project_key_state s
                              JOIN project_members m
                                ON m.project_id = s.project_id AND m.user_id = $3
                               AND m.role = 'owner' AND m.state = 'active'
                             WHERE s.project_id = $1
                               AND s.rotation_requested > s.rotation_done)",
        )
        .bind(project_id)
        .bind(&req.key_id)
        .bind(user.user_id)
        .fetch_one(pool)
        .await?;
        if has_keys && !known && !rotating {
            return Err(AppError::Conflict(
                "this shared project already has a key".into(),
            ));
        }
    }
    // The caller's own copy supersedes an owner's delivery of the same key and needs no signature.
    sqlx::query(
        "INSERT INTO project_keys (project_id, user_id, key_id, kind, encrypted_pek, updated_at)
         VALUES ($1, $2, $3, 'wrapped', $4, now())
         ON CONFLICT (project_id, user_id, key_id) DO UPDATE
            SET kind = 'wrapped', encrypted_pek = EXCLUDED.encrypted_pek,
                signature = NULL, signed_by = NULL, updated_at = now()",
    )
    .bind(project_id)
    .bind(user.user_id)
    .bind(&req.key_id)
    .bind(&req.encrypted_pek)
    .execute(pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /projects/:id/member-keys/:member_id`: an active owner delivers a PEK, sealed to the
/// member's public key and signed with the owner's identity key, to another member. The caller
/// is recorded as the signer.
///
/// 400 without a well-formed signature; 404 when either has no membership row; 403 when the
/// caller is not an active owner or targets themselves. A delivery never overwrites the
/// member's own `wrapped` copy of the same key.
async fn put_member_project_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path((project_id, member_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<ProjectKeyPayload>,
) -> AppResult<StatusCode> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    validate_key_id(&req.key_id)?;
    let signature = validate_signature(req.signature.as_deref())?;
    let pool = &state.pool;
    match members::membership(pool, project_id, user.user_id).await? {
        None => return Err(AppError::NotFound),
        Some((Role::Owner, MemberState::Active)) => {}
        Some(_) => {
            return Err(AppError::Forbidden(
                "only an active owner can deliver project keys".into(),
            ))
        }
    }
    if member_id == user.user_id {
        return Err(AppError::Forbidden(
            "store your own key with PUT /projects/:id/keys".into(),
        ));
    }
    if members::membership(pool, project_id, member_id)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound);
    }
    sqlx::query(
        "INSERT INTO project_keys
                (project_id, user_id, key_id, kind, encrypted_pek, signature, signed_by, updated_at)
         VALUES ($1, $2, $3, 'sealed', $4, $5, $6, now())
         ON CONFLICT (project_id, user_id, key_id) DO UPDATE
            SET encrypted_pek = EXCLUDED.encrypted_pek, signature = EXCLUDED.signature,
                signed_by = EXCLUDED.signed_by, updated_at = now()
          WHERE project_keys.kind = 'sealed'",
    )
    .bind(project_id)
    .bind(member_id)
    .bind(&req.key_id)
    .bind(&req.encrypted_pek)
    .bind(signature)
    .bind(user.user_id)
    .execute(pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ProjectKeyRow {
    pub project_id: Uuid,
    pub key_id: String,
    pub kind: String,
    pub encrypted_pek: Value,
    /// A delivery's signature and signer (null on own copies), with the signer's current keys.
    pub signature: Option<String>,
    pub signed_by: Option<Uuid>,
    pub signer_public_key: Option<String>,
    pub signer_signing_key: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProjectKeysResponse {
    pub keys: Vec<ProjectKeyRow>,
    /// `project_id -> key_id` of the canonical key, for projects the caller is a member of.
    pub canonical: BTreeMap<Uuid, String>,
    /// `project_id -> key ids` a rotation superseded: readable, no longer for writing.
    pub retired: BTreeMap<Uuid, Vec<String>>,
}

/// `GET /project-keys`: the caller's key history plus the canonical key per project.
async fn list_project_keys(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ProjectKeysResponse>> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    let keys = sqlx::query_as::<_, ProjectKeyRow>(
        "SELECT pk.project_id, pk.key_id, pk.kind, pk.encrypted_pek, pk.signature, pk.signed_by,
                s.public_key AS signer_public_key, s.signing_public_key AS signer_signing_key
           FROM project_keys pk LEFT JOIN users s ON s.id = pk.signed_by
          WHERE pk.user_id = $1
          ORDER BY pk.project_id, pk.created_at, pk.key_id",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let canonical: Vec<(Uuid, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.project_id, c.key_id FROM ({CANONICAL_KEYS}) c
          WHERE c.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1)"
    )))
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let retired_rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT r.project_id, r.key_id FROM project_retired_keys r
          WHERE r.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1)
          ORDER BY r.project_id, r.retired_at, r.key_id",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut retired: BTreeMap<Uuid, Vec<String>> = BTreeMap::new();
    for (project_id, key_id) in retired_rows {
        retired.entry(project_id).or_default().push(key_id);
    }
    Ok(Json(ProjectKeysResponse {
        keys,
        canonical: canonical.into_iter().collect(),
        retired,
    }))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MissingKey {
    pub project_id: Uuid,
    pub user_id: Uuid,
    pub public_key: Option<String>,
    pub key_id: String,
}

/// `GET /project-keys/missing`: for each project the caller actively owns, every other member
/// without their own `wrapped` copy of the canonical key (or a retired key the caller holds),
/// with the public key to seal it to. A `sealed` row does not count: its `key_id` is only what
/// the sender claimed, and garbage there would hide the member from redelivery.
async fn list_missing_keys(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<MissingKey>>> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    let rows = sqlx::query_as::<_, MissingKey>(sqlx::AssertSqlSafe(format!(
        "WITH wanted AS (
             SELECT c.project_id, c.key_id, 0 AS rank FROM ({CANONICAL_KEYS}) c
             UNION ALL
             SELECT r.project_id, r.key_id, 1 AS rank FROM project_retired_keys r
              WHERE EXISTS (SELECT 1 FROM project_keys mine
                             WHERE mine.project_id = r.project_id AND mine.user_id = $1
                               AND mine.key_id = r.key_id AND mine.kind = 'wrapped')
         )
         SELECT pm.project_id, pm.user_id, u.public_key, w.key_id
           FROM project_members me
           JOIN wanted w ON w.project_id = me.project_id
           JOIN project_members pm
             ON pm.project_id = me.project_id AND pm.user_id <> me.user_id
           JOIN users u ON u.id = pm.user_id
          WHERE me.user_id = $1 AND me.role = 'owner' AND me.state = 'active'
            AND NOT EXISTS (
                SELECT 1 FROM project_keys pk
                 WHERE pk.project_id = pm.project_id AND pk.user_id = pm.user_id
                   AND pk.key_id = w.key_id AND pk.kind = 'wrapped')
          ORDER BY pm.project_id, pm.created_at, pm.user_id, w.rank, w.key_id"
    )))
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PendingRotation {
    pub project_id: Uuid,
    pub request: i64,
}

/// `GET /project-keys/rotations`: projects the caller owns whose key must be rotated.
async fn list_rotations(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<PendingRotation>>> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    let rows = sqlx::query_as::<_, PendingRotation>(
        "SELECT s.project_id, s.rotation_requested AS request
           FROM project_key_state s
           JOIN project_members me ON me.project_id = s.project_id
          WHERE me.user_id = $1 AND me.role = 'owner' AND me.state = 'active'
            AND s.rotation_requested > s.rotation_done
          ORDER BY s.project_id",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct CompleteRotation {
    #[serde(default)]
    pub key_id: String,
    pub request: i64,
}

/// `POST /projects/:id/key-rotation`: an active owner completes a pending rotation with the key
/// it minted; it becomes canonical and every other key is retired.
///
/// The caller must have stored its own `wrapped` copy first. 409 `rotation_not_pending` when
/// `request` is not outstanding (another owner completed it first, or it was never asked for).
async fn complete_rotation(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
    Json(req): Json<CompleteRotation>,
) -> AppResult<StatusCode> {
    user.require_app(crate::auth::root_key::TODO_APP)?;
    validate_key_id(&req.key_id)?;
    let pool = &state.pool;
    match members::membership(pool, project_id, user.user_id).await? {
        None => return Err(AppError::NotFound),
        Some((Role::Owner, MemberState::Active)) => {}
        Some(_) => {
            return Err(AppError::Forbidden(
                "only an active owner can rotate the project key".into(),
            ))
        }
    }
    let mut tx = pool.begin().await?;
    let counters: Option<(i64, i64)> = sqlx::query_as(
        "SELECT rotation_requested, rotation_done FROM project_key_state
          WHERE project_id = $1 FOR UPDATE",
    )
    .bind(project_id)
    .fetch_optional(&mut *tx)
    .await?;
    match counters {
        Some((requested, done)) if req.request > done && req.request <= requested => {}
        _ => return Err(AppError::RotationNotPending),
    }
    let (held, retired): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM project_keys
                         WHERE project_id = $1 AND user_id = $2 AND key_id = $3 AND kind = 'wrapped'),
                EXISTS (SELECT 1 FROM project_retired_keys WHERE project_id = $1 AND key_id = $3)",
    )
    .bind(project_id)
    .bind(user.user_id)
    .bind(&req.key_id)
    .fetch_one(&mut *tx)
    .await?;
    if !held {
        return Err(AppError::BadRequest(
            "store your own copy of the new key before completing the rotation".into(),
        ));
    }
    if retired {
        return Err(AppError::BadRequest(
            "a retired key cannot become canonical again".into(),
        ));
    }
    sqlx::query(
        "UPDATE project_key_state
            SET canonical_key_id = $2, rotation_done = $3, rotated_by = $4, rotated_at = now(),
                updated_at = now()
          WHERE project_id = $1",
    )
    .bind(project_id)
    .bind(&req.key_id)
    .bind(req.request)
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO project_retired_keys (project_id, key_id)
         SELECT DISTINCT project_id, key_id FROM project_keys
          WHERE project_id = $1 AND key_id <> '' AND key_id <> $2
         ON CONFLICT DO NOTHING",
    )
    .bind(project_id)
    .bind(&req.key_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // Tells members the project writes under another key now. Best effort: they reload on start.
    if let Err(e) = members::announce_key_change(&state, project_id).await {
        tracing::warn!(error = ?e, %project_id, "could not announce a key rotation");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Ask for a rotation of each key-holding project that one of `users` is leaving (`project_id`,
/// or every project they belong to). Called in the same transaction, before their rows go.
pub(crate) async fn request_rotations<'e, E>(
    executor: E,
    project_id: Option<Uuid>,
    users: &[Uuid],
) -> AppResult<()>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query(
        "INSERT INTO project_key_state (project_id, rotation_requested)
         SELECT DISTINCT pm.project_id, 1::BIGINT FROM project_members pm
          WHERE pm.user_id = ANY($1)
            AND ($2::UUID IS NULL OR pm.project_id = $2)
            AND EXISTS (SELECT 1 FROM project_keys k WHERE k.project_id = pm.project_id)
            AND (pm.state = 'active'
                 OR EXISTS (SELECT 1 FROM project_keys mine
                             WHERE mine.project_id = pm.project_id AND mine.user_id = pm.user_id))
         ON CONFLICT (project_id) DO UPDATE
            SET rotation_requested = project_key_state.rotation_requested + 1, updated_at = now()",
    )
    .bind(users)
    .bind(project_id)
    .execute(executor)
    .await?;
    Ok(())
}

/// Drop every key `user_id` holds for `project_id`, when they leave it or decline the invite.
pub(crate) async fn delete_member_keys<'e, E>(
    executor: E,
    project_id: Uuid,
    user_id: Uuid,
) -> AppResult<()>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query("DELETE FROM project_keys WHERE project_id = $1 AND user_id = $2")
        .bind(project_id)
        .bind(user_id)
        .execute(executor)
        .await?;
    Ok(())
}
