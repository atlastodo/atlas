import { useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AdminUserView } from "@atlas/client-core";
import { useFormat } from "../hooks/useFormat";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { ConfirmDialog } from "./ConfirmDialog";
import { DetailButton } from "./DetailButton";
import { Field } from "./Field";

/** The actions that ask before they run, and the copy each confirmation uses. */
type Confirmable = "promote" | "demote" | "disable" | "logout" | "delete";

const CONFIRM: Record<Confirmable, { title: string; message: string; label: string }> = {
  promote: { title: "admin.promoteTitle", message: "admin.promoteConfirm", label: "admin.promote" },
  demote: { title: "admin.demoteTitle", message: "admin.demoteConfirm", label: "admin.demote" },
  disable: { title: "admin.disableTitle", message: "admin.disableConfirm", label: "admin.disable" },
  logout: {
    title: "admin.forceLogoutTitle",
    message: "admin.forceLogoutConfirm",
    label: "admin.forceLogout",
  },
  delete: {
    title: "admin.deleteUserTitle",
    message: "admin.deleteUserConfirm",
    label: "admin.deleteAccount",
  },
};

/**
 * One account in full, with the lifecycle actions. Every action that takes something away (or
 * grants admin) asks first. Self-actions are disabled in the UI and refused by the server, as is
 * changing an admin the server's configuration manages.
 */
/** A scheduled deletion, with the days left when the server sent them. */
export function deletionLabel(user: AdminUserView, t: TFunction): string {
  return user.deletion_days_remaining != null
    ? t("admin.deletionInDays", { count: user.deletion_days_remaining })
    : t("admin.deletionScheduled");
}

export function AdminUserDetail({
  user,
  isSelf,
  onClose,
  onSetAdmin,
  onSetDisabled,
  onForceLogout,
  onDelete,
}: {
  user: AdminUserView;
  isSelf: boolean;
  onClose: () => void;
  onSetAdmin: (isAdmin: boolean) => void;
  onSetDisabled: (disabled: boolean) => void;
  onForceLogout: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const [confirming, setConfirming] = useState<Confirmable | null>(null);

  return (
    <BottomSheet visible onClose={onClose}>
      <View className="gap-3">
        <Text
          numberOfLines={1}
          className="text-base font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {user.display_name || user.email}
        </Text>

        <SheetScrollView className="max-h-72">
          <Field label={t("admin.emailLabel")} value={user.email} />
          <Field label={t("admin.joined")} value={format.dateTime(user.created_at_ms)} />
          <Field
            label={t("admin.lastLogin")}
            value={
              user.last_login_at_ms != null
                ? format.dateTime(user.last_login_at_ms)
                : t("admin.never")
            }
          />
          <Field
            label={t("admin.statusLabel")}
            value={
              user.deletion_scheduled
                ? deletionLabel(user, t)
                : user.disabled
                  ? t("admin.disabledBadge")
                  : user.is_admin
                    ? t("admin.adminBadge")
                    : t("admin.active")
            }
          />
        </SheetScrollView>

        {user.managed_by_env ? (
          <Text className="text-xs text-neutral-500">{t("admin.managedByEnv")}</Text>
        ) : null}
        <View className="flex-row gap-2">
          <DetailButton
            label={user.is_admin ? t("admin.demote") : t("admin.promote")}
            onPress={() => setConfirming(user.is_admin ? "demote" : "promote")}
            disabled={isSelf || user.managed_by_env === true}
            primary
          />
          <DetailButton
            label={user.disabled ? t("admin.enable") : t("admin.disable")}
            onPress={() => {
              if (user.disabled) {
                onSetDisabled(false);
                onClose();
              } else setConfirming("disable");
            }}
            disabled={isSelf}
          />
        </View>
        <View className="flex-row gap-2">
          {/* Not on yourself: the server refuses it, and your own sign-out is one tap away. */}
          <DetailButton
            label={t("admin.forceLogout")}
            onPress={() => setConfirming("logout")}
            disabled={isSelf}
          />
          <DetailButton
            label={t("admin.deleteAccount")}
            onPress={() => setConfirming("delete")}
            disabled={isSelf}
            danger
          />
        </View>

        {confirming ? (
          <ConfirmDialog
            visible
            title={t(CONFIRM[confirming].title)}
            message={t(CONFIRM[confirming].message, { email: user.email })}
            confirmLabel={t(CONFIRM[confirming].label)}
            danger={confirming !== "promote"}
            onConfirm={() => {
              const action = confirming;
              setConfirming(null);
              if (action === "promote" || action === "demote") onSetAdmin(action === "promote");
              else if (action === "disable") onSetDisabled(true);
              else if (action === "logout") onForceLogout();
              else onDelete();
              onClose();
            }}
            onCancel={() => setConfirming(null)}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}
