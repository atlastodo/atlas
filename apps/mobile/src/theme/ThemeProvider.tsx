import { createContext, useContext, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { vars } from "nativewind";
import { DEFAULT_ACCENT, accentVars, type AccentName } from "@atlastodo/shared";

/**
 * Applies the accent palette to the tree, so `bg-accent-600` and friends resolve. It hands
 * `accentVars(accent)` from `@atlastodo/shared` to NativeWind's `vars()`, which scopes the variables to
 * this View and its descendants.
 *
 * Dark mode is managed by `SyncedTheme`. The accent is the default until the store is up. The
 * accent name is also published on a context so {@link ThemeScope} can restore the palette inside
 * a `Modal`.
 */
const AccentContext = createContext<AccentName>(DEFAULT_ACCENT);

export function ThemeProvider({
  accent = DEFAULT_ACCENT,
  children,
}: {
  accent?: AccentName;
  children: ReactNode;
}) {
  return (
    <AccentContext.Provider value={accent}>
      <View style={vars(accentVars(accent))} className="flex-1">
        {children}
      </View>
    </AccentContext.Provider>
  );
}

/**
 * Re-applies the accent palette inside a `Modal`. Every Modal-based surface needs this.
 *
 * On web, `vars()` compiles to CSS custom properties inherited down the DOM tree, but
 * react-native-web's `Modal` portals its children into `document.body`, outside the app root. The
 * `*-accent-*` classes then resolve to undefined variables and are silently not applied (accent
 * text fell back to black on a dark sheet). `dark:` keeps working because its class is on `<html>`.
 *
 * React context follows the React tree, not the DOM, so reading the accent back out and
 * re-applying `vars()` inside the modal restores the palette. It is inert on native, where
 * variables already propagate.
 */
export function ThemeScope({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const accent = useContext(AccentContext);
  return (
    <View style={[vars(accentVars(accent)), style]} className={className}>
      {children}
    </View>
  );
}
