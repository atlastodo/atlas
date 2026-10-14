//! Which field values leave the device in plaintext (`fieldPolicy.ts`): the `plaintext_fields` of
//! the bundled app manifests (`manifests/*.json`, compiled in by `atlas-core`). Every other field,
//! including one no manifest names yet, is encrypted.

use atlas_core::Registry;

/// Whether a value of `entity`.`field` is end-to-end encrypted. An unknown kind encrypts everything.
pub fn should_encrypt_field(entity: &str, field: &str) -> bool {
    Registry::bundled()
        .kind(entity)
        .is_none_or(|k| !k.plaintext_fields.contains(field))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_decides() {
        assert!(should_encrypt_field("task", "title"));
        assert!(!should_encrypt_field("task", "project_id"));
        assert!(!should_encrypt_field("task", "assignee_id"));
        assert!(should_encrypt_field("task", "a_field_nobody_declared"));
        assert!(!should_encrypt_field("comment", "task_id"));
        assert!(!should_encrypt_field("project_member", "anything"));
        assert!(should_encrypt_field("project", "name"));
        assert!(!should_encrypt_field("attachment", "wrapped_key"));
        assert!(should_encrypt_field("notes.note", "body"));
    }

    /// Every kind and plaintext field of `manifests/todo.json`, read independently of atlas-core.
    #[test]
    fn matches_the_manifest_file() {
        let path = format!("{}/../../manifests/todo.json", env!("CARGO_MANIFEST_DIR"));
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for (kind, spec) in doc["kinds"].as_object().unwrap() {
            match &spec["plaintext_fields"] {
                serde_json::Value::String(all) => {
                    assert_eq!(all, "all");
                    assert!(!should_encrypt_field(kind, "x"));
                }
                fields => {
                    for f in fields.as_array().unwrap() {
                        assert!(
                            !should_encrypt_field(kind, f.as_str().unwrap()),
                            "{kind}.{f}"
                        );
                    }
                    assert!(should_encrypt_field(kind, "title"));
                }
            }
        }
    }
}
