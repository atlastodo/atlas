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

`packages/sdk` (`@atlas/sdk`) is the same client as a TypeScript library: `AtlasClient.connect`,
then `tasks()`, `createTask()`, `completeTask()`, `changes()` and so on. The CLI is built on
`crates/atlas-client`, the same client in Rust (`AtlasClient::connect`), which reimplements the
app's encryption, sync and task rules; the fixtures in `test-vectors/` hold the two at parity.
Neither is published on its own yet. Use them from this repository, or run the CLI.

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
