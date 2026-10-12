import en from "./locales/en.json";
import da from "./locales/da.json";
import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import pt from "./locales/pt.json";

/**
 * The translation catalogs and offered languages, shared so apps cannot drift. Only data lives
 * here; each app runs its own i18next `init`. English is the base and fallback. Catalogs stay JSON
 * because the ESLint rule banning unicode glyphs targets `.ts`/`.tsx`. A new UI string needs its
 * key in every catalog (`keys.test.ts` in apps/mobile checks). `pt` is Brazilian Portuguese.
 */
export const resources = {
  en: { translation: en },
  da: { translation: da },
  de: { translation: de },
  es: { translation: es },
  fr: { translation: fr },
  it: { translation: it },
  nl: { translation: nl },
  pl: { translation: pl },
  pt: { translation: pt },
} as const;

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "da", label: "Dansk" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "pt", label: "Português (Brasil)" },
];
