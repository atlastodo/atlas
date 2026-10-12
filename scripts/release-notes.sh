#!/usr/bin/env bash
#
# Generate RELEASE_NOTES.md for a version from the commit log: every commit since the previous
# release tag (see PREV below), grouped by conventional-commit type (Features / Fixes / Changes /
# Documentation), one line per distinct subject. Maintenance commits (chore, ci, build, test,
# style, refactor: dependency bumps, regenerated lockfiles) are counted on one line with a link to
# the full comparison instead. `chore(release):` commits are excluded -- they are the releases
# themselves.
#
# Called by bump-version.sh, so the notes live in the chore(release) commit and are reviewed in
# the diff before anything ships; the release workflow (.github/workflows/release.yml) then publishes
# this version's section as the GitHub Release notes. Also runnable standalone to preview the notes for
# an upcoming version.
#
# Usage:
#   scripts/release-notes.sh <x.y.z[-rc.N]|vX.Y.Z>   # default: the root package.json version
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p 'require("./package.json").version')"
if [[ $# -gt 0 ]]; then
  VERSION="${1#v}"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$ ]] || { echo "error: version must be x.y.z or x.y.z-rc.N, got '$VERSION'"; exit 1; }

# The previous release tag: the newest existing tag reachable from HEAD that is not this version
# itself -- a re-run after v$VERSION was already cut must not zero out the range. Newest-first by
# creatordate, so old-style tags (v0.9.0 sorting before v0.25.x alphabetically) stay correct.
#   - a stable release (x.y.z) takes notes since the last STABLE tag, so it lists everything the
#     rcs carried (the rc notes stay on their own pre-releases);
#   - an rc takes notes since the last tag of ANY kind, so rc.2 lists only what is new since rc.1.
if [[ "$VERSION" == *-* ]]; then PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$'; else PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'; fi
PREV="$(git tag -l 'v[0-9]*' --merged HEAD --sort=-creatordate | grep -E -- "$PATTERN" | grep -v -- "^v$VERSION\$" | head -1 || true)"

if [[ -n "$PREV" ]]; then
  RANGE="$PREV..HEAD"
else
  # No prior release tag at all: everything back to the root commit is this release's history.
  RANGE="$(git rev-list --max-parents=0 HEAD)..HEAD"
fi

# Grouping in node (bash + node are all this script needs, like bump-version.sh).
node - "$VERSION" "$PREV" "$RANGE" <<'JS'
const { execFileSync } = require("child_process");
const fs = require("fs");
const [version, prev, range] = process.argv.slice(2);

// chore(release) commits ARE the releases; everything else is a change they carry.
const subjects = execFileSync("git", ["log", "--no-merges", "--format=%s", range], { encoding: "utf8" })
  .split("\n")
  .filter((s) => s && !s.startsWith("chore(release):"));

// Conventional-commit type or type(scope), with the optional breaking `!` -- anything else is a
// plain subject that must not be mangled by prefix-stripping.
const CONVENTIONAL = /^([a-z]+)(\([^)]*\))?!?:(.*)$/s;

// Housekeeping a user of the release does not need line by line.
const MAINTENANCE = new Set(["chore", "ci", "build", "test", "style", "refactor"]);

const sections = { Features: [], Fixes: [], Changes: [], Documentation: [] };
let deps = 0;
let maintenance = 0;
for (const s of subjects) {
  const m = s.match(CONVENTIONAL);
  const kind = m ? m[1] : "";
  // A breaking change (`type!:`) is listed whatever its type.
  if (MAINTENANCE.has(kind) && !/^[a-z]+(\([^)]*\))?!:/.test(s)) {
    if (/^\(deps/.test(m[2] ?? "")) deps++;
    else maintenance++;
    continue;
  }
  let text = m ? m[3].trim() : s;
  text = text.slice(0, 1).toUpperCase() + text.slice(1); // sentence case
  const section =
    kind === "feat" ? "Features" : kind === "fix" ? "Fixes" : kind === "docs" ? "Documentation" : "Changes";
  if (!sections[section].includes(text)) sections[section].push(text);
}

const lines = [`## v${version}`, ""];
for (const [title, entries] of Object.entries(sections)) {
  if (!entries.length) continue;
  lines.push(`### ${title}`, ...entries.map((e) => `- ${e}`), "");
}
if (deps + maintenance > 0) {
  const parts = [];
  if (deps) parts.push(`${deps} dependency update${deps === 1 ? "" : "s"}`);
  if (maintenance) parts.push(`${maintenance} maintenance commit${maintenance === 1 ? "" : "s"} (CI, build, tests)`);
  const compare = prev
    ? ` ([full list](https://github.com/atlastodo/atlas-todo/compare/${prev}...v${version}))`
    : "";
  lines.push("### Maintenance", `- ${parts.join(", ")}${compare}`, "");
}
// Thank everyone but the maintainers (CODEOWNERS, and whoever runs this) and bots by name, as their
// GitHub handle when the commit email is a GitHub noreply address.
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
let self = "";
try {
  self = git("config", "user.email").toLowerCase();
} catch {}
const owners = new Set(
  (fs.existsSync(".github/CODEOWNERS") ? fs.readFileSync(".github/CODEOWNERS", "utf8") : "")
    .match(/@[A-Za-z0-9-]+/g)
    ?.map((h) => h.toLowerCase()) ?? [],
);
const thanks = [];
for (const line of git("log", "--no-merges", "--format=%an%x09%ae%x09%s", range).split("\n")) {
  const [name, email = "", subject = ""] = line.split("\t");
  if (!name || subject.startsWith("chore(release):")) continue;
  if (name.endsWith("[bot]") || email.toLowerCase() === self || email === "noreply@anthropic.com") continue;
  const handle = email.match(/^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i)?.[1];
  const who = handle ? `@${handle}` : name;
  if (owners.has(who.toLowerCase()) || thanks.includes(who)) continue;
  thanks.push(who);
}
if (thanks.length) lines.push("### Thanks", `- ${thanks.join(", ")}`, "");
if (lines.length === 2) {
  // Nothing but the heading -- e.g. a manifest-only re-release.
  lines.push("Maintenance release.", "");
}

fs.writeFileSync("RELEASE_NOTES.md", lines.join("\n"));
console.log(`>> Release notes for v${version} (${subjects.length} commit(s) since ${prev || "the first commit"}):`);
console.log(lines.join("\n"));
JS
