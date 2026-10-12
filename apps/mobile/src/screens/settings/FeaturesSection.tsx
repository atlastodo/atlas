import { useState } from "react";
import { TextInput } from "react-native";
import { useTranslation } from "react-i18next";
import type { PomodoroConfig } from "@atlas/shared";
import { usePreferences } from "../../hooks/usePreferences";
import { usePomodoroConfig } from "../../hooks/usePomodoroConfig";
import { Row, Section } from "../../ui/Section";
import { Toggle } from "../../ui/Toggle";
import { SlidersHorizontal } from "../../ui/icons";

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  // Buffered as text: a controlled numeric input cannot represent "" or a half-typed value.
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(text));
    // A zero or invalid phase would never run; snap back.
    if (Number.isFinite(n) && n >= 1) onChange(n);
    else setText(String(value));
  };
  return (
    <Row label={label}>
      <TextInput
        accessibilityLabel={label}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        returnKeyType="done"
        className="w-20 rounded border border-neutral-200 px-2.5 py-1.5 text-right text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
      />
    </Row>
  );
}

/** The optional features' switches, and the Pomodoro lengths while the focus timer is on. */
export function FeaturesSection() {
  const { t } = useTranslation();
  const {
    focusEnabled,
    setFocusEnabled,
    focusSoundEnabled,
    setFocusSoundEnabled,
    habitsEnabled,
    setHabitsEnabled,
    countdownsEnabled,
    setCountdownsEnabled,
    statsEnabled,
    setStatsEnabled,
  } = usePreferences();
  const { config, setConfig } = usePomodoroConfig();

  const setPomodoro = (key: keyof PomodoroConfig) => (value: number) => setConfig({ [key]: value });

  return (
    <>
      <Section icon={SlidersHorizontal} title={t("settings.features")}>
        <Toggle
          label={t("settings.focus")}
          description={t("settings.focusDesc")}
          value={focusEnabled}
          onValueChange={setFocusEnabled}
        />
        <Toggle
          label={t("settings.countdowns")}
          description={t("settings.countdownsDesc")}
          value={countdownsEnabled}
          onValueChange={setCountdownsEnabled}
        />
        <Toggle
          label={t("settings.habits")}
          description={t("settings.habitsDesc")}
          value={habitsEnabled}
          onValueChange={setHabitsEnabled}
        />
        <Toggle
          label={t("settings.stats")}
          description={t("settings.statsDesc")}
          value={statsEnabled}
          onValueChange={setStatsEnabled}
        />
      </Section>
      {focusEnabled && (
        <Section icon={SlidersHorizontal} title={t("settings.pomodoro")}>
          <NumberField
            key={`work-${config.workMin}`}
            label={t("settings.focusLength")}
            value={config.workMin}
            onChange={setPomodoro("workMin")}
          />
          <NumberField
            key={`short-${config.shortBreakMin}`}
            label={t("settings.shortBreak")}
            value={config.shortBreakMin}
            onChange={setPomodoro("shortBreakMin")}
          />
          <NumberField
            key={`long-${config.longBreakMin}`}
            label={t("settings.longBreak")}
            value={config.longBreakMin}
            onChange={setPomodoro("longBreakMin")}
          />
          <NumberField
            key={`every-${config.longBreakEvery}`}
            label={t("settings.longBreakEvery")}
            value={config.longBreakEvery}
            onChange={setPomodoro("longBreakEvery")}
          />
          <Toggle
            label={t("settings.focusSound")}
            description={t("settings.focusSoundDesc")}
            value={focusSoundEnabled}
            onValueChange={setFocusSoundEnabled}
          />
        </Section>
      )}
    </>
  );
}
