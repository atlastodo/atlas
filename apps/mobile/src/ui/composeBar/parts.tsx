import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { PRIORITY_COLOR, type ChipKind } from "@atlas/shared";
import type { Priority } from "@atlas/client-core";
import { CHIP_ICON, chipColors } from "../chips";
import { Check, ChevronLeft, ChevronRight, X } from "../icons";

export type PanelKind = "due" | "priority" | "project" | "label" | "recurrence";

/** One chip. The label is the field ("Due date") and the value what it reads ("Tomorrow"); it takes its kind's colour only once it has a value. */
export function ChipButton({
  kind,
  field,
  value,
  onPress,
  onRemove,
  removeLabel,
}: {
  kind: ChipKind;
  field: string;
  value?: string | null;
  onPress: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const Icon = CHIP_ICON[kind];
  const c = chipColors(kind);
  const set = value != null;
  const isWeb = Platform.OS === "web";
  if (!onRemove) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={field}
        accessibilityValue={set ? { text: value } : undefined}
        onPress={onPress}
        hitSlop={6}
        className={
          "flex-row items-center gap-1.5 active:opacity-75 border " +
          (isWeb ? "rounded-full px-2.5 py-1 web:cursor-pointer " : "rounded-full px-3.5 py-2 ") +
          (set ? c.chip : "border-slate-300/80 bg-white dark:border-slate-700/80 dark:bg-zinc-900")
        }
      >
        <Icon
          size={isWeb ? 13 : 17}
          className={set ? c.text : "text-slate-500 dark:text-slate-400"}
        />
        <Text
          className={
            (isWeb ? "text-xs " : "text-sm ") +
            "font-medium " +
            (set ? c.text : "text-slate-700 dark:text-slate-200")
          }
        >
          {value ?? field}
        </Text>
      </Pressable>
    );
  }

  return (
    <View
      className={
        "flex-row items-center gap-1.5 border " +
        (isWeb ? "rounded-full px-2.5 py-1 " : "rounded-full px-3.5 py-2 ") +
        (set ? c.chip : "border-slate-300/80 bg-white dark:border-slate-700/80 dark:bg-zinc-900")
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={field}
        accessibilityValue={set ? { text: value } : undefined}
        onPress={onPress}
        hitSlop={6}
        className="flex-row items-center gap-1.5 active:opacity-75 web:cursor-pointer"
      >
        <Icon
          size={isWeb ? 13 : 17}
          className={set ? c.text : "text-slate-500 dark:text-slate-400"}
        />
        <Text
          className={
            (isWeb ? "text-xs " : "text-sm ") +
            "font-medium " +
            (set ? c.text : "text-slate-700 dark:text-slate-200")
          }
        >
          {value ?? field}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={removeLabel ?? ""}
        onPress={(e) => {
          e?.stopPropagation?.();
          onRemove();
        }}
        hitSlop={isWeb ? 6 : 10}
        className="web:cursor-pointer ml-0.5"
      >
        <X size={isWeb ? 12 : 15} className={set ? c.text : "text-slate-500 dark:text-slate-400"} />
      </Pressable>
    </View>
  );
}

/** An expanded field: its name, a way back to the chips, and the options themselves. */
export function Panel({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isWeb = Platform.OS === "web";
  return (
    <View className={isWeb ? "gap-2" : "gap-3"}>
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          onPress={onBack}
          hitSlop={isWeb ? 8 : 10}
          className="web:cursor-pointer"
        >
          <ChevronLeft size={isWeb ? 14 : 18} className="text-neutral-500" />
        </Pressable>
        <Text
          className={
            (isWeb ? "text-xs " : "text-base ") +
            "font-semibold text-neutral-600 dark:text-neutral-300"
          }
        >
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

export function PanelButton({
  label,
  onPress,
  muted = false,
}: {
  label: string;
  onPress: () => void;
  muted?: boolean;
}) {
  const isWeb = Platform.OS === "web";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={
        "grow border border-neutral-200 web:cursor-pointer dark:border-neutral-800 " +
        (isWeb ? "rounded-md px-2.5 py-1.5" : "rounded-xl px-4 py-3")
      }
    >
      <Text
        className={
          "text-center font-medium " +
          (isWeb ? "text-xs " : "text-base ") +
          (muted ? "text-neutral-500" : "text-neutral-600 dark:text-neutral-300")
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A scrolling list for unbounded panels, capped so the bar never swallows the list below. `keyboardShouldPersistTaps` because the title field still has the keyboard up. */
export function PanelList({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      className="max-h-48 rounded-lg border border-neutral-200 dark:border-neutral-800"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function ListRow({
  label,
  color,
  selected,
  chevron,
  onPress,
}: {
  label: string;
  color?: string;
  selected: boolean;
  chevron?: boolean;
  onPress: () => void;
}) {
  const isWeb = Platform.OS === "web";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      className={
        "flex-row items-center gap-2 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800 " +
        (isWeb ? "px-2.5 py-2" : "px-3 py-2.5")
      }
    >
      {color != null && (
        <View className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
      )}
      <Text
        className={
          "flex-1 font-medium text-neutral-900 dark:text-neutral-100 " +
          (isWeb ? "text-xs" : "text-sm")
        }
      >
        {label}
      </Text>
      {selected && <Check size={isWeb ? 14 : 16} className="text-accent-600" />}
      {chevron && <ChevronRight size={isWeb ? 14 : 16} className="text-neutral-500" />}
    </Pressable>
  );
}

/** The priority flag in that level's colour. */
export function Flagged({ level, size = 14 }: { level: Priority; size?: number }) {
  const Icon = CHIP_ICON.priority;
  return <Icon size={size} className={PRIORITY_COLOR[level] ?? ""} />;
}

const CARD_ON =
  "border-accent-600 bg-accent-100 dark:bg-accent-950 active:bg-accent-200 dark:active:bg-neutral-800";
const CARD_OFF =
  "border-neutral-200 bg-neutral-50/50 active:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/40 dark:active:bg-neutral-800";
const ACCENT_TEXT = "text-accent-600 dark:text-accent-400";

/** A full-width option card in the mobile sheet; a check closes the row when it is selected. */
export function SheetOption({
  label,
  accessibilityLabel,
  text = label,
  selected,
  onPress,
  role = "button",
  accessibilityState,
  icon: Icon,
  leading,
  trailing,
}: {
  label: string;
  accessibilityLabel?: string;
  text?: string;
  selected: boolean;
  onPress: () => void;
  role?: "button" | "radio" | "checkbox";
  accessibilityState?: { selected?: boolean; checked?: boolean };
  icon?: LucideIcon;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const lead =
    leading ??
    (Icon ? (
      <Icon
        size={22}
        className={selected ? ACCENT_TEXT : "text-neutral-500 dark:text-neutral-400"}
      />
    ) : null);
  const textNode = (
    <Text
      className={
        "text-base font-semibold " +
        (selected ? ACCENT_TEXT : "text-neutral-800 dark:text-neutral-200")
      }
    >
      {text}
    </Text>
  );
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className={
        "flex-row items-center justify-between rounded-2xl border p-4 " +
        (selected ? CARD_ON : CARD_OFF)
      }
    >
      {lead ? (
        <View className="flex-row items-center gap-3">
          {lead}
          {textNode}
        </View>
      ) : (
        textNode
      )}
      {trailing ?? (selected && <Check size={20} className={ACCENT_TEXT} />)}
    </Pressable>
  );
}

/** The "new project" / "new label" input with its Create button; `compact` is the inline web panel. */
export function NewItemRow({
  compact,
  icon: Icon,
  accessibilityLabel,
  placeholder,
  value,
  onChangeText,
  onSubmit,
  autoCapitalize,
  onEscape,
}: {
  compact: boolean;
  icon: LucideIcon;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  autoCapitalize?: "none" | "words";
  onEscape?: () => void;
}) {
  const { t } = useTranslation();
  const ready = value.trim().length > 0;
  const create = t("common.create") ?? "Create";
  return (
    <View
      className={
        compact
          ? "mb-2 flex-row items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50/60 p-1.5 dark:border-neutral-700 dark:bg-neutral-800/40"
          : "flex-row items-center gap-2.5 rounded-2xl border-2 border-neutral-300 bg-neutral-50 p-2.5 dark:border-neutral-700 dark:bg-neutral-800"
      }
    >
      {compact ? (
        <Icon size={14} className="ml-1 text-neutral-500" />
      ) : (
        <View className="pl-1">
          <Icon size={22} className="text-neutral-500 dark:text-neutral-400" />
        </View>
      )}
      <TextInput
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#737373"
        autoCapitalize={compact ? undefined : autoCapitalize}
        onSubmitEditing={onSubmit}
        returnKeyType={compact ? undefined : "done"}
        // react-native-web stops key events in an input before the panel's window listener.
        onKeyPress={onEscape ? (e) => e.nativeEvent.key === "Escape" && onEscape() : undefined}
        className={
          compact
            ? "flex-1 px-1 py-0.5 text-xs text-neutral-900 dark:text-neutral-100"
            : "flex-1 py-1 text-base font-medium text-neutral-900 dark:text-neutral-50"
        }
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={create}
        onPress={onSubmit}
        disabled={!ready}
        className={
          (compact ? "rounded px-2 py-1 web:cursor-pointer " : "rounded-xl px-4 py-2 ") +
          (ready
            ? "bg-accent-600 active:bg-accent-700"
            : "bg-neutral-200 dark:bg-neutral-700 " + (compact ? "opacity-50" : "opacity-60"))
        }
      >
        <Text
          className={
            (compact ? "text-xs font-semibold " : "text-sm font-bold ") +
            (ready ? "text-white" : "text-neutral-500 dark:text-neutral-400")
          }
        >
          {create}
        </Text>
      </Pressable>
    </View>
  );
}
