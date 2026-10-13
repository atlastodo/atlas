import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDue } from "./dates";

/** `test-vectors/parse_due_vectors.json`, which the Rust CLI's date reader asserts too. */
describe("parseDue vectors", () => {
  const { cases } = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../test-vectors/parse_due_vectors.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    cases: {
      value: string | number | null;
      tz: string;
      now: number;
      expected?: number | null;
      error?: string;
    }[];
  };

  for (const c of cases) {
    it(`reads ${JSON.stringify(c.value)} in ${c.tz}`, () => {
      if (c.error !== undefined) {
        expect(() => parseDue(c.value, c.tz, c.now)).toThrow(c.error);
      } else {
        expect(parseDue(c.value, c.tz, c.now)).toBe(c.expected);
      }
    });
  }
});
