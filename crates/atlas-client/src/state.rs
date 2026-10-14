//! A cache of the synced account between runs (`ATLAS_STATE_DIR` of the CLI), so a run pulls only
//! what changed since the last one instead of the whole snapshot.
//!
//! The file holds the decrypted state, so it is sealed: AES-256-GCM under a key HKDF derives from
//! the token's secret (`atlas-cli-state-v1`), bound to the token id and the server. Only the token's
//! holder opens it; a file that does not open (another token, another server, tampering, an older
//! format) is ignored and the run syncs from scratch.

use std::path::{Path, PathBuf};

use atlas_core::Operation;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::crypto::{decrypt_aes_gcm, encrypt_aes_gcm, hkdf32, ApiTokenParts, EncryptedPayload};

const VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
pub struct CachedState {
    pub user_id: String,
    pub cursor: u64,
    pub ops: Vec<Operation>,
}

#[derive(Serialize, Deserialize)]
struct Sealed {
    v: u8,
    iv: String,
    ct: String,
}

fn key(parts: &ApiTokenParts) -> [u8; 32] {
    let salt = hex::decode(parts.id.replace('-', "")).unwrap_or_default();
    hkdf32(&parts.secret, Some(&salt), "atlas-cli-state-v1")
}

fn aad(parts: &ApiTokenParts, server: &str) -> Vec<u8> {
    serde_json::to_vec(&[
        Value::from("atlas-cli-state"),
        Value::from(VERSION),
        Value::from(parts.id.as_str()),
        Value::from(server.trim_end_matches('/')),
    ])
    .expect("JSON")
}

/// The state file of a token in `dir`.
pub fn state_path(dir: &Path, parts: &ApiTokenParts) -> PathBuf {
    dir.join(format!("{}.state", parts.id))
}

/// The cached state, if there is one this token opens for this server.
pub fn load(dir: &Path, parts: &ApiTokenParts, server: &str) -> Option<CachedState> {
    let bytes = std::fs::read(state_path(dir, parts)).ok()?;
    let sealed: Sealed = serde_json::from_slice(&bytes).ok()?;
    if sealed.v != VERSION {
        return None;
    }
    let payload = EncryptedPayload {
        iv: sealed.iv,
        ct: sealed.ct,
    };
    let plain = decrypt_aes_gcm(&key(parts), &payload, &aad(parts, server)).ok()?;
    serde_json::from_slice(&plain).ok()
}

/// Write the state atomically (a temporary file renamed over the old one), readable only by the
/// owner where the platform has permissions.
pub fn save(
    dir: &Path,
    parts: &ApiTokenParts,
    server: &str,
    state: &CachedState,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let plain = serde_json::to_vec(state).expect("JSON");
    let p = encrypt_aes_gcm(&key(parts), &plain, &aad(parts, server))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let sealed = serde_json::to_vec(&Sealed {
        v: VERSION,
        iv: p.iv,
        ct: p.ct,
    })
    .expect("JSON");
    let target = state_path(dir, parts);
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
