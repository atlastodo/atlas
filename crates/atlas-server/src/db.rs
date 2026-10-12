//! Database pool creation and migrations.

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::DEFAULT_DB_MAX_CONNECTIONS;

/// Connect eagerly to Postgres with a pool of the default size.
pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    connect_with(database_url, DEFAULT_DB_MAX_CONNECTIONS).await
}

/// Connect eagerly to Postgres with a pool of at most `max_connections`.
pub async fn connect_with(database_url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await
}

/// Apply all pending migrations from the repo-root `migrations/` directory. Idempotent: sqlx
/// records applied migrations and takes an advisory lock, so concurrent callers are safe.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}
