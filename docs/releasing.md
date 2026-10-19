# Releasing Atlas core

A core release carries the server image, the static `atlas` CLI binaries and the core JS packages
(`@atlastodo/client-core`, `@atlastodo/shared`, `@atlastodo/sdk`). The todo app (Android, desktop
and the web app tarball) is released from its own repository,
[atlastodo/atlas-todo](https://github.com/atlastodo/atlas-todo); the server image serves a pinned
release of its web build (see [Pinning the web app](#pinning-the-web-app)).

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
  attestation. The image's web app is the `todo` pin in `apps.lock.json`, which
  `docker/Dockerfile` downloads and checks against its SHA-256.
- **CLI**: the `atlas` binary (`crates/atlas-cli`), one per target, as `atlas-X.Y.Z-<target>`,
  and the SecretSpec provider (`crates/atlas-secretspec`) next to it as
  `secretspec-provider-atlas-X.Y.Z-<target>`. Linux x86_64 and aarch64 build against musl with `cargo zigbuild` (zig from PyPI's `ziglang`),
  so the binaries are static and run on Alpine; each is checked to be statically linked, and the
  x86_64 one to print the tag's version. macOS (`aarch64-apple-darwin`, `x86_64-apple-darwin`)
  and Windows (`x86_64-pc-windows-msvc`, static CRT) build on their own hosted runners once the
  repository is public, where those minutes are free.
- **Core packages**: `scripts/pack-core-packages.sh` builds the three packages (Bun-bundled ESM in
  `dist/`, tsc declarations, the test vectors they ship) and packs them with `bun pm pack` as
  `atlastodo-client-core-X.Y.Z.tgz`, `atlastodo-shared-X.Y.Z.tgz` and `atlastodo-sdk-X.Y.Z.tgz`.
  Never `npm pack`: only Bun rewrites the `workspace:*` dependencies between them to the release
  version.
- **GitHub Release**: creates the release, or updates it on a re-run, with the CLI binaries, the
  package tarballs, `THIRD_PARTY_NOTICES.txt` and `SHA256SUMS.txt`, and a build provenance
  attestation for the binaries and the packages (`gh attestation verify <file> --repo atlastodo/atlas`).
- **npm publish**: after the GitHub Release, publishes the same tarballs to npm in dependency
  order, with trusted publishing when the `NPM_TRUSTED_PUBLISHING` variable is `true`, else with
  the `NPM_TOKEN` secret; neither set skips it. A version already on npm is skipped, and a refused
  publish never holds back the release: re-run that job once fixed. Provenance is attached from a
  public repository only, and needs each package's `repository.url` to name the repository the
  release runs in.

A tag that contains `-` (`v0.1.4-rc.1`) is a prerelease: the GitHub Release is marked prerelease
and never "latest", the image gets only `0.1.4-rc.1` (never `latest`, on Docker Hub too), and npm
gets the `next` dist-tag.

**Third-party notices**: `scripts/third-party-licenses.mjs` lists the licences of the Rust crates
the server and the CLI ship and of the core packages' JS dependencies. The image carries it as
`/usr/share/doc/atlas-todo/THIRD_PARTY_NOTICES.txt` and the release attaches it. The web app's
own notices come from its release (`THIRD_PARTY_NOTICES.txt` there, pinned with the web build):
the image carries them as `/usr/share/doc/atlas-todo/web/THIRD_PARTY_NOTICES.txt`. `lint` and CI
fail when a shipped JS package has a licence outside the allow-list.

**GHCR visibility**: the first push to GHCR creates the package as private, so `docker pull` needs
a login until it is made public (Package settings → Danger Zone → Change visibility). That cannot
be undone, and it publishes every tag, including the `buildcache-*` tags, which hold the source
tree. To check the package from the CLI, first run
`gh auth refresh -s read:packages,write:packages`. With `DOCKERHUB_IMAGE` and the two
`DOCKERHUB_*` secrets set, the same tags also go to Docker Hub, but only from a public
repository, because Docker Hub creates a new repository as public.

## Secrets and variables

Set these under Settings → Secrets and variables → Actions. `GITHUB_TOKEN` is provided
automatically and is used for GHCR and the release. A ruleset keeps `v*` tags from being moved or
deleted, and the `release` environment is limited to `v*` tags.

| Secret               | Required | What it is                                                                                                                |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DOCKERHUB_USERNAME` | no       | the Docker Hub user for the mirror (see `DOCKERHUB_IMAGE`)                                                                |
| `DOCKERHUB_TOKEN`    | no       | a Docker Hub access token with Read & Write scope                                                                         |
| `NPM_TOKEN`          | no       | a granular npm publish token for the `@atlastodo` scope that bypasses 2FA; unused when `NPM_TRUSTED_PUBLISHING` is `true` |

The `DOCKERHUB_*` secrets stay repository secrets, since the `dev` image pushes use them.

| Variable                 | Default | What it does                                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `DOCKERHUB_IMAGE`        | unset   | also push the server image to Docker Hub as this name, e.g. `atlastodo/atlas`               |
| `IMAGE_ALIASES`          | unset   | more names for the server image (`ghcr.io/…` or `docker.io/…`, space-separated)             |
| `NPM_TRUSTED_PUBLISHING` | unset   | `true`: publish the core packages with npm trusted publishing (OIDC) instead of `NPM_TOKEN` |

The app's signing and store secrets (`ANDROID_*`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) and
variables (`ATLAS_APP_ID`, `ATLAS_EAS_PROJECT_ID`, `PLAY_STORE_TRACK`,
`PLAY_STORE_PRERELEASE_TRACK`, `EXPO_PUBLIC_API_URL`) belong to atlastodo/atlas-todo; core no
longer reads them.

## Pinning the web app

The server image and the flake's `web-dist` serve a released web build of the todo app, never a
build from source. The pin is the `todo` entry of `apps.lock.json`: the version, the URL and
SHA-256 of `atlas-todo-web-X.Y.Z.tar.gz`, and the same for that release's
`THIRD_PARTY_NOTICES.txt`. To move it to a new app release:

```sh
node scripts/pin-app-web.mjs X.Y.Z    # downloads both, checks them against its SHA256SUMS.txt
```

Review the `apps.lock.json` diff and commit it (`chore: pin the todo web build to atlas-todo
vX.Y.Z`). The next image (the `dev` tag on a push to `dev`) and `nix build .#web-dist` then serve
that build. The asset is built with `EXPO_PUBLIC_API_URL=/api`, the path the server serves its API
on, so it works on any origin the server runs at.

## Pinning the core packages by release URL

Until a release has published the core packages to npm (or for a version npm lacks), another
repository pins them to a release's tarballs instead. Each package depends on its siblings at the
exact release version, which npm cannot resolve yet, so the siblings are pinned through
`overrides` as well:

```json
{
  "dependencies": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz",
    "@atlastodo/shared": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-shared-X.Y.Z.tgz"
  },
  "overrides": {
    "@atlastodo/client-core": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-client-core-X.Y.Z.tgz",
    "@atlastodo/shared": "https://github.com/atlastodo/atlas/releases/download/vX.Y.Z/atlastodo-shared-X.Y.Z.tgz"
  }
}
```

(`@atlastodo/sdk` the same way.) The lockfile records each tarball's integrity hash, so a
re-uploaded asset fails the install instead of slipping in. Once the packages are on npm, replace
both blocks with plain versions (`"@atlastodo/shared": "X.Y.Z"`) and drop the overrides.

A consumer imports the built `dist/` (ESM, declarations for `moduleResolution` `bundler`, `node16`
and `nodenext`) and can assert the shipped fixtures, e.g.
`require("@atlastodo/client-core/test-vectors/password_kdf_vectors.json")`. Inside this repository
the packages are used unbuilt: their `exports` lead with an `@atlastodo/source` condition (their
`src/`), which the packages' `vitest.config.ts` aliases follow. `scripts/smoke-core-packages.sh`
(in CI's Test (TypeScript)) installs the packed tarballs into a scratch project as a consumer would
and checks them; locally, `packages:pack` writes them to `dist-packages/`.

## Releasing from a fork

The image goes to `ghcr.io/<your account>/<repo>` and the release to your repository without any
setting. Leave `DOCKERHUB_IMAGE`, `NPM_TOKEN` and `NPM_TRUSTED_PUBLISHING` unset unless you
publish under your own names; the packages' `repository.url` must name your repository for npm
provenance.
