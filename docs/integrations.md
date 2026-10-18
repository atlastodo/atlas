# Integrations: API tokens, the `atlas` CLI and n8n

Atlas Todo stores your tasks end-to-end encrypted, and the server cannot read them. So an
integration cannot just call a REST endpoint with a token: whatever reads or writes tasks has to
decrypt them itself. Atlas does this with three pieces:

- An **API token** carries a key as well as a credential. You create it in the app, which wraps a
  copy of your account keys under a secret the server never sees.
- The **`atlas` CLI** signs in with the token, downloads your account, decrypts it on the machine
  it runs on, and reads or changes tasks as JSON.
- **n8n** (or cron, a shell script, Home Assistant, …) runs the CLI.

The server stays zero-knowledge. It sees ciphertext from the CLI, exactly as it does from the app.

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

## The `atlas` CLI

The CLI is one static binary with nothing to install beside it: no Node.js, no system TLS library
and no time zone database (it carries its own). Each release attaches one per platform, named
`atlas-X.Y.Z-<target>`:

| Platform                                | Target                                          |
| --------------------------------------- | ----------------------------------------------- |
| Linux x86_64 (any distribution, Alpine) | `x86_64-unknown-linux-musl`                     |
| Linux arm64 (Raspberry Pi OS 64-bit, …) | `aarch64-unknown-linux-musl`                    |
| macOS, Apple silicon or Intel           | `aarch64-apple-darwin`, `x86_64-apple-darwin`   |
| Windows x86_64                          | `x86_64-pc-windows-msvc` (the file ends `.exe`) |

```sh
VERSION=X.Y.Z
TARGET=x86_64-unknown-linux-musl
BASE=https://github.com/atlastodo/atlas-todo/releases/download/v$VERSION
curl -fLO "$BASE/atlas-$VERSION-$TARGET"
curl -fLO "$BASE/SHA256SUMS.txt"
sha256sum --check --ignore-missing SHA256SUMS.txt
install -m 755 "atlas-$VERSION-$TARGET" /usr/local/bin/atlas
atlas --help
```

Each file also carries a build provenance attestation:
`gh attestation verify atlas-$VERSION-$TARGET --repo atlastodo/atlas-todo`. Earlier releases
shipped the CLI as a JavaScript file (`atlas-cli-X.Y.Z.mjs`, and `@atlastodo/cli` on npm); the
binary takes the same commands and environment and prints the same output.

It is configured through the environment. The token is never passed as a flag, because flags show
up in process listings and shell history.

| Variable          | What it is                                                 |
| ----------------- | ---------------------------------------------------------- |
| `ATLAS_URL`       | your server, e.g. `https://app.atlastodo.dev` (or `--url`) |
| `ATLAS_TOKEN`     | the API token                                              |
| `ATLAS_TZ`        | IANA time zone for dates, e.g. `Europe/Copenhagen`         |
| `ATLAS_STATE_DIR` | optional: a directory to keep the account in between runs  |

Every command prints JSON. Each command also takes its app first, as in `atlas todo tasks list`;
the shorter forms stay. A failure prints `{"error": …, "code": …}` on stderr and exits with
code 1, or 2 for a usage error.

```sh
atlas projects list
atlas labels list
atlas tasks list --project Work --due-before tomorrow
atlas tasks list --filter "today & p1"          # the app's filter syntax
atlas tasks get 0192…
atlas tasks add --title "Renew passport" --due 2026-11-02 --priority 2 --project Home --label errand
atlas tasks add --json '{"title": "From a form", "notes": "…", "due": "2026-11-02T09:00"}'
atlas tasks quick "Pay rent every month on the 1st #Home p1 @bills"   # the app's quick-add syntax
atlas tasks update 0192… --due none --notes "moved"
atlas tasks complete 0192…        # a recurring task returns its next occurrence as "next"
atlas tasks reopen 0192…
atlas tasks delete 0192…          # to the trash, as in the app
atlas changes                     # {"cursor": 1234}: the starting point
atlas changes --since 1234        # tasks created, updated, completed and deleted since then
```

How the arguments are read:

- **Dates** can be `YYYY-MM-DD` (the app's default due time on that day),
  `YYYY-MM-DDTHH:MM` (wall time in `ATLAS_TZ`), ISO 8601 with `Z` or an offset, unix
  milliseconds, `today`, `tomorrow`, or `none`.
- **Projects and labels** can be given by name (case-insensitive) or by id.

### Atlas Journal

On a server that offers Atlas Journal (`ATLAS_APPS=todo,journal`), the CLI also reads and writes
journal entries. Journal commands always start with `journal`, and they need a token that
includes Atlas Journal (see [App-scoped tokens](#app-scoped-tokens)):

```sh
atlas journal entries list [--from DAY] [--to DAY] [--tag T] [--search TEXT]
atlas journal entries get 0192…
atlas journal entries add --title "Harbour walk" --body "Fog over the water." --mood 4 --tag walks
atlas journal entries add --json '{"date": "2026-10-16", "body": "From a form", "tags": ["n8n"]}'
atlas journal entries update 0192… --date yesterday --mood none
atlas journal entries delete 0192…   # to the trash: deleted_at is set, list leaves it out
```

`DAY` is `YYYY-MM-DD`, `today`, `yesterday` or `tomorrow` (in `ATLAS_TZ`). `list` shows entries
outside the trash, newest date first; `--from` and `--to` are inclusive, `--tag` is
case-insensitive and `--search` matches the title or body. `add` and `update` take flags or a
`--json` object with the same keys (`date`, `title`, `body`, `mood`, `tags`); a flag wins over
`--json`. `--tag` may be repeated, and on `update` it replaces the list. `--mood none` (or
`"mood": null`) clears the mood, `"tags": []` the tags.

An entry (`journal.entry`) is printed, and stored, with these fields:

| Field        | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| `id`         | the entry's id (a UUID)                                        |
| `date`       | the day the entry is about, `YYYY-MM-DD`; today when not given |
| `title`      | text, may be empty                                             |
| `body`       | text, may be empty; an entry needs a title or a body           |
| `mood`       | 1 (awful) to 5 (great), or `null`                              |
| `tags`       | a list of strings, trimmed, without repeats (case-insensitive) |
| `created_at` | unix milliseconds                                              |
| `updated_at` | unix milliseconds of the last change                           |
| `deleted_at` | unix milliseconds once in the trash, else `null`               |

Every field is end-to-end encrypted: `manifests/journal.json` lists no plaintext field for
`journal.entry`, so the server sees only ids and ciphertext. A journal command on a token without
Atlas Journal fails with `{"error": "this API token is not for Atlas Journal …", "code":
"app_not_in_token"}`, as does a todo command on a journal-only token; a server that does not offer
journal fails with `server_incompatible`. With `ATLAS_STATE_DIR` each app keeps its own file
there.

Each run signs in, downloads and decrypts the account, then exits. That takes about a second for
a typical account, and longer for a very large one. With `ATLAS_STATE_DIR` set, a run keeps the
account there and the next one downloads only what changed. The file is encrypted under a key
derived from the token, so only the token opens it, but it holds your tasks: keep the directory
as private as the token. Token sign-ins share the per-IP `/auth/*`
rate limit (`AUTH_RATE_LIMIT_MAX`, 30 a minute by default), so space out bursts of CLI calls from
one machine, or raise the limit on your own server.

## n8n

n8n runs the CLI with its **Execute Command** node. Recent n8n versions disable that node by
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
  `atlas tasks quick "{{ $json.subject }}"`. Use `tasks add --json` to keep the body as notes.
  Mind the shell quoting: `--json '{{ JSON.stringify({title: $json.subject}) }}'` breaks on a
  single quote in the subject, so strip or escape quotes first.
- **Daily digest.** _Schedule Trigger_ (07:00) → _Execute Command_
  `atlas tasks list --filter "today | overdue"` → _Code_ (`JSON.parse($json.stdout)`) → _Send
  Email_ / _Telegram_.
- **React to changes.** _Schedule Trigger_ (every 5 minutes) → _Execute Command_
  `atlas changes --since {{ $getWorkflowStaticData('global').cursor ?? '' }}` → _Code_, which
  stores the returned `cursor` back in the static data and emits one item per entry of
  `completed` or `created` → whatever should happen next. The first run, without a cursor, only
  returns the starting cursor.

## Scripts in TypeScript or Rust

`packages/sdk` (`@atlastodo/sdk`) is the same client as a TypeScript library: `AtlasClient.connect`,
then `tasks()`, `createTask()`, `completeTask()`, `changes()` and so on. The CLI is built on
`crates/atlas-client`, the same client in Rust (`AtlasClient::connect`), which reimplements the
app's encryption, sync and task rules; the fixtures in `test-vectors/` hold the two at parity.

Every release attaches the SDK and the packages it builds on as npm tarballs
(`atlastodo-sdk-X.Y.Z.tgz`, `atlastodo-shared-X.Y.Z.tgz`, `atlastodo-client-core-X.Y.Z.tgz`: ESM
with type declarations, for Node and bundlers), and publishes them to npm as `@atlastodo/sdk`
and so on once publishing is on (`npm install @atlastodo/sdk`; an rc under the `next` tag). For a
version not on npm, install the release tarballs, with `overrides` for the two the SDK depends on:

```json
{
  "dependencies": {
    "@atlastodo/sdk": "https://github.com/atlastodo/atlas-todo/releases/download/vX.Y.Z/atlastodo-sdk-X.Y.Z.tgz"
  },
  "overrides": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas-todo/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz",
    "@atlastodo/shared": "https://github.com/atlastodo/atlas-todo/releases/download/vX.Y.Z/atlastodo-shared-X.Y.Z.tgz"
  }
}
```

`@atlastodo/sdk/testing` exports the in-memory `FakeServer` the SDK's own tests run against. The
Rust client is not published on its own; use it from this repository, or run the CLI.

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
for another app of the suite (Atlas Journal), made by a client of that app with
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
  is not for is 403 `app_not_enabled`, scope `token`. The CLI sends `todo` for its todo commands
  and `journal` for its journal commands, and checks the session's `apps` first, so a token
  without the app fails before any sync.
- In a journal session the journal app key does what the DEK does for todo: each field value is a
  personal-scope field envelope (`{"__enc": 2, "kid": "dek", …}`, associated data naming the kind
  `journal.entry`, the entity, the field and the scope `personal`) under the journal key. There
  are no shared projects, project keys or legacy values in a journal session.
