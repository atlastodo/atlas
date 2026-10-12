# 0001: A per-field last-writer-wins op log, not a CRDT library

## Decision

Every change is an operation that sets one field of an entity or deletes it, stamped with a
hybrid logical clock. The greatest stamp wins per field, and a delete is a tombstone that hides
older fields. Clients and the server apply the same rule. There is no Automerge, Yjs or other
CRDT library.

## Why

- **The server must merge without reading.** Values are encrypted on the device. A per-field
  register needs only the stamp to decide a winner, so the server can fold ops into a snapshot
  with a SQL row comparison on `(wall_ms, counter, node)`. A text or sequence CRDT would need the
  plaintext, or an opaque encrypted document the server can only store whole.
- **Tasks are mostly small fields.** A title, a due date, a priority, a project id. Concurrent
  edits to different fields of one task both survive, which covers most real conflicts.
- **It is small and testable.** The rule is a few lines in each language, checked against shared
  JSON vectors (`test-vectors/conflict_vectors.json`) by both the TypeScript and Rust tests.
- **Sharing needs per-op routing.** Each op carries the entity it touches, so the server can copy
  it to every member of a shared project without understanding it.

## Costs

- No text merge: two devices editing the same note offline keep the later edit whole.
- An edit stamped after a concurrent delete revives the entity with only the fields written
  after the delete.
- Ordering is only as good as device clocks. The server refuses stamps more than five minutes
  ahead, which bounds how far a fast clock can push its edits past others.
