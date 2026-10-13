//! The unlocked keys of a session (`keyring.ts`): the DEK, the X25519 identity, the signing key and
//! each shared project's keys, with the canonical one per project and the retired ones.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use super::signing_public_key;

pub const DEK_KEY_ID: &str = "dek";

/// The non-secret fingerprint of a project key: hex of the first 16 bytes of
/// SHA-256("atlas-pek-id-v1" || PEK).
pub fn project_key_id(pek: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"atlas-pek-id-v1");
    h.update(pek);
    hex::encode(&h.finalize()[..16])
}

/// A key the keyring holds: the DEK (`project_id` None) or a project key.
#[derive(Clone)]
pub struct HeldKey {
    pub project_id: Option<String>,
    pub key_id: String,
    pub key: [u8; 32],
}

#[derive(Default)]
pub struct Keyring {
    dek: Option<[u8; 32]>,
    private_key: Option<[u8; 32]>,
    public_key: Option<String>,
    signing_key: Option<[u8; 32]>,
    signing_public: Option<String>,
    peks: BTreeMap<String, BTreeMap<String, [u8; 32]>>,
    canonical: BTreeMap<String, String>,
    retired: BTreeMap<String, BTreeSet<String>>,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keyring")
            .field("projects", &self.peks.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Keyring {
    pub fn new(dek: [u8; 32], private_key: [u8; 32], public_key: Option<String>) -> Self {
        Self {
            dek: Some(dek),
            private_key: Some(private_key),
            public_key,
            ..Self::default()
        }
    }

    pub fn has_keys(&self) -> bool {
        self.dek.is_some()
    }

    pub fn dek(&self) -> &[u8; 32] {
        self.dek.as_ref().expect("DEK not unlocked in Keyring")
    }

    pub fn private_key(&self) -> Option<&[u8; 32]> {
        self.private_key.as_ref()
    }

    pub fn public_key(&self) -> Option<&str> {
        self.public_key.as_deref()
    }

    pub fn set_signing_key(&mut self, secret: [u8; 32]) {
        self.signing_public = Some(signing_public_key(&secret));
        self.signing_key = Some(secret);
    }

    pub fn signing_key(&self) -> Option<&[u8; 32]> {
        self.signing_key.as_ref()
    }

    pub fn signing_public_key(&self) -> Option<&str> {
        self.signing_public.as_deref()
    }

    /// Whether the key is new to this project.
    pub fn add_project_key(&mut self, project_id: &str, key_id: &str, pek: [u8; 32]) -> bool {
        self.peks
            .entry(project_id.to_owned())
            .or_default()
            .insert(key_id.to_owned(), pek)
            .is_none()
    }

    /// Name the key new content is encrypted with, possibly one not held yet.
    pub fn set_canonical(&mut self, project_id: &str, key_id: &str) {
        self.canonical
            .insert(project_id.to_owned(), key_id.to_owned());
    }

    pub fn canonical_key_id(&self, project_id: &str) -> Option<&str> {
        self.canonical.get(project_id).map(String::as_str)
    }

    pub fn set_project_key(&mut self, project_id: &str, pek: [u8; 32]) -> String {
        let key_id = project_key_id(&pek);
        self.add_project_key(project_id, &key_id, pek);
        self.set_canonical(project_id, &key_id);
        key_id
    }

    /// The canonical key of the project, when held.
    pub fn project_key_canonical(&self, project_id: &str) -> Option<&[u8; 32]> {
        let key_id = self.canonical.get(project_id)?;
        self.peks.get(project_id)?.get(key_id)
    }

    pub fn project_key(&self, project_id: &str, key_id: &str) -> Option<&[u8; 32]> {
        self.peks.get(project_id)?.get(key_id)
    }

    pub fn set_retired_keys(&mut self, project_id: &str, ids: BTreeSet<String>) {
        if ids.is_empty() {
            self.retired.remove(project_id);
        } else {
            self.retired.insert(project_id.to_owned(), ids);
        }
    }

    pub fn is_retired(&self, project_id: &str, key_id: &str) -> bool {
        self.retired
            .get(project_id)
            .is_some_and(|s| s.contains(key_id))
    }

    pub fn project_ids(&self) -> Vec<String> {
        self.peks.keys().cloned().collect()
    }

    pub fn projects_with_key(&self, key_id: &str) -> Vec<String> {
        self.peks
            .iter()
            .filter(|(_, keys)| keys.contains_key(key_id))
            .map(|(p, _)| p.clone())
            .collect()
    }

    pub fn project_keys(&self, project_id: &str) -> Vec<(String, [u8; 32])> {
        self.peks
            .get(project_id)
            .map(|keys| keys.iter().map(|(id, k)| (id.clone(), *k)).collect())
            .unwrap_or_default()
    }

    pub fn all_keys(&self) -> Vec<HeldKey> {
        let mut out = Vec::new();
        if let Some(dek) = self.dek {
            out.push(HeldKey {
                project_id: None,
                key_id: DEK_KEY_ID.into(),
                key: dek,
            });
        }
        for (project_id, keys) in &self.peks {
            for (key_id, key) in keys {
                out.push(HeldKey {
                    project_id: Some(project_id.clone()),
                    key_id: key_id.clone(),
                    key: *key,
                });
            }
        }
        out
    }
}
