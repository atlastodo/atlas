#!/usr/bin/env bash
#
# Bump the project version across EVERY manifest in lockstep (the root package.json and every
# workspace package.json the root `workspaces` globs match -- apps/* and packages/*, so a new
# package is picked up without editing this script -- apps/mobile/app.json, bun.lock, and
# Cargo.toml/Cargo.lock),
# ensuring all manifests stay synchronized with the release tag. Also regenerates nix/bun.nix (the
# flake's npm dependency set) from bun.lock when nix is available.
#
# Usage:
#   scripts/bump-version.sh [options] <x.y.z>     # set an explicit version
#   scripts/bump-version.sh [options] <x.y.z-rc.N> # set a pre-release (cut on the dev branch)
#   scripts/bump-version.sh [options] patch       # bump the patch component (x.y.Z -> x.y.Z+1)
#   scripts/bump-version.sh [options] minor       # bump the minor  (x.Y.z -> x.Y+1.0)
#   scripts/bump-version.sh [options] major       # bump the major  (X.y.z -> X+1.0.0)
#
# patch/minor/major need a stable current version; from an rc, name the version (x.y.z-rc.N+1, or
# x.y.z to promote). Only x.y.z and x.y.z-rc.N are accepted. Android's versionCode is derived from
# the version by scripts/version-code.mjs (it always grows, rc or stable); the version string itself
# (-rc.N and all) is the Android versionName, which accepts it.
#
# Options:
#   --no-notes   don't regenerate RELEASE_NOTES.md
#   --desktop    also build the desktop tarball (scripts/package-desktop.sh) for the new version
#
# Re-running with the current version only verifies that every manifest agrees; it leaves
# RELEASE_NOTES.md alone, so reviewed notes are never overwritten.
#
# After running: review `git diff` (the regenerated RELEASE_NOTES.md is part of it -- it becomes
# the release notes for the tag), commit as `chore(release): vX.Y.Z`, then tag `vX.Y.Z` to release.
#
# Needs only bash and node (no GNU sed, no python), so it runs the same on Linux and macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NOTES=1
DESKTOP=0
ARG=""
for a in "$@"; do
  case "$a" in
    --no-notes) NOTES=0 ;;
    --desktop) DESKTOP=1 ;;
    -*) echo "error: unknown option '$a'" >&2; exit 2 ;;
    *) ARG="$a" ;;
  esac
done
[[ -n "$ARG" ]] || { echo "usage: bump-version.sh [--no-notes] [--desktop] <x.y.z|patch|minor|major>" >&2; exit 2; }

OLD="$(node -p 'require("./package.json").version')"
RELEASE_RE='^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$'
[[ "$OLD" =~ $RELEASE_RE ]] || { echo "error: package.json version is not x.y.z or x.y.z-rc.N: '$OLD'"; exit 1; }
if [[ "$ARG" =~ ^(patch|minor|major)$ && "$OLD" == *-* ]]; then
  echo "error: '$ARG' needs a stable current version ($OLD is a pre-release); give the version explicitly." >&2
  exit 2
fi
IFS=. read -r MAJOR MINOR PATCH <<<"$OLD"
case "$ARG" in
  patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW="$((MAJOR + 1)).0.0" ;;
  *) NEW="$ARG" ;;
esac

[[ "$NEW" =~ $RELEASE_RE ]] || { echo "error: version must be x.y.z or x.y.z-rc.N, got '$NEW'"; exit 1; }
# Fails (set -e) when the version is out of range for the versionCode scheme.
VERSION_CODE="$(node "$ROOT/scripts/version-code.mjs" "$NEW")"
# "Already at X" still falls through to the verification below rather than exiting: the root
# package.json agreeing says nothing about the others, and a manifest quietly drifting out of step is
# the failure this script exists to prevent. Re-running with the current version is the way to check.
if [[ "$OLD" == "$NEW" ]]; then
  echo "Already at $NEW -- verifying the other manifests agree."
else
  echo "Bumping $OLD -> $NEW"
fi

# Rewrite and verify in one node pass. Edits are textual (exact-match replacements) so every file
# keeps its formatting; nothing is round-tripped through a JSON serializer.
node - "$OLD" "$NEW" "$VERSION_CODE" <<'JS'
const fs = require("fs");
const [OLD, NEW, VERSION_CODE] = process.argv.slice(2);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const read = (f) => fs.readFileSync(f, "utf8");
const edit = (f, fn) => {
  const before = read(f);
  const after = fn(before);
  if (after !== before) fs.writeFileSync(f, after);
};

// JSON manifests: only the top-level (and expo) "version" field is the plain "x.y.z" string --
// workspace deps use "workspace:*" and third-party deps use caret ranges, so this exact match is safe.
//
// bun.lock records each workspace package's version too. It once sat at an old version for two
// releases, so every `bun install` rewrote it and dirtied the tree (`--frozen-lockfile` passes
// either way, which is why the drift went unnoticed). The same exact match is safe there: third-party
// packages are recorded as ["name@ver", ...] arrays, so the only `"version": "x.y.z"` keys in the
// file are the workspace ones.
// Every workspace package, found from the root `workspaces` globs ("dir/*" or a plain path), so a
// package added later is bumped and verified too. Directories without a package.json (or without
// a version) are skipped.
const workspaceManifests = JSON.parse(read("package.json"))
  .workspaces.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const dir = pattern.slice(0, -2);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `${dir}/${d.name}`)
      .sort();
  })
  .map((dir) => `${dir}/package.json`)
  .filter((f) => fs.existsSync(f) && JSON.parse(read(f)).version !== undefined);
const packageManifests = ["package.json", ...workspaceManifests];
const jsonFiles = [...packageManifests, "apps/mobile/app.json", "bun.lock"];
const versionKey = new RegExp(`"version": "${esc(OLD)}"`, "g");
if (OLD !== NEW) {
  for (const f of jsonFiles) edit(f, (s) => s.replace(versionKey, `"version": "${NEW}"`));
  // Every new version needs a higher Android versionCode (stores reject a reused or lower one):
  // derived from the version, see scripts/version-code.mjs.
  edit("apps/mobile/app.json", (s) => s.replace(/("versionCode": )(\d+)/, `$1${VERSION_CODE}`));
  // Cargo.toml workspace version -- line-anchored so dependency version pins are left alone.
  edit("Cargo.toml", (s) =>
    s.replace(new RegExp(`^version = "${esc(OLD)}"`, "m"), `version = "${NEW}"`),
  );
  // Cargo.lock: only OUR atlas-* crates (context-aware, so third-party crates that happen to share
  // the old version string are never touched).
  edit("Cargo.lock", (s) =>
    s.replace(
      new RegExp(`(name = "atlas-[a-z]+"\\nversion = )"${esc(OLD)}"`, "g"),
      `$1"${NEW}"`,
    ),
  );
}

// Verify by asserting every manifest now *equals* the new version, rather than grepping for
// leftover copies of the old one: that catches a manifest that silently drifted to some *other*
// version, and never trips over a third-party crate that shares the version number.
console.log(`Done. Verifying every manifest is at ${NEW}:`);
let failed = false;
const check = (label, actual) => {
  const ok = actual === NEW;
  if (!ok) failed = true;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${actual}${ok ? "" : ` (expected ${NEW})`}`);
};
for (const f of packageManifests) check(f, JSON.parse(read(f)).version ?? "");
check("apps/mobile/app.json", JSON.parse(read("apps/mobile/app.json")).expo?.version ?? "");
// (Not when merely verifying: v0.1.3 and older carry the legacy +1 codes.)
if (OLD !== NEW) {
  const code = String(JSON.parse(read("apps/mobile/app.json")).expo?.android?.versionCode);
  const ok = code === VERSION_CODE;
  if (!ok) failed = true;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${"app.json android.versionCode".padEnd(34)} ${code}${ok ? "" : ` (expected ${VERSION_CODE})`}`);
}
check("Cargo.toml", (read("Cargo.toml").match(/^version = "(.*)"$/m) ?? [])[1] ?? "");
for (const [, name, ver] of read("Cargo.lock").matchAll(/name = "(atlas-[^"]+)"\nversion = "([^"]+)"/g))
  check(`Cargo.lock ${name}`, ver);
// bun.lock is JSONC (trailing commas), so a regex rather than JSON.parse.
for (const [, name, ver] of read("bun.lock").matchAll(/"name": "([^"]+)",\s*\n\s*"version": "([^"]+)"/g))
  check(`bun.lock ${name}`, ver);
if (failed) {
  console.log(`WARNING: some manifests are not at ${NEW} -- see above.`);
  process.exit(1);
}
JS

# Keep nix/bun.nix in step with bun.lock: a stale one breaks the flake's web-dist/atlas-desktop
# builds (they install offline from it) and fails `lint`. Runs on every bump, not only when the
# version changed, so a dependency update since the last release is picked up too.
echo ""
if command -v nix >/dev/null; then
  echo ">> Regenerating nix/bun.nix from bun.lock..."
  nix run --inputs-from "$ROOT" bun2nix -- -c ../ -o "$ROOT/nix/bun.nix"
else
  echo ">> WARNING: nix not found -- nix/bun.nix was not regenerated; run \`nix:bun-lock\` before tagging." >&2
fi

# Regenerate the release notes from the commits since the previous release tag. They live in the
# chore(release) commit (review the diff!) and become the release notes for the tag.
if [[ "$NOTES" -eq 1 && "$OLD" != "$NEW" ]]; then
  echo ""
  echo ">> Regenerating release notes for v${NEW}..."
  bash "$ROOT/scripts/release-notes.sh" "$NEW"
fi

if [[ "$DESKTOP" -eq 1 ]]; then
  echo ""
  echo ">> Packaging desktop distribution for v${NEW}..."
  bash "$ROOT/scripts/package-desktop.sh" "$NEW"
fi
