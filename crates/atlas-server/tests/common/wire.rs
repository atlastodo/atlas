//! Sync protocol 7 ops as a client pushes them, without the cryptography
//! (`docs/decisions/0006-opaque-sync-metadata.md`). The server compares field tags and never opens
//! a value, so a test stands in a tag derived from the field's name and an envelope that carries
//! the value readably in `ct`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// The wire kind of a todo project.
pub const PROJECT: &str = "todo.project";
/// The wire kind of every other todo entity.
pub const SEALED: &str = "todo.sealed";

/// A field tag standing in for the field `name`: 32 lowercase hex digits, distinct per name.
pub fn tag(name: &str) -> String {
    hex::encode(&Sha256::digest(name.as_bytes())[..16])
}

/// A field envelope version 3 standing in for `value`.
pub fn sealed(value: Value) -> Value {
    json!({ "__enc": 3, "kid": "test", "iv": "aXY=", "ct": value.to_string() })
}

/// The value a [`sealed`] envelope stands in for.
pub fn opened(envelope: &Value) -> Value {
    serde_json::from_str(envelope["ct"].as_str().expect("a sealed envelope")).unwrap()
}

/// The wire name of `field` on `entity`: a public name as it is, any other field as its [`tag`].
pub fn wire_field(entity: &str, field: &str) -> String {
    let public = match entity {
        PROJECT => ["deleted_at", "archived_at"].contains(&field),
        SEALED => ["blob_sha", "thumb_sha"].contains(&field),
        _ => false,
    };
    if public {
        field.to_owned()
    } else {
        tag(field)
    }
}

/// The wire value of `field` on `entity`: a blob address as it is, any other value [`sealed`].
pub fn wire_value(entity: &str, field: &str, value: Value) -> Value {
    if entity == SEALED && ["blob_sha", "thumb_sha"].contains(&field) {
        value
    } else {
        sealed(value)
    }
}

/// A set op of `field` on `entity` (a wire kind) in `scope`.
pub fn set(
    entity: &str,
    entity_id: impl ToString,
    scope: Option<&str>,
    field: &str,
    value: Value,
    ts: (u64, u32, Uuid),
) -> Value {
    json!({
        "id": Uuid::now_v7(),
        "entity": entity,
        "entity_id": entity_id.to_string(),
        "scope": scope,
        "op": "set",
        "field": wire_field(entity, field),
        "value": wire_value(entity, field, value),
        "ts": { "wall_ms": ts.0, "counter": ts.1, "node": ts.2 },
    })
}

/// A delete of `entity` in `scope`.
pub fn delete(
    entity: &str,
    entity_id: impl ToString,
    scope: Option<&str>,
    ts: (u64, u32, Uuid),
) -> Value {
    json!({
        "id": Uuid::now_v7(),
        "entity": entity,
        "entity_id": entity_id.to_string(),
        "scope": scope,
        "op": "delete",
        "ts": { "wall_ms": ts.0, "counter": ts.1, "node": ts.2 },
    })
}

/// Whether wire op `op` sets `field` (by its real name) of `entity_id`.
pub fn sets(op: &Value, entity_id: &str, field: &str) -> bool {
    op["op"] == "set"
        && op["entity_id"] == entity_id
        && op["entity"]
            .as_str()
            .is_some_and(|e| op["field"] == wire_field(e, field))
}

/// The real value of a wire op's set: a blob address as it is, any other [`opened`].
pub fn value_of(op: &Value) -> Value {
    if op["value"].is_object() {
        opened(&op["value"])
    } else {
        op["value"].clone()
    }
}

/// The wire kind a real kind travels as (`manifests/*.json`).
pub fn wire_kind(kind: &str) -> &'static str {
    match kind {
        "project" => PROJECT,
        "project_member" => "project_member",
        k if k.starts_with("journal.") => "journal.sealed",
        k if k.starts_with("vault.") => "vault.sealed",
        _ => SEALED,
    }
}

/// A set op of `field` on an entity of the real `kind`, as its client sends it: under its wire
/// kind, the field tagged, the value sealed, no scope.
pub fn set_of_kind(
    kind: &str,
    entity_id: impl ToString,
    field: &str,
    value: Value,
    wall: u64,
) -> Value {
    set(
        wire_kind(kind),
        entity_id,
        None,
        field,
        value,
        (wall, 0, Uuid::now_v7()),
    )
}
