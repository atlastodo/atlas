import { useEffect } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ThemeScope } from "../theme/ThemeProvider";
import { resolveTimeZone, shiftWallClockToZone } from "@atlastodo/shared";
import { useAuth } from "../auth/AuthContext";
import { usePreferences } from "../hooks/usePreferences";
import { useLocalTasks } from "../hooks/useLocalTasks";

/**
 * Detects a device timezone change and offers to shift every open task's due instant so its local
 * wall-clock time is preserved (`shiftWallClockToZone`), or to leave them. Fires only while
 * following the device (no pinned `timezone`). The last-seen zone is a synced preference, so it
 * prompts once across devices. Mounted under the store.
 */
export function TimezoneChangePrompt() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const { timezone, lastSeenTimezone, setLastSeenTimezone } = usePreferences();
  const { tasks, update } = useLocalTasks(session?.user.id);

  const deviceZone = resolveTimeZone("");
  // Only while following the device: a pinned `timezone` fixes display wherever the device is.
  const following = timezone === "";

  // Seed the last-seen zone silently on first run so a new account gets no spurious prompt.
  useEffect(() => {
    if (following && lastSeenTimezone === "") setLastSeenTimezone(deviceZone);
  }, [following, lastSeenTimezone, deviceZone, setLastSeenTimezone]);

  const changed = following && lastSeenTimezone !== "" && lastSeenTimezone !== deviceZone;

  const keep = () => setLastSeenTimezone(deviceZone);
  const reschedule = () => {
    for (const task of tasks) {
      if (task.due_at != null) {
        update(task, { due_at: shiftWallClockToZone(task.due_at, lastSeenTimezone, deviceZone) });
      }
    }
    setLastSeenTimezone(deviceZone);
  };

  return (
    <Modal visible={changed} transparent animationType="fade" onRequestClose={keep}>
      <ThemeScope className="flex-1 items-center justify-center bg-black/40 p-6">
        <View className="w-full max-w-sm gap-3 rounded-2xl bg-white p-5 dark:bg-zinc-900">
          <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("timezone.changedTitle")}
          </Text>
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("timezone.changedBody", { from: lastSeenTimezone, to: deviceZone })}
          </Text>
          <View className="mt-1 flex-row justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("timezone.keep")}
              onPress={keep}
              className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700 web:cursor-pointer"
            >
              <Text className="text-sm text-neutral-700 dark:text-neutral-200">
                {t("timezone.keep")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("timezone.reschedule")}
              onPress={reschedule}
              className="rounded-md bg-accent-600 px-3 py-2 web:cursor-pointer"
            >
              <Text className="text-sm font-medium text-white">{t("timezone.reschedule")}</Text>
            </Pressable>
          </View>
        </View>
      </ThemeScope>
    </Modal>
  );
}
