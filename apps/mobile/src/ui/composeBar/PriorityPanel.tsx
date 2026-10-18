import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Priority } from "@atlastodo/client-core";
import { Flagged, Panel, SheetOption } from "./parts";

const PRIORITIES: Priority[] = [1, 2, 3, 4];

export function PriorityWebPanel({
  priority,
  pick,
  onBack,
}: {
  priority: Priority | null | undefined;
  pick: (patch: { priority: Priority }) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("taskDetail.priority")} onBack={onBack}>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        {PRIORITIES.map((level) => (
          <Pressable
            key={level}
            accessibilityRole="radio"
            accessibilityState={{ selected: priority === level }}
            accessibilityLabel={level === 4 ? t("taskDetail.priorityNone") : `P${level}`}
            onPress={() => pick({ priority: level })}
            className="grow flex-row items-center justify-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 web:cursor-pointer dark:border-neutral-800"
          >
            {level < 4 && <Flagged level={level} />}
            <Text className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {level === 4 ? t("taskDetail.priorityNone") : `P${level}`}
            </Text>
          </Pressable>
        ))}
      </View>
    </Panel>
  );
}

export function PrioritySheetBody({
  draftPriority,
  setDraftPriority,
}: {
  draftPriority: Priority | null;
  setDraftPriority: (level: Priority) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 pb-4">
      {PRIORITIES.map((level) => {
        const label =
          level === 4
            ? t("taskDetail.priorityNone")
            : (t("task.priority", { level }) ?? `P${level}`);
        const desc =
          level === 1
            ? t("taskDetail.priorityUrgent", "Urgent")
            : level === 2
              ? t("taskDetail.priorityHigh", "High")
              : level === 3
                ? t("taskDetail.priorityMedium", "Medium")
                : t("taskDetail.priorityNoneDesc", "No priority");
        const selected = draftPriority === level;
        return (
          <SheetOption
            key={level}
            role="radio"
            accessibilityState={{ selected }}
            label={level === 4 ? desc : `P${level}`}
            text={level === 4 ? desc : `${label} — ${desc}`}
            leading={<Flagged level={level} size={22} />}
            selected={selected}
            onPress={() => setDraftPriority(level)}
          />
        );
      })}
    </View>
  );
}
