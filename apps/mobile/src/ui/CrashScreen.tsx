import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CircleAlert, Copy, House, RefreshCw } from "./icons";
import { copyText } from "../lib/clipboard";
import { reloadApp } from "../lib/reload";
import type { CaptureResult } from "../lib/crashReporter";

/**
 * What the user sees instead of a blank screen when something throws. Provider-free: the root
 * `ErrorBoundary` replaces the whole app tree, so this may import only `react-native`,
 * `react-i18next` and the two platform-split helpers; a `useStore()` here would turn a caught
 * crash into an uncaught one. Actions are passed in (only route files may import `router`).
 */
export function CrashScreen({
  error,
  report,
  onRetry,
  onGoHome,
  homeLabel,
}: {
  error: Error;
  /** What became of the crash report, so the status line is truthful. */
  report: CaptureResult | "pending";
  onRetry?: () => void;
  onGoHome?: () => void;
  /** What the escape action does: the drawer goes home, the task detail pops back. */
  homeLabel?: string;
}) {
  const { t } = useTranslation();

  const reportLine =
    report === "sent"
      ? t("crash.reported")
      : report === "queued"
        ? t("crash.reportQueued")
        : report === "failed"
          ? t("crash.reportFailed")
          : t("crash.reporting");

  return (
    <View className="flex-1 bg-white px-6 pb-10 pt-24 dark:bg-zinc-950">
      <View className="items-center">
        <CircleAlert size={40} className="text-red-500" />
        <Text className="mt-4 text-center text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {t("crash.title")}
        </Text>
        <Text className="mt-2 text-center text-sm text-neutral-500">{t("crash.body")}</Text>
        <Text className="mt-1 text-center text-xs text-neutral-500">{reportLine}</Text>
      </View>

      <ScrollView className="mt-6 max-h-40 rounded-lg bg-neutral-100 p-3 dark:bg-neutral-900">
        <Text className="text-xs text-neutral-500">{error.message}</Text>
        {/* Stack in development only; in production the redacted copy is already sent. */}
        {__DEV__ && error.stack ? (
          <Text className="mt-2 text-xs text-neutral-500">{error.stack}</Text>
        ) : null}
      </ScrollView>

      <View className="mt-6 gap-2">
        {onRetry ? (
          <Action icon={RefreshCw} label={t("crash.tryAgain")} onPress={onRetry} primary />
        ) : null}
        {onGoHome ? (
          <Action icon={House} label={homeLabel ?? t("crash.goHome")} onPress={onGoHome} />
        ) : null}
        <Action icon={RefreshCw} label={t("crash.restart")} onPress={() => void reloadApp()} />
        <Action
          icon={Copy}
          label={t("crash.copyDetails")}
          onPress={() => void copyText(`${error.message}\n\n${error.stack ?? ""}`)}
        />
      </View>
    </View>
  );
}

function Action({
  icon: Icon,
  label,
  onPress,
  primary,
}: {
  icon: typeof CircleAlert;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`flex-row items-center justify-center gap-2 rounded-lg border px-4 py-3 ${
        primary
          ? "border-accent-600 bg-accent-600"
          : "border-neutral-200 bg-transparent dark:border-neutral-800"
      }`}
    >
      <Icon size={16} className={primary ? "text-white" : "text-neutral-500"} />
      <Text
        className={`text-sm font-medium ${
          primary ? "text-white" : "text-neutral-700 dark:text-neutral-200"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
