import { Pressable, Text, View } from "react-native";
import type { LucideIcon } from "./icons";

/**
 * The one "there is nothing here" panel: icon, title, an optional hint and optional ways out. Every
 * empty list and dead-end screen uses it, so they all sit at the same height: top-aligned at a fixed
 * offset below whatever the screen shows above it (a header, quick-add, a toolbar), never centred,
 * since centring in a tall pane strands the message far from the controls it refers to.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions = [],
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: { label: string; onPress: () => void; primary?: boolean }[];
}) {
  return (
    <View className="flex-1 items-center bg-white px-8 pb-8 pt-16 dark:bg-zinc-950">
      <Icon size={32} className="text-neutral-500 dark:text-neutral-400" />
      <Text className="mt-4 max-w-sm text-center text-base font-medium text-neutral-700 dark:text-neutral-200">
        {title}
      </Text>
      {description ? (
        <Text className="mt-2 max-w-sm text-center text-sm text-neutral-500 dark:text-neutral-400">
          {description}
        </Text>
      ) : null}
      {actions.length > 0 ? (
        // Side by side when they fit, wrapping on a narrow phone; each sized to its label.
        <View className="mt-6 flex-row flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole="button"
              onPress={action.onPress}
              className={`min-w-32 items-center rounded-lg border px-5 py-3 web:cursor-pointer ${
                action.primary
                  ? "border-accent-600 bg-accent-600 active:bg-accent-700"
                  : "border-neutral-200 active:bg-neutral-100 dark:border-neutral-800 dark:active:bg-neutral-900"
              }`}
            >
              <Text
                className={`text-sm font-medium ${
                  action.primary ? "text-white" : "text-neutral-700 dark:text-neutral-200"
                }`}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
