import type { ReactNode } from "react";
import { Platform, Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CircleAlert, type LucideIcon } from "../../ui/icons";

/** Building blocks several Settings sections share. */

/** Translates a static option list's label keys, for a `Segmented` control. */
export function labelOptions<T extends string | number>(
  t: TFunction,
  opts: { value: T; labelKey: string }[],
): { value: T; label: string }[] {
  return opts.map((o) => ({ value: o.value, label: t(o.labelKey) }));
}

/** A Settings row's secondary button: a label, pressed to act. */
export function RowButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="rounded-md border border-neutral-200 px-3 py-2 web:cursor-pointer dark:border-neutral-800"
    >
      <Text className="text-sm text-neutral-600 dark:text-neutral-300">{label}</Text>
    </Pressable>
  );
}

/**
 * A masked password field for the account forms. No fixed width: a stacked phone row stretches it
 * to the card's width, a side-by-side row gives it its minimum.
 */
export function PasswordInput(props: TextInputProps) {
  return (
    <TextInput
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor="#737373"
      className="min-w-56 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-zinc-900 dark:text-neutral-100"
      {...props}
    />
  );
}

/** A section's irreversible actions, in their own red-edged card below the everyday ones. */
export function DangerZone({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center gap-2 px-1">
        <CircleAlert
          size={Platform.OS === "web" ? 16 : 18}
          className="text-red-600 dark:text-red-400"
        />
        <Text className="text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
          {t("settings.dangerZone")}
        </Text>
      </View>
      <View className="overflow-hidden rounded-2xl border border-red-200 bg-red-50/40 px-4 py-1 dark:border-red-900/60 dark:bg-red-950/20">
        {children}
      </View>
    </View>
  );
}

export function DangerButton({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        "flex-row items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 active:bg-red-100 dark:border-red-900/50 dark:bg-red-950/30 dark:active:bg-red-950/60 " +
        (disabled ? "opacity-60" : "")
      }
    >
      <Icon size={18} className="text-red-600 dark:text-red-400" />
      <Text className="text-sm font-medium text-red-600 dark:text-red-400">{label}</Text>
    </Pressable>
  );
}
