#!/usr/bin/env node
// The third-party code Atlas Todo ships, and its licences.
//
// The JavaScript side is every package reachable through `dependencies` (and installed peer and
// optional dependencies) from the workspace packages that end up in a build: the app, the desktop
// shell and the shared packages. Dev dependencies (build tools, tests) are not shipped or listed. The
// Rust side is the normal (non-dev, non-build) dependency closure of atlas-server and atlas-cli
// for Linux, from `cargo metadata`.
//
// Usage:
//   node scripts/third-party-licenses.mjs --check          # fail on a JS licence outside ALLOW
//   node scripts/third-party-licenses.mjs --notices FILE   # write the notices file (JS + Rust)
//   node scripts/third-party-licenses.mjs --notices FILE --no-rust
//
// Run `bun install` first (and have cargo on PATH for the Rust part). `--check` mirrors deny.toml's
// allow-list, plus the licences only JS packages use; a new licence fails it for a human to review.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACES = ["apps/mobile", "apps/electron", "packages/shared", "packages/client-core"];

// deny.toml's list, and the permissive licences the shipped JS tree adds (each checked by hand).
const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unicode-3.0",
  "Zlib",
  "CDLA-Permissive-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
  "Python-2.0",
  "MIT-0",
  // Weak copyleft, compatible with AGPL (MPL 2.0 section 3.3): lightningcss, through Expo's CSS
  // tooling.
  "MPL-2.0",
  // Browser-support data, not code: caniuse-lite, through browserslist.
  "CC-BY-4.0",
]);

/** The licence of a package.json: SPDX `license`, an object, or the legacy `licenses` array. */
function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === "string" ? x : x?.type)).join(" OR ");
  if (l && typeof l === "object") return l.type ?? "UNKNOWN";
  return "UNKNOWN";
}

/** Whether an SPDX expression is satisfiable with allowed licences (OR picks one; AND needs all). */
export function allowed(expr) {
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean.split(/\s+OR\s+/i).some((alt) =>
    alt
      .split(/\s+AND\s+/i)
      .map((s) => s.trim())
      .every((id) => ALLOW.has(id)),
  );
}

/** Node's lookup: `<dir>/node_modules/<name>`, then each parent's. Bun's isolated layout resolves too. */
function resolveDep(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(fs.realpathSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function jsPackages() {
  const seen = new Map(); // realpath -> entry
  // A build context may hold only some workspaces (the Docker image has no apps/electron).
  const workspaceDirs = new Set(
    WORKSPACES.map((w) => path.join(ROOT, w))
      .filter((d) => fs.existsSync(path.join(d, "package.json")))
      .map((d) => fs.realpathSync(d)),
  );
  const queue = [...workspaceDirs];
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    seen.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      dir,
      own: workspaceDirs.has(dir),
    });
    const deps = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    for (const name of Object.keys(deps)) {
      const found = resolveDep(dir, name);
      // An optional or peer dependency that isn't installed isn't shipped either.
      if (found && !seen.has(found)) queue.push(found);
    }
  }
  return [...seen.values()]
    .filter((p) => !p.own)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function rustPackages() {
  const meta = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        "x86_64-unknown-linux-gnu",
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  // The two Rust programs a release ships: the server and the `atlas` CLI.
  const roots = meta.packages.filter((p) => p.name === "atlas-server" || p.name === "atlas-cli");
  const seen = new Set();
  const queue = roots.map((p) => p.id);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
    }
  }
  const workspace = new Set(meta.workspace_members);
  return [...seen]
    .filter((id) => !workspace.has(id))
    .map((id) => byId.get(id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `see ${p.license_file}` : "UNKNOWN"),
      dir: path.dirname(p.manifest_path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The licence and notice files a package ships, in a stable order. */
function licenseTexts(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^(licen[cs]e|copying|notice)([-_.].*)?$/i.test(f))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8").trim());
}

function writeNotices(file, withRust) {
  const out = [
    "Atlas Todo third-party notices",
    "",
    "Atlas Todo is licensed under the GNU Affero General Public License v3.0 only. It includes the",
    "third-party software below, each under its own licence. Packages with identical licence texts",
    "share one copy of the text.",
    "",
  ];
  const section = (title, pkgs) => {
    // Group packages by their exact licence text, so the many identical texts appear once.
    const groups = new Map();
    for (const p of pkgs) {
      const texts = licenseTexts(p.dir);
      const key = texts.length
        ? texts.join("\n\n")
        : `(No licence file is included; the package declares: ${p.license})`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(`${p.name} ${p.version} (${p.license})`);
    }
    out.push("=".repeat(78), title, "=".repeat(78), "");
    for (const [text, names] of groups) {
      out.push(...names, "", text, "", "-".repeat(78), "");
    }
  };
  section("JavaScript packages (web, Android and desktop apps)", jsPackages());
  if (withRust) section("Rust crates (the server and the atlas CLI)", rustPackages());
  fs.writeFileSync(file, out.join("\n"));
  console.log(`Wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KiB)`);
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const bad = jsPackages().filter((p) => !allowed(p.license));
    for (const p of bad) console.error(`${p.name}@${p.version}: ${p.license}`);
    if (bad.length) {
      console.error(
        `\n${bad.length} shipped JS package(s) with a licence outside the allow-list in scripts/third-party-licenses.mjs. ` +
          "Review each; add a licence to ALLOW only if it is compatible with AGPL-3.0-only.",
      );
      process.exit(1);
    }
    console.log("Every shipped JS package has an allowed licence.");
  }
  const at = args.indexOf("--notices");
  if (at >= 0) writeNotices(args[at + 1], !args.includes("--no-rust"));
  if (!args.includes("--check") && at < 0) {
    console.error("usage: third-party-licenses.mjs [--check] [--notices FILE [--no-rust]]");
    process.exit(2);
  }
}
