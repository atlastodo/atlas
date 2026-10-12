import { useState } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "../../lib/appVersion";
import { useStore } from "../../data/StoreProvider";
import { useOnboarding } from "../../data/OnboardingContext";
import { Row, Section } from "../../ui/Section";
import { ReportProblemSheet } from "../../ui/ReportProblemSheet";
import { SyncDetails } from "../../ui/SyncDetails";
import { Bug, Info, LifeBuoy, RefreshCw, Sparkles } from "../../ui/icons";

/** Help and feedback: file a bug, and see the sync panel a bug report is usually about. */
export function HelpSection({ onOpenAbout }: { onOpenAbout?: () => void }) {
  const { t } = useTranslation();
  const { openOnboarding } = useOnboarding();
  const { localOnly } = useStore();
  const [reportOpen, setReportOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  return (
    <Section icon={LifeBuoy} title={t("settings.help")}>
      {onOpenAbout && (
        <Row label={t("settings.about")} description={t("settings.aboutDesc")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.about")}
            onPress={onOpenAbout}
            className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
          >
            <Info size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("common.open")}
            </Text>
          </Pressable>
        </Row>
      )}
      <Row label={t("settings.onboarding")} description={t("settings.onboardingDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.onboarding")}
          onPress={openOnboarding}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Sparkles size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">{t("common.open")}</Text>
        </Pressable>
      </Row>
      <Row label={t("settings.reportProblem")} description={t("settings.reportProblemDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.reportProblem")}
          onPress={() => setReportOpen(true)}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Bug size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">{t("report.send")}</Text>
        </Pressable>
      </Row>
      {!localOnly && (
        <Row label={t("sync.detailsTitle")} description={t("settings.syncDetailsDesc")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("sync.detailsTitle")}
            onPress={() => setSyncOpen(true)}
            className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
          >
            <RefreshCw size={18} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("common.open")}
            </Text>
          </Pressable>
        </Row>
      )}
      <Row label={t("settings.appVersion")}>
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">{APP_VERSION}</Text>
      </Row>
      {/* Both sheets are mounted only while open: each reads the store to build its contents, so
          leaving them mounted behind a closed sheet would do that work on every render. */}
      {reportOpen && <ReportProblemSheet open onClose={() => setReportOpen(false)} />}
      {syncOpen && <SyncDetails open onClose={() => setSyncOpen(false)} />}
    </Section>
  );
}
