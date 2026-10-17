#!/usr/bin/env bash
#
# Builds the web app (the Expo web export of apps/mobile) as the release asset
# atlas-todo-web-X.Y.Z.tar.gz, plus atlas-todo-web-X.Y.Z.tar.gz.sha256 (`sha256sum` format), in
# OUT_DIR (default: dist-web/). The tarball holds one directory, atlas-todo-web-X.Y.Z/, whose
# contents are a server's static dir: what a pinned server image (docker/Dockerfile,
# TODO_WEB_URL/TODO_WEB_SHA256) or the flake's web-dist (apps.lock.json) downloads instead of
# building the app. The release attaches both files; the todo app's own repository will release the
# same asset shape once the app lives there.
#
# Built as the server image builds it: the API at /api on the page's origin
# (EXPO_PUBLIC_API_URL=/api) and the About screen's source link at EXPO_PUBLIC_REPO_URL. The archive
# is reproducible for a given export (sorted entries, fixed owner and mtime, no gzip timestamp).
#
# Usage: scripts/web-release-tarball.sh [OUT_DIR]     (run `bun install` first)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-web}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
NAME="atlas-todo-web-$VERSION"

export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL-/api}"
export EXPO_PUBLIC_REPO_URL="${EXPO_PUBLIC_REPO_URL:-https://github.com/atlastodo/atlas-todo}"
export CI=1 EXPO_NO_TELEMETRY=1

echo ">> Exporting the web app $VERSION (API at '${EXPO_PUBLIC_API_URL}')"
(cd "$ROOT/apps/mobile" && rm -rf .expo dist && bunx expo export --platform web --clear && node scripts/postexport-favicon.mjs)

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -r "$ROOT/apps/mobile/dist" "$stage/$NAME"

# The commit time, so the same commit gives the same archive.
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)}"
tar -C "$stage" --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  --format=gnu -cf - "$NAME" | gzip -9n >"$OUT/$NAME.tar.gz"
(cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")

cat "$OUT/$NAME.tar.gz.sha256"
