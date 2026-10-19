// Theme and accent resolution; applying a choice lives in the app's `ThemeProvider`.

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME: ThemePref = "system";

export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

export type AccentName = "indigo" | "blue" | "violet" | "emerald" | "amber" | "rose";

export type AccentScale = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 900 | 950, string>;

// Tailwind palettes, except that emerald and amber 600 and 700 are one Tailwind step darker
// (their stock 700 and 800): white text sits on accent-600 buttons and needs 4.5:1 (WCAG AA), which
// their stock 600s miss.
export const ACCENTS: Record<AccentName, AccentScale> = {
  indigo: {
    50: "#eef2ff",
    100: "#e0e7ff",
    200: "#c7d2fe",
    300: "#a5b4fc",
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
    900: "#312e81",
    950: "#1e1b4b",
  },
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    900: "#1e3a8a",
    950: "#172554",
  },
  violet: {
    50: "#f5f3ff",
    100: "#ede9fe",
    200: "#ddd6fe",
    300: "#c4b5fd",
    400: "#a78bfa",
    500: "#8b5cf6",
    600: "#7c3aed",
    700: "#6d28d9",
    900: "#4c1d95",
    950: "#2e1065",
  },
  emerald: {
    50: "#ecfdf5",
    100: "#d1fae5",
    200: "#a7f3d0",
    300: "#6ee7b7",
    400: "#34d399",
    500: "#10b981",
    600: "#047857",
    700: "#065f46",
    900: "#064e3b",
    950: "#022c22",
  },
  amber: {
    50: "#fffbeb",
    100: "#fef3c7",
    200: "#fde68a",
    300: "#fcd34d",
    400: "#fbbf24",
    500: "#f59e0b",
    600: "#b45309",
    700: "#92400e",
    900: "#78350f",
    950: "#451a03",
  },
  rose: {
    50: "#fff1f2",
    100: "#ffe4e6",
    200: "#fecdd3",
    300: "#fda4af",
    400: "#fb7185",
    500: "#f43f5e",
    600: "#e11d48",
    700: "#be123c",
    900: "#881337",
    950: "#4c0519",
  },
};

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export const ACCENT_LABEL_KEYS: Record<AccentName, string> = {
  indigo: "settings.accentIndigo",
  blue: "settings.accentBlue",
  violet: "settings.accentViolet",
  emerald: "settings.accentEmerald",
  amber: "settings.accentAmber",
  rose: "settings.accentRose",
};
export const DEFAULT_ACCENT: AccentName = "indigo";

export function isAccentName(v: unknown): v is AccentName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ACCENTS, v);
}

// `"r g b"` channels for Tailwind v3's `<alpha-value>` substitution.
export function hexToRgbTriad(hex: string): string {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r} ${g} ${b}`;
}

// The `-rgb` form lets `rgb(var(--accent-<shade>-rgb) / <alpha>)` work with opacity modifiers.
export function accentVars(name: AccentName): Record<string, string> {
  const scale = ACCENTS[isAccentName(name) ? name : DEFAULT_ACCENT];
  const vars: Record<string, string> = {};
  for (const [shade, hex] of Object.entries(scale)) {
    vars[`--accent-${shade}`] = hex;
    vars[`--accent-${shade}-rgb`] = hexToRgbTriad(hex);
  }
  return vars;
}
