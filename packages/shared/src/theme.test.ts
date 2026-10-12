import { describe, it, expect } from "vitest";
import {
  ACCENTS,
  ACCENT_NAMES,
  accentVars,
  DEFAULT_ACCENT,
  hexToRgbTriad,
  isAccentName,
  isThemePref,
  resolveTheme,
} from "./theme";

describe("resolveTheme", () => {
  it("honours an explicit light/dark preference regardless of the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("follows the OS when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("accent presets", () => {
  it("exposes six named presets, each a full 50..950 scale", () => {
    expect(ACCENT_NAMES).toHaveLength(6);
    for (const name of ACCENT_NAMES) {
      const scale = ACCENTS[name];
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 900, 950] as const) {
        expect(scale[shade]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("accentVars maps a preset to both hex and -rgb custom properties", () => {
    const vars = accentVars("emerald");
    expect(vars["--accent-600"]).toBe(ACCENTS.emerald[600]);
    expect(vars["--accent-50"]).toBe(ACCENTS.emerald[50]);
    expect(vars["--accent-600-rgb"]).toBe("4 120 87"); // #047857
    expect(vars["--accent-50-rgb"]).toBe("236 253 245"); // #ecfdf5
    expect(Object.keys(vars)).toHaveLength(20);
  });

  it("hexToRgbTriad converts hex to space-separated decimal channels", () => {
    expect(hexToRgbTriad("#1e1b4b")).toBe("30 27 75");
    expect(hexToRgbTriad("1e1b4b")).toBe("30 27 75");
    expect(hexToRgbTriad("#ffffff")).toBe("255 255 255");
    expect(hexToRgbTriad("#000000")).toBe("0 0 0");
  });

  it("falls back to the default accent for an unknown name", () => {
    // Cast through unknown: exercises the runtime guard for corrupt/legacy stored values.
    const vars = accentVars("chartreuse" as unknown as Parameters<typeof accentVars>[0]);
    expect(vars["--accent-600"]).toBe(ACCENTS[DEFAULT_ACCENT][600]);
    expect(vars["--accent-600-rgb"]).toBe(hexToRgbTriad(ACCENTS[DEFAULT_ACCENT][600]));
  });

  it("guards accept only known values", () => {
    expect(isAccentName("rose")).toBe(true);
    expect(isAccentName("chartreuse")).toBe(false);
    expect(isThemePref("system")).toBe(true);
    expect(isThemePref("solar")).toBe(false);
  });
});

// WCAG 2 contrast ratio between two sRGB hex colours.
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = hexToRgbTriad(hex)
      .split(" ")
      .map((c) => {
        const s = Number(c) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("accent contrast", () => {
  it("measures known pairs", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("keeps white text on accent-600 and accent-700, and those shades as text on white, at 4.5:1", () => {
    for (const name of ACCENT_NAMES) {
      for (const shade of [600, 700] as const) {
        expect({ name, shade, ratio: contrast(ACCENTS[name][shade], "#ffffff") >= 4.5 }).toEqual({
          name,
          shade,
          ratio: true,
        });
      }
    }
  });
});
