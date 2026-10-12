#!/usr/bin/env node
// Compares the permissions in the Android release build's merged manifest with the table in
// docs/android-permissions.md, so a dependency that adds a permission fails the release instead of
// shipping it, and the table cannot keep a permission the app no longer declares.
//
// Usage: node apps/mobile/scripts/check-android-permissions.mjs [merged AndroidManifest.xml]
// (default: the release build's, under apps/mobile/android/app/build).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(mobile, "../../docs/android-permissions.md");
const manifestPath =
  process.argv[2] ??
  join(
    mobile,
    "android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml",
  );

const applicationId = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.android
  .package;

let manifest;
try {
  manifest = readFileSync(manifestPath, "utf8");
} catch {
  console.error(`No merged manifest at ${manifestPath}: build the release first.`);
  process.exit(2);
}

// <uses-permission> and <uses-permission-sdk-23>, minus commented-out ones.
const declared = new Set(
  [
    ...manifest
      .replace(/<!--[\s\S]*?-->/g, "")
      .matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*?android:name="([^"]+)"/g),
  ].map((m) => m[1]),
);

// The first backticked cell of each row in the "Declared" table.
const declaredSection = readFileSync(docPath, "utf8")
  .split(/^## /m)
  .find((s) => s.startsWith("Declared"));
const allowed = new Set(
  [...(declaredSection ?? "").matchAll(/^\|\s*`([^`]+)`/gm)].map((m) =>
    m[1].replace("${applicationId}", applicationId),
  ),
);
if (allowed.size === 0) {
  console.error(`Found no permissions in the "Declared" table of ${docPath}.`);
  process.exit(2);
}

const unexpected = [...declared].filter((p) => !allowed.has(p)).sort();
const stale = [...allowed].filter((p) => !declared.has(p)).sort();

for (const p of unexpected) {
  console.error(`Declared but not documented: ${p}`);
}
for (const p of stale) {
  console.error(`Documented but no longer declared: ${p}`);
}
if (unexpected.length || stale.length) {
  console.error(
    "\nAdd a row to docs/android-permissions.md for a permission the app needs, or block it in " +
      "apps/mobile/app.json (android.blockedPermissions); drop the row of one no longer declared.",
  );
  process.exit(1);
}
console.log(`Android permissions match docs/android-permissions.md (${declared.size}).`);
