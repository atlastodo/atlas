# Releasing Atlas core

A core release carries the server image and the core JS packages (`@atlastodo/client-core`,
`@atlastodo/sdk`). The apps are released from their own repositories: the todo app (Android,
desktop, the web app tarball and the `atlas-todo` CLI) from
[atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo), the `atlas-journal` CLI from
[atlastodo/atlas-journal](https://github.com/atlastodo/atlas-journal), the `atlas-vault` CLI and
`secretspec-provider-atlas` from [atlastodo/atlas-vault](https://github.com/atlastodo/atlas-vault);
each builds on a core release (its npm packages and its `atlas-client` crate by tag). The server
image serves a pinned release of the todo web build (see [Pinning the web app](#pinning-the-web-app)).
Up to 0.1.15 a core release also carried the `atlas` CLI, the SecretSpec provider and
`@atlastodo/shared`.

## Versioning

Versions are lockstep across every manifest: the root `package.json`, each `packages/*`
`package.json`, `bun.lock`, `Cargo.toml` and `Cargo.lock`. Never hand-edit one. Run
`version:bump <x.y.z|x.y.z-rc.N|patch|minor|major>` in `devenv shell` (`scripts/bump-version.sh`):
it rewrites them all, verifies they agree, regenerates `nix/bun.nix` and, when the version
changes, `RELEASE_NOTES.md` (`--no-notes` skips that). Re-running it with the current version only
verifies. Only `X.Y.Z` and `X.Y.Z-rc.N` are accepted, and `patch|minor|major` need a stable
current version.

A stable release's notes list the commits since the last stable tag, so they carry what its rcs
did; an rc lists the commits since the last tag of any kind. Review them in the diff: they become
the GitHub Release notes.

## Cutting a release

Work lands on the long-lived `dev` branch; `main` is stable-only and takes pull requests alone
(merge commits, CI must pass, no bypass).

**Pre-release**, tagged by hand on `dev`:

1. `version:bump 0.1.4-rc.1` (then `-rc.2`, and so on).
2. Commit as `chore(release): v0.1.4-rc.1`, `git tag v0.1.4-rc.1`, `git push origin dev v0.1.4-rc.1`.

**Stable**:

1. On `dev`, `version:bump 0.1.4` and commit `chore(release): v0.1.4`.
2. Open a PR from `dev` to `main` and merge it.
3. `git tag v0.1.4` on the merged `main` and push the tag.
4. Fast-forward `dev` to `main`: `git checkout dev && git merge --ff-only origin/main && git push`.

The moving `dev` Docker tag is not tied to rcs: every push to `dev` runs CI for the changed paths
and, if it passes, publishes the image as `dev` (`dev-image.yml`). Release commits and docs-only
pushes are skipped. There is no dev server; hosted instances stay on stable releases.

## What the release workflow does

A `v*` tag runs `.github/workflows/release.yml`:

- **CI**: the full lint and test suite (`ci.yml`).
- **Prepare**: checks that the tag equals the `package.json` version and takes the `## vX.Y.Z`
  section of `RELEASE_NOTES.md` as the release notes. It runs in the `release` environment, so
  that environment's protection rules gate the release.
- **Docker** (`docker.yml`, shared with `dev-image.yml`): the third-party notices, then the server
  image per architecture (linux/amd64, plus linux/arm64 once the repository is public, since
  GitHub's arm64 runners are free only there), each pushed by digest with its build cache in a
  `buildcache-<arch>` tag, then merged into the multi-arch `ghcr.io/<owner>/<repo>` with the
  tags `X.Y.Z`, `X.Y` and `latest`, an SBOM, BuildKit provenance and a GitHub build provenance
  attestation. The image is the server alone; the todo app's repository publishes
  `ghcr.io/atlastodo/atlas-todo` on top of it, pinned to a core release.
- **Core packages**: `scripts/pack-core-packages.sh` builds the two packages (Bun-bundled ESM in
  `dist/`, tsc declarations, the test vectors they ship) and packs them with `bun pm pack` as
  `atlastodo-client-core-X.Y.Z.tgz` and `atlastodo-sdk-X.Y.Z.tgz`.
  Never `npm pack`: only Bun rewrites the `workspace:*` dependencies between them to the release
  version.
- **GitHub Release**: creates the release, or updates it on a re-run, with the package tarballs, `THIRD_PARTY_NOTICES.txt` and `SHA256SUMS.txt`, and a build provenance
  attestation for the binaries and the packages (`gh attestation verify <file> --repo atlastodo/atlas`).
- **npm publish**: after the GitHub Release, publishes the same tarballs to npm in dependency
  order, with trusted publishing when the `NPM_TRUSTED_PUBLISHING` variable is `true`, else with
  the `NPM_TOKEN` secret; neither set skips it. A version already on npm is skipped, and a refused
  publish never holds back the release: re-run that job once fixed. Provenance is attached from a
  public repository only, and needs each package's `repository.url` to name the repository the
  release runs in.

A tag that contains `-` (`v0.1.4-rc.1`) is a prerelease: the GitHub Release is marked prerelease
and never "latest", the image gets only `0.1.4-rc.1` (never `latest`), and npm
gets the `next` dist-tag.

**Third-party notices**: `scripts/third-party-licenses.mjs` lists the licences of the Rust crates
the server ships and of the core packages' JS dependencies. The image carries it as
`/usr/share/doc/atlas/THIRD_PARTY_NOTICES.txt` and the release attaches it. `lint` and CI
fail when a shipped JS package has a licence outside the allow-list.

**GHCR visibility**: the first push to GHCR creates the package as private, so `docker pull` needs
a login until it is made public (Package settings → Danger Zone → Change visibility). That cannot
be undone, and it publishes every tag, including the `buildcache-*` tags, which hold the source
tree. To check the package from the CLI, first run
`gh auth refresh -s read:packages,write:packages`. Images go to GHCR only; the Docker Hub mirror
(`atlastodo/atlas`) and the `ghcr.io/atlastodo/atlas-todo` alias were dropped after 0.1.16 (the
alias name now belongs to the todo app's image).

## Secrets and variables

Set these under Settings → Secrets and variables → Actions. `GITHUB_TOKEN` is provided
automatically and is used for GHCR and the release. A ruleset keeps `v*` tags from being moved or
deleted, and the `release` environment is limited to `v*` tags.

| Secret      | Required | What it is                                                                                                                |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | no       | a granular npm publish token for the `@atlastodo` scope that bypasses 2FA; unused when `NPM_TRUSTED_PUBLISHING` is `true` |

| Variable                 | Default | What it does                                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `NPM_TRUSTED_PUBLISHING` | unset   | `true`: publish the core packages with npm trusted publishing (OIDC) instead of `NPM_TOKEN` |

The app's signing and store secrets (`ANDROID_*`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) and
variables (`ATLAS_APP_ID`, `ATLAS_EAS_PROJECT_ID`, `PLAY_STORE_TRACK`,
`PLAY_STORE_PRERELEASE_TRACK`, `EXPO_PUBLIC_API_URL`) belong to atlastodo/atlas-todo; core no
longer reads them.

## The apps

Core pins nothing of the apps and builds none of them. Each app pins a core release (its
`@atlastodo/*` packages, the `atlas-client` git tag and, for the todo app, the base of its image)
and moves it with its `deps:update`; a core release reaches an app through that.

## Pinning the core packages by release URL

Until a release has published the core packages to npm (or for a version npm lacks), another
repository pins them to a release's tarballs instead. The SDK depends on client-core at the exact
release version, which npm cannot resolve yet, so client-core is pinned through `overrides` as
well:

```json
{
  "dependencies": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz",
    "@atlastodo/sdk": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-sdk-X.Y.Z.tgz"
  },
  "overrides": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz"
  }
}
```

The lockfile records each tarball's integrity hash, so a re-uploaded asset fails the install
instead of slipping in. Once the packages are on npm, replace both blocks with plain versions
(`"@atlastodo/sdk": "X.Y.Z"`) and drop the overrides.

A consumer imports the built `dist/` (ESM, declarations for `moduleResolution` `bundler`, `node16`
and `nodenext`) and can assert the shipped fixtures, e.g.
`require("@atlastodo/client-core/test-vectors/password_kdf_vectors.json")`. Inside this repository
the packages are used unbuilt: their `exports` lead with an `@atlastodo/source` condition (their
`src/`), which the packages' `vitest.config.ts` aliases follow. `scripts/smoke-core-packages.sh`
(in CI's Test (TypeScript)) installs the packed tarballs into a scratch project as a consumer would
and checks them; locally, `packages:pack` writes them to `dist-packages/`.

## Releasing from a fork

The image goes to `ghcr.io/<your account>/<repo>` and the release to your repository without any
setting. Leave `NPM_TOKEN` and `NPM_TRUSTED_PUBLISHING` unset unless you
publish under your own names; the packages' `repository.url` must name your repository for npm
provenance.
