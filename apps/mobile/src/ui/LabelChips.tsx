import { Text, View } from "react-native";
import type { Label } from "@atlastodo/client-core";

/** Read-only label chips (a coloured dot + name). `resolve` maps a label id to its label; unknown ids (e.g. a deleted label) are skipped. */
export function LabelChips({
  labelIds,
  resolve,
  className = "",
}: {
  labelIds: string[];
  resolve: (id: string) => Label | undefined;
  className?: string;
}) {
  const labels = labelIds.map(resolve).filter((l): l is Label => l != null);
  if (labels.length === 0) return null;
  return (
    <View className={"flex-row flex-wrap items-center gap-1 " + className}>
      {labels.map((l) => (
        <View
          key={l.id}
          className="flex-row items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800"
        >
          <View
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: l.color || "#6366f1" }}
          />
          <Text
            numberOfLines={1}
            className="max-w-[8rem] text-xs text-neutral-600 dark:text-neutral-300"
          >
            {l.name}
          </Text>
        </View>
      ))}
    </View>
  );
}
