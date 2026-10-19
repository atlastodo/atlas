//! What the account trusts about key distribution (`trust.ts`): fields of one `preference` entity,
//! encrypted under the personal key and synced, so the server cannot forge them.

use std::collections::{BTreeMap, BTreeSet};

use atlas_core::EntityKind;
use serde_json::Value;

use crate::store::Store;

pub const KEY_TRUST_ID: &str = "00000000-0000-4000-8000-00000000e2ee";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedIdentity {
    pub public_key: String,
    pub signing_key: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct KeyTrust {
    pub initialized: bool,
    pub legacy_migrated: bool,
    pub accepted: BTreeSet<String>,
    /// Project id to the key id the user minted, in the order the fields were set.
    pub minted: Vec<(String, String)>,
    pub pins: BTreeMap<String, String>,
    pub identities: BTreeMap<String, PinnedIdentity>,
    pub verified: BTreeMap<String, String>,
    pub retired: BTreeSet<String>,
}

impl KeyTrust {
    pub fn minted_key(&self, project_id: &str) -> Option<&str> {
        self.minted
            .iter()
            .find(|(p, _)| p == project_id)
            .map(|(_, k)| k.as_str())
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_identity(value: &str) -> Option<PinnedIdentity> {
    let mut parts = value.split(':');
    let public_key = parts.next()?;
    let signing_key = parts.next();
    if parts.next().is_some() || public_key.is_empty() || !is_hex64(public_key) {
        return None;
    }
    let signing_key = signing_key.filter(|s| !s.is_empty());
    if signing_key.is_some_and(|s| !is_hex64(s)) {
        return None;
    }
    Some(PinnedIdentity {
        public_key: public_key.to_owned(),
        signing_key: signing_key.map(str::to_owned),
    })
}

pub fn read_key_trust(store: &Store) -> KeyTrust {
    let Some(fields) = store.get(EntityKind::Preference, KEY_TRUST_ID) else {
        return KeyTrust::default();
    };
    let mut t = KeyTrust {
        initialized: fields.get("keys_initialized") == Some(&Value::Bool(true)),
        legacy_migrated: fields.get("legacy_migrated") == Some(&Value::Bool(true)),
        ..KeyTrust::default()
    };
    for (field, value) in &fields {
        let text = value.as_str();
        if let Some(p) = field.strip_prefix("accepted:") {
            if *value == Value::Bool(true) {
                t.accepted.insert(p.to_owned());
            }
        } else if let Some(p) = field.strip_prefix("minted:") {
            if let Some(k) = text {
                t.minted.push((p.to_owned(), k.to_owned()));
            }
        } else if let Some(p) = field.strip_prefix("pin:") {
            if let Some(k) = text {
                t.pins.insert(p.to_owned(), k.to_owned());
            }
        } else if let Some(u) = field.strip_prefix("identity:") {
            if let Some(identity) = text.and_then(parse_identity) {
                t.identities.insert(u.to_owned(), identity);
            }
        } else if let Some(u) = field.strip_prefix("verified:") {
            if let Some(k) = text {
                t.verified.insert(u.to_owned(), k.to_owned());
            }
        } else if let Some(slot) = field.strip_prefix("retired:") {
            if *value == Value::Bool(true) {
                t.retired.insert(slot.to_owned());
            }
        }
    }
    t
}

fn write(store: &mut Store, field: &str, value: Value) {
    let current = store
        .get(EntityKind::Preference, KEY_TRUST_ID)
        .and_then(|f| f.get(field).cloned());
    if current.as_ref() == Some(&value) {
        return;
    }
    store.set(EntityKind::Preference, KEY_TRUST_ID, field, value);
}

pub fn record_minted_key(store: &mut Store, project_id: &str, key_id: &str) {
    write(store, &format!("minted:{project_id}"), key_id.into());
}

pub fn record_retired_key(store: &mut Store, project_id: &str, key_id: &str) {
    write(
        store,
        &format!("retired:{project_id}:{key_id}"),
        true.into(),
    );
}

pub fn pin_member_key(store: &mut Store, project_id: &str, user_id: &str, public_key: &str) {
    write(
        store,
        &format!("pin:{project_id}:{user_id}"),
        public_key.into(),
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityStatus {
    Trusted,
    Changed,
    Unknown,
}

/// Compare the identity keys published for `user_id` with the pin, pinning on first use and
/// filling in a later-published signing key (`observeIdentity`). With no store, nothing is pinned.
pub fn observe_identity(
    mut store: Option<&mut Store>,
    trust: &KeyTrust,
    user_id: &str,
    public_key: Option<&str>,
    signing_key: Option<&str>,
) -> (IdentityStatus, Option<PinnedIdentity>) {
    let public_key = public_key.map(str::to_lowercase).filter(|s| !s.is_empty());
    let signing_key = signing_key.map(str::to_lowercase).filter(|s| !s.is_empty());
    let field = format!("identity:{user_id}");
    let pinned = match store.as_deref() {
        Some(s) => s.get(EntityKind::Preference, KEY_TRUST_ID).and_then(|f| {
            f.get(&field)
                .and_then(Value::as_str)
                .and_then(parse_identity)
        }),
        None => trust.identities.get(user_id).cloned(),
    };
    let format = |i: &PinnedIdentity| {
        format!(
            "{}:{}",
            i.public_key,
            i.signing_key.as_deref().unwrap_or("")
        )
    };
    let Some(pinned) = pinned else {
        let Some(public_key) = public_key.filter(|p| is_hex64(p)) else {
            return (IdentityStatus::Unknown, None);
        };
        let identity = PinnedIdentity {
            public_key,
            signing_key: signing_key.filter(|s| is_hex64(s)),
        };
        if let Some(s) = store.as_deref_mut() {
            write(s, &field, format(&identity).into());
        }
        return (IdentityStatus::Trusted, Some(identity));
    };
    if public_key.as_deref() != Some(pinned.public_key.as_str()) {
        return (IdentityStatus::Changed, Some(pinned));
    }
    if let Some(pinned_signing) = &pinned.signing_key {
        let status = if signing_key.as_deref() == Some(pinned_signing.as_str()) {
            IdentityStatus::Trusted
        } else {
            IdentityStatus::Changed
        };
        return (status, Some(pinned));
    }
    if let Some(signing_key) = signing_key.filter(|s| is_hex64(s)) {
        let identity = PinnedIdentity {
            public_key: pinned.public_key.clone(),
            signing_key: Some(signing_key),
        };
        if let Some(s) = store {
            write(s, &field, format(&identity).into());
        }
        return (IdentityStatus::Trusted, Some(identity));
    }
    (IdentityStatus::Trusted, Some(pinned))
}
