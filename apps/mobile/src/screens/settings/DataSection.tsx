import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  bundleFilename,
  exportData,
  importBundle,
  parseBundle,
  serializeBundle,
  ticktickLegacyIdReusable,
  ticktickToBundle,
  readTodoistFiles,
  todoistToBundle,
  type TicktickWarningCode,
  type TodoistWarningCode,
} from "@atlas/shared";
import { useAuth } from "../../auth/AuthContext";
import { useStore } from "../../data/StoreProvider";
import { useToast } from "../../data/ToastProvider";
import { saveBundle, pickBundleText, pickCsvText, pickTodoistFile } from "../../lib/dataTransfer";
import { usePreferences } from "../../hooks/usePreferences";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Row, Section } from "../../ui/Section";
import { PersistentStorageRow } from "../../ui/PersistentStorageRow";
import { Database, Download, Upload } from "../../ui/icons";
import { PasswordInput } from "./shared";

const TICKTICK_WARNING_KEYS: Record<TicktickWarningCode, string> = {
  folder: "settings.ticktickWarnFolder",
  noTaskId: "settings.ticktickWarnNoTaskId",
  missingParent: "settings.ticktickWarnMissingParent",
  repeat: "settings.ticktickWarnRepeat",
  reminders: "settings.ticktickWarnReminders",
  checklist: "settings.ticktickWarnChecklist",
  timezone: "settings.ticktickWarnTimezone",
};

const TODOIST_WARNING_KEYS: Record<TodoistWarningCode, string> = {
  notTodoist: "settings.todoistWarnNotTodoist",
  recurrence: "settings.todoistWarnRecurrence",
  date: "settings.todoistWarnDate",
  deadline: "settings.todoistWarnDeadline",
  duration: "settings.todoistWarnDuration",
  assignee: "settings.todoistWarnAssignee",
  projectNote: "settings.todoistWarnProjectNote",
  timezone: "settings.todoistWarnTimezone",
};

/**
 * Backup & restore. Import merges a bundle back in via LWW with fresh HLCs, so an imported value
 * wins on an id conflict and nothing is deleted.
 *
 * The export is the whole store in plaintext, so a signed-in account confirms its password first,
 * every time: an unlocked device left open is not enough to walk away with everything. The check
 * is local (`verifyPassword` re-derives the key that opens the session's wrapped DEK), so it works
 * offline. Local-only mode has no account password and exports directly.
 */
export function DataSection() {
  const { t } = useTranslation();
  const { store, kick, localOnly } = useStore();
  const { timezone } = usePreferences();
  const { session, verifyPassword } = useAuth();
  const toast = useToast();
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Bumped whenever the prompt opens or closes, so a slow check that finishes after Cancel is
  // dropped instead of exporting.
  const attempt = useRef(0);

  const runExport = async () => {
    try {
      await saveBundle(serializeBundle(exportData(store)), bundleFilename());
    } catch {
      toast.show(t("settings.exportError"));
    }
  };

  const resetPrompt = (open: boolean) => {
    attempt.current++;
    setAskPassword(open);
    setPassword("");
    setPasswordError(null);
    setChecking(false);
  };

  const doExport = () => {
    if (localOnly === true) void runExport();
    else resetPrompt(true);
  };

  const confirmPassword = async () => {
    if (checking) return;
    if (password === "") {
      setPasswordError(t("settings.deletePasswordHint"));
      return;
    }
    const id = attempt.current;
    setPasswordError(null);
    setChecking(true);
    let ok: boolean;
    try {
      ok = await verifyPassword(password);
    } catch {
      if (id === attempt.current) {
        setChecking(false);
        setPasswordError(t("settings.exportPasswordFailed"));
      }
      return;
    }
    if (id !== attempt.current) return;
    if (!ok) {
      setChecking(false);
      setPasswordError(t("settings.passwordIncorrect"));
      return;
    }
    resetPrompt(false);
    await runExport();
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

  const doImportTodoist = async () => {
    try {
      const file = await pickTodoistFile();
      if (file == null) return;
      const { bundle, counts, warnings } = todoistToBundle(
        readTodoistFiles(file.name, file.bytes),
        {
          userId: session?.user.id ?? "",
          timeZone: timezone,
        },
      );
      importBundle(store, kick, bundle);
      toast.show(t("settings.todoistDone", { tasks: counts.tasks, projects: counts.projects }));
      // What the mapping could not carry over; the import itself succeeded, so these are notices, not errors.
      for (const warning of warnings) {
        toast.show(t(TODOIST_WARNING_KEYS[warning.code], { detail: warning.detail ?? "" }));
      }
    } catch {
      toast.show(t("settings.todoistError"));
    }
  };

  return (
    <Section icon={Database} title={t("settings.data")}>
      <Row label={t("settings.export")} description={t("settings.exportDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.exportAction")}
          onPress={doExport}
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
      <Row label={t("settings.todoist")} description={t("settings.todoistDesc")}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.todoistAction")}
          onPress={() => void doImportTodoist()}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Upload size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("settings.todoistAction")}
          </Text>
        </Pressable>
      </Row>
      {/* Browser-only: it renders nothing on native, Electron and hardened private modes (see
          its header), so the phone's Data section is unchanged. */}
      <PersistentStorageRow />
      <ConfirmDialog
        visible={askPassword}
        title={t("settings.exportPasswordTitle")}
        message={t("settings.exportPasswordMessage")}
        confirmLabel={checking ? t("settings.exportPasswordChecking") : t("settings.exportAction")}
        confirmDisabled={checking}
        onConfirm={() => void confirmPassword()}
        onCancel={() => resetPrompt(false)}
      >
        <View className="gap-1">
          <PasswordInput
            accessibilityLabel={t("auth.password")}
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              setPasswordError(null);
            }}
            autoFocus
            textContentType="password"
            onSubmitEditing={() => void confirmPassword()}
            placeholder={t("settings.recoveryPasswordPlaceholder")}
          />
          {passwordError !== null && (
            <Text accessibilityRole="alert" className="text-xs text-red-600 dark:text-red-400">
              {passwordError}
            </Text>
          )}
        </View>
      </ConfirmDialog>
    </Section>
  );
}
