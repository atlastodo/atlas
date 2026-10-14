//! The task rules of `packages/shared` (and `parseDue` of `packages/sdk`), checked against the
//! fixtures in `test-vectors/` that the TypeScript tests read too.

pub mod dates;
pub mod filter;
pub mod quick_add;
pub mod recurrence;
pub mod task;
pub mod zoned;

#[cfg(test)]
mod vectors;
