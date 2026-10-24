//! The sync wire format, protocol 7 (`wire.ts`; `docs/decisions/0006-opaque-sync-metadata.md`).
//!
//! On the wire an op names a wire kind (`todo.sealed`, …) instead of its real kind, the scope whose
//! key encrypted it (`scope`: a project id, or null for the account's own key), and a field that is
//! an opaque per-entity tag unless the manifest makes it public. The real kind and field travel
//! inside the value's v3 envelope. Rows written before protocol 7 carry their real kind as the wire
//! kind and are read as before.

use atlas_core::{Change, EntityKind, Hlc, Operation};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::crypto::Keyring;
use crate::crypto::{
    field_tag, field_tag_key, open_sealed_field, seal_field, FieldEnvelope, FieldLocation,
    KeyScope, SealedField, DEK_KEY_ID,
};
use crate::error::{Error, Result};
use crate::field_policy::{
    is_legacy_wire_kind, is_public_field, kinds_of_wire, legacy_encrypted, real_kind_of,
    should_encrypt_field, wire_kind_of,
};
use crate::scope::ScopeKey;
use crate::store::{op_entity_id, OpenedSealed, SealedPending, Store};

/// The wire name of `field` of `kind` entity `id` under `key`: its tag, or the field when public.
pub fn wire_field_of(key: &[u8; 32], kind: &str, id: &str, field: &str) -> String {
    if is_public_field(kind, field) {
        field.to_owned()
    } else {
        field_tag(&field_tag_key(key), id, kind, field)
    }
}

/// `op` on the wire, with `k`, the key of its scope.
pub fn encode_op(op: &Operation, k: &ScopeKey) -> Result<Value> {
    let kind = op.entity.as_str();
    let wire = wire_kind_of(kind)
        .filter(|w| *w != "project_member")
        .ok_or_else(|| Error::Protocol(format!("cannot push {kind} ops")))?;
    let id = op_entity_id(op);
    let scope = match &k.scope {
        KeyScope::Personal => Value::Null,
        KeyScope::Project(p) => Value::from(p.as_str()),
    };
    let ts = json!({ "wall_ms": op.ts.wall_ms, "counter": op.ts.counter, "node": op.ts.node });
    Ok(match &op.change {
        Change::Delete => json!({
            "id": op.id, "entity": wire, "entity_id": id, "scope": scope, "op": "delete", "ts": ts,
        }),
        Change::Set { field, value } => {
            let wire_field = wire_field_of(&k.key, kind, &id, field);
            let value = if should_encrypt_field(kind, field) {
                let at = FieldLocation {
                    entity: wire,
                    entity_id: &id,
                    field: &wire_field,
                };
                let sealed = SealedField {
                    kind: kind.to_owned(),
                    field: field.clone(),
                    value: value.clone(),
                };
                seal_field(&k.key, &k.key_id, &k.scope, at, &sealed)?.to_value()
            } else {
                value.clone()
            };
            json!({
                "id": op.id, "entity": wire, "entity_id": id, "scope": scope, "op": "set",
                "field": wire_field, "value": value, "ts": ts,
            })
        }
    })
}

/// Open a v3 value that arrived as `wire`.`wire_field` of `id` in `scope`: only with a held key of
/// that scope, only when its plaintext names a kind of that wire kind, and only when the wire field
/// is that field's tag (or the field itself, when public).
pub fn open_sealed(
    keyring: &Keyring,
    wire: &str,
    id: &str,
    wire_field: &str,
    scope: Option<&str>,
    envelope: &FieldEnvelope,
) -> Option<OpenedSealed> {
    let (key, key_scope) = match scope {
        None if envelope.kid == DEK_KEY_ID => (*keyring.dek(), KeyScope::Personal),
        None => return None,
        Some(p) => (
            *keyring.project_key(p, &envelope.kid)?,
            KeyScope::Project(p.to_owned()),
        ),
    };
    let at = FieldLocation {
        entity: wire,
        entity_id: id,
        field: wire_field,
    };
    let sealed = open_sealed_field(&key, &key_scope, at, envelope).ok()?;
    let kind = EntityKind::from_wire(&sealed.kind)?;
    if wire_kind_of(kind.as_str()) != Some(wire)
        || wire_field_of(&key, kind.as_str(), id, &sealed.field) != wire_field
    {
        return None;
    }
    Some(OpenedSealed {
        kind,
        field: sealed.field,
        value: sealed.value,
        key_id: envelope.kid.clone(),
        scope: key_scope,
    })
}

/// One decoded wire op.
pub struct Decoded {
    pub op: Operation,
    /// For a value opened from a v3 envelope: the key and scope it opened with.
    pub opened: Option<(String, KeyScope)>,
    /// It arrived under a legacy kind.
    pub legacy: bool,
}

/// What a page decodes to besides its ops: values kept sealed and tombstones without a kind.
#[derive(Debug, Clone, Default)]
pub struct Aside {
    pub sealed: Vec<SealedPending>,
    pub tombstones: Vec<(String, Hlc, Uuid)>,
}

fn parse_ts(w: &Value) -> Option<Hlc> {
    serde_json::from_value(w.get("ts")?.clone()).ok()
}

/// Decode one page of wire ops (`decodeOps`). `open_legacy` reads a protocol 6 value by the old
/// rules (`None` drops it). A delete takes the kind of the entity this page or `store` knows by its
/// id, else waits aside; a value no held key opens waits aside sealed.
pub fn decode_ops(
    wire_ops: &[Value],
    keyring: &Keyring,
    store: &Store,
    mut open_legacy: impl FnMut(Operation) -> Option<Operation>,
) -> (Vec<Decoded>, Aside) {
    let mut out: Vec<Decoded> = Vec::new();
    let mut aside = Aside::default();
    let mut page_kinds: Vec<(String, EntityKind)> = Vec::new();
    let mut kindless: Vec<(String, Hlc, Uuid)> = Vec::new();
    for w in wire_ops {
        let entity = w.get("entity").and_then(Value::as_str).unwrap_or_default();
        let (Some(id), Some(op_id), Some(ts)) = (
            w.get("entity_id").and_then(Value::as_str),
            w.get("id")
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok()),
            parse_ts(w),
        ) else {
            continue;
        };
        let Ok(entity_uuid) = Uuid::parse_str(id) else {
            continue;
        };
        let is_delete = w.get("op").and_then(Value::as_str) == Some("delete");
        let make = |kind: EntityKind, change: Change| Operation {
            id: op_id,
            entity: kind,
            entity_id: entity_uuid,
            change,
            ts,
        };
        if is_legacy_wire_kind(entity) || entity == "project_member" {
            let Some(kind) = EntityKind::from_wire(entity) else {
                continue;
            };
            page_kinds.push((id.to_owned(), kind));
            let legacy = entity != "project_member";
            if is_delete {
                out.push(Decoded {
                    op: make(kind, Change::Delete),
                    opened: None,
                    legacy,
                });
                continue;
            }
            let (Some(field), Some(value)) =
                (w.get("field").and_then(Value::as_str), w.get("value"))
            else {
                continue;
            };
            let op = make(
                kind,
                Change::Set {
                    field: field.to_owned(),
                    value: value.clone(),
                },
            );
            if !legacy || !legacy_encrypted(entity, field) {
                out.push(Decoded {
                    op,
                    opened: None,
                    legacy,
                });
            } else if let Some(op) = open_legacy(op) {
                out.push(Decoded {
                    op,
                    opened: None,
                    legacy,
                });
            }
            continue;
        }
        if kinds_of_wire(entity).is_empty() {
            continue; // a kind this build does not know: nothing here could show it
        }
        if is_delete {
            match real_kind_of(entity, None).or_else(|| store.kind_of(id)) {
                Some(kind) => out.push(Decoded {
                    op: make(kind, Change::Delete),
                    opened: None,
                    legacy: false,
                }),
                None => kindless.push((id.to_owned(), ts, op_id)),
            }
            continue;
        }
        let (Some(field), Some(value)) = (w.get("field").and_then(Value::as_str), w.get("value"))
        else {
            continue;
        };
        let scope = w.get("scope").and_then(Value::as_str);
        if let Some(kind) = real_kind_of(entity, Some(field)).filter(|k| {
            is_public_field(k.as_str(), field) && !should_encrypt_field(k.as_str(), field)
        }) {
            page_kinds.push((id.to_owned(), kind));
            let change = Change::Set {
                field: field.to_owned(),
                value: value.clone(),
            };
            out.push(Decoded {
                op: make(kind, change),
                opened: None,
                legacy: false,
            });
            continue;
        }
        let Some(envelope) = FieldEnvelope::from_value_v3(value) else {
            continue; // no sealed envelope: dropped
        };
        let Some(opened) = open_sealed(keyring, entity, id, field, scope, &envelope) else {
            aside.sealed.push(SealedPending {
                wire: entity.to_owned(),
                entity_id: id.to_owned(),
                field: field.to_owned(),
                scope: scope.map(str::to_owned),
                envelope,
                ts,
            });
            continue;
        };
        if opened.kind == EntityKind::Activity && opened.field == "actor_id" {
            // The server says who pushed an op; an activity naming someone else is forged.
            let pushed_by = w.get("pushed_by").and_then(Value::as_str);
            if pushed_by.is_none() || opened.value.as_str() != pushed_by {
                continue;
            }
        }
        page_kinds.push((id.to_owned(), opened.kind));
        let change = Change::Set {
            field: opened.field,
            value: opened.value,
        };
        out.push(Decoded {
            op: make(opened.kind, change),
            opened: Some((opened.key_id, opened.scope)),
            legacy: false,
        });
    }
    // A delete whose entity only this page names.
    for (id, ts, op_id) in kindless {
        match page_kinds.iter().find(|(i, _)| *i == id) {
            Some((_, kind)) => out.push(Decoded {
                op: Operation {
                    id: op_id,
                    entity: *kind,
                    entity_id: Uuid::parse_str(&id).expect("parsed above"),
                    change: Change::Delete,
                    ts,
                },
                opened: None,
                legacy: false,
            }),
            None => aside.tombstones.push((id, ts, op_id)),
        }
    }
    (out, aside)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> (Keyring, ScopeKey, ScopeKey) {
        let mut keyring = Keyring::new([7u8; 32], [8u8; 32], None);
        let key_id = keyring.set_project_key("p1", [9u8; 32]);
        let personal = ScopeKey {
            key: [7u8; 32],
            key_id: DEK_KEY_ID.into(),
            scope: KeyScope::Personal,
        };
        let project = ScopeKey {
            key: [9u8; 32],
            key_id,
            scope: KeyScope::Project("p1".into()),
        };
        (keyring, personal, project)
    }

    fn set(kind: EntityKind, id: Uuid, field: &str, value: Value) -> Operation {
        Operation::set(
            kind,
            id,
            field,
            value,
            Hlc {
                wall_ms: 5,
                counter: 0,
                node: Uuid::nil(),
            },
        )
    }

    #[test]
    fn encodes_and_decodes_like_the_typescript_client() {
        let (keyring, personal, project) = keys();
        let store = Store::new(Uuid::nil());
        let task = Uuid::new_v4();
        let title = encode_op(
            &set(EntityKind::Task, task, "title", json!("Secret")),
            &project,
        )
        .unwrap();
        assert_eq!(title["entity"], "todo.sealed");
        assert_eq!(title["scope"], "p1");
        assert_eq!(title["field"].as_str().unwrap().len(), 32);
        assert_eq!(title["value"]["__enc"], 3);
        assert!(!title.to_string().contains("Secret") && !title.to_string().contains("title"));
        let blob = encode_op(
            &set(
                EntityKind::Attachment,
                Uuid::new_v4(),
                "blob_sha",
                json!("a".repeat(64)),
            ),
            &personal,
        )
        .unwrap();
        assert_eq!(
            (blob["field"].as_str(), blob["scope"].is_null()),
            (Some("blob_sha"), true)
        );

        let (ops, aside) = decode_ops(&[title.clone(), blob], &keyring, &store, Some);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].op.entity, EntityKind::Task);
        assert!(
            matches!(&ops[0].op.change, Change::Set { field, value } if field == "title" && value == "Secret")
        );
        assert_eq!(ops[1].op.entity, EntityKind::Attachment);
        assert!(aside.sealed.is_empty());

        // Without the project key the title waits sealed; moved under another tag it never opens.
        let bare = Keyring::new([7u8; 32], [8u8; 32], None);
        let (ops, aside) = decode_ops(std::slice::from_ref(&title), &bare, &store, Some);
        assert!(ops.is_empty());
        assert_eq!(aside.sealed.len(), 1);
        let mut moved = title.clone();
        moved["field"] = json!("0".repeat(32));
        let (ops, aside) = decode_ops(&[moved], &keyring, &store, Some);
        assert!(ops.is_empty() && aside.sealed.len() == 1);
    }

    #[test]
    fn an_activity_actor_must_be_its_pusher_and_a_delete_finds_its_kind() {
        let (keyring, _, project) = keys();
        let store = Store::new(Uuid::nil());
        let activity = Uuid::new_v4();
        let mut actor = encode_op(
            &set(EntityKind::Activity, activity, "actor_id", json!("me")),
            &project,
        )
        .unwrap();
        actor["pushed_by"] = json!("someone else");
        assert!(
            decode_ops(std::slice::from_ref(&actor), &keyring, &store, Some)
                .0
                .is_empty()
        );
        actor["pushed_by"] = json!("me");
        assert_eq!(decode_ops(&[actor], &keyring, &store, Some).0.len(), 1);

        let id = Uuid::new_v4();
        let del = encode_op(
            &Operation::delete(
                EntityKind::Comment,
                id,
                Hlc {
                    wall_ms: 9,
                    counter: 0,
                    node: Uuid::nil(),
                },
            ),
            &project,
        )
        .unwrap();
        let body = encode_op(&set(EntityKind::Comment, id, "body", json!("x")), &project).unwrap();
        let (ops, _) = decode_ops(&[del.clone(), body], &keyring, &store, Some);
        assert!(ops
            .iter()
            .any(|d| d.op.entity == EntityKind::Comment && matches!(d.op.change, Change::Delete)));
        let (ops, aside) = decode_ops(&[del], &keyring, &store, Some);
        assert!(ops.is_empty());
        assert_eq!(aside.tombstones.len(), 1);
    }
}
