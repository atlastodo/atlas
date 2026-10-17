#!/usr/bin/env bash
#
# Installs the packed core packages (scripts/pack-core-packages.sh) into a throwaway project the
# way another repository pins them -- by tarball, with `overrides` for the dependencies between
# them -- and checks they work there: Node imports each entry point, the shipped test vectors
# resolve, and tsc typechecks a consumer under both `moduleResolution` nodenext and bundler.
#
# Usage: scripts/smoke-core-packages.sh TARBALL_DIR     (CI's Test (TypeScript) runs it)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(cd "${1:?usage: smoke-core-packages.sh TARBALL_DIR}" && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
TS="$(node -p 'require(process.argv[1]).devDependencies.typescript' "$ROOT/packages/client-core/package.json")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/src"
tgz() { echo "$DIR/atlastodo-$1-$VERSION.tgz"; }

cat >"$work/package.json" <<EOF
{
  "name": "core-packages-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@atlastodo/client-core": "$(tgz client-core)",
    "@atlastodo/shared": "$(tgz shared)",
    "@atlastodo/sdk": "$(tgz sdk)",
    "typescript": "$TS"
  },
  "overrides": {
    "@atlastodo/client-core": "$(tgz client-core)",
    "@atlastodo/shared": "$(tgz shared)"
  }
}
EOF
(cd "$work" && bun install --silent)

cat >"$work/src/main.ts" <<'EOF'
import { generateDek } from "@atlastodo/client-core";
import { resolveServerUrl } from "@atlastodo/shared";
import { AtlasClient } from "@atlastodo/sdk";
import { FakeServer } from "@atlastodo/sdk/testing";
import kdf from "@atlastodo/client-core/test-vectors/password_kdf_vectors.json" with { type: "json" };

const dek: Uint8Array = generateDek();
const url: string = resolveServerUrl(null, "https://atlas.example/");
console.log(dek.length, url, typeof AtlasClient, typeof FakeServer, Object.keys(kdf).length > 0);
EOF
for mode in nodenext:nodenext esnext:bundler; do
  cat >"$work/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "module": "${mode%%:*}",
    "moduleResolution": "${mode##*:}",
    "target": "es2022",
    "lib": ["es2022", "dom"],
    "types": [],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
EOF
  (cd "$work" && ./node_modules/.bin/tsc -p .) || { echo "error: a consumer fails tsc (${mode##*:})" >&2; exit 1; }
done

out="$(cd "$work" && node --input-type=module -e '
  const entries = ["@atlastodo/client-core", "@atlastodo/shared", "@atlastodo/sdk", "@atlastodo/sdk/testing"];
  for (const e of entries) {
    const m = await import(e);
    if (Object.keys(m).length === 0) throw new Error(`${e} exports nothing`);
  }
  const { generateDek } = await import("@atlastodo/client-core");
  console.log(generateDek().length);
')"
[[ "$out" == 32 ]] || { echo "error: unexpected output from the Node import: $out" >&2; exit 1; }
echo "core packages $VERSION: install, Node import and tsc (nodenext, bundler) OK"
