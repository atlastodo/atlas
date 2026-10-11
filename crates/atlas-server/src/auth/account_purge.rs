//! Purging accounts whose deletion grace period has run out.
//!
//! Deletion is only scheduled; after [`DELETION_GRACE_DAYS`] a periodic task ([`spawn`]) removes
//! the account and everything cascading from it, whether or not the user signs in again. Shared
//! projects are handled like removing a member (membership tombstones to the remaining members).
//! A project whose only owner was purged can be taken over via
//! `POST /projects/:id/claim-ownership`.

use std::time::Duration;

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppResult;
use crate::state::AppState;

pub const DELETION_GRACE_DAYS: i64 = 30;

/// How often the purge runs; the first pass fires at startup.
const PURGE_INTERVAL: Duration = Duration::from_secs(60 * 60 * 6);

/// Accounts deleted per transaction; each drags its op log along, so batches stay small.
const PURGE_BATCH: i64 = 50;

/// Start the periodic purge. Always on: an expired grace period is a promise to the user.
pub fn spawn(state: &AppState) -> tokio::task::JoinHandle<()> {
    let state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PURGE_INTERVAL);
        loop {
            interval.tick().await;
            match purge_expired_accounts(&state).await {
                Ok(0) => {}
                Ok(purged) => tracing::info!(purged, "purged accounts past their deletion date"),
                Err(e) => tracing::warn!(error = ?e, "account purge failed"),
            }
        }
    })
}

/// Whether a deletion scheduled at `scheduled_at` is past its grace period.
pub fn is_past_grace(scheduled_at: OffsetDateTime) -> bool {
    OffsetDateTime::now_utc() - scheduled_at >= time::Duration::days(DELETION_GRACE_DAYS)
}

/// Whole days left before a deletion scheduled at `scheduled_at` is purged; at least 1 while the
/// account still exists (the purge runs every [`PURGE_INTERVAL`], so it can trail the expiry).
pub fn days_remaining(scheduled_at: OffsetDateTime) -> i64 {
    let elapsed = OffsetDateTime::now_utc() - scheduled_at;
    (DELETION_GRACE_DAYS - elapsed.whole_days()).max(1)
}

/// Delete every account whose grace period has run out, in batches, each audited with a NULL
/// actor. Returns how many were purged.
pub async fn purge_expired_accounts(state: &AppState) -> AppResult<u64> {
    let mut purged = 0;
    loop {
        let (purged_ids, memberships, blobs) = purge_batch(&state.pool).await?;
        let count = purged_ids.len() as u64;
        purged += count;
        for id in purged_ids {
            state.hub.close_user_sockets(id);
        }
        notify_members(state, &memberships).await;
        remove_blob_files(state, &blobs).await;
        if count < PURGE_BATCH as u64 {
            return Ok(purged);
        }
    }
}

/// What one purge batch removed: accounts, their (project, user) memberships and their blobs' addresses.
type PurgedBatch = (Vec<Uuid>, Vec<(Uuid, Uuid)>, Vec<String>);

async fn purge_batch(pool: &PgPool) -> AppResult<PurgedBatch> {
    let mut tx = pool.begin().await?;
    // SKIP LOCKED: two servers on one database split the work.
    let doomed: Vec<(Uuid, String, OffsetDateTime)> = sqlx::query_as(
        "SELECT id, email::TEXT, deletion_scheduled_at FROM users
          WHERE deletion_scheduled_at <= now() - make_interval(days => $1)
          ORDER BY deletion_scheduled_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED",
    )
    .bind(DELETION_GRACE_DAYS as i32)
    .bind(PURGE_BATCH)
    .fetch_all(&mut *tx)
    .await?;
    if doomed.is_empty() {
        return Ok((Vec::new(), Vec::new(), Vec::new()));
    }
    let ids: Vec<Uuid> = doomed.iter().map(|(id, _, _)| *id).collect();
    let memberships: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT project_id, user_id FROM project_members WHERE user_id = ANY($1)")
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;

    for (id, email, scheduled_at) in &doomed {
        // Written before the delete so the row can be referenced; the FK then nulls the target.
        crate::audit::record_system(
            &mut *tx,
            "user.purge",
            Some(*id),
            serde_json::json!({
                "source": "purge",
                "target_email": email,
                "target_user_id": id,
                "deletion_scheduled_at_ms": scheduled_at.unix_timestamp() * 1000,
            }),
        )
        .await?;
    }
    // Their files would otherwise stay on disk with nothing pointing the GC at them.
    let blobs: Vec<String> =
        sqlx::query_scalar("DELETE FROM blobs WHERE uploader_id = ANY($1) RETURNING sha256")
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    // The purged members' keys go with their accounts; the projects they held them for rotate.
    crate::projects::request_rotations(&mut *tx, None, &ids).await?;
    sqlx::query("DELETE FROM users WHERE id = ANY($1)")
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((ids, memberships, blobs))
}

/// Delete the purged accounts' blob files, after commit; a failure leaves an orphan the GC sweep collects.
async fn remove_blob_files(state: &AppState, blobs: &[String]) {
    if blobs.is_empty() {
        return;
    }
    if let Some(store) = &state.blobs {
        crate::attachments::remove_files(store, blobs).await;
    }
}

/// Tombstone each purged membership in the remaining members' partitions, after commit. A failed
/// delivery is logged, not retried: the membership row a retry needs is gone.
async fn notify_members(state: &AppState, memberships: &[(Uuid, Uuid)]) {
    for &(project_id, user_id) in memberships {
        let delivered = async {
            let remaining: Vec<Uuid> = crate::members::active_members(&state.pool, project_id)
                .await?
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            crate::sync::deliver_to_members(
                state,
                &remaining,
                &[crate::sync::member_delete_op(state, project_id, user_id)],
            )
            .await
        }
        .await;
        if let Err(e) = delivered {
            tracing::warn!(error = ?e, %project_id, "could not notify members of a purged account");
        }
    }
}
