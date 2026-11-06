//! `atlas-client`: a headless Atlas client in Rust, the engine the apps' CLIs and other
//! integrations build on (by git tag).
//!
//! The apps keep the TypeScript client core (`packages/client-core`); this crate
//! reimplements what an integration needs at parity with it, and the shared fixtures in
//! `test-vectors/` keep the two honest:
//!
//! - [`crypto`]: key derivation, wraps, field envelopes, sealed boxes, signatures.
//! - [`apps`], [`field_policy`]: the app definitions apps register (their kinds, scope links and
//!   writer fields) and which fields travel in plaintext, from the bundled app manifests.
//! - [`store`], [`scope`], [`trust`], [`project_keys`], [`api`], [`sync`]: the in-memory store
//!   with the client's conflict resolution, key scopes, the synced trust state, project key
//!   hydration, the HTTP API and the sync cycle.
//! - [`session`]: an API-token session of one app holding all of that.
//! - [`client`]: what integrations call, the generic client. Each app's operations are its own
//!   crate on this one, in the app's repository: todo's tasks (`atlas-todo-rules`, atlastodo/
//!   atlas-todo), the journal's entries (`atlas-journal-rules`, atlastodo/atlas-journal) and the
//!   vault's items (`atlas-vault-rules`, atlastodo/atlas-vault).
//! - [`zoned`]: time-zone-aware day math.

pub mod api;
pub mod apps;
pub mod client;
pub mod crypto;
pub mod discovery;
pub mod error;
pub mod field_policy;
pub mod project_keys;
pub mod scope;
pub mod session;
pub mod state;
pub mod store;
pub mod sync;
pub mod testing;
pub mod trust;
pub mod wire;
pub mod zoned;

pub use error::{Error, Result};
