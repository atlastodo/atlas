//! The sync operation log.
//!
//! Clients never mutate rows in place; every change is recorded as an [`Operation`] — a single
//! field assignment (or tombstone) stamped with an [`Hlc`]. Operations are what gets pushed to
//! and pulled from the server. Applying an op is just a field-level LWW merge, so replaying a
//! set of ops in any order yields the same state.

use crate::hlc::Hlc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The entity kinds that participate in sync, as clients know them. The server sees them only on
/// rows written before protocol 7 ([`WireKind::Legacy`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Task,
    Project,
    Section,
    Label,
    Comment,
    Preference,
    /// A saved filter / smart list, synced generically.
    SavedFilter,
    /// A task reminder, synced generically.
    Reminder,
    /// A shared-project membership. Server-authored: written into each member's partition;
    /// clients never push them.
    ProjectMember,
    /// An activity-feed entry for a key task change; fans out like a comment on shared projects.
    Activity,
    /// A logged focus session against a task. User-private.
    FocusSession,
    /// A habit. User-private.
    Habit,
    /// A single day's check-in for a habit. User-private.
    HabitCheckin,
    /// A task attachment's metadata; the ciphertext travels via `/attachments/blobs/:sha256`.
    /// Link fields (`task_id`, `blob_sha`, `thumb_sha`) are plaintext and must not join the
    /// client's SENSITIVE_FIELDS; the encrypted `meta` payload uses its own `__aenc:1` marker.
    Attachment,
    /// An Atlas Journal entry (`manifests/journal.json`). Personal: never fanned out to another
    /// account, and the server reads none of its fields.
    #[serde(rename = "journal.entry")]
    JournalEntry,
    /// An Atlas Journal setting. Personal, like [`EntityKind::JournalEntry`].
    #[serde(rename = "journal.preference")]
    JournalPreference,
    /// An Atlas Vault item (`manifests/vault.json`): a login, note, card, identity, SSH key or API
    /// key. Personal: never fanned out to another account, and the server reads none of its
    /// fields, not even its type or folder.
    #[serde(rename = "vault.item")]
    VaultItem,
    /// An Atlas Vault folder. Personal, like [`EntityKind::VaultItem`].
    #[serde(rename = "vault.folder")]
    VaultFolder,
    /// An Atlas Vault setting. Personal, like [`EntityKind::VaultItem`].
    #[serde(rename = "vault.preference")]
    VaultPreference,
}

impl EntityKind {
    /// Every kind, in declaration order.
    pub const ALL: [EntityKind; 19] = [
        EntityKind::Task,
        EntityKind::Project,
        EntityKind::Section,
        EntityKind::Label,
        EntityKind::Comment,
        EntityKind::Preference,
        EntityKind::SavedFilter,
        EntityKind::Reminder,
        EntityKind::ProjectMember,
        EntityKind::Activity,
        EntityKind::FocusSession,
        EntityKind::Habit,
        EntityKind::HabitCheckin,
        EntityKind::Attachment,
        EntityKind::JournalEntry,
        EntityKind::JournalPreference,
        EntityKind::VaultItem,
        EntityKind::VaultFolder,
        EntityKind::VaultPreference,
    ];

    /// The kind's wire name (its serde form), as the manifests and the op store key it.
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Task => "task",
            EntityKind::Project => "project",
            EntityKind::Section => "section",
            EntityKind::Label => "label",
            EntityKind::Comment => "comment",
            EntityKind::Preference => "preference",
            EntityKind::SavedFilter => "saved_filter",
            EntityKind::Reminder => "reminder",
            EntityKind::ProjectMember => "project_member",
            EntityKind::Activity => "activity",
            EntityKind::FocusSession => "focus_session",
            EntityKind::Habit => "habit",
            EntityKind::HabitCheckin => "habit_checkin",
            EntityKind::Attachment => "attachment",
            EntityKind::JournalEntry => "journal.entry",
            EntityKind::JournalPreference => "journal.preference",
            EntityKind::VaultItem => "vault.item",
            EntityKind::VaultFolder => "vault.folder",
            EntityKind::VaultPreference => "vault.preference",
        }
    }

    /// The kind with this wire name.
    pub fn from_wire(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == name)
    }
}

/// A single change to one field of one entity, or a delete (tombstone), as clients hold it: the
/// real kind and field name. On the wire it travels as a [`WireOperation`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Operation {
    /// Client-generated UUIDv7 for the op itself; also the idempotency key on the server.
    pub id: Uuid,
    pub entity: EntityKind,
    /// The target entity's client-generated UUIDv7 (created offline, stable forever).
    pub entity_id: Uuid,
    /// The op payload: a field write or a delete.
    #[serde(flatten)]
    pub change: Change,
    /// HLC timestamp; drives last-writer-wins ordering.
    pub ts: Hlc,
}

/// What an [`Operation`] does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    /// Set `field` to `value` (a JSON scalar/object for that field).
    Set {
        field: String,
        value: serde_json::Value,
    },
    /// Tombstone the entity. Tombstones are retained so deletes propagate and win over
    /// stale concurrent edits with an earlier timestamp.
    Delete,
}

impl Operation {
    pub fn set(
        entity: EntityKind,
        entity_id: Uuid,
        field: &str,
        value: serde_json::Value,
        ts: Hlc,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            entity,
            entity_id,
            change: Change::Set {
                field: field.to_string(),
                value,
            },
            ts,
        }
    }

    pub fn delete(entity: EntityKind, entity_id: Uuid, ts: Hlc) -> Self {
        Self {
            id: Uuid::now_v7(),
            entity,
            entity_id,
            change: Change::Delete,
            ts,
        }
    }
}

/// The kind an op carries on the wire (sync protocol 7, `docs/decisions/0006-opaque-sync-metadata.md`).
/// The server sees only these: whether an entity is a todo project, some other todo entity, a
/// journal or vault entity, or a membership row it wrote itself. The real [`EntityKind`] travels
/// inside the encrypted value. [`WireKind::Legacy`] names a row written before protocol 7 under
/// its real kind, which stays readable until its client migrates it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WireKind {
    /// A todo project: the server needs it for its creator, its owner-only fields and its
    /// tombstones.
    TodoProject,
    /// Every other todo entity: task, section, label, comment, attachment, ….
    TodoSealed,
    /// A shared-project membership. Server-authored: clients never push it.
    ProjectMember,
    /// Every Atlas Journal entity.
    JournalSealed,
    /// Every Atlas Vault entity.
    VaultSealed,
    /// A row written before protocol 7, under its real kind (never [`EntityKind::ProjectMember`]).
    Legacy(EntityKind),
}

impl WireKind {
    /// Every current (non-legacy) wire kind.
    pub const CURRENT: [WireKind; 5] = [
        WireKind::TodoProject,
        WireKind::TodoSealed,
        WireKind::ProjectMember,
        WireKind::JournalSealed,
        WireKind::VaultSealed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            WireKind::TodoProject => "todo.project",
            WireKind::TodoSealed => "todo.sealed",
            WireKind::ProjectMember => "project_member",
            WireKind::JournalSealed => "journal.sealed",
            WireKind::VaultSealed => "vault.sealed",
            WireKind::Legacy(kind) => kind.as_str(),
        }
    }

    /// The wire kind with this name: a current one, or a legacy one named by a real kind.
    pub fn from_wire(name: &str) -> Option<Self> {
        if let Some(kind) = Self::CURRENT.into_iter().find(|k| k.as_str() == name) {
            return Some(kind);
        }
        EntityKind::from_wire(name)
            .filter(|kind| *kind != EntityKind::ProjectMember)
            .map(WireKind::Legacy)
    }

    pub fn is_legacy(self) -> bool {
        matches!(self, WireKind::Legacy(_))
    }
}

impl Serialize for WireKind {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for WireKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let name = String::deserialize(d)?;
        WireKind::from_wire(&name)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown entity kind: {name}")))
    }
}

/// An op as the server stores and relays it (sync protocol 7): a wire kind, the scope whose key
/// encrypted it, and a field that is an opaque tag or a public name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireOperation {
    /// Client-generated UUID for the op itself; also the idempotency key on the server.
    pub id: Uuid,
    pub entity: WireKind,
    /// The target entity's client-generated UUID (created offline, stable forever).
    pub entity_id: Uuid,
    /// The project whose key encrypted the op, or `None` for the account's own key. The server
    /// routes and authorizes by it.
    #[serde(default)]
    pub scope: Option<Uuid>,
    #[serde(flatten)]
    pub change: Change,
    pub ts: Hlc,
    /// The account that pushed the op, which the server sets on every op it delivers (`None` for
    /// its own). Ignored on push.
    #[serde(default)]
    pub pushed_by: Option<Uuid>,
}

impl WireOperation {
    pub fn set(
        entity: WireKind,
        entity_id: Uuid,
        scope: Option<Uuid>,
        field: &str,
        value: serde_json::Value,
        ts: Hlc,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            entity,
            entity_id,
            scope,
            change: Change::Set {
                field: field.to_string(),
                value,
            },
            ts,
            pushed_by: None,
        }
    }

    pub fn delete(entity: WireKind, entity_id: Uuid, scope: Option<Uuid>, ts: Hlc) -> Self {
        Self {
            id: Uuid::now_v7(),
            entity,
            entity_id,
            scope,
            change: Change::Delete,
            ts,
            pushed_by: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts() -> Hlc {
        Hlc {
            wall_ms: 1,
            counter: 0,
            node: Uuid::from_u128(1),
        }
    }

    #[test]
    fn set_operation_round_trips_through_json() {
        let op = Operation::set(
            EntityKind::Task,
            Uuid::from_u128(42),
            "title",
            serde_json::json!("Buy milk"),
            ts(),
        );
        let encoded = serde_json::to_string(&op).unwrap();
        let decoded: Operation = serde_json::from_str(&encoded).unwrap();
        assert_eq!(op, decoded);
    }

    #[test]
    fn delete_operation_round_trips_through_json() {
        let op = Operation::delete(EntityKind::Task, Uuid::from_u128(42), ts());
        let encoded = serde_json::to_string(&op).unwrap();
        let decoded: Operation = serde_json::from_str(&encoded).unwrap();
        assert_eq!(op, decoded);
        assert!(matches!(decoded.change, Change::Delete));
    }

    #[test]
    fn saved_filter_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::SavedFilter,
            Uuid::from_u128(9),
            "query",
            serde_json::json!("@work & p1"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "saved_filter");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::SavedFilter);
    }

    #[test]
    fn reminder_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::Reminder,
            Uuid::from_u128(11),
            "at",
            serde_json::json!(1_700_000_000_000i64),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "reminder");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::Reminder);
    }

    #[test]
    fn project_member_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::ProjectMember,
            Uuid::from_u128(13),
            "role",
            serde_json::json!("editor"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "project_member");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::ProjectMember);
    }

    #[test]
    fn activity_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::Activity,
            Uuid::from_u128(15),
            "kind",
            serde_json::json!("status"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "activity");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::Activity);
    }

    #[test]
    fn focus_session_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::FocusSession,
            Uuid::from_u128(17),
            "duration_ms",
            serde_json::json!(1_500_000i64),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "focus_session");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::FocusSession);
    }

    #[test]
    fn habit_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::Habit,
            Uuid::from_u128(19),
            "name",
            serde_json::json!("Meditate"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "habit");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::Habit);
    }

    #[test]
    fn habit_checkin_entity_kind_serializes_snake_case_and_round_trips() {
        let op = Operation::set(
            EntityKind::HabitCheckin,
            Uuid::from_u128(21),
            "date",
            serde_json::json!("2026-07-06"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "habit_checkin");

        let decoded: Operation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        assert_eq!(decoded.entity, EntityKind::HabitCheckin);
    }

    #[test]
    fn wire_names_match_serde() {
        for kind in EntityKind::ALL {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
            assert_eq!(EntityKind::from_wire(kind.as_str()), Some(kind));
        }
        assert_eq!(EntityKind::from_wire("notes.note"), None);
        assert_eq!(
            EntityKind::from_wire("journal.entry"),
            Some(EntityKind::JournalEntry)
        );
        assert_eq!(EntityKind::from_wire("entry"), None);
        assert_eq!(
            EntityKind::from_wire("vault.item"),
            Some(EntityKind::VaultItem)
        );
        assert_eq!(EntityKind::from_wire("item"), None);
    }

    #[test]
    fn wire_kinds_round_trip_and_name_legacy_rows_by_their_real_kind() {
        for wire in WireKind::CURRENT {
            assert_eq!(serde_json::to_value(wire).unwrap(), wire.as_str());
            assert_eq!(WireKind::from_wire(wire.as_str()), Some(wire));
            assert!(!wire.is_legacy());
        }
        assert_eq!(
            WireKind::from_wire("task"),
            Some(WireKind::Legacy(EntityKind::Task))
        );
        assert_eq!(
            WireKind::from_wire("vault.item"),
            Some(WireKind::Legacy(EntityKind::VaultItem))
        );
        assert_eq!(
            WireKind::from_wire("project_member"),
            Some(WireKind::ProjectMember)
        );
        assert_eq!(WireKind::from_wire("sealed"), None);
        let op = WireOperation::set(
            WireKind::TodoSealed,
            Uuid::from_u128(42),
            Some(Uuid::from_u128(7)),
            "0123456789abcdef0123456789abcdef",
            serde_json::json!({"__enc": 3}),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["entity"], "todo.sealed");
        assert_eq!(v["scope"], Uuid::from_u128(7).to_string());
        assert!(v["pushed_by"].is_null());
        let decoded: WireOperation = serde_json::from_value(v).unwrap();
        assert_eq!(op, decoded);
        // A client may leave out scope and pushed_by.
        let bare: WireOperation = serde_json::from_value(serde_json::json!({
            "id": Uuid::from_u128(1), "entity": "journal.sealed", "entity_id": Uuid::from_u128(2),
            "op": "delete", "ts": {"wall_ms": 1, "counter": 0, "node": Uuid::from_u128(1)}
        }))
        .unwrap();
        assert_eq!((bare.scope, bare.pushed_by), (None, None));
        assert!(serde_json::from_value::<WireOperation>(serde_json::json!({
            "id": Uuid::from_u128(1), "entity": "sealed", "entity_id": Uuid::from_u128(2),
            "op": "delete", "ts": {"wall_ms": 1, "counter": 0, "node": Uuid::from_u128(1)}
        }))
        .is_err());
    }

    #[test]
    fn set_change_serializes_with_tagged_op_field() {
        let op = Operation::set(
            EntityKind::Label,
            Uuid::from_u128(7),
            "color",
            serde_json::json!("#ff0000"),
            ts(),
        );
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(v["op"], "set");
        assert_eq!(v["field"], "color");
        assert_eq!(v["entity"], "label");
    }
}
