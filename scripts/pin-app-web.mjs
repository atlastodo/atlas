#!/usr/bin/env node
// Pins the web build of an app in apps.lock.json, which docker.yml turns into the Dockerfile's
// TODO_WEB_* build args and the flake's web-dist reads. The server image and the flake serve
// only a pinned build: the app itself lives in its own repository.
//
//   node scripts/pin-app-web.mjs <version> [--repo owner/name] [--app todo]
//   node scripts/pin-app-web.mjs --latest [--repo owner/name] [--app todo]
//
// <version> is a release of the app repository (default atlastodo/atlas-todo) carrying
// atlas-todo-web-<version>.tar.gz and THIRD_PARTY_NOTICES.txt (the web app's third-party
// licences, which the image ships next to the build). The script downloads both, computes their
// SHA-256 and checks them against the release's SHA256SUMS.txt, then writes
// { version, url, sha256, notices: { url, sha256 } } under the app's key. Review and commit the
// change like any other pin.
//
// --latest picks the newest release, rc or stable, that carries the web build, and leaves the pin
// alone unless that is newer than it: the pin never moves back. `deps:update` and
// .github/workflows/app-web-pin.yml use it. It reads the releases from the GitHub API, with
// GH_TOKEN or GITHUB_TOKEN when set.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCK = path.join(ROOT, "apps.lock.json");

const args = process.argv.slice(2);
let repo = "atlastodo/atlas-todo";
let app = "todo";
let version = null;
let latest = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--latest") latest = true;
  else if (a === "--repo") repo = args[++i];
  else if (a === "--app") app = args[++i];
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else version = a.replace(/^v/, "");
}
function usage(message) {
  console.error(`error: ${message}`);
  console.error("usage: pin-app-web.mjs <version> | --latest [--repo owner/name] [--app todo]");
  process.exit(2);
}
const RELEASE = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
if (latest === (version !== null)) usage("give a version or --latest");
if (version !== null && !RELEASE.test(version)) usage(`not a release version: ${version}`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) usage(`not owner/name: ${repo}`);

const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, "utf8")) : {};

/** Release order: X.Y.Z-rc.N sorts before X.Y.Z. */
function compare(a, b) {
  const parts = (v) => {
    const [, maj, min, pat, rc] = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
    return [+maj, +min, +pat, rc === undefined ? Infinity : +rc];
  };
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

if (latest) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${repo} releases: HTTP ${res.status}`);
  // A release still uploading its assets (or one without a web build) is skipped.
  const newest = (await res.json())
    .filter((r) => !r.draft)
    .map((r) => ({ v: r.tag_name.replace(/^v/, ""), assets: r.assets.map((a) => a.name) }))
    .filter(({ v, assets }) => RELEASE.test(v) && assets.includes(`atlas-${app}-web-${v}.tar.gz`))
    .map(({ v }) => v)
    .sort(compare)
    .at(-1);
  if (!newest) throw new Error(`${repo} has no release`);
  const current = lock[app]?.version;
  if (current !== undefined && RELEASE.test(current) && compare(newest, current) <= 0) {
    console.log(`${app} web stays at ${current} (newest release: ${newest})`);
    process.exit(0);
  }
  console.log(`${app} web ${current ?? "(none)"} -> ${newest}`);
  version = newest;
}
const base = `https://github.com/${repo}/releases/download/v${version}`;

// The release's SHA256SUMS.txt (every asset's hash) checks what is downloaded, when it exists.
const published = new Map();
const sums = await fetch(`${base}/SHA256SUMS.txt`);
if (sums.ok) {
  for (const line of (await sums.text()).split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash && name) published.set(name.replace(/^\*/, ""), hash);
  }
} else {
  console.warn(`warning: ${base}/SHA256SUMS.txt is missing (HTTP ${sums.status})`);
}

/** Downloads a release asset and returns its URL and SHA-256, checked against SHA256SUMS.txt. */
async function pinned(file) {
  const url = `${base}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const sha256 = createHash("sha256")
    .update(Buffer.from(await res.arrayBuffer()))
    .digest("hex");
  const want = published.get(file);
  if (want === undefined) {
    console.warn(`warning: SHA256SUMS.txt does not list ${file}; pinning the computed hash`);
  } else if (want !== sha256) {
    throw new Error(`${file}: downloaded ${sha256}, but the release's SHA256SUMS.txt says ${want}`);
  }
  return { url, sha256 };
}

const web = await pinned(`atlas-${app}-web-${version}.tar.gz`);
const notices = await pinned("THIRD_PARTY_NOTICES.txt");
lock[app] = { version, ...web, notices };

fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`apps.lock.json: ${app} = ${JSON.stringify(lock[app])}`);
