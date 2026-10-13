//! `atlas-client`: a headless Atlas client in Rust, for the `atlas` CLI and other integrations.
//!
//! The apps keep the TypeScript client core (`packages/client-core`, `packages/shared`); this crate
//! reimplements what an integration needs at parity with it, and the shared fixtures in
//! `test-vectors/` keep the two honest:
//!
//! - [`crypto`]: key derivation, wraps, field envelopes, sealed boxes, signatures.
//! - [`field_policy`]: which fields travel in plaintext, from the bundled app manifests.

pub mod crypto;
pub mod field_policy;
