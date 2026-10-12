import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ApiError } from "@atlas/client-core";
import { DEFAULT_FOLDER_ICON, resolveProjectColor } from "@atlas/shared";
import { useNotifications, type InviteNotification } from "../data/NotificationsProvider";
import { useToast } from "../data/ToastProvider";
import { Bell, Check, Lock, X } from "../ui/icons";
import { projectIconFor } from "../ui/projectIcons";
import { SkeletonRows } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { haptics } from "../lib/haptics";
import { relativeLabel } from "./settings/relativeLabel";

/** The notifications centre: a durable place to act on notifications. Today the only kind is a shared-project invite (Accept/Decline); new kinds slot in as branches of {@link AppNotification}. */
export function NotificationsScreen() {
  const { t } = useTranslation();
  const { notifications, loading, error } = useNotifications();

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-white p-4 dark:bg-zinc-950">
        <Text className="text-sm text-red-500">{t("notifications.error")}</Text>
      </View>
    );
  }

  // Invites come from REST, so the first paint has none: show a skeleton rather than flashing the empty state.
  if (loading && notifications.length === 0) {
    return (
      <View className="flex-1 bg-white dark:bg-zinc-950">
        <SkeletonRows count={3} />
      </View>
    );
  }

  if (!loading && notifications.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title={t("notifications.empty")}
        description={t("notifications.emptyHint")}
      />
    );
  }

  return (
    <FlatList
      className="flex-1 bg-white dark:bg-zinc-950"
      contentContainerClassName="gap-2 p-4"
      data={notifications}
      keyExtractor={(n) => n.id}
      renderItem={({ item }) => <InviteCard notification={item} />}
    />
  );
}

const ROLE_KEY = {
  owner: "share.owner",
  editor: "share.editor",
  commenter: "share.commenter",
} as const;

function failureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function InviteCard({ notification }: { notification: InviteNotification }) {
  const { t, i18n } = useTranslation();
  const { accept, decline } = useNotifications();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { invite, project } = notification;

  const name = project.name;
  const Icon = projectIconFor(
    project.icon ?? (project.kind === "folder" ? DEFAULT_FOLDER_ICON : undefined),
  );
  const color = resolveProjectColor({ id: invite.project_id, color: project.color ?? "" });

  const inviter = invite.inviter;
  const from =
    inviter?.display_name && inviter.email && inviter.display_name !== inviter.email
      ? `${inviter.display_name} (${inviter.email})`
      : inviter?.display_name || inviter?.email || t("invites.someone");

  const onAccept = async () => {
    haptics.success();
    setBusy(true);
    try {
      await accept(invite.project_id);
      toast.show(
        name != null ? t("invites.accepted", { project: name }) : t("invites.acceptedLocked"),
      );
    } catch (err) {
      toast.show(failureMessage(err, t("invites.acceptFailed")));
      setBusy(false);
    }
  };

  const onDecline = async () => {
    haptics.selection();
    setBusy(true);
    try {
      await decline(invite.project_id);
    } catch (err) {
      toast.show(failureMessage(err, t("invites.declineFailed")));
      setBusy(false);
    }
  };

  return (
    <View className="gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <View className="flex-row items-start gap-3">
        {name != null ? (
          <Icon size={20} color={color} />
        ) : (
          <View accessible accessibilityLabel={t("invites.lockedLabel")}>
            <Lock size={20} className="text-neutral-400" />
          </View>
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            numberOfLines={1}
            className="text-sm font-medium text-neutral-900 dark:text-neutral-100"
          >
            {name ?? t("invites.sharedProject")}
          </Text>
          <Text numberOfLines={1} className="text-xs text-neutral-600 dark:text-neutral-300">
            {t("invites.from", { inviter: from })}
          </Text>
          <Text className="text-xs text-neutral-500">
            {t("invites.roleWhen", {
              role: t(ROLE_KEY[invite.role]),
              when: relativeLabel(invite.invited_at, Date.now(), i18n.language),
            })}
          </Text>
        </View>
      </View>
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.decline")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void onDecline()}
          className={`flex-row items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 dark:border-neutral-700 ${
            busy ? "opacity-50" : ""
          }`}
        >
          <X size={14} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-xs text-neutral-600 dark:text-neutral-300">
            {t("common.decline")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.accept")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void onAccept()}
          className={`flex-row items-center gap-1 rounded-md bg-accent-600 px-3 py-1.5 ${
            busy ? "opacity-50" : ""
          }`}
        >
          <Check size={14} className="text-white" />
          <Text className="text-xs text-white">{t("common.accept")}</Text>
        </Pressable>
      </View>
    </View>
  );
}
