# Releasing the Atlas Todo mobile app

How to get `apps/mobile` onto a phone from a Linux machine, without a Mac. Compiling happens on
Expo's cloud builders (EAS). This repo only holds the config.

Since Expo SDK 57 (v0.15.0), the App Store build of Expo Go can no longer open this app on an
iPhone, because the app targets a newer SDK. On iOS you now need an EAS development build, which
needs an Apple Developer account. On Android you can use an EAS development build APK or the web
export in a browser, and Expo Go still works if its Play Store build is on SDK 57 or later.

## Ways to run the app

| Way               | Needs                                  | Good for                                       |
| ----------------- | -------------------------------------- | ---------------------------------------------- |
| Web export        | nothing (`web:dev`, open the browser)  | the fastest loop for anything not device-bound |
| Development build | EAS account; iOS also needs Apple      | the on-device loop now that Expo Go can't      |
| Preview build     | EAS account; iOS also needs Apple      | handing an installable app to a tester         |
| Production build  | EAS, plus Apple ($99/yr) or Play ($25) | App Store, TestFlight or Play                  |

EAS removes the need for a Mac, not for an Apple Developer account. Any build that installs on
an iPhone must be signed by one. Android needs only a one-off $25 Play Console fee to publish,
and a raw APK needs nothing.

## First-run setup

1. Expo account and project id. The maintainer's project id `a1ae13e9-8e40-4624-bed9-5550cfe4ac1a`
   is the default in `app.json`. A fork sets its own with `ATLAS_EAS_PROJECT_ID`, which
   `app.config.ts` reads (see [Releasing from a fork](#releasing-from-a-fork)). Authenticate
   with `bunx eas-cli@latest login`.
2. Android credentials. Let EAS generate and store the keystore; `eas build` offers this on the
   first Android build. It is the release signing key, and if it is lost no future build can
   update an installed app. `eas credentials` can export a backup.
3. iOS credentials, once you have an Apple Developer account. `eas build --platform ios` asks for
   the Apple ID and creates the certificate and provisioning profile in the cloud. For an
   internal iOS build, register each test device's UDID first: `bunx eas-cli device:create`
   prints a QR code the phone enrolls through.

## Building and installing on Android

From the repository root (or in `apps/mobile`):

```sh
build:android        # via devenv (or: bunx eas-cli build --profile preview --platform android)
```

1. EAS builds the `.apk` on its servers. The CLI prints a build page URL to follow progress.
2. When it finishes, EAS prints an install URL and QR code. Scan it, or open the link in Chrome
   on the phone.
3. Open the downloaded `.apk`. If Android says the phone is not allowed to install unknown apps
   from this source, tap Settings, turn on "Allow from this source", then tap Install.
4. For JS and styling changes you don't need a reinstall. Publish an over-the-air update and the
   app pulls it the next time it opens:

   ```sh
   update:android     # via devenv (or: bunx eas-cli update --channel preview --platform android)
   ```

## All build commands

Run from the root via `devenv`, or from `apps/mobile`:

```sh
build:android                                              # Android preview APK
build:android:aab                                          # Android production .aab, built locally, for Play
bundle:android:release                                     # Android production .aab via local Gradle
build:ios                                                  # iOS ad-hoc .ipa (needs Apple + a registered UDID)
bunx eas-cli build --profile production --platform all     # .aab for Play and a store .ipa (EAS cloud)
```

The profiles in `eas.json`:

- `development`: a dev client (`developmentClient: true`), for when a native module that Expo Go
  doesn't ship is added.
- `preview`: internal distribution. An install-from-URL APK on Android, an ad-hoc `.ipa` on iOS.
  Use it to send a tester a build.
- `production`: an `.aab` for Play and a store-signed build for App Store Connect.

## Submitting

```sh
bunx eas-cli submit --profile production --platform ios       # App Store Connect / TestFlight
bunx eas-cli submit --profile production --platform android   # Play internal track
```

TestFlight is where an iOS build goes for real-device testing without a public release. The
Android equivalent configured here is Play's internal track (`submit.production.android.track`).

Android submission needs a Google service-account key (`serviceAccountKeyPath`). iOS submission
asks for the Apple ID, or takes `appleId`, `ascAppId` and `appleTeamId`. Neither is in `eas.json`
because neither account exists yet, and a service-account key must never be committed.

### iOS export compliance

`app.json` declares `ITSAppUsesNonExemptEncryption: true`. The app ships its own end-to-end
encryption (AES-256-GCM, X25519 and the key derivation described in
[SECURITY.md](../../SECURITY.md)), which goes beyond the HTTPS the declaration's exemption
covers. App Store Connect therefore asks its export-compliance questions for the build, and
TestFlight holds it until they are answered.

Whoever publishes an iOS build has to answer them truthfully and may need a US export
classification first, typically the mass-market exemption (ECCN 5D992, License Exception ENC).
That comes with an annual self-classification report to the US Bureau of Industry and Security.
Once Apple accepts the documentation, its compliance code can go in `ios.infoPlist` as
`ITSEncryptionExportComplianceCode` so later builds skip the questions.

This is a legal step, not a code change, and it rests with the publisher. Check the current rules,
and those of any country the app is distributed in, rather than relying on this page.

## Versioning

`eas.json` sets `appVersionSource: "local"`, so `app.json` is the source of truth for the
version. A release bumps `expo.version` in lockstep across all manifests: `package.json`,
`apps/mobile/package.json`, `apps/electron/package.json`, `packages/client-core/package.json`,
`packages/shared/package.json`, `apps/mobile/app.json`, `bun.lock`, `Cargo.toml` and
`Cargo.lock`.

Use `scripts/bump-version.sh` (or `version:bump <version>` in `devenv`). It updates every
manifest and sets `android.versionCode` in `app.json`.

The versionCode is derived from the version by `scripts/version-code.mjs`, not incremented:
`major*1000000 + minor*10000 + patch*100 + slot`, where slot is `N` for `X.Y.Z-rc.N` (1 to 98)
and 99 for the stable `X.Y.Z`. Play rejects a code that is equal to or lower than one already
uploaded, and this keeps rc and stable builds in order: `0.1.4-rc.1` is 10401, `0.1.4-rc.2` is
10402, `0.1.4` is 10499, `0.1.5-rc.1` is 10501 (minor and patch must stay below 100). v0.1.3 and
older used +1 codes (81 for v0.1.3), far below the new range. The release workflow's Prepare job
re-derives the code and fails if `app.json` disagrees.

A pre-release version (`0.1.4-rc.1`) is also the Android `versionName`, which accepts any string.
iOS has no separate marketing version in Expo, so an iOS build of an rc would carry the rc string
and App Store Connect wants `X.Y.Z`. No iOS build is published, so cut iOS builds from stable
versions.

Stores reject duplicate build numbers. To re-submit an already uploaded version without bumping
the SemVer, bump `ios.buildNumber` or `android.versionCode` in `app.json` by hand (the next
`version:bump` resets it to the derived value).

## Releases on GitHub (CI)

The published Android build is made by GitHub Actions, not EAS. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`:

1. Run `version:bump <x.y.z|patch|minor|major>` in `devenv shell`. Review the diff, including the
   regenerated `RELEASE_NOTES.md`.
2. Commit as `chore(release): vX.Y.Z`, then `git tag vX.Y.Z` and `git push origin main vX.Y.Z`.

### Pre-releases (the `dev` branch)

Work lands on the long-lived `dev` branch. A plain push runs no CI and publishes nothing; the rc
tag runs the full suite before anything is built. To cut a pre-release, tag by hand on `dev`:

1. `version:bump 0.1.4-rc.1` (then `0.1.4-rc.2`, and so on). `RELEASE_NOTES.md` lists the commits
   since the previous tag of any kind.
2. Commit as `chore(release): v0.1.4-rc.1`, `git tag v0.1.4-rc.1`, `git push origin dev v0.1.4-rc.1`.

The same workflow runs, and the `-` in the tag makes it a prerelease: the GitHub Release is marked
prerelease and is not "latest"; the Docker image gets `0.1.4-rc.1`, never `latest` (Docker Hub
included); the AAB goes to the Play **internal** track, with the APK on the
GitHub prerelease; the desktop tarball is attached without the `-latest` copy. There is no dev
server. Hosted instances stay on stable releases.

The moving `dev` Docker tag is not tied to rcs: every push to the `dev` branch runs CI for the
changed paths and, if it passes, publishes the image as `dev` (`dev-image.yml`). Release commits
and docs-only pushes are skipped.

To ship: `main` only accepts pull requests (merge commits, CI must pass, no bypass). On `dev`, run
`version:bump 0.1.4` and commit `chore(release): v0.1.4`; open a PR from `dev` to `main` and merge
it; then `git tag v0.1.4` on the merged `main` and push the tag; finally fast-forward `dev` to `main`
(`git checkout dev && git merge --ff-only origin/main && git push`). The stable notes list everything since the last stable tag,
so they include what the rcs carried. Two release runs that overlap race at the Play upload (the
lower versionCode is refused once the higher one is on the track), so let one finish first.

The workflow then runs these jobs:

- CI: the full lint and test suite (`ci.yml`).
- Prepare: checks that the tag equals the `package.json` version, takes the `## vX.Y.Z` section
  of `RELEASE_NOTES.md` as the release notes, and fails early if any of the four keystore secrets
  is missing. There is no unsigned fallback.
- Docker image: builds the server image per architecture (linux/amd64, plus linux/arm64 once the
  repository is public, since GitHub's arm64 runners are free only for public repositories) and
  pushes `ghcr.io/<owner>/<repo>` as one multi-arch image with the tags `X.Y.Z`, `X.Y` and
  `latest`. Each architecture keeps its build cache in a `buildcache-<arch>` tag.
- Android APK + AAB: `expo prebuild --platform android --clean`, then Gradle
  `assembleRelease bundleRelease`, both signed with the upload key. The job checks that both
  files carry the upload key's SHA-256 fingerprint. If a Play service account is set, it uploads
  the AAB with `scripts/upload-play-store.mjs`.
- Desktop tarball: `scripts/package-desktop.sh X.Y.Z`.
- GitHub Release: creates the release, or updates it on a re-run, with `atlas-todo-X.Y.Z.apk`,
  `atlas-todo-X.Y.Z.aab`, `atlas-desktop-X.Y.Z.tar.gz`, `atlas-desktop-latest.tar.gz` and
  `SHA256SUMS.txt`.

A tag that contains `-` (for example `v1.0.0-rc.1`) becomes a prerelease and does not move the
Docker `latest` tag (see above). The first push to GHCR creates the package as private, so `docker pull` needs
a login until you make it public: Package settings → Danger Zone → Change visibility. That cannot
be undone, and it publishes every tag, including the `buildcache-*` tags, which hold the source
tree. To check the package from the CLI, first run
`gh auth refresh -s read:packages,write:packages`. A fork does the same for its own package.
With `DOCKERHUB_IMAGE` and the two `DOCKERHUB_*` secrets set, the same tags also go to Docker
Hub, but only from a public repository, because Docker Hub creates a new repository as public.

### Secrets

Set these under Settings → Secrets and variables → Actions.

| Secret                             | Required | What it is                                                              |
| ---------------------------------- | -------- | ----------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`          | yes      | the upload keystore (JKS or PKCS12), base64: `base64 -w0 upload.jks`    |
| `ANDROID_KEYSTORE_PASSWORD`        | yes      | the keystore password                                                   |
| `ANDROID_KEY_ALIAS`                | yes      | the key alias                                                           |
| `ANDROID_KEY_PASSWORD`             | yes      | the key password                                                        |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | no       | a Play service-account JSON key; when unset, the Play upload is skipped |
| `DOCKERHUB_USERNAME`               | no       | the Docker Hub user for the mirror (see `DOCKERHUB_IMAGE`)              |
| `DOCKERHUB_TOKEN`                  | no       | a Docker Hub access token with Read & Write scope                       |

`GITHUB_TOKEN` is provided automatically and is used for GHCR and the release.

### Variables

All are optional. An unset or empty variable means the default.

| Variable                      | Default                  | What it does                                                                       |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `ATLAS_APP_ID`                | `dev.sejder.atlastodo`   | Android package and iOS bundle id                                                  |
| `ATLAS_EAS_PROJECT_ID`        | the maintainer's project | EAS project id; the update URL follows it. `none` turns over-the-air updates off   |
| `PLAY_STORE_TRACK`            | `internal`               | the Play track a stable release's AAB goes to, besides internal (always)           |
| `PLAY_STORE_PRERELEASE_TRACK` | `internal`               | the Play track a pre-release's (`-rc.N` tag) AAB goes to                           |
| `EXPO_PUBLIC_API_URL`         | unset                    | a server URL baked into the desktop tarball; unset means users pick one at sign-in |
| `DOCKERHUB_IMAGE`             | unset                    | also push the server image to Docker Hub as this name, e.g. `atlastodo/atlas-todo` |

### Releasing from a fork

A fork's release must not look like the upstream app:

- Set `ATLAS_APP_ID` to your own id (for example `org.example.atlastodo`). Otherwise your APK
  claims the upstream package name and cannot be installed next to, or update, the upstream app.
- Set `ATLAS_EAS_PROJECT_ID` to your own EAS project, or to `none` so your build never fetches
  updates from the upstream Expo project.
- Add your own upload keystore as the four `ANDROID_*` secrets.
- Leave `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` unset unless you publish to your own Play listing.
  The upload script reads the package name from the built APK.
- The Docker image goes to `ghcr.io/<your account>/<repo>` without any setting.

Check the resolved config locally with
`cd apps/mobile && ATLAS_APP_ID=... bunx expo config --type public`.
