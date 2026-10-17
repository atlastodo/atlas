#!/usr/bin/env node
// Pins (or unpins) the web build of an app in apps.lock.json, which docker.yml turns into the
// Dockerfile's TODO_WEB_* build args and the flake's web-dist reads.
//
//   node scripts/pin-app-web.mjs <version> [--repo owner/name] [--app todo]
//   node scripts/pin-app-web.mjs --source [--app todo]       # back to building apps/mobile here
//
// <version> is a release of the app repository (default atlastodo/atlas-todo) carrying
// atlas-todo-web-<version>.tar.gz. The script downloads it, computes its SHA-256 and, when the
// release also has the .sha256 asset, checks the two agree, then writes
// { version, url, sha256 } under the app's key. Review and commit the change like any other pin.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCK = path.join(ROOT, "apps.lock.json");

const args = process.argv.slice(2);
let repo = "atlastodo/atlas-todo";
let app = "todo";
let version = null;
let source = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--repo") repo = args[++i];
  else if (a === "--app") app = args[++i];
  else if (a === "--source") source = true;
  else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else version = a.replace(/^v/, "");
}
function usage(message) {
  console.error(`error: ${message}`);
  console.error(
    "usage: pin-app-web.mjs <version> [--repo owner/name] [--app todo] | --source [--app todo]",
  );
  process.exit(2);
}
if (!source && !version) usage("give a version or --source");
if (version && !/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version))
  usage(`not a release version: ${version}`);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) usage(`not owner/name: ${repo}`);

const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, "utf8")) : {};

if (source) {
  lock[app] = null;
} else {
  const file = `atlas-${app}-web-${version}.tar.gz`;
  const url = `https://github.com/${repo}/releases/download/v${version}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const sha256 = createHash("sha256")
    .update(Buffer.from(await res.arrayBuffer()))
    .digest("hex");
  const sums = await fetch(`${url}.sha256`);
  if (sums.ok) {
    const published = (await sums.text()).trim().split(/\s+/)[0];
    if (published !== sha256) {
      throw new Error(`${file}: downloaded ${sha256}, but the release's .sha256 says ${published}`);
    }
  } else {
    console.warn(
      `warning: ${url}.sha256 is missing (HTTP ${sums.status}); pinning the computed hash`,
    );
  }
  lock[app] = { version, url, sha256 };
}

fs.writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`apps.lock.json: ${app} = ${JSON.stringify(lock[app])}`);
