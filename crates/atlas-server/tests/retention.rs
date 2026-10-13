//! Integration tests for operation-log retention (`retention::purge_once`).
//!
//! Retention must be inert by default (days <= 0 is a no-op) because purging the log breaks every
//! device that bootstraps by replaying from `since=0`; and even when enabled it must keep project
//! entity ops (ownership bootstrap reads the earliest `project` op) and always remove stale
//! tombstones together with the tombstoned entity's field rows.

use atlas_server::{config::Config, db, retention, state::AppState};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://atlas:atlas@127.0.0.1:5432/atlas_test".into())
}

async fn pool() -> PgPool {
    let pool = db::connect(&test_database_url()).await.expect("connect");
    db::migrate(&pool).await.expect("migrate");
    pool
}

/// A minimal real user row to satisfy the FK on sync tables.
async fn insert_user(pool: &PgPool) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(id)
        .bind(format!("ret-{}@example.com", id))
        .execute(pool)
        .await
        .unwrap();
    id
}

/// One `title` Set op row, committed `age_days` days ago; returns its server_seq.
async fn insert_op(pool: &PgPool, user: Uuid, entity: &str, age_days: i64) -> i64 {
    let entity_id = Uuid::now_v7();
    sqlx::query_scalar(
        "INSERT INTO operations
            (op_id, user_id, entity, entity_id, field, value, is_delete, hlc_wall_ms, hlc_counter, hlc_node, created_at)
         VALUES ($1, $2, $3, $4, 'title', 'null'::jsonb, FALSE, 1, 0, $5, now() - make_interval(days => $6))
         RETURNING server_seq",
    )
    .bind(Uuid::now_v7())
    .bind(user)
    .bind(entity)
    .bind(entity_id)
    .bind(Uuid::now_v7())
    .bind(age_days as i32)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_field(
    pool: &PgPool,
    user: Uuid,
    entity: &str,
    entity_id: Uuid,
    field: &str,
    wall_ms: i64,
) {
    sqlx::query(
        "INSERT INTO entity_fields
            (user_id, entity, entity_id, field, value, hlc_wall_ms, hlc_counter, hlc_node)
         VALUES ($1, $2, $3, $4, 'null'::jsonb, $5, 0, $6)",
    )
    .bind(user)
    .bind(entity)
    .bind(entity_id)
    .bind(field)
    .bind(wall_ms)
    .bind(Uuid::now_v7())
    .execute(pool)
    .await
    .unwrap();
}

/// A tombstone with HLC `wall_ms`, received by the server `received_days_ago` days ago.
async fn insert_tombstone(
    pool: &PgPool,
    user: Uuid,
    entity: &str,
    entity_id: Uuid,
    wall_ms: i64,
    received_days_ago: i64,
) {
    sqlx::query(
        "INSERT INTO entity_tombstones
            (user_id, entity, entity_id, hlc_wall_ms, hlc_counter, hlc_node, received_at)
         VALUES ($1, $2, $3, $4, 0, $5, now() - make_interval(days => $6))",
    )
    .bind(user)
    .bind(entity)
    .bind(entity_id)
    .bind(wall_ms)
    .bind(Uuid::now_v7())
    .bind(received_days_ago as i32)
    .execute(pool)
    .await
    .unwrap();
}

/// The fields stored for one entity, by name.
async fn field_names(pool: &PgPool, user: Uuid, entity_id: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT field FROM entity_fields WHERE user_id = $1 AND entity_id = $2 ORDER BY field",
    )
    .bind(user)
    .bind(entity_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn has_tombstone(pool: &PgPool, user: Uuid, entity_id: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM entity_tombstones WHERE user_id = $1 AND entity_id = $2)",
    )
    .bind(user)
    .bind(entity_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn op_count(pool: &PgPool, user: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM operations WHERE user_id = $1")
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tokio::test]
async fn purge_with_zero_days_is_a_noop() {
    let pool = pool().await;
    let user = insert_user(&pool).await;
    insert_op(&pool, user, "task", 400).await;

    let stats = retention::purge_once(&pool, 0).await.unwrap();
    assert_eq!(
        stats,
        retention::PurgeStats::default(),
        "disabled purge removes nothing"
    );
    assert_eq!(
        op_count(&pool, user).await,
        1,
        "rows survive the default config"
    );
    // Negative values are equally disabled.
    let stats = retention::purge_once(&pool, -5).await.unwrap();
    assert_eq!(stats, retention::PurgeStats::default());
    assert_eq!(op_count(&pool, user).await, 1);
}

#[tokio::test]
async fn retention_task_not_spawned_when_disabled() {
    let pool = PgPoolOptions::new()
        .connect_lazy(&test_database_url())
        .unwrap();
    let config = Config {
        database_url: test_database_url(),
        jwt_secret: b"integration-test-secret-32-bytes-x".to_vec(),
        access_ttl_seconds: 900,
        refresh_ttl_seconds: 3600,
        port: 8080,
        admin_emails: Vec::new(),
        signup_enabled: true,
        bug_reports_enabled: true,
        op_retention_days: 0,
        max_push_bytes: 2 * 1024 * 1024,
        refresh_token_retention_days: 0,
        attachments_enabled: false,
        blob_backend: atlas_server::config::BlobBackend::Fs,
        blob_dir: None,
        max_blob_bytes: 25 * 1024 * 1024,
        blob_quota_bytes: 1024 * 1024 * 1024,
        blob_gc_grace_days: 7,
        max_blob_transfers: 16,
        apps: vec!["todo".into()],
        passkeys: None,
        android_asset_links: None,
        static_dir: None,
    };
    let state = AppState::new(pool, config);
    assert!(
        retention::spawn_if_enabled(&state).is_none(),
        "a config with both purges disabled must not start the task"
    );
}

#[tokio::test]
async fn retention_task_spawns_for_token_purge_alone() {
    // The token purge is on by default (the tokens are useless after expiry), so token retention
    // alone — with op retention still off — is enough to start the task.
    let pool = PgPoolOptions::new()
        .connect_lazy(&test_database_url())
        .unwrap();
    let config = Config {
        database_url: test_database_url(),
        jwt_secret: b"integration-test-secret-32-bytes-x".to_vec(),
        access_ttl_seconds: 900,
        refresh_ttl_seconds: 3600,
        port: 8080,
        admin_emails: Vec::new(),
        signup_enabled: true,
        bug_reports_enabled: true,
        op_retention_days: 0,
        max_push_bytes: 2 * 1024 * 1024,
        refresh_token_retention_days: 30,
        attachments_enabled: false,
        blob_backend: atlas_server::config::BlobBackend::Fs,
        blob_dir: None,
        max_blob_bytes: 25 * 1024 * 1024,
        blob_quota_bytes: 1024 * 1024 * 1024,
        blob_gc_grace_days: 7,
        max_blob_transfers: 16,
        apps: vec!["todo".into()],
        passkeys: None,
        android_asset_links: None,
        static_dir: None,
    };
    let state = AppState::new(pool, config);
    let handle = retention::spawn_if_enabled(&state);
    assert!(
        handle.is_some(),
        "token retention alone starts the purge task"
    );
    handle.unwrap().abort(); // never awaited: the task must not outlive the test's pool
}

/// Tombstones that must survive a purge in some form. A purge must never erase state newer than
/// the delete: a task restored by `restore-tasks` (newer fields, tombstone left in place), an
/// entity edited after a late offline delete, or a shared task a member "deletes" with an ancient
/// HLC. Age counts from receipt, so an ancient-HLC delete is not purgeable the moment it lands.
#[derive(Clone, Copy)]
struct NewerThanDelete {
    user: Uuid,
    restored: Uuid,
    tomb_ms: i64,
    ancient: Uuid,
}

async fn seed_newer_than_delete(pool: &PgPool, user: Uuid) -> NewerThanDelete {
    // Deleted 30 days ago, then edited (or restored) with a newer HLC.
    let restored = Uuid::now_v7();
    let tomb_ms = now_ms() - 30 * 86_400_000;
    insert_field(pool, user, "task", restored, "priority", tomb_ms - 1).await;
    insert_field(pool, user, "task", restored, "project_id", tomb_ms - 1).await;
    insert_field(pool, user, "task", restored, "title", tomb_ms + 1).await;
    insert_tombstone(pool, user, "task", restored, tomb_ms, 30).await;
    // A delete carrying an ancient HLC, received just now.
    let ancient = Uuid::now_v7();
    insert_field(pool, user, "task", ancient, "title", 0).await;
    insert_tombstone(pool, user, "task", ancient, 1, 0).await;
    NewerThanDelete {
        user,
        restored,
        tomb_ms,
        ancient,
    }
}

async fn assert_newer_than_delete_survived(pool: &PgPool, seeded: &NewerThanDelete) {
    let NewerThanDelete {
        user,
        restored,
        tomb_ms,
        ancient,
    } = *seeded;
    assert_eq!(
        field_names(pool, user, restored).await,
        vec!["project_id".to_string(), "title".to_string()],
        "the newer field survives, and so does the hidden project_id clients read its key \
         scope from; only the other hidden field is purged"
    );
    assert!(
        has_tombstone(pool, user, restored).await,
        "a tombstone with a newer field is kept, so the older fields stay hidden"
    );
    let visible: Vec<(String, i64)> = sqlx::query_as(
        "SELECT f.field, f.hlc_wall_ms FROM entity_fields f
           JOIN entity_tombstones t USING (user_id, entity, entity_id)
          WHERE f.user_id = $1 AND f.entity_id = $2
            AND (f.hlc_wall_ms, f.hlc_counter, f.hlc_node)
              > (t.hlc_wall_ms, t.hlc_counter, t.hlc_node)",
    )
    .bind(user)
    .bind(restored)
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(
        visible,
        vec![("title".to_string(), tomb_ms + 1)],
        "the entity stays visible through its newer field"
    );
    assert!(
        has_tombstone(pool, user, ancient).await,
        "an ancient-HLC delete received today is not yet purgeable"
    );
    assert_eq!(
        field_names(pool, user, ancient).await,
        vec!["title".to_string()]
    );
}

/// The enabled-purge scenarios in one test, including the rows newer than a delete that must
/// survive: the purge is global (it sweeps every user's expired rows, including other tests'
/// ancient leftovers), so two purging tests running concurrently could delete each other's
/// fixtures. Combining them keeps the pass count deterministic.
#[tokio::test]
async fn enabled_purge_removes_expired_rows_but_keeps_projects_recent_and_fresh_tombstones() {
    let pool = pool().await;
    let user = insert_user(&pool).await;

    // Operations: an expired task op, an expired project op, a fresh task op.
    let old_task = insert_op(&pool, user, "task", 30).await;
    let old_project = insert_op(&pool, user, "project", 30).await;
    let fresh_task = insert_op(&pool, user, "task", 0).await;

    // Tombstones: a stale one (received 30 days ago) with two older field rows, and a fresh one.
    let stale = Uuid::now_v7();
    let stale_ms = now_ms() - 30 * 86_400_000;
    insert_field(&pool, user, "task", stale, "title", stale_ms - 1).await;
    insert_field(&pool, user, "task", stale, "priority", stale_ms - 2).await;
    insert_field(&pool, user, "task", stale, "project_id", stale_ms - 2).await;
    insert_tombstone(&pool, user, "task", stale, stale_ms, 30).await;
    let fresh = Uuid::now_v7();
    let fresh_ms = now_ms();
    insert_field(&pool, user, "task", fresh, "title", fresh_ms).await;
    insert_tombstone(&pool, user, "task", fresh, fresh_ms, 0).await;
    let newer_than_delete = seed_newer_than_delete(&pool, user).await;

    // Purge to completion: a purge takes the oldest rows first in bounded batches, and the shared
    // test database may hold more expired leftovers than one batch.
    let mut stats = retention::PurgeStats::default();
    loop {
        let batch = retention::purge_once(&pool, 7).await.unwrap();
        if batch.operations == 0 && batch.tombstones == 0 {
            break;
        }
        stats.operations += batch.operations;
        stats.tombstones += batch.tombstones;
    }
    assert!(
        stats.operations >= 1,
        "the expired task op is eligible for the purge"
    );
    assert!(
        stats.tombstones >= 1,
        "the stale tombstone is eligible for the purge"
    );

    // Expired non-project ops are gone; the project op (is_project_creator reads the earliest
    // one) and the recent op survive.
    let remaining: Vec<i64> = sqlx::query_scalar(
        "SELECT server_seq FROM operations WHERE user_id = $1 ORDER BY server_seq",
    )
    .bind(user)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        !remaining.contains(&old_task),
        "the expired task op is purged"
    );
    assert_eq!(
        remaining,
        vec![old_project, fresh_task],
        "project ops survive, recent ops survive"
    );
    let watermark: Option<i64> =
        sqlx::query_scalar("SELECT purged_seq FROM sync_purge_watermarks WHERE user_id = $1")
            .bind(user)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(
        watermark,
        Some(old_task),
        "the purge records the user's newest purged seq, so a cursor below it is refused"
    );

    // The stale tombstone goes together with its field rows — leaving fields behind with their
    // tombstone gone would resurrect the entity on the next snapshot bootstrap.
    let stale_fields: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM entity_fields WHERE user_id = $1 AND entity_id = $2",
    )
    .bind(user)
    .bind(stale)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        stale_fields, 0,
        "the stale tombstone's field rows go with it"
    );
    let stale_tomb: Option<i64> = sqlx::query_scalar(
        "SELECT hlc_wall_ms FROM entity_tombstones WHERE user_id = $1 AND entity_id = $2",
    )
    .bind(user)
    .bind(stale)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(stale_tomb, None, "the stale tombstone is purged");

    // The fresh tombstone and its fields survive.
    let fresh_kept: Option<i64> = sqlx::query_scalar(
        "SELECT hlc_wall_ms FROM entity_tombstones WHERE user_id = $1 AND entity_id = $2",
    )
    .bind(user)
    .bind(fresh)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(fresh_kept, Some(fresh_ms), "the fresh tombstone survives");
    let fresh_fields: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM entity_fields WHERE user_id = $1 AND entity_id = $2",
    )
    .bind(user)
    .bind(fresh)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fresh_fields, 1, "the fresh tombstone's fields survive");

    assert_newer_than_delete_survived(&pool, &newer_than_delete).await;
}

/// One `refresh_tokens` row. `expires_in_days` sets the expiry relative to now (negative = already
/// expired); `revoked_days_ago` marks it revoked that long ago, or leaves it live when `None`.
async fn insert_token(
    pool: &PgPool,
    user: Uuid,
    device: Uuid,
    expires_in_days: i64,
    revoked_days_ago: Option<i64>,
) {
    let revoked = revoked_days_ago
        .map(|d| format!("now() - make_interval(days => {d})"))
        .unwrap_or_else(|| "NULL".to_string());
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at, revoked_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4), {revoked})"
    )))
    .bind(user)
    .bind(device)
    .bind(format!("purge-test-{}", Uuid::now_v7()))
    .bind(expires_in_days as i32)
    .execute(pool)
    .await
    .unwrap();
}

async fn token_rows(pool: &PgPool, user: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(
        "SELECT DISTINCT device_id FROM refresh_tokens WHERE user_id = $1 ORDER BY device_id",
    )
    .bind(user)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn token_purge_removes_long_dead_rows_keeps_everything_alive_or_inside_the_window() {
    let pool = pool().await;
    let user = insert_user(&pool).await;

    // Long dead: expired 40 days ago, and revoked 40 days ago (both past a 30-day window).
    insert_token(&pool, user, Uuid::now_v7(), -40, None).await;
    insert_token(&pool, user, Uuid::now_v7(), 10, Some(40)).await;
    // Still inside the window: expired yesterday, revoked yesterday.
    let recent_expired = Uuid::now_v7();
    insert_token(&pool, user, recent_expired, -1, None).await;
    let recent_revoked = Uuid::now_v7();
    insert_token(&pool, user, recent_revoked, 10, Some(1)).await;

    let purged = retention::purge_tokens_once(&pool, 30).await.unwrap();
    assert!(
        purged >= 2,
        "both long-dead rows are eligible ({purged} purged)"
    );
    let remaining = token_rows(&pool, user).await;
    assert_eq!(
        remaining,
        vec![recent_expired, recent_revoked],
        "exactly the rows that died inside the window survive"
    );

    // A live token (unexpired, unrevoked) and a fresh rotation row (revoked but not expired)
    // must survive even an aggressive 1-day window: the purge predicate matches only rows that
    // have been dead for the whole window, so no run can ever sign a working device out.
    let live = Uuid::now_v7();
    insert_token(&pool, user, live, 10, None).await;
    let fresh_rotated = Uuid::now_v7();
    insert_token(&pool, user, fresh_rotated, 10, Some(0)).await;
    retention::purge_tokens_once(&pool, 1).await.unwrap();
    let after_aggressive = token_rows(&pool, user).await;
    assert!(
        after_aggressive.contains(&live),
        "no live token is ever purged"
    );
    assert!(
        after_aggressive.contains(&fresh_rotated),
        "a fresh rotation row is not purgeable"
    );

    // And the disabled setting is a no-op, like the op purge's.
    assert_eq!(retention::purge_tokens_once(&pool, 0).await.unwrap(), 0);
    assert_eq!(retention::purge_tokens_once(&pool, -1).await.unwrap(), 0);
}
