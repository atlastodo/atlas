import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Label } from "@atlastodo/client-core";
import { useLabels } from "../hooks/useLabels";
import { Plus, Tag, X } from "./icons";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";

/**
 * Edit a task's labels. Current labels are removable chips; a filter input adds an existing label
 * or creates one. Persists via `onChange(newLabelIds)`.
 */
export function LabelPicker({
  labelIds,
  onChange,
}: {
  labelIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { labels, byId, createLabel } = useLabels();
  const [query, setQuery] = useState("");
  const escapeQuery = useCancelOnEscape(() => setQuery(""));

  const selected = labelIds.map(byId).filter((l): l is Label => l != null);
  const q = query.trim().toLowerCase();
  const available = labels.filter(
    (l) => !labelIds.includes(l.id) && l.name.toLowerCase().includes(q),
  );
  const exactExists = labels.some((l) => l.name.toLowerCase() === q);

  const add = (id: string) => onChange([...labelIds, id]);
  const remove = (id: string) => onChange(labelIds.filter((x) => x !== id));
  const create = () => {
    const name = query.trim();
    if (!name || exactExists) return;
    const id = createLabel(name);
    onChange([...labelIds, id]);
    setQuery("");
  };

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-1">
        {selected.length === 0 && (
          <Text className="text-xs text-neutral-500">{t("label.none")}</Text>
        )}
        {selected.map((l) => (
          <View
            key={l.id}
            className="flex-row items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800"
          >
            <View
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: l.color || "#6366f1" }}
            />
            <Text className="text-xs text-neutral-700 dark:text-neutral-200">{l.name}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("label.remove", { name: l.name })}
              onPress={() => remove(l.id)}
              hitSlop={8}
              className="web:cursor-pointer"
            >
              <X size={12} className="text-neutral-500" />
            </Pressable>
          </View>
        ))}
      </View>

      <TextInput
        ref={escapeQuery.ref}
        accessibilityLabel={t("label.add")}
        placeholder={t("label.addPlaceholder")}
        placeholderTextColor="#737373"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => {
          if (available.length > 0) add(available[0]!.id);
          else create();
          setQuery("");
        }}
        onKeyPress={escapeQuery.onKeyPress}
        {...KEEP_FOCUS_SUBMIT}
        className="rounded border border-neutral-200 bg-transparent px-2 py-1 text-sm text-neutral-900 focus:border-accent-400 dark:border-neutral-700 dark:text-neutral-100"
      />

      {(available.length > 0 || (q !== "" && !exactExists)) && (
        <View className="flex-row flex-wrap gap-1">
          {available.map((l) => (
            <Pressable
              key={l.id}
              accessibilityRole="button"
              accessibilityLabel={l.name}
              onPress={() => {
                add(l.id);
                setQuery("");
              }}
              className="flex-row items-center gap-1 rounded border border-neutral-200 px-1.5 py-0.5 dark:border-neutral-700 web:cursor-pointer"
            >
              <Tag size={12} color={l.color || "#6366f1"} />
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">{l.name}</Text>
            </Pressable>
          ))}
          {q !== "" && !exactExists && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("label.create", { name: query.trim() })}
              onPress={create}
              className="flex-row items-center gap-1 rounded border border-dashed border-neutral-300 px-1.5 py-0.5 dark:border-neutral-600 web:cursor-pointer"
            >
              <Plus size={12} className="text-neutral-500" />
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                {t("label.create", { name: query.trim() })}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
