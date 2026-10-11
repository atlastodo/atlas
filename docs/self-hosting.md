# Self-hosting Atlas Todo

This guide covers installing, configuring, backing up and upgrading an Atlas Todo server. For a
quick start, see the [README](../README.md#self-hosting).

## What you run

- PostgreSQL 16 holds the accounts, the sync op log and the encrypted data.
- One server container (`atlas-server`) serves the API, the WebSocket for live sync, and the
  web app. It listens on port 8080 and runs as the non-root user `atlas` (uid and gid 10001).
- Two volumes hold the database and `/app/data`, which holds the encrypted attachment blobs.

The server applies database migrations every time it starts. The API answers at both `/` and
`/api`; the web app uses `/api`.

## Install

You need Docker with Compose v2.24 or later. (On NixOS, use the [module](#nixos) instead.)

```sh
git clone https://github.com/atlastodo/atlas-todo.git
cd atlas-todo
cp .env.example .env
```

Edit `.env` and set the two required values:

```sh
POSTGRES_PASSWORD=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -hex 32>
```

Then start it:

```sh
docker compose up -d            # pulls ghcr.io/atlastodo/atlas-todo:latest
docker compose up -d --build    # or: builds the image from this checkout
docker compose logs -f server   # follow the logs
```

Run all `docker compose` commands from the repository root. The root `compose.yaml` includes
`docker/docker-compose.yml`. Compose reads the root `.env`, and the server container receives
every variable in it. A `docker/.env` is read too, if it exists, for tools that run
`docker compose -f docker/docker-compose.yml` and write their env file there.

In production, pin a version: `ATLAS_IMAGE=ghcr.io/atlastodo/atlas-todo:X.Y.Z`. The same image is
on Docker Hub as `atlastodo/atlas-todo`. It is built for linux/amd64 and linux/arm64 (a 64-bit OS
on a Raspberry Pi works; 32-bit ARM does not).

To try unreleased changes, `ATLAS_IMAGE=ghcr.io/atlastodo/atlas-todo:dev` follows the `dev` branch:
it is rebuilt after every change there that passes CI. Use it with a database you can lose or
restore. A `dev` image may apply database migrations that no release has yet, and a release image
refuses to start against a database with a migration it does not know, so going back means waiting
for the next release that includes it, or restoring a backup taken before switching.

## NixOS

The repository flake builds the server from source and ships a NixOS module, so a NixOS machine
runs the server, and optionally the database, as native services instead of the container:

```nix
# flake input
atlas-todo.url = "git+https://github.com/atlastodo/atlas-todo.git";
# No `inputs.nixpkgs.follows`: the packages build with the flake's own pinned nixpkgs, the Bun
# and Node versions CI tests (a stable channel can carry an older Bun).

# configuration
imports = [ inputs.atlas-todo.nixosModules.atlas-todo ];

services.atlas-todo = {
  enable = true;
  # Attachment blobs live under <dataDir>/blobs. Back this up together with the database.
  dataDir = "/var/lib/atlas-todo";
  # A file containing JWT_SECRET, read by systemd (an agenix/sops secret, never the store).
  jwtSecretFile = "/run/agenix/atlas-todo-jwt";
  # Accounts promoted to admin at every start (the ADMIN_EMAILS restart path).
  adminEmails = [ "you@example.com" ];
  settings = {
    # Behind a TLS reverse proxy (see below):
    AUTH_RATE_LIMIT_TRUST_FORWARDED = true;
    # TRUSTED_PROXY_HOPS = 2;   # if two proxies append to X-Forwarded-For
  };
};
```

- Database: by default the module creates the `atlas-todo` database and user on the host's
  `services.postgresql`, which is additive: an existing cluster keeps its version and settings.
  It connects over the unix socket, with no password. Migrations run when the service starts. For
  an external Postgres, set `database.createLocally = false` and put `DATABASE_URL=…` in a file
  listed in `environmentFile` (an agenix/sops secret). `database.url` works too, but its value,
  password included, lands in the world-readable nix store.
- JWT secret: with `jwtSecretFile` unset, a secret is generated under `<dataDir>/jwt_secret`
  on first start and kept. Carry it over when migrating, or every session is invalidated.
- Every other setting passes through `settings` with the env names from the table below; the
  module adds no defaults of its own. Secrets never go there, because env values land in the nix
  store, and `JWT_SECRET` in `settings` is rejected explicitly.
- The web app: `staticDir` points the server at a web export and it serves SPA and API on
  one port, like the container. The repository flake builds the export from source as
  `packages.<system>.web-dist`, from the same revision as the server, so a flake update ships
  both together (`staticDir = inputs.atlas-todo.packages.${pkgs.system}.web-dist;`). No API URL
  is baked into it, so each browser types the API URL once on the sign-in screen.
- The service runs as the system user `atlas-todo` with a hardened unit (`ProtectSystem=strict`,
  only `dataDir` writable). The port is 8080 by default (`port`); `openFirewall` opens it when
  nothing proxies in front.
- Maintenance commands need only `DATABASE_URL`. With the default local database:

  ```console
  $ server=$(systemctl show -P ExecStart atlas-todo); server=${server%% *}
  $ sudo -u atlas-todo env \
      DATABASE_URL='postgres:///atlas-todo?host=/run/postgresql&user=atlas-todo' \
      "$server" promote you@example.com
  ```

  The `adminEmails` list plus a restart does the same for promotion.

### Moving from the container

- Carry `JWT_SECRET` over: the same secret keeps every session valid. Put the old value into
  the `jwtSecretFile` before switching.
- Stop the old stack before the new server starts on the migrated data.
- Migrate the database: `pg_dump -U atlas -Fc atlas` out of the old database, then restore with
  the service stopped (`systemctl stop atlas-todo`):

  ```console
  $ sudo -u postgres pg_restore -d atlas-todo --clean --if-exists --no-owner \
      --role=atlas-todo atlas.dump
  ```

  (`--clean --if-exists` covers the objects the just-started server already created; the pair
  `--no-owner --role=atlas-todo` makes the restored tables owned by the module's user.)

- Copy the old blob volume (the container's `/app/data`) into `<dataDir>` and
  `chown -R atlas-todo:atlas-todo <dataDir>`.
- Start the service, move the reverse proxy onto it, then remove the old deployment.

## Configuration

Settings come from environment variables, normally set in `.env`. The server checks them at
startup:

- A number that doesn't parse, or a flag that isn't one of `1/0`, `true/false`, `yes/no`,
  `on/off` (any case), stops the server with an error that names the variable.
- An empty value counts as unset.
- `JWT_SECRET` must be at least 32 bytes and not a known placeholder.
- Avoid `$` in `.env` values: compose treats it as a variable reference.

### Compose settings

These are read by compose, not by the server.

| Variable            | Default                               | Notes                                                                                                                         |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | none, required                        | Database password. It goes into a URL, so use URL-safe characters. PostgreSQL only reads it when the volume is first created. |
| `POSTGRES_USER`     | `atlas`                               | Database user.                                                                                                                |
| `POSTGRES_DB`       | `atlas`                               | Database name.                                                                                                                |
| `PORT_BIND`         | `8080`                                | Host port. Inside the container the server always listens on 8080.                                                            |
| `ATLAS_IMAGE`       | `ghcr.io/atlastodo/atlas-todo:latest` | Image to pull, or the name to tag a local build with.                                                                         |
| `ATLAS_DB_VOLUME`   | `docker_atlas_db`                     | Name of the database volume. The default keeps the name older installs already have.                                          |

Compose builds `DATABASE_URL` from the `POSTGRES_*` values and pins `PORT=8080`. A
`DATABASE_URL` in `.env` or in your shell is ignored.

### Server settings

| Variable                                                        | Default                                                 | Notes                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                  | none, required                                          | Set by compose. Needed when you run the binary yourself.                                                                                                                                                                                        |
| `JWT_SECRET`                                                    | none, required                                          | Signs access tokens and account-recovery challenges. At least 32 bytes, not a placeholder.                                                                                                                                                      |
| `PORT`                                                          | `8080`                                                  | Listening port.                                                                                                                                                                                                                                 |
| `RUST_LOG`                                                      | `info` in the image, `atlas_server=info,warn` otherwise | Log filter, in `tracing` EnvFilter syntax.                                                                                                                                                                                                      |
| `STATIC_DIR`                                                    | `/app/dist` if that directory exists                    | The web app to serve. The image sets it. Without it the server is API only.                                                                                                                                                                     |
| `CORS_ALLOWED_ORIGINS`                                          | any origin                                              | Comma-separated exact origins. Auth uses a bearer header, not cookies, so any origin is safe. If you set a list, include `app://atlas-todo` for the desktop app.                                                                                |
| `ACCESS_TOKEN_TTL_SECONDS`                                      | `900`                                                   | Access token lifetime (15 minutes).                                                                                                                                                                                                             |
| `REFRESH_TOKEN_TTL_SECONDS`                                     | `2592000`                                               | Refresh token lifetime (30 days).                                                                                                                                                                                                               |
| `SIGNUP_ENABLED`                                                | `true`                                                  | `false` refuses new accounts. Existing accounts can still sign in, and a signup invite still admits one person. Once the admin panel's toggle has been used, it overrides this value.                                                           |
| `ADMIN_EMAILS`                                                  | none                                                    | Comma-separated. At every startup, the listed accounts that exist are promoted to admin. It never demotes and never applies at signup.                                                                                                          |
| `BUG_REPORTS_ENABLED`                                           | `true`                                                  | `false` removes the anonymous `POST /reports` endpoint.                                                                                                                                                                                         |
| `AUTH_RATE_LIMIT_TRUST_FORWARDED`                               | `false`                                                 | Use `X-Forwarded-For` for the per-IP limits. Turn it on behind a reverse proxy, and only if the proxy is the only way in.                                                                                                                       |
| `TRUSTED_PROXY_HOPS`                                            | `1`                                                     | How many proxies append to `X-Forwarded-For`. At least 1.                                                                                                                                                                                       |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECS`           | `30` / `60`                                             | Requests per client IP to the `/auth/*` endpoints.                                                                                                                                                                                              |
| `AUTH_ACCOUNT_FAILURE_MAX` / `AUTH_ACCOUNT_FAILURE_WINDOW_SECS` | `10` / `900`                                            | Failed password checks per account, across login, recovery and cancelling a deletion.                                                                                                                                                           |
| `SYNC_RATE_LIMIT_MAX` / `SYNC_RATE_LIMIT_WINDOW_SECS`           | `60` / `60`                                             | Sync pushes per user.                                                                                                                                                                                                                           |
| `SYNC_READ_RATE_LIMIT_MAX` / `SYNC_READ_RATE_LIMIT_WINDOW_SECS` | `600` / `60`                                            | Sync reads (pull, snapshot, WebSocket tickets) per user.                                                                                                                                                                                        |
| `REPORT_RATE_LIMIT_MAX` / `REPORT_RATE_LIMIT_WINDOW_SECS`       | `10` / `300`                                            | Bug reports per client IP.                                                                                                                                                                                                                      |
| `UPLOAD_RATE_LIMIT_MAX` / `UPLOAD_RATE_LIMIT_WINDOW_SECS`       | `60` / `60`                                             | Attachment uploads per user.                                                                                                                                                                                                                    |
| `DOWNLOAD_RATE_LIMIT_MAX` / `DOWNLOAD_RATE_LIMIT_WINDOW_SECS`   | `600` / `60`                                            | Attachment downloads per user (a separate budget from uploads).                                                                                                                                                                                 |
| `MAX_PUSH_BYTES`                                                | `2097152`                                               | Largest sync push body (2 MiB). A larger one gets 413.                                                                                                                                                                                          |
| `OP_RETENTION_DAYS`                                             | `30`                                                    | Days of sync history to keep. `0` keeps everything.                                                                                                                                                                                             |
| `REFRESH_TOKEN_RETENTION_DAYS`                                  | `30`                                                    | Days to keep expired or revoked refresh tokens, for reuse detection. `0` or less keeps them.                                                                                                                                                    |
| `ATTACHMENTS_ENABLED`                                           | `true`                                                  | `false` turns attachments off: `/attachments/*` answers 404 and the apps hide the feature.                                                                                                                                                      |
| `BLOB_BACKEND`                                                  | `fs`                                                    | `fs` stores blobs under `BLOB_DIR`; `s3` stores them in a bucket. See [S3 storage](#s3-storage).                                                                                                                                                |
| `BLOB_DIR`                                                      | `/app/data/blobs`                                       | Where blobs are stored. In Docker, keep it under `/app/data`, the volume; anything else is lost when the container is recreated. With `s3`, only uploads in progress.                                                                           |
| `S3_BUCKET` / `S3_PREFIX`                                       | unset / empty                                           | With `BLOB_BACKEND=s3`: the bucket (required) and a key prefix.                                                                                                                                                                                 |
| `MAX_BLOB_BYTES`                                                | `26214400`                                              | Largest attachment (25 MiB).                                                                                                                                                                                                                    |
| `BLOB_QUOTA_BYTES`                                              | `1073741824`                                            | Total attachment storage per user (1 GiB).                                                                                                                                                                                                      |
| `MAX_BLOB_TRANSFERS`                                            | `16`                                                    | Attachment uploads and downloads in progress at once, across all users. One more gets 503 and the app tries again shortly. Bodies stream to and from disk, so this bounds open files and disk load rather than memory.                          |
| `BLOB_GC_GRACE_DAYS`                                            | `30`                                                    | Days an unreferenced blob is kept before it is deleted, counted from its last upload and from when it lost its last reference. Never less than `OP_RETENTION_DAYS`, so a deleted attachment can still be restored. `0` disables the collection. |

### S3 storage

With `BLOB_BACKEND=s3` the server keeps attachment blobs in an S3 bucket, or in any service with
the S3 API (MinIO, Garage, Cloudflare R2, Backblaze B2, …). Set `S3_BUCKET` and, optionally,
`S3_PREFIX`. Credentials, region and endpoint come from the standard AWS variables:
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (or an instance role), `AWS_REGION`, and
`AWS_ENDPOINT` for a service other than AWS. Set `AWS_ALLOW_HTTP=true` only for an endpoint on a
private network that has no TLS.

```sh
BLOB_BACKEND=s3
S3_BUCKET=atlas-todo
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_REGION=eu-central-1
# AWS_ENDPOINT=https://s3.example.com
```

The server stages each upload under `BLOB_DIR` while it checks the size and hash, then writes it
to `<S3_PREFIX>/<first two hex digits>/<sha256>` in the bucket. Give the credentials
`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on that bucket. The blob
garbage collector deletes objects without a database row once they are an hour old, so keep
other data out of the prefix. The bucket only ever holds ciphertext, but keep it private anyway.

Switching backends does not move existing blobs. Copy them across first: the bucket layout
under the prefix is the same as the directory layout under `BLOB_DIR`, so for example
`rclone copy /app/data/blobs remote:atlas-todo/<S3_PREFIX>` works. Skip the `.tmp-*` files.

### Image build arguments

Only for `docker compose up -d --build` or `docker build`:

| Argument         | Default                                   | Notes                                                                                                                                             |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_API_URL` | `/api`                                    | API URL baked into the web app. `/api` means the same origin.                                                                                     |
| `REPO_URL`       | `https://github.com/atlastodo/atlas-todo` | The source link on the web app's About screen. If you run modified code, point it at that code: the AGPL asks you to offer your users its source. |
| `BUN_VERSION`    | `1.4.2`                                   | Bun used to build the web app.                                                                                                                    |

## Reverse proxy

Run the server behind a TLS reverse proxy and keep PostgreSQL private. Compose only publishes the
server's port, not the database's.

When you add a proxy, set these in `.env` and restart:

```sh
AUTH_RATE_LIMIT_TRUST_FORWARDED=true
# TRUSTED_PROXY_HOPS=2   # only if two proxies append to X-Forwarded-For
```

Without this, every client shares the proxy's IP address, and one client's failed logins can
lock everyone out for a minute. Don't turn it on if clients can also reach port 8080 directly:
they could then forge the header.

It also helps to bind the port to localhost so only the proxy can reach it:
`PORT_BIND=127.0.0.1:8080`.

### Caddy

Caddy handles TLS, WebSockets and large bodies without extra settings:

```caddyfile
todo.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### nginx

nginx needs a larger body limit for attachments (its default is 1 MiB) and the WebSocket
upgrade headers for `/sync/ws`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name todo.example.com;

    ssl_certificate     /etc/letsencrypt/live/todo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/todo.example.com/privkey.pem;

    # Above MAX_BLOB_BYTES (25 MiB by default).
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

The server pings WebSocket clients every 30 seconds, so nginx's default read timeout is enough.

## Accounts and admins

- Signing up never makes an account an admin. Promote the first admin from the command line:

  ```sh
  docker compose exec server atlas-server promote you@example.com
  docker compose exec server atlas-server demote someone@example.com
  ```

  `ADMIN_EMAILS` does the same at every startup for accounts that already exist.

- The admin panel is the Admin section of Settings (shown only to admins). It lists accounts; an admin can promote,
  disable, delete or sign out a user. It also shows bug reports and the audit log, and holds the instance settings.
- To close registration, use the toggle in the admin panel or `SIGNUP_ENABLED=false`. To admit
  one person to a closed instance, create a signup invite in the admin panel.
- The server cannot reset a forgotten password. A user who forgets it recovers with their
  24-word recovery phrase. Without the phrase, their data cannot be decrypted. A signed-in user who
  lost the phrase can create a new one in Settings.
- Deleted accounts are kept for 30 days, during which the user can cancel the deletion, and are
  then purged.

## Backups

Back up both the database and the attachment blobs. Attachments are end-to-end encrypted, so a
lost blob cannot be restored from anywhere else. Back up the database first: the app uploads a
blob before the database refers to it, so a blob copy made after the dump covers every blob in
the dump.

```sh
# 1. The database (custom format, compressed)
docker compose exec -T db pg_dump -U atlas -Fc atlas > atlas-$(date +%F).dump

# 2. The attachment blobs
docker compose cp server:/app/data ./atlas-data-$(date +%F)
```

With `BLOB_BACKEND=s3`, back up the bucket instead of `/app/data` (bucket versioning or a copy
with your provider's tools), after the database dump as above.

Replace `-U atlas` and the final `atlas` if you changed `POSTGRES_USER` or `POSTGRES_DB`.

Everything in a backup is either ciphertext or metadata (see [SECURITY.md](../SECURITY.md)), but
treat it as sensitive anyway: it contains email addresses and password hashes.

### Restore

Restore into a fresh installation:

```sh
docker compose up -d db
docker compose exec -T db pg_restore -U atlas -d atlas --clean --if-exists < atlas-2026-01-01.dump
docker compose up -d
docker compose cp ./atlas-data-2026-01-01/. server:/app/data/
docker compose exec -u root server chown -R atlas:atlas /app/data
```

If you mount a host directory at `/app/data` instead of the named volume, it must be owned by
uid and gid 10001.

## Upgrading

Back up first. Then:

```sh
git pull
docker compose pull     # or build: docker compose up -d --build
docker compose up -d
```

Migrations run when the new server starts. Read the release notes before a minor-version jump:
they list any manual steps. A client that is too old for the server is refused with
`426 Upgrade Required` and asks the user to update.

### Upgrading from a pre-public build

Versions up to 0.28 used a different compose setup. If you run one of those, do this once:

- Copy the attachment blobs out of the old container before you upgrade, because recreating it
  deletes them: `docker cp <server-container>:/app/data ./atlas-data-backup`. They now live in
  the volume at `/app/data`.
- Stop the old stack without `-v` (`docker compose -p docker down`) so two PostgreSQL containers
  never share one volume.
- The compose project is now `atlas-todo`, started from the repository root. Move any settings
  from `docker/.env` to the root `.env`, and delete `DATABASE_URL` from it, since compose now
  builds it from `POSTGRES_*`.
- Set `POSTGRES_PASSWORD` to the password your database already has (`change-me` unless you
  chose one). PostgreSQL only reads it when it creates a volume.
- If you use your own project name (`-p <name>`, as Dokploy does), the database volume is
  `<name>_atlas_db`. Set `ATLAS_DB_VOLUME` to that name before the first deploy, or the server
  starts on an empty database. The old volume is not touched, so you can still fix this
  afterwards.
- After the new stack is up, copy the blobs back and fix their owner:

  ```sh
  docker compose cp ./atlas-data-backup/. server:/app/data/
  docker compose exec -u root server chown -R atlas:atlas /app/data
  ```

The Android APK is now signed with the release key, so it cannot be installed over an earlier
debug-signed APK. Let the app finish syncing, uninstall it, install the new one and sign in
again. Play Store installs update normally.

### Changing the database password

To replace an old default password such as `change-me`:

```sh
docker compose exec db psql -U atlas -d atlas -c "ALTER USER atlas PASSWORD 'new-password'"
```

Then set the same value as `POSTGRES_PASSWORD` in `.env` and run `docker compose up -d`.

## Maintenance commands

The server binary has a few subcommands. They need only `DATABASE_URL`, which the container
already has.

| Command                                                                                                                         | What it does                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `atlas-server promote <email>`                                                                                                  | Make an account an admin.                                                                                        |
| `atlas-server demote <email>`                                                                                                   | Remove admin rights.                                                                                             |
| `atlas-server restore-tasks (--project <uuid> \| --user <uuid>) --since <RFC3339> --until <RFC3339> [--apply] [--all-deleters]` | Bring back tasks deleted in a time window. A dry run unless `--apply`. It only works within `OP_RETENTION_DAYS`. |

Run them with `docker compose exec server atlas-server <command>`.

`GET /health` answers 200 when the server is up; the image's health check uses it.

## Running without Docker

The container and the NixOS module are the supported setups; the parts are ordinary:

```sh
cargo build --release -p atlas-server            # the server binary
(cd apps/mobile && EXPO_PUBLIC_API_URL=/api bun run export:web)   # the web app, in apps/mobile/dist
```

Run `target/release/atlas-server` with `DATABASE_URL`, `JWT_SECRET` and
`STATIC_DIR=apps/mobile/dist`, and set `BLOB_DIR` to a directory the server can write. The
project is tested against PostgreSQL 16.
