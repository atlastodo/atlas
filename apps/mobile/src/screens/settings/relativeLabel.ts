import i18n from "../../i18n";

/**
 * A short relative label ("just now", "3 days ago") for a unix-millis stamp, via
 * `Intl.RelativeTimeFormat`. Falls through coarse units so a minute never reads "0 hours ago".
 * `locale` defaults to the app language, not the device's: the label sits inside translated text.
 */
export function relativeLabel(ms: number, now: number, locale: string = i18n.language): string {
  // Whole minutes: sub-minute noise would read "1 second ago" for one network round trip.
  const diff = Math.round((ms - now) / 60_000);
  const m = Math.abs(diff);
  // The units subtract down the same signed `diff`, which already carries "ago"/"in"; do not flip it again.
  let value = diff;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  if (m >= 60 * 24 * 365) {
    value = Math.round(diff / (60 * 24 * 365));
    unit = "year";
  } else if (m >= 60 * 24 * 30) {
    value = Math.round(diff / (60 * 24 * 30));
    unit = "month";
  } else if (m >= 60 * 24) {
    value = Math.round(diff / (60 * 24));
    unit = "day";
  } else if (m >= 60) {
    value = Math.round(diff / 60);
    unit = "hour";
  }
  // Hermes on Android may lack `Intl.RelativeTimeFormat`, where the constructor is `undefined`. The
  // fallback must never touch that constructor; it renders plain text in the same coarse units.
  const formed =
    typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
      ? (() => {
          try {
            return new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" }).format(
              value,
              unit,
            );
          } catch {
            return null;
          }
        })()
      : null;
  if (formed !== null) return formed;
  // The fallback is translated too, so a Danish screen never reads "2 timer ago".
  const t = locale ? i18n.getFixedT(locale) : i18n.t.bind(i18n);
  if (value === 0) return t("relativeTime.justNow");
  const amount = t(`relativeTime.${unit}`, { count: Math.abs(value) });
  return t(value < 0 ? "relativeTime.past" : "relativeTime.future", { amount });
}
