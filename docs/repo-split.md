# Splitting the repository: core and the todo app

This repository is going to become two:

- **core**: this repository, renamed from `atlastodo/atlas-todo` to `atlastodo/atlas`. It keeps
  the sync server (`crates/atlas-server`), `crates/atlas-core`, `crates/atlas-client`, the `atlas`
  CLI (`crates/atlas-cli`), `manifests/`, `migrations/`, `packages/client-core`, `packages/shared`,
  `packages/sdk`, `test-vectors/`, `docker/`, the NixOS server module and the server, architecture
  and integration docs. Its releases carry the server image, the CLI binaries and the core package
  tarballs.
- **app**: a new `atlastodo/atlas-todo` holding the todo app (`apps/mobile`, `apps/electron`) with
  its history filtered out of this one. Its releases carry the APK/AAB, the desktop tarball and the
  web app tarball. It consumes the core JS packages as pinned versions, and the core server image
  pulls a pinned build of its web app.

This page is the inventory of every reference to the repository name, what each one becomes, and
the runbook for doing the split.

## Progress

| Step                                                  | State                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions 1–3 (Docker Hub name, NixOS names, version) | **Decided**: Docker Hub moves to `atlastodo/atlas` with the old names as aliases; `services.atlas` with `services.atlas-todo` renamed from; core keeps the current version line. See [Decisions](#decisions-for-the-repository-owner).                                                                                                                         |
| 1. Stable release before the split                    | to do                                                                                                                                                                                                                                                                                                                                                          |
| 2.1–2.3 Rename, `IMAGE_ALIASES`, GHCR package access  | to do by the owner on GitHub: rename, then set `DOCKERHUB_IMAGE=atlastodo/atlas` and `IMAGE_ALIASES=ghcr.io/atlastodo/atlas-todo docker.io/atlastodo/atlas-todo`                                                                                                                                                                                               |
| 2.4 Core rows of the inventory                        | **done**: every **core** row, plus the core copy of the **split** rows outside `apps/`. The `services.atlas` NixOS rename landed with it (`nixosModules.atlas`/`server`, the old option and module as deprecated aliases, checked by `server-module-rename-eval`), and `docs/self-hosting.md` has the [Image renamed](./self-hosting.md#image-renamed) notice. |
| 3. App repository from the filtered history           | to do                                                                                                                                                                                                                                                                                                                                                          |
| 4. App on pinned core packages                        | to do                                                                                                                                                                                                                                                                                                                                                          |
| 5. First app release                                  | to do                                                                                                                                                                                                                                                                                                                                                          |
| 6. Pin the web build in core, remove the app          | **done** (`chore/remove-app`): pinned to atlas-todo v0.1.11-rc.6, `apps/` and the app-only files removed, the image and the flake serve only the pin (the image with the app release's notices), and the core half of `apps/mobile/RELEASE.md` is now `docs/releasing.md`. See [step 6](#6-pin-the-web-build-in-core-and-remove-the-app).                      |
| 7. Deprecation period                                 | to do: announce the new names in the release notes; unset `IMAGE_ALIASES` after two stable releases; drop the NixOS aliases after that.                                                                                                                                                                                                                        |

## What is already in place

These landed before the split and work in the monorepo today:

| Piece                                  | Where                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishable core packages              | `@atlastodo/client-core`, `@atlastodo/shared`, `@atlastodo/sdk`: `dist/` (Bun ESM + tsc declarations), `test-vectors/` (copied from `test-vectors/` at build time, listed in each `package.json`'s `atlas.testVectors`), licence |
| Packing                                | `scripts/pack-core-packages.sh` (`packages:pack`), `bun pm pack` in dependency order                                                                                                                                             |
| A consumer's view, checked in CI       | `scripts/smoke-core-packages.sh` (Test (TypeScript)): tarball install with `overrides`, Node import, tsc nodenext + bundler                                                                                                      |
| Package tarballs on every release      | `release.yml` Core packages: `atlastodo-<pkg>-X.Y.Z.tgz`, published to npm when `NPM_TOKEN` is set                                                                                                                               |
| Web app tarball on every release       | `release.yml` Web app tarball: `atlas-todo-web-X.Y.Z.tar.gz` + `.sha256` (`scripts/web-release-tarball.sh`)                                                                                                                      |
| Server image from a pinned web build   | `docker/Dockerfile` reads `apps.lock.json` (or `TODO_WEB_URL` + `TODO_WEB_SHA256`); since step 6 the only way                                                                                                                    |
| Flake web-dist from a pinned web build | `flake.nix`: `web-dist` is a fixed-output fetch of the pin (`web-dist-source` was removed in step 6)                                                                                                                             |
| Writing a pin                          | `node scripts/pin-app-web.mjs <version> [--repo owner/name]` (since step 6 also the notices; no `--source`)                                                                                                                      |
| Image under its old name               | `docker.yml` `image-aliases` input / `IMAGE_ALIASES` variable (no-op while unset)                                                                                                                                                |

In this repository the packages are used unbuilt: their `exports` lead with an
`@atlastodo/source` condition pointing at `src/`. `apps/mobile` enables it in `tsconfig.json`
(`customConditions`) and `metro.config.js` (`unstable_conditionNames`); jest maps the packages
and `@atlastodo/<pkg>/test-vectors/*` to source in `moduleNameMapper`; the packages' own vitest
configs alias their siblings. The app repo drops all four (see step 4 of the runbook).

## Reference inventory

Every literal `atlastodo/atlas-todo` outside `RELEASE_NOTES.md` (which is history and stays as
is) and this page: 104 in 42 files when this was written, 49 in 24 after step 2.4 (the app rows,
the app parts of the split rows, and the notes that name the old repository on purpose: the
image alias, pre-rename attestations, the rename notice). The `n` column is the count before
step 2.4. **core** means the reference moves to
`atlastodo/atlas` (it lives in, or describes, the core repo); **app** means it stays
`atlastodo/atlas-todo` (the app repo inherits the name); **split** means the file goes to both
repos and each copy keeps its own repo name. Re-run
`git grep -n "atlastodo/atlas-todo" -- ':!RELEASE_NOTES.md'` before the split: anything new must be
classified here first.

### Runtime and build references

| File                                               | n   | Class | Change                                                                                                                                                                                 |
| -------------------------------------------------- | --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/electron/src/updater.ts`                     | 1   | app   | `DEFAULT_REPO` stays `atlastodo/atlas-todo`: installed desktops query the app repo's `releases/latest`, which must keep the `atlas-desktop-X.Y.Z.tar.gz` asset and `SHA256SUMS.txt`.   |
| `apps/mobile/src/ui/UpdateBanner.test.tsx`         | 1   | app   | none (fixture URL).                                                                                                                                                                    |
| `apps/mobile/src/ui/DesktopUpdateSection.test.tsx` | 1   | app   | none (fixture URL).                                                                                                                                                                    |
| `apps/mobile/src/screens/AboutScreen.test.tsx`     | 2   | app   | none (fixture URL). The About screen's own links come from `EXPO_PUBLIC_REPO_URL`, which the workflows derive from `github.repository`.                                                |
| `apps/electron/package.json`                       | 2   | app   | none.                                                                                                                                                                                  |
| `apps/mobile/package.json`                         | 1   | app   | none.                                                                                                                                                                                  |
| `apps/electron/README.md`                          | 2   | app   | none: the desktop flake input (`git+https://github.com/atlastodo/atlas-todo.git`, `releases/latest/download/atlas-desktop-latest.tar.gz`) keeps working once the app repo releases.    |
| `nix/packages/atlas-desktop.nix`                   | 1   | app   | moves to the app repo unchanged.                                                                                                                                                       |
| `nix/packages/web-dist.nix`                        | 1   | app   | moves to the app repo (the source build of the web app); core keeps only `web-dist-pinned.nix`.                                                                                        |
| `nix/packages/web-dist-pinned.nix`                 | 1   | app   | `homepage` names the app the asset comes from: keep. File stays in core.                                                                                                               |
| `scripts/web-release-tarball.sh`                   | 1   | app   | moves to the app repo (default `EXPO_PUBLIC_REPO_URL`).                                                                                                                                |
| `scripts/pin-app-web.mjs`                          | 2   | app   | stays in core; its default `--repo` is the app repo: keep.                                                                                                                             |
| `docker/Dockerfile`                                | 1   | core  | **Done.** `ARG REPO_URL` default → `https://github.com/atlastodo/atlas`. After the split the source stage goes (see runbook), and with it `REPO_URL`.                                  |
| `docker/docker-compose.yml`                        | 1   | core  | **Done.** `ATLAS_IMAGE` default → `ghcr.io/atlastodo/atlas:latest`.                                                                                                                    |
| `.env.example`                                     | 1   | core  | **Done.** the `ATLAS_IMAGE` example → `ghcr.io/atlastodo/atlas:latest`.                                                                                                                |
| `nix/server-module.nix`                            | 1   | core  | **Done.** `documentation` → `https://github.com/atlastodo/atlas`.                                                                                                                      |
| `nix/packages/atlas-server.nix`                    | 1   | core  | **Done.** `homepage` → core.                                                                                                                                                           |
| `Cargo.toml`                                       | 2   | core  | **Done.** `repository`, `homepage` → core.                                                                                                                                             |
| `packages/client-core/package.json`                | 3   | core  | **Done.** `homepage`, `repository.url`, `bugs.url` → core. **`repository.url` must match the publishing repo or npm refuses the provenance**: change it before the first core release. |
| `packages/shared/package.json`                     | 3   | core  | **Done.** as above.                                                                                                                                                                    |
| `packages/sdk/package.json`                        | 3   | core  | **Done.** as above.                                                                                                                                                                    |
| `package.json` (root)                              | 3   | split | **Core copy done.** core copy → core; the app repo's root `package.json` keeps `atlas-todo`.                                                                                           |
| `scripts/release-notes.sh`                         | 1   | split | **Core copy done.** the compare link: each copy names its own repo.                                                                                                                    |

### Workflows

| File                            | n   | Class | Change                                                                                                                                                                                                                                                             |
| ------------------------------- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/docker.yml`  | 4   | core  | **Done.** comments only (the image and attestation examples) → `ghcr.io/atlastodo/atlas`, `--repo atlastodo/atlas`; the alias example keeps `ghcr.io/atlastodo/atlas-todo`. The image name itself is `ghcr.io/${{ github.repository }}` and flips with the rename. |
| `.github/workflows/release.yml` | 1   | split | **Core copy done.** the attestation comment: each copy its own repo.                                                                                                                                                                                               |

The workflows otherwise derive the repository from `github.repository` (GHCR image name, OCI
`source`/`documentation` labels, `REPO_URL`, `EXPO_PUBLIC_REPO_URL`, `GH_REPO`): those follow the
rename by themselves and need no edit.

### Documentation and community files

| File                                       | n   | Class | Change                                                                                                                                                                                                                           |
| ------------------------------------------ | --- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/self-hosting.md`                     | 8   | core  | **Done**, plus the "Image renamed" notice and the `services.atlas` module. Clone URL, image names (`ghcr.io/atlastodo/atlas`, Docker Hub name per the decision below), flake input `github:atlastodo/atlas`, `REPO_URL` default. |
| `docs/integrations.md`                     | 5   | core  | **Done.** CLI download base and attestation `--repo` → core; the package tarball URLs → core.                                                                                                                                    |
| `apps/mobile/RELEASE.md`                   | 5   | split | the app repo keeps it (app releases); the core-release parts (image, packages, CLI, `NPM_TOKEN`, `DOCKERHUB_*`, `IMAGE_ALIASES`) move to a new `docs/releasing.md` in core, URLs → core. The package pin example → core URLs.    |
| `SECURITY.md`                              | 3   | split | **Core copy done** (with a note on pre-rename attestations). Advisory link per repo; attestation examples: APK → app, image → core.                                                                                              |
| `README.md`                                | 9   | split | **Core copy links done** (badges, clone, Discussions, Issues → core; the APK link stays app). Remaining: core gets a server/CLI/packages README; the app keeps the app README (badges, clone, APK link, discussions).            |
| `CONTRIBUTING.md`                          | 4   | split | **Core copy done.** each copy its own repo (discussions, labels, `upstream` remote).                                                                                                                                             |
| `ROADMAP.md`                               | 1   | split | **Core copy done.** discussions link per repo, or keep one roadmap in core and link it from the app.                                                                                                                             |
| `CODE_OF_CONDUCT.md`                       | 1   | split | **Core copy done.** reporting form per repo.                                                                                                                                                                                     |
| `ACCESSIBILITY.md`                         | 1   | app   | moves to the app repo (it is about the UI); core links to it.                                                                                                                                                                    |
| `.github/ISSUE_TEMPLATE/accessibility.yml` | 1   | app   | moves to the app repo.                                                                                                                                                                                                           |
| `.github/ISSUE_TEMPLATE/bug_report.yml`    | 1   | split | **Core copy done.** SECURITY link per repo.                                                                                                                                                                                      |
| `.github/ISSUE_TEMPLATE/config.yml`        | 2   | split | **Core copy done.** per repo.                                                                                                                                                                                                    |
| `.github/PULL_REQUEST_TEMPLATE.md`         | 1   | split | the app copy keeps the accessibility line; core drops it.                                                                                                                                                                        |
| `.github/SUPPORT.md`                       | 3   | split | **Core copy done.** per repo (server questions → core discussions, app ones → app).                                                                                                                                              |
| `site/index.html`                          | 5   | app   | the landing page and its "latest release" button stay with the app repo.                                                                                                                                                         |
| `site/privacy.html`                        | 5   | app   | the Play listing's privacy policy: app. Its "self-hosting" and SECURITY links may point to core.                                                                                                                                 |
| `site/delete-account.html`                 | 3   | app   | the Play listing's account-deletion page: app.                                                                                                                                                                                   |

Names that contain `atlas-todo` but are not the repository (the compose project `atlas-todo`, the
systemd unit and system user the NixOS module creates, `/var/lib/atlas-todo`, the module's default
`atlas-todo` database, `/usr/share/doc/atlas-todo/`, the `app://atlas-todo` origin, the
`atlas-todo-X.Y.Z.apk` asset names) are product names, not repository references. Keep them:
renaming any of them breaks existing deployments. The NixOS option and module names are the
exception (decision 2): `services.atlas` and `nixosModules.atlas`/`server` are the names now, and
`services.atlas-todo` (`mkRenamedOptionModule`, a warning) and `nixosModules.atlas-todo` (a
warning) stay as deprecated aliases, checked by the flake's `server-module-rename-eval`.

## Where workflows, secrets and variables go

| Item                                                                                                                                                            | Core (`atlastodo/atlas`)                                                                     | App (`atlastodo/atlas-todo`)                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ci.yml`                                                                                                                                                        | Lint (Rust), MSRV, Test (Rust), Test (TypeScript) for `packages/`, audits, Lint (TypeScript) | Lint (TypeScript), Test (mobile), electron tests, Audit (JS)                                               |
| `release.yml` jobs                                                                                                                                              | Prepare (no keystore check), Docker, CLI, Core packages, GitHub Release                      | Prepare (keystore check, versionCode), Android APK + AAB, Desktop tarball, Web app tarball, GitHub Release |
| `docker.yml`, `dev-image.yml`                                                                                                                                   | yes                                                                                          | no                                                                                                         |
| `android-cache.yml`, `.github/actions/android-setup`, `.github/scripts/android-gradle.sh`                                                                       | no                                                                                           | yes                                                                                                        |
| `dependabot.yml`, `dependabot-bun-nix.yml`, `pr-base.yml`, `scorecard.yml`                                                                                      | yes (Cargo, Bun, Docker, Actions)                                                            | yes (Bun, Actions)                                                                                         |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (`release` environment) | remove after the first app release                                                           | **move** (re-create in the app repo's `release` environment)                                               |
| `ATLAS_APP_ID`, `ATLAS_EAS_PROJECT_ID`, `PLAY_STORE_TRACK`, `PLAY_STORE_PRERELEASE_TRACK`, `EXPO_PUBLIC_API_URL` (variables)                                    | remove                                                                                       | **move**                                                                                                   |
| `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (secrets), `DOCKERHUB_IMAGE` (variable)                                                                                 | keep (`DOCKERHUB_IMAGE=atlastodo/atlas`)                                                     | no                                                                                                         |
| `NPM_TOKEN`                                                                                                                                                     | keep                                                                                         | no (the app publishes nothing to npm)                                                                      |
| `IMAGE_ALIASES`                                                                                                                                                 | `ghcr.io/atlastodo/atlas-todo docker.io/atlastodo/atlas-todo` for the deprecation period     | no                                                                                                         |
| Rulesets ("main: PRs only", `v*` tag protection), `release` environment limited to `v*` tags, the `dev` branch                                                  | keep                                                                                         | re-create                                                                                                  |
| GitHub Pages / `site/` deployment, the EAS project link, the Play Console listing                                                                               | no                                                                                           | yes                                                                                                        |

## Runbook

### 1. Before the split, in the monorepo

1. Ship a stable release that contains this work (`version:bump X.Y.Z`, PR `dev` → `main`, tag).
   Its GitHub Release carries the three `.tgz` files and `atlas-todo-web-X.Y.Z.tar.gz`; check
   that it also reached npm if `NPM_TOKEN` was set (`npm view @atlastodo/shared@X.Y.Z`).
2. Note that release's Android `versionCode` (`node scripts/version-code.mjs X.Y.Z`). The app
   repo's first release must be a higher version, or Play refuses the upload.
3. Transfer the app-only issues and discussions you want in the app repo later, once it exists
   (`gh issue transfer <n> atlastodo/atlas-todo`). Issues stay with the renamed repository by
   default.

### 2. Rename this repository

1. Settings → General → Repository name: `atlas`. GitHub redirects `atlastodo/atlas-todo` (web,
   git, API, release downloads) to the renamed repo **only until a repository named
   `atlastodo/atlas-todo` exists again**. Step 3 creates one, so every old URL then resolves to
   the app repo. That is what the desktop updater and the desktop flake input want; it is wrong
   for server users, hence the alias and notices below.
2. Set `DOCKERHUB_IMAGE` to `atlastodo/atlas` and the `IMAGE_ALIASES` variable to
   `ghcr.io/atlastodo/atlas-todo docker.io/atlastodo/atlas-todo` (decision 1). The next
   image push then goes to `ghcr.io/atlastodo/atlas` (a new GHCR package, created private: make it
   public under Package settings) and to the old name.
3. In the old package's settings (`ghcr.io/atlastodo/atlas-todo` → Manage Actions access), make
   sure the renamed repository has **Write**. A package created by a workflow is linked to the
   repository by id, so it usually survives the rename; verify before the first push.
4. Edit the **core** rows of the inventory: the image defaults, `Cargo.toml`, the packages'
   `homepage`/`repository`/`bugs` (required before the next npm publish with provenance), the
   docs. Commit on `dev`. **Done** (`chore/core-rename`), with the NixOS rename. Merge it right
   after the rename: its compose default and docs name `ghcr.io/atlastodo/atlas`, which exists
   from the first image push after 2.1–2.2 (the `dev` image push of the merge itself).

### 3. Create the app repository from this history

On a fresh mirror clone (never in a working checkout):

```sh
git clone --mirror https://github.com/atlastodo/atlas.git atlas-todo-app.git
cd atlas-todo-app.git
git filter-repo \
  --path apps/mobile --path apps/electron \
  --path site \
  --path docs/android-permissions.md --path docs/screenshots \
  --path ACCESSIBILITY.md --path .github/ISSUE_TEMPLATE/accessibility.yml \
  --path .github/actions/android-setup --path .github/scripts/android-gradle.sh \
  --path .github/workflows/android-cache.yml \
  --path nix/packages/atlas-desktop.nix --path nix/packages/web-dist.nix \
  --path nix/packages/js-source.nix \
  --path nix/desktop-nixos-module.nix --path nix/desktop-home-manager-module.nix \
  --path nix/flake.desktop.nix --path nix/flake.desktop.lock \
  --path scripts/package-desktop.sh --path scripts/screenshots.mjs \
  --path scripts/version-code.mjs --path scripts/web-release-tarball.sh \
  --path LICENSE --path .prettierrc.json --path .prettierignore --path eslint.config.mjs \
  --path bunfig.toml
```

Then create the empty `atlastodo/atlas-todo` (no README), push the filtered history
(`git push --mirror` drops `refs/pull/*` on its own; push only `main`, `dev` and the tags you want
to keep: old `v*` tags are fine, they keep pointing at the app's part of each release), and add on
top, as new commits:

- a root `package.json` (`workspaces: ["apps/*"]`, the same `overrides`), `README.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `devenv.nix` (the JS half of today's),
  `flake.nix` (the desktop half: `atlas-desktop`, `web-dist`, the desktop modules), copies of
  `scripts/third-party-licenses.mjs`, `scripts/bump-version.sh` and `scripts/release-notes.sh`
  without the Cargo parts;
- `ci.yml` and `release.yml` with the app jobs from the table above (the Web app tarball job
  unchanged), `dependabot.yml` for Bun and Actions.

### 4. Point the app at pinned core packages

In `apps/mobile/package.json` replace `"workspace:*"` with the core release's tarball URLs
(or npm versions once published), with `overrides` at the root for the siblings, as
`apps/mobile/RELEASE.md` (Pinning the core packages by release URL) shows. Then:

- `apps/mobile/tsconfig.json`: `customConditions` back to `["react-native"]`.
- `apps/mobile/metro.config.js`: drop the `@atlastodo/source` condition and the workspace-root
  watch folder if nothing else needs it.
- `apps/mobile/jest.config.js`: drop the three `@atlastodo/*` `moduleNameMapper` entries (the
  `test-vectors/*` ones then resolve inside the installed package), and add `@atlastodo` to the
  `transformIgnorePatterns` allowlist so jest transforms the packages' ESM `dist/`.
- `bun install`, `nix:bun-lock`, then the app's full suite and a web export.

Upgrading core later is a version (or URL) bump of the three entries, nothing else.

### 5. First app release

Bump the app to a version above the last monorepo release (step 1.2), tag it in the app repo. Its
release must carry `atlas-desktop-X.Y.Z.tar.gz`, `atlas-desktop-latest.tar.gz` (stable),
`SHA256SUMS.txt` (the desktop updater verifies with it), the APK/AAB and
`atlas-todo-web-X.Y.Z.tar.gz` + `.sha256`. Until it exists, installed desktops find no update
and the desktop flake's `releases/latest` URL is a 404: cut it right after step 3.

### 6. Pin the web build in core and remove the app

In core, on `dev`:

1. `node scripts/pin-app-web.mjs X.Y.Z` (the app release), review `apps.lock.json`, commit.
   The next image and the flake's `web-dist` now serve that build; `docker.yml` passes the pin.
2. Remove `apps/`, the app-only files from step 3, the `web-source` stage of `docker/Dockerfile`
   (make `TODO_WEB_FROM=release` the only path and drop `REPO_URL`), the source build from
   `flake.nix` (`web-dist-source`, `atlas-desktop`, the desktop modules), the mobile/electron
   jobs of `ci.yml` and the Android/desktop/web jobs of `release.yml` (and the keystore check in
   Prepare), `app.json` and the versionCode check from `scripts/bump-version.sh`, and the app
   entries of `scripts/third-party-licenses.mjs`. The image's third-party notices then cover the
   server and the core packages; the web app's notices come from the app release
   (`THIRD_PARTY_NOTICES.txt` there) — ship that file into the image next to the web build, or
   link it from the core notices.
3. `bun install`, `nix:bun-lock`, `test:all`, `lint`, `nix flake check`.

How it was done (`chore/remove-app`):

- The pin also records the app release's `THIRD_PARTY_NOTICES.txt` (URL and SHA-256, both checked
  against that release's `SHA256SUMS.txt` by `pin-app-web.mjs`). The Dockerfile's web stage
  downloads and checks both and ships the notices as
  `/usr/share/doc/atlas-todo/web/THIRD_PARTY_NOTICES.txt`; the core notices name that file. That
  keeps the web app's licences inside every image (a local build included), not only behind a
  link.
- The Dockerfile reads `apps.lock.json` itself, so `docker.yml` passes no build args and a plain
  `docker build -f docker/Dockerfile .` serves the pin. `TODO_WEB_FROM`, `REPO_URL`,
  `PUBLIC_API_URL` and `BUN_VERSION` are gone; `TODO_WEB_URL`/`TODO_WEB_SHA256` (and the
  optional `TODO_WEB_NOTICES_*`) serve another build.
- `nixosModules.default` is the server module alone (it used to add the desktop module);
  `nixosModules.desktop`/`atlas-desktop`, `homeManagerModules` and `packages.atlas-desktop` are
  gone from core, as is `web-dist-source`. The `bun2nix` input and `nix/bun.nix` stay, unused by
  any build, so existing `follows` overrides keep evaluating.
- The root `overrides` and `//audit-known` only concerned the app's tooling and went with it.

### 7. Deprecation period

- Keep `IMAGE_ALIASES` for at least two stable releases; announce the new image name in both
  repos' release notes and in `docs/self-hosting.md`, then unset it. Pulls of the old name keep
  the last pushed tags forever; only new tags stop.
- Server Nix users have `github:atlastodo/atlas-todo` as an input, which after step 3 is the app
  repo: tell them to switch to `github:atlastodo/atlas` (`docs/self-hosting.md`, Image renamed,
  says so) and to `services.atlas`. Optionally, the app repo's flake can re-export
  `nixosModules.server` from a core input for one release with a deprecation warning. After the
  deprecation period, drop the `services.atlas-todo` rename and `nixosModules.atlas-todo` (and
  the `server-module-rename-eval` check) from core.

## Decisions for the repository owner

1. **Docker Hub name** (decided): `DOCKERHUB_IMAGE=atlastodo/atlas`, with
   `ghcr.io/atlastodo/atlas-todo docker.io/atlastodo/atlas-todo` in `IMAGE_ALIASES`, so the old
   names keep getting the same tags for the deprecation period.
2. **NixOS option names** (decided, done): `services.atlas`, exported as `nixosModules.atlas` and
   `nixosModules.server`; `services.atlas-todo` forwards to it through `mkRenamedOptionModule`
   (a warning) and `nixosModules.atlas-todo` is a deprecated alias (a warning). The unit, user,
   data directory and database keep their `atlas-todo` names. The VM test uses the new name.
3. **Version lines** (decided for core): core keeps the current version line. Still open: whether
   the app keeps the shared version line (its first release must exceed the last monorepo
   versionCode either way).
4. **Old releases**: the existing `v*` releases (with APKs and desktop tarballs) stay with the
   renamed core repo. Decide whether to leave them there, or re-upload the last one to the app
   repo so `releases/latest` there has something on day one.
5. **Issues, discussions, Pages, Scorecard badge**: which move to the app repo; the landing page
   (`site/`) and the Play listing URLs (privacy, account deletion) should be served from wherever
   Pages runs, under a custom domain so a later move does not change them.
6. **Web build in the image**: the pinned asset is built with `EXPO_PUBLIC_API_URL=/api`, like the
   image's own build. A self-hoster who needs another value builds the image from the app source
   instead (`TODO_WEB_FROM=source` while it exists here; later from the app repo).
