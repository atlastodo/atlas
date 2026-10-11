import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "../lib/appVersion";
import {
  ACCENTS,
  ACCENT_LABEL_KEYS,
  ACCENT_NAMES,
  LANGUAGES,
  REGION_OPTIONS,
  SMART_VIEWS,
  bundleFilename,
  exportData,
  importBundle,
  parseBundle,
  resolveTimeZone,
  serializeBundle,
  ticktickLegacyIdReusable,
  ticktickToBundle,
  timeZoneOptions,
  type AccentName,
  type DateFormatPref,
  type PomodoroConfig,
  type SmartView,
  type TaskSwipeAction,
  type ThemePref,
  type TicktickWarningCode,
  type TimeFormatPref,
} from "@atlas/shared";
import { isAdmin, apiErrorCode, type SessionView } from "@atlas/client-core";
import { useAuth } from "../auth/AuthContext";
import { RecoveryPhraseModal } from "../auth/RecoveryPhraseModal";
import {
  defaultServerUrl,
  getServerUrlOverride,
  isOnlineWeb,
  setServerUrlOverride,
} from "../auth/serverUrl";
import { useStore } from "../data/StoreProvider";
import { useToast } from "../data/ToastProvider";
import { saveBundle, pickBundleText, pickCsvText } from "../lib/dataTransfer";
import { explainNotifications } from "../lib/permissionExplainer";
import { openPermissionsSheet } from "../lib/permissionsSheet";
import { useMotion } from "../lib/motion";
import { usePreferences } from "../hooks/usePreferences";
import { useExactAlarms, useNotifyPermission } from "../hooks/useReminders";
import { usePomodoroConfig } from "../hooks/usePomodoroConfig";
import { useIsWide } from "../hooks/useIsWide";
import {
  resolveSettingsSection,
  settingsSections,
  type SettingsSectionId,
} from "../nav/settingsNav";
import { useProjects } from "../hooks/useProjects";
import i18n, { deviceLanguage } from "../i18n";
import { ListPicker, type PickerOption } from "../ui/ListPicker";
import { LabelsManager } from "../ui/LabelsManager";
import { Row, Section } from "../ui/Section";
import { Segmented } from "../ui/Segmented";
import { Toggle } from "../ui/Toggle";
import { ScreenFade } from "../ui/ScreenFade";
import { ReportProblemSheet } from "../ui/ReportProblemSheet";
import { SyncDetails } from "../ui/SyncDetails";
import {
  Bell,
  Bug,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Database,
  Download,
  Info,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Lock,
  LogOut,
  Menu,
  Palette,
  Pencil,
  RefreshCw,
  Server,
  Smartphone,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserPlus,
  UserRound,
  type LucideIcon,
} from "../ui/icons";
import { SkeletonRows } from "../ui/Skeleton";
import { useOnboarding } from "../data/OnboardingContext";
import { useLocalMode } from "../auth/localMode";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CloseToTrayRow } from "../ui/CloseToTrayRow";
import { DesktopUpdateSection } from "../ui/DesktopUpdateSection";
import { PersistentStorageRow } from "../ui/PersistentStorageRow";
import { useSignOut } from "../auth/useSignOut";
import { AdminPanel, type AdminTab } from "./AdminPanel";

/**
 * Settings. Every value is a field on the synced preference entity, written through
 * `usePreferences`, so it follows the account across devices.
 *
 * Every `<select>` is a {@link ListPicker} (RN has no select; the timezone list is searchable). The
 * server URL cannot apply itself: a phone app cannot rebind its `ApiClient`, so it saves and says
 * so. Data export/import splits by platform in `lib/dataTransfer`.
 */

/** The smart lists offered as a landing view (Completed is history, a poor place to land). */
const DEFAULT_VIEW_CHOICES: SmartView[] = SMART_VIEWS.filter((v) => v !== "completed");

const THEME_OPTIONS: { value: ThemePref; labelKey: string }[] = [
  { value: "system", labelKey: "settings.themeSystem" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
];
const TIME_OPTIONS: { value: TimeFormatPref; labelKey: string }[] = [
  { value: "auto", labelKey: "settings.auto" },
  { value: "12h", labelKey: "settings.time12h" },
  { value: "24h", labelKey: "settings.time24h" },
];
const DATE_OPTIONS: { value: DateFormatPref; labelKey: string }[] = [
  { value: "auto", labelKey: "settings.auto" },
  { value: "short", labelKey: "settings.short" },
  { value: "medium", labelKey: "settings.medium" },
  { value: "long", labelKey: "settings.long" },
];

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  // Buffered as text: a controlled numeric input cannot represent "" or a half-typed value.
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Math.round(Number(text));
    // A zero or invalid phase would never run; snap back.
    if (Number.isFinite(n) && n >= 1) onChange(n);
    else setText(String(value));
  };
  return (
    <Row label={label}>
      <TextInput
        accessibilityLabel={label}
        value={text}
        onChangeText={setText}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        returnKeyType="done"
        className="w-20 rounded border border-neutral-200 px-2.5 py-1.5 text-right text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
      />
    </Row>
  );
}

const TICKTICK_WARNING_KEYS: Record<TicktickWarningCode, string> = {
  folder: "settings.ticktickWarnFolder",
  noTaskId: "settings.ticktickWarnNoTaskId",
  missingParent: "settings.ticktickWarnMissingParent",
  repeat: "settings.ticktickWarnRepeat",
  reminders: "settings.ticktickWarnReminders",
  checklist: "settings.ticktickWarnChecklist",
  timezone: "settings.ticktickWarnTimezone",
};

/** A Settings row's secondary button: a label, pressed to act. */
function RowButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="rounded-md border border-neutral-200 px-3 py-2 web:cursor-pointer dark:border-neutral-800"
    >
      <Text className="text-sm text-neutral-600 dark:text-neutral-300">{label}</Text>
    </Pressable>
  );
}

/**
 * Everything that decides whether a reminder reaches the user, in one place: the reminders switch,
 * the notification permission and, on Android 12+, exact alarms (without them a locked phone's
 * reminders come up to ~10 minutes late). Each row says where it stands and offers its one fix.
 */
function NotificationsSection() {
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

/**
 * Backup & restore. Import merges a bundle back in via LWW with fresh HLCs, so an imported value
 * wins on an id conflict and nothing is deleted.
 */
function DataSection() {
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

/** Help and feedback: file a bug, and see the sync panel a bug report is usually about. */
function HelpSection({ onOpenAbout }: { onOpenAbout?: () => void }) {
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

/**
 * The self-hosted API server URL; storage lives in `auth/serverUrl.ts`. The stored value is read
 * asynchronously, so the field starts empty and fills in. Production builds ship no default, so the
 * placeholder is only a hint.
 */
function ServerSection() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOnlineWeb()) return;
    let live = true;
    void getServerUrlOverride().then((stored) => {
      if (live) setUrl(stored);
    });
    return () => {
      live = false;
    };
  }, []);

  if (isOnlineWeb()) return null;

  const save = () => {
    setServerUrlOverride(url).then(
      () => setSaved(true),
      (err) => console.warn("[atlas] could not save the server address:", err),
    );
  };

  return (
    <Section icon={Server} title={t("settings.server")}>
      <Row label={t("settings.serverUrl")} description={t("settings.serverUrlHint")}>
        <TextInput
          accessibilityLabel={t("settings.serverUrl")}
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setSaved(false);
          }}
          placeholder={defaultServerUrl || "http://localhost:8080"}
          placeholderTextColor="#a1a1aa"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className="w-44 rounded border border-neutral-200 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
        />
      </Row>
      <View className="flex-row items-center gap-3 py-2">
        <Pressable
          accessibilityRole="button"
          onPress={save}
          className="rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">{t("common.save")}</Text>
        </Pressable>
        {saved && (
          <Text className="flex-1 text-xs text-neutral-500">{t("settings.serverUrlSaved")}</Text>
        )}
      </View>
    </Section>
  );
}

/**
 * A short relative label ("just now", "3 days ago") for a unix-millis stamp, via
 * `Intl.RelativeTimeFormat`. Falls through coarse units so a minute never reads "0 hours ago".
 * `locale` defaults to the app language, not the device's: the label sits inside translated text.
 */
export function relativeLabel(ms: number, now: number, locale: string = i18n.language): string {
  // Whole minutes: sub-minute noise would read "1 second ago" for one network round trip.
  const diff = Math.round((ms - now) / 60_000);
  const m = Math.abs(diff);
  // The units subtract down the same signed `diff`, which already carries "ago"/"in"; do not flip it again.
  let value = diff;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  if (m >= 60 * 24 * 365) {
    value = Math.round(diff / (60 * 24 * 365));
    unit = "year";
  } else if (m >= 60 * 24 * 30) {
    value = Math.round(diff / (60 * 24 * 30));
    unit = "month";
  } else if (m >= 60 * 24) {
    value = Math.round(diff / (60 * 24));
    unit = "day";
  } else if (m >= 60) {
    value = Math.round(diff / 60);
    unit = "hour";
  }
  // Hermes on Android may lack `Intl.RelativeTimeFormat`, where the constructor is `undefined`. The
  // fallback must never touch that constructor; it renders plain text in the same coarse units.
  const formed =
    typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
      ? (() => {
          try {
            return new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" }).format(
              value,
              unit,
            );
          } catch {
            return null;
          }
        })()
      : null;
  if (formed !== null) return formed;
  // The fallback is translated too, so a Danish screen never reads "2 timer ago".
  const t = locale ? i18n.getFixedT(locale) : i18n.t.bind(i18n);
  if (value === 0) return t("relativeTime.justNow");
  const amount = t(`relativeTime.${unit}`, { count: Math.abs(value) });
  return t(value < 0 ? "relativeTime.past" : "relativeTime.future", { amount });
}

function RenameDeviceDialog({
  session,
  onClose,
  onRenamed,
}: {
  session: SessionView | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { t } = useTranslation();
  const { api } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(session?.device_name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(session?.device_name ?? "");
  }, [session]);

  if (!session) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || saving) return;
    setSaving(true);
    try {
      await api.renameSession(session.device_id, trimmed);
      toast.show(t("settings.devicesRenamed"));
      onClose();
      onRenamed();
    } catch {
      toast.show(t("settings.devicesRenameFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfirmDialog
      visible={true}
      title={t("settings.devicesRenameTitle")}
      confirmLabel={t("common.save")}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <View className="gap-1 py-1">
        <TextInput
          accessibilityLabel={t("settings.devicesRenamePlaceholder")}
          placeholder={t("settings.devicesRenamePlaceholder")}
          value={name}
          onChangeText={setName}
          autoFocus
          autoCapitalize="sentences"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          onSubmitEditing={() => void submit()}
        />
      </View>
    </ConfirmDialog>
  );
}

/**
 * Devices & sessions: every device signed in to the account (`GET /auth/sessions`). The current
 * device's row has no sign-out button, because the server refuses self-revocation on this route;
 * "Sign out" in the account section is the way out. Signing out other devices goes through a
 * {@link ConfirmDialog}, being irreversible.
 */
function DevicesSection() {
  const { t } = useTranslation();
  const { api } = useAuth();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionView | null>(null);
  const handleCloseRename = useCallback(() => setRenameTarget(null), []);

  const load = useCallback(async () => {
    setFailed(false);
    setReloading(true);
    try {
      setSessions(await api.listSessions());
    } catch {
      setFailed(true);
    } finally {
      setReloading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await api.revokeSession(deviceId);
      toast.show(t("settings.devicesRevoked"));
      await load();
    } catch {
      toast.show(t("settings.devicesRevokeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const revokeOthers = async () => {
    setConfirmRevokeOthers(false);
    try {
      await api.revokeOtherSessions();
      toast.show(t("settings.devicesRevokeOthersDone"));
      await load();
    } catch {
      toast.show(t("settings.devicesRevokeOthersFailed"));
    }
  };

  const deviceName = (s: SessionView) =>
    s.device_name || t("settings.devicesDeviceLabel", { id: s.device_id.slice(0, 8) });

  const formatMoment = (ms: number, now: number, justNowKey: string, relativeKey: string) => {
    const diff = Math.round((ms - now) / 60_000);
    if (diff === 0) return t(justNowKey);
    return t(relativeKey, { when: relativeLabel(ms, now) });
  };

  const whenPart = (s: SessionView) => {
    const now = Date.now();
    return (
      formatMoment(s.created_at, now, "settings.devicesCreatedJustNow", "settings.devicesCreated") +
      " · " +
      formatMoment(
        s.last_used_at,
        now,
        "settings.devicesLastUsedJustNow",
        "settings.devicesLastUsed",
      )
    );
  };

  const expiresPart = (s: SessionView) =>
    t("settings.devicesExpires", {
      when: relativeLabel(s.expires_at, Date.now()),
    });

  const others = (sessions ?? []).filter((s) => !s.current);

  return (
    <>
      <Section icon={Smartphone} title={t("settings.devices")}>
        {sessions === null ? (
          failed ? (
            <Row label={t("settings.devicesLoadFailed")}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("settings.devicesLoadRetry")}
                onPress={() => void load()}
                className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <RefreshCw size={18} className="text-neutral-600 dark:text-neutral-300" />
                <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t("common.retry")}
                </Text>
              </Pressable>
            </Row>
          ) : (
            <View className="py-3">
              <SkeletonRows count={2} />
            </View>
          )
        ) : (
          <>
            {sessions.length === 0
              ? null
              : sessions.map((s) => (
                  <Row key={s.device_id} label={deviceName(s)} description={whenPart(s)}>
                    <View className="flex-row items-center gap-2">
                      {s.current && (
                        <Text className="text-xs font-medium text-accent-600 dark:text-accent-400">
                          {t("settings.devicesThisDevice")}
                        </Text>
                      )}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t("settings.devicesRename")} ${deviceName(s)}`}
                        disabled={busyId !== null}
                        onPress={() => setRenameTarget(s)}
                        hitSlop={8}
                        className="p-1 rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        <Pencil size={16} className="text-neutral-500 dark:text-neutral-400" />
                      </Pressable>
                      {!s.current && (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${t("settings.devicesRevoke")} ${deviceName(s)}`}
                          accessibilityHint={expiresPart(s)}
                          disabled={busyId !== null}
                          onPress={() => void revoke(s.device_id)}
                          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                        >
                          <LogOut size={18} className="text-neutral-600 dark:text-neutral-300" />
                          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                            {t("settings.devicesRevoke")}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  </Row>
                ))}
          </>
        )}
      </Section>

      {sessions !== null && (
        <DangerZone>
          <Row
            label={t("settings.devicesRevokeOthers")}
            description={t("settings.devicesRevokeOthersDesc")}
          >
            <DangerButton
              icon={LogOut}
              label={t("settings.devicesRevokeOthers")}
              disabled={reloading || busyId !== null || others.length === 0}
              onPress={() => setConfirmRevokeOthers(true)}
            />
          </Row>
        </DangerZone>
      )}

      <ConfirmDialog
        visible={confirmRevokeOthers}
        title={t("settings.devicesRevokeOthersConfirmTitle")}
        message={t("settings.devicesRevokeOthersConfirmMessage")}
        confirmLabel={t("settings.devicesRevokeOthers")}
        danger
        onConfirm={() => void revokeOthers()}
        onCancel={() => setConfirmRevokeOthers(false)}
      />

      <RenameDeviceDialog
        session={renameTarget}
        onClose={handleCloseRename}
        onRenamed={() => void load()}
      />
    </>
  );
}

/**
 * A masked password field for the account forms. No fixed width: a stacked phone row stretches it
 * to the card's width, a side-by-side row gives it its minimum.
 */
function PasswordInput(props: TextInputProps) {
  return (
    <TextInput
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor="#a1a1aa"
      className="min-w-56 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-zinc-900 dark:text-neutral-100"
      {...props}
    />
  );
}

/** A section's irreversible actions, in their own red-edged card below the everyday ones. */
function DangerZone({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <View className="mb-6">
      <View className="mb-2 flex-row items-center gap-2 px-1">
        <CircleAlert
          size={Platform.OS === "web" ? 16 : 18}
          className="text-red-600 dark:text-red-400"
        />
        <Text className="text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
          {t("settings.dangerZone")}
        </Text>
      </View>
      <View className="overflow-hidden rounded-2xl border border-red-200 bg-red-50/40 px-4 py-1 dark:border-red-900/60 dark:bg-red-950/20">
        {children}
      </View>
    </View>
  );
}

function DangerButton({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={
        "flex-row items-center justify-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 active:bg-red-100 dark:border-red-900/50 dark:bg-red-950/30 dark:active:bg-red-950/60 " +
        (disabled ? "opacity-60" : "")
      }
    >
      <Icon size={18} className="text-red-600 dark:text-red-400" />
      <Text className="text-sm font-medium text-red-600 dark:text-red-400">{label}</Text>
    </Pressable>
  );
}

/** The new password's length floor; the server only sees the derived auth hash, so this rule is the client's. */
const MIN_PASSWORD_LEN = 8;

/**
 * Change password. For an E2EE account the key material is re-wrapped under the new password in
 * `@atlas/client-core` (`buildE2eePasswordChange`); the server verifies the current credential and
 * swaps hash and wrapped keys atomically. Inline validation covers the length floor and confirm match.
 */
function SecuritySection() {
  const { t } = useTranslation();
  const { changePassword } = useAuth();
  const toast = useToast();
  const isWide = useIsWide();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (next.length < MIN_PASSWORD_LEN) {
      setError(t("settings.passwordTooShort"));
      return;
    }
    if (next !== confirm) {
      setError(t("settings.passwordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.show(t("settings.changePasswordDone"));
    } catch (err) {
      // A wrong current password is a 403 with its own code; a 401 is the session, not the password.
      if (apiErrorCode(err) === "invalid_credentials") {
        setError(t("settings.passwordIncorrect"));
      } else {
        setError(t("settings.changePasswordFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={KeyRound} title={t("settings.changePassword")}>
      <Row label={t("settings.currentPassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.currentPassword")}
          value={current}
          onChangeText={setCurrent}
          placeholder={t("settings.currentPasswordPlaceholder")}
        />
      </Row>
      <Row label={t("settings.newPassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.newPassword")}
          value={next}
          onChangeText={setNext}
          textContentType="newPassword"
          placeholder={t("settings.newPasswordPlaceholder")}
        />
      </Row>
      <Row label={t("settings.confirmNewPassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.confirmNewPassword")}
          value={confirm}
          onChangeText={setConfirm}
          textContentType="newPassword"
          onSubmitEditing={() => void submit()}
          placeholder={t("settings.confirmNewPasswordPlaceholder")}
        />
      </Row>
      <View className={isWide ? "flex-row items-center gap-3 py-3" : "gap-2 py-3"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.updatePassword")}
          disabled={busy}
          onPress={() => void submit()}
          className={
            "items-center rounded-md bg-accent-600 px-4 py-2.5 active:bg-accent-500 " +
            (busy ? "opacity-60" : "")
          }
        >
          <Text className="text-sm font-medium text-white">{t("settings.updatePassword")}</Text>
        </Pressable>
        {error !== null && (
          <Text
            accessibilityRole="alert"
            className={"text-xs text-red-600 dark:text-red-400 " + (isWide ? "flex-1" : "")}
          >
            {error}
          </Text>
        )}
      </View>
    </Section>
  );
}

/**
 * Create a new recovery phrase. The server verifies the password and replaces the phrase's key and
 * wrapped keys in one step; the new phrase is shown once, in the modal sign-up uses. The old phrase
 * stops recovering the account.
 */
function RecoveryPhraseSection() {
  const { t } = useTranslation();
  const { replaceRecoveryPhrase } = useAuth();
  const isWide = useIsWide();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (password === "") {
      setError(t("settings.deletePasswordHint"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await replaceRecoveryPhrase(password);
      setPassword("");
      setPhrase(next);
    } catch (err) {
      setError(
        apiErrorCode(err) === "invalid_credentials"
          ? t("settings.passwordIncorrect")
          : t("settings.newRecoveryPhraseFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={Lock} title={t("settings.recoveryPhrase")}>
      <Text className="py-3 text-sm text-neutral-600 dark:text-neutral-400">
        {t("settings.newRecoveryPhraseDesc")}
      </Text>
      <Row label={t("settings.newRecoveryPhrasePassword")}>
        <PasswordInput
          accessibilityLabel={t("settings.newRecoveryPhrasePassword")}
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            setError(null);
          }}
          textContentType="password"
          onSubmitEditing={() => void submit()}
          placeholder={t("settings.recoveryPasswordPlaceholder")}
        />
      </Row>
      <View className={isWide ? "flex-row items-center gap-3 py-3" : "gap-2 py-3"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.newRecoveryPhrase")}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void submit()}
          className={
            "items-center rounded-md border border-neutral-300 px-4 py-2.5 dark:border-neutral-600 " +
            (busy ? "opacity-60" : "")
          }
        >
          <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("settings.newRecoveryPhrase")}
          </Text>
        </Pressable>
        {error !== null && (
          <Text
            accessibilityRole="alert"
            className={"text-xs text-red-600 dark:text-red-400 " + (isWide ? "flex-1" : "")}
          >
            {error}
          </Text>
        )}
      </View>
      <RecoveryPhraseModal phrase={phrase} replaced onClose={() => setPhrase(null)} />
    </Section>
  );
}

/** A section's content, mounted only while selected, so e.g. the devices list is fetched only when opened. */
/**
 * The Account pane in local-only mode: the data is on this device only, and an account (to sync
 * between devices and share projects) is one tap away. Either way the local data moves into the
 * account (`LocalUpgradeGate`).
 */
function LocalAccountSection() {
  const { t } = useTranslation();
  const local = useLocalMode();
  return (
    <Section icon={UserRound} title={t("settings.account")}>
      <View className="gap-1 py-3">
        <Text className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {t("localMode.settingsTitle")}
        </Text>
        <Text className="text-sm text-neutral-600 dark:text-neutral-300">
          {t("localMode.settingsDesc")}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2 pb-3">
        <Pressable
          accessibilityRole="button"
          onPress={() => local?.openAuth("signup")}
          className="flex-row items-center gap-1.5 rounded-md bg-accent-600 px-3 py-2"
        >
          <UserPlus size={18} className="text-white" />
          <Text className="text-sm font-medium text-white">{t("localMode.createAccount")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => local?.openAuth("login")}
          className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
        >
          <UserRound size={18} className="text-neutral-600 dark:text-neutral-300" />
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("localMode.signIn")}
          </Text>
        </Pressable>
      </View>
    </Section>
  );
}

function SettingsPane({
  id,
  active,
  children,
}: {
  id: SettingsSectionId;
  active: SettingsSectionId;
  children: ReactNode;
}) {
  return id === active ? <View>{children}</View> : null;
}

export function SettingsScreen({
  section,
  onSelectSection,
  adminTab,
  onSelectAdminTab,
  onOpenAbout,
}: {
  section?: string | string[];
  /** Select a section; the route writes it to `?section=`, which comes back as `section`. */
  onSelectSection: (id: SettingsSectionId) => void;
  /** The Admin section's `?tab=`, and how to select one. */
  adminTab?: string | string[];
  onSelectAdminTab: (tab: AdminTab) => void;
  onOpenAbout?: () => void;
}) {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    accent,
    setAccent,
    language,
    setLanguage,
    region,
    setRegion,
    weekStartsOn,
    setWeekStartsOn,
    timezone,
    setTimezone,
    timeFormat,
    setTimeFormat,
    dateFormat,
    setDateFormat,
    focusEnabled,
    setFocusEnabled,
    focusSoundEnabled,
    setFocusSoundEnabled,
    habitsEnabled,
    setHabitsEnabled,
    countdownsEnabled,
    setCountdownsEnabled,
    statsEnabled,
    setStatsEnabled,
    smartDatesEnabled,
    setSmartDatesEnabled,
    hapticsEnabled,
    setHapticsEnabled,
    defaultView,
    setDefaultView,
    showWeekNumbers,
    setShowWeekNumbers,
    toastDuration,
    setToastDuration,
    swipeRightAction,
    setSwipeRightAction,
    swipeLeftAction,
    setSwipeLeftAction,
    smartViewInMenu,
    setSmartViewInMenu,
    projectPinned,
    setProjectPinned,
  } = usePreferences();
  const { projects } = useProjects();
  const isWide = useIsWide();
  const { config, setConfig } = usePomodoroConfig();
  const { session, deleteAccount } = useAuth();
  const { localOnly } = useStore();
  const { signOut, dialog: signOutDialog } = useSignOut();
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectsMenuExpanded, setProjectsMenuExpanded] = useState(false);
  const motion = useMotion();
  const pillScrollViewRef = useRef<ScrollView>(null);
  const pillX = useRef<Partial<Record<SettingsSectionId, number>>>({});

  const toggleProjectsMenu = () => {
    setProjectsMenuExpanded((prev) => !prev);
  };

  const setPomodoro = (key: keyof PomodoroConfig) => (value: number) => setConfig({ [key]: value });
  const tr = <T extends string | number>(opts: { value: T; labelKey: string }[]) =>
    opts.map((o) => ({ value: o.value, label: t(o.labelKey) }));

  // The URL owns the selection (`?section=`), so deep links and back/forward land on the same section.
  const sections = useMemo(
    () => settingsSections(isAdmin(session), localOnly === true),
    [session, localOnly],
  );
  const active = resolveSettingsSection(section, sections);

  // Keep the selected pill in view; the layout pass arrives after first render, so a pill measuring itself as selected scrolls too.
  const revealPill = (id: SettingsSectionId) => {
    const x = pillX.current[id];
    if (x !== undefined)
      pillScrollViewRef.current?.scrollTo({ x: Math.max(0, x - 24), animated: true });
  };
  useEffect(() => revealPill(active), [active]);

  const deviceZone = resolveTimeZone("");
  const deviceLangCode = deviceLanguage();
  const deviceLangLabel = LANGUAGES.find((l) => l.code === deviceLangCode)?.label ?? deviceLangCode;
  const deviceRegionLabel = new Intl.DateTimeFormat().resolvedOptions().locale || deviceLangCode;

  const viewOptions: PickerOption<SmartView>[] = DEFAULT_VIEW_CHOICES.map((v) => ({
    value: v,
    label: t(`nav.${v}`),
  }));

  const swipeActionOptions: PickerOption<TaskSwipeAction>[] = [
    { value: "indent", label: t("settings.swipeActionIndent") },
    { value: "complete", label: t("settings.swipeActionComplete") },
    { value: "schedule", label: t("settings.swipeActionSchedule") },
    { value: "delete", label: t("settings.swipeActionDelete") },
    { value: "none", label: t("settings.swipeActionNone") },
  ];

  const toastDurationOptions: PickerOption<string>[] = [
    { value: "2", label: "2s" },
    { value: "3", label: "3s" },
    { value: "5", label: "5s" },
    { value: "6", label: "6s" },
    { value: "8", label: "8s" },
    { value: "10", label: "10s" },
  ];

  const languageOptions: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceLangLabel },
    ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];
  const timezoneChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceZone },
    ...timeZoneOptions().map((z) => ({ value: z, label: z })),
  ];
  const regionChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceRegionLabel },
    ...REGION_OPTIONS.map((r) => ({ value: r.tag, label: r.label })),
  ];

  const sampleDate = useMemo(() => new Date(2026, 8, 3, 14, 30), []);
  const resolvedAutoTimeSample = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(region || undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: timezone || undefined,
      }).format(sampleDate);
    } catch {
      return "14:30";
    }
  }, [sampleDate, region, timezone]);

  const timeFormatDesc = useMemo(() => {
    if (timeFormat === "auto") {
      return t("settings.timeFormatAutoDesc", { sample: resolvedAutoTimeSample });
    }
    if (timeFormat === "12h") {
      return t("settings.timeFormat12hDesc");
    }
    return t("settings.timeFormat24hDesc");
  }, [timeFormat, resolvedAutoTimeSample, t]);

  const sampleDateMap = useMemo(() => {
    const loc = region || undefined;
    const tz = timezone || undefined;
    try {
      return {
        auto: new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeZone: tz }).format(
          sampleDate,
        ),
        short: new Intl.DateTimeFormat(loc, { dateStyle: "short", timeZone: tz }).format(
          sampleDate,
        ),
        medium: new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeZone: tz }).format(
          sampleDate,
        ),
        long: new Intl.DateTimeFormat(loc, { dateStyle: "long", timeZone: tz }).format(sampleDate),
      };
    } catch {
      return {
        auto: "3 Sep 2026",
        short: "03/09/2026",
        medium: "3 Sep 2026",
        long: "3 September 2026",
      };
    }
  }, [sampleDate, region, timezone]);

  const dateFormatDesc = useMemo(() => {
    if (dateFormat === "auto") {
      return t("settings.dateFormatAutoDesc", { sample: sampleDateMap.auto });
    }
    if (dateFormat === "short") {
      return t("settings.dateFormatShortDesc", { sample: sampleDateMap.short });
    }
    if (dateFormat === "medium") {
      return t("settings.dateFormatMediumDesc", { sample: sampleDateMap.medium });
    }
    return t("settings.dateFormatLongDesc", { sample: sampleDateMap.long });
  }, [dateFormat, sampleDateMap, t]);

  const renderSections = () => (
    <View className="gap-6">
      {/* Appearance */}
      <SettingsPane id="appearance" active={active}>
        <Section icon={Palette} title={t("settings.appearance")}>
          <Row label={t("settings.theme")} description={t("settings.themeDesc")}>
            <Segmented
              value={theme}
              options={tr(THEME_OPTIONS)}
              onChange={setTheme}
              label={t("settings.theme")}
            />
          </Row>
          <Row label={t("settings.accent")} description={t("settings.accentDesc")}>
            <View accessibilityRole="radiogroup" className="flex-row items-center gap-2">
              {ACCENT_NAMES.map((name) => (
                <Pressable
                  key={name}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: accent === name }}
                  accessibilityLabel={t(ACCENT_LABEL_KEYS[name])}
                  onPress={() => setAccent(name as AccentName)}
                  style={{ backgroundColor: ACCENTS[name][600] }}
                  className={
                    "h-8 w-8 rounded-full border-2 " +
                    (accent === name
                      ? "border-neutral-900 dark:border-white"
                      : "border-transparent")
                  }
                />
              ))}
            </View>
          </Row>
          <ListPicker
            label={t("settings.language")}
            description={t("settings.languageDesc")}
            value={language}
            options={languageOptions}
            onChange={setLanguage}
          />
        </Section>
      </SettingsPane>

      {/* Sidebar & Navigation */}
      <SettingsPane id="sidebar" active={active}>
        <Section icon={Menu} title={t("settings.sidebarMenu")}>
          <View className="py-2">
            <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
              {t("settings.smartLists")}
            </Text>
            <Text className="text-xs text-neutral-400 dark:text-neutral-500">
              {t("settings.smartListsDesc")}
            </Text>
          </View>
          {SMART_VIEWS.map((v) => (
            <Toggle
              key={v}
              label={t(`nav.${v}`)}
              accessibilityLabel={`${t(`nav.${v}`)} in menu`}
              value={smartViewInMenu(v)}
              onValueChange={(val) => setSmartViewInMenu(v, val)}
            />
          ))}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("settings.projectsInMenu")}
            onPress={toggleProjectsMenu}
            className={`mt-4 flex-row items-center justify-between border-t border-neutral-100 pt-3 dark:border-zinc-800 ${
              !projectsMenuExpanded ? "pb-3" : "pb-0"
            }`}
          >
            <View className="flex-1 pr-2">
              <View className="flex-row items-center gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("settings.projectsInMenu")}
                </Text>
                <View className="rounded-full bg-neutral-200 px-2 py-0.5 dark:bg-zinc-800">
                  <Text className="text-[10px] font-medium text-neutral-600 dark:text-neutral-300">
                    {projects.length}
                  </Text>
                </View>
              </View>
              <Text className="text-xs text-neutral-400 dark:text-neutral-500">
                {t("settings.projectsInMenuDesc")}
              </Text>
            </View>
            <View className="h-7 w-7 items-center justify-center rounded-lg bg-neutral-100 dark:bg-zinc-800">
              {projectsMenuExpanded ? (
                <ChevronUp size={16} className="text-neutral-600 dark:text-neutral-300" />
              ) : (
                <ChevronDown size={16} className="text-neutral-600 dark:text-neutral-300" />
              )}
            </View>
          </Pressable>

          {projectsMenuExpanded && (
            <Animated.View
              entering={motion.rowEntering}
              exiting={motion.rowExiting}
              layout={motion.rowLayout}
              style={{ marginTop: 8, paddingLeft: 8, overflow: "hidden" }}
            >
              {projects.length === 0 ? (
                <Text className="py-2 text-sm italic text-neutral-400 dark:text-neutral-500">
                  {t("nav.noProjects")}
                </Text>
              ) : (
                projects.map((p) => (
                  <Toggle
                    key={p.id}
                    label={p.name}
                    accessibilityLabel={`${p.name} in menu`}
                    value={projectPinned(p.id)}
                    onValueChange={(val) => setProjectPinned(p.id, val)}
                  />
                ))
              )}
            </Animated.View>
          )}
        </Section>
      </SettingsPane>

      {/* Tasks & Gestures */}
      <SettingsPane id="tasks" active={active}>
        <Section icon={ListChecks} title={t("settings.tasksGestures")}>
          <ListPicker
            label={t("settings.defaultView")}
            description={t("settings.defaultViewDesc")}
            value={defaultView}
            options={viewOptions}
            onChange={setDefaultView}
          />
          <ListPicker
            label={t("settings.swipeRight")}
            description={t("settings.swipeRightDesc")}
            value={swipeRightAction}
            options={swipeActionOptions}
            onChange={setSwipeRightAction}
          />
          <ListPicker
            label={t("settings.swipeLeft")}
            description={t("settings.swipeLeftDesc")}
            value={swipeLeftAction}
            options={swipeActionOptions}
            onChange={setSwipeLeftAction}
          />
          <ListPicker
            label={t("settings.toastDuration")}
            description={t("settings.toastDurationDesc")}
            value={String(toastDuration)}
            options={toastDurationOptions}
            onChange={(val) => setToastDuration(Number(val))}
          />
          <Toggle
            label={t("settings.smartDates")}
            description={t("settings.smartDatesDesc")}
            value={smartDatesEnabled}
            onValueChange={setSmartDatesEnabled}
          />
          {Platform.OS !== "web" && (
            <Toggle
              label={t("settings.haptics")}
              description={t("settings.hapticsDesc")}
              value={hapticsEnabled}
              onValueChange={setHapticsEnabled}
            />
          )}
        </Section>
      </SettingsPane>

      {/* Calendar & Time */}
      <SettingsPane id="calendar" active={active}>
        <Section icon={CalendarClock} title={t("settings.calendarTime")}>
          <Row label={t("settings.weekStart")} description={t("settings.weekStartDesc")}>
            <Segmented
              value={weekStartsOn}
              options={[
                { value: 0, label: t("settings.sun") },
                { value: 1, label: t("settings.mon") },
              ]}
              onChange={setWeekStartsOn}
              label={t("settings.weekStart")}
            />
          </Row>
          <Toggle
            label={t("settings.showWeekNumbers")}
            description={t("settings.showWeekNumbersDesc")}
            value={showWeekNumbers}
            onValueChange={setShowWeekNumbers}
          />
          <Row label={t("settings.timeFormat")} description={timeFormatDesc}>
            <Segmented
              value={timeFormat}
              options={tr(TIME_OPTIONS)}
              onChange={setTimeFormat}
              label={t("settings.timeFormat")}
            />
          </Row>
          <Row label={t("settings.dateFormat")} description={dateFormatDesc}>
            <Segmented
              value={dateFormat}
              options={tr(DATE_OPTIONS)}
              onChange={setDateFormat}
              label={t("settings.dateFormat")}
            />
          </Row>
          <ListPicker
            label={t("settings.timezone")}
            description={t("settings.timezoneDesc")}
            value={timezone}
            options={timezoneChoices}
            onChange={setTimezone}
          />
          <ListPicker
            label={t("settings.region")}
            description={t("settings.regionDesc")}
            value={region}
            options={regionChoices}
            onChange={setRegion}
          />
        </Section>
      </SettingsPane>

      {/* Features */}
      <SettingsPane id="features" active={active}>
        <Section icon={SlidersHorizontal} title={t("settings.features")}>
          <Toggle
            label={t("settings.focus")}
            description={t("settings.focusDesc")}
            value={focusEnabled}
            onValueChange={setFocusEnabled}
          />
          <Toggle
            label={t("settings.countdowns")}
            description={t("settings.countdownsDesc")}
            value={countdownsEnabled}
            onValueChange={setCountdownsEnabled}
          />
          <Toggle
            label={t("settings.habits")}
            description={t("settings.habitsDesc")}
            value={habitsEnabled}
            onValueChange={setHabitsEnabled}
          />
          <Toggle
            label={t("settings.stats")}
            description={t("settings.statsDesc")}
            value={statsEnabled}
            onValueChange={setStatsEnabled}
          />
        </Section>
        {focusEnabled && (
          <Section icon={SlidersHorizontal} title={t("settings.pomodoro")}>
            <NumberField
              key={`work-${config.workMin}`}
              label={t("settings.focusLength")}
              value={config.workMin}
              onChange={setPomodoro("workMin")}
            />
            <NumberField
              key={`short-${config.shortBreakMin}`}
              label={t("settings.shortBreak")}
              value={config.shortBreakMin}
              onChange={setPomodoro("shortBreakMin")}
            />
            <NumberField
              key={`long-${config.longBreakMin}`}
              label={t("settings.longBreak")}
              value={config.longBreakMin}
              onChange={setPomodoro("longBreakMin")}
            />
            <NumberField
              key={`every-${config.longBreakEvery}`}
              label={t("settings.longBreakEvery")}
              value={config.longBreakEvery}
              onChange={setPomodoro("longBreakEvery")}
            />
            <Toggle
              label={t("settings.focusSound")}
              description={t("settings.focusSoundDesc")}
              value={focusSoundEnabled}
              onValueChange={setFocusSoundEnabled}
            />
          </Section>
        )}
      </SettingsPane>

      {/* Notifications */}
      <SettingsPane id="notifications" active={active}>
        <NotificationsSection />
      </SettingsPane>

      {/* Labels */}
      <SettingsPane id="labels" active={active}>
        <Section icon={Tag} title={t("label.manage")}>
          <LabelsManager />
        </Section>
      </SettingsPane>

      {/* Data & Backup */}
      <SettingsPane id="data" active={active}>
        <DataSection />
      </SettingsPane>

      {/* Server */}
      <SettingsPane id="server" active={active}>
        <ServerSection />
      </SettingsPane>

      {/* Devices & sessions */}
      <SettingsPane id="devices" active={active}>
        <DevicesSection />
      </SettingsPane>

      {/* Desktop app: only listed inside the desktop app */}
      <SettingsPane id="desktop" active={active}>
        <CloseToTrayRow />
        <DesktopUpdateSection />
      </SettingsPane>

      {/* Help & Feedback */}
      <SettingsPane id="help" active={active}>
        <HelpSection onOpenAbout={onOpenAbout} />
      </SettingsPane>

      {/* Account */}
      <SettingsPane id="account" active={active}>
        {localOnly ? (
          <LocalAccountSection />
        ) : (
          <>
            <Section icon={UserRound} title={t("settings.account")}>
              <Row label={t("settings.signedInAs")}>
                <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                  {session?.user.display_name || session?.user.email || "-"}
                </Text>
              </Row>
              {session?.user.display_name != null && session.user.display_name !== "" && (
                <Row label={t("settings.email")}>
                  <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                    {session.user.email}
                  </Text>
                </Row>
              )}
              <View className="flex-row items-center gap-2 py-3">
                <Pressable
                  accessibilityRole="button"
                  onPress={signOut}
                  className="flex-row items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                >
                  <LogOut size={18} className="text-neutral-600 dark:text-neutral-300" />
                  <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                    {t("common.signOut")}
                  </Text>
                </Pressable>
              </View>
            </Section>

            <SecuritySection />
            <RecoveryPhraseSection />

            <DangerZone>
              <Row label={t("auth.deleteAccount")} description={t("settings.deleteAccountDesc")}>
                <DangerButton
                  icon={Trash2}
                  label={t("auth.deleteAccount")}
                  onPress={() => setConfirmDeleteAccount(true)}
                />
              </Row>
            </DangerZone>
          </>
        )}
      </SettingsPane>
    </View>
  );

  // One section per page: a fresh ScrollView per id starts each at the top. Admin's tabs scroll
  // themselves (virtualized lists), so it gets no page ScrollView around it.
  const page = (contentClassName: string) =>
    active === "admin" ? (
      <View className="flex-1 bg-white dark:bg-zinc-950">
        <AdminPanel tab={adminTab} onSelectTab={onSelectAdminTab} />
      </View>
    ) : (
      <ScrollView
        key={active}
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerClassName={contentClassName}
        keyboardShouldPersistTaps="handled"
      >
        {renderSections()}
      </ScrollView>
    );

  return (
    <ScreenFade>
      <View className="flex-1 bg-white dark:bg-zinc-950">
        {isWide ? (
          // Wide: the `(drawer)` layout swaps its rows for `SettingsSidebar`, so the page is only the section.
          page("px-8 py-6 pb-16 max-w-2xl mx-auto w-full")
        ) : (
          <View className="flex-1 bg-white dark:bg-zinc-950">
            {/* Phone: the pill bar picks the section; the page below shows just that one. */}
            <View
              accessibilityLabel={t("settings.sectionsNav")}
              className="border-b border-neutral-200 bg-white py-2.5 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <ScrollView
                ref={pillScrollViewRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="px-4 gap-2 flex-row items-center"
              >
                {sections.map((sec) => {
                  const Icon = sec.icon;
                  const isActive = active === sec.id;
                  return (
                    <Pressable
                      key={sec.id}
                      accessibilityRole="button"
                      accessibilityLabel={t(sec.labelKey)}
                      accessibilityState={{ selected: isActive }}
                      onPress={() => onSelectSection(sec.id)}
                      onLayout={(e) => {
                        pillX.current[sec.id] = e.nativeEvent.layout.x;
                        if (isActive) revealPill(sec.id);
                      }}
                      className={`flex-row items-center gap-1.5 rounded-full px-3.5 py-1.5 border web:cursor-pointer web:focus-visible:outline web:focus-visible:outline-2 web:focus-visible:outline-accent-500 ${
                        isActive
                          ? "border-neutral-900 bg-neutral-900 dark:border-zinc-700 dark:bg-zinc-800"
                          : "border-neutral-200 bg-neutral-50 dark:border-zinc-800 dark:bg-zinc-900"
                      }`}
                    >
                      <Icon
                        size={14}
                        className={
                          isActive
                            ? "text-white dark:text-neutral-100"
                            : "text-neutral-600 dark:text-neutral-400"
                        }
                      />
                      <Text
                        className={`text-xs font-medium ${
                          isActive
                            ? "text-white dark:text-neutral-100"
                            : "text-neutral-700 dark:text-neutral-300"
                        }`}
                      >
                        {t(sec.labelKey)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            {page("px-4 py-4 pb-32")}
          </View>
        )}
      </View>

      <ConfirmDialog
        visible={confirmDeleteAccount}
        title={t("auth.deleteAccountConfirmTitle")}
        message={t("auth.deleteAccountConfirmMessage")}
        confirmLabel={t("auth.deleteAccount")}
        danger
        onConfirm={async () => {
          if (deletePassword === "") {
            setDeleteError(t("settings.deletePasswordHint"));
            return;
          }
          setDeleteError(null);
          try {
            await deleteAccount(deletePassword);
            setConfirmDeleteAccount(false);
          } catch (e) {
            if (apiErrorCode(e) === "invalid_credentials") {
              setDeleteError(t("settings.passwordIncorrect"));
            } else {
              setDeleteError(t("auth.genericError"));
            }
          }
        }}
        onCancel={() => {
          setConfirmDeleteAccount(false);
          setDeletePassword("");
          setDeleteError(null);
        }}
      >
        <View className="gap-1">
          <Text className="text-sm text-neutral-600 dark:text-neutral-400">
            {t("auth.password")}
          </Text>
          <TextInput
            accessibilityLabel={t("auth.password")}
            value={deletePassword}
            onChangeText={(v) => {
              setDeletePassword(v);
              setDeleteError(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          />
          {deleteError !== null && (
            <Text accessibilityRole="alert" className="text-xs text-red-600 dark:text-red-400">
              {deleteError}
            </Text>
          )}
        </View>
      </ConfirmDialog>
      {signOutDialog}
    </ScreenFade>
  );
}
