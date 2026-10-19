import { describe, expect, it } from "vitest";
import { trimTrailing } from "./text";

describe("trimTrailing", () => {
  it("drops only the trailing run", () => {
    expect(trimTrailing("abc==", "=")).toBe("abc");
    expect(trimTrailing("a=b=", "=")).toBe("a=b");
    expect(trimTrailing("https://x.example//", "/")).toBe("https://x.example");
    expect(trimTrailing("abc", "=")).toBe("abc");
    expect(trimTrailing("===", "=")).toBe("");
    expect(trimTrailing("", "=")).toBe("");
  });

  it("stays fast on a long run that is not at the end", () => {
    const evil = "=".repeat(200_000) + "x";
    const started = performance.now();
    expect(trimTrailing(evil, "=")).toBe(evil);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("takes exactly one character", () => {
    expect(() => trimTrailing("ab", "")).toThrow();
    expect(() => trimTrailing("ab", "ab")).toThrow();
  });
});
