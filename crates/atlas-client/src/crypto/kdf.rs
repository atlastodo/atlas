//! The password KDF (`kdf.ts`): a password and salt to a 32-byte master key, which HKDF expands
//! into the auth hash (`atlas-auth-v1`) and the MEK (`atlas-mek-v1`).
//!
//! - Version 1: PBKDF2-HMAC-SHA256, 600 000 iterations, over the password as typed.
//! - Version 2: Argon2id (RFC 9106, 0x13) over the NFC-normalized password.

use serde_json::Value;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;

use super::{from_hex, hkdf32, CryptoError, CryptoResult};

pub const DEFAULT_PBKDF2_ITERATIONS: u32 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordKdf {
    Pbkdf2 {
        iterations: u32,
    },
    Argon2id {
        memory_kib: u32,
        iterations: u32,
        parallelism: u32,
    },
}

pub const LEGACY_KDF: PasswordKdf = PasswordKdf::Pbkdf2 {
    iterations: DEFAULT_PBKDF2_ITERATIONS,
};

pub const CURRENT_KDF: PasswordKdf = PasswordKdf::Argon2id {
    memory_kib: 65_536,
    iterations: 3,
    parallelism: 1,
};

const ARGON2_MEMORY: (u64, u64) = (65_536, 262_144);
const ARGON2_ITERATIONS: (u64, u64) = (3, 10);
const ARGON2_PARALLELISM: (u64, u64) = (1, 4);

/// Read a server's `kdf_version` and `kdf_params`; `Ok(None)` for a server predating them.
/// Refuses unknown versions and parameters outside what `kdfFromWire` accepts.
pub fn kdf_from_wire(version: &Value, params: &Value) -> CryptoResult<Option<PasswordKdf>> {
    let unsupported = |d: &str| CryptoError::new(format!("unsupported password KDF: {d}"));
    if version.is_null() {
        return if params.is_null() {
            Ok(None)
        } else {
            Err(unsupported("kdf_params without kdf_version"))
        };
    }
    let Some(fields) = params.as_object() else {
        return Err(unsupported(&format!(
            "version {version} without kdf_params"
        )));
    };
    let mut names: Vec<&str> = fields.keys().map(String::as_str).collect();
    names.sort();
    let int = |name: &str| -> CryptoResult<u64> {
        let v = &fields[name];
        let n = v
            .as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0);
        match n {
            Some(f) if f >= 0.0 => Ok(f as u64),
            Some(_) => Err(unsupported(&format!("{name} out of bounds"))),
            None => Err(unsupported(&format!("{name} is not an integer"))),
        }
    };
    let bounded = |name: &str, (lo, hi): (u64, u64)| -> CryptoResult<u32> {
        let v = int(name)?;
        if v < lo || v > hi {
            return Err(unsupported(&format!("{name} {v} out of bounds")));
        }
        Ok(v as u32)
    };
    match version.as_f64() {
        Some(1.0) => {
            if names != ["iterations"] || int("iterations")? != u64::from(DEFAULT_PBKDF2_ITERATIONS)
            {
                return Err(unsupported("version 1 parameters"));
            }
            Ok(Some(LEGACY_KDF))
        }
        Some(2.0) => {
            if names != ["iterations", "memory_kib", "parallelism"] {
                return Err(unsupported("version 2 parameters"));
            }
            Ok(Some(PasswordKdf::Argon2id {
                memory_kib: bounded("memory_kib", ARGON2_MEMORY)?,
                iterations: bounded("iterations", ARGON2_ITERATIONS)?,
                parallelism: bounded("parallelism", ARGON2_PARALLELISM)?,
            }))
        }
        _ => Err(unsupported(&format!("version {version}"))),
    }
}

/// Raw Argon2id (type 2, version 0x13, no secret or associated data).
pub fn argon2id(
    password: &[u8],
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    out_len: usize,
) -> CryptoResult<Vec<u8>> {
    let params = argon2::Params::new(memory_kib, iterations, parallelism, Some(out_len))
        .map_err(|e| CryptoError::new(format!("Argon2id parameters: {e}")))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = vec![0u8; out_len];
    argon
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| CryptoError::new(format!("Argon2id: {e}")))?;
    Ok(out)
}

/// The master key of a password: version 1 over its bytes as given, version 2 over its NFC form.
pub fn master_key(password: &str, salt_hex: &str, kdf: PasswordKdf) -> CryptoResult<[u8; 32]> {
    let salt = from_hex(salt_hex)?;
    let mut out = [0u8; 32];
    match kdf {
        PasswordKdf::Pbkdf2 { iterations } => {
            pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut out);
        }
        PasswordKdf::Argon2id {
            memory_kib,
            iterations,
            parallelism,
        } => {
            let nfc: String = password.nfc().collect();
            let key = argon2id(
                nfc.as_bytes(),
                &salt,
                memory_kib,
                iterations,
                parallelism,
                32,
            )?;
            out.copy_from_slice(&key);
        }
    }
    Ok(out)
}

/// The auth hash (hex, what the server checks) and the MEK.
pub struct DerivedKeys {
    pub auth_hash: String,
    pub mek: [u8; 32],
}

pub fn expand_master_key(master: &[u8; 32]) -> DerivedKeys {
    DerivedKeys {
        auth_hash: hex::encode(hkdf32(master, None, "atlas-auth-v1")),
        mek: hkdf32(master, None, "atlas-mek-v1"),
    }
}

pub fn derive_auth_and_mek(
    password: &str,
    salt_hex: &str,
    kdf: PasswordKdf,
) -> CryptoResult<DerivedKeys> {
    Ok(expand_master_key(&master_key(password, salt_hex, kdf)?))
}
