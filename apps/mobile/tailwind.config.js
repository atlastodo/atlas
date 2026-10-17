/**
 * Tailwind (v3, as NativeWind 4 requires) for the RN app.
 *
 * The `accent-*` colours resolve to CSS variables: the palette is owned by `@atlastodo/shared`'s
 * ACCENTS table and applied at runtime by `ThemeProvider` through NativeWind's `vars()`. Only the
 * shade list is repeated here; it mirrors `AccentScale` in `@atlastodo/shared`, which has no 800.
 *
 * `darkMode: "class"` is required for the light/dark/system preference: NativeWind throws if the
 * colour scheme is set by hand under the default "media".
 *
 * Opacity modifiers on `accent-*` (e.g. `bg-accent-100/60`) work because `accentVars()` emits
 * space-separated RGB channels (`--accent-<shade>-rgb`), wired into Tailwind's `<alpha-value>` as
 * `rgb(var(--accent-<shade>-rgb) / <alpha-value>)`.
 */

const ACCENT_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 900, 950];

/** @type {import('tailwindcss').Config} */
module.exports = {
  // A directory missing here silently never gets its classes generated.
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: Object.fromEntries(
          ACCENT_SHADES.map((shade) => [shade, `rgb(var(--accent-${shade}-rgb) / <alpha-value>)`]),
        ),
      },
    },
  },
  plugins: [],
};
