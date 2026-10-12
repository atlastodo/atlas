import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  REGION_OPTIONS,
  resolveTimeZone,
  timeZoneOptions,
  type DateFormatPref,
  type TimeFormatPref,
} from "@atlas/shared";
import { usePreferences } from "../../hooks/usePreferences";
import { deviceLanguage } from "../../i18n";
import { ListPicker, type PickerOption } from "../../ui/ListPicker";
import { Row, Section } from "../../ui/Section";
import { Segmented } from "../../ui/Segmented";
import { Toggle } from "../../ui/Toggle";
import { CalendarClock } from "../../ui/icons";
import { labelOptions } from "./shared";

const TIME_OPTIONS: { value: TimeFormatPref; labelKey: string }[] = [
  { value: "auto", labelKey: "settings.auto" },
  { value: "12h", labelKey: "settings.time12h" },
  { value: "24h", labelKey: "settings.time24h" },
];
const DATE_OPTIONS: { value: DateFormatPref; labelKey: string }[] = [
  { value: "auto", labelKey: "settings.auto" },
  { value: "short", labelKey: "settings.short" },
  { value: "medium", labelKey: "settings.medium" },
  { value: "long", labelKey: "settings.long" },
];

/** Week start and numbers, time and date formats (each previewed on a sample), timezone and region. */
export function CalendarSection() {
  const { t } = useTranslation();
  const {
    weekStartsOn,
    setWeekStartsOn,
    showWeekNumbers,
    setShowWeekNumbers,
    timeFormat,
    setTimeFormat,
    dateFormat,
    setDateFormat,
    timezone,
    setTimezone,
    region,
    setRegion,
  } = usePreferences();

  const deviceZone = resolveTimeZone("");
  const deviceRegionLabel = new Intl.DateTimeFormat().resolvedOptions().locale || deviceLanguage();

  const timezoneChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceZone },
    ...timeZoneOptions().map((z) => ({ value: z, label: z })),
  ];
  const regionChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceRegionLabel },
    ...REGION_OPTIONS.map((r) => ({ value: r.tag, label: r.label })),
  ];

  const sampleDate = useMemo(() => new Date(2026, 8, 3, 14, 30), []);
  const resolvedAutoTimeSample = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(region || undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone || undefined,
      }).format(sampleDate);
    } catch {
      return "14:30";
    }
  }, [sampleDate, region, timezone]);

  const timeFormatDesc = useMemo(() => {
    if (timeFormat === "auto") {
      return t("settings.timeFormatAutoDesc", { sample: resolvedAutoTimeSample });
    }
    if (timeFormat === "12h") {
      return t("settings.timeFormat12hDesc");
    }
    return t("settings.timeFormat24hDesc");
  }, [timeFormat, resolvedAutoTimeSample, t]);

  const sampleDateMap = useMemo(() => {
    const loc = region || undefined;
    const tz = timezone || undefined;
    try {
      return {
        auto: new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeZone: tz }).format(
          sampleDate,
        ),
        short: new Intl.DateTimeFormat(loc, { dateStyle: "short", timeZone: tz }).format(
          sampleDate,
        ),
        medium: new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeZone: tz }).format(
          sampleDate,
        ),
        long: new Intl.DateTimeFormat(loc, { dateStyle: "long", timeZone: tz }).format(sampleDate),
      };
    } catch {
      return {
        auto: "3 Sep 2026",
        short: "03/09/2026",
        medium: "3 Sep 2026",
        long: "3 September 2026",
      };
    }
  }, [sampleDate, region, timezone]);

  const dateFormatDesc = useMemo(() => {
    if (dateFormat === "auto") {
      return t("settings.dateFormatAutoDesc", { sample: sampleDateMap.auto });
    }
    if (dateFormat === "short") {
      return t("settings.dateFormatShortDesc", { sample: sampleDateMap.short });
    }
    if (dateFormat === "medium") {
      return t("settings.dateFormatMediumDesc", { sample: sampleDateMap.medium });
    }
    return t("settings.dateFormatLongDesc", { sample: sampleDateMap.long });
  }, [dateFormat, sampleDateMap, t]);

  return (
    <Section icon={CalendarClock} title={t("settings.calendarTime")}>
      <Row label={t("settings.weekStart")} description={t("settings.weekStartDesc")}>
        <Segmented
          value={weekStartsOn}
          options={[
            { value: 0, label: t("settings.sun") },
            { value: 1, label: t("settings.mon") },
          ]}
          onChange={setWeekStartsOn}
          label={t("settings.weekStart")}
        />
      </Row>
      <Toggle
        label={t("settings.showWeekNumbers")}
        description={t("settings.showWeekNumbersDesc")}
        value={showWeekNumbers}
        onValueChange={setShowWeekNumbers}
      />
      <Row label={t("settings.timeFormat")} description={timeFormatDesc}>
        <Segmented
          value={timeFormat}
          options={labelOptions(t, TIME_OPTIONS)}
          onChange={setTimeFormat}
          label={t("settings.timeFormat")}
        />
      </Row>
      <Row label={t("settings.dateFormat")} description={dateFormatDesc}>
        <Segmented
          value={dateFormat}
          options={labelOptions(t, DATE_OPTIONS)}
          onChange={setDateFormat}
          label={t("settings.dateFormat")}
        />
      </Row>
      <ListPicker
        label={t("settings.timezone")}
        description={t("settings.timezoneDesc")}
        value={timezone}
        options={timezoneChoices}
        onChange={setTimezone}
      />
      <ListPicker
        label={t("settings.region")}
        description={t("settings.regionDesc")}
        value={region}
        options={regionChoices}
        onChange={setRegion}
      />
    </Section>
  );
}
