#!/usr/bin/env node
// Pins the web build of an app in apps.lock.json, which docker.yml turns into the Dockerfile's
// TODO_WEB_* build args and the flake's web-dist reads. The server image and the flake serve
// only a pinned build: the app itself lives in its own repository.
//
//   node scripts/pin-app-web.mjs <version> [--repo owner/name] [--app todo]
//
// <version> is a release of the app repository (default atlastodo/atlas-todo) carrying
// atlas-todo-web-<version>.tar.gz and THIRD_PARTY_NOTICES.txt (the web app's third-party
// licences, which the image ships next to the build). The script downloads both, computes their
// SHA-256 and checks them against the release's SHA256SUMS.txt, then writes
// { version, url, sha256, notices: { url, sha256 } } under the app's key. Review and commit the
// change like any other pin.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCK = path.join(ROOT, "apps.lock.json");

const args = process.argv.slice(2);
let repo = "atlastodo/atlas-todo";
let app = "todo";
let version = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--repo") repo = args[++i];
  else if (a === "--app") app = args[++i];
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else version = a.replace(/^v/, "");
}
function usage(message) {
  console.error(`error: ${message}`);
  console.error("usage: pin-app-web.mjs <version> [--repo owner/name] [--app todo]");
  process.exit(2);
}
if (!version) usage("give a version");
if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version)) usage(`not a release version: ${version}`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) usage(`not owner/name: ${repo}`);

const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, "utf8")) : {};
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
