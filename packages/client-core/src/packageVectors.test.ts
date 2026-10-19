import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The package tarball ships the `test-vectors/` fixtures its `atlas.testVectors` names (copied from
 * the repository's test-vectors/ by scripts/build-core-package.mjs), so a client in another
 * repository can assert the same fixtures. Every fixture these tests read must be in that list.
 */
const pkgDir = fileURLToPath(new URL("..", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );
}

describe("shipped test vectors", () => {
  it("lists every fixture the tests read", () => {
    const pkg = JSON.parse(readFileSync(`${pkgDir}/package.json`, "utf8")) as {
      atlas: { testVectors: string[] };
    };
    const read = new Set<string>();
    for (const file of filesUnder(`${pkgDir}/src`).filter((f) => f.endsWith(".ts"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\b([a-z_]+_vectors\.json)/g)) {
        read.add(m[1]!);
      }
    }
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((name) => !pkg.atlas.testVectors.includes(name))).toEqual([]);
  });
});
