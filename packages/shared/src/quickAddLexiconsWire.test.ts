import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUICK_ADD_LANGUAGES, quickAddLexiconsWire } from "./quickAddLexiconsWire";
import { quickAddLexicons } from "./quickAddLexicons";

describe("the Rust client's copy of the quick-add lexicons", () => {
  it("matches the lexicons (regenerate: bun packages/shared/scripts/export-quick-add-lexicons.ts)", () => {
    const path = fileURLToPath(
      new URL("../../../crates/atlas-client/src/rules/quick_add_lexicons.json", import.meta.url),
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(quickAddLexiconsWire());
  });

  it("covers every language with a lexicon", () => {
    for (const code of ["xx", ...QUICK_ADD_LANGUAGES]) {
      const own = quickAddLexicons(code);
      expect(own.length === 2 || code === "en" || code === "xx").toBe(true);
    }
  });
});
