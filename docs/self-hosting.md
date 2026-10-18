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
git clone https://github.com/atlastodo/atlas.git
cd atlas
cp .env.example .env
```

Edit `.env` and set the two required values:

```sh
POSTGRES_PASSWORD=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -hex 32>
```

Then start it:

```sh
docker compose up -d            # pulls ghcr.io/atlastodo/atlas:latest
docker compose up -d --build    # or: builds the image from this checkout
docker compose logs -f server   # follow the logs
```

Run all `docker compose` commands from the repository root. The root `compose.yaml` includes
`docker/docker-compose.yml`. Compose reads the root `.env`, and the server container receives
every variable in it. A `docker/.env` is read too, if it exists, for tools that run
`docker compose -f docker/docker-compose.yml` and write their env file there.

In production, pin a version: `ATLAS_IMAGE=ghcr.io/atlastodo/atlas:X.Y.Z`. The same image is
on Docker Hub as `atlastodo/atlas`. It is built for linux/amd64 and linux/arm64 (a 64-bit OS
on a Raspberry Pi works; 32-bit ARM does not).

To try unreleased changes, `ATLAS_IMAGE=ghcr.io/atlastodo/atlas:dev` follows the `dev` branch:
it is rebuilt after every change there that passes CI. Use it with a database you can lose or
restore. A `dev` image may apply database migrations that no release has yet, and a release image
refuses to start against a database with a migration it does not know, so going back means waiting
for the next release that includes it, or restoring a backup taken before switching.

### Image renamed

The repository was renamed from `atlastodo/atlas-todo` to `atlastodo/atlas`, and the image with
it: it is now `ghcr.io/atlastodo/atlas` (Docker Hub: `atlastodo/atlas`). The old names,
`ghcr.io/atlastodo/atlas-todo` and `atlastodo/atlas-todo`, keep receiving the same tags for a
deprecation period, then stop getting new ones. Switch now:

- Set `ATLAS_IMAGE=ghcr.io/atlastodo/atlas:latest` (or a pinned `X.Y.Z`) in `.env` if you set
  it to the old name; the compose default already uses the new one.
- Point an existing clone at the new repository, because `atlastodo/atlas-todo` will hold the
  todo app rather than the server:
  `git remote set-url origin https://github.com/atlastodo/atlas.git`.
- On NixOS, change the flake input to `github:atlastodo/atlas` (or
  `git+https://github.com/atlastodo/atlas.git`), import `nixosModules.atlas` and rename
  `services.atlas-todo` to `services.atlas`. The old option and module names still evaluate,
  with a deprecation warning, and the service keeps its unit, user, data directory and database
  (all still called `atlas-todo`).

## NixOS

The repository flake builds the server from source and ships a NixOS module, so a NixOS machine
runs the server, and optionally the database, as native services instead of the container:

```nix
# flake input
atlas.url = "git+https://github.com/atlastodo/atlas.git";
# No `inputs.nixpkgs.follows`: the server builds with the flake's own pinned nixpkgs, the
# toolchain CI tests.

# configuration
imports = [ inputs.atlas.nixosModules.atlas ]; # also exported as nixosModules.server

services.atlas = {
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

- Names: the option is `services.atlas` and the module `nixosModules.atlas`. The pre-rename
  `services.atlas-todo` and `nixosModules.atlas-todo` still work, with a deprecation warning
  ([Image renamed](#image-renamed)). The system names below stay `atlas-todo`, so a rename never
  moves the data.
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
  one port, like the container. The repository flake provides it as `packages.<system>.web-dist`
  (`staticDir = inputs.atlas.packages.${pkgs.system}.web-dist;`): the same released Atlas Todo
  web build the image serves, pinned by version and hash in `apps.lock.json`, so a flake update
  ships the server and its matching web app together. It calls the API at `/api` on its own
  origin, which the server serves. The app itself is built in
  [atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo); the desktop app's NixOS and
  Home Manager modules (`programs.atlas-desktop`) moved to that repository's flake.
- The service runs as the system user `atlas-todo` with a hardened unit (`ProtectSystem=strict`,
  only `dataDir` writable). It listens on 0.0.0.0:8080 by default (`bindAddress`, `port`);
  `openFirewall` opens the port when nothing proxies in front.
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

| Variable            | Default                          | Notes                                                                                                                         |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` | none, required                   | Database password. It goes into a URL, so use URL-safe characters. PostgreSQL only reads it when the volume is first created. |
| `POSTGRES_USER`     | `atlas`                          | Database user.                                                                                                                |
| `POSTGRES_DB`       | `atlas`                          | Database name.                                                                                                                |
| `PORT_BIND`         | `127.0.0.1:8080`                 | Host address and port. Localhost only by default; `8080` listens on every interface. Inside, the server always uses 8080.     |
| `ATLAS_IMAGE`       | `ghcr.io/atlastodo/atlas:latest` | Image to pull, or the name to tag a local build with.                                                                         |
| `ATLAS_DB_VOLUME`   | `docker_atlas_db`                | Name of the database volume. The default keeps the name older installs already have.                                          |

Compose builds `DATABASE_URL` from the `POSTGRES_*` values and pins `PORT=8080` and
`BIND_ADDR=0.0.0.0`. A `DATABASE_URL` in `.env` or in your shell is ignored.

### Server settings

| Variable                                                        | Default                                                 | Notes                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                  | none, required                                          | Set by compose. Needed when you run the binary yourself.                                                                                                                                                                                                                               |
| `DB_MAX_CONNECTIONS`                                            | `10`                                                    | PostgreSQL connections the server pools. Raise it for many concurrent users, within the database's own `max_connections`.                                                                                                                                                              |
| `JWT_SECRET`                                                    | none, required                                          | Signs access tokens and account-recovery challenges. At least 32 bytes, not a placeholder.                                                                                                                                                                                             |
| `PORT`                                                          | `8080`                                                  | Listening port.                                                                                                                                                                                                                                                                        |
| `BIND_ADDR`                                                     | `0.0.0.0`                                               | Listening address, any IPv4 or IPv6 address: `127.0.0.1` for localhost only, `::` for every interface (IPv4 too, unless the host sets `net.ipv6.bindv6only`). Pinned to `0.0.0.0` under compose; use `PORT_BIND` there.                                                                |
| `RUST_LOG`                                                      | `info` in the image, `atlas_server=info,warn` otherwise | Log filter, in `tracing` EnvFilter syntax.                                                                                                                                                                                                                                             |
| `STATIC_DIR`                                                    | `/app/dist` if that directory exists                    | The web app to serve. The image sets it. Without it the server is API only.                                                                                                                                                                                                            |
| `CORS_ALLOWED_ORIGINS`                                          | any origin                                              | Comma-separated exact origins. Auth uses a bearer header, not cookies, so any origin is safe. If you set a list, include `app://atlas-todo` for the desktop app.                                                                                                                       |
| `ACCESS_TOKEN_TTL_SECONDS`                                      | `900`                                                   | Access token lifetime (15 minutes).                                                                                                                                                                                                                                                    |
| `REFRESH_TOKEN_TTL_SECONDS`                                     | `2592000`                                               | Refresh token lifetime (30 days).                                                                                                                                                                                                                                                      |
| `SIGNUP_ENABLED`                                                | `true`                                                  | `false` refuses new accounts. Existing accounts can still sign in, and a signup invite still admits one person. Once the admin panel's toggle has been used, it overrides this value.                                                                                                  |
| `ADMIN_EMAILS`                                                  | none                                                    | Comma-separated. At every startup, the listed accounts that exist are promoted to admin. It never demotes and never applies at signup.                                                                                                                                                 |
| `BUG_REPORTS_ENABLED`                                           | `true`                                                  | `false` removes the anonymous `POST /reports` endpoint.                                                                                                                                                                                                                                |
| `ATLAS_APPS`                                                    | `todo`                                                  | Comma-separated Atlas apps this instance offers, from those bundled in the release (`todo`, `journal`). An app the release does not bundle stops the server at startup. Sync refuses and hides the data of an app left out. `GET /discovery` lists what is offered. See [Apps](#apps). |
| `WEBAUTHN_RP_ID`                                                | unset (passkeys off)                                    | The domain passkeys belong to, normally the one serving the web app. Setting it turns passkeys on. Changing it later orphans every registered passkey. See [Passkeys](#passkeys).                                                                                                      |
| `WEBAUTHN_ORIGINS`                                              | `https://<WEBAUTHN_RP_ID>`                              | Comma-separated exact origins a passkey ceremony may come from: https on that domain or a subdomain (`http://localhost` only with `WEBAUTHN_RP_ID=localhost`), or `android:apk-key-hash:` origins.                                                                                     |
| `WEBAUTHN_RP_NAME`                                              | `Atlas Todo`                                            | The name an authenticator shows next to the passkey.                                                                                                                                                                                                                                   |
| `ANDROID_APP_PACKAGE` / `ANDROID_APP_CERT_SHA256`               | unset                                                   | Both or neither. Serve `/.well-known/assetlinks.json` for the Android app (package name and comma-separated SHA-256 signing-certificate fingerprints), so it can use this domain's passkeys; the fingerprints also become allowed origins.                                             |
| `AUTH_RATE_LIMIT_TRUST_FORWARDED`                               | `false`                                                 | Use `X-Forwarded-For` for the per-IP limits. Turn it on behind a reverse proxy, and only if the proxy is the only way in.                                                                                                                                                              |
| `TRUSTED_PROXY_HOPS`                                            | `1`                                                     | How many proxies append to `X-Forwarded-For`. At least 1.                                                                                                                                                                                                                              |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_SECS`           | `30` / `60`                                             | Requests per client IP to the `/auth/*` endpoints.                                                                                                                                                                                                                                     |
| `AUTH_ACCOUNT_FAILURE_MAX` / `AUTH_ACCOUNT_FAILURE_WINDOW_SECS` | `10` / `900`                                            | Failed password checks per account and client address (an IPv6 address counts by its /64), across login, recovery and cancelling a deletion. Across all addresses an account closes at five times this, so locking its owner out takes failures from five addresses.                   |
| `SYNC_RATE_LIMIT_MAX` / `SYNC_RATE_LIMIT_WINDOW_SECS`           | `60` / `60`                                             | Sync pushes per user.                                                                                                                                                                                                                                                                  |
| `SYNC_READ_RATE_LIMIT_MAX` / `SYNC_READ_RATE_LIMIT_WINDOW_SECS` | `600` / `60`                                            | Sync reads (pull, snapshot, WebSocket tickets) per user.                                                                                                                                                                                                                               |
| `REPORT_RATE_LIMIT_MAX` / `REPORT_RATE_LIMIT_WINDOW_SECS`       | `10` / `300`                                            | Bug reports per client IP.                                                                                                                                                                                                                                                             |
| `INVITE_RATE_LIMIT_MAX` / `INVITE_RATE_LIMIT_WINDOW_SECS`       | `60` / `3600`                                           | Project invites per user. Each one shows whether an email has an account.                                                                                                                                                                                                              |
| `UPLOAD_RATE_LIMIT_MAX` / `UPLOAD_RATE_LIMIT_WINDOW_SECS`       | `60` / `60`                                             | Attachment uploads per user.                                                                                                                                                                                                                                                           |
| `DOWNLOAD_RATE_LIMIT_MAX` / `DOWNLOAD_RATE_LIMIT_WINDOW_SECS`   | `600` / `60`                                            | Attachment downloads per user (a separate budget from uploads).                                                                                                                                                                                                                        |
| `MAX_PUSH_BYTES`                                                | `2097152`                                               | Largest sync push body (2 MiB). A larger one gets 413.                                                                                                                                                                                                                                 |
| `OP_RETENTION_DAYS`                                             | `30`                                                    | Days of sync history to keep. `0` keeps everything.                                                                                                                                                                                                                                    |
| `REFRESH_TOKEN_RETENTION_DAYS`                                  | `30`                                                    | Days to keep expired or revoked refresh tokens, for reuse detection. `0` or less keeps them.                                                                                                                                                                                           |
| `ATTACHMENTS_ENABLED`                                           | `true`                                                  | `false` turns attachments off: `/attachments/*` answers 404 and the apps hide the feature.                                                                                                                                                                                             |
| `BLOB_BACKEND`                                                  | `fs`                                                    | `fs` stores blobs under `BLOB_DIR`; `s3` stores them in a bucket. See [S3 storage](#s3-storage).                                                                                                                                                                                       |
| `BLOB_DIR`                                                      | `/app/data/blobs`                                       | Where blobs are stored. In Docker, keep it under `/app/data`, the volume; anything else is lost when the container is recreated. With `s3`, only uploads in progress.                                                                                                                  |
| `S3_BUCKET` / `S3_PREFIX`                                       | unset / empty                                           | With `BLOB_BACKEND=s3`: the bucket (required) and a key prefix.                                                                                                                                                                                                                        |
| `MAX_BLOB_BYTES`                                                | `26214400`                                              | Largest attachment (25 MiB).                                                                                                                                                                                                                                                           |
| `BLOB_QUOTA_BYTES`                                              | `1073741824`                                            | Total attachment storage per user (1 GiB).                                                                                                                                                                                                                                             |
| `MAX_BLOB_TRANSFERS`                                            | `16`                                                    | Attachment uploads and downloads in progress at once, across all users. One more gets 503 and the app tries again shortly. Bodies stream to and from disk, so this bounds open files and disk load rather than memory.                                                                 |
| `BLOB_GC_GRACE_DAYS`                                            | `30`                                                    | Days an unreferenced blob is kept before it is deleted, counted from its last upload and from when it lost its last reference. Never less than `OP_RETENTION_DAYS`, so a deleted attachment can still be restored. `0` disables the collection.                                        |

### Apps

Atlas is growing into a suite of end-to-end encrypted apps that share one server and one account.
Each app is described by a manifest that ships inside the server release; you cannot add one
from disk. `ATLAS_APPS` picks which of the bundled apps your instance offers. The release bundles
`todo` (the default) and `journal` (Atlas Journal, daily encrypted journal entries; its app ships
separately). Set `ATLAS_APPS=todo,journal` to offer Journal too.

Every account has `todo` enabled, existing ones included. Apps added to a release later are
switched on per account from the app, once you list them in `ATLAS_APPS`. Leaving an app out
of `ATLAS_APPS` hides its data from sync without deleting it; adding the app back brings the
data back.

`GET /discovery` (also under `/api`) is public and tells clients the server version, its sync
protocol, its capabilities and the apps it offers. The apps read it before signing in, so a server
too old for an app says so instead of failing later.

### Passkeys

Passkeys let people sign in, and unlock their end-to-end encrypted data, with a fingerprint, face
or device PIN instead of a password. They are off until you set `WEBAUTHN_RP_ID` to the domain
the web app is served from:

```sh
WEBAUTHN_RP_ID=todo.example.com
# WEBAUTHN_ORIGINS=https://todo.example.com   # the default
```

A passkey is bound to that domain (the WebAuthn "relying party ID") for good: changing it later
leaves every registered passkey unusable, and their owners sign in with a password or the recovery
phrase instead. Every web origin that offers passkeys must be `https://` on that domain or a
subdomain, and must be listed in `WEBAUTHN_ORIGINS` when it is not the domain itself. For local
development, `WEBAUTHN_RP_ID=localhost` with `WEBAUTHN_ORIGINS=http://localhost:8081` works over
plain HTTP. `GET /discovery` lists the `passkeys` capability while they are on; the apps offer
passkeys only then.

Only passkeys that support the WebAuthn PRF extension are accepted, since the passkey also
unlocks the account's keys: current Chrome, Edge, Safari and Firefox with Google Password Manager,
iCloud Keychain, Windows Hello (Windows 11), 1Password, Bitwarden or a FIDO2 security key. The app
says so when an authenticator cannot. The server never sees the key material.

**Desktop app.** The desktop app runs from its own `app://atlas-todo` origin, which no WebAuthn
relying party can match, so it does not offer passkeys: sign in there with the password (an
account can have both). **iOS** is not supported yet; a passkey-only account cannot sign in on
iOS.

**Android.** The Android app uses Credential Manager, which only lets an app use a domain's
passkeys when the domain vouches for the app through Digital Asset Links. Set both:

```sh
ANDROID_APP_PACKAGE=dev.sejder.atlastodo
ANDROID_APP_CERT_SHA256=AB:CD:…:EF
```

The server then serves `https://<WEBAUTHN_RP_ID>/.well-known/assetlinks.json` (make sure your
proxy passes it through, and that `WEBAUTHN_RP_ID` is the very domain it is served on) and accepts
the app's `android:apk-key-hash:` origin. For the official Play Store build use the app signing
key's SHA-256 shown in the Play Console under Setup → App signing; for an APK you signed yourself,
`keytool -list -v -keystore <keystore>` prints it. List several fingerprints, comma-separated, to
accept more than one build.

Rate limits are those of every `/auth/*` route. A passkey ceremony must finish within five
minutes, and each challenge answers once.

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

The image does not build the web app: it serves a released Atlas Todo web build (an
`atlas-todo-web-X.Y.Z.tar.gz` asset of [atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo/releases)),
downloaded during the build and checked against its SHA-256. By default that is the `todo` pin in
`apps.lock.json`, together with that release's `THIRD_PARTY_NOTICES.txt` (in the image as
`/usr/share/doc/atlas-todo/web/THIRD_PARTY_NOTICES.txt`). The arguments serve another build:

| Argument                  | Default           | Notes                                                                                              |
| ------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `TODO_WEB_URL`            | the pin's URL     | An `atlas-todo-web-X.Y.Z.tar.gz` (one top-level directory of static files with an `index.html`).   |
| `TODO_WEB_SHA256`         | the pin's SHA-256 | That file's SHA-256, required with `TODO_WEB_URL`; the build fails on a mismatch.                  |
| `TODO_WEB_NOTICES_URL`    | the pin's notices | With `TODO_WEB_URL`: the web build's third-party notices, optional (left out, the image has none). |
| `TODO_WEB_NOTICES_SHA256` | the pin's SHA-256 | That file's SHA-256, required with `TODO_WEB_NOTICES_URL`.                                         |

The released web build calls its API at `/api` on its own origin. A build with another API URL,
or of modified app code, is built in the app repository (`scripts/web-release-tarball.sh`) and passed
here; if you run modified code, its About screen should link to that code, since the AGPL asks you
to offer your users its source.

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

Compose publishes the port on localhost only (`PORT_BIND=127.0.0.1:8080`), so only a proxy on the
same host can reach it. Keep it that way when you trust the header; widen it (`PORT_BIND=8080`)
only for a proxy on another machine, and then firewall the port to that machine.

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

- The server does not verify email addresses: whoever signs up first with an address holds it,
  and project invites sent to that address go to them. So create your own account (and promote
  it) before the instance is reachable by others, and list an address in `ADMIN_EMAILS` only once
  its account exists: otherwise whoever registers it first is promoted at the next restart. On an
  instance for a known group, close registration and admit people with signup invites.

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

From 0.1.10, compose publishes the port on localhost only. If clients reach port 8080 directly
rather than through a proxy on the same host, set `PORT_BIND=8080` in `.env` before upgrading.

### Upgrading from a pre-public build

Builds from before the public 0.1.0 release (versioned up to 0.28) used a different compose
setup. If you run one of those, do this once:

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
`GET /discovery` answers with the server version and the apps it offers.

## Running without Docker

The container and the NixOS module are the supported setups; the parts are ordinary:

```sh
cargo build --release -p atlas-server            # the server binary
curl -fsSLo web.tar.gz "$(jq -r .todo.url apps.lock.json)"     # the pinned web app
echo "$(jq -r .todo.sha256 apps.lock.json)  web.tar.gz" | sha256sum -c -
mkdir web && tar -xzf web.tar.gz -C web --strip-components=1
```

The server links OpenSSL (for passkey verification): building needs its headers and
`pkg-config` (`libssl-dev` on Debian and Ubuntu), and running needs the library (`libssl3`).

Run `target/release/atlas-server` with `DATABASE_URL`, `JWT_SECRET` and
`STATIC_DIR=web`, and set `BLOB_DIR` to a directory the server can write. The
project is tested against PostgreSQL 16.
