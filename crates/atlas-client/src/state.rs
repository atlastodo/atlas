//! A cache of the synced account between runs (`ATLAS_STATE_DIR` of the apps' CLIs), so a run pulls only
//! what changed since the last one instead of the whole snapshot.
//!
//! The file holds the decrypted state, so it is sealed: AES-256-GCM under a key HKDF derives from
//! the token's secret (`atlas-cli-state-v1`, named when the `atlas` CLI was its only user; kept so
//! existing state files open), bound to the token id and the server. Only the token's
//! holder opens it; a file that does not open (another token, another server, tampering, an older
//! format) is ignored and the run syncs from scratch.
//!
//! A password session ([`crate::session::Session::login`]) has no token: its file is
//! `session-<device id>.state`, sealed under a key HKDF derives from the account's app key and bound
//! to that device id ([`StateKey::for_device`]).

use std::path::{Path, PathBuf};

use atlas_core::Operation;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::crypto::{
    decrypt_aes_gcm, encrypt_aes_gcm, hkdf32, ApiTokenParts, EncryptedPayload, TODO_APP,
};

const VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
pub struct CachedState {
    pub user_id: String,
    pub cursor: u64,
    pub ops: Vec<Operation>,
    /// Values no key opened yet (sync protocol 7), kept for a later run that holds the key.
    #[serde(default)]
    pub sealed: Vec<crate::store::SealedPending>,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    v: u8,
    iv: String,
    ct: String,
}

/// What names and seals a state file: a token's, or a password session's device's.
pub struct StateKey {
    id: String,
    key: [u8; 32],
}

impl StateKey {
    pub fn for_token(parts: &ApiTokenParts) -> Self {
        let salt = hex::decode(parts.id.replace('-', "")).unwrap_or_default();
        Self {
            id: parts.id.clone(),
            key: hkdf32(&parts.secret, Some(&salt), "atlas-cli-state-v1"),
        }
    }

    /// A password session's: its device id (from the server) and the app key it opened.
    pub fn for_device(device_id: &str, app_key: &[u8; 32]) -> Self {
        let salt = hex::decode(device_id.replace('-', "")).unwrap_or_default();
        Self {
            id: format!("session-{device_id}"),
            key: hkdf32(app_key, Some(&salt), "atlas-session-state-v1"),
        }
    }
}

fn aad(key: &StateKey, server: &str, app: &str) -> Vec<u8> {
    let mut aad = vec![
        Value::from("atlas-cli-state"),
        Value::from(VERSION),
        Value::from(key.id.as_str()),
        Value::from(server.trim_end_matches('/')),
    ];
    // Todo's state predates app scopes; every other app's is bound to its app.
    if app != TODO_APP {
        aad.push(Value::from(app));
    }
    serde_json::to_vec(&aad).expect("JSON")
}

/// The state file of a token and app in `dir`: `<token id>.state` for todo, `<token id>.<app>.state`
/// for another app (a token for several apps syncs each in its own scope).
pub fn state_path(dir: &Path, parts: &ApiTokenParts, app: &str) -> PathBuf {
    keyed_path(dir, &StateKey::for_token(parts), app)
}

fn keyed_path(dir: &Path, key: &StateKey, app: &str) -> PathBuf {
    if app == TODO_APP {
        dir.join(format!("{}.state", key.id))
    } else {
        dir.join(format!("{}.{app}.state", key.id))
    }
}

/// The cached state of `app`, if there is one this token opens for this server.
pub fn load(dir: &Path, parts: &ApiTokenParts, server: &str, app: &str) -> Option<CachedState> {
    load_keyed(dir, &StateKey::for_token(parts), server, app)
}

/// [`load`] for any [`StateKey`].
pub fn load_keyed(dir: &Path, key: &StateKey, server: &str, app: &str) -> Option<CachedState> {
    let bytes = std::fs::read(keyed_path(dir, key, app)).ok()?;
    let sealed: Sealed = serde_json::from_slice(&bytes).ok()?;
    if sealed.v != VERSION {
        return None;
    }
    let payload = EncryptedPayload {
        iv: sealed.iv,
        ct: sealed.ct,
    };
    let plain = decrypt_aes_gcm(&key.key, &payload, &aad(key, server, app)).ok()?;
    serde_json::from_slice(&plain).ok()
}

/// Write the state atomically (a temporary file renamed over the old one), readable only by the
/// owner where the platform has permissions.
pub fn save(
    dir: &Path,
    parts: &ApiTokenParts,
    server: &str,
    app: &str,
    state: &CachedState,
) -> std::io::Result<()> {
    save_keyed(dir, &StateKey::for_token(parts), server, app, state)
}

/// [`save`] for any [`StateKey`].
pub fn save_keyed(
    dir: &Path,
    key: &StateKey,
    server: &str,
    app: &str,
    state: &CachedState,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let plain = serde_json::to_vec(state).expect("JSON");
    let p = encrypt_aes_gcm(&key.key, &plain, &aad(key, server, app))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let sealed = serde_json::to_vec(&Sealed {
        v: VERSION,
        iv: p.iv,
        ct: p.ct,
    })
    .expect("JSON");
    let target = keyed_path(dir, key, app);
    let tmp = target.with_extension(format!("state.{}.tmp", std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut f = options.open(&tmp)?;
        f.write_all(&sealed)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &target)
}
