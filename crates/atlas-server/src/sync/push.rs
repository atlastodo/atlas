//! `POST /sync/push`: a client's batch validated, authorized against project membership,
//! folded into the caller's partition and fanned out to co-members.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::PoisonError;
use std::time::{SystemTime, UNIX_EPOCH};

use atlas_core::hlc::MAX_COUNTER;
use atlas_core::{Change, EntityKind, Hlc, Operation};
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
use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::members::Role;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub operations: Vec<Operation>,
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
    Uuid,
    Sha256,
}

/// Every field whose value the server reads, per entity. Clients encrypt all other values, so
/// these must arrive as plaintext: an envelope here silently breaks fan-out or authorization.
/// `test-vectors/plaintext_fields.json` is the client's side of this contract.
pub(crate) const SERVER_READ_FIELDS: &[(&str, &[(&str, ReadFieldKind)])] = &[
    (
        "task",
        &[
            ("project_id", ReadFieldKind::Uuid),
            ("assignee_id", ReadFieldKind::Uuid),
        ],
    ),
    ("section", &[("project_id", ReadFieldKind::Uuid)]),
    ("comment", &[("task_id", ReadFieldKind::Uuid)]),
    (
        "activity",
        &[
            ("task_id", ReadFieldKind::Uuid),
            ("actor_id", ReadFieldKind::Uuid),
        ],
    ),
    (
        "attachment",
        &[
            ("task_id", ReadFieldKind::Uuid),
            ("blob_sha", ReadFieldKind::Sha256),
            ("thumb_sha", ReadFieldKind::Sha256),
        ],
    ),
];

fn server_read_field(entity: &str, field: &str) -> Option<ReadFieldKind> {
    SERVER_READ_FIELDS
        .iter()
        .find(|(e, _)| *e == entity)?
        .1
        .iter()
        .find(|(f, _)| *f == field)
        .map(|(_, kind)| *kind)
}

/// Reject a push whose value for a [`SERVER_READ_FIELDS`] field is not the expected plaintext
/// shape (or null, which clears a link).
fn validate_server_read_field(op: &Operation) -> AppResult<()> {
    let Change::Set { field, value } = &op.change else {
        return Ok(());
    };
    let entity = entity_str(op.entity);
    let Some(kind) = server_read_field(entity, field) else {
        return Ok(());
    };
    let ok = match value {
        Value::Null => true,
        Value::String(s) => match kind {
            ReadFieldKind::Uuid => Uuid::parse_str(s).is_ok(),
            // Lowercase only: blob rows, downloads and the GC compare the lowercase form.
            ReadFieldKind::Sha256 => {
                s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }
        },
        _ => false,
    };
    if ok {
        return Ok(());
    }
    let expected = match kind {
        ReadFieldKind::Uuid => "a plaintext UUID string",
        ReadFieldKind::Sha256 => "a plaintext lowercase 64-hex sha256 string",
    };
    Err(AppError::BadRequest(format!(
        "{entity}.{field} must be {expected} or null (the server reads it, so it cannot be encrypted)"
    )))
}

async fn field_value(
    conn: &mut PgConnection,
    user_id: Uuid,
    entity: &str,
    entity_id: Uuid,
    field: &str,
) -> AppResult<Option<Value>> {
    let v: Option<Value> = sqlx::query_scalar(
        "SELECT value FROM entity_fields
         WHERE user_id = $1 AND entity = $2 AND entity_id = $3 AND field = $4",
    )
    .bind(user_id)
    .bind(entity)
    .bind(entity_id)
    .bind(field)
    .fetch_optional(conn)
    .await?;
    Ok(v)
}

fn as_uuid(v: &Value) -> Option<Uuid> {
    v.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

/// Resolves the `project_id`/`task_id` links a push batch's ops depend on. A link set anywhere
/// in the batch counts for every op (last wins, null clears), so fan-out does not depend on
/// field order; otherwise the caller's stored value holds. Stored values are read once.
struct Links {
    caller: Uuid,
    batch: HashMap<(Uuid, &'static str), Option<Uuid>>,
    stored: HashMap<(Uuid, &'static str), Option<Uuid>>,
}

impl Links {
    fn new(caller: Uuid, ops: &[Operation]) -> Self {
        let mut batch = HashMap::new();
        for op in ops {
            if let Change::Set { field, value } = &op.change {
                let field = match field.as_str() {
                    "project_id" => "project_id",
                    "task_id" => "task_id",
                    _ => continue,
                };
                batch.insert((op.entity_id, field), as_uuid(value));
            }
        }
        Self {
            caller,
            batch,
            stored: HashMap::new(),
        }
    }

    async fn get(
        &mut self,
        conn: &mut PgConnection,
        entity: &str,
        entity_id: Uuid,
        field: &'static str,
    ) -> AppResult<Option<Uuid>> {
        if let Some(link) = self.batch.get(&(entity_id, field)) {
            return Ok(*link);
        }
        if let Some(link) = self.stored.get(&(entity_id, field)) {
            return Ok(*link);
        }
        let link = field_value(conn, self.caller, entity, entity_id, field)
            .await?
            .as_ref()
            .and_then(as_uuid);
        self.stored.insert((entity_id, field), link);
        Ok(link)
    }

    /// The uuid `op`'s entity links to through `field`: its own value, else as of batch end.
    async fn of_op(
        &mut self,
        conn: &mut PgConnection,
        op: &Operation,
        field: &'static str,
    ) -> AppResult<Option<Uuid>> {
        if let Change::Set { field: f, value } = &op.change {
            if f == field {
                return Ok(as_uuid(value));
            }
        }
        self.get(conn, entity_str(op.entity), op.entity_id, field)
            .await
    }
}

async fn stored_project_link(
    conn: &mut PgConnection,
    user: Uuid,
    task_id: Uuid,
) -> AppResult<Option<(Option<Uuid>, HlcKey)>> {
    let row: Option<(Value, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT value, hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
          WHERE user_id = $1 AND entity = 'task' AND entity_id = $2 AND field = 'project_id'",
    )
    .bind(user)
    .bind(task_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(value, wall, counter, node)| (as_uuid(&value), (wall, counter, node))))
}

async fn newest_task_field(
    conn: &mut PgConnection,
    partitions: &[Uuid],
    task_id: Uuid,
) -> AppResult<Option<HlcKey>> {
    Ok(sqlx::query_as(
        "SELECT hlc_wall_ms, hlc_counter, hlc_node FROM entity_fields
          WHERE user_id = ANY($1) AND entity = 'task' AND entity_id = $2
          ORDER BY hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC
          LIMIT 1",
    )
    .bind(partitions)
    .bind(task_id)
    .fetch_optional(conn)
    .await?)
}

fn project_moves(ops: &[Operation]) -> HashMap<Uuid, usize> {
    let mut winners: HashMap<Uuid, usize> = HashMap::new();
    for (i, op) in ops.iter().enumerate() {
        let sets_project = matches!(&op.change, Change::Set { field, .. } if field == "project_id");
        if op.entity != EntityKind::Task || !sets_project {
            continue;
        }
        match winners.get(&op.entity_id) {
            Some(&best) if ops[best].ts >= op.ts => {}
            _ => {
                winners.insert(op.entity_id, i);
            }
        }
    }
    winners
}

/// A task leaving a shared project for somewhere a member cannot follow: that member gets a
/// tombstone and a `revoked_tasks` row (see [`still_revoked`]).
struct Revocation {
    task_id: Uuid,
    members: Vec<Uuid>,
    after: Hlc,
}

async fn project_of(
    conn: &mut PgConnection,
    op: &Operation,
    links: &mut Links,
) -> AppResult<Option<Uuid>> {
    match op.entity {
        EntityKind::Project => Ok(Some(op.entity_id)),
        EntityKind::Task | EntityKind::Section => links.of_op(conn, op, "project_id").await,
        // Comments, activity and attachments follow their task's project (it may be created in
        // this batch).
        EntityKind::Comment | EntityKind::Activity | EntityKind::Attachment => {
            match links.of_op(conn, op, "task_id").await? {
                Some(task_id) => links.get(conn, "task", task_id, "project_id").await,
                None => Ok(None),
            }
        }
        // Private to their owner.
        _ => Ok(None),
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

/// The tasks the batch sets fields of that a move took away from `caller` ([`Revocation`]) and
/// that are still out of their reach. The tombstone alone would not keep them away (a later
/// field shows the task again, and retention purges it), so the caller may not write them while
/// their partition links them to no project or a private one. One back in a shared project the
/// caller is active in is theirs again, and its row is dropped.
async fn still_revoked(
    tx: &mut Transaction<'_, Postgres>,
    members_cache: &mut HashMap<Uuid, ProjectMembers>,
    caller: Uuid,
    ops: &[Operation],
) -> AppResult<HashSet<Uuid>> {
    let written: Vec<Uuid> = ops
        .iter()
        .filter(|op| op.entity == EntityKind::Task && matches!(op.change, Change::Set { .. }))
        .map(|op| op.entity_id)
        .collect();
    if written.is_empty() {
        return Ok(HashSet::new());
    }
    let recorded: Vec<Uuid> = sqlx::query_scalar(
        "SELECT task_id FROM revoked_tasks WHERE user_id = $1 AND task_id = ANY($2)",
    )
    .bind(caller)
    .bind(&written)
    .fetch_all(&mut **tx)
    .await?;
    let (mut revoked, mut returned) = (HashSet::new(), Vec::new());
    for task in recorded {
        let back = match stored_project_link(tx, caller, task).await? {
            Some((Some(pid), _)) => project_members(tx, members_cache, pid)
                .await?
                .active_role(caller)
                .is_some(),
            _ => false,
        };
        if back {
            returned.push(task);
        } else {
            revoked.insert(task);
        }
    }
    if !returned.is_empty() {
        sqlx::query("DELETE FROM revoked_tasks WHERE user_id = $1 AND task_id = ANY($2)")
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
/// Tasks, sections, comments and activity need only `Commenter` (any active member). Editing the
/// project entity's fields needs `Editor`. Deleting or archiving the project is owner-only, so
/// an editor cannot remove it from under its owner. Membership changes go through REST.
fn min_role_for_op(op: &Operation) -> Role {
    match op.entity {
        EntityKind::Task
        | EntityKind::Section
        | EntityKind::Comment
        | EntityKind::Activity
        | EntityKind::Attachment => Role::Commenter,
        EntityKind::Project => match &op.change {
            Change::Delete => Role::Owner,
            Change::Set { field, .. } if field == "deleted_at" || field == "archived_at" => {
                Role::Owner
            }
            Change::Set { .. } => Role::Editor,
        },
        _ => Role::Editor,
    }
}

/// `POST /sync/push`: persist a batch idempotently, fold it into LWW state, and fan out ops on
/// shared projects to every co-member's partition and live channel.
pub(super) async fn push(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<PushRequest>,
) -> SyncResult<Json<PushResponse>> {
    let caller = user.user_id;
    let (ops, newest) = check_batch(caller, req.operations)?;

    let mut tx = state.pool.begin().await?;
    // Serialize all sync writes (see [`SYNC_WRITE_LOCK`]).
    take_sync_write_lock(&mut tx).await?;

    // Authorize every op and resolve its fan-out before writing anything.
    let moves = project_moves(&ops);
    let fan_out = authorize(&mut tx, caller, &ops, &moves).await?;
    let tombstones = revoke_moved_tasks(&mut tx, &state, fan_out.revocations).await?;
    let (applied, batches) =
        apply_and_fan_out(&mut tx, caller, &ops, &fan_out.targets, &tombstones).await?;

    // Keep each blob bound to the project its attachment lives in (`attachments::bind_blobs`).
    let attachment_ids: Vec<Uuid> = ops
        .iter()
        .filter(|op| op.entity == EntityKind::Attachment)
        .map(|op| op.entity_id)
        .collect();
    let moved_tasks: Vec<Uuid> = moves.keys().copied().collect();
    if !attachment_ids.is_empty() || !moved_tasks.is_empty() {
        crate::attachments::bind_blobs(&mut tx, caller, &attachment_ids, &moved_tasks, &[]).await?;
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
/// and server-stamp its activities' `actor_id`. Returns the ops and their newest timestamp.
fn check_batch(
    caller: Uuid,
    operations: Vec<Operation>,
) -> SyncResult<(Vec<Operation>, Option<Hlc>)> {
    if operations.len() > MAX_OPS_PER_PUSH {
        return Err(AppError::BadRequest("too many operations in one push".into()).into());
    }
    for op in &operations {
        validate_server_read_field(op)?;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut newest: Option<Hlc> = None;
    for op in &operations {
        // Membership is server-managed.
        if op.entity == EntityKind::ProjectMember {
            return Err(AppError::Forbidden("project_member is server-managed".into()).into());
        }

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

    // Server-stamp an activity's `actor_id` to the caller so it cannot be forged.
    let mut ops = operations;
    for op in &mut ops {
        if let Change::Set { field, value } = &mut op.change {
            if op.entity == EntityKind::Activity && field == "actor_id" {
                *value = Value::String(caller.to_string());
            }
        }
    }
    Ok((ops, newest))
}

/// Where a batch goes beyond the caller's own partition, as [`authorize`] resolved it.
struct FanOut {
    /// Per op, in batch order: the co-members whose partitions receive it.
    targets: Vec<Vec<Uuid>>,
    /// Tasks the batch moves away from members who cannot follow them.
    revocations: Vec<Revocation>,
}

/// Authorize every op of a batch against the caller's project roles and resolve its fan-out.
/// Runs before any of the batch is written, so a refused op fails it whole. `moves` is
/// [`project_moves`] of `ops`.
async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    caller: Uuid,
    ops: &[Operation],
    moves: &HashMap<Uuid, usize>,
) -> AppResult<FanOut> {
    let mut members_cache: HashMap<Uuid, ProjectMembers> = HashMap::new();
    let mut links = Links::new(caller, ops);

    let revoked = still_revoked(tx, &mut members_cache, caller, ops).await?;
    let mut revocations: Vec<Revocation> = Vec::new();
    let mut fan_targets: Vec<Vec<Uuid>> = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let project = project_of(tx, op, &mut links).await?;

        // A task a move took away stays away (see `still_revoked`); its comments are kept.
        if revoked.contains(&op.entity_id)
            && op.entity == EntityKind::Task
            && matches!(op.change, Change::Set { .. })
        {
            return Err(AppError::Forbidden(
                "this task was moved to a project you are not a member of".into(),
            ));
        }

        // An assignee must be an active member of the shared project (or the caller on a
        // private task); null (unassign) is always allowed.
        if op.entity == EntityKind::Task {
            if let Change::Set { field, value } = &op.change {
                if field == "assignee_id" {
                    if let Some(assignee) = as_uuid(value) {
                        let ok = match project {
                            Some(pid) => {
                                let members = project_members(tx, &mut members_cache, pid).await?;
                                if members.is_shared() {
                                    members.active_role(assignee).is_some()
                                } else {
                                    assignee == caller
                                }
                            }
                            None => assignee == caller,
                        };
                        if !ok {
                            return Err(AppError::Forbidden(
                                "assignee must be a project member".into(),
                            ));
                        }
                    }
                }
            }
        }

        let mut targets = Vec::new();
        if let Some(pid) = project {
            let members = project_members(tx, &mut members_cache, pid).await?;
            if members.is_shared() {
                members.require_role(caller, min_role_for_op(op))?;
                targets = members.active_ids();
            }
        }

        // A task moving out of a shared project: the old project's members get the move too,
        // and those who cannot see the new project lose the task, which takes an editor.
        if moves.get(&op.entity_id) == Some(&i) {
            if let Some((Some(old), stored_ts)) =
                stored_project_link(tx, caller, op.entity_id).await?
            {
                if old != project.unwrap_or(Uuid::nil()) && hlc_key(&op.ts)? > stored_ts {
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
                                task_id: op.entity_id,
                                members: left_behind,
                                after: op.ts,
                            });
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
    })
}

/// Record each [`Revocation`] and build the tombstone its members receive: it beats the move
/// and every field its recipients hold, and the recorded revocation keeps it hidden from what
/// they write later.
async fn revoke_moved_tasks(
    tx: &mut Transaction<'_, Postgres>,
    state: &AppState,
    revocations: Vec<Revocation>,
) -> AppResult<Vec<(Vec<Uuid>, Operation)>> {
    let (revoked_users, revoked_tasks): (Vec<Uuid>, Vec<Uuid>) = revocations
        .iter()
        .flat_map(|rev| rev.members.iter().map(|member| (*member, rev.task_id)))
        .unzip();
    if !revoked_users.is_empty() {
        sqlx::query(
            "INSERT INTO revoked_tasks (user_id, task_id)
             SELECT * FROM UNNEST($1::uuid[], $2::uuid[])
             ON CONFLICT (user_id, task_id) DO NOTHING",
        )
        .bind(&revoked_users)
        .bind(&revoked_tasks)
        .execute(&mut **tx)
        .await?;
    }
    let mut revoke_ops: Vec<(Vec<Uuid>, Operation)> = Vec::with_capacity(revocations.len());
    for rev in revocations {
        let mut floor = rev.after;
        if let Some((wall, counter, node)) =
            newest_task_field(tx, &rev.members, rev.task_id).await?
        {
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
            Operation::delete(EntityKind::Task, rev.task_id, ts),
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
    ops: &[Operation],
    targets: &[Vec<Uuid>],
    tombstones: &[(Vec<Uuid>, Operation)],
) -> AppResult<(usize, MemberBatches)> {
    let caller_rows: Vec<(Uuid, &Operation)> = ops.iter().map(|op| (caller, op)).collect();
    let (caller_seqs, mut batches) = apply_live(tx, &caller_rows).await?;
    let applied = caller_seqs.iter().filter(|seq| seq.is_some()).count();
    let mut member_rows: Vec<(Uuid, &Operation)> = ops
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
    use crate::sync::entity_from_str;

    const PLAINTEXT_FIELDS_JSON: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test-vectors/plaintext_fields.json"
    ));

    #[test]
    fn every_server_read_field_is_plaintext_on_the_client() {
        let doc: Value = serde_json::from_str(PLAINTEXT_FIELDS_JSON).unwrap();
        let table = &doc["plaintext_fields"];
        for (entity, fields) in SERVER_READ_FIELDS {
            entity_from_str(entity).unwrap_or_else(|_| panic!("unknown entity {entity}"));
            let listed = &table[*entity];
            for (field, _) in *fields {
                let plaintext = listed == "all"
                    || listed
                        .as_array()
                        .is_some_and(|a| a.iter().any(|f| f == *field));
                assert!(
                    plaintext,
                    "{entity}.{field} is read by the server but plaintext_fields.json lets the \
                     client encrypt it"
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
        // A field matched by name only (never by value), or handed back to the client verbatim.
        const NOT_INTERPRETED: &[&str] =
            &["deleted_at", "archived_at", "name", "icon", "color", "kind"];
        let sources = [
            include_str!("mod.rs"),
            include_str!("apply.rs"),
            include_str!("backfill.rs"),
            include_str!("hub.rs"),
            include_str!("pull.rs"),
            include_str!("push.rs"),
            include_str!("revoke.rs"),
            include_str!("snapshot.rs"),
            include_str!("ws.rs"),
            include_str!("../members.rs"),
            include_str!("../attachments.rs"),
            include_str!("../restore.rs"),
            include_str!("../projects.rs"),
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
        assert!(seen.contains(&"project_id") && seen.contains(&"blob_sha"));
        for field in seen {
            let listed = SERVER_READ_FIELDS
                .iter()
                .any(|(_, fields)| fields.iter().any(|(f, _)| *f == field));
            assert!(
                listed || NOT_INTERPRETED.contains(&field),
                "the server reads `{field}`; add it to SERVER_READ_FIELDS"
            );
        }
    }
}
