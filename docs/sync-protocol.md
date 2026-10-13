# Sync protocol

This is the wire contract between a client and the server's `/sync/*` routes. It is what a
third-party client would implement. [architecture.md](./architecture.md) explains why it works
this way; this page only says what goes over the wire.

> **Unstable until 1.0.** The protocol changes in lockstep with the official clients. A server
> refuses clients below its minimum protocol version (see [Versions](#versions)), so keep clients
> and server on recent releases. There is no compatibility promise across minor versions yet.

## Requests

Every `/sync/*` HTTP request carries:

- `Authorization: Bearer <access token>` (from `POST /auth/login`, renewed with
  `POST /auth/refresh`).
- `x-atlas-sync-protocol: <version>`, the client's protocol version. The current version is 6.

The server answers `426 Upgrade Required` with
`{"code": "upgrade_required", "min_protocol": <n>}` when the version is missing or below its
minimum. Any route answers `429` with `Retry-After` when the user is over budget; pushes and
reads (pull, snapshot, socket tickets) have separate budgets. All routes are also served under
`/api`.

Before signing in, a client may read the public `GET /discovery` for the server's
`protocol_version`, `capabilities` and offered `apps`; a 404 means a server older than discovery
(protocol 1). An op whose entity kind belongs to an app (`manifests/<app>.json`) that is not
enabled for the instance or the account is refused with
`403 {"code": "app_not_enabled", "app": <id>, "scope": "instance" | "account"}`, and pull and
the snapshot do not serve such ops. See [architecture.md](./architecture.md#apps-and-manifests).

## Operations

All data is a set of entities, each a bag of fields with a client-generated UUIDv7 id. A change is
an operation that sets one field or deletes the entity:

```json
{
  "id": "<uuidv7, unique per op>",
  "entity": "task",
  "entity_id": "<uuidv7>",
  "op": "set",
  "field": "title",
  "value": { "__enc": 2, "kid": "<key id>", "iv": "…", "ct": "…" },
  "ts": { "wall_ms": 1767225600000, "counter": 0, "node": "<device uuid>" }
}
```

A delete has `"op": "delete"` and no `field` or `value`.

- `entity` is one of `task`, `project`, `section`, `label`, `comment`, `preference`,
  `saved_filter`, `reminder`, `project_member`, `activity`, `focus_session`, `habit`,
  `habit_checkin`, `attachment`. The server refuses other kinds, and `project_member` ops, which
  only the server writes.
- `ts` is a hybrid logical clock stamp. `counter` is at most 65535; a clock that would pass it
  moves to the next millisecond instead. `wall_ms` may be at most five minutes ahead of the
  server's clock.
- `value` is any JSON value of at most 64 KiB serialized. Values are encrypted, except the
  routing fields listed in the `plaintext_fields` of [`manifests/todo.json`](../manifests/todo.json)
  (such as a task's `project_id`), which the server reads to find who shares an entity.
  [architecture.md](./architecture.md#field-values) describes the envelope.

### Resolving state

For each field the op with the greatest `ts` wins, comparing `wall_ms`, then `counter`, then
`node` (as a UUID, by bytes). A delete is a tombstone with its own `ts`: a field is visible only
when its `ts` is greater than the entity's newest tombstone, and an entity whose tombstone hides
every field is deleted. Applying ops in any order, any number of times, gives the same state.
[`test-vectors/conflict_vectors.json`](../test-vectors/conflict_vectors.json) has worked cases.

## Routes

### `POST /sync/push`

Body: `{"operations": [<op>, …]}`, at most 5000 ops and `MAX_PUSH_BYTES` (2 MiB by default).

Response: `{"applied": <n>, "from": <seq>, "cursor": <seq>}`. `applied` counts ops the server had
not seen; a re-sent op id is ignored, so retrying a push is safe. `from` and `cursor` are the
caller's partition sequence before and after the push. A client whose pull cursor is at least
`from` may move it to `cursor`, since `(from, cursor]` holds only this push's ops.

Errors:

- `400 {"code": "clock_skew", "server_time": <ms>}`: an op's `wall_ms` is more than five minutes
  (300000 ms) past `server_time`. Nothing was applied. Do not drop the ops. Correct the clock
  offset by `server_time`, then re-stamp the unsynced ops stamped past `server_time` + 300000:
  the server never accepted them, so they may keep their ids. Stamp them in their old order from
  the corrected clock, above every stamp the client has seen from the server (its own
  acknowledged ops and every pulled op) and above the unsynced ops it leaves alone, and move the
  local clock back to the newest of these, then retry. Ops at or below the limit keep their
  stamps: an earlier push whose response was lost may have stored them.
- Other `400`, `403` (no permission for an op's project) and `413` (body too large) are
  permanent for that batch. Nothing was applied. Split the batch to find the op at fault.

### `GET /sync/pull?since=<seq>&limit=<n>`

The caller's ops with a sequence above `since`, in order. `limit` defaults to 500, at most 1000.

Response: `{"operations": [<op>, …], "from": <seq>, "cursor": <seq>}`. Pass `cursor` as the next
`since`. Pull again until a page comes back empty.

`410 {"code": "cursor_expired"}` means retention purged ops after `since`: bootstrap from the
snapshot. Push the outbox first, so no local edit depends on what was purged.

### `GET /sync/snapshot?next=<token>&limit=<n>`

The caller's current merged state, for a new device, in pages of at most `limit` entities
(default 100, at most 1000).

Response: `{"operations": [<op>, …], "cursor": <seq>, "next": "<token>"}`. Each field's winning
`set` op and each tombstone `delete` come with their original stamps; resolve them with the rule
above. Follow `next` until it is absent, then pull from `cursor`. Ops pushed during the walk come
again in that pull, which is harmless.

### `POST /sync/ws-ticket` and `GET /sync/ws`

`POST /sync/ws-ticket` returns `{"ticket": "<opaque>", "expires_in": 30}`: a single-use ticket
for one socket. Open `GET /sync/ws?ticket=<ticket>&since=<seq>&protocol=<version>` (browsers
cannot set headers on a WebSocket, so the version and ticket travel in the query). The handshake
answers `401` for an unknown, used or expired ticket, and `410 {"code": "cursor_expired"}`
before any socket opens when `since` predates retention.

The server sends text messages shaped like a pull response, `{"operations", "from", "cursor"}`:
first the backlog since `since`, then live ops. A message covers `(from, cursor]`: apply its ops,
but move your cursor to its `cursor` only when your cursor is at least `from`; otherwise pull to
fill the gap first. Close codes:

| Code   | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `4401` | The access token expired. Refresh it and reconnect.                           |
| `4403` | The session was revoked or the account disabled. Sign out.                    |
| `4410` | The cursor went stale during the backlog. Bootstrap from the snapshot.        |
| `1013` | The client fell behind the live stream. Reconnect; the backlog fills the gap. |
| `1011` | Reading the backlog failed. Reconnect.                                        |

The server pings every 30 seconds. Keep polling `pull` as a fallback in case the socket is down.

## Versions

| Version | Change                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------- |
| 3       | Load every project key and encrypt with the project's canonical key.                               |
| 4       | Field values use the `__enc: 2` envelope bound to entity and field.                                |
| 5       | The WebSocket opens with a single-use ticket, not the access token.                                |
| 6       | Load only owner-signed key deliveries and follow key rotations. Current, and the server's minimum. |

The minimum only rises: each version above fixed a way an older client harmed data or keys in a
way the server cannot detect. See [decision 0004](./decisions/0004-protocol-floor-only-rises.md).
