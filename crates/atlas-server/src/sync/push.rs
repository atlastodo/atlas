//! `POST /sync/push`: a client's batch validated, authorized against project membership,
//! folded into the caller's partition and fanned out to co-members.
//!
//! Since protocol 7 (`docs/decisions/0006-opaque-sync-metadata.md`) an op tells the server only
//! its wire kind, the scope (project) whose key encrypted it and an opaque field tag. Routing,
//! the role check and moves read the scope; the server reads no field value but a few public
//! plaintext names ([`SERVER_READ_FIELDS`]).

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::PoisonError;
use std::time::{SystemTime, UNIX_EPOCH};

use atlas_core::hlc::MAX_COUNTER;
use atlas_core::{Change, Hlc, Registry, WireKind, WireOperation};
use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use super::apply::{apply_live, MemberBatches};
use super::pull::partition_head;
use super::{
    cap_future_skew, entity_str, hlc_key, observe_client_ts, physical_now_ms, successor_hlc,
    take_sync_write_lock, HlcKey, SyncError, SyncResult, MAX_FUTURE_SKEW_MS,
};
use crate::apps::{RequestedApps, SessionApps};
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::members::Role;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub operations: Vec<WireOperation>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    /// The caller partition's newest `server_seq` after this batch. A client may adopt it as
    /// its pull cursor only when its own cursor is at least `from`.
    pub cursor: i64,
    pub applied: usize,
    /// The caller partition's newest `server_seq` before this batch.
    pub from: i64,
}

/// Cap on ops in one push batch; each op drives several DB round-trips.
const MAX_OPS_PER_PUSH: usize = 5000;

/// Cap on a single field value's serialized size, bounding row growth in the JSONB store.
const MAX_OP_VALUE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadFieldKind {
    Sha256,
}

/// Every field whose value the server reads, per wire kind: an attachment's blob addresses. They
/// must be plaintext public fields in the manifests, which a test checks.
pub(crate) const SERVER_READ_FIELDS: &[(&str, &[(&str, ReadFieldKind)])] = &[(
    "todo.sealed",
    &[
        ("blob_sha", ReadFieldKind::Sha256),
        ("thumb_sha", ReadFieldKind::Sha256),
    ],
)];

fn server_read_field(entity: &str, field: &str) -> Option<ReadFieldKind> {
    SERVER_READ_FIELDS
        .iter()
        .find(|(e, _)| *e == entity)?
        .1
        .iter()
        .find(|(f, _)| *f == field)
        .map(|(_, kind)| *kind)
}

/// Whether `field` is a field tag: 32 lowercase hex digits.
fn is_tag(field: &str) -> bool {
    field.len() == 32
        && field
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `value` is a field envelope version 3 and nothing else, so a client cannot send a
/// plaintext value by mistake.
fn is_sealed_envelope(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.len() == 4
        && obj.get("__enc").and_then(Value::as_u64) == Some(3)
        && ["kid", "iv", "ct"]
            .iter()
            .all(|k| obj.get(*k).is_some_and(Value::is_string))
}

/// Check one op's shape: a current wire kind the client may write, a scope that fits it, and a
/// field that is a tag or one of the kind's public names, with an envelope unless the server
/// reads the value.
fn validate_op(op: &WireOperation) -> AppResult<()> {
    let entity = entity_str(op.entity);
    match op.entity {
        WireKind::Legacy(_) => {
            return Err(AppError::BadRequest(format!(
                "{entity} is a protocol 6 kind: it is read-only, re-encode it and drop it \
                 (POST /sync/legacy/drop)"
            )))
        }
        // Membership is server-managed.
        WireKind::ProjectMember => {
            return Err(AppError::Forbidden(
                "project_member is server-managed".into(),
            ))
        }
        WireKind::TodoProject => {
            if op.scope.is_some_and(|s| s != op.entity_id) {
                return Err(AppError::BadRequest(
                    "a project op's scope is the project itself or none".into(),
                ));
            }
        }
        WireKind::TodoSealed => {}
        // Journal and vault are personal: their ops are always under the account's own key.
        WireKind::JournalSealed | WireKind::VaultSealed => {
            if op.scope.is_some() {
                return Err(AppError::BadRequest(format!("{entity} ops have no scope")));
            }
        }
    }
    let Change::Set { field, value } = &op.change else {
        return Ok(());
    };
    let public = Registry::bundled()
        .wire_kind(entity)
        .is_some_and(|k| k.is_public(field));
    if !public && !is_tag(field) {
        return Err(AppError::BadRequest(format!(
            "{entity}.{field} is neither a field tag nor a public field"
        )));
    }
    match server_read_field(entity, field) {
        Some(ReadFieldKind::Sha256) => {
            // Lowercase only: blob rows, downloads and the GC compare the lowercase form.
            let ok = match value {
                Value::Null => true,
                Value::String(s) => {
                    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                }
                _ => false,
            };
            if !ok {
                return Err(AppError::BadRequest(format!(
                    "{entity}.{field} must be a plaintext lowercase 64-hex sha256 string or null \
                     (the server reads it, so it cannot be encrypted)"
                )));
            }
        }
        None => {
            if !is_sealed_envelope(value) {
                return Err(AppError::BadRequest(format!(
                    "{entity}.{field} must be a field envelope version 3 \
                     ({{\"__enc\": 3, \"kid\", \"iv\", \"ct\"}})"
                )));
            }
        }
    }
    Ok(())
}

/// Where the batch's sealed entities live as of its end: an entity's scope is that of its newest
/// op, in the batch or stored (`entity_scopes`, see `apply.rs`). Stored scopes are read once.
struct Scopes {
    /// Per entity, the batch's set op with the greatest timestamp.
    batch: HashMap<Uuid, usize>,
    stored: HashMap<Uuid, (Option<Uuid>, HlcKey)>,
}

impl Scopes {
    async fn load(conn: &mut PgConnection, caller: Uuid, ops: &[WireOperation]) -> AppResult<Self> {
        let mut batch: HashMap<Uuid, usize> = HashMap::new();
        let mut ids: Vec<Uuid> = Vec::new();
        for (i, op) in ops.iter().enumerate() {
            if op.entity != WireKind::TodoSealed {
                continue;
            }
            ids.push(op.entity_id);
            if !matches!(op.change, Change::Set { .. }) {
                continue;
            }
            match batch.get(&op.entity_id) {
                Some(&best) if ops[best].ts >= op.ts => {}
                _ => {
                    batch.insert(op.entity_id, i);
                }
            }
        }
        ids.sort_unstable();
        ids.dedup();
        let stored = if ids.is_empty() {
            HashMap::new()
        } else {
            let rows: Vec<(Uuid, Option<Uuid>, i64, i32, Uuid)> = sqlx::query_as(
                "SELECT entity_id, scope, hlc_wall_ms, hlc_counter, hlc_node FROM entity_scopes
                  WHERE user_id = $1 AND entity = 'todo.sealed' AND entity_id = ANY($2)",
            )
            .bind(caller)
            .bind(&ids)
            .fetch_all(conn)
            .await?;
            rows.into_iter()
                .map(|(id, scope, wall, counter, node)| (id, (scope, (wall, counter, node))))
                .collect()
        };
        Ok(Self { batch, stored })
    }

    /// The batch op that moves `entity_id` to another scope, with the scope it leaves: the batch's
    /// newest set op of the entity, when it is newer than the stored scope and names another one.
    fn move_of<'a>(
        &self,
        ops: &'a [WireOperation],
        entity_id: Uuid,
    ) -> AppResult<Option<(usize, &'a WireOperation, Option<Uuid>)>> {
        let Some(&i) = self.batch.get(&entity_id) else {
            return Ok(None);
        };
        let op = &ops[i];
        match self.stored.get(&entity_id) {
            Some((old, ts)) if *old != op.scope && hlc_key(&op.ts)? > *ts => {
                Ok(Some((i, op, *old)))
            }
            _ => Ok(None),
        }
    }

    /// The scope `entity_id` has as of the batch's end; `fallback` for an entity neither the batch
    /// nor the partition gives one.
    fn effective(
        &self,
        ops: &[WireOperation],
        entity_id: Uuid,
        fallback: Option<Uuid>,
    ) -> AppResult<Option<Uuid>> {
        let batch = self.batch.get(&entity_id).map(|&i| &ops[i]);
        Ok(match (batch, self.stored.get(&entity_id)) {
            (Some(op), Some((scope, ts))) => {
                if hlc_key(&op.ts)? > *ts {
                    op.scope
                } else {
                    *scope
                }
            }
            (Some(op), None) => op.scope,
            (None, Some((scope, _))) => *scope,
            (None, None) => fallback,
        })
    }
}

/// The stored scope of a sealed entity in `user`'s partition, with the stamp of its newest op.
async fn stored_scope(
    conn: &mut PgConnection,
    user: Uuid,
    entity_id: Uuid,
) -> AppResult<Option<(Option<Uuid>, HlcKey)>> {
    let row: Option<(Option<Uuid>, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT scope, hlc_wall_ms, hlc_counter, hlc_node FROM entity_scopes
          WHERE user_id = $1 AND entity = 'todo.sealed' AND entity_id = $2",
    )
    .bind(user)
    .bind(entity_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(scope, wall, counter, node)| (scope, (wall, counter, node))))
}

async fn newest_field(
    conn: &mut PgConnection,
    partitions: &[Uuid],
    entity_id: Uuid,
) -> AppResult<Option<HlcKey>> {
    Ok(sqlx::query_as(
        "SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
          WHERE user_id = ANY($1) AND entity = 'todo.sealed' AND entity_id = $2
          ORDER BY hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC
          LIMIT 1",
    )
    .bind(partitions)
    .bind(entity_id)
    .fetch_optional(conn)
    .await?)
}

/// A sealed entity leaving a shared project for somewhere a member cannot follow: that member gets
/// a tombstone and a `revoked_entities` row (see [`still_revoked`]).
struct Revocation {
    entity_id: Uuid,
    members: Vec<Uuid>,
    after: Hlc,
}

/// Whether ops of `kind` can reach another account's partition: only todo's, through a shared
/// project. Every other kind stays in its owner's partition, whatever its scope says. Exhaustive
/// on purpose, so a new kind (another app's) cannot inherit todo's sharing by accident.
fn may_fan_out(kind: WireKind) -> bool {
    match kind {
        WireKind::TodoProject | WireKind::TodoSealed => true,
        WireKind::ProjectMember => false,
        // Journal and vault v1 are personal: owner-only, no sharing. A stolen password is worse
        // than a leaked task.
        WireKind::JournalSealed | WireKind::VaultSealed => false,
        // Refused on push ([`validate_op`]).
        WireKind::Legacy(_) => false,
    }
}

/// The project `op` belongs to as of the batch's end: a project op's own, a sealed entity's scope.
fn project_of(
    op: &WireOperation,
    ops: &[WireOperation],
    scopes: &Scopes,
) -> AppResult<Option<Uuid>> {
    match op.entity {
        WireKind::TodoProject => Ok(Some(op.entity_id)),
        WireKind::TodoSealed => scopes.effective(ops, op.entity_id, op.scope),
        WireKind::ProjectMember
        | WireKind::JournalSealed
        | WireKind::VaultSealed
        | WireKind::Legacy(_) => Ok(None),
    }
}

/// A project's membership rows as the push transaction sees them: `(user, role, active)`.
/// Read on the transaction's own connection: a second pool checkout would let pushes queued on
/// the lock pin every connection while the holder waits for one.
struct ProjectMembers(Vec<(Uuid, Role, bool)>);

impl ProjectMembers {
    async fn load(conn: &mut PgConnection, project_id: Uuid) -> AppResult<Self> {
        let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
            "SELECT user_id, role, state FROM project_members WHERE project_id = $1",
        )
        .bind(project_id)
        .fetch_all(conn)
        .await?;
        rows.into_iter()
            .map(|(user, role, state)| Ok((user, Role::parse(&role)?, state == "active")))
            .collect::<AppResult<_>>()
            .map(Self)
    }

    fn is_shared(&self) -> bool {
        !self.0.is_empty()
    }

    fn active_role(&self, user: Uuid) -> Option<Role> {
        self.0
            .iter()
            .find(|(id, _, active)| *id == user && *active)
            .map(|(_, role, _)| *role)
    }

    fn require_role(&self, user: Uuid, min: Role) -> AppResult<Role> {
        match self.active_role(user) {
            Some(role) if role >= min => Ok(role),
            _ => Err(AppError::Forbidden(format!(
                "requires {} role on this project",
                min.as_str()
            ))),
        }
    }

    fn active_ids(&self) -> Vec<Uuid> {
        self.0
            .iter()
            .filter(|(_, _, active)| *active)
            .map(|(id, _, _)| *id)
            .collect()
    }
}

/// The sealed entities the batch writes that a move took away from `caller` ([`Revocation`]) and
/// that are still out of their reach. The tombstone alone would not keep them away (a later
/// field shows the entity again, and retention purges it), so the caller may not write them while
/// their partition puts them in no project or a private one. One back in a shared project the
/// caller is active in is theirs again, and its row is dropped.
async fn still_revoked(
    tx: &mut Transaction<'_, Postgres>,
    members_cache: &mut HashMap<Uuid, ProjectMembers>,
    caller: Uuid,
    ops: &[WireOperation],
) -> AppResult<HashSet<Uuid>> {
    let written: Vec<Uuid> = ops
        .iter()
        .filter(|op| op.entity == WireKind::TodoSealed && matches!(op.change, Change::Set { .. }))
        .map(|op| op.entity_id)
        .collect();
    if written.is_empty() {
        return Ok(HashSet::new());
    }
    let recorded: Vec<Uuid> = sqlx::query_scalar(
        "SELECT entity_id FROM revoked_entities WHERE user_id = $1 AND entity_id = ANY($2)",
    )
    .bind(caller)
    .bind(&written)
    .fetch_all(&mut **tx)
    .await?;
    let (mut revoked, mut returned) = (HashSet::new(), Vec::new());
    for entity_id in recorded {
        let back = match stored_scope(tx, caller, entity_id).await? {
            Some((Some(pid), _)) => project_members(tx, members_cache, pid)
                .await?
                .active_role(caller)
                .is_some(),
            _ => false,
        };
        if back {
            returned.push(entity_id);
        } else {
            revoked.insert(entity_id);
        }
    }
    if !returned.is_empty() {
        sqlx::query("DELETE FROM revoked_entities WHERE user_id = $1 AND entity_id = ANY($2)")
            .bind(caller)
            .bind(&returned)
            .execute(&mut **tx)
            .await?;
    }
    Ok(revoked)
}

async fn project_members<'a>(
    tx: &mut Transaction<'_, Postgres>,
    cache: &'a mut HashMap<Uuid, ProjectMembers>,
    project_id: Uuid,
) -> AppResult<&'a ProjectMembers> {
    Ok(match cache.entry(project_id) {
        Entry::Occupied(e) => e.into_mut(),
        Entry::Vacant(e) => e.insert(ProjectMembers::load(tx, project_id).await?),
    })
}

/// The minimum role required to push this op onto a shared project.
///
/// A sealed entity (task, section, comment, activity, attachment, …) needs only `Commenter` (any
/// active member). Editing the project entity's fields needs `Editor`. Deleting or archiving the
/// project is owner-only, so an editor cannot remove it from under its owner: `deleted_at` and
/// `archived_at` keep their names on the wire for this. Membership changes go through REST.
fn min_role_for_op(op: &WireOperation) -> Role {
    match op.entity {
        WireKind::TodoSealed => Role::Commenter,
        WireKind::TodoProject => match &op.change {
            Change::Delete => Role::Owner,
            Change::Set { field, .. } if field == "deleted_at" || field == "archived_at" => {
                Role::Owner
            }
            Change::Set { .. } => Role::Editor,
        },
        // Never on a shared project ([`may_fan_out`]); the strictest answer if one were.
        WireKind::ProjectMember
        | WireKind::JournalSealed
        | WireKind::VaultSealed
        | WireKind::Legacy(_) => Role::Owner,
    }
}

/// `POST /sync/push`: persist a batch idempotently, fold it into LWW state, and fan out ops on
/// shared projects to every co-member's partition and live channel.
pub(super) async fn push(
    State(state): State<AppState>,
    user: AuthUser,
    requested: RequestedApps,
    Json(req): Json<PushRequest>,
) -> SyncResult<Json<PushResponse>> {
    let caller = user.user_id;
    let (ops, newest) = check_batch(caller, req.operations)?;
    // Every op's app must be enabled for the instance and the account, and in the session's scope.
    SessionApps::for_request(&state, &user, requested)
        .await?
        .check_ops(&ops)?;

    let mut tx = state.pool.begin().await?;
    // Serialize all sync writes (see [`SYNC_WRITE_LOCK`]).
    take_sync_write_lock(&mut tx).await?;

    // Authorize every op and resolve its fan-out before writing anything.
    let scopes = Scopes::load(&mut tx, caller, &ops).await?;
    let mut fan_out = authorize(&mut tx, caller, &ops, &scopes).await?;
    drop_members_without_app(&mut tx, &ops, &mut fan_out.targets).await?;
    let tombstones = revoke_moved(&mut tx, &state, fan_out.revocations).await?;
    let (applied, batches) =
        apply_and_fan_out(&mut tx, caller, &ops, &fan_out.targets, &tombstones).await?;

    // Keep each blob bound to the project its attachment lives in (`attachments::bind_blobs`):
    // the entities that name a blob or changed scope.
    let mut rebind: Vec<Uuid> = ops
        .iter()
        .filter(|op| {
            op.entity == WireKind::TodoSealed
                && matches!(&op.change, Change::Set { field, .. }
                    if server_read_field("todo.sealed", field).is_some())
        })
        .map(|op| op.entity_id)
        .collect();
    rebind.extend(fan_out.moved);
    rebind.sort_unstable();
    rebind.dedup();
    if !rebind.is_empty() {
        crate::attachments::bind_blobs(&mut tx, caller, &rebind, &[]).await?;
    }

    let cursor = partition_head(&mut tx, caller).await?;
    let from = batches.get(&caller).map_or(cursor, |batch| batch.from);

    tx.commit().await?;

    // Observe the accepted timestamps so later server-authored ops order after them.
    if let Some(newest) = newest {
        observe_client_ts(&state, newest);
    }

    for (user, batch) in batches {
        batch.publish(&state.hub, user);
    }

    Ok(Json(PushResponse {
        cursor,
        applied,
        from,
    }))
}

/// Check a batch before the transaction, so a malformed one never takes the global write lock,
/// and stamp every op with its pusher. Returns the ops and their newest timestamp.
fn check_batch(
    caller: Uuid,
    operations: Vec<WireOperation>,
) -> SyncResult<(Vec<WireOperation>, Option<Hlc>)> {
    if operations.len() > MAX_OPS_PER_PUSH {
        return Err(AppError::BadRequest("too many operations in one push".into()).into());
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut newest: Option<Hlc> = None;
    for op in &operations {
        validate_op(op)?;

        // Reject a future HLC wall clock before it can win LWW (see MAX_FUTURE_SKEW_MS).
        let wall = i64::try_from(op.ts.wall_ms)
            .map_err(|_| AppError::BadRequest("hlc wall_ms too large".into()))?;
        if wall > now_ms.saturating_add(MAX_FUTURE_SKEW_MS) {
            return Err(SyncError::ClockSkew {
                server_time: now_ms,
            });
        }
        // Clocks carry past MAX_COUNTER, so a larger counter is forged; observing it would
        // push the server clock's counter past what `int4` holds.
        if op.ts.counter > MAX_COUNTER {
            return Err(AppError::BadRequest("hlc counter too large".into()).into());
        }
        newest = newest.max(Some(op.ts));

        // Bound a single field value's size.
        if let Change::Set { value, .. } = &op.change {
            if value.to_string().len() > MAX_OP_VALUE_BYTES {
                return Err(AppError::BadRequest("operation value too large".into()).into());
            }
        }
    }

    // Clients check an activity's actor against the pusher, which only the server may say.
    let mut ops = operations;
    for op in &mut ops {
        op.pushed_by = Some(caller);
    }
    Ok((ops, newest))
}

/// Where a batch goes beyond the caller's own partition, as [`authorize`] resolved it.
struct FanOut {
    /// Per op, in batch order: the co-members whose partitions receive it.
    targets: Vec<Vec<Uuid>>,
    /// Sealed entities the batch moves away from members who cannot follow them.
    revocations: Vec<Revocation>,
    /// Sealed entities the batch moves to another scope.
    moved: Vec<Uuid>,
}

/// Authorize every op of a batch against the caller's project roles and resolve its fan-out.
/// Runs before any of the batch is written, so a refused op fails it whole.
async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    caller: Uuid,
    ops: &[WireOperation],
    scopes: &Scopes,
) -> AppResult<FanOut> {
    let mut members_cache: HashMap<Uuid, ProjectMembers> = HashMap::new();

    let revoked = still_revoked(tx, &mut members_cache, caller, ops).await?;
    let mut revocations: Vec<Revocation> = Vec::new();
    let mut moved: Vec<Uuid> = Vec::new();
    let mut fan_targets: Vec<Vec<Uuid>> = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        // Owner-only kinds: nothing to authorize against a project, and nobody else receives them.
        if !may_fan_out(op.entity) {
            fan_targets.push(Vec::new());
            continue;
        }
        let project = project_of(op, ops, scopes)?;

        // An entity a move took away stays away (see `still_revoked`).
        if revoked.contains(&op.entity_id) && matches!(op.change, Change::Set { .. }) {
            return Err(AppError::Forbidden(
                "this item was moved to a project you are not a member of".into(),
            ));
        }

        let mut targets = Vec::new();
        if let Some(pid) = project {
            let members = project_members(tx, &mut members_cache, pid).await?;
            if members.is_shared() {
                members.require_role(caller, min_role_for_op(op))?;
                targets = members.active_ids();
            }
        }

        // An entity moving out of a shared project: the old project's members get the move too,
        // and those who cannot see the new scope lose the entity, which takes an editor.
        if op.entity == WireKind::TodoSealed {
            if let Some((winner, move_op, old)) = scopes.move_of(ops, op.entity_id)? {
                if winner == i {
                    moved.push(op.entity_id);
                    if let Some(old) = old {
                        let old_members = project_members(tx, &mut members_cache, old).await?;
                        if old_members.is_shared() {
                            old_members.require_role(caller, Role::Editor)?;
                            let left_behind: Vec<Uuid> = old_members
                                .active_ids()
                                .into_iter()
                                .filter(|m| *m != caller && !targets.contains(m))
                                .collect();
                            targets.extend(&left_behind);
                            if !left_behind.is_empty() {
                                revocations.push(Revocation {
                                    entity_id: op.entity_id,
                                    members: left_behind,
                                    after: move_op.ts,
                                });
                            }
                        }
                    }
                }
            }
        }
        targets.retain(|member| *member != caller);
        fan_targets.push(targets);
    }
    Ok(FanOut {
        targets: fan_targets,
        revocations,
        moved,
    })
}

/// Leave out of each op's fan-out the co-members whose account has not enabled the op's app:
/// none of their sessions would serve it.
async fn drop_members_without_app(
    conn: &mut PgConnection,
    ops: &[WireOperation],
    targets: &mut [Vec<Uuid>],
) -> AppResult<()> {
    let mut members: Vec<Uuid> = targets.iter().flatten().copied().collect();
    if members.is_empty() {
        return Ok(());
    }
    members.sort_unstable();
    members.dedup();
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT user_id, app FROM account_apps WHERE user_id = ANY($1)")
            .bind(&members)
            .fetch_all(conn)
            .await?;
    let enabled: HashSet<(Uuid, String)> = rows.into_iter().collect();
    for (op, targets) in ops.iter().zip(targets.iter_mut()) {
        let app = Registry::bundled()
            .app_of_wire(entity_str(op.entity))
            .map(|a| a.app.clone())
            .unwrap_or_default();
        targets.retain(|member| enabled.contains(&(*member, app.clone())));
    }
    Ok(())
}

/// Record each [`Revocation`] and build the tombstone its members receive: it beats the move
/// and every field its recipients hold, and the recorded revocation keeps it hidden from what
/// they write later.
async fn revoke_moved(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    revocations: Vec<Revocation>,
) -> AppResult<Vec<(Vec<Uuid>, WireOperation)>> {
    let (revoked_users, revoked_ids): (Vec<Uuid>, Vec<Uuid>) = revocations
        .iter()
        .flat_map(|rev| rev.members.iter().map(|member| (*member, rev.entity_id)))
        .unzip();
    if !revoked_users.is_empty() {
        sqlx::query(
            "INSERT INTO revoked_entities (user_id, entity_id)
             SELECT * FROM UNNEST($1::uuid[], $2::uuid[])
             ON CONFLICT (user_id, entity_id) DO NOTHING",
        )
        .bind(&revoked_users)
        .bind(&revoked_ids)
        .execute(&mut **tx)
        .await?;
    }
    let mut revoke_ops: Vec<(Vec<Uuid>, WireOperation)> = Vec::with_capacity(revocations.len());
    for rev in revocations {
        let mut floor = rev.after;
        if let Some((wall, counter, node)) = newest_field(tx, &rev.members, rev.entity_id).await? {
            floor = floor.max(Hlc {
                wall_ms: wall as u64,
                counter: counter as u32,
                node,
            });
        }
        // The clock observes the floor only up to the skew a pushed op may carry, so a stored
        // far-future stamp cannot drag later server ops along. The tombstone still beats the floor.
        let now = physical_now_ms();
        let ts = state
            .clock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .update(cap_future_skew(floor, now), now)
            .max(successor_hlc(floor));
        revoke_ops.push((
            rev.members,
            WireOperation::delete(WireKind::TodoSealed, rev.entity_id, None, ts),
        ));
    }
    Ok(revoke_ops)
}

/// Apply the batch to the caller's partition, then each newly applied op to its `targets` and
/// each revocation tombstone to its members. Returns how many ops were new to the caller and
/// the live batches to publish after commit.
async fn apply_and_fan_out(
    tx: &mut Transaction<'_, Postgres>,
    caller: Uuid,
    ops: &[WireOperation],
    targets: &[Vec<Uuid>],
    tombstones: &[(Vec<Uuid>, WireOperation)],
) -> AppResult<(usize, MemberBatches)> {
    let caller_rows: Vec<(Uuid, &WireOperation)> = ops.iter().map(|op| (caller, op)).collect();
    let (caller_seqs, mut batches) = apply_live(tx, &caller_rows).await?;
    let applied = caller_seqs.iter().filter(|seq| seq.is_some()).count();
    let mut member_rows: Vec<(Uuid, &WireOperation)> = ops
        .iter()
        .zip(targets)
        .zip(&caller_seqs)
        .filter(|(_, seq)| seq.is_some())
        .flat_map(|((op, targets), _)| targets.iter().map(move |member| (*member, op)))
        .collect();
    for (members, tombstone) in tombstones {
        member_rows.extend(members.iter().map(|member| (*member, tombstone)));
    }
    let (_, member_batches) = apply_live(tx, &member_rows).await?;
    batches.extend(member_batches);
    Ok((applied, batches))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_server_read_field_is_plaintext_and_public_in_the_manifests() {
        let registry = Registry::bundled();
        for (entity, fields) in SERVER_READ_FIELDS {
            let kind = registry
                .wire_kind(entity)
                .unwrap_or_else(|| panic!("{entity} is no wire kind of a manifest"));
            for (field, _) in *fields {
                assert!(
                    kind.is_public(field) && kind.plaintext_fields.contains(field),
                    "{entity}.{field} is read by the server but its manifest lets the client \
                     tag or encrypt it"
                );
            }
        }
    }

    /// Lowercase names in `source` that directly follow `needle` and are closed by `end`.
    fn quoted_after<'a>(source: &'a str, needle: &str, end: char) -> Vec<&'a str> {
        source
            .match_indices(needle)
            .filter_map(|(i, _)| {
                let rest = &source[i + needle.len()..];
                let name = &rest[..rest.find(end)?];
                (!name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
                    .then_some(name)
            })
            .collect()
    }

    #[test]
    fn server_read_fields_cover_every_field_lookup_in_the_source() {
        // A public field matched by name only (never by value).
        const NOT_INTERPRETED: &[&str] = &["deleted_at", "archived_at"];
        // The legacy invite preview reads a legacy project's fields by name and hands them back.
        const LEGACY_PREVIEW: &[&str] = &["name", "icon", "color", "kind"];
        let sources = [
            include_str!("mod.rs"),
            include_str!("apply.rs"),
            include_str!("backfill.rs"),
            include_str!("hub.rs"),
            include_str!("legacy.rs"),
            include_str!("pull.rs"),
            include_str!("push.rs"),
            include_str!("revoke.rs"),
            include_str!("snapshot.rs"),
            include_str!("ws.rs"),
            include_str!("../members.rs"),
            include_str!("../attachments.rs"),
            include_str!("../restore.rs"),
            include_str!("../projects.rs"),
            include_str!("../retention.rs"),
        ];
        let mut seen = Vec::new();
        for src in sources {
            seen.extend(quoted_after(src, "field = '", '\''));
            seen.extend(quoted_after(src, "field == \"", '"'));
            // A field compared against a quoted list of names.
            for (i, _) in src.match_indices("field IN (") {
                let rest = &src[i + "field IN (".len()..];
                let list = &rest[..rest.find(')').unwrap_or(0)];
                seen.extend(
                    list.split(',')
                        .map(|n| n.trim().trim_matches('\''))
                        .filter(|n| {
                            !n.is_empty() && n.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                        }),
                );
            }
        }
        assert!(seen.contains(&"blob_sha") && seen.contains(&"archived_at"));
        // The rows written before protocol 7, which the legacy read paths still follow until their
        // clients migrate them, carry the manifests' `legacy_plaintext_fields`.
        let legacy: Vec<&str> = Registry::bundled()
            .apps()
            .iter()
            .flat_map(|a| a.kinds.values())
            .flat_map(|k| k.legacy_plaintext_fields.iter().map(String::as_str))
            .collect();
        for field in seen {
            let listed = SERVER_READ_FIELDS
                .iter()
                .any(|(_, fields)| fields.iter().any(|(f, _)| *f == field));
            assert!(
                listed
                    || NOT_INTERPRETED.contains(&field)
                    || LEGACY_PREVIEW.contains(&field)
                    || legacy.contains(&field),
                "the server reads `{field}`; add it to SERVER_READ_FIELDS"
            );
        }
    }

    fn set(entity: WireKind, scope: Option<Uuid>, field: &str, value: Value) -> WireOperation {
        WireOperation::set(
            entity,
            Uuid::from_u128(1),
            scope,
            field,
            value,
            Hlc {
                wall_ms: 1,
                counter: 0,
                node: Uuid::nil(),
            },
        )
    }

    fn envelope() -> Value {
        json!({"__enc": 3, "kid": "dek", "iv": "aXY=", "ct": "Y3Q="})
    }

    #[test]
    fn ops_are_checked_against_the_wire_kinds() {
        let tag = "0123456789abcdef0123456789abcdef";
        let sha = "a".repeat(64);
        let pid = Uuid::from_u128(9);
        let own = Some(Uuid::from_u128(1));
        let delete = WireOperation::delete(
            WireKind::TodoSealed,
            Uuid::from_u128(1),
            Some(pid),
            Hlc {
                wall_ms: 1,
                counter: 0,
                node: Uuid::nil(),
            },
        );
        for ok in [
            set(WireKind::TodoSealed, None, tag, envelope()),
            set(WireKind::TodoSealed, Some(pid), tag, envelope()),
            set(WireKind::TodoSealed, Some(pid), "blob_sha", json!(sha)),
            set(WireKind::TodoSealed, None, "thumb_sha", Value::Null),
            set(WireKind::TodoProject, None, "archived_at", envelope()),
            set(WireKind::TodoProject, own, tag, envelope()),
            set(WireKind::VaultSealed, None, tag, envelope()),
            delete,
        ] {
            validate_op(&ok).unwrap_or_else(|e| panic!("{ok:?}: {e:?}"));
        }
        let wrong_version = json!({"__enc": 2, "kid": "k", "iv": "i", "ct": "c"});
        let extra_key = json!({"__enc": 3, "kid": "k", "iv": "i", "ct": "c", "x": 1});
        let legacy = WireKind::Legacy(atlas_core::EntityKind::Task);
        for bad in [
            // A field name instead of a tag, or a public name of another kind.
            set(WireKind::TodoSealed, None, "title", envelope()),
            set(WireKind::TodoSealed, None, "archived_at", envelope()),
            set(WireKind::TodoProject, None, "blob_sha", json!(sha)),
            // A tag of the wrong shape.
            set(WireKind::TodoSealed, None, &tag.to_uppercase(), envelope()),
            set(WireKind::TodoSealed, None, &tag[1..], envelope()),
            // Plaintext, or another envelope, where a v3 envelope belongs.
            set(WireKind::TodoSealed, None, tag, json!("Buy milk")),
            set(WireKind::TodoSealed, None, tag, Value::Null),
            set(WireKind::TodoSealed, None, tag, wrong_version),
            set(WireKind::TodoSealed, None, tag, extra_key),
            set(WireKind::TodoProject, None, "deleted_at", json!(1)),
            // An envelope, or uppercase hex, where the server reads a plaintext hash.
            set(WireKind::TodoSealed, None, "blob_sha", envelope()),
            set(
                WireKind::TodoSealed,
                None,
                "blob_sha",
                json!(sha.to_uppercase()),
            ),
            // Scopes that do not fit the kind.
            set(WireKind::TodoProject, Some(pid), tag, envelope()),
            set(WireKind::JournalSealed, Some(pid), tag, envelope()),
            // Legacy kinds are read-only, membership is the server's.
            set(legacy, None, "title", json!("x")),
            set(WireKind::ProjectMember, None, "role", json!("owner")),
        ] {
            assert!(validate_op(&bad).is_err(), "{bad:?}");
        }
    }
}
