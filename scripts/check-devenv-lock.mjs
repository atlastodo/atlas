#!/usr/bin/env node
// devenv.yaml takes nixpkgs (and any other shared input) from this repository's flake with
// `follows: <self>/<input>`, and devenv.lock keeps its own copy of what flake.lock pinned. Fails when
// that copy has fallen behind flake.lock, e.g. after `nix flake update` without `devenv update`.
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const devenv = read("devenv.lock");
const flake = read("flake.lock");

// The node an input reference points at: a node name, or a `follows` path from the root.
function resolve(lock, ref) {
  if (typeof ref === "string") return ref;
  let node = lock.root;
  for (const name of ref) node = resolve(lock, lock.nodes[node].inputs[name]);
  return node;
}

const self = Object.entries(devenv.nodes).find(
  ([, n]) => n.locked?.type === "path" && n.locked.path === ".",
)?.[0];
if (!self) {
  console.error("devenv.lock has no input for this repository's flake (url: path:.)");
  process.exit(1);
}

const stale = [];
for (const [name, ref] of Object.entries(devenv.nodes[devenv.root].inputs)) {
  if (!Array.isArray(ref) || ref[0] !== self) continue;
  const ours = devenv.nodes[resolve(devenv, ref)].locked;
  const theirs = flake.nodes[resolve(flake, ref.slice(1))].locked;
  if (ours.narHash !== theirs.narHash)
    stale.push(
      `${name}: devenv.lock ${ours.rev ?? ours.narHash}, flake.lock ${theirs.rev ?? theirs.narHash}`,
    );
}
if (stale.length) {
  console.error(`devenv.lock is behind flake.lock: run devenv update\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
