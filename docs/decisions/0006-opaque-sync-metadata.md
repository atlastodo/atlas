# 0006: Ops carry a scope and opaque field tags, not routing fields and field names

Replaces [0003](./0003-plaintext-routing-fields.md).

## Decision

Sync protocol 7 hides what an op is about. On the wire an op is
`{id, entity, entity_id, scope, op, field, value, ts}`:

- `entity` is a **wire kind**:
  - `todo.project` for a todo project;
  - `todo.sealed` for every other todo entity (task, section, label, comment, …);
  - `journal.sealed` and `vault.sealed` for the other apps;
  - `project_member` for the rows the server writes itself.
    The real kind travels inside the ciphertext.
- `scope` is the project whose key encrypted the op, or `null` for the account's own key. The
  server routes and authorizes by it. There are no plaintext `project_id`, `task_id`,
  `assignee_id` or `actor_id` fields any more.
- `field` is a **tag**: 32 lowercase hex digits, the first 16 bytes of
  `HMAC-SHA256(tag_key, JSON.stringify(["atlas-field-tag", 1, entity_id, kind, field]))` with
  `tag_key = HKDF-SHA256(ikm = the encrypting key, no salt, info "atlas-field-tag-v1", 32 bytes)`.
  The server merges on it like it merged on names. The tag includes the entity id, so the same
  field of two entities has unrelated tags.
- A few **public names** stay as they are, because the server acts on them:
  - a project's `deleted_at` and `archived_at` (owner-only), whose values stay encrypted;
  - an attachment's `blob_sha` and `thumb_sha`, which stay plaintext (hashes of ciphertext,
    used for blob authorization and garbage collection).
    The manifests list them.
- `value` is a field envelope version 3, `{__enc: 3, kid, iv, ct}`:
  - Its plaintext is `JSON.stringify([kind, field, value])`, padded as in version 2.
  - Its associated data is
    `JSON.stringify(["atlas-field", 3, entity, entity_id, field, scope, kid])`, with the wire
    `entity` and `field`, and `scope` as `"personal"` or `"project:<id>"`.
  - A delete has no value: clients find the entity by id.
- The server adds `pushed_by` (the pushing account, `null` for its own ops) to every op it
  delivers. A client drops an activity whose `actor_id` is not its `pushed_by`; the server used
  to overwrite that field instead.

## Why

Decision 0003 kept routing fields plaintext because the server must know which project an op
belongs to. It does not need to know which task, which field or what kind of entity:

- Fan-out and the role check need only the project.
- The last-writer-wins merge needs only equal names to compare.
- Every project-scoped kind already needed the same role.

Moving the project onto the op as `scope` keeps sharing, moves, revocation and blob authorization
working. With opaque kinds and tags, the server no longer learns the shape of the data.

## Costs

- The server still learns:
  - each op's account, scope, entity id, time, size bucket and whether it is a project;
  - which entities are attachments (their blob fields);
  - when a project is archived or deleted.
    It also still knows email addresses, sessions, memberships and timing (see
    [SECURITY.md](../../SECURITY.md)).
- The server no longer checks that an assignee is a project member; clients show only members.
- A key rotation or a move gives a field a new tag. The superseded row stays on the server until
  the entity is deleted, and clients resolve the two after decrypting.
- Deleting a task must tombstone its attachments on the client, because the server can no longer
  link an attachment to its task.
- Data written before protocol 7 migrates in place, so nothing is lost and shares survive:
  - The server keeps the old kinds (`task`, `project`, `journal.entry`, …) readable, with their
    old routing paths (revocation, backfill, attachments, retention), but refuses new writes to
    them.
  - Each client re-encodes the live entities of its partition with every field's original
    timestamp, so concurrent edits still merge as before. It then drops the old rows with
    `POST /sync/legacy/drop`, which hard-deletes them from its own partition only.
  - An activity is re-encoded only by its actor, whose account must be the one to push it.
  - Until every member of a shared project has migrated, the old rows in the other members'
    partitions keep their plaintext metadata.
