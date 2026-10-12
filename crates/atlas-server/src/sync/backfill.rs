//! The accept backfill: a shared project copied from its owner's partition into a new member's,
//! with fields their old tombstones would hide rewritten above them.

use std::collections::{HashMap, HashSet};

use atlas_core::{Change, Hlc, Operation};
use sqlx::{PgConnection, Postgres, Transaction};
use uuid::Uuid;

use super::apply::partition_heads;
use super::revoke::project_keys;
use super::snapshot::keys_ops;
use super::{entity_str, successor_hlc, EntityKey};
use crate::error::AppResult;

async fn keys_ops_by_key(
    conn: &mut PgConnection,
    user: Uuid,
    keys: &[EntityKey],
) -> AppResult<HashMap<EntityKey, Vec<Operation>>> {
    let mut by_key: HashMap<EntityKey, Vec<Operation>> = HashMap::new();
    for op in keys_ops(conn, user, keys).await? {
        by_key
            .entry((entity_str(op.entity).to_string(), op.entity_id))
            .or_default()
            .push(op);
    }
    Ok(by_key)
}

/// The newest tombstone `member` holds for each of `keys`. The project's Delete ops are read
/// from the op log too, since retention may have purged the tombstone row a device still holds.
async fn member_floors(
    conn: &mut PgConnection,
    member: Uuid,
    project_id: Uuid,
    keys: &[EntityKey],
) -> AppResult<HashMap<EntityKey, Hlc>> {
    let entities: Vec<&str> = keys.iter().map(|(e, _)| e.as_str()).collect();
    let ids: Vec<Uuid> = keys.iter().map(|(_, id)| *id).collect();
    let project_key = ("project".to_string(), project_id);
    let rows: Vec<(String, Uuid, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT t.entity, t.entity_id, t.hlc_wall_ms, t.hlc_counter, t.hlc_node
           FROM UNNEST($2::text[], $3::uuid[]) AS k(entity, entity_id)
           JOIN entity_tombstones t
             ON t.user_id = $1 AND t.entity = k.entity AND t.entity_id = k.entity_id
         UNION ALL
         SELECT entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node FROM operations
          WHERE $5 AND user_id = $1 AND entity = 'project' AND entity_id = $4 AND is_delete",
    )
    .bind(member)
    .bind(&entities)
    .bind(&ids)
    .bind(project_id)
    .bind(keys.contains(&project_key))
    .fetch_all(&mut *conn)
    .await?;
    let mut floors: HashMap<EntityKey, Hlc> = HashMap::new();
    for (entity, entity_id, wall, counter, node) in rows {
        let ts = Hlc {
            wall_ms: wall as u64,
            counter: counter as u32,
            node,
        };
        let floor = floors.entry((entity, entity_id)).or_insert(ts);
        *floor = (*floor).max(ts);
    }
    Ok(floors)
}

async fn keys_written_since(
    conn: &mut PgConnection,
    user: Uuid,
    head: i64,
) -> AppResult<HashSet<EntityKey>> {
    let rows: Vec<EntityKey> = sqlx::query_as(
        "SELECT DISTINCT entity, entity_id FROM operations WHERE user_id = $1 AND server_seq > $2",
    )
    .bind(user)
    .bind(head)
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// What [`accept_backfill_ops`] builds from: `owner`'s copy of the project and `member`'s
/// tombstones for it.
pub(crate) struct BackfillRead {
    owner: Uuid,
    member: Uuid,
    project_id: Uuid,
    owner_head: i64,
    member_head: i64,
    keys: Vec<EntityKey>,
    ops: HashMap<EntityKey, Vec<Operation>>,
    floors: HashMap<EntityKey, Hlc>,
}

impl BackfillRead {
    /// Read on `conn`, whose transaction must see one snapshot, so the heads mark exactly what
    /// the read saw. Ops it missed have a higher seq than the head it read.
    pub(crate) async fn read(
        conn: &mut PgConnection,
        owner: Uuid,
        member: Uuid,
        project_id: Uuid,
    ) -> AppResult<Self> {
        let heads = partition_heads(conn, &[owner, member]).await?;
        let keys = project_keys(conn, owner, project_id).await?;
        let ops = keys_ops_by_key(conn, owner, &keys).await?;
        let floors = member_floors(conn, member, project_id, &keys).await?;
        Ok(Self {
            owner,
            member,
            project_id,
            owner_head: heads.get(&owner).copied().unwrap_or(0),
            member_head: heads.get(&member).copied().unwrap_or(0),
            keys,
            ops,
            floors,
        })
    }

    /// [`BackfillRead::read`] in its own read-only snapshot transaction without
    /// [`SYNC_WRITE_LOCK`](super::SYNC_WRITE_LOCK), so copying a large project does not block
    /// pushes.
    pub(crate) async fn read_unlocked(
        pool: &sqlx::PgPool,
        owner: Uuid,
        member: Uuid,
        project_id: Uuid,
    ) -> AppResult<Self> {
        let mut tx = pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        let read = Self::read(&mut tx, owner, member, project_id).await?;
        tx.commit().await?;
        Ok(read)
    }

    pub(crate) fn owner(&self) -> Uuid {
        self.owner
    }
}

/// The accept backfill for `member`: `owner`'s copy of the project, plus each field that copy
/// shows but a tombstone in `member`'s partition hides, rewritten just above that tombstone
/// ([`successor_hlc`]).
///
/// `read` may be older than `tx`, which holds [`SYNC_WRITE_LOCK`](super::SYNC_WRITE_LOCK): keys
/// written since the read's heads, and the key set itself when the owner's partition changed,
/// are read again.
pub(crate) async fn accept_backfill_ops(
    tx: &mut Transaction<'_, Postgres>,
    read: BackfillRead,
) -> AppResult<Vec<Operation>> {
    let BackfillRead {
        owner,
        member,
        project_id,
        owner_head,
        member_head,
        keys,
        mut ops,
        mut floors,
    } = read;
    let owner_changed = keys_written_since(tx, owner, owner_head).await?;
    let member_changed = keys_written_since(tx, member, member_head).await?;
    let keys = if owner_changed.is_empty() && member_changed.is_empty() {
        keys
    } else {
        let read_keys: HashSet<EntityKey> = keys.iter().cloned().collect();
        let keys = if owner_changed.is_empty() {
            keys
        } else {
            project_keys(tx, owner, project_id).await?
        };
        let reread: Vec<EntityKey> = keys
            .iter()
            .filter(|k| owner_changed.contains(*k) || !read_keys.contains(*k))
            .cloned()
            .collect();
        if !reread.is_empty() {
            for key in &reread {
                ops.remove(key);
            }
            ops.extend(keys_ops_by_key(tx, owner, &reread).await?);
        }
        let reread: HashSet<EntityKey> = reread.into_iter().collect();
        let refloor: Vec<EntityKey> = keys
            .iter()
            .filter(|k| member_changed.contains(*k) || reread.contains(*k))
            .cloned()
            .collect();
        if !refloor.is_empty() {
            for key in &refloor {
                floors.remove(key);
            }
            floors.extend(member_floors(tx, member, project_id, &refloor).await?);
        }
        keys
    };

    let mut out: Vec<Operation> = Vec::new();
    for key in &keys {
        if let Some(key_ops) = ops.remove(key) {
            out.extend(key_ops);
        }
    }
    let owner_tombs: HashMap<EntityKey, Hlc> = out
        .iter()
        .filter(|op| matches!(op.change, Change::Delete))
        .map(|op| ((entity_str(op.entity).to_string(), op.entity_id), op.ts))
        .collect();
    let mut rewrites = Vec::new();
    for op in &out {
        let Change::Set { field, value } = &op.change else {
            continue;
        };
        let key = (entity_str(op.entity).to_string(), op.entity_id);
        let Some(&floor) = floors.get(&key) else {
            continue;
        };
        let shown = owner_tombs.get(&key).is_none_or(|tomb| op.ts > *tomb);
        if shown && op.ts <= floor {
            rewrites.push(Operation::set(
                op.entity,
                op.entity_id,
                field,
                value.clone(),
                successor_hlc(floor),
            ));
        }
    }
    out.extend(rewrites);
    Ok(out)
}
