-- Sync protocol 7 (docs/decisions/0006-opaque-sync-metadata.md): ops carry a wire kind, the scope
-- whose key encrypted them and an opaque field tag. Rows written before it keep their real kind
-- and field names (legacy rows) until their client migrates them; nothing here rewrites them.

-- The project whose key encrypted the op (NULL: the account's own key), which the client needs to
-- open the value, and the account that pushed it (NULL: the server), which clients check an
-- activity's actor against. Legacy rows have neither.
ALTER TABLE operations
    ADD COLUMN scope UUID,
    ADD COLUMN pushed_by UUID;
ALTER TABLE entity_fields
    ADD COLUMN scope UUID,
    ADD COLUMN pushed_by UUID;

-- Where each sealed entity of a partition lives now: the scope of its newest op. Fan-out,
-- revocation, the accept backfill and blob binding read it instead of plaintext links.
CREATE TABLE entity_scopes (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity      TEXT NOT NULL,
    entity_id   UUID NOT NULL,
    scope       UUID,
    hlc_wall_ms BIGINT NOT NULL,
    hlc_counter INT NOT NULL,
    hlc_node    UUID NOT NULL,
    PRIMARY KEY (user_id, entity, entity_id)
);
-- "What of project P does this partition hold?" (revocation, backfill).
CREATE INDEX entity_scopes_scope_idx ON entity_scopes (user_id, scope) WHERE scope IS NOT NULL;

-- A move can take any sealed entity out of a shared project, not only a task.
ALTER TABLE revoked_tasks RENAME TO revoked_entities;
ALTER TABLE revoked_entities RENAME COLUMN task_id TO entity_id;

-- What the invitee is shown before accepting, encrypted by the inviter under the project key
-- (the server cannot read the project's fields any more).
ALTER TABLE project_members ADD COLUMN invite_preview JSONB;

-- Blob references of current attachments, like the legacy index on `attachment` rows.
CREATE INDEX entity_fields_sealed_sha_idx ON entity_fields ((value #>> '{}'))
    WHERE entity = 'todo.sealed' AND field IN ('blob_sha', 'thumb_sha');

-- Who created each project: the account whose op for it came first in the log. Unshared projects'
-- first share is authorized by it (`members::is_project_creator`). It used to be read from the op
-- log, so retention kept every project op; clients now drop their legacy project ops after
-- migrating them, so the answer is kept here, recorded on the first write from now on.
CREATE TABLE project_creators (
    project_id UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO project_creators (project_id, user_id)
SELECT DISTINCT ON (entity_id) entity_id, user_id
  FROM operations
 WHERE entity = 'project'
 ORDER BY entity_id, server_seq;
