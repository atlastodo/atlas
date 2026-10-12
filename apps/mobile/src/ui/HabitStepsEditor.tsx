import { useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_STEPS } from "@atlas/shared";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ChevronDown, ChevronUp, EllipsisVertical, Plus, Trash2 } from "./icons";
import type { MenuPos } from "../hooks/useContextMenu";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useToast } from "../data/ToastProvider";

/**
 * A habit's ordered steps. Reference only: a habit is one row per day (`derivedUuidV2(habit_id,
 * date)`), so ticking steps would need a second identity underneath. Reordering is Move up / Move
 * down in the row menu, not drag, since the detail screen is a `ScrollView`.
 */

/** Move `from` to `to`, or return the array unchanged when the move goes nowhere. */
function moveStep(steps: string[], from: number, to: number): string[] {
  if (to < 0 || to >= steps.length || from === to) return steps;
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

function StepRow({
  index,
  value,
  onCommit,
  onOpenActions,
}: {
  index: number;
  value: string;
  onCommit: (text: string) => void;
  onOpenActions: (pos: MenuPos) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const stored = useRef(value);
  if (stored.current !== value) {
    stored.current = value;
    setDraft(value);
  }

  const esc = useCancelOnEscape(() => setDraft(value));

  const commit = () => {
    // Escape blurs the field and this runs on blur too; the guard stops it saving the text Escape reverted.
    if (esc.consume()) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed);
  };

  return (
    <View className="flex-row items-center gap-2">
      <Text className="w-5 text-right text-xs tabular-nums text-neutral-500">{index + 1}.</Text>
      <TextInput
        accessibilityLabel={t("habits.stepLabel", { index: index + 1 })}
        ref={esc.ref}
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        onKeyPress={esc.onKeyPress}
        {...KEEP_FOCUS_SUBMIT}
        returnKeyType="done"
        className="flex-1 py-1 text-sm text-neutral-900 dark:text-neutral-100"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("habits.stepActions", { index: index + 1 })}
        onPress={(event) =>
          onOpenActions({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })
        }
        hitSlop={8}
        className="p-1"
      >
        <EllipsisVertical size={16} className="text-neutral-500" />
      </Pressable>
    </View>
  );
}

export function HabitStepsEditor({
  steps,
  onChange,
}: {
  steps: string[];
  onChange: (steps: string[]) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ index: number; pos: MenuPos } | null>(null);

  const esc = useCancelOnEscape(() => setDraft(""));

  const submit = () => {
    if (esc.consume()) return;
    const trimmed = draft.trim();
    if (!trimmed || steps.length >= MAX_STEPS) return;
    onChange([...steps, trimmed]);
    setDraft("");
  };

  const remove = (index: number) => {
    const previous = steps;
    onChange(steps.filter((_, i) => i !== index));
    toast.show(t("toast.stepRemoved"), { label: t("common.undo"), run: () => onChange(previous) });
  };

  const menuItems = (index: number): ContextMenuItem[] => [
    ...(index > 0
      ? [
          {
            key: "up",
            label: t("common.moveUp"),
            icon: ChevronUp,
            onPress: () => onChange(moveStep(steps, index, index - 1)),
          },
        ]
      : []),
    ...(index < steps.length - 1
      ? [
          {
            key: "down",
            label: t("common.moveDown"),
            icon: ChevronDown,
            onPress: () => onChange(moveStep(steps, index, index + 1)),
          },
        ]
      : []),
    {
      key: "delete",
      label: t("common.delete"),
      icon: Trash2,
      danger: true,
      onPress: () => remove(index),
    },
  ];

  return (
    <View className="gap-1">
      {steps.map((step, index) => (
        <StepRow
          // Index-keyed: steps are plain strings with no identity, and two rows can hold the same text.
          key={index}
          index={index}
          value={step}
          onCommit={(text) => onChange(steps.map((s, i) => (i === index ? text : s)))}
          onOpenActions={(pos) => setMenu({ index, pos })}
        />
      ))}

      {steps.length < MAX_STEPS && (
        <View className="flex-row items-center gap-2">
          <Plus size={16} className="text-neutral-500" />
          <TextInput
            accessibilityLabel={t("habits.addStep")}
            ref={esc.ref}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            onBlur={submit}
            onKeyPress={esc.onKeyPress}
            {...KEEP_FOCUS_SUBMIT}
            returnKeyType="done"
            placeholder={t("habits.addStep")}
            placeholderTextColor="#737373"
            className="flex-1 py-1 text-sm text-neutral-900 dark:text-neutral-100"
          />
        </View>
      )}

      {menu !== null && (
        <ContextMenu items={menuItems(menu.index)} pos={menu.pos} onClose={() => setMenu(null)} />
      )}
    </View>
  );
}
