import { useMemo } from "react";
import { makeFormatters, resolveLocale, type Formatters } from "@atlastodo/shared";
import { usePreferences } from "./usePreferences";

/**
 * Date/time/number formatters bound to the user's preferences: one memoized {@link Formatters}
 * instance per consumer. `region` wins over `language` for Intl, so the UI can be in English while
 * dates read `DD/MM/YYYY`.
 */
export function useFormat(): Formatters {
  const { timezone, timeFormat, dateFormat, language, region } = usePreferences();
  return useMemo(
    () =>
      makeFormatters({
        locale: resolveLocale(region, language),
        timeZone: timezone,
        timeFormat,
        dateFormat,
      }),
    [timezone, timeFormat, dateFormat, language, region],
  );
}
