#!/usr/bin/env bun
// Builds a publishable core package (packages/client-core, packages/shared, packages/sdk) into the
// shape its tarball ships: run from the package directory as its `build` script (`bun run build`;
// scripts/pack-core-packages.sh builds each package, in dependency order, before it packs it; a
// `prepack` hook could not keep that order, since shared's declarations need client-core's).
//
//   dist/<entry>.js     the entry points of the package's `exports`, bundled by Bun into ESM with
//                       every dependency left external (relative modules and JSON are inlined,
//                       manifests/ included, so the package needs no files outside itself)
//   dist/**/*.d.ts      tsc declarations (tsconfig.build.json), with relative specifiers rewritten
//                       to `.js` so `moduleResolution` node16/nodenext consumers resolve them as
//                       well as bundler ones
//   test-vectors/*.json the fixtures named in package.json's `atlas.testVectors`, copied from the
//                       repository's test-vectors/ (the single source; these copies are gitignored)
//   LICENSE             the repository's licence
//
// Inside this repository nothing needs the build: the `@atlastodo/source` export condition sends
// tsc, Metro and vitest to src/ (see each consumer's config). Only a tarball consumer reads dist/.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const pkgDir = process.cwd();
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const SOURCE = "@atlastodo/source";

function fail(message) {
  console.error(`build-core-package (${pkg.name}): ${message}`);
  process.exit(1);
}

// Every export whose source condition points into src/: `./src/foo.ts` builds `./dist/foo.js` and
// must be declared as that in the other conditions, so the two never drift apart.
const entries = [];
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== "object" || !target[SOURCE]) continue;
  const src = target[SOURCE];
  const m = /^\.\/src\/(.+)\.ts$/.exec(src);
  if (!m) fail(`exports["${subpath}"]["${SOURCE}"] must be ./src/<name>.ts, got ${src}`);
  const js = `./dist/${m[1]}.js`;
  const dts = `./dist/${m[1]}.d.ts`;
  if (target.types !== dts || target.default !== js) {
    fail(
      `exports["${subpath}"] must be { "${SOURCE}": "${src}", "types": "${dts}", "default": "${js}" }`,
    );
  }
  entries.push(path.join(pkgDir, src));
}
if (entries.length === 0) fail(`no exports with a "${SOURCE}" condition`);

for (const dir of ["dist", "test-vectors"])
  fs.rmSync(path.join(pkgDir, dir), { recursive: true, force: true });

// 1. JavaScript.
const result = await Bun.build({
  entrypoints: entries,
  root: path.join(pkgDir, "src"),
  outdir: path.join(pkgDir, "dist"),
  format: "esm",
  // Portable code for browsers, React Native and Node alike: no Node or Bun built-ins are used.
  target: "browser",
  packages: "external",
  splitting: true,
  sourcemap: "none",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  fail("bun build failed");
}

// 2. Declarations.
const tsc = path.join(pkgDir, "node_modules", ".bin", "tsc");
const tscRun = spawnSync(fs.existsSync(tsc) ? tsc : "tsc", ["-p", "tsconfig.build.json"], {
  cwd: pkgDir,
  stdio: "inherit",
});
if (tscRun.status !== 0) fail("tsc (declarations) failed");

const dist = path.join(pkgDir, "dist");
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const srcDir = path.join(pkgDir, "src");
for (const file of walk(dist).filter((f) => f.endsWith(".d.ts"))) {
  const text = fs.readFileSync(file, "utf8");
  const fixed = text.replace(
    /((?:from|import)\s*\(?\s*["'])(\.\.?\/[^"']*)(["'])/g,
    (whole, pre, spec, post) => {
      const base = path.resolve(path.dirname(file), spec);
      if (spec.endsWith(".js")) return whole;
      if (spec.endsWith(".json")) {
        // A declaration that needs a JSON module's type: ship that JSON beside it.
        const rel = path.relative(dist, base);
        const from = path.join(srcDir, rel);
        if (rel.startsWith("..") || !fs.existsSync(from)) fail(`${file}: ${spec} is outside src/`);
        fs.mkdirSync(path.dirname(base), { recursive: true });
        fs.copyFileSync(from, base);
        return whole;
      }
      if (fs.existsSync(`${base}.d.ts`)) return `${pre}${spec}.js${post}`;
      if (fs.existsSync(path.join(base, "index.d.ts"))) return `${pre}${spec}/index.js${post}`;
      fail(`${path.relative(pkgDir, file)}: cannot resolve ${spec}`);
    },
  );
  if (fixed !== text) fs.writeFileSync(file, fixed);
}

// 3. Fixtures and licence.
const vectors = pkg.atlas?.testVectors ?? [];
if (vectors.length) {
  const out = path.join(pkgDir, "test-vectors");
  fs.mkdirSync(out);
  for (const name of vectors) {
    const from = path.join(root, "test-vectors", name);
    if (!fs.existsSync(from)) fail(`atlas.testVectors names ${name}, which test-vectors/ lacks`);
    fs.copyFileSync(from, path.join(out, name));
  }
}
fs.copyFileSync(path.join(root, "LICENSE"), path.join(pkgDir, "LICENSE"));

console.log(
  `built ${pkg.name}@${pkg.version}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ${vectors.length} test vectors`,
);
