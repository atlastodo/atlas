import { Linking, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { explainNotifications } from "../../lib/permissionExplainer";
import { openPermissionsSheet } from "../../lib/permissionsSheet";
import { usePreferences } from "../../hooks/usePreferences";
import { useExactAlarms, useNotifyPermission } from "../../hooks/useReminders";
import { Row, Section } from "../../ui/Section";
import { Toggle } from "../../ui/Toggle";
import { Bell } from "../../ui/icons";
import { RowButton } from "./shared";

/**
 * Everything that decides whether a reminder reaches the user, in one place: the reminders switch,
 * the notification permission and, on Android 12+, exact alarms (without them a locked phone's
 * reminders come up to ~10 minutes late). Each row says where it stands and offers its one fix.
 */
export function NotificationsSection() {
  const { t } = useTranslation();
  const { remindersEnabled, setRemindersEnabled } = usePreferences();
  const { permission } = useNotifyPermission();
  const { exactAlarms, openSettings: openExactAlarmSettings } = useExactAlarms();
  const native = Platform.OS !== "web";
  const openAppSettings = () => void Linking.openSettings().catch(() => {});

  const permissionDesc =
    permission === "granted"
      ? t("settings.notificationPermissionGranted")
      : permission === "default"
        ? t("settings.notificationPermissionDefault")
        : permission === "denied"
          ? t(
              native
                ? "settings.notificationPermissionDeniedNative"
                : "settings.notificationPermissionDeniedWeb",
            )
          : t("settings.notificationPermissionUnsupported");

  return (
    <Section icon={Bell} title={t("settings.notifications")}>
      <Toggle
        label={t("settings.reminders")}
        description={t("settings.remindersDesc")}
        value={remindersEnabled}
        onValueChange={(on) => {
          if (on) void explainNotifications();
          setRemindersEnabled(on);
        }}
      />
      {remindersEnabled && permission !== null && (
        <Row label={t("settings.notificationPermission")} description={permissionDesc}>
          {permission === "default" ? (
            <RowButton
              label={t("reminder.enableNotifications")}
              onPress={() => void explainNotifications()}
            />
          ) : native && permission !== "unsupported" ? (
            <RowButton label={t("reminder.openSettings")} onPress={openAppSettings} />
          ) : null}
        </Row>
      )}
      {remindersEnabled && exactAlarms !== "unsupported" && (
        <Row
          label={t("settings.exactAlarms")}
          description={t(
            exactAlarms === "granted"
              ? "settings.exactAlarmsGranted"
              : "settings.exactAlarmsDenied",
          )}
        >
          <RowButton
            label={t("reminder.openSettings")}
            onPress={() => void openExactAlarmSettings()}
          />
        </Row>
      )}
      <Row label={t("permissions.title")}>
        <RowButton label={t("permissions.review")} onPress={openPermissionsSheet} />
      </Row>
    </Section>
  );
}
