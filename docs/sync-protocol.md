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
- `x-atlas-sync-protocol: <version>`, the client's protocol version. The current version is 7.
- Optionally `x-atlas-sync-apps: <app>[,<app>…]`, the apps this client syncs (see
  [App scope](#app-scope)). Without it the client is a todo client.

The server answers `426 Upgrade Required` with
`{"code": "upgrade_required", "min_protocol": <n>}` when the version is missing or below its
minimum. Any route answers `429` with `Retry-After` when the user is over budget; pushes and
reads (pull, snapshot, socket tickets) have separate budgets. All routes are also served under
`/api`.

Before signing in, a client may read the public `GET /discovery` for the server's
`protocol_version`, `capabilities` and offered `apps`; a 404 means a server older than discovery
(protocol 1).

### App scope

The server hosts several apps of the Atlas suite (`manifests/<app>.json`, listed by
`GET /discovery`), all in one op log per account with one sequence. A client names the apps it
syncs in `x-atlas-sync-apps` (comma-separated app ids; servers with the `app_scoped_sync`
capability). A request without it is scoped to `todo`, so clients that predate the header see no
change.

- Pull, the snapshot, the WebSocket (backlog and live messages) and `GET /auth/export` carry only
  ops of the scope's apps. The cursor still moves past every other app's ops: a pull that is
  caught up returns the partition's newest sequence, and a live message whose ops all belong to
  another app arrives with `"operations": []` and its `from` and `cursor`, so the cursor moves
  without a gap. A cursor is valid only for the scope it was pulled under; a client that changes
  its scope bootstraps again from the snapshot.
- Push refuses an op outside the scope (below).
- The socket's scope is the one its `POST /sync/ws-ticket` request named.
- Refusals are `403 {"code": "app_not_enabled", "app": <id>, "scope": <where>}`:
  - `instance`: the server does not offer the app (`ATLAS_APPS`).
  - `account`: the account has not enabled it (`PUT /auth/apps/:app`).
  - `session`: a push holds an op of an enabled app outside the request's scope.
  - `token`: an API-token session named, or defaulted to, an app its token carries no key for.
- An app named in the header must be enabled for the instance and the account, or every route
  answers 403. Without the header, a todo the account or instance switched off is hidden silently
  (an empty pull), as before the header existed.
- An unknown app id or an empty list is `400`.

An API-token session can also be refused for its token (servers with the `api_token_policies`
capability): `401 {"code": "api_token_expired"}` once the token is past its `expires_at`, on every
route including the WebSocket ticket, and `403 {"code": "api_token_read_only"}` for a push (or any
request other than `GET` and the WebSocket ticket) from a token made without write access. Neither
is retried: only a new token helps.

See [architecture.md](./architecture.md#apps-and-manifests).

## Operations

All data is a set of entities, each a bag of fields with a client-generated random UUID id. A change
is an operation that sets one field or deletes the entity. On the wire it tells the server as
little as the server needs ([decision 0006](./decisions/0006-opaque-sync-metadata.md)):

```json
{
  "id": "<uuid, unique per op>",
  "entity": "todo.sealed",
  "entity_id": "<uuid>",
  "scope": "<project uuid, or null>",
  "op": "set",
  "field": "<32 lowercase hex digits>",
  "value": { "__enc": 3, "kid": "<key id>", "iv": "…", "ct": "…" },
  "ts": { "wall_ms": 1767225600000, "counter": 0, "node": "<device uuid>" }
}
```

A delete has `"op": "delete"` and no `field` or `value`.

- `entity` is a **wire kind**: `todo.project` for a todo project, `todo.sealed` for every other todo
  entity, `journal.sealed` and `vault.sealed` for the journal's and the vault's, and
  `project_member` for the membership rows only the server writes. The real kind (`task`,
  `comment`, `vault.item`, …) travels inside the value. The manifests
  ([`manifests/`](../manifests)) map each real kind to its wire kind. The server refuses other kinds,
  `project_member` ops and the legacy kinds below.
- `scope` is the project whose key encrypted the op, or `null` for the account's own key. The
  server routes the op by it: to the members of a shared project, else nowhere. A project op's
  scope is the project itself or null; a journal or vault op's is always null. An entity's scope is
  that of its newest op, so writing it under another project's key moves it (re-write every field,
  and its comments, activity and attachments, which carry their own scope).
- `field` is a **tag**, the first 16 bytes in hex of
  `HMAC-SHA256(tag_key, JSON.stringify(["atlas-field-tag", 1, entity_id, kind, field]))`, where
  `tag_key` is `HKDF-SHA256(key, no salt, "atlas-field-tag-v1", 32 bytes)` of the encrypting key and
  `kind`/`field` are the real ones. A few **public fields** keep their names because the server acts
  on them: a project's `deleted_at` and `archived_at` (owner-only) and an attachment's `blob_sha`
  and `thumb_sha` (blob addresses). The manifests list them as `public_fields`.
- `value` is at most 64 KiB serialized: a field envelope version 3 (below), or for the blob
  addresses, which the server reads, a lowercase 64-hex sha256 or null. The server refuses any
  other value, plaintext included.
- `ts` is a hybrid logical clock stamp. `counter` is at most 65535; a clock that would pass it
  moves to the next millisecond instead. `wall_ms` may be at most five minutes ahead of the
  server's clock.
- In what the server serves, every op also carries `pushed_by`: the account that pushed it, or
  `null` for the server's own ops. A client drops an `activity` whose `actor_id` is not its
  `pushed_by`.

### Field envelope version 3

`{"__enc": 3, "kid": "<key id>", "iv": "<base64>", "ct": "<base64>"}`: AES-256-GCM, with `kid`
`dek` for the account's own key or a project key's id.

- The plaintext is the UTF-8 JSON of `[kind, field, value]`, padded ISO/IEC 7816-4 style (0x80,
  then zeros) to at least 64 bytes, then the next power of two up to 1 KiB, then whole KiB.
- The associated data is the UTF-8 JSON of
  `["atlas-field", 3, entity, entity_id, field, scope, kid]` with the wire `entity` and `field`,
  and `scope` as `"personal"` or `"project:<id>"`.

A client opens a value only with a key of the op's scope, and accepts it only when its plaintext
names a kind of the op's wire kind and the wire field is that field's tag (or the field itself,
when public). [`test-vectors/envelope_vectors.json`](../test-vectors/envelope_vectors.json) has
worked envelopes and tags.

### Rows written before protocol 7

Rows a protocol 6 client wrote are served as they were stored: their real kind as `entity`, their
field names, version 2 or 1 envelopes, and the routing fields the manifests list as
`legacy_plaintext_fields` in plaintext. A client reads them, re-encodes the live ones in protocol 7
form keeping every field's stamp (so the copy changes no state), then drops the originals:

- `GET /sync/legacy/keys?next=<token>&limit=<n>`: `{"entities": [{"entity", "entity_id",
"covered"}], "next"}`, the legacy entities the caller's partition holds, of the session's apps.
  `covered` means a current copy at least as complete and as new already exists: drop it as it is.
- `POST /sync/legacy/drop` with `{"entities": [{"entity", "entity_id"}]}` (legacy kinds only, at most
  5000): deletes their rows from the caller's partition only. Answers `{"dropped": <n>}`.

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
for one socket, scoped to the apps the request named. Open `GET /sync/ws?ticket=<ticket>&since=<seq>&protocol=<version>` (browsers
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

| Version | Change                                                                                      |
| ------- | ------------------------------------------------------------------------------------------- |
| 3       | Load every project key and encrypt with the project's canonical key.                        |
| 4       | Field values use the `__enc: 2` envelope bound to entity and field.                         |
| 5       | The WebSocket opens with a single-use ticket, not the access token.                         |
| 6       | Load only owner-signed key deliveries and follow key rotations.                             |
| 7       | Wire kinds, scopes, field tags and `__enc: 3` envelopes. Current, and the server's minimum. |

The app scope (`x-atlas-sync-apps`) is no protocol version: it is optional, its absence means
todo, and clients detect it by the `app_scoped_sync` discovery capability.

The minimum only rises: each version above fixed a way an older client harmed data or keys in a
way the server cannot detect. See [decision 0004](./decisions/0004-protocol-floor-only-rises.md).
