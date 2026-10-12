import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { PROJECT_COLORS } from "@atlas/shared";
import type { Label } from "@atlas/client-core";
import { useLabels } from "../hooks/useLabels";
import { useToast } from "../data/ToastProvider";
import { Plus, Trash2 } from "./icons";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";

/** Manage labels as a Settings section: create, rename, recolor or delete. Delete soft-deletes to Trash with an undo toast. */
export function LabelsManager() {
  const { t } = useTranslation();
  const { labels, createLabel } = useLabels();
  const [draft, setDraft] = useState("");

  const addLabel = () => {
    const name = draft.trim();
    if (!name) return;
    // No duplicate of an existing label name (case-insensitive).
    if (!labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) createLabel(name);
    setDraft("");
  };
  const escapeDraft = useCancelOnEscape(() => setDraft(""));

  return (
    <View className="gap-1 py-1">
      <View className="mb-1 flex-row items-center gap-1">
        <Plus size={16} className="text-neutral-500" />
        <TextInput
          ref={escapeDraft.ref}
          accessibilityLabel={t("label.add")}
          placeholder={t("label.newPlaceholder")}
          placeholderTextColor="#737373"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addLabel}
          onKeyPress={escapeDraft.onKeyPress}
          {...KEEP_FOCUS_SUBMIT}
          className="flex-1 rounded border border-transparent bg-transparent px-1 py-1 text-sm text-neutral-900 focus:border-accent-400 dark:text-neutral-100"
        />
      </View>
      {labels.length === 0 ? (
        <Text className="py-1 text-sm text-neutral-500">{t("label.empty")}</Text>
      ) : (
        labels.map((l) => <LabelRow key={l.id} label={l} />)
      )}
    </View>
  );
}

function LabelRow({ label }: { label: Label }) {
  const { t } = useTranslation();
  const { updateLabel, removeLabel } = useLabels();
  const toast = useToast();
  const [name, setName] = useState(label.name);
  const [pickOpen, setPickOpen] = useState(false);
  const color = label.color || "#6366f1";

  useEffect(() => setName(label.name), [label.name]);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== label.name) updateLabel(label.id, { name: trimmed });
    else setName(label.name);
  };

  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("label.color", { name: label.name })}
          onPress={() => setPickOpen((o) => !o)}
          className="h-4 w-4 rounded-full border border-neutral-300 dark:border-neutral-600 web:cursor-pointer"
          style={{ backgroundColor: color }}
        />
        <TextInput
          accessibilityLabel={t("label.rename", { name: label.name })}
          value={name}
          onChangeText={setName}
          onBlur={commit}
          onSubmitEditing={commit}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 text-sm text-neutral-900 focus:border-accent-400 dark:text-neutral-100"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("label.delete", { name: label.name })}
          onPress={() => {
            const undo = removeLabel(label.id);
            toast.show(t("toast.labelDeleted"), { label: t("common.undo"), run: undo });
          }}
          hitSlop={8}
          className="rounded p-1 web:cursor-pointer"
        >
          <Trash2 size={16} className="text-neutral-500" />
        </Pressable>
      </View>
      {pickOpen && (
        <View className="ml-6 flex-row flex-wrap gap-1.5 pb-1">
          {PROJECT_COLORS.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityLabel={c}
              onPress={() => {
                updateLabel(label.id, { color: c });
                setPickOpen(false);
              }}
              style={{ backgroundColor: c }}
              className={
                "h-5 w-5 rounded-full border web:cursor-pointer " +
                (color.toLowerCase() === c.toLowerCase()
                  ? "border-neutral-900 dark:border-white"
                  : "border-transparent")
              }
            />
          ))}
        </View>
      )}
    </View>
  );
}
