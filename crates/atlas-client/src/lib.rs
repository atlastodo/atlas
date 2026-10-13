//! `atlas-client`: a headless Atlas client in Rust, for the `atlas` CLI and other integrations.
//!
//! The apps keep the TypeScript client core (`packages/client-core`, `packages/shared`); this crate
//! reimplements what an integration needs at parity with it, and the shared fixtures in
//! `test-vectors/` keep the two honest:
//!
//! - [`crypto`]: key derivation, wraps, field envelopes, sealed boxes, signatures.
//! - [`field_policy`]: which fields travel in plaintext, from the bundled app manifests.
//! - [`store`], [`scope`], [`trust`], [`project_keys`], [`api`], [`sync`]: the in-memory store
//!   with the client's conflict resolution, key scopes, the synced trust state, project key
//!   hydration, the HTTP API and the sync cycle.
//! - [`session`]: an API-token session holding all of that.

pub mod api;
pub mod client;
pub mod crypto;
pub mod discovery;
pub mod error;
pub mod field_policy;
pub mod project_keys;
pub mod rules;
pub mod scope;
pub mod session;
pub mod store;
pub mod sync;
pub mod testing;
pub mod trust;

pub use error::{Error, Result};
