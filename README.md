# Atlas Todo

[![CI](https://github.com/atlastodo/atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/atlastodo/atlas/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/atlastodo/atlas)](https://github.com/atlastodo/atlas/releases/latest)
![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/atlastodo/atlas/badge)](https://scorecard.dev/viewer/?uri=github.com/atlastodo/atlas)

Atlas Todo is a self-hostable, end-to-end-encrypted to-do app. Your tasks, notes and attachments
are encrypted on your device, and the server you run (Rust + PostgreSQL) stores and
relays them without being able to read them. The same app runs in the browser, on Android and on
the Linux desktop, works fully offline, merges edits per field when it reconnects, and lets you
share encrypted projects with other people on your server.

> **Status: pre-1.0.** Only the latest release gets fixes, and the sync protocol still changes:
> keep clients and server on recent versions. The encryption has not been independently audited;
> [SECURITY.md](./SECURITY.md) says what it protects against and what it does not. Keep a JSON
> export of anything you cannot afford to lose.

Try it at [app.atlastodo.dev](https://app.atlastodo.dev) (a test server that may be reset), or
[self-host it](#self-hosting) with Docker. Website: [atlastodo.dev](https://atlastodo.dev). Questions
and ideas go to [Discussions](https://github.com/atlastodo/atlas/discussions); see
[Getting help](#getting-help).

<p>
  <img src="docs/screenshots/task-detail.png" alt="The task detail: notes, subtasks, attachments and comments next to a properties panel with due date, priority, labels, repeat and reminders">
</p>

<p>
  <img src="docs/screenshots/board.png" alt="A project board with sections as columns and subtasks nested in a card" width="49%">
  <img src="docs/screenshots/list.png" alt="The same project as a list grouped by section" width="49%">
  <img src="docs/screenshots/upcoming.png" alt="Upcoming tasks grouped by day, with notes, labels and subtasks" width="49%">
  <img src="docs/screenshots/calendar.png" alt="The month calendar with tasks on their due dates and an agenda below" width="49%">
  <img src="docs/screenshots/habits.png" alt="Habits with streaks and a week of check-ins" width="49%">
  <img src="docs/screenshots/stats.png" alt="Stats: completed tasks per day, streak, focus time and habit check-ins" width="49%">
  <img src="docs/screenshots/dark-board.png" alt="The project board in dark mode" width="49%">
  <img src="docs/screenshots/dark-task-detail.png" alt="The task detail in dark mode" width="49%">
</p>

<p>
  <img src="docs/screenshots/phone-today.png" alt="The Today view on a phone" width="32%">
  <img src="docs/screenshots/phone-task-detail.png" alt="The task detail on a phone" width="32%">
  <img src="docs/screenshots/phone-habits-dark.png" alt="Habits on a phone in dark mode" width="32%">
</p>

## Why Atlas Todo

Hosted to-do apps can read your tasks, and self-hosted ones usually can too: the server is where
the data is decrypted, if it is encrypted at all. Atlas Todo puts the keys on your devices
instead, and still gives you sharing, offline use and live sync across them.

|                                      | Atlas Todo | Todoist, TickTick | Vikunja |
| ------------------------------------ | :--------: | :---------------: | :-----: |
| Run it on your own server            |    yes     |        no         |   yes   |
| Server cannot read your tasks (E2EE) |    yes     |        no         |   no    |
| Shared projects                      |    yes     |        yes        |   yes   |
| Open source                          | yes (AGPL) |        no         |   yes   |

Not there yet:

- No iOS build is published, and the desktop app is Linux only (Electron).
- No CalDAV: the server cannot read tasks, so it cannot serve them to calendar apps.
- Two devices editing the same note offline keep the later edit whole, not a merge of both.
- One server instance only; it does not scale out.

## Features

- End-to-end encryption: Task titles, notes, project names, labels, comments, habits and
  attachments are encrypted on your device. See [Security model](#security-model).
- Offline-first sync: Every change is saved locally first and synced as a log of
  field-level edits. Concurrent edits merge per field. Other devices update live over a
  WebSocket.
- Sharing: Invite people on the same server to a project as editors or commenters. Owners
  can promote members. Assign tasks, comment and see an activity feed.
- Tasks: Projects, sections, labels, subtasks, priorities, start and due dates, a trash and
  an archive.
- Recurrence: Repeat rules that step by calendar day in your time zone.
- Reminders: Local notifications on Android and desktop. In a browser they fire while the
  tab is open.
- Views: Inbox, Today, Upcoming, list, board (kanban), calendar, saved filters and
  countdowns.
- Quick add: Type "tomorrow 5pm" or "friday" and the date is set for you. Keyboard
  shortcuts and a command palette on web and desktop.
- Habits: Scheduled habits with check-ins and streaks.
- Focus: A pomodoro timer that logs focus time against tasks, plus productivity stats.
- Attachments: Files and images on tasks, encrypted before upload.
- Import and export: Import a TickTick CSV export, or a Todoist project CSV or full backup zip.
  Back up and restore your data as JSON.
- Passkeys: Sign in and unlock with a passkey on the web and Android, with or without a
  password, when the server enables them.
- Admin panel: Manage accounts, close signups, create signup invites, read bug reports and
  review the audit log.
- Languages: English, Danish, German, Spanish, French, Italian, Dutch, Polish and Brazilian
  Portuguese. Quick add understands dates, times and repeats typed in each of them.
- Platforms: Web (served by your server), Android, and a Linux desktop app (Electron).

## Architecture

```mermaid
flowchart TB
  subgraph clients["apps/mobile (Expo)"]
    android["Android app"]
    web["Web app (react-native-web)"]
  end
  electron["apps/electron<br/>desktop shell"]
  core["packages/client-core<br/>local store (SQLite / IndexedDB), sync client, E2EE"]
  shared["packages/shared<br/>pure TS: recurrence, filters, quick add, habits"]
  server["crates/atlas-server (Axum)"]
  atlascore["crates/atlas-core<br/>pure Rust: HLC and op types"]
  db[("PostgreSQL<br/>op log, per-user state, accounts, wrapped keys")]

  electron -.->|wraps| web
  android --> core
  web --> core
  core --> shared
  core <-->|"HTTPS + WebSocket<br/>(ciphertext ops)"| server
  server --> atlascore
  server --> db
```

Clients record each edit as an operation on one field, stamped with a hybrid logical clock. The
newest stamp wins per field, so replaying operations in any order gives the same result. The
server keeps an append-only log per user and copies operations on shared projects to every
member. [docs/architecture.md](./docs/architecture.md) covers sync, the clock and the key
hierarchy, [docs/sync-protocol.md](./docs/sync-protocol.md) the wire format, and
[docs/decisions/](./docs/decisions/README.md) why the main choices were made.

## Self-hosting

You need Docker with Compose v2.24 or later. On NixOS, the repository flake has a
`services.atlas` module instead; see [NixOS](./docs/self-hosting.md#nixos).

```sh
git clone https://github.com/atlastodo/atlas.git
cd atlas
cp .env.example .env
# Edit .env and set:
#   POSTGRES_PASSWORD   e.g. the output of: openssl rand -hex 24
#   JWT_SECRET          e.g. the output of: openssl rand -hex 32
docker compose up -d
```

Open <http://localhost:8080> and create an account. One container serves the web app and the
API, and applies database migrations when it starts. Run compose commands from the repository
root so it reads the root `.env`.

The port is published on localhost only. To use it from other devices, put a TLS reverse proxy in
front ([Caddy takes three lines](./docs/self-hosting.md#caddy)), or set `PORT_BIND=8080` in
`.env` to listen on every interface.

Signing up never makes anyone an admin. Create your account, then promote it:

```sh
docker compose exec server atlas-server promote you@example.com
```

The admin panel is the Admin section of Settings, shown to admins only.

[docs/self-hosting.md](./docs/self-hosting.md) has the full settings reference, reverse-proxy
examples, backups, upgrades and closing registration.

Docker (with compose) and the Android app are the supported ways to run Atlas Todo. The NixOS
module, the Linux desktop tarball and self-built iOS apps are maintained on a best-effort basis.

## Help test it on Android

Google Play only opens the app to the public after a closed test, so testers are welcome:

1. Join the [atlas-todo-testers](https://groups.google.com/g/atlas-todo-testers) Google Group with
   the Google account you use on your phone.
2. Opt in at [play.google.com/apps/testing/dev.sejder.atlastodo](https://play.google.com/apps/testing/dev.sejder.atlastodo)
   and install Atlas Todo from Google Play.
3. Report bugs in [Issues](https://github.com/atlastodo/atlas/issues).

The test builds sign in to the test server at [app.atlastodo.dev](https://app.atlastodo.dev),
which may be reset; see the [privacy notice](https://atlastodo.dev/privacy.html).

## Client apps

Release builds start out pointed at the test server, app.atlastodo.dev. To use your own instance,
change the _Server URL_ field on the sign-in screen.

- Web: your server serves the web app at its root URL. There is nothing to configure.
- Android: join the closed test on Google Play ([above](#help-test-it-on-android)), or download
  `atlas-todo-X.Y.Z.apk` from [GitHub Releases](https://github.com/atlastodo/atlas-todo/releases)
  and install it. [docs/android-permissions.md](./docs/android-permissions.md) lists the
  permissions it asks for, and why.
- Desktop (Linux): each release has `atlas-desktop-X.Y.Z.tar.gz`, which contains the app and a
  Nix flake for x86_64 and aarch64 Linux. See [apps/electron/README.md](./apps/electron/README.md)
  for the Nix setup.
- iOS: there is no published build. You can build one yourself with Expo EAS and an Apple
  Developer account; see [apps/mobile/RELEASE.md](./apps/mobile/RELEASE.md).
- Command line and automation: the `atlas` CLI (a static binary per platform on each release)
  works with an API token from Settings, for scripts and tools like n8n. Your data stays
  end-to-end encrypted. See [docs/integrations.md](./docs/integrations.md).

## Getting help

- Questions, self-hosting help and ideas: [Discussions](https://github.com/atlastodo/atlas/discussions).
- Bugs and concrete feature requests: [Issues](https://github.com/atlastodo/atlas/issues/new/choose).
- Vulnerabilities: privately, as [SECURITY.md](./SECURITY.md) describes, never in a public issue.
- Accessibility problems: [ACCESSIBILITY.md](./ACCESSIBILITY.md) has what is known and how to report.

Atlas Todo is a spare-time project with one maintainer. [SUPPORT.md](./.github/SUPPORT.md) says
what to expect, and [ROADMAP.md](./ROADMAP.md) where the project is heading.

## Development

The dev environment is [devenv](https://devenv.sh) (Nix). It provides Rust, Node 26, Bun and
PostgreSQL.

```sh
devenv shell           # enter the environment
cp .env.example .env   # then set JWT_SECRET
devenv up              # start PostgreSQL (in its own terminal)
db:migrate
dev                    # API + web app with live reload
test:all               # all test suites
lint                   # rustfmt, clippy and TypeScript checks
```

[CONTRIBUTING.md](./CONTRIBUTING.md) covers the setup (including one without Nix), the test runners,
commit style and what CI checks.

## Security model

Your password never leaves your device. The app derives a login hash for the server and a key
that unlocks your encryption keys. Field values are encrypted with AES-256-GCM before they sync,
and shared projects use a per-project key sealed to each member's public key.

The server sees who you are, which entities exist, when they change and a few plaintext routing
fields such as a task's project id. It cannot read titles, notes, names or attachment contents.
A 24-word recovery phrase, shown at signup, is the only way back if you forget your password.
On servers that enable them, passkeys (with the WebAuthn PRF extension) can sign in and unlock your
data too, next to a password or instead of one, in the web app and on Android.

There is no telemetry, analytics or crash reporting SDK: the apps talk to your server and nothing
else, with two exceptions. Release builds of the mobile app check Expo's update service
(`u.expo.dev`) for over-the-air updates when they start, and the Linux desktop app, unless it runs
from the Nix store, checks the GitHub Releases API for a new version once a day (`--no-update` or
`ATLAS_DISABLE_UPDATE=1` turns that off).

[SECURITY.md](./SECURITY.md) has the threat model, its limits and how to report a vulnerability.

## Repository layout

```
crates/atlas-core     Rust: HLC and op log types (pure, no I/O)
crates/atlas-server   Rust: Axum HTTP + WebSocket API over PostgreSQL (sqlx)
migrations/           sqlx migrations, the source of truth for the schema
apps/mobile           React Native + Expo: the one UI, for Android, iOS and the web
apps/electron         Electron shell around the web export
packages/client-core  TS: local store, sync client, E2EE
packages/shared       TS: portable pure logic (recurrence, filters, habits, stats, i18n, …)
packages/sdk          TS: headless client for integrations, signed in with an API token
crates/atlas-client   Rust: headless client (E2EE, sync, task rules) at parity with the TS core
crates/atlas-cli      Rust: the `atlas` command-line tool, one static binary
manifests/            JSON app manifests (entity kinds, plaintext fields), bundled by server and clients
test-vectors/         JSON fixtures shared by the Rust and TypeScript tests
docker/               Dockerfile and the compose stack (included by compose.yaml)
nix/                  Nix packages, the NixOS and Home Manager modules, the desktop tarball's flake
docs/                 Self-hosting, architecture and integration guides
```

## License

Copyright (C) 2026 The Atlas Todo contributors.

Atlas Todo is licensed under the [GNU Affero General Public License v3.0 only](./LICENSE).
If you run a modified version as a network service, the AGPL requires you to offer its source
to your users.

Contributions are welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md).
