import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { EntityKind } from "@atlas/client-core";
import type { TrashItem } from "@atlas/shared";
import { useTrash } from "../hooks/useTrash";
import { useFormat } from "../hooks/useFormat";
import { useToast } from "../data/ToastProvider";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { RotateCcw, Trash2, X } from "../ui/icons";

/**
 * Recently Deleted / Trash: items soft-deleted within the last 30 days, across entity kinds. Each
 * can be restored (a container brings its children back) or permanently deleted; anything past 30
 * days is swept on app launch. Rules are in `@atlas/shared`'s `trash.ts`.
 */

const KIND_LABEL: Record<string, string> = {
  task: "trash.kind.task",
  project: "trash.kind.project",
  section: "trash.kind.section",
  saved_filter: "trash.kind.filter",
  habit: "trash.kind.habit",
  comment: "trash.kind.comment",
  reminder: "trash.kind.reminder",
  attachment: "trash.kind.attachment",
};

export function TrashScreen() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const toast = useToast();
  const { items, restore, purgeItem, purgeAll } = useTrash();
  const [confirming, setConfirming] = useState(false);
  // Awaiting the confirm: the purge is a tombstone, irreversible and applied for every member of a shared project.
  const [purging, setPurging] = useState<TrashItem | null>(null);

  if (items.length === 0) {
    return <EmptyState icon={Trash2} title={t("trash.empty")} description={t("trash.emptyHint")} />;
  }

  return (
    <View className="flex-1 bg-white dark:bg-zinc-950">
      <View className="flex-row items-center justify-between border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
        <Text className="flex-1 pr-2 text-xs text-neutral-500">{t("trash.retentionNote")}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("trash.emptyTrash")}
          onPress={() => setConfirming(true)}
          className="flex-row items-center gap-1 rounded-md bg-red-50 px-2.5 py-1.5 active:bg-red-100 dark:bg-red-950/40 dark:active:bg-red-950/60"
        >
          <Trash2 size={13} className="text-red-600 dark:text-red-400" />
          <Text className="text-xs font-medium text-red-600 dark:text-red-400">
            {t("trash.emptyTrash")}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={items}
        keyExtractor={(it) => `${it.kind}:${it.id}`}
        contentContainerClassName="pt-2"
        renderItem={({ item }) => (
          <Row
            item={item}
            kindLabel={t(KIND_LABEL[item.kind] ?? "trash.kind.item")}
            when={fmt.dateTime(item.deletedAt)}
            daysLeft={t("trash.daysLeft", { count: item.daysLeft })}
            restoreLabel={t("trash.restore")}
            purgeLabel={t("trash.deleteForever")}
            onRestore={() => restore(item.kind as EntityKind, item.id)}
            onPurge={() => setPurging(item)}
          />
        )}
      />

      <ConfirmDialog
        visible={confirming}
        title={t("trash.emptyTrashTitle")}
        message={t("trash.emptyTrashConfirm", { count: items.length })}
        confirmLabel={t("trash.deleteAll")}
        danger
        onConfirm={() => {
          setConfirming(false);
          purgeAll();
          toast.show(t("toast.trashEmptied"));
        }}
        onCancel={() => setConfirming(false)}
      />

      <ConfirmDialog
        visible={purging !== null}
        title={t("trash.deleteForeverTitle")}
        message={t("trash.deleteForeverConfirm", {
          name: purging ? purging.label || t(KIND_LABEL[purging.kind] ?? "trash.kind.item") : "",
        })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={() => {
          if (purging) purgeItem(purging.kind as EntityKind, purging.id);
          setPurging(null);
        }}
        onCancel={() => setPurging(null)}
      />
    </View>
  );
}

function Row({
  item,
  kindLabel,
  when,
  daysLeft,
  restoreLabel,
  purgeLabel,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  kindLabel: string;
  when: string;
  daysLeft: string;
  restoreLabel: string;
  purgeLabel: string;
  onRestore: () => void;
  onPurge: () => void;
}) {
  // Red in the final 3 days, amber within a week, else neutral. The colour class must sit on the
  // `Text` itself: RN `Text` does not inherit colour from a parent `View`.
  const badge =
    item.daysLeft <= 3
      ? { bg: "bg-red-100 dark:bg-red-950", text: "text-red-700 dark:text-red-200" }
      : item.daysLeft <= 7
        ? { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-700 dark:text-amber-200" }
        : {
            bg: "bg-neutral-100 dark:bg-neutral-800",
            text: "text-neutral-600 dark:text-neutral-200",
          };

  return (
    <View className="mx-4 mb-2 gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-sm text-neutral-800 dark:text-neutral-100">
            {item.label || kindLabel}
          </Text>
          <Text className="text-xs text-neutral-500">
            {kindLabel} - {when}
          </Text>
        </View>
        <View className={"shrink-0 rounded-full px-2 py-0.5 " + badge.bg}>
          <Text className={"text-xs font-medium tabular-nums " + badge.text}>{daysLeft}</Text>
        </View>
      </View>
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={restoreLabel}
          onPress={onRestore}
          className="flex-row items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800"
        >
          <RotateCcw size={14} className="text-neutral-500" />
          <Text className="text-xs text-neutral-500">{restoreLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={purgeLabel}
          onPress={onPurge}
          className="flex-row items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800"
        >
          <X size={14} className="text-red-500" />
          <Text className="text-xs text-red-500">{purgeLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
