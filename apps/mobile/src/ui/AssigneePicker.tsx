import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { useProjectMembers } from "../hooks/useProjectMembers";
import { UserRound } from "./icons";

/**
 * Assign a task to one of its project's members. Shown only for a task in a shared project;
 * assignments are validated server-side. Member chips plus an "Unassigned" chip to clear.
 */

export function AssigneePicker({
  task,
  onUpdate,
}: {
  task: Task;
  onUpdate: (task: Task, patch: Partial<Task>) => void;
}) {
  const { t } = useTranslation();
  const { forProject } = useProjectMembers();
  const members = task.project_id ? forProject(task.project_id) : [];

  if (members.length === 0) return null;

  const options: { id: string | null; label: string }[] = [
    { id: null, label: t("assignee.unassigned") },
    ...members.map((m) => ({ id: m.user_id, label: m.display_name || m.email })),
  ];

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <UserRound size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("assignee.heading")}</Text>
      </View>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = (task.assignee_id ?? null) === opt.id;
          return (
            <Pressable
              key={opt.id ?? "__none__"}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
              onPress={() => onUpdate(task, { assignee_id: opt.id })}
              className={
                "rounded-md border px-2.5 py-1.5 " +
                (active
                  ? "border-accent-600 bg-accent-50 dark:bg-accent-900"
                  : "border-neutral-200 dark:border-neutral-800")
              }
            >
              <Text
                className={
                  "text-xs " +
                  (active
                    ? "text-accent-700 dark:text-accent-300"
                    : "text-neutral-600 dark:text-neutral-300")
                }
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
