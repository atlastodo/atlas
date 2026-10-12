import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "../lib/appVersion";
import { resolveTimeZone } from "@atlas/shared";
import { copyText } from "../lib/clipboard";
import { useToast } from "../data/ToastProvider";
import { useStoreOptional } from "../data/StoreProvider";
import { usePreferences } from "../hooks/usePreferences";
import { useIsWide } from "../hooks/useIsWide";
import { deviceLanguage } from "../i18n";
import { ScreenFade } from "../ui/ScreenFade";
import { ThemeScope } from "../theme/ThemeProvider";
import { ReportProblemSheet } from "../ui/ReportProblemSheet";
import { ShortcutsTable } from "../ui/ShortcutsHelp";
import { SyncDetails } from "../ui/SyncDetails";
import {
  Bug,
  Check,
  CircleCheckBig,
  Copy,
  Database,
  Globe,
  Info,
  Keyboard,
  ListTodo,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  SquareArrowOutUpRight,
} from "../ui/icons";

export type AboutTab = "overview" | "shortcuts" | "architecture" | "licenses";

/**
 * External links are build-time env, not hardcoded: a distribution that wants them sets
 * `EXPO_PUBLIC_REPO_URL` / `EXPO_PUBLIC_HOSTED_URL`. The release workflow sets the repository for
 * the Android, desktop and Docker builds; a build with neither renders no link rows.
 */
const REPO_URL = process.env.EXPO_PUBLIC_REPO_URL || null;
const HOSTED_URL = process.env.EXPO_PUBLIC_HOSTED_URL || null;

export function AboutScreen() {
  const { t } = useTranslation();
  const toast = useToast();
  const { theme, accent, language, timezone } = usePreferences();
  const [tab, setTab] = useState<AboutTab>("overview");
  // Four icon-and-label tabs do not fit a phone row; there only the active tab keeps its label.
  const compactTabs = !useIsWide();
  const [reportOpen, setReportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  // Local-only mode has no sync to show.
  const localOnly = useStoreOptional()?.localOnly === true;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const appVersion = APP_VERSION;
  const platformName =
    Platform.OS === "web" ? "Web" : Platform.OS === "android" ? "Android" : "iOS";

  const handleCopySystemInfo = async () => {
    const info = [
      `Atlas Todo v${appVersion}`,
      `Platform: ${platformName} (OS Version: ${String(Platform.Version)})`,
      `Language: ${language || deviceLanguage()}`,
      `Timezone: ${timezone || resolveTimeZone("")}`,
      `Theme: ${theme}, Accent: ${accent}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");

    const ok = await copyText(info);
    if (ok) {
      setCopied(true);
      toast.show(t("about.systemInfoCopied"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2500);
    }
  };

  const handleOpenUrl = (url: string) => {
    void Linking.openURL(url);
  };

  return (
    <ThemeScope className="flex-1 bg-white dark:bg-zinc-950">
      <ScreenFade>
        <ScrollView
          className="flex-1 bg-white dark:bg-zinc-950"
          contentContainerClassName="px-4 pb-20 web:mx-auto web:w-full web:max-w-2xl"
          keyboardShouldPersistTaps="handled"
        >
          <View className="items-center py-6">
            <View className="mb-3 h-16 w-16 items-center justify-center rounded-2xl bg-accent-600 shadow-lg shadow-accent-600">
              <ListTodo size={36} className="text-white" />
            </View>
            <Text className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
              {t("about.title")}
            </Text>
            <Text className="mt-1 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t("about.subtitle")}
            </Text>
            <View className="mt-2.5 flex-row items-center gap-2">
              <View className="rounded-full border border-neutral-200/60 bg-neutral-100 px-3 py-1 dark:border-neutral-700/60 dark:bg-neutral-800">
                <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  v{appVersion}
                </Text>
              </View>
              <View className="rounded-full border border-neutral-200/60 bg-neutral-100 px-3 py-1 dark:border-neutral-700/60 dark:bg-neutral-800">
                <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  {platformName}
                </Text>
              </View>
            </View>
          </View>

          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t("nav.about")}
            className="mb-6 flex-row rounded-xl bg-neutral-100 p-1 dark:bg-neutral-900"
          >
            {(
              [
                { id: "overview", label: t("about.tabOverview"), icon: Info },
                { id: "shortcuts", label: t("about.tabShortcuts"), icon: Keyboard },
                { id: "architecture", label: t("about.tabArchitecture"), icon: ShieldCheck },
                { id: "licenses", label: t("about.tabLicenses"), icon: Globe },
              ] as const
            ).map(({ id, label, icon: TabIcon }) => {
              const active = tab === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  onPress={() => setTab(id)}
                  className={
                    "flex-row items-center justify-center gap-1.5 rounded-lg py-2 " +
                    (compactTabs && !active ? "px-3.5 " : "flex-1 px-2 ") +
                    (active
                      ? "bg-white shadow-sm dark:bg-neutral-800"
                      : "opacity-75 active:opacity-100")
                  }
                >
                  <TabIcon
                    size={16}
                    className={
                      active
                        ? "text-accent-600 dark:text-accent-400"
                        : "text-neutral-500 dark:text-neutral-400"
                    }
                  />
                  {(active || !compactTabs) && (
                    <Text
                      className={
                        "text-xs font-medium " +
                        (active
                          ? "text-neutral-900 dark:text-neutral-100"
                          : "text-neutral-600 dark:text-neutral-300")
                      }
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>

          {tab === "overview" && (
            <View className="gap-4">
              <View className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                <View className="mb-2 flex-row items-center gap-2">
                  <Sparkles size={18} className="text-accent-600 dark:text-accent-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.missionTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.missionDescription")}
                </Text>
              </View>

              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <Text className="mb-3 text-xs font-bold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("about.diagnosticsTitle")}
                </Text>
                <View className="gap-2.5">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("about.copySystemInfo")}
                    onPress={() => void handleCopySystemInfo()}
                    className="flex-row items-center justify-between rounded-lg border border-neutral-200 px-3.5 py-2.5 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-800/60"
                  >
                    <View className="flex-row items-center gap-2.5">
                      {copied ? (
                        <Check size={18} className="text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy size={18} className="text-neutral-600 dark:text-neutral-300" />
                      )}
                      <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                        {t("about.copySystemInfo")}
                      </Text>
                    </View>
                    <Text className="text-xs text-neutral-500">
                      {copied ? t("about.copied") : "v" + appVersion}
                    </Text>
                  </Pressable>

                  {HOSTED_URL !== null && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("about.openHosted")}
                      onPress={() => handleOpenUrl(HOSTED_URL)}
                      className="flex-row items-center justify-between rounded-lg border border-neutral-200 px-3.5 py-2.5 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-800/60"
                    >
                      <View className="flex-row items-center gap-2.5">
                        <Globe size={18} className="text-neutral-600 dark:text-neutral-300" />
                        <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                          {t("about.openHosted")}
                        </Text>
                      </View>
                      <Text className="text-xs text-neutral-500">{t("common.open")}</Text>
                    </Pressable>
                  )}

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("about.openReport")}
                    onPress={() => setReportOpen(true)}
                    className="flex-row items-center justify-between rounded-lg border border-neutral-200 px-3.5 py-2.5 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-800/60"
                  >
                    <View className="flex-row items-center gap-2.5">
                      <Bug size={18} className="text-neutral-600 dark:text-neutral-300" />
                      <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                        {t("about.openReport")}
                      </Text>
                    </View>
                    <Text className="text-xs text-neutral-500">{t("common.open")}</Text>
                  </Pressable>

                  {!localOnly && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("about.openSync")}
                      onPress={() => setSyncOpen(true)}
                      className="flex-row items-center justify-between rounded-lg border border-neutral-200 px-3.5 py-2.5 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-800/60"
                    >
                      <View className="flex-row items-center gap-2.5">
                        <RefreshCw size={18} className="text-neutral-600 dark:text-neutral-300" />
                        <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                          {t("about.openSync")}
                        </Text>
                      </View>
                      <Text className="text-xs text-neutral-500">{t("common.open")}</Text>
                    </Pressable>
                  )}

                  {REPO_URL !== null && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("about.viewRepo")}
                      onPress={() => handleOpenUrl(REPO_URL)}
                      className="flex-row items-center justify-between rounded-lg border border-neutral-200 px-3.5 py-2.5 active:bg-neutral-50 dark:border-neutral-800 dark:active:bg-neutral-800/60"
                    >
                      <View className="flex-row items-center gap-2.5">
                        <SquareArrowOutUpRight
                          size={18}
                          className="text-neutral-600 dark:text-neutral-300"
                        />
                        <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                          {t("about.viewRepo")}
                        </Text>
                      </View>
                      <Text className="text-xs text-neutral-500">GitHub</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </View>
          )}

          {tab === "shortcuts" && <ShortcutsTable />}

          {tab === "architecture" && (
            <View className="gap-4">
              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-2 flex-row items-center gap-2">
                  <ShieldCheck size={20} className="text-emerald-600 dark:text-emerald-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.archE2eeTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.archE2eeDesc")}
                </Text>
              </View>

              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-2 flex-row items-center gap-2">
                  <Database size={20} className="text-blue-600 dark:text-blue-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.archLocalFirstTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.archLocalFirstDesc")}
                </Text>
              </View>

              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-2 flex-row items-center gap-2">
                  <RefreshCw size={20} className="text-indigo-600 dark:text-indigo-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.archSyncTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.archSyncDesc")}
                </Text>
              </View>

              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-2 flex-row items-center gap-2">
                  <CircleCheckBig size={20} className="text-amber-600 dark:text-amber-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.archPrivacyTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.archPrivacyDesc")}
                </Text>
              </View>
            </View>
          )}

          {tab === "licenses" && (
            <View className="gap-4">
              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <View className="mb-2 flex-row items-center gap-2">
                  <Globe size={20} className="text-accent-600 dark:text-accent-400" />
                  <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {t("about.licenseTitle")}
                  </Text>
                </View>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.licenseDesc")}
                </Text>
                <View className="mt-3">
                  {REPO_URL !== null && (
                    <Pressable
                      accessibilityRole="link"
                      accessibilityLabel={t("about.sourceCode")}
                      onPress={() => handleOpenUrl(REPO_URL)}
                      className="flex-row items-center gap-1.5 self-start rounded-md bg-neutral-100 px-3 py-1.5 dark:bg-neutral-800"
                    >
                      <SquareArrowOutUpRight
                        size={14}
                        className="text-accent-600 dark:text-accent-400"
                      />
                      <Text className="text-xs font-semibold text-accent-600 dark:text-accent-400">
                        {t("about.sourceCode")}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>

              <View className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
                <Text className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {t("about.acknowledgementsTitle")}
                </Text>
                <Text className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t("about.acknowledgements")}
                </Text>
              </View>
            </View>
          )}

          {reportOpen && <ReportProblemSheet open onClose={() => setReportOpen(false)} />}
          {syncOpen && <SyncDetails open onClose={() => setSyncOpen(false)} />}
        </ScrollView>
      </ScreenFade>
    </ThemeScope>
  );
}
