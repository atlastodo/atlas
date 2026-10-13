//! The recovery phrase (`bip39.ts`): a 24-word BIP-39 English mnemonic, whose seed derives the key
//! that wraps the recovery slots and the X25519 keypair recovery challenges are sealed to.

use sha2::{Digest, Sha256, Sha512};

use super::{from_hex, hkdf32, x25519_public_key, CryptoError, CryptoResult};

const WORDLIST: &str = include_str!("bip39_english.txt");

fn wordlist() -> impl Iterator<Item = &'static str> {
    WORDLIST.lines()
}

/// Trimmed, lowercased, whitespace runs collapsed: how the phrase is read.
fn normalize(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `phrase` is a valid BIP-39 English mnemonic (words and checksum).
pub fn validate_recovery_phrase(phrase: &str) -> bool {
    let normalized = normalize(phrase);
    let words: Vec<&str> = normalized.split(' ').collect();
    if !matches!(words.len(), 12 | 15 | 18 | 21 | 24) {
        return false;
    }
    let mut bits: Vec<bool> = Vec::with_capacity(words.len() * 11);
    for word in &words {
        let Some(index) = wordlist().position(|w| w == *word) else {
            return false;
        };
        for b in (0..11).rev() {
            bits.push(index >> b & 1 == 1);
        }
    }
    let checksum_bits = bits.len() / 33;
    let entropy_bits = bits.len() - checksum_bits;
    let entropy: Vec<u8> = bits[..entropy_bits]
        .chunks(8)
        .map(|c| c.iter().fold(0u8, |acc, &b| acc << 1 | u8::from(b)))
        .collect();
    let hash = Sha256::digest(&entropy);
    (0..checksum_bits).all(|i| (hash[i / 8] >> (7 - i % 8) & 1 == 1) == bits[entropy_bits + i])
}

fn recovery_seed(phrase: &str) -> CryptoResult<[u8; 64]> {
    let normalized = normalize(phrase);
    if !validate_recovery_phrase(&normalized) {
        return Err(CryptoError::new("Invalid BIP-39 recovery phrase"));
    }
    // The English word list is ASCII, so NFKD normalization changes nothing.
    let mut seed = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha512>(normalized.as_bytes(), b"mnemonic", 2048, &mut seed);
    Ok(seed)
}

/// The keys a phrase derives for an account salt.
pub struct RecoveryKeys {
    /// Wraps the recovery slots (`atlas-recovery-v1`).
    pub wrap_key: [u8; 32],
    /// The secret of the X25519 recovery keypair (`atlas-recovery-auth-v1`).
    pub auth_secret_key: [u8; 32],
    pub auth_public_key: String,
}

pub fn derive_recovery_keys(phrase: &str, salt_hex: &str) -> CryptoResult<RecoveryKeys> {
    let seed = recovery_seed(phrase)?;
    let salt = from_hex(salt_hex)?;
    let wrap_key = hkdf32(&seed, Some(&salt), "atlas-recovery-v1");
    let auth_secret_key = hkdf32(&seed, Some(&salt), "atlas-recovery-auth-v1");
    Ok(RecoveryKeys {
        wrap_key,
        auth_public_key: x25519_public_key(&auth_secret_key),
        auth_secret_key,
    })
}
