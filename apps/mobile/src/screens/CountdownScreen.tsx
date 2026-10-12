import { type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { COUNTDOWN_PRESETS, countdownTo, presetTarget } from "@atlas/shared";
import { CalendarClock, X } from "../ui/icons";
import { useCountdownPresets } from "../hooks/useCountdownPresets";
import { usePreferences } from "../hooks/usePreferences";
import { useFormat } from "../hooks/useFormat";
import { useNow } from "../hooks/useNow";
import { ScreenFade } from "../ui/ScreenFade";
import { EmptyState } from "../ui/EmptyState";

/**
 * Countdown-to-deadline widgets: synthetic presets (the weekend, month end, year end) to count
 * down to without a task. Ticks every second via {@link useNow}; duration maths in `@atlas/shared`'s
 * `countdown` handles timezone/DST. Gated behind the `countdowns` flag at the route.
 */

function CountdownCard({
  title,
  subtitle,
  targetAt,
  now,
  trailing,
}: {
  title: string;
  subtitle: string;
  targetAt: number;
  now: number;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const c = countdownTo(targetAt, now);
  const display =
    c.remaining === 0
      ? t("countdown.dueNow")
      : c.overdue
        ? t("countdown.overdueBy", { magnitude: c.magnitude })
        : c.magnitude;
  return (
    <View
      className={
        "flex-row items-center justify-between gap-4 rounded-lg border p-4 " +
        (c.overdue
          ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900")
      }
    >
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className="text-sm font-medium text-neutral-800 dark:text-neutral-100"
        >
          {title}
        </Text>
        <Text className="mt-0.5 text-xs text-neutral-500">{subtitle}</Text>
      </View>
      <View className="flex-row shrink-0 items-center gap-3">
        <Text
          className={
            "text-lg font-semibold " +
            (c.overdue ? "text-red-600 dark:text-red-400" : "text-neutral-900 dark:text-neutral-50")
          }
        >
          {display}
        </Text>
        {trailing}
      </View>
    </View>
  );
}

export function CountdownScreen({ now: nowOverride }: { now?: number }) {
  const { t } = useTranslation();
  const { isEnabled, toggle: togglePreset } = useCountdownPresets();
  const { timezone } = usePreferences();
  const fmt = useFormat();
  const tick = useNow(1000);
  const now = nowOverride ?? tick;

  const enabledPresets = COUNTDOWN_PRESETS.filter((id) => isEnabled(id));

  return (
    <ScreenFade>
      <ScrollView
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerClassName="gap-6 p-4"
      >
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {t("countdown.presets")}
          </Text>
          {COUNTDOWN_PRESETS.map((id) => {
            const on = isEnabled(id);
            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t(`countdown.preset.${id}`)}
                onPress={() => togglePreset(id)}
                className={
                  "rounded-full border px-2.5 py-1 " +
                  (on
                    ? "border-accent-600 bg-accent-600"
                    : "border-neutral-200 dark:border-neutral-700")
                }
              >
                <Text className={"text-xs " + (on ? "text-white" : "text-neutral-500")}>
                  {t(`countdown.preset.${id}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {enabledPresets.length > 0 ? (
          <View className="gap-3">
            {enabledPresets.map((id) => {
              const target = presetTarget(id, now, timezone);
              return (
                <CountdownCard
                  key={id}
                  title={t(`countdown.preset.${id}`)}
                  subtitle={fmt.dateTime(target)}
                  targetAt={target}
                  now={now}
                  trailing={
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("countdown.disablePreset")}
                      onPress={() => togglePreset(id)}
                      className="rounded p-1"
                    >
                      <X size={16} className="text-neutral-500" />
                    </Pressable>
                  }
                />
              );
            })}
          </View>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title={t("countdown.empty")}
            description={t("countdown.emptyHint")}
          />
        )}
      </ScrollView>
    </ScreenFade>
  );
}
