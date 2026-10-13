//! `atlas-core` — shared sync primitives for Atlas Todo.
//!
//! The hybrid logical clock ([`hlc`]), the operation log types ([`op`]) the server stores and
//! relays, and the bundled app manifests ([`manifest`]) mapping each entity kind to its app. It
//! has no I/O and no database dependency (the manifests are compiled in). Conflict resolution and
//! recurrence run on the clients, in TypeScript.

pub mod hlc;
pub mod manifest;
pub mod op;

pub use hlc::{Hlc, HlcClock};
pub use manifest::{AppManifest, PlaintextFields, Registry};
pub use op::{Change, EntityKind, Operation};
