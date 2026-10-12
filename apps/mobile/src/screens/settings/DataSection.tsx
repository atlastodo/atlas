import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import {
  bundleFilename,
  exportData,
  importBundle,
  parseBundle,
  serializeBundle,
  ticktickLegacyIdReusable,
  ticktickToBundle,
  type TicktickWarningCode,
} from "@atlas/shared";
import { useAuth } from "../../auth/AuthContext";
import { useStore } from "../../data/StoreProvider";
import { useToast } from "../../data/ToastProvider";
import { saveBundle, pickBundleText, pickCsvText } from "../../lib/dataTransfer";
import { usePreferences } from "../../hooks/usePreferences";
import { Row, Section } from "../../ui/Section";
import { PersistentStorageRow } from "../../ui/PersistentStorageRow";
import { Database, Download, Upload } from "../../ui/icons";

const TICKTICK_WARNING_KEYS: Record<TicktickWarningCode, string> = {
  folder: "settings.ticktickWarnFolder",
  noTaskId: "settings.ticktickWarnNoTaskId",
  missingParent: "settings.ticktickWarnMissingParent",
  repeat: "settings.ticktickWarnRepeat",
  reminders: "settings.ticktickWarnReminders",
  checklist: "settings.ticktickWarnChecklist",
  timezone: "settings.ticktickWarnTimezone",
};

/**
 * Backup & restore. Import merges a bundle back in via LWW with fresh HLCs, so an imported value
 * wins on an id conflict and nothing is deleted.
 */
export function DataSection() {
  const { t } = useTranslation();
  const { store, kick } = useStore();
  const { timezone } = usePreferences();
  const { session } = useAuth();
  const toast = useToast();

  const doExport = async () => {
    try {
      await saveBundle(serializeBundle(exportData(store)), bundleFilename());
    } catch {
      toast.show(t("settings.exportError"));
    }
  };

  const doImport = async () => {
    try {
      const text = await pickBundleText();
      if (text == null) return;
      const { count } = importBundle(store, kick, parseBundle(text));
      toast.show(t("settings.importDone", { count }));
    } catch {
      toast.show(t("settings.importError"));
    }
  };

  const doImportTicktick = async () => {
    try {
      const text = await pickCsvText();
      if (text == null) return;
      const { bundle, counts, warnings } = ticktickToBundle(text, {
        userId: session?.user.id ?? "",
        reuseLegacyId: ticktickLegacyIdReusable(store),
        timeZone: timezone,
      });
      importBundle(store, kick, bundle);
      toast.show(
        t("settings.ticktickDone", {
          tasks: counts.tasks,
          projects: counts.projects,
        }),
      );
      // What the mapping could not carry over; the import itself succeeded, so these are notices, not errors.
      for (const warning of warnings) {
        toast.show(t(TICKTICK_WARNING_KEYS[warning.code], { detail: warning.detail ?? "" }));
      }
    } catch {
      toast.show(t("settings.ticktickError"));
    }
  };

  return (
    <Section icon={Database} title={t("settings.data")}>
      <Row label={t("settings.export")} description={t("settings.exportDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.exportAction")}
          onPress={() => void doExport()}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Download size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("settings.exportAction")}
          </Text>
        </Pressable>
      </Row>
      <Row label={t("settings.import")} description={t("settings.importDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.importAction")}
          onPress={() => void doImport()}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Upload size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("settings.importAction")}
          </Text>
        </Pressable>
      </Row>
      <Row label={t("settings.ticktick")} description={t("settings.ticktickDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.ticktickAction")}
          onPress={() => void doImportTicktick()}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Upload size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("settings.ticktickAction")}
          </Text>
        </Pressable>
      </Row>
      {/* Browser-only: it renders nothing on native, Electron and hardened private modes (see
          its header), so the phone's Data section is unchanged. */}
      <PersistentStorageRow />
    </Section>
  );
}
