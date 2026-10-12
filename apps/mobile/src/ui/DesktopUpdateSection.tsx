import { Linking, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw, Sparkles, SquareArrowOutUpRight } from "./icons";
import { useDesktopUpdates } from "../hooks/useDesktopUpdates";

export function DesktopUpdateSection() {
  const { t } = useTranslation();
  const { state, isDesktop, checkForUpdates, downloadUpdate, installUpdate } = useDesktopUpdates();

  if (!isDesktop || !state) {
    return null;
  }

  const openReleaseNotes = () => {
    if (state.releaseUrl) {
      void Linking.openURL(state.releaseUrl);
    }
  };

  return (
    <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <View className="mb-3 flex-row items-center justify-between">
        <Text className="text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          {t("desktopUpdate.title")}
        </Text>
        {state.manager && (
          <View className="rounded bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
            <Text className="text-[10px] font-semibold text-neutral-600 dark:text-neutral-300">
              {state.manager}
            </Text>
          </View>
        )}
      </View>

      {/* Case 1: Disabled by system/package manager (NixOS, Flatpak, env, CLI flag) */}
      {state.disabled ? (
        <View className="gap-2">
          <Text className="text-sm text-neutral-600 dark:text-neutral-400">
            {t("desktopUpdate.managedGeneric")}
          </Text>
        </View>
      ) : (
        /* Case 2: Updates are enabled */
        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {state.status === "available"
                  ? t("desktopUpdate.available", { version: state.availableVersion })
                  : state.status === "downloading"
                    ? t("desktopUpdate.downloading", { percent: state.downloadProgress })
                    : state.status === "downloaded"
                      ? t("desktopUpdate.readyToInstall", { version: state.availableVersion })
                      : state.status === "checking"
                        ? t("desktopUpdate.checking")
                        : state.status === "error"
                          ? t("desktopUpdate.error", { error: state.error || "Unknown" })
                          : t("desktopUpdate.upToDate", { version: state.currentVersion })}
              </Text>
            </View>

            {/* Action buttons depending on state */}
            {state.status === "available" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("desktopUpdate.download")}
                onPress={state.canSelfUpdate ? () => void downloadUpdate() : openReleaseNotes}
                className="flex-row items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-2 active:bg-accent-700 web:cursor-pointer"
              >
                <Download size={15} className="text-white" />
                <Text className="text-xs font-semibold text-white">
                  {t("desktopUpdate.download")}
                </Text>
              </Pressable>
            )}

            {state.status === "downloaded" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("desktopUpdate.restart")}
                onPress={installUpdate}
                className="flex-row items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 active:bg-emerald-700 web:cursor-pointer"
              >
                <Sparkles size={15} className="text-white" />
                <Text className="text-xs font-semibold text-white">
                  {t("desktopUpdate.restart")}
                </Text>
              </Pressable>
            )}

            {(state.status === "idle" ||
              state.status === "up-to-date" ||
              state.status === "error") && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("desktopUpdate.check")}
                onPress={() => void checkForUpdates()}
                className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 active:bg-neutral-50 dark:border-neutral-700 dark:active:bg-neutral-800 web:cursor-pointer"
              >
                <RefreshCw size={14} className="text-neutral-600 dark:text-neutral-300" />
                <Text className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
                  {t("desktopUpdate.check")}
                </Text>
              </Pressable>
            )}

            {state.status === "checking" && (
              <View className="flex-row items-center gap-1.5 px-3 py-2">
                <RefreshCw
                  size={14}
                  className="animate-spin text-accent-600 dark:text-accent-400"
                />
              </View>
            )}
          </View>

          {/* Release Notes Link */}
          {state.status === "available" && state.releaseUrl && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("desktopUpdate.whatsNew")}
              onPress={openReleaseNotes}
              className="flex-row items-center gap-1 web:cursor-pointer"
            >
              <Text className="text-xs text-accent-600 underline dark:text-accent-400">
                {t("desktopUpdate.whatsNew")}
              </Text>
              <SquareArrowOutUpRight size={12} className="text-accent-600 dark:text-accent-400" />
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
