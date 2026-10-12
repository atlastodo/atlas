import { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { vars } from "nativewind";
import {
  ACCENTS,
  ACCENT_LABEL_KEYS,
  ACCENT_NAMES,
  REGION_OPTIONS,
  accentVars,
  createTask,
  LANGUAGES,
  resolveTimeZone,
  timeZoneOptions,
  type AccentName,
  type DateFormatPref,
  type SmartView,
  type ThemePref,
  type TimeFormatPref,
} from "@atlas/shared";
import { useStore } from "../data/StoreProvider";
import { usePreferences } from "../hooks/usePreferences";
import { useOnboarding } from "../data/OnboardingContext";
import { useLocalMode } from "../auth/localMode";
import { AuthForm, useAuthForm, type AuthFormState } from "../auth/AuthForm";
import { deviceLanguage } from "../i18n";
import { ThemeScope } from "../theme/ThemeProvider";
import { explainNotifications } from "../lib/permissionExplainer";
import { haptics } from "../lib/haptics";
import { ListPicker, type PickerOption } from "./ListPicker";
import { NotifyPermissionHint } from "./NotifyPermissionHint";
import { Segmented } from "./Segmented";
import {
  Bell,
  Calendar,
  CalendarClock,
  ChartColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock,
  Database,
  Flame,
  Globe,
  Inbox,
  ListTodo,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  UserPlus,
  UserRound,
  type LucideIcon,
} from "./icons";

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

/**
 * The wizard's steps. Local-only mode adds the account step after Welcome: create an account to
 * sync and share, sign in to an existing one, or carry on with this device only. It comes before
 * any setting is chosen, so signing in to an existing account never overwrites its settings.
 *
 * Creating an account or signing in moves on to the form step ("auth", the shared `AuthForm`);
 * "this device only" skips it. A new account carries on at Appearance once its app mounts (the
 * session swaps the app tree, so `setUpgradeIntent` asks the next wizard to resume); signing in to
 * an existing account ends the wizard, after `LocalUpgradeGate` asks about any local data.
 */
type StepKey = "welcome" | "account" | "auth" | "appearance" | "defaults" | "features" | "ready";
const ACCOUNT_STEPS: StepKey[] = ["welcome", "appearance", "defaults", "features", "ready"];
const LOCAL_STEPS: StepKey[] = [
  "welcome",
  "account",
  "auth",
  "appearance",
  "defaults",
  "features",
  "ready",
];

/** One choice on the account step: an icon, a title, a line of explanation, and a press. */
function AccountChoice({
  icon: Icon,
  title,
  description,
  onPress,
  primary,
  accentHex,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onPress: () => void;
  primary?: boolean;
  accentHex: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={primary ? { borderColor: accentHex } : undefined}
      className={
        "flex-row items-start gap-3.5 rounded-xl border p-4 active:opacity-80 web:cursor-pointer " +
        (primary
          ? "bg-accent-50/60 dark:bg-accent-950/40"
          : "border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/60")
      }
    >
      <View className="mt-0.5 rounded-lg p-2" style={{ backgroundColor: accentHex + "20" }}>
        <Icon size={18} color={accentHex} />
      </View>
      <View className="flex-1">
        <Text className="font-semibold text-neutral-900 dark:text-neutral-100">{title}</Text>
        <Text className="mt-0.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          {description}
        </Text>
      </View>
      <ChevronRight size={16} className="mt-1 text-neutral-400" />
    </Pressable>
  );
}

const VIEW_CHOICES: { view: SmartView; icon: LucideIcon }[] = [
  { view: "today", icon: Sun },
  { view: "inbox", icon: Inbox },
  { view: "upcoming", icon: CalendarClock },
  { view: "all", icon: ListTodo },
];

function OnboardingToggleItem({
  icon: Icon,
  label,
  description,
  value,
  onValueChange,
  accentHex,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  accentHex: string;
}) {
  const isWeb = Platform.OS === "web";
  return (
    <View className="flex-row items-center justify-between gap-4 p-4 sm:p-5">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 dark:bg-neutral-800">
        <Icon
          size={20}
          color={value ? accentHex : undefined}
          className={value ? "" : "text-neutral-500 dark:text-neutral-400"}
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {label}
        </Text>
        <Text className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          {description}
        </Text>
      </View>
      {isWeb ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: value }}
          accessibilityLabel={label}
          onPress={() => onValueChange(!value)}
          style={value ? { backgroundColor: accentHex } : undefined}
          className={
            "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 web:cursor-pointer " +
            (value ? "bg-accent-600" : "bg-neutral-300 dark:bg-neutral-700")
          }
        >
          <View
            style={{ left: value ? 22 : 2 }}
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200"
          />
        </Pressable>
      ) : (
        <Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} />
      )}
    </View>
  );
}

export function OnboardingModal({ onFinish }: { onFinish?: () => void }) {
  const { localOnly } = useStore();
  const local = useLocalMode();
  return localOnly && local ? (
    <LocalOnboarding onFinish={onFinish} />
  ) : (
    <Wizard onFinish={onFinish} authForm={null} />
  );
}

/** Local-only mode's wizard, which holds the account form's state across its steps. */
function LocalOnboarding({ onFinish }: { onFinish?: () => void }) {
  // Kept above the steps, not in the form step, so stepping Back and forth keeps what was typed.
  const authForm = useAuthForm({ resumeOnboardingOnSignup: true });
  return <Wizard onFinish={onFinish} authForm={authForm} />;
}

function Wizard({
  onFinish,
  authForm,
}: {
  onFinish?: () => void;
  /** The account form's state in local-only mode, which has the account steps; else null. */
  authForm: AuthFormState | null;
}) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { store, kick } = useStore();
  const { isOpen, startAt, closeOnboarding } = useOnboarding();
  const steps = authForm ? LOCAL_STEPS : ACCOUNT_STEPS;
  const {
    theme,
    setTheme,
    accent,
    setAccent,
    language,
    setLanguage,
    timezone,
    setTimezone,
    region,
    setRegion,
    defaultView,
    setDefaultView,
    weekStartsOn,
    setWeekStartsOn,
    timeFormat,
    setTimeFormat,
    dateFormat,
    setDateFormat,
    focusEnabled,
    setFocusEnabled,
    habitsEnabled,
    setHabitsEnabled,
    countdownsEnabled,
    setCountdownsEnabled,
    statsEnabled,
    setStatsEnabled,
    smartDatesEnabled,
    setSmartDatesEnabled,
    remindersEnabled,
    setRemindersEnabled,
    setOnboardingCompleted,
  } = usePreferences();

  const [step, setStep] = useState<number>(1);
  const [firstTaskTitle, setFirstTaskTitle] = useState("");

  // Reset to the first step (or the one asked for) when the wizard is opened or replayed.
  useEffect(() => {
    if (isOpen) {
      setStep(startAt ? Math.max(1, steps.indexOf(startAt) + 1) : 1);
      setFirstTaskTitle("");
    }
    // `steps` follows the mode, which a running wizard never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, startAt]);

  const TOTAL_STEPS = steps.length;
  const current = steps[step - 1] ?? "welcome";
  const currentAccentHex = ACCENTS[accent]?.[600] ?? "#4f46e5";

  // Resolve browser/device defaults for timezone and region display
  const deviceZone = resolveTimeZone("");
  const deviceLangCode = deviceLanguage();
  const deviceRegionLabel =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().locale || deviceLangCode
      : deviceLangCode;

  const timezoneChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceZone },
    ...timeZoneOptions().map((z) => ({ value: z, label: z })),
  ];
  const regionChoices: PickerOption<string>[] = [
    { value: "", label: t("settings.deviceDefault"), hint: deviceRegionLabel },
    ...REGION_OPTIONS.map((r) => ({ value: r.tag, label: r.label })),
  ];

  const sampleTime = new Date(2026, 8, 3, 14, 30);
  const deviceZoneTimeSample =
    typeof Intl !== "undefined"
      ? new Intl.DateTimeFormat(region || undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZone: timezone || undefined,
        }).format(sampleTime)
      : "14:30";

  const sampleDateMap = {
    auto:
      typeof Intl !== "undefined"
        ? new Intl.DateTimeFormat(region || undefined, {
            dateStyle: "medium",
            timeZone: timezone || undefined,
          }).format(sampleTime)
        : "3 Sep 2026",
    short:
      typeof Intl !== "undefined"
        ? new Intl.DateTimeFormat(region || undefined, {
            dateStyle: "short",
            timeZone: timezone || undefined,
          }).format(sampleTime)
        : "03/09/2026",
    medium:
      typeof Intl !== "undefined"
        ? new Intl.DateTimeFormat(region || undefined, {
            dateStyle: "medium",
            timeZone: timezone || undefined,
          }).format(sampleTime)
        : "3 Sep 2026",
    long:
      typeof Intl !== "undefined"
        ? new Intl.DateTimeFormat(region || undefined, {
            dateStyle: "long",
            timeZone: timezone || undefined,
          }).format(sampleTime)
        : "3 September 2026",
  };

  const handleFinish = (skipped = false) => {
    setOnboardingCompleted(true);
    if (!skipped && firstTaskTitle.trim()) {
      createTask(store, { title: firstTaskTitle.trim() });
      kick();
    }
    haptics.success();
    closeOnboarding();
    if (onFinish) onFinish();
  };

  const handleNext = () => {
    haptics.selection();
    // Reminders are on by default, so the toggle's own prompt never runs for most people. On a phone
    // the permissions drawer (`PermissionsSheetHost`) asks for everything once the wizard closes; a
    // browser has only the notification prompt, so leaving the step that presents reminders asks
    // for it through the explainer. A no-op once answered.
    if (current === "features" && remindersEnabled && Platform.OS === "web") {
      void explainNotifications({ implicit: true });
    }
    if (step < TOTAL_STEPS) {
      setStep(step + 1);
    } else {
      handleFinish(false);
    }
  };

  const goTo = (key: StepKey) => {
    haptics.selection();
    setStep(steps.indexOf(key) + 1);
  };

  const handleBack = () => {
    haptics.selection();
    // The form step is only reached by choosing an account: Back from it, and from the step after
    // it, returns to the choices.
    if (current === "auth" || (current === "appearance" && steps.includes("auth"))) {
      setStep(steps.indexOf("account") + 1);
    } else if (step > 1) {
      setStep(step - 1);
    }
  };

  const tr = <T extends string | number>(opts: { value: T; labelKey: string }[]) =>
    opts.map((o) => ({ value: o.value, label: t(o.labelKey) }));

  // No explicit choice yet: the language the device resolved to.
  const selectedLanguage =
    language || LANGUAGES.find((l) => i18n.language?.startsWith(l.code))?.code || "en";

  if (!isOpen) return null;

  return (
    <Modal visible={isOpen} animationType="fade" transparent={false}>
      <ThemeScope
        style={[vars(accentVars(accent)), { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        className="flex-1 bg-white dark:bg-zinc-950"
      >
        {/* Top App Header with Centered Progress Bar and Skip */}
        <View className="relative flex-row items-center justify-between border-b border-neutral-100 px-5 py-3 dark:border-neutral-800">
          <View className="flex-row items-center gap-2">
            {/* The app icon's globe, as in the sidebar and on sign-in. */}
            <Globe size={22} color={currentAccentHex} />
            <Text className="font-semibold text-neutral-900 dark:text-neutral-100">
              {t("app.title")}
            </Text>
          </View>

          {/* Step Progress Dots: Positioned in dead horizontal center */}
          <View
            className="absolute left-0 right-0 items-center justify-center"
            style={{ pointerEvents: "none" }}
          >
            <View className="flex-row items-center gap-1.5">
              {Array.from({ length: TOTAL_STEPS }).map((_, idx) => {
                const isCurrent = idx + 1 === step;
                const isPast = idx + 1 < step;
                return (
                  <View
                    key={idx}
                    style={isCurrent || isPast ? { backgroundColor: currentAccentHex } : undefined}
                    className={
                      "h-2 rounded-full transition-all " +
                      (isCurrent
                        ? "w-6"
                        : isPast
                          ? "w-2 opacity-80"
                          : "w-2 bg-neutral-200 dark:bg-neutral-800")
                    }
                  />
                );
              })}
            </View>
          </View>

          {step < TOTAL_STEPS ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.skip")}
              onPress={() => handleFinish(true)}
              hitSlop={8}
              className="rounded-md px-2 py-1 active:opacity-70"
            >
              <Text className="text-sm font-medium text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                {t("onboarding.skip")}
              </Text>
            </Pressable>
          ) : (
            <View className="w-16" />
          )}
        </View>

        {/* Step Body */}
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-6 py-6 web:mx-auto web:w-full web:max-w-xl"
          keyboardShouldPersistTaps="handled"
        >
          {/* Welcome & Value Prop */}
          {current === "welcome" && (
            <View className="gap-6">
              <View className="items-center py-4">
                <View className="mb-4 h-20 w-20 items-center justify-center rounded-3xl border border-accent-300 bg-accent-50 shadow-sm dark:border-accent-700 dark:bg-accent-950">
                  <Sparkles size={40} color={currentAccentHex} />
                </View>
                <Text className="text-center text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
                  {t("onboarding.welcomeTitle")}
                </Text>
                <Text className="mt-2 text-center text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                  {t("onboarding.welcomeSubtitle")}
                </Text>
              </View>

              <View className="gap-3">
                <View className="flex-row items-start gap-3.5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                  <View
                    className="mt-0.5 rounded-lg p-2"
                    style={{ backgroundColor: currentAccentHex + "20" }}
                  >
                    <Database size={18} color={currentAccentHex} />
                  </View>
                  <View className="flex-1">
                    <Text className="font-semibold text-neutral-900 dark:text-neutral-100">
                      {t("onboarding.valSpeedTitle")}
                    </Text>
                    <Text className="mt-0.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {t("onboarding.valSpeedDesc")}
                    </Text>
                  </View>
                </View>

                <View className="flex-row items-start gap-3.5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                  <View className="mt-0.5 rounded-lg bg-emerald-100 p-2 dark:bg-emerald-950/40">
                    <ShieldCheck size={18} className="text-emerald-600 dark:text-emerald-400" />
                  </View>
                  <View className="flex-1">
                    <Text className="font-semibold text-neutral-900 dark:text-neutral-100">
                      {t("onboarding.valPrivacyTitle")}
                    </Text>
                    <Text className="mt-0.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {t("onboarding.valPrivacyDesc")}
                    </Text>
                  </View>
                </View>

                <View className="flex-row items-start gap-3.5 rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                  <View className="mt-0.5 rounded-lg bg-blue-100 p-2 dark:bg-blue-950/40">
                    <CalendarClock size={18} className="text-blue-600 dark:text-blue-400" />
                  </View>
                  <View className="flex-1">
                    <Text className="font-semibold text-neutral-900 dark:text-neutral-100">
                      {t("onboarding.valSyncTitle")}
                    </Text>
                    <Text className="mt-0.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
                      {t("onboarding.valSyncDesc")}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* Account: sync and collaborate, or this device only (local-only mode) */}
          {current === "account" && authForm && (
            <View className="gap-6">
              <View>
                <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">
                  {t("localMode.stepTitle")}
                </Text>
                <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                  {t("localMode.stepDesc")}
                </Text>
              </View>
              <View className="gap-3">
                <AccountChoice
                  icon={UserPlus}
                  title={t("localMode.createAccount")}
                  description={t("localMode.createAccountDesc")}
                  onPress={() => {
                    authForm.setMode("signup");
                    goTo("auth");
                  }}
                  primary
                  accentHex={currentAccentHex}
                />
                <AccountChoice
                  icon={UserRound}
                  title={t("localMode.signIn")}
                  description={t("localMode.signInDesc")}
                  onPress={() => {
                    authForm.setMode("login");
                    goTo("auth");
                  }}
                  accentHex={currentAccentHex}
                />
                <AccountChoice
                  icon={Smartphone}
                  title={t("localMode.continueLocal")}
                  description={t("localMode.continueLocalDesc")}
                  onPress={() => goTo("appearance")}
                  accentHex={currentAccentHex}
                />
              </View>
            </View>
          )}

          {/* Account form: create an account, sign in, or recover one (local-only mode) */}
          {current === "auth" && authForm && (
            <View className="gap-6">
              <View>
                <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">
                  {authForm.mode === "signup"
                    ? t("localMode.createAccount")
                    : authForm.mode === "login"
                      ? t("localMode.signIn")
                      : t("auth.resetAndRecover")}
                </Text>
                {authForm.mode !== "recover" && (
                  <Text className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                    {authForm.mode === "signup"
                      ? t("localMode.createAccountDesc")
                      : t("localMode.signInDesc")}
                  </Text>
                )}
              </View>
              <View>
                <AuthForm form={authForm} />
              </View>
            </View>
          )}

          {/* Appearance & Theme */}
          {current === "appearance" && (
            <View className="gap-6">
              <View>
                <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">
                  {t("onboarding.appearanceTitle")}
                </Text>
                <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.appearanceDesc")}
                </Text>
              </View>

              {/* Theme Selector */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.themeLabel")}
                </Text>
                <Segmented
                  value={theme}
                  options={tr(THEME_OPTIONS)}
                  onChange={setTheme}
                  label={t("onboarding.themeLabel")}
                  accentColor={currentAccentHex}
                />
              </View>

              {/* Accent Color Palette */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.accentLabel")}
                </Text>
                <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-3 py-1">
                  {ACCENT_NAMES.map((name) => {
                    const isSelected = accent === name;
                    return (
                      <Pressable
                        key={name}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={t(ACCENT_LABEL_KEYS[name])}
                        onPress={() => {
                          haptics.selection();
                          setAccent(name as AccentName);
                        }}
                        style={{ backgroundColor: ACCENTS[name][600] }}
                        className={
                          "h-10 w-10 items-center justify-center rounded-full shadow-sm " +
                          (isSelected
                            ? "border-2 border-neutral-900 dark:border-white scale-110"
                            : "border border-black/10 opacity-90")
                        }
                      >
                        {isSelected && <Check size={18} className="text-white" />}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Language Selection */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.languageLabel")}
                </Text>
                <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2.5">
                  {LANGUAGES.map(({ code, label }) => {
                    const isSelected = code === selectedLanguage;
                    return (
                      <Pressable
                        key={code}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={label}
                        onPress={() => {
                          haptics.selection();
                          setLanguage(code);
                        }}
                        style={isSelected ? { borderColor: currentAccentHex } : undefined}
                        className={
                          "flex-1 min-w-[140px] flex-row items-center justify-between rounded-xl border p-3.5 transition-all " +
                          (isSelected
                            ? "border-2 bg-accent-50 dark:bg-accent-950"
                            : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/60")
                        }
                      >
                        <Text
                          className={
                            "text-sm font-semibold " +
                            (isSelected
                              ? "text-neutral-900 dark:text-neutral-50"
                              : "text-neutral-700 dark:text-neutral-300")
                          }
                        >
                          {label}
                        </Text>
                        {isSelected ? (
                          <View
                            className="h-5 w-5 items-center justify-center rounded-full"
                            style={{ backgroundColor: currentAccentHex }}
                          >
                            <Check size={12} className="text-white" />
                          </View>
                        ) : (
                          <View className="h-5 w-5 rounded-full border border-neutral-300 dark:border-neutral-750" />
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Live Preview Card */}
              <View className="rounded-xl border border-neutral-200 bg-neutral-50/50 p-4 dark:border-neutral-800 dark:bg-neutral-900/50">
                <Text className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-400">
                  {t("onboarding.previewCard")}
                </Text>
                <View className="flex-row items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3.5 shadow-sm dark:border-neutral-800 dark:bg-zinc-900">
                  <View
                    className="h-5 w-5 items-center justify-center rounded-full border-2"
                    style={{ borderColor: currentAccentHex }}
                  >
                    <View
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: currentAccentHex }}
                    />
                  </View>
                  <View className="flex-1">
                    <Text className="font-medium text-neutral-900 dark:text-neutral-100">
                      {t("onboarding.previewTaskTitle")}
                    </Text>
                    <View className="mt-1 flex-row items-center gap-2">
                      <View
                        className="rounded px-1.5 py-0.5"
                        style={{ backgroundColor: currentAccentHex + "22" }}
                      >
                        <Text className="text-xs font-semibold" style={{ color: currentAccentHex }}>
                          {t("onboarding.previewTaskProject")}
                        </Text>
                      </View>
                      <Text className="text-xs text-neutral-400">{t("nav.today")}</Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* Calendar & Routine Defaults */}
          {current === "defaults" && (
            <View className="gap-6">
              <View>
                <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">
                  {t("onboarding.defaultsTitle")}
                </Text>
                <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.defaultsDesc")}
                </Text>
              </View>

              {/* Default View 2x2 Grid with Icons */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.defaultViewLabel")}
                </Text>
                <View className="flex-row flex-wrap gap-2.5">
                  {VIEW_CHOICES.map(({ view: v, icon: ViewIcon }) => {
                    const isSelected = defaultView === v;
                    return (
                      <Pressable
                        key={v}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={t(`nav.${v}`)}
                        onPress={() => {
                          haptics.selection();
                          setDefaultView(v);
                        }}
                        style={isSelected ? { borderColor: currentAccentHex } : undefined}
                        className={
                          "flex-1 min-w-[140px] flex-row items-center justify-between rounded-xl border p-3.5 transition-all " +
                          (isSelected
                            ? "border-2 bg-accent-50 dark:bg-accent-950"
                            : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/60")
                        }
                      >
                        <View className="flex-row items-center gap-3">
                          <View className="rounded-lg p-2 bg-neutral-100 dark:bg-neutral-800">
                            <ViewIcon
                              size={18}
                              color={isSelected ? currentAccentHex : undefined}
                              className={isSelected ? "" : "text-neutral-500 dark:text-neutral-400"}
                            />
                          </View>
                          <Text
                            className={
                              "text-sm font-semibold capitalize " +
                              (isSelected
                                ? "text-neutral-900 dark:text-neutral-50"
                                : "text-neutral-700 dark:text-neutral-300")
                            }
                          >
                            {t(`nav.${v}`)}
                          </Text>
                        </View>
                        {isSelected ? (
                          <View
                            className="h-5 w-5 items-center justify-center rounded-full"
                            style={{ backgroundColor: currentAccentHex }}
                          >
                            <Check size={12} className="text-white" />
                          </View>
                        ) : (
                          <View className="h-5 w-5 rounded-full border border-neutral-300 dark:border-neutral-750" />
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {/* Timezone & Region Settings */}
              <View className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                <View className="p-4 sm:p-5">
                  <ListPicker
                    label={t("settings.timezone")}
                    description={t("settings.timezoneDesc")}
                    value={timezone}
                    options={timezoneChoices}
                    onChange={setTimezone}
                    className="border-none py-0"
                  />
                </View>
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <View className="p-4 sm:p-5">
                  <ListPicker
                    label={t("settings.region")}
                    description={t("settings.regionDesc")}
                    value={region}
                    options={regionChoices}
                    onChange={setRegion}
                    className="border-none py-0"
                  />
                </View>
              </View>

              {/* Week Starts On */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.weekStartLabel")}
                </Text>
                <Segmented
                  value={weekStartsOn}
                  options={[
                    { value: 1, label: t("settings.mon") },
                    { value: 0, label: t("settings.sun") },
                  ]}
                  onChange={setWeekStartsOn}
                  label={t("onboarding.weekStartLabel")}
                  accentColor={currentAccentHex}
                />
              </View>

              {/* Time Format */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.timeFormatLabel")}
                </Text>
                <Segmented
                  value={timeFormat}
                  options={tr(TIME_OPTIONS)}
                  onChange={setTimeFormat}
                  label={t("onboarding.timeFormatLabel")}
                  accentColor={currentAccentHex}
                />
                <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                  {timeFormat === "auto"
                    ? t("settings.timeFormatAutoDesc", { sample: deviceZoneTimeSample })
                    : timeFormat === "12h"
                      ? t("settings.timeFormat12hDesc")
                      : t("settings.timeFormat24hDesc")}
                </Text>
              </View>

              {/* Date Format */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.dateFormatLabel", t("settings.dateFormat"))}
                </Text>
                <Segmented
                  value={dateFormat}
                  options={tr(DATE_OPTIONS)}
                  onChange={setDateFormat}
                  label={t("settings.dateFormat")}
                  accentColor={currentAccentHex}
                />
                <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                  {dateFormat === "auto"
                    ? t("settings.dateFormatAutoDesc", { sample: sampleDateMap.auto })
                    : dateFormat === "short"
                      ? t("settings.dateFormatShortDesc", { sample: sampleDateMap.short })
                      : dateFormat === "medium"
                        ? t("settings.dateFormatMediumDesc", { sample: sampleDateMap.medium })
                        : t("settings.dateFormatLongDesc", { sample: sampleDateMap.long })}
                </Text>
              </View>
            </View>
          )}

          {/* Feature Modules */}
          {current === "features" && (
            <View className="gap-6">
              <View>
                <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-50">
                  {t("onboarding.featuresTitle")}
                </Text>
                <Text className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.featuresDesc")}
                </Text>
              </View>

              <View className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
                <OnboardingToggleItem
                  icon={Clock}
                  label={t("onboarding.featureFocus")}
                  description={t("onboarding.featureFocusDesc")}
                  value={focusEnabled}
                  onValueChange={setFocusEnabled}
                  accentHex={currentAccentHex}
                />
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <OnboardingToggleItem
                  icon={Flame}
                  label={t("onboarding.featureHabits")}
                  description={t("onboarding.featureHabitsDesc")}
                  value={habitsEnabled}
                  onValueChange={setHabitsEnabled}
                  accentHex={currentAccentHex}
                />
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <OnboardingToggleItem
                  icon={CalendarClock}
                  label={t("onboarding.featureCountdowns")}
                  description={t("onboarding.featureCountdownsDesc")}
                  value={countdownsEnabled}
                  onValueChange={setCountdownsEnabled}
                  accentHex={currentAccentHex}
                />
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <OnboardingToggleItem
                  icon={ChartColumn}
                  label={t("onboarding.featureStats")}
                  description={t("onboarding.featureStatsDesc")}
                  value={statsEnabled}
                  onValueChange={setStatsEnabled}
                  accentHex={currentAccentHex}
                />
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <OnboardingToggleItem
                  icon={Calendar}
                  label={t("onboarding.featureSmartDates")}
                  description={t("onboarding.featureSmartDatesDesc")}
                  value={smartDatesEnabled}
                  onValueChange={setSmartDatesEnabled}
                  accentHex={currentAccentHex}
                />
                <View className="mx-5 border-t border-neutral-100 dark:border-neutral-800/80" />
                <OnboardingToggleItem
                  icon={Bell}
                  label={t("onboarding.featureReminders")}
                  description={t("onboarding.featureRemindersDesc")}
                  value={remindersEnabled}
                  onValueChange={(on) => {
                    if (on) void explainNotifications();
                    setRemindersEnabled(on);
                  }}
                  accentHex={currentAccentHex}
                />
                {remindersEnabled && (
                  <View className="px-4 pb-4 sm:px-5">
                    <NotifyPermissionHint />
                  </View>
                )}
              </View>
            </View>
          )}

          {/* Ready to Go & Optional First Task */}
          {current === "ready" && (
            <View className="gap-6">
              <View className="items-center py-4">
                <View className="mb-4 h-20 w-20 items-center justify-center rounded-3xl bg-emerald-500/10">
                  <CircleCheckBig size={44} className="text-emerald-600 dark:text-emerald-400" />
                </View>
                <Text className="text-center text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
                  {t("onboarding.readyTitle")}
                </Text>
                <Text className="mt-2 text-center text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                  {t("onboarding.readyDesc")}
                </Text>
              </View>

              {/* Summary of choices */}
              <View className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4 dark:border-neutral-800 dark:bg-neutral-900/60">
                <Text className="text-center text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  {t("onboarding.readySummary", {
                    theme: t(
                      THEME_OPTIONS.find((o) => o.value === theme)?.labelKey ??
                        "settings.themeSystem",
                    ),
                    accent: t(ACCENT_LABEL_KEYS[accent]),
                    view: t(`nav.${defaultView}`),
                  })}
                </Text>
              </View>

              {/* Optional First Task */}
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {t("onboarding.firstTaskLabel")}
                </Text>
                <TextInput
                  accessibilityLabel={t("onboarding.firstTaskLabel")}
                  placeholder={t("onboarding.firstTaskPlaceholder")}
                  value={firstTaskTitle}
                  onChangeText={setFirstTaskTitle}
                  returnKeyType="done"
                  onSubmitEditing={() => handleFinish(false)}
                  className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                  placeholderTextColor="#a1a1aa"
                />
              </View>
            </View>
          )}
        </ScrollView>

        {/* Bottom Actions Bar */}
        <View className="flex-row items-center justify-between border-t border-neutral-100 bg-white px-6 py-4 dark:border-neutral-800 dark:bg-zinc-950 web:mx-auto web:w-full web:max-w-xl">
          {step > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.back")}
              onPress={handleBack}
              className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-4 py-2.5 active:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-900 dark:active:bg-neutral-800"
            >
              <ChevronLeft size={16} className="text-neutral-600 dark:text-neutral-300" />
              <Text className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                {t("onboarding.back")}
              </Text>
            </Pressable>
          ) : (
            <View className="w-16" />
          )}

          {current === "account" || current === "auth" ? (
            // The step's own choices (or the form's submit) move on.
            <View className="w-16" />
          ) : step < TOTAL_STEPS ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.next")}
              onPress={handleNext}
              style={{ backgroundColor: currentAccentHex }}
              className="flex-row items-center gap-1.5 rounded-lg px-5 py-2.5 shadow-sm active:opacity-90"
            >
              <Text className="text-sm font-semibold text-white">{t("onboarding.next")}</Text>
              <ChevronRight size={16} className="text-white" />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("onboarding.finish")}
              onPress={() => handleFinish(false)}
              style={{ backgroundColor: currentAccentHex }}
              className="flex-row items-center gap-1.5 rounded-lg px-6 py-2.5 shadow-md active:opacity-90"
            >
              <Text className="text-sm font-semibold text-white">{t("onboarding.finish")}</Text>
              <Sparkles size={16} className="text-white" />
            </Pressable>
          )}
        </View>
      </ThemeScope>
    </Modal>
  );
}
