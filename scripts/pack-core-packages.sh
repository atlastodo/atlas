#!/usr/bin/env bash
#
# Packs the publishable core packages into npm tarballs: atlastodo-client-core-X.Y.Z.tgz,
# atlastodo-shared-X.Y.Z.tgz and atlastodo-sdk-X.Y.Z.tgz in OUT_DIR (default: dist-packages/).
# The release attaches them to the GitHub Release (and publishes them to npm when NPM_TOKEN is set);
# locally it is the `packages:pack` devenv script.
#
# `bun pm pack`, never `npm pack`: Bun rewrites the `workspace:*` dependencies between the packages
# to the exact (lockstep) version, which npm would leave in place and so ship an uninstallable
# package. Each package is built first (`bun run build`, scripts/build-core-package.mjs), in
# dependency order, since a package's declarations are built against its siblings' built ones.
#
# Usage: scripts/pack-core-packages.sh [OUT_DIR]     (run `bun install` first)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-packages}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
for pkg in client-core shared sdk; do
  dir="$ROOT/packages/$pkg"
  [[ "$(node -p 'require(process.argv[1]).version' "$dir/package.json")" == "$VERSION" ]] || {
    echo "error: packages/$pkg is not at $VERSION; run version:bump" >&2
    exit 1
  }
  (cd "$dir" && bun run build && bun pm pack --destination "$OUT" --quiet >/dev/null)
  tgz="$OUT/atlastodo-$pkg-$VERSION.tgz"
  [[ -f "$tgz" ]] || { echo "error: bun pm pack wrote no $tgz" >&2; exit 1; }
  # The packed manifest must not leak the workspace protocol, and must carry what it exports.
  manifest="$(tar -xzOf "$tgz" package/package.json)"
  if grep -q '"workspace:' <<<"$manifest"; then
    echo "error: $tgz still has workspace: dependencies" >&2
    exit 1
  fi
  listing="$(tar -tzf "$tgz")"
  for f in package/dist/index.js package/dist/index.d.ts package/LICENSE; do
    grep -qx "$f" <<<"$listing" || { echo "error: $tgz lacks $f" >&2; exit 1; }
  done
  echo "$tgz"
done
