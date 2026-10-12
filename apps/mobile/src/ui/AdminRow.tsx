import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "./icons";

/**
 * A tappable admin list row inside a card: a title line with its badges right beside it, a muted
 * detail line, and a chevron to the detail sheet. `first` drops the divider the card's edge replaces.
 */
export function AdminRow({
  title,
  badges,
  detail,
  first,
  onPress,
}: {
  title: string;
  badges?: ReactNode;
  detail: string;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={
        "flex-row items-center gap-3 py-3 web:cursor-pointer " +
        (first ? "" : "border-t border-neutral-200/50 dark:border-neutral-800/60")
      }
    >
      <View className="flex-1 gap-1">
        <View className="flex-row flex-wrap items-center gap-2">
          <Text
            numberOfLines={1}
            className="shrink text-sm font-medium text-neutral-900 dark:text-neutral-100"
          >
            {title}
          </Text>
          {badges}
        </View>
        <Text numberOfLines={2} className="text-xs text-neutral-500 dark:text-neutral-400">
          {detail}
        </Text>
      </View>
      <ChevronRight size={16} className="text-neutral-500 dark:text-neutral-400" />
    </Pressable>
  );
}

const BADGE_TONES = {
  accent: "bg-accent-50 dark:bg-accent-950/60",
  red: "bg-red-50 dark:bg-red-950/40",
  amber: "bg-amber-50 dark:bg-amber-950/40",
  green: "bg-green-50 dark:bg-green-950/40",
} as const;

const BADGE_TEXT = {
  accent: "text-accent-700 dark:text-accent-300",
  red: "text-red-700 dark:text-red-300",
  amber: "text-amber-700 dark:text-amber-300",
  green: "text-green-700 dark:text-green-300",
} as const;

/** A small status pill for an {@link AdminRow} title line (role, disabled, resolved...). */
export function AdminBadge({ label, tone }: { label: string; tone: keyof typeof BADGE_TONES }) {
  return (
    <View className={"rounded-full px-2 py-0.5 " + BADGE_TONES[tone]}>
      <Text className={"text-[11px] font-medium " + BADGE_TEXT[tone]}>{label}</Text>
    </View>
  );
}

/** The card an admin list sits in: the same surface as a Settings section. */
export const ADMIN_CARD =
  "rounded-2xl border border-neutral-200/80 bg-neutral-50/70 px-4 dark:border-neutral-800 dark:bg-zinc-900/60";
