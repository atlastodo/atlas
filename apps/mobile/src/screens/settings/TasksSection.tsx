import { Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { SMART_VIEWS, type SmartView, type TaskSwipeAction } from "@atlastodo/shared";
import { usePreferences } from "../../hooks/usePreferences";
import { ListPicker, type PickerOption } from "../../ui/ListPicker";
import { Section } from "../../ui/Section";
import { Toggle } from "../../ui/Toggle";
import { ListChecks } from "../../ui/icons";

/** The smart lists offered as a landing view (Completed is history, a poor place to land). */
const DEFAULT_VIEW_CHOICES: SmartView[] = SMART_VIEWS.filter((v) => v !== "completed");

const TOAST_DURATION_OPTIONS: PickerOption<string>[] = [
  { value: "2", label: "2s" },
  { value: "3", label: "3s" },
  { value: "5", label: "5s" },
  { value: "6", label: "6s" },
  { value: "8", label: "8s" },
  { value: "10", label: "10s" },
];

/** The landing view, swipe gestures, toast length, smart dates and haptics. */
export function TasksSection() {
  const { t } = useTranslation();
  const {
    defaultView,
    setDefaultView,
    swipeRightAction,
    setSwipeRightAction,
    swipeLeftAction,
    setSwipeLeftAction,
    toastDuration,
    setToastDuration,
    smartDatesEnabled,
    setSmartDatesEnabled,
    hapticsEnabled,
    setHapticsEnabled,
  } = usePreferences();

  const viewOptions: PickerOption<SmartView>[] = DEFAULT_VIEW_CHOICES.map((v) => ({
    value: v,
    label: t(`nav.${v}`),
  }));

  const swipeActionOptions: PickerOption<TaskSwipeAction>[] = [
    { value: "indent", label: t("settings.swipeActionIndent") },
    { value: "complete", label: t("settings.swipeActionComplete") },
    { value: "schedule", label: t("settings.swipeActionSchedule") },
    { value: "delete", label: t("settings.swipeActionDelete") },
    { value: "none", label: t("settings.swipeActionNone") },
  ];

  return (
    <Section icon={ListChecks} title={t("settings.tasksGestures")}>
      <ListPicker
        label={t("settings.defaultView")}
        description={t("settings.defaultViewDesc")}
        value={defaultView}
        options={viewOptions}
        onChange={setDefaultView}
      />
      <ListPicker
        label={t("settings.swipeRight")}
        description={t("settings.swipeRightDesc")}
        value={swipeRightAction}
        options={swipeActionOptions}
        onChange={setSwipeRightAction}
      />
      <ListPicker
        label={t("settings.swipeLeft")}
        description={t("settings.swipeLeftDesc")}
        value={swipeLeftAction}
        options={swipeActionOptions}
        onChange={setSwipeLeftAction}
      />
      <ListPicker
        label={t("settings.toastDuration")}
        description={t("settings.toastDurationDesc")}
        value={String(toastDuration)}
        options={TOAST_DURATION_OPTIONS}
        onChange={(val) => setToastDuration(Number(val))}
      />
      <Toggle
        label={t("settings.smartDates")}
        description={t("settings.smartDatesDesc")}
        value={smartDatesEnabled}
        onValueChange={setSmartDatesEnabled}
      />
      {Platform.OS !== "web" && (
        <Toggle
          label={t("settings.haptics")}
          description={t("settings.hapticsDesc")}
          value={hapticsEnabled}
          onValueChange={setHapticsEnabled}
        />
      )}
    </Section>
  );
}
