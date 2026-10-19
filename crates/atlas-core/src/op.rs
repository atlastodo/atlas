//! The sync operation log.
//!
//! Clients never mutate rows in place; every change is recorded as an [`Operation`] — a single
//! field assignment (or tombstone) stamped with an [`Hlc`]. Operations are what gets pushed to
//! and pulled from the server. Applying an op is just a field-level LWW merge, so replaying a
//! set of ops in any order yields the same state.

use crate::hlc::Hlc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The entity kinds that participate in sync, explicit so the server can validate and route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

/// A single change to one field of one entity, or a delete (tombstone).
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
