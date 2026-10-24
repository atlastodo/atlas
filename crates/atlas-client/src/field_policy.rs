//! What of an entity leaves the device readable (`fieldPolicy.ts`, sync protocol 7: see
//! `docs/decisions/0006-opaque-sync-metadata.md`): the wire kind it travels as, the few field names
//! that travel as they are instead of an opaque tag, and which of those carry a plaintext value.
//! Everything else, including a field no manifest names yet, travels tagged and encrypted. The tables
//! are the bundled app manifests (`manifests/*.json`, compiled in by `atlas-core`).

use atlas_core::{EntityKind, PlaintextFields, Registry};

/// Whether a value of `entity`.`field` is end-to-end encrypted (protocol 7). An unknown kind
/// encrypts everything.
pub fn should_encrypt_field(entity: &str, field: &str) -> bool {
    Registry::bundled()
        .kind(entity)
        .is_none_or(|k| !k.plaintext_fields.contains(field))
}

/// The wire kind `kind` travels as; `None` for a kind no bundled manifest names.
pub fn wire_kind_of(kind: &str) -> Option<&'static str> {
    Registry::bundled().kind(kind).map(|k| k.wire.as_str())
}

/// Whether `field` of `kind` goes on the wire under its name rather than an opaque tag.
pub fn is_public_field(kind: &str, field: &str) -> bool {
    Registry::bundled().kind(kind).is_some_and(|k| {
        matches!(k.plaintext_fields, PlaintextFields::All)
            || k.public_fields.iter().any(|f| f == field)
    })
}

/// Whether protocol 6 encrypted a value of `kind`.`field`: how a legacy row is read.
pub fn legacy_encrypted(kind: &str, field: &str) -> bool {
    Registry::bundled().kind(kind).is_none_or(|k| {
        !matches!(k.plaintext_fields, PlaintextFields::All)
            && !k.legacy_plaintext_fields.iter().any(|f| f == field)
    })
}

/// Whether `name` is the wire kind of rows written before protocol 7: a real kind that now travels
/// as another.
pub fn is_legacy_wire_kind(name: &str) -> bool {
    Registry::bundled()
        .kind(name)
        .is_some_and(|k| k.wire != name)
}

/// The real kinds that travel as `wire`.
pub fn kinds_of_wire(wire: &str) -> Vec<EntityKind> {
    EntityKind::ALL
        .into_iter()
        .filter(|k| wire_kind_of(k.as_str()) == Some(wire))
        .collect()
}

/// The real kind a public field names on `wire` (`blob_sha` on `todo.sealed` is an attachment's), or
/// the wire kind's only real kind.
pub fn real_kind_of(wire: &str, public_field: Option<&str>) -> Option<EntityKind> {
    let kinds = kinds_of_wire(wire);
    if kinds.len() == 1 {
        return kinds.first().copied();
    }
    let field = public_field?;
    let naming: Vec<EntityKind> = kinds
        .into_iter()
        .filter(|k| is_public_field(k.as_str(), field))
        .collect();
    (naming.len() == 1).then(|| naming[0])
}

/// Whether `name` is a current sealed wire kind (not legacy, not server-authored).
pub fn is_sealed_wire_kind(name: &str) -> bool {
    name != "project_member" && !is_legacy_wire_kind(name) && !kinds_of_wire(name).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_decides() {
        assert!(should_encrypt_field("task", "title"));
        assert!(should_encrypt_field("task", "project_id"));
        assert!(!legacy_encrypted("task", "project_id"));
        assert!(should_encrypt_field("comment", "task_id"));
        assert!(!should_encrypt_field("attachment", "blob_sha"));
        assert!(is_public_field("attachment", "blob_sha"));
        assert!(is_public_field("project", "archived_at"));
        assert!(should_encrypt_field("project", "archived_at"));
        assert!(!should_encrypt_field("project_member", "anything"));
        assert!(should_encrypt_field("notes.note", "body"));
        assert_eq!(wire_kind_of("task"), Some("todo.sealed"));
        assert_eq!(wire_kind_of("project"), Some("todo.project"));
        assert_eq!(wire_kind_of("vault.item"), Some("vault.sealed"));
        assert_eq!(
            real_kind_of("todo.project", None),
            Some(EntityKind::Project)
        );
        assert_eq!(real_kind_of("todo.sealed", None), None);
        assert_eq!(
            real_kind_of("todo.sealed", Some("blob_sha")),
            Some(EntityKind::Attachment)
        );
        assert!(is_legacy_wire_kind("task") && !is_legacy_wire_kind("project_member"));
        assert!(is_sealed_wire_kind("journal.sealed") && !is_sealed_wire_kind("journal.entry"));
    }

    /// `test-vectors/field_policy_vectors.json`, which `fieldPolicy.test.ts` asserts too.
    #[test]
    fn field_policy_vectors() {
        let path = format!(
            "{}/../../test-vectors/field_policy_vectors.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for c in doc["fields"].as_array().unwrap() {
            let (entity, field) = (c["entity"].as_str().unwrap(), c["field"].as_str().unwrap());
            let what = format!("{entity}.{field}");
            assert_eq!(wire_kind_of(entity), c["wire"].as_str(), "{what}");
            assert_eq!(
                is_public_field(entity, field),
                c["public"].as_bool().unwrap(),
                "{what}"
            );
            assert_eq!(
                should_encrypt_field(entity, field),
                c["encrypted"].as_bool().unwrap(),
                "{what}"
            );
            assert_eq!(
                legacy_encrypted(entity, field),
                c["legacy_encrypted"].as_bool().unwrap(),
                "{what}"
            );
        }
        let registry = Registry::bundled();
        for c in doc["token_policies"].as_array().unwrap() {
            let apps: Vec<&str> = c["apps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap())
                .collect();
            let policy = atlas_core::TokenPolicy::strictest(
                apps.iter().map(|a| &registry.app(a).unwrap().api_tokens),
            );
            let p = &c["policy"];
            assert_eq!(
                (
                    policy.expiry_required,
                    policy.max_lifetime_days.map(u64::from),
                    policy.write_by_default,
                    policy.exclusive
                ),
                (
                    p["expiry_required"].as_bool().unwrap(),
                    p["max_lifetime_days"].as_u64(),
                    p["write_by_default"].as_bool().unwrap(),
                    p["exclusive"].as_bool().unwrap()
                ),
                "{apps:?}"
            );
        }
    }
}
