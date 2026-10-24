//! Rows written before sync protocol 7, which a push can no longer create: the legacy read paths
//! (revocation, backfill, attachments, invite previews, retention) are tested on rows seeded
//! straight into a partition, as a protocol 6 client left them.

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

/// Write `field` = `value` of the legacy `entity` (a real kind name, like `task`) into `user`'s op
/// log and field state at HLC `(wall, 0, node)`. Returns the op's `server_seq`.
pub async fn seed_legacy(
    pool: &PgPool,
    user: Uuid,
    entity: &str,
    entity_id: Uuid,
    field: &str,
    value: Value,
    wall: i64,
) -> i64 {
    let node = Uuid::now_v7();
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO operations
             (op_id, user_id, entity, entity_id, field, value, is_delete,
              hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, 0, $8)
         RETURNING server_seq",
    )
    .bind(Uuid::now_v7())
    .bind(user)
    .bind(entity)
    .bind(entity_id)
    .bind(field)
    .bind(&value)
    .bind(wall)
    .bind(node)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO entity_fields
             (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
         ON CONFLICT (user_id, entity, entity_id, field) DO UPDATE
            SET value = EXCLUDED.value, hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                hlc_counter = 0, hlc_node = EXCLUDED.hlc_node",
    )
    .bind(user)
    .bind(entity)
    .bind(entity_id)
    .bind(field)
    .bind(&value)
    .bind(wall)
    .bind(node)
    .execute(pool)
    .await
    .unwrap();
    seq
}

/// Apply protocol 6 ops (`{entity, entity_id, op, field?, value?, ts}`, real kind names) to each
/// of `partitions` in order, as that server did after authorizing a push: the pusher's partition
/// first (the lowest `server_seq` names the author), then the members it fanned out to. Fields and
/// tombstones fold last-writer-wins.
pub async fn legacy_push(pool: &PgPool, partitions: &[Uuid], ops: &[Value]) {
    for user in partitions {
        for op in ops {
            let entity = op["entity"].as_str().unwrap();
            let entity_id: Uuid = op["entity_id"].as_str().unwrap().parse().unwrap();
            let wall = op["ts"]["wall_ms"].as_i64().unwrap();
            let counter = op["ts"]["counter"].as_i64().unwrap() as i32;
            let node: Uuid = op["ts"]["node"].as_str().unwrap().parse().unwrap();
            let is_delete = op["op"] == "delete";
            let field = op["field"].as_str();
            let value = (!is_delete).then(|| op["value"].clone());
            sqlx::query(
                "INSERT INTO operations
                     (op_id, user_id, entity, entity_id, field, value, is_delete,
                      hlc_wall_ms, hlc_counter, hlc_node)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(Uuid::now_v7())
            .bind(user)
            .bind(entity)
            .bind(entity_id)
            .bind(field)
            .bind(&value)
            .bind(is_delete)
            .bind(wall)
            .bind(counter)
            .bind(node)
            .execute(pool)
            .await
            .unwrap();
            if is_delete {
                sqlx::query(
                    "INSERT INTO entity_tombstones
                         (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (user_id, entity, entity_id) DO UPDATE
                        SET hlc_wall_ms = EXCLUDED.hlc_wall_ms, hlc_counter = EXCLUDED.hlc_counter,
                            hlc_node = EXCLUDED.hlc_node, received_at = now()
                      WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                          > (entity_tombstones.hlc_wall_ms, entity_tombstones.hlc_counter,
                             entity_tombstones.hlc_node)",
                )
                .bind(user)
                .bind(entity)
                .bind(entity_id)
                .bind(wall)
                .bind(counter)
                .bind(node)
                .execute(pool)
                .await
                .unwrap();
            } else {
                sqlx::query(
                    "INSERT INTO entity_fields
                         (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter,
                          hlc_node)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (user_id, entity, entity_id, field) DO UPDATE
                        SET value = EXCLUDED.value, hlc_wall_ms = EXCLUDED.hlc_wall_ms,
                            hlc_counter = EXCLUDED.hlc_counter, hlc_node = EXCLUDED.hlc_node
                      WHERE (EXCLUDED.hlc_wall_ms, EXCLUDED.hlc_counter, EXCLUDED.hlc_node)
                          > (entity_fields.hlc_wall_ms, entity_fields.hlc_counter,
                             entity_fields.hlc_node)",
                )
                .bind(user)
                .bind(entity)
                .bind(entity_id)
                .bind(field)
                .bind(&value)
                .bind(wall)
                .bind(counter)
                .bind(node)
                .execute(pool)
                .await
                .unwrap();
            }
        }
    }
}

/// Record `user` as `project`'s creator, as the protocol 7 migration does for a legacy project.
pub async fn record_creator(pool: &PgPool, project: Uuid, user: Uuid) {
    sqlx::query(
        "INSERT INTO project_creators (project_id, user_id) VALUES ($1, $2)
         ON CONFLICT (project_id) DO NOTHING",
    )
    .bind(project)
    .bind(user)
    .execute(pool)
    .await
    .unwrap();
}
