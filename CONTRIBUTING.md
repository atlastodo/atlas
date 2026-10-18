# Contributing to Atlas Todo

Thanks for your interest. Atlas Todo has a Rust server, one React Native + Expo UI for Android,
the web and the desktop, and a TypeScript client core. This guide covers the setup, the checks
and how changes get merged. For a map of the code, start with
[docs/architecture.md](./docs/architecture.md).

**Open pull requests against the `dev` branch**, not `main` (GitHub's default): `main` only
receives releases. See [Branches and releases](#branches-and-releases).

For anything larger than a small fix, open an issue first so we can agree on the approach before
you write code; a draft pull request early on is welcome too. A feature PR without an agreed
issue may be closed with a pointer here. Questions and ideas that are not bugs go to
[Discussions](https://github.com/atlastodo/atlas/discussions). Everyone taking part follows
the [Code of Conduct](./CODE_OF_CONDUCT.md).

The project has one maintainer, who decides what is merged. Issues and pull requests are triaged
about once a week; if your pull request has had no response after 7 days, comment on it to ping.
[.github/SUPPORT.md](./.github/SUPPORT.md) has the rest of what to expect.

## Scope

[ROADMAP.md](./ROADMAP.md) says where the project is going. Some things are out of scope for good,
so please don't start on them without asking:

- Anything that needs the server to read task content (server-side search, a server CalDAV
  endpoint): see [decision 0002](./docs/decisions/0002-no-caldav.md) and
  [0003](./docs/decisions/0003-plaintext-routing-fields.md).
- A separate native UI for one platform: see [decision 0005](./docs/decisions/0005-one-react-native-ui.md).
- Running several server instances, and telemetry or analytics of any kind.
- Weakening the sync protocol floor for old clients: see
  [decision 0004](./docs/decisions/0004-protocol-floor-only-rises.md).

## Good first contributions

- Issues labelled [`good first issue`](https://github.com/atlastodo/atlas/labels/good%20first%20issue)
  are small and self-contained; [`help wanted`](https://github.com/atlastodo/atlas/labels/help%20wanted)
  ones are bigger.
- Translations: improving a catalog, or adding a language
  ([Adding or changing UI text](#adding-or-changing-ui-text)), needs no Rust and little setup.
- Docs: anything in the self-hosting guide that tripped you up is worth a fix.
- Not code: testing a pre-release (the Android closed test, a `-rc` Docker tag), reproducing
  someone else's bug report, or answering a question in Discussions all help.
- Accessibility: [ACCESSIBILITY.md](./ACCESSIBILITY.md) lists the known gaps.

## Development environment

The environment is defined with [devenv](https://devenv.sh) (Nix). It pins Rust, Node 26,
Bun 1.4.2, PostgreSQL, sqlx-cli and the other tools.

```sh
git clone https://github.com/<you>/atlas.git
cd atlas
git remote add upstream https://github.com/atlastodo/atlas.git
git fetch upstream
git switch -c my-change upstream/dev   # branch from dev: PRs target it
cp .env.example .env   # set JWT_SECRET (openssl rand -hex 32)
devenv shell           # enter the environment
devenv up              # start PostgreSQL; leave it running in its own terminal
db:migrate             # apply the migrations
dev                    # API on :8080 + the web app with live reload
```

- The first `devenv shell` builds sqlx-cli from source, which takes about a minute.
- devenv starts PostgreSQL on a free port and derives `DATABASE_URL` and `TEST_DATABASE_URL`
  from it. Keep database settings out of `.env`: devenv loads it and it would override them.
  The dev database is `atlas_dev`, the test database is `atlas_test`, and the user and password
  are both `atlas`.
- The server refuses to start without `DATABASE_URL` and a valid `JWT_SECRET`.
- The web app talks to `EXPO_PUBLIC_API_URL`, which defaults to `http://localhost:8080`.

### Without Nix

devenv is the supported setup, but nothing requires it. You need Rust 1.94 or later, Node 26,
Bun 1.4.2, PostgreSQL 16 or later and [cargo-nextest](https://nexte.st). The server applies its
migrations when it starts, so sqlx-cli is optional.

```sh
# PostgreSQL with the dev and test databases, here in Docker:
docker run -d --name atlas-pg -p 5432:5432 \
  -e POSTGRES_USER=atlas -e POSTGRES_PASSWORD=atlas -e POSTGRES_DB=atlas_dev postgres:16
docker exec atlas-pg createdb -U atlas atlas_test

export DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_dev
export TEST_DATABASE_URL=postgres://atlas:atlas@localhost:5432/atlas_test
export JWT_SECRET=$(openssl rand -hex 32)

bun install
cargo run -p atlas-server            # API on :8080, migrates on start
cd apps/mobile && bun run web        # the web app, in a second terminal
```

The exports last only for that terminal: run the server and the tests where you set them, or
put `JWT_SECRET` (not the database URLs) in `.env`. Install cargo-nextest with
`cargo install cargo-nextest --locked`.

The devenv scripts are short shell in `devenv.nix`. Without devenv, `test:all` and `lint` are:

```sh
# test:all (PostgreSQL running, TEST_DATABASE_URL set)
cargo nextest run --workspace
(cd packages/client-core && bunx --bun vitest run)
(cd packages/shared && bunx --bun vitest run)
(cd apps/electron && bunx --bun vitest run)
(cd apps/mobile && bun run test)

# lint, plus the two typechecks only CI runs
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --no-deps -- -D warnings
bun run --parallel --filter '*' typecheck
bunx eslint .
bunx prettier --check .
```

If you change dependencies without Nix, `nix/bun.nix` can't be regenerated (`nix:bun-lock`). Say
so in the pull request and the maintainer will regenerate it.

### Android SDK (optional)

The Android SDK is several GB, so it is off by default. Expo Go (`mobile:dev`) and the EAS cloud
builds don't need it. To turn it on for your machine, create a `devenv.local.nix` in the
repository root (it is gitignored):

```nix
{ android.enable = true; }
```

Then leave and re-enter `devenv shell`. The scripts that need the SDK tell you this when it is
off.

## Scripts

All of these run inside `devenv shell` (without it, see [Without Nix](#without-nix)). The root
`package.json` has no scripts.

| Script                             | What it does                                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| `dev`                              | API (cargo watch) and the Expo web dev server                    |
| `web:dev`                          | the whole local stack in one command                             |
| `mobile:dev`                       | Metro for a phone running Expo Go                                |
| `desktop:dev`                      | API, web and the Electron app with live reload                   |
| `desktop:start`                    | export the web bundle and run Electron against it                |
| `desktop:package`                  | build the desktop tarball                                        |
| `nix:bun-lock`                     | regenerate `nix/bun.nix` after a `bun.lock` change               |
| `db:migrate`, `db:reset`           | apply or reset the migrations                                    |
| `test:all`                         | every test suite (see below)                                     |
| `lint`                             | rustfmt check, clippy, TypeScript checks, ESLint, Prettier check |
| `fmt`                              | rustfmt and prettier                                             |
| `emulator:start`, `mobile:android` | Android emulator and native dev build (needs the SDK)            |
| `version:bump`                     | release helper, maintainers only                                 |

The full-suite script is `test:all`, not `test`: a script named `test` collides with the shell
builtin.

## Tests

`test:all` runs, in order and stopping at the first failure:

1. `cargo nextest run --workspace`
2. vitest in `packages/client-core`, `packages/shared` and `apps/electron`
3. jest (jest-expo) in `apps/mobile`

`lint` runs `cargo fmt --check`, `cargo clippy --workspace --all-targets --no-deps -D warnings`,
`tsc --noEmit` for `packages/shared` and `apps/mobile`, `eslint .` and `prettier --check .`.
`fmt` fixes the formatting. CI also typechecks `packages/client-core` and `apps/electron`. If you
touch them, run `cd packages/client-core && bun run typecheck` or
`cd apps/electron && bun run typecheck`.

Each package has its own runner. To run one test:

- Rust: `cargo nextest run -p atlas-server <name>`
- `packages/*` and `apps/electron`: `cd packages/shared && bunx --bun vitest run src/foo.test.ts`
- `apps/mobile`: `bun run test -- <pattern>`. This must run under Node, not Bun's runtime, or it
  fails at load with `Attempted to assign to readonly property`.

Where the tests live:

- `crates/atlas-core`: unit tests next to the code. No database needed.
- `crates/atlas-server/tests/`: integration tests over HTTP. They need PostgreSQL running
  (`devenv up`, or the container from [Without Nix](#without-nix)) and migrate
  `TEST_DATABASE_URL` themselves.
- `packages/*/src/*.test.ts`, `apps/electron/src/*.test.ts` and `apps/mobile/src/**/*.test.tsx`:
  next to the code they test.
- `manifests/`: the app manifests (entity kinds and their plaintext fields), compiled into the
  server and bundled by the clients; both sides test against them.
- `test-vectors/`: JSON fixtures. Conflict resolution and recovery challenges are read by both
  the Rust and the TypeScript tests, so the two sides agree; the recurrence vectors are
  TypeScript only. The merge rule exists in TypeScript
  (`packages/client-core`) and in the server's SQL fold (`crates/atlas-server/src/sync/apply.rs`). If
  you change one side of that logic, change the other and extend the vectors.

## Adding or changing UI text

All user-facing text goes through i18next. The catalogs are in `packages/shared/src/locales/`:
English (`en.json`, the base), Danish, German, Spanish, French, Italian, Dutch, Polish and
Brazilian Portuguese (`pt.json`).

1. Add the key to every catalog, at the same path. For a plural, `en.json` has `_one`/`_other`;
   each other catalog has its own language's plural forms (Polish `_one`/`_few`/`_many`/`_other`).
   If you can't write a language, add the English text to its catalog and say so in the PR.
2. Use it with `t("section.key")`.
3. Run the two checks:
   - `cd packages/shared && bunx --bun vitest run src/i18n.test.ts` checks that every locale has
     exactly the English keys, in its own plural forms, and is valid UTF-8.
   - `cd apps/mobile && bun run test -- i18n/keys` checks that every literal key the app uses
     exists in every locale.

A new language also needs an entry in `packages/shared/src/i18n.ts` and a quick-add lexicon in
`packages/shared/src/quickAddLexicons.ts` (its words for today, tomorrow, weekdays, months, "in 3
days", "every week" and times), with cases in the "every UI language" table of
`quickAddParse.test.ts`. The settings and onboarding text about smart dates quotes examples in the
language; they must parse.

## Commits and pull requests

- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix(mobile):`, `refactor(sync):`, `docs:`, … Release notes are generated from the
  commit log, so write the subject for users. The notes of each release also thank its
  contributors by name.
- Keep a PR to one change. Explain what and why, and how you tested it (platforms, screenshots
  for UI changes). The PR template has a short checklist.
- Run `lint` and `test:all` before you open the PR. CI runs the same checks.
- Add tests for new behaviour.
- Don't edit a version number. Versions move in lockstep across all manifests and only change
  in release commits.
- Don't commit secrets, keystores, `.env` files or build output (`dist-desktop/`,
  `atlas-desktop-*.tar.gz`).
- Security problems go through [SECURITY.md](./SECURITY.md), not a public issue or PR.

### Branches and releases

Work lands on the long-lived `dev` branch; open pull requests against `dev`. `main` holds stable
releases only. As a contributor that is all you need: target `dev` and follow Conventional
Commits; the rest of this section is what the maintainer does. A push to `dev` only refreshes
the moving `dev` Docker image. The maintainer tags pre-releases (`v0.1.4-rc.1`) on `dev`,
and when one is good, merges `dev` into `main` through a pull request (`main` takes no direct pushes)
and tags the stable `v0.1.4`. Pre-releases go to
GitHub as prereleases, to Docker as `0.1.4-rc.1` and `dev`, and to the Play internal track. Details
in [apps/mobile/RELEASE.md](./apps/mobile/RELEASE.md).

### What CI runs

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`. A
push to `dev` runs it for the changed paths before building the `dev` image, and a tag runs
the full suite. Pull requests from forks need no secrets, so they get the same checks:

| Check             | What it runs                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| Lint (Rust)       | `cargo fmt --check`, clippy with `-D warnings`                                |
| Lint (TypeScript) | typecheck of shared, client-core, mobile and electron; ESLint; Prettier check |
| MSRV              | `cargo check` on the minimum Rust version (1.94)                              |
| Test (Rust)       | `cargo nextest run --workspace` against PostgreSQL 16                         |
| Test (TypeScript) | vitest in client-core, shared and electron                                    |
| Test (mobile)     | jest in apps/mobile                                                           |
| Audit (Rust)      | `cargo deny check` (allowed to fail)                                          |
| Audit (JS)        | `bun audit` (allowed to fail)                                                 |

The audits are informational, so a red audit check on a pull request does not block it. A known, unfixable advisory is explained under `//audit-known`
in the root `package.json`. Fixable advisories are fixed with `overrides`, not ignored.

## Bug reports from the app

The app's _Report a problem_ screen sends a report to the server it is connected to. It shows up
in that server's admin panel, not in this repository. To report a bug in Atlas Todo itself, open
a GitHub issue.

## License

By contributing you agree that your contributions are licensed under the repository's
[AGPL-3.0-only](./LICENSE) license.
