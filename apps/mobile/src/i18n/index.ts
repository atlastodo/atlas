import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getLocales } from "expo-localization";
import { LANGUAGES, resources } from "@atlastodo/shared";

/**
 * i18next setup. The catalogs and the offered language list come from `@atlastodo/shared`. The initial
 * language is the device's (via expo-localization), and the synced `language` preference then
 * takes over through {@link useI18nLanguage}.
 *
 * Resources are bundled, not fetched, so `t()` resolves synchronously (no Suspense boundary, and
 * tests render translated copy at once). English is the base and the fallback.
 */

/** The device's preferred language, narrowed to one we actually ship. */
export function deviceLanguage(): string {
  const codes = LANGUAGES.map((l) => l.code);
  for (const locale of getLocales()) {
    // `languageCode` is the bare tag ("da"); a device set to "da-DK" should still get Danish.
    const code = locale.languageCode ?? "";
    if (codes.includes(code)) return code;
  }
  return "en";
}

/**
 * On the web, keeps `<html lang>` on the UI language: screen readers pick their voice from it, and
 * Expo's web template fixes it at "en". A no-op on native, where there is no document.
 */
export function setDocumentLanguage(lng: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng === "pt" ? "pt-BR" : lng;
}

if (!i18n.isInitialized) {
  // Registered before init, so it also runs for the initial language.
  i18n.on("languageChanged", setDocumentLanguage);
  void i18n.use(initReactI18next).init({
    resources,
    lng: deviceLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export default i18n;
