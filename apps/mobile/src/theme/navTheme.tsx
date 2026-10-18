import { Platform, View, type ColorSchemeName, type StyleProp, type ViewStyle } from "react-native";
import { ACCENTS, type AccentName } from "@atlastodo/shared";

/**
 * React Navigation header/drawer/tab colours for a resolved colour scheme. React Navigation styles
 * its chrome through hex props, not className; the values match the `bg-white dark:bg-zinc-950`
 * screens beneath. The header background is the same zinc-950 as the scene, since two near-identical
 * darks seamed visibly.
 */

const DARK = {
  background: "#09090b", // zinc-950, same as the scene surfaces
  text: "#f5f5f5", // neutral-100
  border: "#262626", // neutral-800
} as const;

const LIGHT = {
  background: "#ffffff",
  text: "#171717", // neutral-900
  border: "#e5e5e5", // neutral-200
} as const;

type Scheme = ColorSchemeName | undefined;

/**
 * React Navigation's own web font stack starts with `system-ui`, which on Linux resolves to a
 * different face than the `-apple-system, ..., Roboto` stack react-native-web gives every `Text`.
 * "System" is react-native-web's name for that same stack, so the navigation chrome (header titles,
 * back labels) renders in the body's font. Native already uses the platform system font.
 */
const WEB_FONTS = {
  regular: { fontFamily: "System", fontWeight: "400" },
  medium: { fontFamily: "System", fontWeight: "500" },
  bold: { fontFamily: "System", fontWeight: "600" },
  heavy: { fontFamily: "System", fontWeight: "700" },
} as const;

/**
 * A page title's type, matching {@link HeaderTitle}'s `text-lg font-semibold`, so a plain title and
 * an icon title read the same. The family is the body's: on Android the plain "sans-serif" (the
 * navigator's default title is "sans-serif-medium", a separate face), elsewhere "System".
 */
const TITLE_FONT = {
  fontSize: 18,
  fontWeight: "600",
  fontFamily: Platform.OS === "android" ? "sans-serif" : "System",
} as const;

export function isDark(scheme: Scheme): boolean {
  return scheme === "dark";
}

/** The scene background (`bg-white` / `dark:bg-zinc-950`) as a hex, for surfaces that take no className. */
export function sceneBackground(scheme: Scheme): string {
  return (isDark(scheme) ? DARK : LIGHT).background;
}

/**
 * Overlays the app's chrome and the user's accent preference onto a react-navigation base theme.
 *
 * The base theme (`DarkTheme`/`DefaultTheme`) is passed in rather than imported: it lives behind
 * expo-router's bootstrap, too heavy for this module, which sits in every UI test's import graph.
 * `primary` follows the accent, a brighter shade in dark mode (as `text-accent-600` /
 * `dark:text-accent-400` elsewhere).
 */
// Typed loosely: importing react-navigation's Theme type would pull the same dependency back in.
export function withAccent<T extends { colors: object }>(
  base: T,
  dark: boolean,
  accent: AccentName,
): T {
  const c = dark ? DARK : LIGHT;
  return {
    ...base,
    ...(Platform.OS === "web" ? { fonts: WEB_FONTS } : null),
    colors: {
      ...base.colors,
      primary: dark ? ACCENTS[accent][400] : ACCENTS[accent][600],
      background: c.background,
      card: c.background,
      border: c.border,
      text: c.text,
    },
  };
}

/** Header background with a colour transition, so web shows no seam on a scheme change. */
function ThemedHeaderBackground(props?: { style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        props?.style,
        Platform.OS === "web"
          ? ({
              transition: "background-color 250ms cubic-bezier(0.4, 0, 0.2, 1)",
            } as ViewStyle)
          : undefined,
      ]}
      className="flex-1 bg-white dark:bg-zinc-950"
    />
  );
}

/** Header screenOptions for a resolved scheme, with the hairline shadow off so the header blends in. */
export function headerThemeOptions(scheme: Scheme) {
  const c = isDark(scheme) ? DARK : LIGHT;
  return {
    headerBackground: () => <ThemedHeaderBackground />,
    headerTintColor: c.text,
    headerTitleStyle: { color: c.text, ...TITLE_FONT },
    headerShadowVisible: false,
  } as const;
}

/** Drawer/sidebar surface colours for a resolved scheme (background + hairline border). */
export function drawerThemeOptions(scheme: Scheme) {
  const c = isDark(scheme) ? DARK : LIGHT;
  const bg = isDark(scheme) ? "#09090b" : "#ffffff";
  return {
    drawerStyle: { backgroundColor: c.background, borderRightColor: c.border },
    sceneStyle: { backgroundColor: bg },
    sceneContainerStyle: { backgroundColor: bg },
  } as const;
}
