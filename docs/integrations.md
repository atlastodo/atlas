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
BASE=https://github.com/atlastodo/atlas/releases/download/v$VERSION
curl -fLO "$BASE/atlas-$VERSION-$TARGET"
curl -fLO "$BASE/SHA256SUMS.txt"
sha256sum --check --ignore-missing SHA256SUMS.txt
install -m 755 "atlas-$VERSION-$TARGET" /usr/local/bin/atlas
atlas --help
```

Each file also carries a build provenance attestation:
`gh attestation verify atlas-$VERSION-$TARGET --repo atlastodo/atlas` (the repository was
`atlastodo/atlas-todo` until its rename: releases signed before that verify with
`--repo atlastodo/atlas-todo`). Earlier releases
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

### Atlas Vault

On a server that offers Atlas Vault (`ATLAS_APPS=todo,vault`), the CLI reads and writes vault
items, for CI jobs and scripts that need a secret. Vault commands always start with `vault`, and
they need a token that includes Atlas Vault (see [Vault tokens for CI](#vault-tokens-for-ci)):

```sh
atlas vault list [--folder F] [--type T] [--tag T] [--search TEXT]   # no secret values
atlas vault get "Deploy key"                     # the item, secrets included
atlas vault get "Deploy key" --field token       # one value, as plain text
DEPLOY_TOKEN="$(atlas vault get 'Deploy key' --field token)"
atlas vault add --name "Deploy key" --type api_key --hidden token=… --folder CI --tag prod
atlas vault add --json - < item.json             # the object from stdin: no secret in argv
atlas vault update "Deploy key" --hidden token=… --remove-field old --favorite true
atlas vault delete "Deploy key"                  # to the trash
atlas vault folders list
atlas vault folders add CI
```

`ITEM` and `F` are names (case-insensitive, outside the trash) or ids; a name two items share is
refused with `ambiguous_vault_item`, so use the id. `list` and every write print items without
their field values, notes or history, so a CI log does not end up holding a secret; `get` prints
everything, and `get ITEM --field NAME` prints only that field's value (case-insensitive name)
followed by a newline. A flag on the command line is visible in the process list: pass secrets
with `--json -` on stdin. Field flags add or replace one field (`--username`, `--password` and
`--totp` name theirs; `--text` and `--hidden` take `NAME=VALUE`), and on `update` leave the item's
other fields alone; `--json` takes the keys below, and on `update` also `set_fields` (fields to
add or replace) and `remove_fields` (names) in place of a whole `fields` list. `--folder none`
clears the folder.

An item (`vault.item`) is printed, and stored, with these fields:

| Field        | Value                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `id`         | the item's id (a UUID)                                                                           |
| `type`       | `login` (the default), `note`, `card`, `identity`, `ssh_key` or `api_key` (any other secret)     |
| `name`       | text, required                                                                                   |
| `fields`     | `[{name, kind, value}]`, names unique (case-insensitive)                                         |
| `urls`       | a list of URLs, trimmed, without repeats                                                         |
| `notes`      | text                                                                                             |
| `tags`       | a list of strings, trimmed, without repeats (case-insensitive)                                   |
| `folder`     | a folder's id, or `null`; `folder_name` is printed next to it                                    |
| `favorite`   | `true` or `false`                                                                                |
| `history`    | earlier values of secret fields, `{field, value, changed_at}`, newest first, 5 per field at most |
| `created_at` | unix milliseconds                                                                                |
| `updated_at` | unix milliseconds of the last change                                                             |
| `deleted_at` | unix milliseconds once in the trash, else `null`                                                 |

A field's `kind` is `text` (the default), `hidden` (a secret), `totp` (a TOTP seed: an
`otpauth://` URI, or a base32 secret stored upper-case without spaces), `email`, `url` or `phone`.
Changing or removing a `hidden` or `totp` field keeps its old value in `history`. A folder
(`vault.folder`) has a `name` and the same timestamps. Every field of both is end-to-end
encrypted: `manifests/vault.json` lists no plaintext field, so the server sees only ids and
ciphertext, not even an item's type or name. The rules are shared with the TypeScript SDK
(`VaultClient` in `@atlastodo/sdk`, `packages/shared/src/vault.ts`) through
`test-vectors/vault_item_vectors.json`.

Each run signs in, downloads and decrypts the account, then exits. That takes about a second for
a typical account, and longer for a very large one. With `ATLAS_STATE_DIR` set, a run keeps the
account there and the next one downloads only what changed. The file is encrypted under a key
derived from the token, so only the token opens it, but it holds your tasks: keep the directory
as private as the token. Token sign-ins share the per-IP `/auth/*`
rate limit (`AUTH_RATE_LIMIT_MAX`, 30 a minute by default), so space out bursts of CLI calls from
one machine, or raise the limit on your own server.

## SecretSpec

[SecretSpec](https://secretspec.dev) (0.21 or newer) declares the secrets a project needs in
`secretspec.toml` and resolves them from a provider. `secretspec-provider-atlas` is a provider for
Atlas Vault, an external one in SecretSpec's terms (its Secret Provider Protocol): SecretSpec runs
it for every provider URI with the `atlas` scheme, and it signs in with a vault token, decrypts the
vault on the machine it runs on and answers SecretSpec over a private pipe. Every release attaches
it next to the CLI, as `secretspec-provider-atlas-X.Y.Z-<target>`. Put it somewhere only you can
write and register it once per user (or, with `--system`, per machine):

```sh
install -m 755 secretspec-provider-atlas-X.Y.Z-x86_64-unknown-linux-musl ~/.local/bin/secretspec-provider-atlas
secretspec-provider-atlas register    # writes ~/.config/secretspec/providers.d/atlas.secretspec.json
```

The registration names the binary and the environment SecretSpec passes it (`ATLAS_URL`,
`ATLAS_TOKEN`, `ATLAS_STATE_DIR`; SecretSpec gives an external provider nothing else of the
caller's environment). SecretSpec refuses a registration or binary that others can write, and it
does not look for providers on `PATH`. `register --print` prints the registration instead.

### Where secrets live

A provider URI is `atlas://` (the server in `ATLAS_URL`) or `atlas://HOST[:PORT][/PATH]` (HTTPS;
HTTP for `localhost`). It carries no token. SecretSpec's names map onto the vault like this:

| SecretSpec                            | Atlas Vault                                                |
| ------------------------------------- | ---------------------------------------------------------- |
| project (`[project] name`)            | a folder of that name                                      |
| profile (`development`, `production`) | an item of that name in the folder                         |
| secret (`DATABASE_URL`)               | a field of that name in the item (`hidden` when set by it) |
| `ref = { item, field }`               | the item of that name (or id) anywhere in the vault, field |
| `ref = { vault, item, field }`        | the item of that name in the folder `vault`, field         |

So the secrets of project `payments` are the folder **payments**, with an item per profile
(**production**, **staging**) holding one field per secret, and you can keep them in the app or
with the CLI:

```sh
atlas vault folders add payments
atlas vault add --json - <<'EOF'
{"name": "production", "type": "api_key", "folder": "payments",
 "fields": [{"name": "DATABASE_URL", "kind": "hidden", "value": "postgres://…"}]}
EOF
```

Names match case-insensitively and must be unique: two items of one name in a folder (or, for a
`ref` without `vault`, in the vault) fail with `conflict` rather than picking one. A missing
folder, item or field is a missing secret, which `secretspec check` reports as such. A `ref` needs
a `field`; `section` and `version` are refused. `secretspec set` (with a token that may write)
replaces the field's value, keeping the old one in the item's history as any change of a hidden
field does, or adds the field, creating the folder and the item (an `api_key` item tagged
`secretspec`) when they are missing.

### Tokens

Make a vault token as for any CI job (see [Vault tokens for CI](#vault-tokens-for-ci)): it
expires (within a year) and reads only unless made with writes. The provider takes it from
`ATLAS_TOKEN`, or, when that is not set, asks SecretSpec for its credential `token`, which
`secretspec config provider login` stores in the system keyring or an alias's `credentials`
table names. A read-only token resolves secrets and is refused `secretspec set` with
`permission_denied` before you are asked for the value; keep a token with writes for whoever
stores the secrets. `ATLAS_STATE_DIR` caches the vault between runs, as for the CLI.

SecretSpec shows an external provider's errors by kind only, so `secretspec-provider-atlas status
[URI]` signs in as SecretSpec would and says what is wrong in words (and, when nothing is, the
server, whether the token may write and when it expires):

| SecretSpec says        | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `interaction required` | no token, or it expired, was revoked or is not an Atlas API token: make one |
| `permission denied`    | a write with a read-only token, or a token that is not for Atlas Vault      |
| `conflict`             | two folders or items share the name the secret maps to                      |
| `invalid params`       | a bad URI (a token in it, no server) or a `ref` without `field`             |
| `unavailable`          | the server did not answer, or rate-limited the sign-in (retried)            |
| `operation failed`     | anything else, e.g. a server without Atlas Vault: run `status`              |

### Examples

```toml
# secretspec.toml
[project]
name = "payments"
revision = "1.0"

[providers]
atlas_vault = "atlas://app.atlastodo.dev"

[defaults]
providers = ["atlas_vault"]

[profiles.default]
DATABASE_URL = { description = "Postgres", required = true }
DEPLOY_TOKEN = { description = "Deploy key", required = true, ref = { item = "Deploy key", field = "token" } }

[profiles.production]
DATABASE_URL = { required = true }
```

```sh
secretspec check --profile production
secretspec run --profile production -- ./deploy.sh
```

In CI, give the job a read-only vault token as a secret variable, install and register the
provider, and run the same commands:

```yaml
# .github/workflows/deploy.yml (excerpt)
- run: |
    curl -fsSLo /usr/local/bin/secretspec-provider-atlas \
      https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/secretspec-provider-atlas-X.Y.Z-x86_64-unknown-linux-musl
    chmod 755 /usr/local/bin/secretspec-provider-atlas
    secretspec-provider-atlas register
    secretspec run --profile production -- ./deploy.sh
  env:
    ATLAS_TOKEN: ${{ secrets.ATLAS_VAULT_TOKEN }}
```

With [devenv](https://devenv.sh), whose SecretSpec integration loads the declared secrets into the
shell, select the provider and profile in `devenv.yaml` (devenv 2.4 embeds SecretSpec 0.21, the
first to run external providers; register the provider as above):

```yaml
# devenv.yaml
secretspec:
  enable: true
  provider: atlas://app.atlastodo.dev
  profile: development
```

```nix
# devenv.nix
{ config, ... }:
{
  env.DATABASE_URL = config.secretspec.secrets.DATABASE_URL or "";
}
```

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
    "@atlastodo/sdk": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-sdk-X.Y.Z.tgz"
  },
  "overrides": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz",
    "@atlastodo/shared": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-shared-X.Y.Z.tgz"
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
  is not for is 403 `app_not_enabled`, scope `token`. The CLI sends `todo` for its todo commands
  and `journal` for its journal commands, and checks the session's `apps` first, so a token
  without the app fails before any sync.
- In a journal session the journal app key does what the DEK does for todo: each field value is a
  personal-scope field envelope (`{"__enc": 2, "kid": "dek", …}`, associated data naming the kind
  `journal.entry`, the entity, the field and the scope `personal`) under the journal key. There
  are no shared projects, project keys or legacy values in a journal session. A vault session
  works the same way with the vault key (`vault.item`, `vault.folder`).

### Vault tokens for CI

A token that includes Atlas Vault is held to the vault's token policy (`api_tokens` in
`manifests/vault.json`), which the server enforces on servers with the `api_token_policies`
capability:

- **It expires.** `POST /auth/api-tokens` needs `expires_at` (unix ms), in the future and at most
  365 days after the token is made; otherwise 400 `api_token_expiry_required`,
  `api_token_expiry_in_past` or `api_token_expiry_too_far`. Past it, the exchange and every request
  of a session it opened answer 401 `api_token_expired` (the CLI prints that code and exits 1), and
  the access token a session gets ends no later than the token.
- **It reads only, unless made with `"write": true`.** A read-only token's sessions reach the read
  routes (`GET`, and the sync socket's ticket); a push or any other write is 403
  `api_token_read_only`. The CLI and SDK check the session's `write` first and refuse the write
  without sending anything.
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
