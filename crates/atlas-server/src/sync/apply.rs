//! The write path every sync write shares: ops folded into partitions as live batches published
//! after commit, and the server-authored membership ops.

use std::collections::HashMap;

use atlas_core::{Change, WireKind, WireOperation};
use serde_json::{json, Value};
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use super::hub::SyncHub;
use super::{begin_sync_write, entity_str, hlc_key, server_ts, HlcKey, PullResponse};
use crate::error::AppResult;
use crate::state::AppState;

/// Insert `(partition, op)` rows idempotently (on `(user_id, op_id)`) and fold the new ones into
/// each partition's LWW state, and each sealed entity's scope into `entity_scopes` (the scope of
/// its newest op). Returns each row's `server_seq`, or `None` for a duplicate. Shared by push and
/// the server-authored fan-out.
///
/// Callers hold [`SYNC_WRITE_LOCK`](super::SYNC_WRITE_LOCK), so this is a few multi-row
/// statements whatever the batch size. Folding is order-independent, so new rows are
/// pre-reduced to one winner per key (an upsert may not touch a row twice). Seqs follow row
/// order.
async fn apply_rows(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &WireOperation)],
) -> AppResult<Vec<Option<i64>>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let n = rows.len();
    let (mut users, mut op_ids, mut entities, mut entity_ids) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut fields, mut values, mut deletes) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut walls, mut counters, mut nodes) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut scopes, mut pushers) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for (user, op) in rows {
        let (wall, counter, node) = hlc_key(&op.ts)?;
        users.push(*user);
        op_ids.push(op.id);
        entities.push(entity_str(op.entity));
        entity_ids.push(op.entity_id);
        match &op.change {
            Change::Set { field, value } => {
                fields.push(Some(field.as_str()));
                values.push(Some(value.clone()));
                deletes.push(false);
            }
            Change::Delete => {
                fields.push(None);
                values.push(None);
                deletes.push(true);
            }
        }
        walls.push(wall);
        counters.push(counter);
        nodes.push(node);
        scopes.push(op.scope);
        pushers.push(op.pushed_by);
    }

    let inserted: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "INSERT INTO operations
            (op_id, user_id, entity, entity_id, field, value, is_delete,
             hlc_wall_ms, hlc_counter, hlc_node, scope, pushed_by)
         SELECT op_id, user_id, entity, entity_id, field, value, is_delete, wall, counter, node,
                scope, pushed_by
           FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::uuid[], $5::text[], $6::jsonb[],
                       $7::bool[], $8::int8[], $9::int4[], $10::uuid[], $11::uuid[], $12::uuid[])
                WITH ORDINALITY
                AS r(op_id, user_id, entity, entity_id, field, value, is_delete,
                     wall, counter, node, scope, pushed_by, ord)
          ORDER BY ord
         ON CONFLICT (user_id, op_id) DO NOTHING
         RETURNING user_id, op_id, server_seq",
    )
    .bind(&op_ids)
    .bind(&users)
    .bind(&entities)
    .bind(&entity_ids)
    .bind(&fields)
    .bind(&values)
    .bind(&deletes)
    .bind(&walls)
    .bind(&counters)
    .bind(&nodes)
    .bind(&scopes)
    .bind(&pushers)
    .fetch_all(&mut **tx)
    .await?;

    let mut new_seqs: HashMap<(Uuid, Uuid), i64> = inserted
        .into_iter()
        .map(|(user, op_id, seq)| ((user, op_id), seq))
        .collect();
    let seqs: Vec<Option<i64>> = rows
        .iter()
        .map(|(user, op)| new_seqs.remove(&(*user, op.id)))
        .collect();

    // The first account to write a project is its creator (`members::is_project_creator`). Rows
    // follow seq order, so the first new row of a project is the earliest; a project already
    // recorded keeps its creator.
    let mut created: Vec<(Uuid, Uuid)> = Vec::new();
    for ((user, op), seq) in rows.iter().zip(&seqs) {
        if seq.is_some()
            && op.entity == WireKind::TodoProject
            && !created.iter().any(|(pid, _)| *pid == op.entity_id)
        {
            created.push((op.entity_id, *user));
        }
    }
    if !created.is_empty() {
        let (pids, creators): (Vec<Uuid>, Vec<Uuid>) = created.into_iter().unzip();
        sqlx::query(
            "INSERT INTO project_creators (project_id, user_id)
             SELECT * FROM UNNEST($1::uuid[], $2::uuid[])
             ON CONFLICT (project_id) DO NOTHING",
        )
        .bind(&pids)
        .bind(&creators)
        .execute(&mut **tx)
        .await?;
    }

    type FieldKey<'a> = (Uuid, &'static str, Uuid, &'a str);
    type FieldWin<'a> = (HlcKey, &'a Value, Option<Uuid>, Option<Uuid>);
    let mut field_wins: HashMap<FieldKey, FieldWin> = HashMap::new();
    let mut tomb_wins: HashMap<(Uuid, &'static str, Uuid), HlcKey> = HashMap::new();
    let mut scope_wins: HashMap<(Uuid, &'static str, Uuid), (HlcKey, Option<Uuid>)> =
        HashMap::new();
    for (i, (user, op)) in rows.iter().enumerate() {
        if seqs[i].is_none() {
            continue;
        }
        let ts = (walls[i], counters[i], nodes[i]);
        let entity = entity_str(op.entity);
        match &op.change {
            Change::Set { field, value } => {
                let key = (*user, entity, op.entity_id, field.as_str());
                match field_wins.get(&key) {
                    Some((best, ..)) if *best >= ts => {}
                    _ => {
                        field_wins.insert(key, (ts, value, op.scope, op.pushed_by));
                    }
                }
                if op.entity == WireKind::TodoSealed {
                    let key = (*user, entity, op.entity_id);
                    match scope_wins.get(&key) {
                        Some((best, _)) if *best >= ts => {}
                        _ => {
                            scope_wins.insert(key, (ts, op.scope));
                        }
                    }
                }
            }
            Change::Delete => {
                let key = (*user, entity, op.entity_id);
                match tomb_wins.get(&key) {
                    Some(best) if *best >= ts => {}
                    _ => {
                        tomb_wins.insert(key, ts);
                    }
                }
            }
        }
    }

    if !field_wins.is_empty() {
        let n = field_wins.len();
        let (mut u, mut e, mut id, mut f, mut v) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut w, mut c, mut nd) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut sc, mut by) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for ((user, entity, entity_id, field), ((wall, counter, node), value, scope, pushed_by)) in
            field_wins
        {
            u.push(user);
            e.push(entity);
            id.push(entity_id);
            f.push(field);
            v.push(value.clone());
            w.push(wall);
            c.push(counter);
            nd.push(node);
            sc.push(scope);
            by.push(pushed_by);
        }
        sqlx::query(
            "INSERT INTO entity_fields
                (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node,
                 scope, pushed_by)
             SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::jsonb[],
                                  $6::int8[], $7::int4[], $8::uuid[], $9::uuid[], $10::uuid[])
             ON CONFLICT (user_id, entity, entity_id, field) DO UPDATE
                SET value = EXCLUDED.value,
                    hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                    hlc_counter = EXCLUDED.hlc_counter,
                    hlc_node = EXCLUDED.hlc_node,
                    scope = EXCLUDED.scope,
                    pushed_by = EXCLUDED.pushed_by
              WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                  > (entity_fields.hlc_wall_ms, entity_fields.hlc_counter, entity_fields.hlc_node)",
        )
        .bind(&u)
        .bind(&e)
        .bind(&id)
        .bind(&f)
        .bind(&v)
        .bind(&w)
        .bind(&c)
        .bind(&nd)
        .bind(&sc)
        .bind(&by)
        .execute(&mut **tx)
        .await?;
    }

    if !scope_wins.is_empty() {
        let n = scope_wins.len();
        let (mut u, mut e, mut id, mut sc) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut w, mut c, mut nd) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for ((user, entity, entity_id), ((wall, counter, node), scope)) in scope_wins {
            u.push(user);
            e.push(entity);
            id.push(entity_id);
            sc.push(scope);
            w.push(wall);
            c.push(counter);
            nd.push(node);
        }
        sqlx::query(
            "INSERT INTO entity_scopes
                (user_id, entity, entity_id, scope, hlc_wall_ms, hlc_counter, hlc_node)
             SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[], $4::uuid[],
                                  $5::int8[], $6::int4[], $7::uuid[])
             ON CONFLICT (user_id, entity, entity_id) DO UPDATE
                SET scope = EXCLUDED.scope,
                    hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                    hlc_counter = EXCLUDED.hlc_counter,
                    hlc_node = EXCLUDED.hlc_node
              WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                  > (entity_scopes.hlc_wall_ms, entity_scopes.hlc_counter, entity_scopes.hlc_node)",
        )
        .bind(&u)
        .bind(&e)
        .bind(&id)
        .bind(&sc)
        .bind(&w)
        .bind(&c)
        .bind(&nd)
        .execute(&mut **tx)
        .await?;
    }

    if !tomb_wins.is_empty() {
        let n = tomb_wins.len();
        let (mut u, mut e, mut id) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let (mut w, mut c, mut nd) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        for ((user, entity, entity_id), (wall, counter, node)) in tomb_wins {
            u.push(user);
            e.push(entity);
            id.push(entity_id);
            w.push(wall);
            c.push(counter);
            nd.push(node);
        }
        sqlx::query(
            "INSERT INTO entity_tombstones
                (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node)
             SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::uuid[],
                                  $4::int8[], $5::int4[], $6::uuid[])
             ON CONFLICT (user_id, entity, entity_id) DO UPDATE
                SET hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                    hlc_counter = EXCLUDED.hlc_counter,
                    hlc_node = EXCLUDED.hlc_node,
                    received_at = now()
              WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                  > (entity_tombstones.hlc_wall_ms, entity_tombstones.hlc_counter,
                     entity_tombstones.hlc_node)",
        )
        .bind(&u)
        .bind(&e)
        .bind(&id)
        .bind(&w)
        .bind(&c)
        .bind(&nd)
        .execute(&mut **tx)
        .await?;
    }
    Ok(seqs)
}

/// Deterministic entity id for a `(project, user)` membership, so re-authoring converges.
pub(crate) fn member_entity_id(project_id: Uuid, user_id: Uuid) -> Uuid {
    const MEMBER_NAMESPACE: Uuid = Uuid::from_u128(0x4d35_5f70_726f_6a5f_6d65_6d62_6572_0001);
    Uuid::new_v5(
        &MEMBER_NAMESPACE,
        format!("{project_id}:{user_id}").as_bytes(),
    )
}

/// The field-set ops describing one membership, for the client's collaborator list.
#[allow(clippy::too_many_arguments)]
pub(crate) fn member_set_ops(
    state: &AppState,
    project_id: Uuid,
    user_id: Uuid,
    email: &str,
    display_name: &str,
    role: &str,
    member_state: &str,
    deletion_scheduled: bool,
) -> Vec<WireOperation> {
    let eid = member_entity_id(project_id, user_id);
    let field = |name: &str, value: Value| {
        WireOperation::set(
            WireKind::ProjectMember,
            eid,
            None,
            name,
            value,
            server_ts(state),
        )
    };
    vec![
        field("project_id", json!(project_id.to_string())),
        field("user_id", json!(user_id.to_string())),
        field("email", json!(email)),
        field("display_name", json!(display_name)),
        field("role", json!(role)),
        field("state", json!(member_state)),
        field("deletion_scheduled", json!(deletion_scheduled)),
    ]
}

pub(crate) fn member_delete_op(state: &AppState, project_id: Uuid, user_id: Uuid) -> WireOperation {
    WireOperation::delete(
        WireKind::ProjectMember,
        member_entity_id(project_id, user_id),
        None,
        server_ts(state),
    )
}

/// The ops one transaction newly applied to one partition, as a live payload: exactly the
/// partition's seqs in `(from, cursor]` thanks to [`SYNC_WRITE_LOCK`](super::SYNC_WRITE_LOCK).
#[derive(Debug)]
pub(crate) struct LiveBatch {
    pub ops: Vec<WireOperation>,
    pub from: i64,
    pub cursor: i64,
}

impl LiveBatch {
    pub(super) fn publish(self, hub: &SyncHub, user: Uuid) {
        hub.publish(
            user,
            PullResponse {
                operations: self.ops,
                cursor: self.cursor,
                from: self.from,
            },
        );
    }
}

pub(crate) type MemberBatches = HashMap<Uuid, LiveBatch>;

/// The heads of `users`' partitions, read before a write transaction touches them.
pub(super) async fn partition_heads(
    conn: &mut PgConnection,
    users: &[Uuid],
) -> AppResult<HashMap<Uuid, i64>> {
    let rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT u.id, COALESCE((SELECT MAX(server_seq) FROM operations WHERE user_id = u.id), 0)
           FROM UNNEST($1::uuid[]) AS u(id)",
    )
    .bind(users)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Apply `(partition, op)` rows and gather the new ones into per-partition live batches.
pub(super) async fn apply_live(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &WireOperation)],
) -> AppResult<(Vec<Option<i64>>, MemberBatches)> {
    let mut users: Vec<Uuid> = rows.iter().map(|(user, _)| *user).collect();
    users.sort_unstable();
    users.dedup();
    let heads = partition_heads(tx, &users).await?;
    let seqs = apply_rows(tx, rows).await?;
    let mut batches = MemberBatches::new();
    for ((user, op), seq) in rows.iter().zip(&seqs) {
        let Some(seq) = seq else { continue };
        let from = heads.get(user).copied().unwrap_or(0);
        let batch = batches.entry(*user).or_insert_with(|| LiveBatch {
            ops: Vec::new(),
            from,
            cursor: from,
        });
        batch.ops.push((*op).clone());
        batch.cursor = batch.cursor.max(*seq);
    }
    Ok((seqs, batches))
}

/// Apply server-authored ops to each member's partition; the caller publishes after commit.
pub(crate) async fn apply_to_members(
    tx: &mut Transaction<'_, Postgres>,
    members: &[Uuid],
    ops: &[WireOperation],
) -> AppResult<MemberBatches> {
    let rows: Vec<(Uuid, &WireOperation)> = members
        .iter()
        .flat_map(|member| ops.iter().map(move |op| (*member, op)))
        .collect();
    apply_to_partitions(tx, &rows).await
}

/// Like [`apply_to_members`], for callers whose partitions receive different ops.
pub(crate) async fn apply_to_partitions(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[(Uuid, &WireOperation)],
) -> AppResult<MemberBatches> {
    Ok(apply_live(tx, rows).await?.1)
}

pub(crate) async fn deliver_to_members(
    state: &AppState,
    members: &[Uuid],
    ops: &[WireOperation],
) -> AppResult<()> {
    if members.is_empty() || ops.is_empty() {
        return Ok(());
    }
    // Same serialization as push: this inserts into `operations` and hands out cursors.
    let mut tx = begin_sync_write(&state.pool).await?;
    let batches = apply_to_members(&mut tx, members, ops).await?;
    tx.commit().await?;
    publish_batches(state, batches);
    Ok(())
}

pub(crate) fn publish_batches(state: &AppState, batches: MemberBatches) {
    for (member, batch) in batches {
        batch.publish(&state.hub, member);
    }
}
