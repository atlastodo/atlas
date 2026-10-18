import { resources } from "@atlastodo/shared";

// Node's fs/path through jest's `requireActual`: the app's own types carry no Node declarations.
const { readdirSync, readFileSync } = jest.requireActual<{
  readdirSync(
    dir: string,
    opts: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  readFileSync(path: string, encoding: "utf8"): string;
}>("fs");
const { join, relative } = jest.requireActual<{
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
}>("path");

/**
 * Every literal key the app asks `t()` for must exist in every catalog. A missing one renders as
 * the raw key (`nav.noProjects` on screen) or silently falls back to an English default in Danish.
 */

const ROOT = join(expect.getState().testPath!, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function has(catalog: unknown, key: string): boolean {
  const lookup = (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        catalog,
      ) !== undefined;
  // Plural keys live as `key_one` / `key_other`.
  return lookup(key) || lookup(`${key}_one`) || lookup(`${key}_other`);
}

describe("translation keys", () => {
  it("resolves every literal key the app uses, in every language", () => {
    const files = [join(ROOT, "src"), join(ROOT, "app")].flatMap(sources);
    // A wrong root would scan nothing and pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)"/g)) {
        const key = match[1]!;
        for (const [language, bundle] of Object.entries(resources)) {
          if (!has(bundle.translation, key)) {
            missing.push(`${language}: ${key} (${relative(ROOT, file)})`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
