#!/usr/bin/env bash
#
# Build and package the Atlas Todo Electron desktop application into a
# standalone archive containing precompiled web assets, Electron scripts,
# desktop metadata, and a self-contained Nix Flake.
#
# Usage:
#   scripts/package-desktop.sh [version]
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/dist-desktop}"

# API URL for the packaged desktop export. Deliberately **unset by default**: the repo ships no
# built-in server (users type theirs on the sign-in screen). A distribution that should default to
# a specific instance sets it here or via CI -- e.g. EXPO_PUBLIC_API_URL=https://todo.example.com/api
export EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-}"
export CI=1
export EXPO_NO_TELEMETRY=1

echo ">> Packaging Atlas Todo Desktop v${VERSION}..."
if [ -n "${EXPO_PUBLIC_API_URL}" ]; then
  echo ">> API URL: ${EXPO_PUBLIC_API_URL}"
else
  echo ">> API URL: (none baked in -- chosen on the sign-in screen)"
fi

# 1. Build mobile web SPA bundle
echo ">> 1. Exporting mobile web bundle..."
(cd "$ROOT/apps/mobile" && rm -rf .expo dist && bunx expo export --platform web --clear && node scripts/postexport-favicon.mjs)

# 2. Compile Electron TypeScript (from clean, so nothing stale rides into the package)
echo ">> 2. Compiling @atlastodo/electron..."
(cd "$ROOT/apps/electron" && rm -rf dist && bun run build)

# 3. Assemble distribution directory
echo ">> 3. Assembling package structure at ${OUTPUT_DIR}..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/dist" "$OUTPUT_DIR/web-dist" "$OUTPUT_DIR/assets"

cp -r "$ROOT/apps/electron/dist/"* "$OUTPUT_DIR/dist/"
cp -r "$ROOT/apps/mobile/dist/"* "$OUTPUT_DIR/web-dist/"
cp "$ROOT/apps/mobile/assets/icon.png" "$OUTPUT_DIR/assets/icon.png"
cp "$ROOT/apps/electron/assets/tray"*.png "$OUTPUT_DIR/assets/"
cp "$ROOT/apps/electron/package.json" "$OUTPUT_DIR/package.json"
# The licence and the third-party notices for the JavaScript in the package (the desktop app has no
# Rust; Electron itself comes from nixpkgs).
cp "$ROOT/LICENSE" "$OUTPUT_DIR/LICENSE"
node "$ROOT/scripts/third-party-licenses.mjs" --notices "$OUTPUT_DIR/THIRD_PARTY_NOTICES.txt" --no-rust

# Release marker, read by main.js: it turns off dev mode (--dev, a localhost dev server) for good.
# Written into the package only -- apps/electron/dist stays a dev build.
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ release: true, version: process.argv[2] }) + "\n")' \
  "$OUTPUT_DIR/dist/release.json" "$VERSION"

# 4. Generate embedded flake.nix & lockfile (the lock pins nixpkgs for users of the tarball flake;
# refresh it with the `desktop:flake-update` devenv script).
echo ">> 4. Generating embedded flake.nix..."
sed "s/@VERSION@/$VERSION/g" "$ROOT/nix/flake.desktop.nix" > "$OUTPUT_DIR/flake.nix"
cp "$ROOT/nix/flake.desktop.lock" "$OUTPUT_DIR/flake.lock"

# 5. Create release tarball archives
echo ">> 5. Creating release archives..."
(cd "$OUTPUT_DIR" && tar -czf "$ROOT/atlas-desktop-${VERSION}.tar.gz" .)
# -latest backs the stable /releases/latest/download/ URL, so a pre-release (x.y.z-rc.N) never
# writes it.
if [[ "$VERSION" != *-* ]]; then
  cp "$ROOT/atlas-desktop-${VERSION}.tar.gz" "$ROOT/atlas-desktop-latest.tar.gz"
fi

echo ">> Successfully created:"
echo "   - $ROOT/atlas-desktop-${VERSION}.tar.gz"
[[ "$VERSION" == *-* ]] || echo "   - $ROOT/atlas-desktop-latest.tar.gz"
echo "   - Directory: ${OUTPUT_DIR}"
