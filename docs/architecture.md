# Architecture

Atlas Todo is local-first. Each client keeps a full copy of its user's data and edits it
offline. The server stores and relays encrypted edits between devices and between the members
of a shared project. It never needs to read the content.

This page is the reference for how things work. [SECURITY.md](../SECURITY.md) says what is and
is not protected, [self-hosting.md](./self-hosting.md) covers running a server,
[sync-protocol.md](./sync-protocol.md) is the wire contract, and [decisions/](./decisions/README.md)
records why the main choices were made.

## Components

| Path                   | Language              | Role                                                                                                                                                                                           |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/atlas-core`    | Rust                  | The hybrid logical clock, the op log types and the bundled app manifest registry. No I/O.                                                                                                      |
| `manifests/`           | JSON                  | One manifest per app of the suite (`todo.json`): its entity kinds and their plaintext fields. Compiled into the server, bundled by the clients.                                                |
| `crates/atlas-server`  | Rust (Axum, sqlx)     | HTTP and WebSocket API over PostgreSQL: accounts, sync, sharing, key distribution, attachments, admin. Also serves the web app.                                                                |
| `migrations/`          | SQL                   | The schema. Applied by the server at startup.                                                                                                                                                  |
| `packages/client-core` | TypeScript            | Local store, persistence, sync client, realtime, end-to-end encryption, API client.                                                                                                            |
| `packages/shared`      | TypeScript            | Pure logic for every client: recurrence, quick-add parsing, filters, habits, stats, ordering, TickTick/Todoist import, i18n catalogs.                                                          |
| `apps/mobile`          | React Native + Expo   | The only UI. Runs natively on Android and iOS and in the browser through react-native-web.                                                                                                     |
| `apps/electron`        | TypeScript (Electron) | Desktop shell that loads the web export from an `app://` origin.                                                                                                                               |
| `crates/atlas-client`  | Rust                  | A headless client for integrations: API-token sessions, the end-to-end encryption, sync and the task rules of `packages/client-core` and `packages/shared`, kept at parity by `test-vectors/`. |
| `crates/atlas-cli`     | Rust                  | The `atlas` command line over `atlas-client`, released as one static binary per platform.                                                                                                      |
| `test-vectors/`        | JSON                  | Shared fixtures (crypto, conflicts, recurrence, task rules, quick add, filters, CLI runs), read by both the Rust and the TypeScript tests.                                                     |

## How the clients share code

There is one UI codebase. `apps/mobile` uses Expo Router. Where a platform needs its own
implementation, a `.web.ts` file sits next to the native one and Metro picks the right file at
build time. Session storage and notifications work this way.

- Android and iOS run the React Native build. The local store persists to SQLite
  (`expo-sqlite`).
- Web is the same code exported with react-native-web. The server serves the export at `/` and
  the app calls the API at `/api` on the same origin. The local store persists to IndexedDB.
- Desktop is Electron around the web export. It adds a tray icon, deep links
  (`atlastodo://`), single-instance handling and a hardened protocol handler. See
  [apps/electron/README.md](../apps/electron/README.md).

All of them use `packages/client-core` for data, sync and encryption, and `packages/shared` for
domain logic. Neither package depends on React.

## Data model

Every piece of user data is an entity: a bag of named fields with a client-generated UUIDv7 id.
The entity kinds are `task`, `project`, `section`, `label`, `comment`, `preference`,
`saved_filter`, `reminder`, `project_member`, `activity`, `focus_session`, `habit`,
`habit_checkin` and `attachment`.

Clients never update rows in place. Every change is an operation:

```json
{
  "id": "<uuidv7>",
  "entity": "task",
  "entity_id": "<uuidv7>",
  "op": "set",
  "field": "title",
  "value": { "__enc": 2, "kid": "dek", "iv": "…", "ct": "…" },
  "ts": { "wall_ms": 1767225600000, "counter": 0, "node": "<device uuid>" }
}
```

An operation either sets one field or deletes the entity (`"op": "delete"`, a tombstone). The
op id makes pushes idempotent.

## Apps and manifests

Atlas is becoming a suite of end-to-end encrypted apps (todo and journal now; notes and a password vault
later) on one generic server and one account. Each app has a first-party manifest in
`manifests/<app>.json`: its id, a display name, a version, and its entity kinds with the fields
of each that travel in plaintext. The manifests are part of the release: `atlas-core` compiles
them in (`manifest.rs`, the `Registry`), and `packages/client-core` bundles the same files
(`fieldPolicy.ts`), so server and clients read one table. Operators never load a manifest from
disk. Bump a manifest's `version` whenever its kinds or plaintext fields change.

Todo's kinds keep their original bare wire names (`task`, `project`, …); every later app must
namespace its kinds as `<app>.<kind>` (`notes.note`), which the registry enforces. The registry
maps each kind to its app by wire name. The Rust `EntityKind` enum stays closed: authorization
and fan-out match on todo's kinds exhaustively, and an open kind would let an op of an unknown
kind slip past those matches. A new app adds its kinds as variants with an explicit
`#[serde(rename = "notes.note")]` next to its manifest; a test fails until every variant is in
exactly one manifest and every manifest kind is a variant.

Enablement has two levels:

- Instance: `ATLAS_APPS` (default `todo`; `todo,journal` to offer Atlas Journal) names the bundled apps the server offers. An id the
  release does not bundle stops the server at startup.
- Account: the `account_apps` table (`user_id`, `app`, `enabled_at`). A trigger gives every new
  user row `todo`, and the migration backfilled existing accounts. `GET /auth/apps` lists the
  instance's apps with the caller's enablement and `PUT /auth/apps/:app` enables one; both take
  an interactive session (an API token gets `403 interactive_session_required`).

The release bundles `todo` and `journal` (Atlas Journal: `journal.entry`, `journal.preference`,
every field encrypted). Journal's client is a separate app; this repository ships its manifest,
the server rules and the client-core helpers.

#### App-scoped sessions

All of an account's apps share one partition and one sequence, but each client syncs only its
own apps: a request names them in `x-atlas-sync-apps` (`apps.rs`, `SessionApps`), and a request
without the header is a todo session, which every client predating the header is. A session's
apps are its scope intersected with the apps enabled for the instance and the account.

- Pull, the snapshot, the WebSocket backfill and live stream, and `GET /auth/export` serve only
  the session's apps. Pull and the snapshot filter in SQL on the kinds of those apps. A pull that
  is caught up answers the partition head as its cursor, read before the ops (every seq up to the
  head is committed, see [One lock for sync writes](#one-lock-for-sync-writes)), so a Journal
  client's cursor moves past todo's ops and the reverse.
- The hub broadcasts each partition's live batch once; every socket narrows it to its session's
  apps and keeps `from` and `cursor`, so a batch of another app's ops arrives as an empty message
  that moves the cursor without a gap. The socket's scope is the one its ticket request named.
- Push refuses an op outside the scope with 403 `app_not_enabled`, scope `session`; an app the
  instance or account has off is scope `instance` or `account`.
- An app named in the header must be enabled, or the request is 403: a cursor that walked past
  the app's ops unseen would lose them for that client. A request without the header keeps the
  older behaviour of hiding a switched-off todo silently. Hidden data is kept and comes back,
  from the snapshot, once the app is enabled again.
- A cursor belongs to the scope it was pulled under. A client changing its scope bootstraps from
  the snapshot again.
- Fan-out to a shared project's members skips members whose account lacks the op's app.
- The scope needs no protocol bump: it is optional and defaults to todo. Clients detect it by the
  `app_scoped_sync` capability.

#### Journal is personal

Journal v1 has no sharing. Push resolves fan-out through `may_fan_out` and the project matches in
`sync/push.rs`, which list every `EntityKind` with no wildcard arm: journal kinds are owner-only,
the server reads none of their fields (not even one named `project_id`), and they never reach
another partition. A new kind fails to compile until it chooses.

#### Enabling an app

`enableApp` in `packages/client-core/src/rootKey.ts` generates the app's 32-byte key and X25519
identity, wraps them under the root ([Account root key](#account-root-key)), stores them with
`PUT /auth/app-keys/:app` and then enables the app with `PUT /auth/apps/:app`. The key is set once:
a device that loses a race gets 409 `key_already_stored`, loads the stored row from
`GET /auth/root-key` and opens it, so both devices end with one key. It needs the unlocked root:
an account from before root keys migrates at its next password sign-in or unlock (`ensureRootKey`)
and can enable apps after that. Both routes are interactive only, and both take only an app this
build bundles and the instance offers: `PUT /auth/app-keys/:app` answers 400 for an unbundled id
and 403 `app_not_enabled` (scope `instance`) for one `ATLAS_APPS` leaves out (`PUT /auth/apps/:app`
answers 404 and 403), so no key row lands under the root for an app nothing can use. The
`app_keys` of signup, migration and recovery must name bundled apps too.

### Discovery

`GET /discovery` is public and reads no database (here with `ATLAS_APPS=todo,journal`):

```json
{
  "service": "atlas-server",
  "version": "0.1.11",
  "protocol_version": 6,
  "min_protocol_version": 6,
  "capabilities": [
    "api_tokens",
    "app_manifests",
    "account_apps",
    "root_key",
    "app_scoped_sync",
    "app_scoped_api_tokens"
  ],
  "apps": [
    { "id": "todo", "name": "Atlas Todo", "version": 1 },
    { "id": "journal", "name": "Atlas Journal", "version": 1 }
  ]
}
```

It sits next to every other route (at `/` and under `/api`), not at `/.well-known/atlas`: clients
know the server by its API base URL, which may be a path such as `https://host/api` behind a
proxy, and a well-known path at the origin root could belong to something else there.
`protocol_version` is the newest sync protocol the server speaks (`SYNC_PROTOCOL`),
`min_protocol_version` the oldest client it accepts. Capabilities are only ever added.

`ApiClient.getDiscovery()` in client-core reads it. A server that predates the endpoint answers
404, or the web app's HTML in its place, and counts as legacy: protocol 1, no capabilities, todo.
`assertServerCompatible` checks a minimum protocol, capabilities and apps and throws
`ServerIncompatibleError`; the app runs it before signing in or up (`auth/serverCompat.ts`) and
says the server must be updated, or does not offer the app.

## Hybrid logical clock and last-writer-wins

Each device has a hybrid logical clock (HLC). A timestamp is `(wall_ms, counter, node)`:

- `wall_ms` follows the device's clock but never goes backwards.
- `counter` breaks ties within the same millisecond, so each stamp is strictly greater than the
  last one the device issued.
- `node` is the device id. It is the final tiebreak, so any two timestamps are ordered.

Receiving an operation moves the clock past its timestamp, so the next local edit wins over it.
The server refuses operations stamped more than five minutes ahead of its own clock. A client
likewise ignores a received timestamp that far ahead when it moves its clock, because one bad
timestamp would otherwise make every later local edit look too far in the future.

Merging is per field: the write with the greatest timestamp wins. The rule only compares
timestamps, so applying the same operations in any order gives the same state. Retries,
duplicates and out-of-order delivery are harmless. In Postgres the same ordering is a row
comparison on `(wall_ms, counter, node)`.

A delete is a tombstone with its own timestamp. Field writes older than the tombstone are
hidden. A field written after the tombstone is visible again, so an edit made after a delete
brings the entity back.

The rule runs on every client (`packages/client-core`) and on the server, which folds each pushed
op into the snapshot state with the same comparison. `test-vectors/conflict_vectors.json` holds
the cases both resolve; the server test pushes them one at a time and in reverse as one batch.

What this means in practice:

- Merging is per field, not per character. When two devices edit the same note offline, the
  later edit wins whole; the other is not merged in. Different fields of one task (title on one
  device, due date on another) both survive.
- An edit made concurrently with a delete, but stamped after it, brings the entity back with only
  the fields written after the delete. The other fields stay hidden by the tombstone.
- The rule has no notion of meaning. The server checks an op's shape, size, clock and the
  caller's role in the project, never what an encrypted value says. A buggy client can write a
  value no other client understands; the protocol floor (see [Protocol versions](#protocol-versions))
  is the lever for keeping such clients off.
- A device whose clock runs more than five minutes fast has its pushes refused with
  `clock_skew`. The client then runs its clock by the server's and re-stamps the edits it had
  queued with the fast clock, so they sync at once (see [Clock skew](#clock-skew)). Other devices
  order those edits by the corrected time, not by the time the fast clock showed. The app shows
  the skew in Sync details only while pushes stay refused.

## Sync

### On the device

`LocalStore` (`packages/client-core/src/store.ts`) is the client's source of truth. A local edit:

1. gets an HLC stamp,
2. updates the in-memory read model at once, so the UI never waits for the network,
3. is written to the persistent op log (SQLite or IndexedDB) and queued in the outbox.

On start-up the store replays its persisted log to rebuild the read model. Once most of the log
is superseded, it rewrites the log in one transaction to what the state needs: the winning
write of each field, the tombstones, and every change not yet synced.

### Local-only mode

The app also runs without an account. With no session it mounts the same `LocalStore` over a
database of its own (`atlas-local`, next to the per-account `atlas-<userId>` ones), with a
device id kept in AsyncStorage as the HLC node, and no `SyncClient`, keys or attachment queue
(`apps/mobile/src/auth/localMode.tsx`). Nothing reaches a server. Since nothing is ever pushed,
`LocalStore.compactLocal` drops superseded ops from the outbox too, which `compact` must not do
for an account.

Ops are encrypted only when pushed, so moving local data into an account is a copy: the outbox
is copied, still unsynced, into the account's database before its store mounts, and the first
sync encrypts and pushes it like any offline edit (`apps/mobile/src/auth/LocalUpgradeGate.tsx`).
A new account takes everything. An existing one is asked whether to merge or discard, and never
takes this device's preferences. Onboarding asks right after its welcome step whether to create
an account, sign in, or stay on the device.

Syncing a local-only store through a file in a cloud folder is sketched in
[local-file-sync.md](local-file-sync.md).

### Push, pull and live updates

`SyncClient` runs a cycle: push the outbox, then pull what is new.

- `POST /sync/push` sends a batch of operations. The server validates them and appends them to
  its log. When it confirms, the client marks them synced.
- `GET /sync/pull?since=<cursor>` returns the operations after the client's cursor, which is a
  server sequence number.
- `GET /sync/ws` is a WebSocket that streams the same pull-shaped messages as other devices
  push. It only makes delivery faster. The pull stays the source of record.
- `GET /sync/snapshot` gives a new device the current merged state instead of the whole history.

#### The WebSocket

Browsers and React Native cannot set headers on a WebSocket, so the socket authenticates with a
query parameter that proxies may log. That parameter is never the access token. Before each
connect the client asks `POST /sync/ws-ticket` for a single-use ticket: 256 random bits, valid
for 30 seconds, bound to the user and device that asked. The handshake consumes it. A bad, used
or expired ticket fails the HTTP upgrade before any socket exists. The socket closes when that
device's access token expires.

The first message is a backfill of the operations since the client's cursor. Every later message
is the same `{ operations, from, cursor }` shape, fanned out from the server's broadcast hub.
`from` and `cursor` give the range of sequence numbers a message covers, and the client only
moves its cursor when there is no gap. A socket that falls behind is closed with code 1013
instead of silently dropping messages.

#### Protocol versions

Every sync request carries the client's protocol version (`x-atlas-sync-protocol`, or a
`protocol` query parameter on the WebSocket). The server answers `426 Upgrade Required` below its
minimum, and the app asks the user to update. The minimum is 6, the current version
(`MIN_SYNC_PROTOCOL` in `sync/mod.rs`, `SYNC_PROTOCOL` in `realtime.ts`). The minimums exist because
older builds do harm that the server cannot detect:

- 3: load every project key and encrypt with the project's canonical key. Older builds minted
  their own keys and forked a shared project's encryption.
- 4: write field values in the bound `__enc: 2` envelope, which older builds cannot open.
- 5: open the WebSocket with a single-use ticket instead of the access token in the URL.
- 6: load only key deliveries signed by the owner, and follow rotations. A protocol 5 build keeps
  writing under a key that a rotation retired, which the member who left can still read.

#### Clock skew

A push holding an op stamped more than five minutes past the server's clock is refused whole with
`400 {"code": "clock_skew", "server_time": <ms>}`, before anything is written. The client
(`SyncClient.pushOutbox`, `LocalStore.restampAhead`) then:

1. sets its clock offset to `server_time` (`alignClock`), so new edits are stamped by the
   server's clock. The offset lives in memory and is dropped when the device clock is set.
2. re-stamps every unsynced op stamped past `server_time` plus five minutes. The server could
   never have accepted such an op, not even in an earlier push whose answer was lost, so it keeps
   its op id. Unsynced ops at or below that limit keep their stamps.
3. pushes again, once in the same cycle.

The new stamps come from the corrected clock, started from a floor: the newest stamp among the
ops the server holds that this device has seen (its own acknowledged ones and every op it
pulled) and the unsynced ops it keeps. The re-stamped ops are taken in their old order. So they
keep their order among themselves, stay above every op they beat before, and nothing an earlier
cycle acknowledged can beat a later edit. No comparison the read model made changes, so the
store only updates the stamps of the field values and tombstones these ops won, and rewrites
their rows in the op log in one transaction (a failed write is retried, like a failed append).
The HLC is wound back to the newest of these stamps, so later edits use the corrected clock and
still beat everything the device has seen. A second refusal in the same cycle leaves the ops
queued, as before, and re-stamping again changes nothing.

### On the server

Each user has a private partition (rows keyed by user id) in three tables:

- `operations`: the append-only log, ordered by a global `server_seq`.
- `entity_fields` and `entity_tombstones`: the merged state, folded from each pushed op with
  the same last-writer-wins rule, so the server converges exactly like a client. The snapshot
  reads from here.

A push writes into the caller's partition. For a shared project the server also copies each op
into every active member's partition (fan-out). It finds the project from the plaintext
`project_id` (tasks, sections) or `task_id` (comments, activity, attachments). Pull, the
WebSocket and the snapshot only read the caller's own partition.

#### One lock for sync writes

Every transaction that inserts into `operations` takes one PostgreSQL advisory lock first
(`SYNC_WRITE_LOCK`). That covers client pushes, server-authored fan-out and the retention
purge. The lock key halves spell `atla` and `s_sy`.

`server_seq` is allocated when a row is inserted but only becomes visible at commit. Without
the lock, transaction A could allocate seq 10, transaction B allocate 11 and commit first, and
B's pull would move the client's cursor to 11. A's seq 10 would then never be delivered, a
permanent and silent loss. With the lock held from before the first insert until the end of the
transaction, allocation order equals commit order. The allocated but uncommitted seqs are always
a contiguous suffix above every committed one, so a cursor can never skip one. That also makes
the cursors in push responses and live pushes safe.

A lock per caller would not be enough, because a partition also receives rows fanned out from
other users' transactions, so two pushers who share a project can interleave inside one target
partition. Locking every partition a transaction might write, in sorted order, would work but
needs the full write set up front. Pushes are short, so one global lock is the simplest choice
that is provably correct, and a single key taken first cannot deadlock. Pushes from all users
queue on it, each holding a pooled connection while it waits, so `DB_MAX_CONNECTIONS` bounds how
many can wait at once.

Server-authored ops (membership rows, revocation tombstones) are stamped by one server clock.
Receiving a push moves that clock past the push's newest stamp, so these ops order after what
the server has already accepted. A client may stamp up to five minutes ahead, and the server
clock then follows it. That is by design: those ops touch only server-managed membership rows,
or delete a task the caller lost access to, and both must win.

The live fan-out to open sockets and the socket tickets are kept in the server's memory. That is
enough while one server instance serves every client, which is how Atlas Todo is deployed. A user
holds at most 8 unredeemed tickets (a new one replaces the oldest) and the server at most
10,000, beyond which a ticket request answers `429`. Several instances would need a shared ticket
store and a shared fan-out.

#### Snapshot

`GET /sync/snapshot` returns the caller's merged state in the same wire shape as pull: field
`set` ops and tombstone `delete` ops, each with its true HLC. A deleted entity arrives the way
the log would replay it, with its stored field writes and its delete. The client's ordinary
rule (a field newer than the tombstone stays visible) then gives the state the server folded.

Pages are keyset-paginated over `(entity, entity_id)`, so they stay stable under concurrent
pushes, and `limit` bounds entity keys per page. The cursor handed back is the partition's
highest `server_seq`, read on the first page before anything is materialized and repeated on
every page. Ops committed during the walk are therefore delivered again by the pull that
follows, which is harmless because ops are idempotent.

#### Retention and the pull watermark

Old operations are purged after `OP_RETENTION_DAYS` (30 by default). New devices load the
snapshot. A device whose cursor points into purged history gets `410 Gone` from pull
(`cursor_expired`) and reloads from the snapshot too. The Resync button in Sync details
(Settings) does the same on request, after pushing what the device has not sent yet.

A purge commits its deletions and its watermark together. Pull therefore reads the ops first and
the watermark second: any purge that could have thinned the page is visible by then, and the
answer is `410`.

### Sharing

Membership lives in `project_member` rows, which only the server writes into each member's
partition. Roles are owner, editor and commenter. An owner invites an existing account by
email, and the invitee accepts or declines. Membership is changed through REST, not through the
op log, and a successful change triggers a sync so the updated `project_member` entities
arrive.

When someone accepts, the server copies the project's existing history into their partition
(the backfill). It reads the project from one database snapshot without the sync write lock,
then takes the lock only to correct for keys written since and to write the copy. A large
project therefore does not hold up every other push.

A member who was removed and then accepts a new invite still holds the tombstones the removal
wrote, which are newer than the owner's fields. A device cannot drop a tombstone, only outrank
it, so the backfill rewrites each hidden field just above its tombstone.

When a task moves to a project some members cannot see, or out of any project, the server
deletes it from those members' partitions and records the revocation in `revoked_tasks`. A
tombstone alone would not keep it away: an edit a member made while offline outranks it, and
retention purges it. So the server refuses a member's edits of a revoked task until it is back
in a shared project they belong to.

## Accounts and sessions

Access tokens are JWTs that live 15 minutes by default. Refresh tokens last 30 days and are
single-use: the server consumes one and issues a replacement. Presenting a consumed token again
is treated as theft and revokes the device's whole token family.

Every authenticated request also checks that the token's device still has a live refresh
family, so signing a device out (or ending its session from another one) takes effect on its
next request, not when its access token expires.

The client takes care not to trip this itself (`packages/client-core/src/api.ts`):

- Concurrent 401s share one rotation. A cold start fires a sync, `me()` and `listInvites()`
  together with an expired token. If each refreshed on its own, the loser would present the token
  the winner just consumed, the server would revoke the family including the winner's new token,
  and the user would have to log in again.
- Clients that share a session, such as browser tabs, rotate under the token store's
  `withRefreshLock`. The client re-reads the stored pair first, adopts it if a sibling already
  rotated, and writes the new pair before releasing the lock.
- Where there is no cross-client lock (plain-http origins have no `navigator.locks`), the refresh
  asks for the server's reuse grace. A reuse right after a rotation then gets a non-revoking
  `refresh_superseded` 401, and the client waits briefly for the sibling's pair and retries.
- A rejected refresh (401 or 403) is final. It is reported through `onAuthExpired` and the token
  is dropped, so a dead token cannot loop into the auth rate limit. A 429 or a network failure is
  transient and leaves the session alone.

### API tokens

Integrations sign in with a personal API token instead of a password
(`crates/atlas-server/src/auth/api_tokens.rs`, `packages/client-core/src/crypto/apiToken.ts`;
usage in [integrations.md](./integrations.md)).

- **Creating a token.** The app generates it: a 16-byte id and a 32-byte secret. HKDF over the
  secret gives an auth value and a wrapping key. The app uploads the id, the auth value and the
  DEK and X25519 private key wrapped under that key (`POST /auth/api-tokens`). The server stores
  the auth value's SHA-256 and the wraps (`api_tokens`), and never sees the secret. A token is
  one more key slot, like the recovery wraps, and only its holder can open it.
- **Opening a session.** `POST /auth/api-token/session` checks the id and auth value and returns
  an access token with `kind: "api_token"` and `did` set to the token id, plus the wraps. There is
  no refresh token: the holder exchanges again. `authenticate_bearer` treats such a session as
  live while its `api_tokens` row is unrevoked.
- **Limits.**
  - `InteractiveAuthUser` refuses a token session with 403 `interactive_session_required` on the
    account-critical routes: credentials, recovery, sessions, API tokens, account deletion,
    export, the signing-key upload, the account root key and app keys, and admin.
  - A token is scoped to apps (`api_tokens.apps`, `{todo}` for every token made before scopes
    and whenever the client names none). It carries a copy of each of their keys: todo's as
    before (`wrapped_dek`, `wrapped_private_key`, sent exactly when the token is for todo),
    every other app's key and identity in `app_keys`, one entry per app with `wrapped_key` and
    `wrapped_private_key` (associated data slots `app_key:<app>` and `app_private_key:<app>`,
    `wrapAppKeysForApiToken`). Creating one needs the app enabled and keyed for the account.
    It never carries the account root key.
  - A token session syncs only its token's apps: a scope naming another app, or the implicit
    todo scope of a token without todo, is 403 `app_not_enabled` with scope `token`. The session
    response lists the token's `apps`. The app's settings screen still makes todo tokens only.
  - Sync, project keys, members and attachments accept token sessions.
  - An account holds at most 25 live tokens.
- **Revoking.** Revoking a token, recovering the account or scheduling its deletion sets
  `revoked_at` and nulls the wraps (`app_keys` too), so a token string that leaks afterwards opens nothing. A
  password change leaves tokens alone, since the DEK does not change.

### Where a web session is stored

Native apps keep the session in the OS keychain (`expo-secure-store`). The browser build, which
the desktop app also runs, stores it in `localStorage`: `session.web.ts` replaces `session.ts`,
and the two have the same signatures so the auth context is identical everywhere.

A token in `localStorage` is readable by any script on the origin, so an XSS bug could take the
refresh token. The usual fix, an httpOnly refresh cookie, is not used. It needs credentialed
CORS, which does not fit a bring-your-own-server URL and any-origin servers. And when the web app
and the API are on different subdomains, the cookie would be third-party and subject to browser
blocking. The remaining risk is limited by refresh-token reuse detection, a Content-Security-Policy
on the web app, auth rate limiting and the short access-token lifetime. The cookie approach is
worth revisiting only if the API and the web app share one origin.

The unlocked E2EE keys are covered under [Key storage on the client](#key-storage-on-the-client).

## End-to-end encryption

All cryptography runs on the client (`packages/client-core/src/crypto`). The server stores only
ciphertext and wrapped keys.

### Key hierarchy

```
password + salt ── Argon2id (or PBKDF2) ── HKDF ──┬── auth hash ──► server (stored as Argon2id)
                                                  └── MEK (master encryption key, device only)
                                                         │ wraps (password slot)
recovery phrase ── recovery key ─── wraps (recovery slot) ──┐
                                                         ▼
                                    account root key (random 256-bit)
                                                         │ wraps, one per app (account_app_keys)
                               ┌─────────────────────────┴──────────── … notes, vault (later)
                               todo app key = the DEK (personal data key)
                               │ encrypts                    │ wraps
                               personal fields               X25519 private key (todo identity)
                               │ wraps                       │ opens
                               ├── Ed25519 identity key      PEKs sealed to this user
                               │   (signs PEK deliveries)    │
                               │ wraps (own copy)            │
                               PEK (one per shared project) ◄┘
                               │ encrypts
                               fields of the project's tasks, sections, comments, …

recovery phrase (24 words, BIP-39) ── HKDF ──┬── recovery key: wraps the root key (recovery slot)
                                             └── recovery X25519 keypair: answers the recovery challenge
```

Deprecated, still written for clients predating the root key: the DEK and the X25519 private key
wrapped directly under the MEK (`users.encrypted_dek`, `users.encrypted_private_key`) and under
the recovery key (`users.recovery_encrypted_dek`, `users.recovery_encrypted_private_key`). See
[Account root key](#account-root-key).

- The DEK is a random 256-bit key that encrypts personal data.
- Each shared project has a random 256-bit project key (PEK).
- Each account has an X25519 key (deliveries are sealed to it) and an Ed25519 signing key,
  created at signup and wrapped under the DEK, so password changes and recovery leave them
  alone. Accounts that predate the signing key get one on their first unlock.
- A password change re-wraps the root key (and the deprecated DEK and private key wraps) under the
  new MEK on the device. Neither the root nor the DEK changes.

### Account root key

Atlas is becoming a suite of apps on one account. Each app gets its own key, and one account root
key sits above them (`crates/atlas-server/src/auth/root_key.rs`,
`packages/client-core/src/crypto/rootKey.ts` for the formats, `packages/client-core/src/rootKey.ts`
for the flows; vectors in `test-vectors/root_key_vectors.json`).

- **Slots.** An unlock slot is the root wrapped under that slot's 32-byte key with AES-256-GCM:
  `{ "v": 1, "iv", "ct" }`, associated data `["atlas-root-key", 1, user_id, slot]`. The slots
  today are `password` (under the MEK, `users.encrypted_root_key`) and `recovery` (under the
  phrase's recovery key, `users.recovery_encrypted_root_key`). `users.root_key_created_at` says
  whether the root exists; no slot does, so an account without a password slot is possible.
- **App keys.** `account_app_keys(user_id, app, wrapped_key, wrapped_private_key)`: the app's key
  under the root, associated data `["atlas-app-key", 1, user_id, app]`, and the app's X25519
  identity under the app key (`["atlas-app-identity", 1, user_id, app, "x25519"]`). The account's
  existing DEK is the `todo` key, unchanged, and its existing keypairs are the todo identity, so
  no data was re-encrypted: field values, PEK copies under the DEK, the signing key and API token
  wraps all keep working. `PUT /auth/app-keys/:app` adds a new app's key, once.
- **Hard rule.** Nothing belonging to another app, and never the root, is wrapped under the old
  DEK (the todo key): API tokens carry a copy of it. Every route that reads or writes the root or
  an app key row (`/auth/root-key`, `/auth/root-key/recovery`, `/auth/app-keys/:app`, and the
  credential routes) is `InteractiveAuthUser`, so a token session gets 403
  `interactive_session_required`. A token session opens as before and never receives the root.
- **Opening.** Sign-in, refresh and cancelling a deletion return `encrypted_root_key`, `app_keys`,
  `has_root_key`, `has_recovery_root_key` and `recovery_public_key`. The client opens root, then
  the todo key, then the todo identity, and falls back to the legacy MEK wraps when the account
  has no root or the slot does not open.
- **Signup.** The client picks the account id (`user_id`, a v4 UUID, since the wraps bind it),
  generates the root, and sends the password slot, the recovery slot (under the phrase's recovery
  key) and the todo key with the legacy wraps.
- **Migration.** An account from before root keys migrates on its next password sign-in or
  unlock, on the device: a new root, the DEK as the todo key under it, the root under the MEK, and
  `POST /auth/root-key` with the current auth hash. The phrase is not at hand then, so the
  recovery slot is the root **sealed** to the account's recovery public key (ephemeral X25519,
  HKDF info `atlas-root-seal-v1`, associated data
  `["atlas-root-key", 1, user_id, "recovery-sealed", recovery_public_key]`, wire form
  `{ "v", "epk", "iv", "ct" }`). An account with no phrase-derived recovery key (version 1) gets
  no recovery slot until it registers one; the next sign-in or unlock then seals one
  (`PUT /auth/root-key/recovery`, also used after a phrase replaced by an old client). The server
  sets the root once, in a transaction: a second device gets 409 `root_key_exists` and loads the
  stored root (`GET /auth/root-key`). A failed migration leaves the legacy path working and is
  retried at the next sign-in.
- **Credential changes.** Password change and KDF upgrade send the root re-wrapped under the new
  MEK; phrase replacement sends it wrapped under the new phrase. Each lands in the `UPDATE` that
  swaps the credential, together with the legacy wraps.
- **Recovery.** `GET /auth/recovery-keys` adds the account id, the recovery slot and the todo
  key, with same-shaped dummies when absent (the slot is always padded with an `epk`, and the
  client tries both forms). The client opens the slot with the phrase and keeps that root only if
  it opens the todo key to the DEK the phrase recovered from the legacy recovery wrap: anyone can
  seal to the recovery public key, so an unchecked sealed slot could hold a root the server chose.
  It then re-wraps the root under the new MEK and writes the slot in the phrase-wrapped form. When
  there is no usable slot (an account without a recovery key, or not migrated), the client sends
  a new root and todo key instead (`app_keys`), which the server accepts only while the account
  has no recovery slot.
- **Older clients.** Clients predating root keys keep signing in on the legacy wraps, which every
  write keeps current. Their password change, KDF upgrade or recovery carries no root slot, so the
  stored one would no longer open: the server drops the root and its app keys
  (`drop_for_legacy_write`), and the next current client re-creates them. If an app other than
  `todo` holds a key, that would lose it, so the server refuses such a write with 409
  `root_key_required` instead. Their phrase replacement empties the recovery slot. The legacy
  wraps go once no supported client needs them; the recovery check above must then rely on the
  phrase-wrapped form.
- **Passkeys.** A passkey is one more slot, `passkey:<credential id>`, in a table of its own (see
  [Passkeys](#passkeys)). A passkey-only account has no password slot; `root_key_created_at`
  still marks the root.

### Passkeys

Passkeys sign in and unlock (`crates/atlas-server/src/auth/passkeys.rs` for the routes,
`auth/webauthn.rs` for the relying party, `packages/client-core/src/crypto/passkey.ts` and
`passkeys.ts` on the client; vectors in `test-vectors/passkey_vectors.json`). They are on when
the server has `WEBAUTHN_RP_ID`, which adds the `passkeys` capability to discovery.

- **PRF is required.** Every ceremony asks for the WebAuthn PRF extension with one fixed input,
  SHA-256 of `atlas-passkey-prf-v1`: a discoverable sign-in cannot know which passkey will answer,
  so it cannot name a per-credential input. Outputs still differ per passkey (the authenticator's
  PRF secret is per credential). The slot key is HKDF-SHA256 over the 32-byte output, salt = the
  raw credential id, info `atlas-passkey-slot-v1`; it wraps the root like any slot. A registration
  whose `create()` returns no PRF output is followed by one `get()` of the new credential (some
  authenticators only evaluate PRF on assertions); none at all is refused. The client strips the
  output from every response, and the server refuses a response that carries `prf.results`. The
  server stores the input per credential (`passkeys.prf_salt`) so a later scheme can differ.
- **Storage.** `passkeys` holds the credential id (base64url), the credential as webauthn-rs
  stores it (`Passkey`: public key, algorithm, counter, flags), copies of the signature counter, transports, backup flags, name, created and last-used times, and the
  wrapped root. Challenges live in `webauthn_challenges` (purpose, account, the ceremony state webauthn-rs
  verifies against, expiry), each spent by
  the `DELETE … RETURNING` that answers it, within six minutes.
- **Verification.** webauthn-rs (`auth/webauthn.rs` adapts it): `clientDataJSON` type, challenge
  and exact origin (`WEBAUTHN_ORIGINS`, plus the Android app's `android:apk-key-hash:` origin), the
  RP ID hash, user presence and user verification, the signature (ES256, RS256) and a counter
  that must increase unless both sides are zero (synced passkeys keep none). Attestation is not
  verified: options ask for `none`. webauthn-rs does not model PRF, so the extension is added to
  the options JSON; registration options also ask for a discoverable credential, and a modal
  discoverable sign-in drops the conditional mediation webauthn-rs sets. It links OpenSSL.
- **Ceremonies.** `POST /auth/passkeys/signup/options` (unauthenticated, for the client-chosen
  account id, which is the passkey's user handle) then `POST /auth/signup` with `passkey` and no
  password: the account gets the passkey's slot and the recovery slot, no password slot, no
  `password_hash` and no MEK-wrapped legacy keys. `POST /auth/passkeys/register/options` and
  `POST /auth/passkeys` add one to a signed-in account, with the current password or a passkey
  proof. `POST /auth/passkeys/login/options` (discoverable, or email-first with each credential
  named; an unknown email gets a stand-in) and `POST /auth/passkeys/login` open a normal session
  plus `passkey`: the credential and its wrapped root, from which the client opens the todo key and
  identity.
- **Re-authentication.** `POST /auth/passkeys/reauth/options` and `POST /auth/passkeys/reauth`
  answer a single-use proof valid five minutes (only its SHA-256 is stored, in
  `passkey_reauth_proofs`), and the passkey's slot, so a re-authentication also unlocks a locked
  session. Every route that took `current_password` takes `reauth_token` instead: password change
  (which is how a passkey-only account adds a password), recovery-key registration and
  replacement, account deletion, the root-key routes, adding and removing passkeys and
  `DELETE /auth/password`. API token creation never asked for the password and does not now.
- **Lifecycle.** Passkeys can be renamed and removed; the last way in (the last passkey of an
  account without a password, or the password of an account without passkeys) cannot be removed
  (409 `last_unlock_method`). A password change keeps the passkeys (the root is unchanged). A
  recovery, a scheduled deletion and a dropped root delete them. Recovery of a passkey-only
  account sets a password; the user adds passkeys again afterwards. Cancelling a deletion takes
  the password, so a passkey-only account recovers first.
- **Platforms.** The web app uses `navigator.credentials`; Android uses Credential Manager through
  the app's `modules/atlas-passkeys`, which passes WebAuthn JSON through unchanged and needs the
  domain's Digital Asset Links (`/.well-known/assetlinks.json`, served from
  `ANDROID_APP_PACKAGE` / `ANDROID_APP_CERT_SHA256`). The desktop app runs from `app://atlas-todo`,
  an origin no relying party ID can match, so it offers no passkeys; iOS has no support yet. Every
  route here except sign-up and sign-in is `InteractiveAuthUser`.

### Login and the password KDF

The client asks for the account's salt and KDF (`GET /auth/salt`), derives the auth hash and
the MEK, and sends only the auth hash. The server compares it with an Argon2id hash. The
password and the MEK never leave the device.

Each account names its KDF version and parameters (`users.kdf_version`, `users.kdf_params`). The
KDF turns the password and salt into a 32-byte master key, and HKDF expands that into the auth
hash (`atlas-auth-v1`) and the MEK (`atlas-mek-v1`), the same for every version. The code is
`packages/client-core/src/crypto/kdf.ts`, with shared vectors in
`test-vectors/password_kdf_vectors.json`.

- Version 2 is the current one: Argon2id (RFC 9106, v1.3) over the NFC-normalized password, with
  64 MiB of memory, 3 passes and 1 lane.
- Version 1 is PBKDF2-HMAC-SHA256 with 600 000 iterations over the password as typed. Accounts
  from before version 2 keep it until the owner next signs in. The client then derives the
  version 2 key, re-wraps the DEK and private key under the new MEK, and swaps the credential,
  the wraps and the version in one request (`POST /auth/change-password` with `kdf_upgrade`),
  authenticated by the version 1 auth hash. If that fails, the account stays on version 1.

Signup, password changes and recovery always write version 2. The client refuses parameters
below version 2's or beyond what a phone can run, and the server refuses to store them. For an
address with no account, `GET /auth/salt` answers with version 2, like a new account would.

Why these Argon2id parameters: RFC 9106 section 4 recommends 3 passes and 64 MiB for constrained
memory, paired with 4 lanes. The libraries used here (Bouncy Castle, hash-wasm and
@noble/hashes) all run lanes serially. Extra lanes would cost the device the same time and save
an attacker's parallel hardware some, so the app uses 1 lane. The cost is about 0.13 s in
WebAssembly on a desktop, 0.2 s in Bouncy Castle on the JVM and 0.7 s in pure JS under Node. A
mid-range Android phone takes 1 to 2 seconds, about as long as a sign-in should wait.

The web and desktop apps run Argon2id in WebAssembly (hash-wasm), Android in a native module
(Bouncy Castle, `apps/mobile/modules/atlas-argon2`), and anything else in pure JS.

### Field values

A field value is serialized to JSON, padded to a size bucket (at least 32 bytes, then powers of
two up to 1 KiB, then whole KiB) and encrypted with AES-256-GCM and a random 96-bit IV. The wire
form is `{ "__enc": 2, "kid": …, "iv": …, "ct": … }`, where `kid` is the key's id: `dek`, or the
PEK's fingerprint.

The associated data binds the value to the envelope version, entity kind, entity id, field name,
key scope (`personal` or `project:<id>`) and key id. A value copied somewhere else does not
open (`crypto/field.ts`).

The key is the project's PEK if the entity belongs to a shared project, and the DEK otherwise. A
value is only opened with a key of the scope its entity is in, and automatic repairs only
re-encrypt within that scope (`scope.ts`).

Clients before sync protocol 4 wrote `{ "__enc": 1, "iv": …, "ct": … }` with nothing bound and no
padding. It is still read and never written; see
[SECURITY.md](../SECURITY.md#upgrading-from-a-pre-public-build).

### Project keys

`project_keys` is an append-only history per `(project, user, key_id)`. The `key_id` is a
fingerprint of the PEK computed by the client, and it is not secret. Each row is one of two
kinds:

- `wrapped`: the user's own copy of the PEK under their DEK, with the project id as associated
  data (`{ "v": 2, "iv": …, "ct": … }`), so the server cannot return one project's key as
  another's. Older copies are `{ "iv": …, "ct": … }` with nothing bound.
- `sealed`: a delivery from an owner, sealed to the user's X25519 public key with an ephemeral
  ECDH and AES-256-GCM. The user's client opens it and stores it back as its own `wrapped` copy.

The history keeps every key a user ever held, so content encrypted under a forked or retired key
stays readable.

#### The canonical key

The server names one canonical key per shared project, so all members encrypt with the same one.
After a rotation it is the key the rotation made canonical (`project_key_state`). Before any
rotation it comes from the project's earliest active owner (by `project_members.created_at`). It
is the first fingerprinted `wrapped` copy of theirs that another member also holds, or, while
nobody else holds one, simply the first.

Both orderings are fixed once established, so the canonical key never flips between two keys,
which would fork the project again. Preferring a key others hold matters when ownership changes
hands. The new owner's first row may name a key only they have, and the server cannot check what
a fingerprint stands for. Making that key canonical would leave every other member unable to
write. When the earliest owner has not fingerprinted a key yet, the project has no canonical key
rather than borrowing a later owner's.

A project shared before project keys existed gets its first key from its owner's key maintenance.
`PUT /projects/:id/keys` refuses a second key for a shared project while anyone holds one.

#### Signed deliveries

An owner signs each delivery with its Ed25519 identity key. The signature covers a
length-prefixed encoding of a domain string, the project id, the recipient's id, the key id and
the sealed bytes (`crypto/identity.ts`, vectors in `test-vectors/identity_vectors.json`). The
server stores the signature with the signer and hands both back with the signer's published
keys. It checks only that the signature is well formed. The recipient verifies it against the
key it pinned for that owner.

Both public halves of an account's identity are published (`GET /users/public-key`, the member
list).

#### Rotation

When someone who held a project's key leaves it, the server marks the project
(`project_key_state`, `request_rotations`) and lists it to its active owners
(`GET /project-keys/rotations`). The first owner client to get to it mints a new PEK, stores its
own copy, delivers it signed to the remaining members it has pinned, and completes the rotation
with `POST /projects/:id/key-rotation`.

The new key becomes canonical and every older key is retired. Members keep retired keys to read
what was written under them, since values are not re-encrypted. Owners also deliver retired keys
to members who join later. Clients never make a retired key canonical again. A request made while
another is outstanding only raises a counter, so the owner that serves it rotates once for both.

### Key trust

The server distributes keys, names canonical keys and lists members with their public keys.
Apart from the owners' signatures, none of that is authenticated. So the client acts on it only
within what the user did, and records those decisions in its own encrypted state.

The state is fields of one `preference` entity, encrypted under the DEK and synced across the
user's devices, so the server cannot forge it (`packages/client-core/src/trust.ts`). Each fact is
its own field, so two devices recording different facts never overwrite each other, and the
field's encryption binds the value to its name.

| Field                           | Value                        | Meaning                                                                                                                                                                |
| ------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted:<projectId>`          |                              | The user accepted this project's invite. Keys sealed to the user are accepted only for these projects.                                                                 |
| `minted:<projectId>`            | key id                       | The user created the project's key when sharing it. It stays canonical whatever the server names.                                                                      |
| `pin:<projectId>:<userId>`      | public key                   | The invitee's public key as fetched at invite time (trust on first use), or the X25519 key of an owner whose signed delivery was loaded. Keys go only to pinned pairs. |
| `identity:<userId>`             | `<X25519 hex>:<Ed25519 hex>` | Another account's identity keys, pinned on first sight. The Ed25519 half may be filled in later. A key that differs from the pin is reported, never adopted.           |
| `verified:<userId>`             | safety number                | Compared out of band. Counts only while it matches the pinned keys.                                                                                                    |
| `retired:<projectId>:<keyId>`   |                              | A rotation retired this key. It is never made canonical again.                                                                                                         |
| `first_key_members:<projectId>` | comma-separated user ids     | Members of a project shared before project keys existed, as they stood when it got its first key. Each is pinned on first delivery.                                    |
| `legacy_shares_recorded`        |                              | Shares joined before invites were recorded here were recorded as accepted.                                                                                             |
| `keys_initialized`              |                              | The baseline was recorded. Before it, an upgraded account loads keys as it used to.                                                                                    |
| `legacy_migrated`               |                              | The account's own old-format values were rewritten, so plaintext in an encrypted field, or a version 1 value under the personal key, can only be a forgery.            |

Loading a sealed key follows these rules (`projectKeys.ts`):

- Anyone can seal a key to the user's public key, so a sealed key loads only with its owner's
  signature under the key pinned for that owner, and only for a project whose invite the user
  accepted. For the user's own project it must come from a co-owner they invited.
- The canonical key is the one the user minted for their own project, or the server's choice for
  a project they joined.
- A delivery stored before signing existed loads only if it holds a key already in the keyring.
  Its owner re-delivers it signed.
- The client re-encrypts a value under another key on its own only within one project, and never
  moves a personal value into a project or one project's value into another. That happens only
  when the user shares a project or moves a task or section.

#### Trust on first use and safety numbers

The first time the client sees a member's keys, it believes what the server shows. A server that
swapped in its own keys at that moment, for a new member or for the owner who first sends a key,
would go unnoticed. Safety numbers close that gap.

The share dialog shows a safety number per member, derived from both accounts' identity keys and
identical on both screens: Signal's iterated SHA-512 over each side's account id and both
identity keys, 30 digits per side, sorted so both see the same 60. The two compare it in person
or on a call and can mark the member verified. The mark is kept in the synced trust state and
holds only for those exact keys. If a key changes, the dialog shows a warning instead.

#### Sharing flow

The share dialog (`ShareDialog.tsx`) ties this together:

- The first share mints the project's key and re-encrypts the project under it. Each invitee then
  gets it sealed to their public key.
- The server accepts a member's key only once they have a membership row, so the invite goes
  first.
- The invitee's public key comes from the server, so the invite pins it. Every later delivery,
  from a retry in the dialog or background maintenance, goes only to the pinned key. A different
  key is reported, not used.
- Removing a member rotates the project key.

### Attachments

The server stores AES-GCM ciphertext only. Attachment metadata syncs through the op log as an
`attachment` entity. The binary transport is `PUT/GET /attachments/blobs/:sha256`, backed by a
content-addressed store: files under `BLOB_DIR`, or objects in an S3 bucket.

#### Keys and metadata

Each file gets a fresh attachment key (AEK). The file's name, type and plaintext hash are
encrypted under it in the `meta` field with a `__aenc: 1` marker. That marker differs from
`__enc` so the sync layer never mistakes it for a scope-key payload.

The AEK is wrapped under the scope key (project PEK or personal DEK) into `wrapped_key`:
`{ "v": 2, "kid": …, "iv": …, "ct": … }`. The attachment id, key scope and key id are the
associated data, as for a field value, and `kid` names the wrapping key so a project with
several keys finds the right one. Older clients wrapped it with no associated data. That form is
still read and never written.

#### Blob format

The blob's address is `sha256(body)`, taken over exactly the bytes the client sends. It is both
the name and the integrity check. The server never parses the body. Two layouts exist, both
AES-256-GCM under the file's AEK:

```text
chunked (current)                        single-shot (older clients; still read)
0..8    magic "ATLSBLOB"                  0..12    96-bit IV, random per file
8       format version (2)                12..N-16 ciphertext of the whole file
9..13   chunk size, u32 big-endian        N-16..N  128-bit tag
13..21  random nonce prefix
then per chunk: ciphertext || 16-byte tag
```

Chunked blobs follow the STREAM construction (`crypto/blob.ts`): 64 KiB chunks, where chunk `i`
uses the nonce `prefix || u32(i)` and authenticates the header plus a flag marking the final
chunk. A client can encrypt, upload, download and decrypt without holding the whole file, and
truncated, reordered or appended chunks fail to decrypt.

The address is the hash of the ciphertext, which leaks nothing because plaintext is never on the
wire. It makes the address verifiable by the server and `PUT` idempotent: re-uploading the same
ciphertext, as an offline queue retry does, finds the existing object and stores no second copy.
Distinct blobs are never deduplicated. Deterministic encryption of identical files would be a
content side channel, so clients always encrypt with a fresh IV.

#### Transfers

Upload bodies stream to a temporary file in the blob's shard (or the S3 store's staging
directory), hashed and counted on the way. Past `MAX_BLOB_BYTES` the upload stops with 413. A
body whose hash does not match its address stops with 409. Both happen before the file is
committed to the address, and the temporary file is removed. Downloads stream from the store.

A transfer holds one small buffer, and at most `MAX_BLOB_TRANSFERS` run at once across all users.
One more answers 503 with `Retry-After`.

#### Who may upload and download

Upload authorization is loose on purpose. Any logged-in user may `PUT`, bounded by the
per-request size cap, a per-uploader quota and the per-user rate limit. A membership check would
let offline-first ordering block an upload, because the metadata op carrying `blob_sha` fans out
like any comment. Blobs nobody references are deleted after `BLOB_GC_GRACE_DAYS`, so abuse is
capped rather than prevented at the authorization layer.

Download is authorized by data, not grants. The caller's partition must contain a live
attachment op whose `blob_sha` (or `thumb_sha`) names the requested hash. "Live" uses the same
tombstone and field-HLC rules as the rest of sync, applied to the attachment, its task and its
project, so deleting the attachment or its task revokes access and frees the blob.

A reference only counts when it sits in the uploader's partition or in the partition of an active
member of the project the blob is bound to (`blobs.project_id`). Anyone can push an attachment op
naming any hash they have seen, so without that binding a forged op would grant a download and
keep the blob from being collected. Membership is read from `project_members`, not from
tombstones. Retention eventually purges the project tombstone a removed member holds, and access
must not come back when it does.

#### On the client

The upload queue (`packages/client-core/src/attachments.ts`) is durable and local to the device,
and never a syncable field:

- It encrypts when a file is queued and uploads the blob first, one at a time.
- After the first settled upload attempt it releases the metadata op to the ordinary sync outbox.
- Terminal answers (400, 404, 405, 409, 413, and 403 with a live task) mark the entry failed.
  Transient ones back off exponentially.
- An uploaded blob keeps its `stored` entry until the server acknowledged the metadata, and is
  uploaded again if the last upload is older than `BLOB_REFRESH_MS`, because the server collects
  unreferenced blobs after a grace period of at least a day.

A file is read in ranges and encrypted as it is read. On the web the ciphertext waits as a `Blob`
in IndexedDB, outside the JS heap, and `fetch` streams it as the request body. On Android and iOS
it waits in SQLite and goes up from one buffer, since React Native cannot stream a request body.
Downloads are decrypted chunk by chunk and the hash is checked again.

### Recovery

`POST /auth/recover` requires answering a challenge sealed to the recovery keypair, which only
the 24-word phrase can derive. The client then unwraps its keys with the recovery key, recovers
the root key (see [Account root key](#account-root-key)) and sets a new password. It deletes the account's passkeys; a passkey-only account comes out of recovery with a
password.

A signed-in user can replace the phrase from Settings. The client generates a new one, derives
its recovery key and keypair as signup does, and sends the recovery public key with the root,
the DEK and the private key wrapped under the new key to `POST /auth/recovery-key/replace`. That
checks the current password and swaps them in one `UPDATE`. Challenges are bound to the key they were
sealed to, so the old phrase stops working at once.

### Key storage on the client

On Android and iOS the unlocked key set lives in the OS keychain with the session. The browser
and desktop builds keep it as follows (`apps/mobile/src/auth/webKeyStore.ts`).

- Browser: the DEK, private key and signing key are stored only AES-GCM-wrapped under a
  non-extractable WebCrypto key kept in IndexedDB, and every tab of the origin shares that
  wrapping key. This keeps the plain keys out of `localStorage`, but it is not protection at
  rest. The browser stores the wrapping key's bytes in the same profile, so a copy of the profile
  holds both, and script on the origin can unwrap the keys. The synced data itself sits
  unencrypted in IndexedDB regardless.
- Desktop: the key set is sealed with the OS key store through the preload's
  `atlasDesktop.safeStorage` (macOS Keychain, Windows DPAPI, Secret Service or KWallet on Linux),
  so a copy of the profile alone does not open it. Script in the app can still ask the bridge to
  open the keys. Where the bridge answers null, for example Linux without a keyring, the browser
  wrap is used.
- Without WebCrypto (`crypto.subtle` exists only in secure contexts) or IndexedDB there is no
  wrapping key. `seal` answers null, the keys stay in memory, and the app asks for the password
  after a reload.

The sealed format has two versions: version 1 is AES-GCM under the browser wrapping key over the
`SessionKeys` JSON with the user id as associated data, and version 2 is the OS key store over
`{user, keys}`. A session stored before wrapping existed is wrapped on its first read. A key set
sealed by the browser wrap is sealed again with the OS key store when next saved, or right after
loading (`session.web.ts`).

## What stays plaintext

A field is encrypted unless its app manifest lists it in `plaintext_fields`
(`manifests/todo.json`; `manifests/journal.json` lists none). Those are the ids the server needs for routing and access checks
(`project_id`, `task_id`, `assignee_id`, `actor_id`), the attachment blob hashes, and the
already-encrypted attachment `wrapped_key` and `meta`. The client encrypts by this list, and the server only reads fields on it. See
[SECURITY.md](../SECURITY.md#fields-that-stay-plaintext-and-why) for the table.

## Server surfaces

| Routes                                                                                             | Purpose                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/auth/*`                                                                                          | signup, login, refresh, sessions, password change, recovery, account deletion |
| `/sync/*`                                                                                          | push, pull, snapshot, WebSocket and its tickets                               |
| `/projects/:id/*`, `/invites`                                                                      | membership, invites, roles                                                    |
| `/projects/:id/keys`, `/projects/:id/member-keys/:member_id`, `/project-keys`, `/users/public-key` | key distribution                                                              |
| `/project-keys/rotations`, `/projects/:id/key-rotation`                                            | project key rotation                                                          |
| `/attachments/blobs/:sha256`                                                                       | encrypted attachment blobs                                                    |
| `/reports`                                                                                         | anonymous bug and crash reports                                               |
| `/admin/*`                                                                                         | users, signup invites, reports, instance settings, audit log                  |
| `/health`                                                                                          | liveness                                                                      |
| `/discovery`                                                                                       | public: server version, sync protocol, capabilities, offered apps             |
| `/auth/apps`, `/auth/apps/:app`                                                                    | the account's apps: list, enable (interactive sessions only)                  |

Every route is mounted both at `/` and under `/api`. Other paths serve the web app.
