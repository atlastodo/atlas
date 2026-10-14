//! Which key encrypts an entity's fields, opening values only with keys of their own scope, and
//! the repair of values written under another key (`scope.ts`). A value is read only with a key
//! of its scope, and a repair re-encrypts only within that scope.

use std::collections::{BTreeSet, HashMap, HashSet};

use atlas_core::{Change, EntityKind, Hlc, Operation};
use serde_json::Value;

use crate::crypto::{
    decrypt_field, decrypt_json, is_encrypted_envelope, EncryptedPayload, FieldEnvelope,
    FieldLocation, KeyScope, Keyring, DEK_KEY_ID,
};
use crate::error::{Error, Result};
use crate::store::{op_entity_id, Opened, Store};
use crate::trust::KEY_TRUST_ID;

/// An entity's scope as far as this client knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Personal,
    Project(String),
    Unknown,
}

/// The link fields of a batch of ops, which may arrive before the store has them.
#[derive(Default)]
pub struct BatchLinks {
    links: HashMap<String, HashMap<&'static str, (Value, Hlc)>>,
    seen: HashSet<String>,
}

pub fn batch_links_of(ops: &[Operation]) -> BatchLinks {
    let mut batch = BatchLinks::default();
    for op in ops {
        let id = op_entity_id(op);
        batch.seen.insert(id.clone());
        let Change::Set { field, value } = &op.change else {
            continue;
        };
        let field: &'static str = match field.as_str() {
            "project_id" => "project_id",
            "task_id" => "task_id",
            _ => continue,
        };
        let fields = batch.links.entry(id).or_default();
        if fields.get(field).is_none_or(|(_, ts)| op.ts > *ts) {
            fields.insert(field, (value.clone(), op.ts));
        }
    }
    batch
}

/// The batch's links first, then the store's (tombstones included).
pub fn resolve_scope(
    store: &Store,
    entity: EntityKind,
    id: &str,
    batch: Option<&BatchLinks>,
) -> Scope {
    let link = |kind: EntityKind, eid: &str, field: &str| -> Option<String> {
        let from_batch = batch
            .and_then(|b| b.links.get(eid))
            .and_then(|f| f.get(field));
        let v = match from_batch {
            Some((v, _)) => Some(v),
            None => store.raw_field(kind, eid, field),
        };
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let known = |kind: EntityKind, eid: &str| {
        batch.is_some_and(|b| b.seen.contains(eid)) || store.exists(kind, eid)
    };
    match entity {
        EntityKind::Project => Scope::Project(id.to_owned()),
        EntityKind::Task | EntityKind::Section => match link(entity, id, "project_id") {
            Some(p) => Scope::Project(p),
            None if known(entity, id) => Scope::Personal,
            None => Scope::Unknown,
        },
        EntityKind::Comment | EntityKind::Activity | EntityKind::Attachment => {
            let Some(task_id) = link(entity, id, "task_id") else {
                return if known(entity, id) {
                    Scope::Personal
                } else {
                    Scope::Unknown
                };
            };
            match link(EntityKind::Task, &task_id, "project_id") {
                Some(p) => Scope::Project(p),
                None if known(EntityKind::Task, &task_id) => Scope::Personal,
                None => Scope::Unknown,
            }
        }
        _ => Scope::Personal,
    }
}

fn str_field<'a>(fields: &'a serde_json::Map<String, Value>, name: &str) -> Option<&'a str> {
    fields.get(name).and_then(Value::as_str)
}

fn active_members(store: &Store, project_id: &str) -> Vec<serde_json::Map<String, Value>> {
    store
        .list(EntityKind::ProjectMember)
        .into_iter()
        .filter(|e| {
            str_field(&e.fields, "project_id") == Some(project_id)
                && str_field(&e.fields, "state") == Some("active")
        })
        .map(|e| e.fields)
        .collect()
}

pub fn shared_project_ids(store: &Store) -> BTreeSet<String> {
    store
        .list(EntityKind::ProjectMember)
        .into_iter()
        .filter(|e| str_field(&e.fields, "state") == Some("active"))
        .filter_map(|e| str_field(&e.fields, "project_id").map(str::to_owned))
        .collect()
}

/// An active owner row, or the project is unshared and in the store (only its creator holds one).
pub fn is_project_creator(store: &Store, project_id: &str, user_id: &str) -> bool {
    let rows = active_members(store, project_id);
    if rows.is_empty() {
        return store.get(EntityKind::Project, project_id).is_some();
    }
    rows.iter()
        .any(|e| str_field(e, "user_id") == Some(user_id) && str_field(e, "role") == Some("owner"))
}

/// A key to encrypt with: the key, its id and its scope.
#[derive(Clone)]
pub struct ScopeKey {
    pub key: [u8; 32],
    pub key_id: String,
    pub scope: KeyScope,
}

/// The canonical project key; [`Error::MissingScopeKey`] for a shared project without it; else the DEK.
pub fn key_for_scope(
    keyring: &Keyring,
    scope: &Scope,
    shared: &BTreeSet<String>,
) -> Result<ScopeKey> {
    if let Scope::Project(p) = scope {
        if let Some(key) = keyring.project_key_canonical(p) {
            return Ok(ScopeKey {
                key: *key,
                key_id: keyring.canonical_key_id(p).expect("canonical").to_owned(),
                scope: KeyScope::Project(p.clone()),
            });
        }
        if shared.contains(p) {
            return Err(Error::MissingScopeKey(p.clone()));
        }
    }
    Ok(ScopeKey {
        key: *keyring.dek(),
        key_id: DEK_KEY_ID.into(),
        scope: KeyScope::Personal,
    })
}

/// The project's while shared or its key is held, else personal; `None` while unknown.
pub fn expected_key_scope(
    keyring: &Keyring,
    scope: &Scope,
    shared: &BTreeSet<String>,
) -> Option<KeyScope> {
    match scope {
        Scope::Unknown => None,
        Scope::Project(p) if keyring.project_key_canonical(p).is_some() || shared.contains(p) => {
            Some(KeyScope::Project(p.clone()))
        }
        _ => Some(KeyScope::Personal),
    }
}

fn preferred_key(keyring: &Keyring, scope: &Scope, shared: &BTreeSet<String>) -> Option<ScopeKey> {
    if *scope == Scope::Unknown {
        return None;
    }
    key_for_scope(keyring, scope, shared).ok()
}

fn keys_of_scope(keyring: &Keyring, scope: &KeyScope) -> Vec<ScopeKey> {
    match scope {
        KeyScope::Personal => vec![ScopeKey {
            key: *keyring.dek(),
            key_id: DEK_KEY_ID.into(),
            scope: KeyScope::Personal,
        }],
        KeyScope::Project(p) => keyring
            .project_keys(p)
            .into_iter()
            .map(|(key_id, key)| ScopeKey {
                key,
                key_id,
                scope: scope.clone(),
            })
            .collect(),
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OpenOptions {
    /// `Some(false)`: a v1 value under the personal key can only be a server copy.
    pub personal_v1: Option<bool>,
    pub v2_only: bool,
    /// Read v1 personal-key values in a project scope, for projects whose sole member is the user.
    pub adopt_personal_v1: bool,
}

pub fn open_options_for(entity: EntityKind, id: &str, personal_v1: bool) -> OpenOptions {
    OpenOptions {
        personal_v1: Some(personal_v1),
        v2_only: entity == EntityKind::Preference && id == KEY_TRUST_ID,
        adopt_personal_v1: false,
    }
}

/// Only `expected`'s keys are tried and a v2 value opens only where it was written.
pub fn open_field_value(
    keyring: &Keyring,
    envelope: &Value,
    at: FieldLocation<'_>,
    expected: Option<&KeyScope>,
    opts: OpenOptions,
) -> Option<Opened> {
    if let Some(env) = FieldEnvelope::from_value(envelope) {
        let candidates: Vec<ScopeKey> = if env.kid == DEK_KEY_ID {
            match expected {
                Some(KeyScope::Project(_)) => Vec::new(),
                _ => keys_of_scope(keyring, &KeyScope::Personal),
            }
        } else {
            let projects = match expected {
                None => keyring.projects_with_key(&env.kid),
                Some(KeyScope::Project(p)) => vec![p.clone()],
                Some(KeyScope::Personal) => Vec::new(),
            };
            projects
                .into_iter()
                .filter_map(|p| {
                    keyring.project_key(&p, &env.kid).map(|k| ScopeKey {
                        key: *k,
                        key_id: env.kid.clone(),
                        scope: KeyScope::Project(p),
                    })
                })
                .collect()
        };
        return candidates.into_iter().find_map(|k| {
            decrypt_field(&k.key, &k.scope, at, &env)
                .ok()
                .map(|value| Opened {
                    value,
                    key_id: k.key_id,
                    scope: k.scope,
                    version: 2,
                })
        });
    }
    if opts.v2_only || !is_encrypted_envelope(envelope) {
        return None;
    }
    let payload = EncryptedPayload {
        iv: envelope["iv"].as_str()?.to_owned(),
        ct: envelope["ct"].as_str()?.to_owned(),
    };
    let candidates: Vec<ScopeKey> = match expected {
        Some(scope) => keys_of_scope(keyring, scope),
        None => keyring
            .all_keys()
            .into_iter()
            .map(|k| ScopeKey {
                key: k.key,
                key_id: k.key_id,
                scope: match k.project_id {
                    None => KeyScope::Personal,
                    Some(p) => KeyScope::Project(p),
                },
            })
            .collect(),
    };
    for k in candidates {
        if k.scope == KeyScope::Personal && opts.personal_v1 == Some(false) {
            continue;
        }
        if let Ok(value) = decrypt_json(&k.key, &payload) {
            return Some(Opened {
                value,
                key_id: k.key_id,
                scope: k.scope,
                version: 1,
            });
        }
    }
    if opts.adopt_personal_v1 {
        if let Some(scope @ KeyScope::Project(_)) = expected {
            if let Ok(value) = decrypt_json(keyring.dek(), &payload) {
                return Some(Opened {
                    value,
                    key_id: DEK_KEY_ID.into(),
                    scope: scope.clone(),
                    version: 1,
                });
            }
        }
    }
    None
}

/// Projects whose only member is `user_id` as active owner.
pub fn sole_owned_projects(store: &Store, user_id: &str) -> BTreeSet<String> {
    let mut others = BTreeSet::new();
    let mut owned = BTreeSet::new();
    for e in store.list(EntityKind::ProjectMember) {
        let Some(project_id) = str_field(&e.fields, "project_id") else {
            continue;
        };
        let state = str_field(&e.fields, "state");
        if str_field(&e.fields, "user_id") != Some(user_id) {
            if state == Some("active") || state == Some("pending") {
                others.insert(project_id.to_owned());
            }
        } else if str_field(&e.fields, "role") == Some("owner") && state == Some("active") {
            owned.insert(project_id.to_owned());
        }
    }
    owned.retain(|p| !others.contains(p));
    owned
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairReason {
    /// Opened with a non-canonical key or in the old format.
    Key,
    /// Arrived unencrypted (before the account's legacy migration).
    Plaintext,
}

/// A value to write again under the right key, at the successor of its stamp.
#[derive(Debug, Clone)]
pub struct Repair {
    pub entity: EntityKind,
    pub entity_id: String,
    pub field: String,
    pub ts: Hlc,
    pub value: Value,
    pub reason: RepairReason,
    pub key_id: Option<String>,
    pub scope: Option<KeyScope>,
    pub version: Option<u8>,
}

fn may_repair_project(store: &Store, user_id: Option<&str>, r: &Repair) -> bool {
    let rows = active_members(store, &r.entity_id);
    if rows.is_empty() {
        return true;
    }
    let Some(mine) = rows
        .iter()
        .find(|e| user_id.is_some() && str_field(e, "user_id") == user_id)
    else {
        return false;
    };
    let role = str_field(mine, "role");
    if r.field == "deleted_at" || r.field == "archived_at" {
        return role == Some("owner");
    }
    role == Some("owner") || role == Some("editor")
}

/// Keep the repairs that stay within their scope; a value under a retired key is history.
pub fn confirm_repairs(
    store: &Store,
    keyring: &Keyring,
    user_id: Option<&str>,
    repairs: Vec<Repair>,
) -> Vec<Repair> {
    if repairs.is_empty() {
        return repairs;
    }
    let shared = shared_project_ids(store);
    repairs
        .into_iter()
        .filter(|r| {
            if r.reason == RepairReason::Key {
                let desired = preferred_key(
                    keyring,
                    &resolve_scope(store, r.entity, &r.entity_id, None),
                    &shared,
                );
                let (Some(desired), Some(scope)) = (desired, r.scope.as_ref()) else {
                    return false;
                };
                if desired.scope != *scope {
                    return false;
                }
                if Some(desired.key_id.as_str()) == r.key_id.as_deref() && r.version == Some(2) {
                    return false;
                }
                if let (Some(2), Some(key_id), KeyScope::Project(p)) =
                    (r.version, r.key_id.as_deref(), scope)
                {
                    if keyring.is_retired(p, key_id) {
                        return false;
                    }
                }
            }
            r.entity != EntityKind::Project || may_repair_project(store, user_id, r)
        })
        .collect()
}

/// Write the repairs whose winning write is still the one at their stamp. Returns how many.
pub fn apply_repairs(store: &mut Store, repairs: &[Repair]) -> usize {
    let mut written = 0;
    for r in repairs {
        if store.field_ts(r.entity, &r.entity_id, &r.field) != Some(r.ts) {
            continue;
        }
        if store
            .rewrite_field(
                r.entity,
                &r.entity_id,
                &r.field,
                r.value.clone(),
                r.ts.successor(),
            )
            .is_some()
        {
            written += 1;
        }
    }
    written
}

/// Open stored envelopes with the keys now held (keeping their stamps) and repair the rest.
/// Returns (revived, repaired).
pub fn revive_locked_values(
    store: &mut Store,
    keyring: &Keyring,
    user_id: Option<&str>,
    personal_v1: bool,
) -> (usize, usize) {
    if !keyring.has_keys() {
        return (0, 0);
    }
    let shared = shared_project_ids(store);
    let sole = user_id
        .map(|u| sole_owned_projects(store, u))
        .unwrap_or_default();
    let revived = store.revive_locked(|store, entity, id, field, envelope| {
        let expected =
            expected_key_scope(keyring, &resolve_scope(store, entity, id, None), &shared);
        let mut opts = open_options_for(entity, id, personal_v1);
        opts.adopt_personal_v1 =
            matches!(&expected, Some(KeyScope::Project(p)) if sole.contains(p));
        open_field_value(
            keyring,
            envelope,
            FieldLocation {
                entity: entity.as_str(),
                entity_id: id,
                field,
            },
            expected.as_ref(),
            opts,
        )
    });
    let count = revived.len();
    let repairs: Vec<Repair> = revived
        .into_iter()
        .map(|r| Repair {
            entity: r.entity,
            entity_id: r.entity_id,
            field: r.field,
            ts: r.ts,
            value: r.opened.value,
            reason: RepairReason::Key,
            key_id: Some(r.opened.key_id),
            scope: Some(r.opened.scope),
            version: Some(r.opened.version),
        })
        .collect();
    let confirmed = confirm_repairs(store, keyring, user_id, repairs);
    (count, apply_repairs(store, &confirmed))
}
