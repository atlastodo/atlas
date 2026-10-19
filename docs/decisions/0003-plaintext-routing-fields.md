# 0003: A few routing fields stay plaintext

## Decision

Field values are encrypted, except a short list of routing fields the server must read, kept in
the `plaintext_fields` of `manifests/todo.json` (formerly `test-vectors/plaintext_fields.json`):
chiefly an entity's `project_id` or `task_id`, a task's `assignee_id`, and an attachment's blob
hash. The server test fails if it reads a field the list
does not allow.

## Why

The server copies each op of a shared project to every member, and checks the pusher's role in
that project. To do either it must know which project an op belongs to. An attachment download
must be checked against the task it belongs to, and blob garbage collection must know which blobs
are still referenced. Encrypting these would mean the server could neither share nor authorize.

## Costs

The server learns the shape of your data: which tasks are in which project, who is assigned, how
many attachments exist and their sizes, and when each field changes. It does not learn titles,
notes, names or file contents. [SECURITY.md](../../SECURITY.md) lists everything the server sees.
