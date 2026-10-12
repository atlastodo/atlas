//! Shared-project membership, roles and invites.
//!
//! A project is private (no `project_members` rows) until its owner shares it. Sharing inserts an
//! `owner` row and `pending` rows for invitees; accepting flips a row to `active`. Roles order
//! `commenter < editor < owner`; [`require_role`] gates cross-user op delivery in `sync/push.rs`.

use atlas_core::Operation;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::ratelimit::{self, UserRateLimitState};
use crate::state::AppState;

/// A member's capability level; declaration order is the authorization order, so
/// `role >= Role::Editor` means editor or owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Commenter,
    Editor,
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Commenter => "commenter",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> AppResult<Role> {
        match s {
            "commenter" => Ok(Role::Commenter),
            "editor" => Ok(Role::Editor),
            "owner" => Ok(Role::Owner),
            other => Err(AppError::BadRequest(format!("unknown role: {other}"))),
        }
    }
}

/// Invite lifecycle: `Pending` until the invitee accepts, then `Active`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberState {
    Pending,
    Active,
}

impl MemberState {
    fn parse(s: &str) -> AppResult<MemberState> {
        match s {
            "pending" => Ok(MemberState::Pending),
            "active" => Ok(MemberState::Active),
            other => Err(AppError::BadRequest(format!(
                "unknown member state: {other}"
            ))),
        }
    }
}

pub async fn membership(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<(Role, MemberState)>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT role, state FROM project_members WHERE project_id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some((role, state)) => Ok(Some((Role::parse(&role)?, MemberState::parse(&state)?))),
        None => Ok(None),
    }
}

/// Require that `user_id` is an active member with at least `min` role; else 403.
pub async fn require_role(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
    min: Role,
) -> AppResult<Role> {
    match membership(pool, project_id, user_id).await? {
        Some((role, MemberState::Active)) if role >= min => Ok(role),
        _ => Err(AppError::Forbidden(format!(
            "requires {} role on this project",
            min.as_str()
        ))),
    }
}

/// True if the project has at least one membership row (it has been shared).
pub async fn is_shared(pool: &PgPool, project_id: Uuid) -> AppResult<bool> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM project_members WHERE project_id = $1")
        .bind(project_id)
        .fetch_one(pool)
        .await?;
    Ok(n > 0)
}

/// Active members of a project (the fan-out target set), each with their role.
pub async fn active_members(pool: &PgPool, project_id: Uuid) -> AppResult<Vec<(Uuid, Role)>> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT user_id, role FROM project_members WHERE project_id = $1 AND state = 'active'",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(id, role)| Ok((id, Role::parse(&role)?)))
        .collect()
}

/// The project's active owners, rows locked until `conn`'s transaction ends. Used to forbid
/// demoting or removing the last owner, which would orphan the project. The lock makes
/// concurrent demotions take turns; otherwise two aimed at different owners would each still
/// see the other and leave none.
async fn lock_owners(conn: &mut PgConnection, project_id: Uuid) -> AppResult<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM project_members
          WHERE project_id = $1 AND role = 'owner' AND state = 'active'
          ORDER BY user_id
          FOR UPDATE",
    )
    .bind(project_id)
    .fetch_all(conn)
    .await?)
}

/// True if `user_id` is the creator of this project: the first user to have pushed any op for
/// it into the global operation log (lowest `server_seq`).
///
/// This is the trustworthy ownership signal for a not-yet-shared project. It must not be
/// inferred from the per-user `entity_fields` partition, which is caller-writable: an attacker
/// who learned a victim's project UUID could plant a matching op and bootstrap as owner. The
/// log's `server_seq` is monotonic and append-only.
pub async fn is_project_creator(pool: &PgPool, project_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let creator: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM operations
         WHERE entity = 'project' AND entity_id = $1
         ORDER BY server_seq ASC
         LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    Ok(creator == Some(user_id))
}

/// Authorize a membership-management action: the caller must be the active owner, or on the
/// first share the project's creator (per the operation log). Returns whether the caller still
/// has to be bootstrapped as owner, which [`invite_member`] does with the invite so a failed
/// first invite leaves the project unshared. 404 for a project the caller has no relationship
/// with, so existence does not leak.
async fn ensure_can_manage(pool: &PgPool, project_id: Uuid, caller: Uuid) -> AppResult<bool> {
    match membership(pool, project_id, caller).await? {
        Some((Role::Owner, MemberState::Active)) => Ok(false),
        Some(_) => Err(AppError::Forbidden(
            "only the owner can manage members".into(),
        )),
        None => {
            if is_shared(pool, project_id).await? {
                // Already shared by someone else; the caller is not a member.
                return Err(AppError::NotFound);
            }
            if !is_project_creator(pool, project_id, caller).await? {
                return Err(AppError::NotFound);
            }
            Ok(true)
        }
    }
}

/// The membership routes. Invites have a per-user budget (`invite_rl`): each one tells the
/// caller whether an email has an account, and lands in that account's invite list.
pub fn routes(invite_rl: UserRateLimitState) -> Router<AppState> {
    let invite = post(invite_member).layer(axum::middleware::from_fn_with_state(
        invite_rl,
        ratelimit::enforce_per_user,
    ));
    Router::new()
        .route("/invites", get(list_invites))
        .route("/projects/{id}/members", get(list_members).merge(invite))
        .route("/projects/{id}/accept", post(accept_invite))
        .route("/projects/{id}/decline", post(decline_invite))
        .route("/projects/{id}/claim-ownership", post(claim_ownership))
        .route(
            "/projects/{id}/members/{user_id}",
            patch(update_role).delete(remove_member),
        )
}

/// Deliver the `project_member` rows of the `changed` members so each member's collaborator
/// list stays current. An active member's row goes to every active member; a pending invitee's
/// only to the invitee. `joined`, a member that just became active, also gets every other
/// active member's row. Authorization never reads these rows: it uses `project_members`, where
/// a pending row grants nothing but the invite and its key.
async fn broadcast_members(
    state: &AppState,
    project_id: Uuid,
    changed: &[Uuid],
    joined: Option<Uuid>,
) -> AppResult<()> {
    let mut tx = crate::sync::begin_sync_write(&state.pool).await?;
    let rows = member_list_rows(&mut tx, state, project_id, changed, joined).await?;
    let rows: Vec<(Uuid, &Operation)> = rows.iter().map(|(member, op)| (*member, op)).collect();
    let batches = crate::sync::apply_to_partitions(&mut tx, &rows).await?;
    tx.commit().await?;
    crate::sync::publish_batches(state, batches);
    Ok(())
}

async fn member_list_rows(
    conn: &mut PgConnection,
    state: &AppState,
    project_id: Uuid,
    changed: &[Uuid],
    joined: Option<Uuid>,
) -> AppResult<Vec<(Uuid, Operation)>> {
    let rows: Vec<(Uuid, String, String, String, String, bool)> = sqlx::query_as(
        "SELECT pm.user_id, u.email::text AS email, u.display_name, pm.role, pm.state,
                (u.deletion_scheduled_at IS NOT NULL) AS deletion_scheduled
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1",
    )
    .bind(project_id)
    .fetch_all(conn)
    .await?;
    let active: Vec<Uuid> = rows
        .iter()
        .filter(|(_, _, _, _, st, _)| st == "active")
        .map(|(id, _, _, _, _, _)| *id)
        .collect();
    let joined = joined.filter(|id| active.contains(id));
    let mut out = Vec::new();
    for (id, email, display_name, role, st, deletion_scheduled) in &rows {
        let recipients = if changed.contains(id) {
            if st == "pending" {
                std::slice::from_ref(id)
            } else {
                active.as_slice()
            }
        } else if st == "active" {
            joined.as_slice()
        } else {
            &[]
        };
        if recipients.is_empty() {
            continue;
        }
        let row_ops = crate::sync::member_set_ops(
            state,
            project_id,
            *id,
            email,
            display_name,
            role,
            st,
            *deletion_scheduled,
        );
        for recipient in recipients {
            out.extend(row_ops.iter().map(|op| (*recipient, op.clone())));
        }
    }
    Ok(out)
}

/// Deliver `user_id`'s own row in every project it belongs to after a change the row shows
/// (its scheduled deletion).
pub async fn broadcast_members_for_user_projects(state: &AppState, user_id: Uuid) -> AppResult<()> {
    let project_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT project_id FROM project_members WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    for pid in project_ids {
        let _ = broadcast_members(state, pid, &[user_id], None).await;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct InviteView {
    pub project_id: Uuid,
    pub role: String,
    pub invited_at: i64,
    pub inviter: Option<InviterView>,
    pub project: InviteProject,
    pub sealed_key: Option<SealedKeyView>,
}

#[derive(Debug, Serialize)]
pub struct InviterView {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
}

/// Project fields as stored in the inviter's partition, passed through untouched: they are
/// E2EE envelopes the invitee decrypts after unsealing the key.
#[derive(Debug, Serialize)]
pub struct InviteProject {
    pub name: Value,
    pub icon: Value,
    pub color: Value,
    pub kind: Value,
}

#[derive(Debug, Serialize)]
pub struct SealedKeyView {
    pub key_id: String,
    pub encrypted_pek: Value,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    project_id: Uuid,
    role: String,
    invited_at: i64,
    inviter_id: Option<Uuid>,
    inviter_email: Option<String>,
    inviter_display_name: Option<String>,
    project_fields: Option<Value>,
    sealed_key_id: Option<String>,
    sealed_pek: Option<Value>,
}

/// `GET /invites`: the caller's pending invitations. Project fields come from the inviter's
/// partition or, when that account is gone, the earliest active owner's.
async fn list_invites(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<Vec<InviteView>>> {
    let rows = sqlx::query_as::<_, InviteRow>(
        "WITH inv AS (
             SELECT pm.project_id, pm.role, pm.created_at,
                    COALESCE(pm.invited_by,
                             (SELECT o.user_id FROM project_members o
                               WHERE o.project_id = pm.project_id
                                 AND o.role = 'owner' AND o.state = 'active'
                               ORDER BY o.created_at, o.user_id LIMIT 1)) AS source
               FROM project_members pm
              WHERE pm.user_id = $1 AND pm.state = 'pending'
         )
         SELECT inv.project_id, inv.role,
                (EXTRACT(EPOCH FROM inv.created_at) * 1000)::BIGINT AS invited_at,
                u.id AS inviter_id, u.email::text AS inviter_email,
                u.display_name AS inviter_display_name,
                (SELECT jsonb_object_agg(ef.field, ef.value) FROM entity_fields ef
                  WHERE ef.user_id = inv.source AND ef.entity = 'project'
                    AND ef.entity_id = inv.project_id
                    AND ef.field IN ('name', 'icon', 'color', 'kind')) AS project_fields,
                sk.key_id AS sealed_key_id, sk.encrypted_pek AS sealed_pek
           FROM inv
           LEFT JOIN users u ON u.id = inv.source
           LEFT JOIN LATERAL (
                SELECT pk.key_id, pk.encrypted_pek FROM project_keys pk
                 WHERE pk.project_id = inv.project_id AND pk.user_id = $1 AND pk.kind = 'sealed'
                 ORDER BY pk.updated_at DESC, pk.created_at DESC, pk.key_id
                 LIMIT 1) sk ON true
          ORDER BY inv.created_at, inv.project_id",
    )
    .bind(user.user_id)
    .fetch_all(&state.pool)
    .await?;
    let invites = rows
        .into_iter()
        .map(|r| {
            let fields = r.project_fields.unwrap_or(Value::Null);
            let field = |name: &str| fields.get(name).cloned().unwrap_or(Value::Null);
            InviteView {
                project_id: r.project_id,
                role: r.role,
                invited_at: r.invited_at,
                inviter: r.inviter_id.map(|user_id| InviterView {
                    user_id,
                    email: r.inviter_email.unwrap_or_default(),
                    display_name: r.inviter_display_name.unwrap_or_default(),
                }),
                project: InviteProject {
                    name: field("name"),
                    icon: field("icon"),
                    color: field("color"),
                    kind: field("kind"),
                },
                sealed_key: r
                    .sealed_key_id
                    .zip(r.sealed_pek)
                    .map(|(key_id, encrypted_pek)| SealedKeyView {
                        key_id,
                        encrypted_pek,
                    }),
            }
        })
        .collect();
    Ok(Json(invites))
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct MemberView {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub state: String,
    pub invited_by: Option<Uuid>,
    pub deletion_scheduled: bool,
    /// The member holds their own wrapped copy of the project's canonical key
    /// ([`crate::projects::CANONICAL_KEYS`]); false while none exists or a delivery is unopened.
    pub has_key: bool,
    /// The member's X25519 and Ed25519 keys, which clients pin on first use and derive safety
    /// numbers from. The signing key is null until the member's client uploaded one.
    pub public_key: Option<String>,
    pub signing_public_key: Option<String>,
}

/// The [`MemberView`] query; `filter` is the WHERE clause body (plus any ORDER BY).
fn member_view_sql(filter: &str) -> String {
    format!(
        "SELECT pm.user_id, u.email::text AS email, u.display_name, pm.role, pm.state, pm.invited_by,
                (u.deletion_scheduled_at IS NOT NULL) AS deletion_scheduled,
                EXISTS (SELECT 1 FROM project_keys pk
                          JOIN ({canonical}) c
                            ON c.project_id = pk.project_id AND c.key_id = pk.key_id
                         WHERE pk.project_id = pm.project_id AND pk.user_id = pm.user_id
                           AND pk.kind = 'wrapped') AS has_key,
                u.public_key, u.signing_public_key
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE {filter}",
        canonical = crate::projects::CANONICAL_KEYS,
    )
}

async fn member_view(pool: &PgPool, project_id: Uuid, user_id: Uuid) -> AppResult<MemberView> {
    sqlx::query_as::<_, MemberView>(sqlx::AssertSqlSafe(member_view_sql(
        "pm.project_id = $1 AND pm.user_id = $2",
    )))
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

/// `GET /projects/:id/members`: visible to any active member, or the creator of a not-yet-shared
/// project (empty list).
async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
) -> AppResult<Json<Vec<MemberView>>> {
    match membership(&state.pool, project_id, user.user_id).await? {
        Some((_, MemberState::Active)) => {}
        _ => {
            if !is_project_creator(&state.pool, project_id, user.user_id).await? {
                return Err(AppError::NotFound);
            }
        }
    }
    let rows = sqlx::query_as::<_, MemberView>(sqlx::AssertSqlSafe(member_view_sql(
        "pm.project_id = $1 ORDER BY pm.created_at",
    )))
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct InviteRequest {
    pub email: String,
    pub role: String,
}

/// `POST /projects/:id/members`: invite an existing user by email (owner-only; bootstraps the
/// caller as owner on first share). Re-inviting a pending invitee updates the invite; an active
/// member answers 409 `already_member`.
async fn invite_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
    Json(req): Json<InviteRequest>,
) -> AppResult<(StatusCode, Json<MemberView>)> {
    let role = Role::parse(req.role.trim())?;
    if role == Role::Owner {
        return Err(AppError::BadRequest(
            "cannot invite another user as owner".into(),
        ));
    }
    let bootstrap = ensure_can_manage(&state.pool, project_id, user.user_id).await?;

    let invitee: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(req.email.trim())
        .fetch_optional(&state.pool)
        .await?;
    let invitee = invitee.ok_or_else(|| AppError::NotFound)?;
    if invitee == user.user_id {
        return Err(AppError::BadRequest("cannot invite yourself".into()));
    }

    let mut tx = state.pool.begin().await?;
    if bootstrap {
        sqlx::query(
            "INSERT INTO project_members (project_id, user_id, role, state)
             VALUES ($1, $2, 'owner', 'active')
             ON CONFLICT (project_id, user_id) DO NOTHING",
        )
        .bind(project_id)
        .bind(user.user_id)
        .execute(&mut *tx)
        .await?;
    }
    // `clock_timestamp()`, not `now()`: on a first share the owner row must stay the older one,
    // as the earliest owner's key is canonical.
    let n = sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role, state, invited_by, created_at)
         VALUES ($1, $2, $3, 'pending', $4, clock_timestamp())
         ON CONFLICT (project_id, user_id)
             DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, updated_at = now()
             WHERE project_members.state = 'pending'",
    )
    .bind(project_id)
    .bind(invitee)
    .bind(role.as_str())
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::AlreadyMember);
    }
    tx.commit().await?;

    let view = member_view(&state.pool, project_id, invitee).await?;
    let changed: &[Uuid] = if bootstrap {
        &[user.user_id, invitee]
    } else {
        &[invitee]
    };
    broadcast_members(&state, project_id, changed, None).await?;
    Ok((StatusCode::CREATED, Json(view)))
}

/// The active owner whose partition an accept backfill copies: `preferred` if still one, else
/// the earliest.
async fn backfill_owner(
    conn: &mut PgConnection,
    project_id: Uuid,
    preferred: Option<Uuid>,
) -> AppResult<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM project_members
         WHERE project_id = $1 AND role = 'owner' AND state = 'active'
         ORDER BY user_id = $2 DESC, created_at, user_id LIMIT 1",
    )
    .bind(project_id)
    .bind(preferred)
    .fetch_optional(conn)
    .await?)
}

/// `POST /projects/:id/accept`: the invitee accepts their own pending invite.
///
/// The joiner gets the project's state from an owner's partition (the backfill). A large copy is
/// first read without the sync-write lock from one snapshot; the accept then takes the lock and
/// reads again only what changed since (see [`crate::sync::accept_backfill_ops`]). The accept,
/// backfill and refreshed collaborator lists commit together, so a failed backfill leaves the
/// invite pending.
async fn accept_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM project_members
                         WHERE project_id = $1 AND user_id = $2 AND state = 'pending')",
    )
    .bind(project_id)
    .bind(user.user_id)
    .fetch_one(&state.pool)
    .await?;
    if !pending {
        return Err(AppError::NotFound);
    }
    let owner = backfill_owner(&mut *state.pool.acquire().await?, project_id, None).await?;
    let read = match owner {
        Some(owner) => Some(
            crate::sync::BackfillRead::read_unlocked(&state.pool, owner, user.user_id, project_id)
                .await?,
        ),
        None => None,
    };

    let mut tx = state.pool.begin().await?;
    // Before the lock: this row is not one a lock holder waits on.
    let n = sqlx::query(
        "UPDATE project_members SET state = 'active', updated_at = now()
         WHERE project_id = $1 AND user_id = $2 AND state = 'pending'",
    )
    .bind(project_id)
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    crate::sync::take_sync_write_lock(&mut tx).await?;

    let owner = backfill_owner(&mut tx, project_id, owner).await?;
    let backfill = match (owner, read) {
        (Some(owner), Some(read)) if read.owner() == owner => {
            crate::sync::accept_backfill_ops(&mut tx, read).await?
        }
        // The owner read is stale: read the new owner's copy under the lock.
        (Some(owner), _) => {
            let read =
                crate::sync::BackfillRead::read(&mut tx, owner, user.user_id, project_id).await?;
            crate::sync::accept_backfill_ops(&mut tx, read).await?
        }
        (None, _) => Vec::new(),
    };
    let list = member_list_rows(
        &mut tx,
        &state,
        project_id,
        &[user.user_id],
        Some(user.user_id),
    )
    .await?;
    let rows: Vec<(Uuid, &Operation)> = backfill
        .iter()
        .map(|op| (user.user_id, op))
        .chain(list.iter().map(|(member, op)| (*member, op)))
        .collect();
    let batches = crate::sync::apply_to_partitions(&mut tx, &rows).await?;
    tx.commit().await?;
    crate::sync::publish_batches(&state, batches);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /projects/:id/decline`: the invitee declines their own pending invite. Touches only a
/// pending row and delivers no project tombstone (the project was never synced). The row's
/// tombstone goes to the invitee and the active members shown the invite.
async fn decline_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    // An invitee already sent the key could open it: the project rotates it.
    crate::projects::request_rotations(&mut *tx, Some(project_id), &[user.user_id]).await?;
    let n = sqlx::query(
        "DELETE FROM project_members
         WHERE project_id = $1 AND user_id = $2 AND state = 'pending'",
    )
    .bind(project_id)
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    crate::projects::delete_member_keys(&mut *tx, project_id, user.user_id).await?;
    tx.commit().await?;
    let mut recipients: Vec<Uuid> = active_members(&state.pool, project_id)
        .await?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    recipients.push(user.user_id);
    crate::sync::deliver_to_members(
        &state,
        &recipients,
        &[crate::sync::member_delete_op(
            &state,
            project_id,
            user.user_id,
        )],
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct UpdateRoleRequest {
    pub role: String,
}

async fn update_role(
    State(state): State<AppState>,
    user: AuthUser,
    Path((project_id, target)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateRoleRequest>,
) -> AppResult<Json<MemberView>> {
    require_role(&state.pool, project_id, user.user_id, Role::Owner).await?;
    let role = Role::parse(req.role.trim())?;
    let mut tx = state.pool.begin().await?;
    if role != Role::Owner && lock_owners(&mut tx, project_id).await? == [target] {
        return Err(AppError::BadRequest("cannot demote the last owner".into()));
    }
    let n = sqlx::query(
        "UPDATE project_members SET role = $3, updated_at = now()
         WHERE project_id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(target)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    broadcast_members(&state, project_id, &[target], None).await?;
    Ok(Json(member_view(&state.pool, project_id, target).await?))
}

async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((project_id, target)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    if target != user.user_id {
        require_role(&state.pool, project_id, user.user_id, Role::Owner).await?;
    }
    // Removing the sole owner would orphan the project.
    let mut tx = state.pool.begin().await?;
    if lock_owners(&mut tx, project_id).await? == [target] {
        return Err(AppError::BadRequest(
            "cannot remove the last owner; delete the project instead".into(),
        ));
    }
    // A member who held the key keeps it, so the project rotates it. Rolled back if not found.
    crate::projects::request_rotations(&mut *tx, Some(project_id), &[target]).await?;
    let removed_state: Option<String> = sqlx::query_scalar(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING state",
    )
    .bind(project_id)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(removed_state) = removed_state else {
        return Err(AppError::NotFound);
    };
    crate::projects::delete_member_keys(&mut *tx, project_id, target).await?;
    tx.commit().await?;

    // Drop the membership from every remaining member's list and revoke the removed member's
    // copy (`revoke_project_ops`); a revoked invitee loses only their membership entry. A later
    // accept's backfill rewrites whatever these tombstones hide.
    let remaining: Vec<Uuid> = active_members(&state.pool, project_id)
        .await?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    crate::sync::deliver_to_members(
        &state,
        &remaining,
        &[crate::sync::member_delete_op(&state, project_id, target)],
    )
    .await?;
    if removed_state == "active" {
        crate::sync::revoke_project(&state, target, project_id).await?;
    } else {
        crate::sync::deliver_to_members(
            &state,
            &[target],
            &[crate::sync::member_delete_op(&state, project_id, target)],
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Re-deliver each active member's own membership row after a key rotation: a client reloads
/// project keys when its own row changes, which tells it to write under the new key.
pub(crate) async fn announce_key_change(state: &AppState, project_id: Uuid) -> AppResult<()> {
    let mut tx = crate::sync::begin_sync_write(&state.pool).await?;
    let rows: Vec<(Uuid, String, String, String, bool)> = sqlx::query_as(
        "SELECT pm.user_id, u.email::text AS email, u.display_name, pm.role,
                (u.deletion_scheduled_at IS NOT NULL) AS deletion_scheduled
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND pm.state = 'active'",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    let ops: Vec<(Uuid, Operation)> = rows
        .iter()
        .flat_map(|(id, email, display_name, role, deletion_scheduled)| {
            crate::sync::member_set_ops(
                state,
                project_id,
                *id,
                email,
                display_name,
                role,
                "active",
                *deletion_scheduled,
            )
            .into_iter()
            .map(|op| (*id, op))
        })
        .collect();
    let rows: Vec<(Uuid, &Operation)> = ops.iter().map(|(member, op)| (*member, op)).collect();
    let batches = crate::sync::apply_to_partitions(&mut tx, &rows).await?;
    tx.commit().await?;
    crate::sync::publish_batches(state, batches);
    Ok(())
}

/// `POST /projects/:id/claim-ownership`: an active member claims a project whose owners are all
/// scheduled for deletion.
async fn claim_ownership(
    State(state): State<AppState>,
    user: AuthUser,
    Path(project_id): Path<Uuid>,
) -> AppResult<Json<MemberView>> {
    let (caller_role, caller_state) = membership(&state.pool, project_id, user.user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("not a member of this project".into()))?;

    if caller_state != MemberState::Active {
        return Err(AppError::Forbidden(
            "only active members can claim ownership".into(),
        ));
    }

    if caller_role == Role::Owner {
        return Ok(Json(
            member_view(&state.pool, project_id, user.user_id).await?,
        ));
    }

    let active_owners: Vec<(Uuid, bool)> = sqlx::query_as(
        "SELECT pm.user_id, (u.deletion_scheduled_at IS NOT NULL) AS deletion_scheduled
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND pm.role = 'owner' AND pm.state = 'active'",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    let any_unscheduled_owner = active_owners.iter().any(|(_, scheduled)| !scheduled);
    if any_unscheduled_owner {
        return Err(AppError::BadRequest(
            "cannot claim ownership while an active owner is not scheduled for deletion".into(),
        ));
    }

    let mut tx = state.pool.begin().await?;
    let mut changed: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE project_members SET role = 'editor', updated_at = now()
         WHERE project_id = $1 AND role = 'owner'
         RETURNING user_id",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    changed.push(user.user_id);

    sqlx::query(
        "UPDATE project_members SET role = 'owner', updated_at = now()
         WHERE project_id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(user.user_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    broadcast_members(&state, project_id, &changed, None).await?;
    Ok(Json(
        member_view(&state.pool, project_id, user.user_id).await?,
    ))
}
