# Integrations: API tokens, the apps' CLIs and n8n

Atlas Todo stores your tasks end-to-end encrypted, and the server cannot read them. So an
integration cannot just call a REST endpoint with a token: whatever reads or writes tasks has to
decrypt them itself. Atlas does this with three pieces:

- An **API token** carries a key as well as a credential. You create it in the app, which wraps a
  copy of your account keys under a secret the server never sees.
- **The apps' CLIs** (`atlas-todo`, `atlas-journal`, `atlas-vault`) sign in with the token,
  download your account, decrypt it on the machine they run on, and read or change it as JSON.
- **n8n** (or cron, a shell script, Home Assistant, …) runs the CLIs.

The server stays zero-knowledge. It sees ciphertext from a CLI, exactly as it does from the app.

## Create a token

1. In the app, open **Settings → API tokens** and choose **Create token**.
2. Name it after where it will be used, such as "n8n at home".
3. Copy the token (`atlas_pat_…`). It is shown only once.

**A token can read and change every task in your account,** shared projects included. Keep it as
safe as your password: in n8n's credentials or an environment variable, never in a workflow's
visible parameters or in git.

A token cannot change your password, recovery phrase or sessions, delete or export your account,
create or revoke tokens, or use the admin pages. Those routes need a signed-in device.

Revoke a token in the same settings section. Anything using it stops on its next request, and the
server deletes its copy of your wrapped keys. Recovering your account with the recovery phrase,
or scheduling its deletion, revokes every token. Changing your password does not.

## The apps' CLIs

Each app of the suite ships its own command line, released from the app's repository and built on
core's Rust client (`crates/atlas-client`). Core keeps no app's rules, so it has no CLI of its own:

| App           | CLI                                                                    | Repository                                                            | Commands                                            |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Atlas Todo    | `atlas-todo`                                                           | [atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo)       | `tasks`, `projects`, `labels`, `changes`            |
| Atlas Journal | `atlas-journal`                                                        | [atlastodo/atlas-journal](https://github.com/atlastodo/atlas-journal) | `entries`                                           |
| Atlas Vault   | `atlas-vault`, and the SecretSpec provider `secretspec-provider-atlas` | [atlastodo/atlas-vault](https://github.com/atlastodo/atlas-vault)     | `list`, `get`, `add`, `update`, `delete`, `folders` |

Each is one static binary with nothing to install beside it: no Node.js, no system TLS library and
no time zone database (it carries its own). Each release of the app attaches one per platform,
named `<cli>-X.Y.Z-<target>`, with `SHA256SUMS.txt` and a build provenance attestation:

| Platform                                | Target                                          |
| --------------------------------------- | ----------------------------------------------- |
| Linux x86_64 (any distribution, Alpine) | `x86_64-unknown-linux-musl`                     |
| Linux arm64 (Raspberry Pi OS 64-bit, …) | `aarch64-unknown-linux-musl`                    |
| macOS, Apple silicon or Intel           | `aarch64-apple-darwin`, `x86_64-apple-darwin`   |
| Windows x86_64                          | `x86_64-pc-windows-msvc` (the file ends `.exe`) |

They share one configuration, through the environment. The token is never passed as a flag,
because flags show up in process listings and shell history.

| Variable          | What it is                                                 |
| ----------------- | ---------------------------------------------------------- |
| `ATLAS_URL`       | your server, e.g. `https://app.atlastodo.dev` (or `--url`) |
| `ATLAS_TOKEN`     | the API token                                              |
| `ATLAS_TZ`        | IANA time zone for dates, e.g. `Europe/Copenhagen`         |
| `ATLAS_STATE_DIR` | optional: a directory to keep the account in between runs  |

Every command prints JSON. A failure prints `{"error": …, "code": …}` on stderr and exits with
code 1, or 2 for a usage error. A command needs a token that includes its app (see
[App-scoped tokens](#app-scoped-tokens)) and a server that offers it (`ATLAS_APPS`): otherwise it
fails with `app_not_in_token` or `server_incompatible`. Each app's README documents its commands
and its fields.

Each run signs in, downloads and decrypts the app's data, then exits. That takes about a second
for a typical account, and longer for a very large one. With `ATLAS_STATE_DIR` set, a run keeps
the account there and the next one downloads only what changed. The file is encrypted under a key
derived from the token, so only the token opens it, but it holds your data: keep the directory as
private as the token. Each app keeps its own file there. Token sign-ins share the per-IP `/auth/*`
rate limit (`AUTH_RATE_LIMIT_MAX`, 30 a minute by default), so space out bursts of CLI calls from
one machine, or raise the limit on your own server.

Core releases up to 0.1.15 shipped an `atlas` CLI (`atlas-X.Y.Z-<target>`) with the journal and
vault commands, and the SecretSpec provider next to it; earlier ones had todo's too, and before
that a JavaScript CLI (`atlas-cli-X.Y.Z.mjs`, `@atlastodo/cli` on npm). They moved with the apps'
rules: `atlas journal entries …` is now `atlas-journal entries …`, `atlas vault …` is
`atlas-vault …` (the old forms, with the app first, still work, e.g. `atlas-vault vault list`),
with the same environment and output, and `secretspec-provider-atlas` is released from
atlastodo/atlas-vault.

## n8n

n8n runs the CLIs with its **Execute Command** node. The recipes below use `atlas-todo`, the todo
app's CLI (see above), installed the same way. Recent n8n versions disable that node by
default, so enable it first by removing it from `NODES_EXCLUDE`, e.g. `NODES_EXCLUDE="[]"`. Only
do that on an instance whose workflows you control, because the node runs shell commands.

The n8n image is Alpine-based, and the Linux musl binary runs there as is (an arm64 host takes the
`aarch64` file). Put it and its settings into the n8n container:

```yaml
# docker-compose.yml (excerpt)
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n
    environment:
      NODES_EXCLUDE: "[]"
      ATLAS_URL: https://todo.example.com
      ATLAS_TOKEN: ${ATLAS_TOKEN} # from an .env file next to the compose file, not committed
      ATLAS_TZ: Europe/Copenhagen
      ATLAS_STATE_DIR: /home/node/.n8n/atlas # optional: faster runs
    volumes:
      - ./atlas-X.Y.Z-x86_64-unknown-linux-musl:/usr/local/bin/atlas:ro
```

### Recipes

- **Create a task from an email.** _Email Trigger (IMAP)_ → _Execute Command_ with
  `atlas-todo tasks quick "{{ $json.subject }}"`. Use `tasks add --json` to keep the body as notes.
  Mind the shell quoting: `--json '{{ JSON.stringify({title: $json.subject}) }}'` breaks on a
  single quote in the subject, so strip or escape quotes first.
- **Daily digest.** _Schedule Trigger_ (07:00) → _Execute Command_
  `atlas-todo tasks list --filter "today | overdue"` → _Code_ (`JSON.parse($json.stdout)`) → _Send
  Email_ / _Telegram_.
- **React to changes.** _Schedule Trigger_ (every 5 minutes) → _Execute Command_
  `atlas-todo changes --since {{ $getWorkflowStaticData('global').cursor ?? '' }}` → _Code_, which
  stores the returned `cursor` back in the static data and emits one item per entry of
  `completed` or `created` → whatever should happen next. The first run, without a cursor, only
  returns the starting cursor.

## Scripts in TypeScript or Rust

`packages/sdk` (`@atlastodo/sdk`) is the TypeScript side: `TokenSession.connect` opens an API-token
session, syncs the account into memory and loads the shared projects' keys; an app's own client
sits on top of it after registering the app's definition (`registerApp` in
`@atlastodo/client-core`). The apps' clients live with their rules: todo's `AtlasClient`
(`tasks()`, `createTask()`, `completeTask()`, `changes()`, …) in `@atlastodo/todo-core`
(atlastodo/atlas-todo), the vault's `VaultClient` in `@atlastodo/vault-core/client`
(atlastodo/atlas-vault; until core 0.1.15 it was the SDK's). The apps' CLIs are built on
`crates/atlas-client`, the same engine in Rust (`AtlasClient::connect`, `atlas_client::apps`);
the fixtures in `test-vectors/` hold the two at parity.

Every release attaches the SDK and the package it builds on as npm tarballs
(`atlastodo-sdk-X.Y.Z.tgz`, `atlastodo-client-core-X.Y.Z.tgz`: ESM with type declarations, for
Node and bundlers), and publishes them to npm as `@atlastodo/sdk` and `@atlastodo/client-core`
once publishing is on (`npm install @atlastodo/sdk`; an rc under the `next` tag). For a version
not on npm, install the release tarballs, with an `override` for the one the SDK depends on.
(`@atlastodo/shared`, the vault's item rules, was published up to 0.1.15; they are
`@atlastodo/vault-core`'s now.)

```json
{
  "dependencies": {
    "@atlastodo/sdk": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-sdk-X.Y.Z.tgz"
  },
  "overrides": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz"
  }
}
```

`@atlastodo/sdk/testing` exports the in-memory `FakeServer` the SDK's own tests run against (and the
apps' tests too). The Rust client is not published on crates.io: depend on it by git tag
(`atlas-client = { git = "https://github.com/atlastodo/atlas", tag = "vX.Y.Z" }`), as the apps'
CLIs do; `atlas_client::testing::FakeServer` is its in-memory server.

## How it works

The token is `atlas_pat_` + base64url(16-byte token id ‖ 32-byte secret). HKDF over the secret,
salted with the id, gives two values:

- `atlas-pat-auth-v1`: the auth value the server checks. The server stores only its SHA-256.
- `atlas-pat-wrap-v1`: the key under which the app wraps the DEK and the X25519 private key. The
  associated data binds the account, the token id and which key it is.

`POST /auth/api-token/session` takes the id and auth value, and returns a 15-minute access token
together with those wraps. There is no refresh token: the client exchanges again when the access
token expires. The access token's `kind` claim marks it as an API-token session, and its device
id is the token's id. With the DEK the client opens the account's signing key and the shared
projects' keys, just as a signed-in device does. See
[architecture.md](./architecture.md#api-tokens) for the server side.

### App-scoped tokens

A token is scoped to apps. The tokens Atlas Todo's settings make are todo tokens, and their
sessions sync todo only. A server with the `app_scoped_api_tokens` capability also accepts tokens
for another app of the suite (Atlas Journal, Atlas Vault), made by a client of that app with
`POST /auth/api-tokens` and `"apps": ["journal"]` (or `["todo", "journal"]`) once the account has
enabled it:

- The session response lists the token's `apps`. It carries the todo wraps (`wrapped_dek`,
  `wrapped_private_key`) exactly when the token is for todo, and every other app's key and X25519
  identity in `app_keys`: `{"journal": {"wrapped_key": …, "wrapped_private_key": …}}`, wrapped
  under the same `atlas-pat-wrap-v1` key with the slots `app_key:<app>` and
  `app_private_key:<app>` in the associated data (`["atlas-pat-wrap", 1, user_id, token_id,
slot]`; `test-vectors/api_token_vectors.json` has a journal entry).
- A client syncs one app per session and names it in the `x-atlas-sync-apps` header of every
  `/sync/*` request ([sync-protocol.md](./sync-protocol.md#app-scope)); naming an app the token
  is not for is 403 `app_not_enabled`, scope `token`. Each app's CLI sends its app, and checks the
  session's `apps` first, so a token without the app fails before any sync.
- In a journal session the journal app key does what the DEK does for todo: each field value is a
  personal-scope sealed envelope (`{"__enc": 3, "kid": "dek", …}`) under the journal key, on a
  `journal.sealed` op whose field is an opaque tag; the kind (`journal.entry`) and the field name
  travel inside it ([sync-protocol.md](./sync-protocol.md#operations)). There are no shared
  projects or project keys in a journal session. A vault session works the same way with the vault
  key (`vault.sealed`; `vault.item`, `vault.folder` inside). A session re-encodes the rows its
  partition still holds from before sync protocol 7 and drops the originals, once per run.

### Vault tokens for CI

A token that includes Atlas Vault is held to the vault's token policy (`api_tokens` in
`manifests/vault.json`), which the server enforces on servers with the `api_token_policies`
capability:

- **It expires.** `POST /auth/api-tokens` needs `expires_at` (unix ms), in the future and at most
  365 days after the token is made; otherwise 400 `api_token_expiry_required`,
  `api_token_expiry_in_past` or `api_token_expiry_too_far`. Past it, the exchange and every request
  of a session it opened answer 401 `api_token_expired` (`atlas-vault` prints that code and exits 1), and
  the access token a session gets ends no later than the token.
- **It reads only, unless made with `"write": true`.** A read-only token's sessions reach the read
  routes (`GET`, and the sync socket's ticket); a push or any other write is 403
  `api_token_read_only`. The vault's CLI and `VaultClient` check the session's `write` first and
  refuse the write without sending anything.
- **It is revoked like any token** (`DELETE /auth/api-tokens/:id`, or account recovery): its
  wrapped keys are dropped and its sessions end on their next request. An expired token stays in
  the list (with `expires_at`) until it is revoked, but no longer counts against the 25; within the
  hour the server drops its wrapped keys.
- **It is for the vault alone.** A token naming the vault and another app is 400
  `api_token_app_exclusive`. Todo and journal tokens may also be given an expiry or
  `"write": false`.
- A password change does not revoke API tokens: they are separate credentials. Revoke them one by
  one; recovering the account revokes them all.

Make one read-only token per pipeline, scoped to `["vault"]`, and rotate it before it expires; a
job that stores secrets gets its own token with writes. A vault token reaches every item of the
vault: limiting one to some folders or items needs per-collection keys, which are not built yet.
