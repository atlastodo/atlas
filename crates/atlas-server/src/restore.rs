//! Admin restore for tasks hard-deleted by outdated clients.
//!
//! Only rows written before sync protocol 7 name a task: since then the server sees an opaque
//! `todo.sealed` entity (`docs/decisions/0006-opaque-sync-metadata.md`), and the clients that
//! hard-deleted tasks are refused anyway. So this restores legacy `task` rows (and their legacy
//! attachments) as legacy rows, which clients read and re-encode like any other.
//!
//! A tombstone only hides an entity: field rows stay in `entity_fields`, and a field with an HLC
//! newer than the tombstone is visible again. A restore re-writes each field's last value as a
//! server-authored Set whose HLC beats every tombstone of the task, through the locked push
//! write path, into every current member's partition. Values are copied verbatim (client-side
//! ciphertext). The task's attachments deleted in the same window are restored too; the blob GC
//! keeps their blobs as long as retention keeps the tombstones.
//!
//! Run as `atlas-server restore-tasks ...` (see [`USAGE`]); a dry run unless `--apply`. Past
//! `OP_RETENTION_DAYS` a deleted task is gone for good, so retention must be off
//! (`OP_RETENTION_DAYS=0`) until the restore has run.

use std::time::{SystemTime, UNIX_EPOCH};

use atlas_core::{EntityKind, Hlc, HlcClock, WireKind, WireOperation};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppResult;
use crate::{members, sync};

pub const USAGE: &str = "usage: atlas-server restore-tasks (--project <uuid> | --user <uuid>) \
--since <RFC3339> --until <RFC3339> [--apply] [--all-deleters]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreScope {
    Project(Uuid),
    User(Uuid),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOptions {
    pub scope: RestoreScope,
    pub since_ms: i64,
    pub until_ms: i64,
    pub apply: bool,
    pub all_deleters: bool,
}

impl RestoreOptions {
    pub fn from_args(args: &[String]) -> Result<Self, String> {
        let (mut project, mut user, mut since, mut until) = (None, None, None, None);
        let (mut apply, mut all_deleters) = (false, false);
        let mut it = args.iter();
        while let Some(arg) = it.next() {
            let mut value = || {
                it.next()
                    .map(String::as_str)
                    .ok_or_else(|| format!("{arg} needs a value"))
            };
            match arg.as_str() {
                "--project" => project = Some(parse_uuid(arg, value()?)?),
                "--user" => user = Some(parse_uuid(arg, value()?)?),
                "--since" => since = Some(parse_rfc3339_ms(arg, value()?)?),
                "--until" => until = Some(parse_rfc3339_ms(arg, value()?)?),
                "--apply" => apply = true,
                "--all-deleters" => all_deleters = true,
                other => return Err(format!("unknown argument: {other}")),
            }
        }
        let scope = match (project, user) {
            (Some(p), None) => RestoreScope::Project(p),
            (None, Some(u)) => RestoreScope::User(u),
            _ => return Err("exactly one of --project or --user is required".into()),
        };
        let since_ms = since.ok_or("--since is required")?;
        let until_ms = until.ok_or("--until is required")?;
        if since_ms > until_ms {
            return Err("--since must not be after --until".into());
        }
        Ok(Self {
            scope,
            since_ms,
            until_ms,
            apply,
            all_deleters,
        })
    }

    fn in_window(&self, wall_ms: u64) -> bool {
        let wall = i64::try_from(wall_ms).unwrap_or(i64::MAX);
        (self.since_ms..=self.until_ms).contains(&wall)
    }
}

fn parse_uuid(flag: &str, s: &str) -> Result<Uuid, String> {
    Uuid::parse_str(s).map_err(|e| format!("{flag}: not a uuid ({e})"))
}

fn parse_rfc3339_ms(flag: &str, s: &str) -> Result<i64, String> {
    let t = OffsetDateTime::parse(s, &Rfc3339)
        .map_err(|e| format!("{flag}: not an RFC 3339 timestamp ({e})"))?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).map_err(|_| format!("{flag}: out of range"))
}

#[derive(Debug, Serialize)]
pub struct RestoreReport {
    pub applied: bool,
    pub tasks: Vec<TaskRestore>,
}

impl RestoreReport {
    pub fn restored(&self) -> usize {
        self.tasks.iter().filter(|t| t.skip.is_none()).count()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRestore {
    pub task_id: Uuid,
    pub project_id: Option<Uuid>,
    pub tombstone_at: Option<String>,
    pub deleter: Option<Uuid>,
    pub creator: Option<Uuid>,
    pub partitions: Vec<Uuid>,
    pub fields: Vec<String>,
    pub attachments: Vec<Uuid>,
    pub skip: Option<SkipReason>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    NotAMember,
    DeletedAgainLater,
    NoStoredFields,
    AlreadyRestored,
    DeletedByCreator,
}

struct Plan {
    report: TaskRestore,
    restore: Vec<(String, Value)>,
    /// The newest tombstone of the task in any partition; every restored Set must beat it.
    floor: Hlc,
    attachments: Vec<ChildPlan>,
}

/// An attachment restored with its task (purging a task tombstones its attachments too).
struct ChildPlan {
    id: Uuid,
    restore: Vec<(String, Value)>,
    floor: Hlc,
}

pub async fn restore_tasks(pool: &PgPool, opts: &RestoreOptions) -> AppResult<RestoreReport> {
    // A fresh node per run keeps these timestamps distinct from every device and server boot.
    let mut clock = HlcClock::new(Uuid::now_v7());
    let mut tasks = Vec::new();
    for task_id in candidate_tasks(pool, opts).await? {
        let report = if opts.apply {
            // Plan and write in one sync-write transaction so no push lands in between.
            let mut tx = sync::begin_sync_write(pool).await?;
            let plan = plan_task(&mut tx, pool, opts, task_id).await?;
            if plan.report.skip.is_none() {
                clock.update(plan.floor, now_ms());
                let task = WireKind::Legacy(EntityKind::Task);
                let ops: Vec<WireOperation> = plan
                    .restore
                    .iter()
                    .map(|(field, value)| {
                        let ts = clock.now(now_ms());
                        WireOperation::set(task, task_id, None, field, value.clone(), ts)
                    })
                    .collect();
                sync::apply_to_members(&mut tx, &plan.report.partitions, &ops).await?;
                for child in &plan.attachments {
                    clock.update(child.floor, now_ms());
                    let ops: Vec<WireOperation> = child
                        .restore
                        .iter()
                        .map(|(field, value)| {
                            let ts = clock.now(now_ms());
                            WireOperation::set(
                                WireKind::Legacy(EntityKind::Attachment),
                                child.id,
                                None,
                                field,
                                value.clone(),
                                ts,
                            )
                        })
                        .collect();
                    sync::apply_to_members(&mut tx, &plan.report.partitions, &ops).await?;
                }
                tx.commit().await?;
            }
            plan.report
        } else {
            let mut conn = pool.acquire().await?;
            plan_task(&mut conn, pool, opts, task_id).await?.report
        };
        tasks.push(report);
    }
    Ok(RestoreReport {
        applied: opts.apply,
        tasks,
    })
}

async fn candidate_tasks(pool: &PgPool, opts: &RestoreOptions) -> AppResult<Vec<Uuid>> {
    let ids = match opts.scope {
        RestoreScope::User(user) => {
            sqlx::query_scalar(
                "SELECT entity_id FROM entity_tombstones
                  WHERE user_id = $1 AND entity = 'task' AND hlc_wall_ms BETWEEN $2 AND $3
                  ORDER BY entity_id",
            )
            .bind(user)
            .bind(opts.since_ms)
            .bind(opts.until_ms)
            .fetch_all(pool)
            .await?
        }
        RestoreScope::Project(project) => {
            sqlx::query_scalar(
                "SELECT DISTINCT entity_id FROM entity_tombstones
                  WHERE entity = 'task' AND hlc_wall_ms BETWEEN $2 AND $3
                    AND entity_id IN (
                        SELECT entity_id FROM entity_fields
                         WHERE entity = 'task' AND field = 'project_id' AND value = $1)
                  ORDER BY entity_id",
            )
            .bind(Value::String(project.to_string()))
            .bind(opts.since_ms)
            .bind(opts.until_ms)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(ids)
}

async fn plan_task(
    conn: &mut PgConnection,
    pool: &PgPool,
    opts: &RestoreOptions,
    task_id: Uuid,
) -> AppResult<Plan> {
    let mut report = TaskRestore {
        task_id,
        project_id: None,
        tombstone_at: None,
        deleter: None,
        creator: None,
        partitions: Vec::new(),
        fields: Vec::new(),
        attachments: Vec::new(),
        skip: None,
        notes: Vec::new(),
    };
    let tombstones = task_tombstones(conn, task_id).await?;
    let floor = tombstones
        .iter()
        .map(|(_, h)| *h)
        .max()
        .unwrap_or(Hlc::zero(Uuid::nil()));
    let skip = |mut report: TaskRestore, reason| {
        report.skip = Some(reason);
        Ok(Plan {
            report,
            restore: Vec::new(),
            floor,
            attachments: Vec::new(),
        })
    };

    let project = match opts.scope {
        RestoreScope::Project(p) => Some(p),
        RestoreScope::User(u) => project_of_task(conn, u, task_id).await?,
    };
    report.project_id = project;

    // Values are read from and written to the same partitions, so a planted row in another
    // user's partition is never copied into a member's.
    let shared = match project {
        Some(p) if members::is_shared(pool, p).await? => Some(p),
        _ => None,
    };
    let mut partitions: Vec<Uuid> = match (shared, opts.scope) {
        (Some(p), _) => members::active_members(pool, p)
            .await?
            .into_iter()
            .map(|(id, _)| id)
            .collect(),
        (None, RestoreScope::User(u)) => vec![u],
        // A private task lives only in its owner's partition.
        (None, RestoreScope::Project(_)) => tombstones
            .iter()
            .filter(|(_, h)| opts.in_window(h.wall_ms))
            .map(|(u, _)| *u)
            .collect(),
    };
    partitions.sort();
    partitions.dedup();
    report.partitions = partitions.clone();

    let scope_partition = match opts.scope {
        RestoreScope::User(u) => Some(u),
        RestoreScope::Project(_) => None,
    };
    let deleted_in_window = tombstones.iter().any(|(u, h)| {
        partitions.contains(u)
            && (scope_partition.is_none() || scope_partition == Some(*u))
            && opts.in_window(h.wall_ms)
    });
    let governing = tombstones
        .iter()
        .filter(|(u, _)| partitions.contains(u))
        .map(|(_, h)| *h)
        .max();
    let Some(governing) = governing.filter(|_| deleted_in_window) else {
        return skip(report, SkipReason::NotAMember);
    };
    report.tombstone_at = Some(rfc3339(governing.wall_ms));
    if !opts.in_window(governing.wall_ms) {
        return skip(report, SkipReason::DeletedAgainLater);
    }

    report.deleter = author_of(conn, task_id, None, governing).await?;
    if report.deleter.is_none() {
        report
            .notes
            .push("deleter unknown: the delete op is no longer in the op log".into());
    }

    let fields = latest_fields(conn, "task", task_id, &partitions).await?;
    if fields.is_empty() {
        return skip(report, SkipReason::NoStoredFields);
    }
    // A field already newer than the delete is visible; rewriting it could only lose an edit.
    let restore: Vec<(String, Value, Hlc)> =
        fields.into_iter().filter(|f| f.2 < governing).collect();
    let Some(oldest) = restore.iter().min_by_key(|f| f.2) else {
        return skip(report, SkipReason::AlreadyRestored);
    };

    // The oldest surviving write comes from the creation batch (`created_at` is never rewritten).
    report.creator = author_of(conn, task_id, Some(&oldest.0), oldest.2).await?;
    if report.creator.is_none() {
        report
            .notes
            .push("creator unknown: the task's oldest write is no longer in the op log".into());
    }
    if !opts.all_deleters && report.deleter.is_some() && report.deleter == report.creator {
        return skip(report, SkipReason::DeletedByCreator);
    }

    report.fields = restore.iter().map(|f| f.0.clone()).collect();
    let attachments = plan_attachments(conn, opts, task_id, &partitions).await?;
    report.attachments = attachments.iter().map(|a| a.id).collect();
    Ok(Plan {
        report,
        restore: restore.into_iter().map(|(f, v, _)| (f, v)).collect(),
        floor,
        attachments,
    })
}

/// The task's attachments whose delete in `partitions` falls inside the window; one deleted
/// outside it stays deleted.
async fn plan_attachments(
    conn: &mut PgConnection,
    opts: &RestoreOptions,
    task_id: Uuid,
    partitions: &[Uuid],
) -> AppResult<Vec<ChildPlan>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT entity_id FROM entity_fields
          WHERE entity = 'attachment' AND field = 'task_id' AND value = $1 AND user_id = ANY($2)
          ORDER BY entity_id",
    )
    .bind(Value::String(task_id.to_string()))
    .bind(partitions)
    .fetch_all(&mut *conn)
    .await?;
    let mut plans = Vec::new();
    for id in ids {
        let tombstones: Vec<(Uuid, i64, i32, Uuid)> = sqlx::query_as(
            "SELECT user_id, hlc_wall_ms, hlc_counter, hlc_node FROM entity_tombstones
              WHERE entity = 'attachment' AND entity_id = $1",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
        let tombstones: Vec<(Uuid, Hlc)> = tombstones
            .into_iter()
            .map(|(user, wall, counter, node)| (user, hlc(wall, counter, node)))
            .collect();
        let Some(governing) = tombstones
            .iter()
            .filter(|(u, _)| partitions.contains(u))
            .map(|(_, h)| *h)
            .max()
        else {
            continue;
        };
        if !opts.in_window(governing.wall_ms) {
            continue;
        }
        let floor = tombstones
            .iter()
            .map(|(_, h)| *h)
            .max()
            .unwrap_or(governing);
        let restore: Vec<(String, Value)> = latest_fields(conn, "attachment", id, partitions)
            .await?
            .into_iter()
            .filter(|f| f.2 < governing)
            .map(|(f, v, _)| (f, v))
            .collect();
        if !restore.is_empty() {
            plans.push(ChildPlan { id, restore, floor });
        }
    }
    Ok(plans)
}

async fn task_tombstones(conn: &mut PgConnection, task_id: Uuid) -> AppResult<Vec<(Uuid, Hlc)>> {
    let rows: Vec<(Uuid, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT user_id, hlc_wall_ms, hlc_counter, hlc_node FROM entity_tombstones
          WHERE entity = 'task' AND entity_id = $1",
    )
    .bind(task_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user, wall, counter, node)| (user, hlc(wall, counter, node)))
        .collect())
}

async fn project_of_task(
    conn: &mut PgConnection,
    user: Uuid,
    task_id: Uuid,
) -> AppResult<Option<Uuid>> {
    let v: Option<Option<String>> = sqlx::query_scalar(
        "SELECT value #>> '{}' FROM entity_fields
          WHERE user_id = $1 AND entity = 'task' AND entity_id = $2 AND field = 'project_id'",
    )
    .bind(user)
    .bind(task_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(v.flatten().and_then(|s| Uuid::parse_str(&s).ok()))
}

async fn latest_fields(
    conn: &mut PgConnection,
    entity: &str,
    entity_id: Uuid,
    partitions: &[Uuid],
) -> AppResult<Vec<(String, Value, Hlc)>> {
    let rows: Vec<(String, Option<Value>, i64, i32, Uuid)> = sqlx::query_as(
        "SELECT DISTINCT ON (field) field, value, hlc_wall_ms, hlc_counter, hlc_node
           FROM entity_fields
          WHERE entity = $3 AND entity_id = $1 AND user_id = ANY($2)
          ORDER BY field, hlc_wall_ms DESC, hlc_counter DESC, hlc_node DESC",
    )
    .bind(entity_id)
    .bind(partitions)
    .bind(entity)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(field, value, wall, counter, node)| {
            (
                field,
                value.unwrap_or(Value::Null),
                hlc(wall, counter, node),
            )
        })
        .collect())
}

/// The user who authored the task op with this HLC (`field: None` for the delete): the lowest
/// `server_seq` carrying it, since push writes the author's partition before fan-out.
async fn author_of(
    conn: &mut PgConnection,
    task_id: Uuid,
    field: Option<&str>,
    ts: Hlc,
) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM operations
          WHERE entity = 'task' AND entity_id = $1
            AND is_delete = $2 AND field IS NOT DISTINCT FROM $3
            AND hlc_wall_ms = $4 AND hlc_counter = $5 AND hlc_node = $6
          ORDER BY server_seq
          LIMIT 1",
    )
    .bind(task_id)
    .bind(field.is_none())
    .bind(field)
    .bind(ts.wall_ms as i64)
    .bind(ts.counter as i32)
    .bind(ts.node)
    .fetch_optional(&mut *conn)
    .await?)
}

fn hlc(wall: i64, counter: i32, node: Uuid) -> Hlc {
    Hlc {
        wall_ms: wall as u64,
        counter: counter as u32,
        node,
    }
}

fn rfc3339(wall_ms: u64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(wall_ms) * 1_000_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_else(|| wall_ms.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn parses_a_full_command_line() {
        let p = Uuid::now_v7();
        let opts = RestoreOptions::from_args(&args(&format!(
            "--project {p} --since 2026-09-01T00:00:00Z --until 2026-09-02T00:00:00.5+02:00 \
             --apply --all-deleters"
        )))
        .unwrap();
        assert_eq!(opts.scope, RestoreScope::Project(p));
        assert_eq!(opts.since_ms, 1_788_220_800_000);
        assert_eq!(opts.until_ms, 1_788_300_000_500);
        assert!(opts.apply && opts.all_deleters);

        let u = Uuid::now_v7();
        let opts = RestoreOptions::from_args(&args(&format!(
            "--user {u} --since 2026-09-01T00:00:00Z --until 2026-09-01T00:00:00Z"
        )))
        .unwrap();
        assert_eq!(opts.scope, RestoreScope::User(u));
        assert!(!opts.apply && !opts.all_deleters, "dry run by default");
    }

    #[test]
    fn rejects_bad_command_lines() {
        let p = Uuid::now_v7();
        let window = "--since 2026-09-01T00:00:00Z --until 2026-09-02T00:00:00Z";
        for bad in [
            window.to_string(),
            format!("--project {p} --user {p} {window}"),
            format!("--project {p} --since 2026-09-01T00:00:00Z"),
            format!("--project {p} --since 2026-09-03T00:00:00Z --until 2026-09-02T00:00:00Z"),
            format!("--project {p} --since yesterday --until 2026-09-02T00:00:00Z"),
            format!("--project not-a-uuid {window}"),
            format!("--project {p} {window} --force"),
            format!("--project {p} {window} --until"),
        ] {
            assert!(RestoreOptions::from_args(&args(&bad)).is_err(), "{bad}");
        }
    }
}
