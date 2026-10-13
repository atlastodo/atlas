//! Load the shared projects' keys into the keyring (`projectKeys.ts`). Anyone can seal a key to
//! the user and the server names the canonical key, so a sealed key loads only with its owner's
//! signature under the owner's pinned key, per the synced trust state.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::api::{ApiClient, ProjectKeyRow};
use crate::crypto::{
    project_key_id, unseal_key, unwrap_project_key, verify_delivery, wrap_project_key, CryptoError,
    DeliveryFields, EncryptedPayload, Keyring, SealedKey,
};
use crate::error::Result;
use crate::store::Store;
use crate::trust::{
    observe_identity, pin_member_key, record_minted_key, record_retired_key, IdentityStatus,
    KeyTrust,
};

#[derive(Debug, Default, Clone)]
pub struct HydrateResult {
    pub added: usize,
    pub failed: usize,
    pub backfilled: usize,
    pub rejected: usize,
    pub signer_changed: Vec<String>,
    pub changed: bool,
}

fn as_payload(v: &Value) -> Option<EncryptedPayload> {
    Some(EncryptedPayload {
        iv: v.get("iv")?.as_str()?.to_owned(),
        ct: v.get("ct")?.as_str()?.to_owned(),
    })
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn as_sealed(v: &Value) -> Option<SealedKey> {
    if let (Some(epk), Some(inner)) = (
        v.get("ephemeralPublicKey").and_then(Value::as_str),
        v.get("encryptedKey").and_then(as_payload),
    ) {
        return Some(SealedKey {
            ephemeral_public_key: epk.to_owned(),
            encrypted_key: inner,
        });
    }
    // An older form: `{ iv: <ephemeral key hex>, ct: <JSON of the payload> }`.
    let p = as_payload(v)?;
    if !is_hex64(&p.iv) {
        return None;
    }
    let inner: Value = serde_json::from_str(&p.ct).ok()?;
    Some(SealedKey {
        ephemeral_public_key: p.iv,
        encrypted_key: as_payload(&inner)?,
    })
}

fn parsed(encrypted_pek: &Value) -> Option<Value> {
    match encrypted_pek {
        Value::String(s) => serde_json::from_str(s).ok(),
        v => Some(v.clone()),
    }
}

pub fn is_sealed_key_row(encrypted_pek: &Value) -> bool {
    parsed(encrypted_pek).is_some_and(|v| as_sealed(&v).is_some())
}

/// Open a key row: a sealed delivery with the X25519 key, an own copy with the DEK.
pub fn open_project_key_row(
    encrypted_pek: &Value,
    keyring: &Keyring,
    project_id: &str,
) -> Result<[u8; 32], CryptoError> {
    let shape = || CryptoError::new("unrecognised project key shape");
    let value = parsed(encrypted_pek).ok_or_else(shape)?;
    let pek = if let Some(sealed) = as_sealed(&value) {
        let secret = keyring
            .private_key()
            .ok_or_else(|| CryptoError::new("User private key not unlocked in Keyring"))?;
        unseal_key(&sealed, secret)?
    } else if let Some(p) = as_payload(&value) {
        unwrap_project_key(&p, value.get("v"), keyring.dek(), project_id)?
    } else {
        return Err(shape());
    };
    let len = pek.len();
    pek.try_into()
        .map_err(|_| CryptoError::new(format!("project key is {len} bytes")))
}

enum Verdict {
    Ok,
    Unsigned,
    Changed,
    Bad,
}

fn check_delivery(
    row: &ProjectKeyRow,
    key_id: &str,
    user_id: Option<&str>,
    trust: &KeyTrust,
    store: Option<&mut Store>,
) -> Verdict {
    let Some(signature) = row.signature.as_deref().filter(|s| !s.is_empty()) else {
        return Verdict::Unsigned;
    };
    let (Some(signer), Some(user_id)) =
        (row.signed_by.as_deref().filter(|s| !s.is_empty()), user_id)
    else {
        return Verdict::Bad;
    };
    if signer == user_id || row.key_id != key_id {
        return Verdict::Bad;
    }
    let Some(sealed) = parsed(&row.encrypted_pek).and_then(|v| as_sealed(&v)) else {
        return Verdict::Bad;
    };
    let mut store = store;
    let (status, pinned) = observe_identity(
        store.as_deref_mut(),
        trust,
        signer,
        row.signer_public_key.as_deref(),
        row.signer_signing_key.as_deref(),
    );
    if status == IdentityStatus::Changed {
        return Verdict::Changed;
    }
    let Some(pinned) = pinned else {
        return Verdict::Bad;
    };
    let Some(signing_key) = pinned.signing_key.as_deref() else {
        return Verdict::Bad;
    };
    let fields = DeliveryFields {
        project_id: &row.project_id,
        recipient_id: user_id,
        key_id,
        sealed: &sealed,
    };
    if !verify_delivery(signing_key, signature, &fields) {
        return Verdict::Bad;
    }
    let pin = format!("{}:{signer}", row.project_id);
    if let Some(s) = store {
        if trust.minted_key(&row.project_id).is_none() && !trust.pins.contains_key(&pin) {
            pin_member_key(s, &row.project_id, signer, &pinned.public_key);
        }
    }
    Verdict::Ok
}

pub struct HydrateOptions<'a> {
    /// Before the trust state exists, an owned project's sole key is canonical when the server
    /// names none.
    pub is_creator: &'a dyn Fn(&str) -> bool,
    pub trust: KeyTrust,
    pub user_id: Option<&'a str>,
    /// Where the trust state records what it learns (pins); `None` records nothing.
    pub record: bool,
}

/// Load every project key the server lists (`hydrateProjectKeys`). Idempotent; rows that do not
/// open are skipped. Fails only when the listing does.
pub fn hydrate_project_keys(
    api: &ApiClient,
    keyring: &mut Keyring,
    store: &mut Store,
    opts: HydrateOptions<'_>,
) -> Result<HydrateResult> {
    let response = api.list_project_keys()?;
    let trust = &opts.trust;
    let mut result = HydrateResult::default();
    let server_retired: BTreeMap<String, BTreeSet<String>> = response
        .retired
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|(p, ids)| {
            let ids = ids
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            (p, ids)
        })
        .collect();
    let retired_here = |p: &str, k: &str| {
        server_retired.get(p).is_some_and(|s| s.contains(k))
            || trust.retired.contains(&format!("{p}:{k}"))
    };
    let takes_sealed = |p: &str, signer: Option<&str>| {
        if trust.minted_key(p).is_some() {
            signer.is_some_and(|s| !s.is_empty() && trust.pins.contains_key(&format!("{p}:{s}")))
        } else {
            trust.accepted.contains(p) || !trust.initialized
        }
    };

    let mut stored = BTreeSet::new();
    for row in &response.keys {
        let bound = as_payload(&row.encrypted_pek).is_some()
            && row.encrypted_pek.get("v").and_then(Value::as_f64) == Some(2.0);
        if row.kind == "wrapped" && !row.key_id.is_empty() && bound {
            stored.insert(format!("{}/{}", row.project_id, row.key_id));
        }
    }

    // Own copies first, so an unsigned delivery can be checked against the keys they hold.
    let mut rows: Vec<(bool, &ProjectKeyRow)> = response
        .keys
        .iter()
        .map(|r| (is_sealed_key_row(&r.encrypted_pek), r))
        .collect();
    rows.sort_by_key(|(sealed, _)| *sealed);

    let mut to_backfill: Vec<(String, String, [u8; 32])> = Vec::new();
    let mut opened: Vec<(String, BTreeSet<String>)> = Vec::new();
    for (sealed, row) in rows {
        if sealed && !takes_sealed(&row.project_id, row.signed_by.as_deref()) {
            result.rejected += 1;
            continue;
        }
        let pek = match open_project_key_row(&row.encrypted_pek, keyring, &row.project_id) {
            Ok(pek) => pek,
            Err(_) => {
                result.failed += 1;
                continue;
            }
        };
        let key_id = project_key_id(&pek);
        if sealed {
            let writer = opts.record.then_some(&mut *store);
            match check_delivery(row, &key_id, opts.user_id, trust, writer) {
                Verdict::Ok => {}
                Verdict::Unsigned => {
                    // From before deliveries were signed: only a key this device already holds.
                    if keyring.project_key(&row.project_id, &key_id).is_none() {
                        result.rejected += 1;
                    }
                    continue;
                }
                Verdict::Changed => {
                    result
                        .signer_changed
                        .push(row.signed_by.clone().unwrap_or_default());
                    result.rejected += 1;
                    continue;
                }
                Verdict::Bad => {
                    result.rejected += 1;
                    continue;
                }
            }
        }
        if keyring.add_project_key(&row.project_id, &key_id, pek) {
            result.added += 1;
        }
        match opened.iter_mut().find(|(p, _)| *p == row.project_id) {
            Some((_, ids)) => {
                ids.insert(key_id.clone());
            }
            None => opened.push((row.project_id.clone(), BTreeSet::from([key_id.clone()]))),
        }
        let slot = format!("{}/{key_id}", row.project_id);
        if !stored.contains(&slot)
            && !to_backfill
                .iter()
                .any(|(p, k, _)| *p == row.project_id && *k == key_id)
        {
            to_backfill.push((row.project_id.clone(), key_id, pek));
        }
    }

    let canonical: BTreeMap<String, String> = response
        .canonical
        .iter()
        .filter_map(|(p, k)| k.as_str().map(|k| (p.clone(), k.to_owned())))
        .collect();
    let choose = |keyring: &mut Keyring, p: &str, k: &str, result: &mut HydrateResult| {
        if keyring.canonical_key_id(p) == Some(k) {
            return;
        }
        keyring.set_canonical(p, k);
        result.changed = true;
    };
    // The user's own project keeps the key they minted until a rotation retires it and the device
    // holds its replacement.
    for (p, k) in &trust.minted {
        let next = canonical.get(p);
        match next {
            Some(next)
                if retired_here(p, k)
                    && next != k
                    && !retired_here(p, next)
                    && keyring.project_key(p, next).is_some() =>
            {
                choose(keyring, p, next, &mut result);
                if opts.record {
                    record_minted_key(store, p, next);
                    record_retired_key(store, p, k);
                }
            }
            _ => {
                if keyring.project_key(p, k).is_some() {
                    choose(keyring, p, k, &mut result);
                }
            }
        }
    }
    for (p, k) in &canonical {
        if trust.minted_key(p).is_some() {
            continue;
        }
        if !trust.accepted.contains(p) && trust.initialized {
            continue;
        }
        if trust.retired.contains(&format!("{p}:{k}")) {
            continue;
        }
        choose(keyring, p, k, &mut result);
        if opts.record && keyring.project_key(p, k).is_some() {
            for old in server_retired.get(p).into_iter().flatten() {
                if old != k && keyring.project_key(p, old).is_some() {
                    record_retired_key(store, p, old);
                }
            }
        }
    }
    if !trust.initialized {
        for (p, ids) in &opened {
            if canonical.contains_key(p) || ids.len() != 1 || keyring.canonical_key_id(p).is_some()
            {
                continue;
            }
            if !(opts.is_creator)(p) {
                continue;
            }
            let only = ids.iter().next().expect("one").clone();
            choose(keyring, p, &only, &mut result);
        }
    }
    if result.added > 0 {
        result.changed = true;
    }

    // What is history now: nothing opened with these keys is re-encrypted.
    let mut retired_projects: BTreeSet<String> = server_retired.keys().cloned().collect();
    for slot in &trust.retired {
        if let Some(at) = slot.rfind(':') {
            retired_projects.insert(slot[..at].to_owned());
        }
    }
    for p in retired_projects {
        let mut ids: BTreeSet<String> = server_retired.get(&p).cloned().unwrap_or_default();
        for slot in &trust.retired {
            if let Some(at) = slot.rfind(':') {
                if slot[..at] == p {
                    ids.insert(slot[at + 1..].to_owned());
                }
            }
        }
        if let Some(current) = keyring.canonical_key_id(&p) {
            ids.remove(current);
        }
        keyring.set_retired_keys(&p, ids);
    }

    for (p, k, pek) in to_backfill {
        let Ok(wrapped) = wrap_project_key(&pek, keyring.dek(), &p) else {
            continue;
        };
        if api.put_project_key(&p, &wrapped, &k).is_ok() {
            result.backfilled += 1;
        }
    }
    Ok(result)
}
