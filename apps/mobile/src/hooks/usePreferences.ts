import { useCallback, useMemo } from "react";
import {
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  PREFERENCES_ID as PREF_ID,
  isAccentName,
  isDateFormat,
  isGroupBy,
  isSmartView,
  isSortBy,
  isTaskSwipeAction,
  isThemePref,
  isTimeFormat,
  type AccentName,
  type DateFormatPref,
  type GroupBy,
  type SmartView,
  type SortBy,
  type TaskSwipeAction,
  type ThemePref,
  type TimeFormatPref,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/**
 * User preferences, backed by the synced store.
 *
 * Every setting is a field on the one synced `preference` entity. Each field is read behind a type
 * guard with a default, because the value arrives over sync and can be anything; an unreadable
 * value degrades to the default. The guards live in `@atlastodo/shared` and pin field names and defaults.
 */

/** What the habits screen lists: only what is in play today, or every habit. */
export type HabitsScope = "today" | "all";

/**
 * Whether the reminders master toggle is on for a raw preference bag. Default-on, so a fresh store
 * has reminders. Gates `usePreferences`, quick-add's implicit reminder and `useReminderScheduler`.
 */
export function remindersEnabledIn(prefs: Record<string, unknown> | null | undefined): boolean {
  return prefs?.reminders_enabled !== false;
}

/** A view's group + sort choice (persisted per view key). */
export interface ListPref {
  group: GroupBy;
  sort: SortBy;
}
const DEFAULT_LIST_PREF: ListPref = { group: "none", sort: "manual" };

export interface UsePreferences {
  /** Appearance: light / dark / follow-system (default system). */
  theme: ThemePref;
  setTheme: (value: ThemePref) => void;
  /** Accent colour preset name (default indigo). */
  accent: AccentName;
  setAccent: (value: AccentName) => void;
  /** 0 = Sunday .. 6 = Saturday. Defaults to Sunday until the user changes it. */
  weekStartsOn: number;
  setWeekStartsOn: (value: number) => void;
  /** IANA timezone for day boundaries + display, or "" to follow the device. */
  timezone: string;
  setTimezone: (value: string) => void;
  /**
   * The device timezone last seen by the app, so a change can be detected and the user offered a
   * reschedule. `""` until first seeded. Synced so the prompt does not re-fire per device.
   */
  lastSeenTimezone: string;
  setLastSeenTimezone: (value: string) => void;
  /** Clock format for displayed times (auto = locale default). */
  timeFormat: TimeFormatPref;
  setTimeFormat: (value: TimeFormatPref) => void;
  /** Date style for displayed dates (auto = medium). */
  dateFormat: DateFormatPref;
  setDateFormat: (value: DateFormatPref) => void;
  /** BCP-47 language, or "" to follow the device (drives i18n translations). */
  language: string;
  setLanguage: (value: string) => void;
  /** BCP-47 region/format locale (e.g. en-GB), or "" to follow the device. Drives date/number
   * formatting independently of the UI language; wins over `language` for Intl formatting. */
  region: string;
  setRegion: (value: string) => void;
  /** Whether reminder notifications are enabled (on by default). */
  remindersEnabled: boolean;
  setRemindersEnabled: (value: boolean) => void;
  /** Whether quick-add recognizes date/time phrases (defaults on; off keeps them literal). */
  smartDatesEnabled: boolean;
  setSmartDatesEnabled: (value: boolean) => void;
  /** Whether the native app plays haptic/tactile feedback on touches (defaults on; no-op on web). */
  hapticsEnabled: boolean;
  setHapticsEnabled: (value: boolean) => void;
  /** Focus timer / time tracking visible (defaults on, hideable). */
  focusEnabled: boolean;
  setFocusEnabled: (value: boolean) => void;
  /** Whether the focus timer chimes when a phase ends (defaults on). */
  focusSoundEnabled: boolean;
  setFocusSoundEnabled: (value: boolean) => void;
  /** Habits & streaks visible (defaults on, hideable). */
  habitsEnabled: boolean;
  setHabitsEnabled: (value: boolean) => void;
  /** Countdown widgets visible (defaults on, hideable). */
  countdownsEnabled: boolean;
  setCountdownsEnabled: (value: boolean) => void;
  /** Productivity stats visible (defaults on, hideable). */
  statsEnabled: boolean;
  setStatsEnabled: (value: boolean) => void;
  /** The smart list the app opens on (defaults to Today). */
  defaultView: SmartView;
  setDefaultView: (value: SmartView) => void;
  /**
   * This view's stored group + sort choice, or `fallback` (default none/manual) when the view has
   * none yet -- so callers can supply a view-specific default (e.g. Today defaults to date grouping).
   */
  listPrefFor: (viewKey: string, fallback?: ListPref) => ListPref;
  /** Merge a group/sort change into a view's stored list preference. */
  setListPref: (viewKey: string, patch: Partial<ListPref>) => void;
  /** Whether a project shows its completed tasks in a Done group/column (default false). */
  showDoneFor: (projectId: string) => boolean;
  setShowDone: (projectId: string, value: boolean) => void;
  /** Whether a folder shows its contents in the sidebar / Projects list (default true). */
  folderExpanded: (folderId: string) => boolean;
  setFolderExpanded: (folderId: string, value: boolean) => void;
  /** Whether a habit group shows its members (default true). */
  habitGroupExpanded: (groupId: string) => boolean;
  setHabitGroupExpanded: (groupId: string, value: boolean) => void;
  /** Whether the habits screen shows only what is in play today (default) or everything. */
  habitsScope: HabitsScope;
  setHabitsScope: (value: HabitsScope) => void;
  /** Whether a project has a sidebar row (default true) -- a per-user choice, see below. */
  projectPinned: (projectId: string) => boolean;
  setProjectPinned: (projectId: string, value: boolean) => void;
  /** Whether a project, filter or view is marked as a favorite. */
  isFavorite: (targetKey: string) => boolean;
  setFavorite: (targetKey: string, value: boolean) => void;
  toggleFavorite: (targetKey: string) => void;
  favorites: Record<string, boolean>;
  /** Whether the user has completed or dismissed the initial onboarding walkthrough. */
  onboardingCompleted: boolean;
  setOnboardingCompleted: (value: boolean) => void;
  /** Whether ISO week numbers are displayed in calendar views (default true). */
  showWeekNumbers: boolean;
  setShowWeekNumbers: (value: boolean) => void;
  /** Toast auto-dismiss duration in seconds (default 6). */
  toastDuration: number;
  setToastDuration: (value: number) => void;
  /** Horizontal swipe right action on a task row (default indent). */
  swipeRightAction: TaskSwipeAction;
  setSwipeRightAction: (value: TaskSwipeAction) => void;
  /** Horizontal swipe left action on a task row (default schedule). */
  swipeLeftAction: TaskSwipeAction;
  setSwipeLeftAction: (value: TaskSwipeAction) => void;
  /** Whether a smart view appears in the drawer / menu (default true). */
  smartViewInMenu: (view: SmartView) => boolean;
  setSmartViewInMenu: (view: SmartView, value: boolean) => void;
}

export function usePreferences(): UsePreferences {
  const { store, version, kick } = useStore();

  const prefs = useMemo(
    () => store.get("preference", PREF_ID) ?? {},
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const setField = useCallback(
    (field: string, value: unknown) => {
      store.set("preference", PREF_ID, field, value);
      kick();
    },
    [store, kick],
  );

  const theme: ThemePref = isThemePref(prefs.theme) ? prefs.theme : DEFAULT_THEME;
  const accent: AccentName = isAccentName(prefs.accent) ? prefs.accent : DEFAULT_ACCENT;
  const weekStartsOn = typeof prefs.week_starts_on === "number" ? prefs.week_starts_on : 0;
  const timezone = typeof prefs.timezone === "string" ? prefs.timezone : "";
  const lastSeenTimezone =
    typeof prefs.last_seen_timezone === "string" ? prefs.last_seen_timezone : "";
  const timeFormat: TimeFormatPref = isTimeFormat(prefs.time_format) ? prefs.time_format : "auto";
  const dateFormat: DateFormatPref = isDateFormat(prefs.date_format) ? prefs.date_format : "auto";
  const language = typeof prefs.language === "string" ? prefs.language : "";
  const region = typeof prefs.region === "string" ? prefs.region : "";
  // Features (including reminders) default on, so a fresh store shows them.
  const remindersEnabled = remindersEnabledIn(prefs);
  const smartDatesEnabled = prefs.smart_dates_enabled !== false;
  const hapticsEnabled = prefs.haptics_enabled !== false;
  const focusEnabled = prefs.focus_enabled !== false;
  const focusSoundEnabled = prefs.focus_sound_enabled !== false;
  const habitsEnabled = prefs.habits_enabled !== false;
  const countdownsEnabled = prefs.countdowns_enabled !== false;
  const statsEnabled = prefs.stats_enabled !== false;
  const defaultView: SmartView = isSmartView(prefs.default_view) ? prefs.default_view : "today";
  const onboardingCompleted = prefs.onboarding_completed === true;
  const showWeekNumbers = prefs.show_week_numbers !== false;
  const toastDuration =
    typeof prefs.toast_duration === "number" && prefs.toast_duration > 0 ? prefs.toast_duration : 6;
  const swipeRightAction: TaskSwipeAction = isTaskSwipeAction(prefs.swipe_right_action)
    ? prefs.swipe_right_action
    : "indent";
  const swipeLeftAction: TaskSwipeAction = isTaskSwipeAction(prefs.swipe_left_action)
    ? prefs.swipe_left_action
    : "schedule";

  // Per-view group/sort choices; unknown entries fall back to defaults.
  const listPrefs = useMemo(() => {
    const out: Record<string, ListPref> = {};
    const raw = prefs.list_prefs;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v && typeof v === "object") {
          const g = (v as Record<string, unknown>).group;
          const s = (v as Record<string, unknown>).sort;
          out[k] = { group: isGroupBy(g) ? g : "none", sort: isSortBy(s) ? s : "manual" };
        }
      }
    }
    return out;
  }, [prefs]);

  const listPrefFor = useCallback(
    (viewKey: string, fallback: ListPref = DEFAULT_LIST_PREF): ListPref =>
      listPrefs[viewKey] ?? fallback,
    [listPrefs],
  );

  const setListPref = useCallback(
    (viewKey: string, patch: Partial<ListPref>) => {
      // Re-read through the store: `list_prefs` is one LWW field holding every view's choice, so a
      // stale copy would drop another view's setting. The same goes for the maps below.
      const raw = store.get("preference", PREF_ID)?.list_prefs;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const cur = base[viewKey];
      const current = cur && typeof cur === "object" ? (cur as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "list_prefs", {
        ...base,
        [viewKey]: { ...DEFAULT_LIST_PREF, ...current, ...patch },
      });
      kick();
    },
    [store, kick],
  );

  // Per-project "show completed" flags, one LWW field like list_prefs. Read `=== true`: the value
  // arrives over sync and can be any shape.
  const projectShowDone = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.project_show_done;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === true;
    }
    return out;
  }, [prefs]);

  const showDoneFor = useCallback(
    (projectId: string) => projectShowDone[projectId] === true,
    [projectShowDone],
  );

  const setShowDone = useCallback(
    (projectId: string, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.project_show_done;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "project_show_done", { ...base, [projectId]: value });
      kick();
    },
    [store, kick],
  );

  // Per-folder expand/collapse, one LWW field. Synced rather than local so it survives a web
  // refresh. Defaults to expanded, so a folder made on another device does not look empty.
  const folderCollapsed = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.folder_expanded;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === false;
    }
    return out;
  }, [prefs]);

  const folderExpanded = useCallback(
    (folderId: string) => folderCollapsed[folderId] !== true,
    [folderCollapsed],
  );

  const setFolderExpanded = useCallback(
    (folderId: string, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.folder_expanded;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "folder_expanded", { ...base, [folderId]: value });
      kick();
    },
    [store, kick],
  );

  // Habit groups: same shape. Synced because folding a group is a durable choice about how the
  // screen reads, unlike the momentary peek at a habit's steps (local state).
  const habitGroupCollapsed = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.habit_group_expanded;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === false;
    }
    return out;
  }, [prefs]);

  const habitGroupExpanded = useCallback(
    (groupId: string) => habitGroupCollapsed[groupId] !== true,
    [habitGroupCollapsed],
  );

  // Defaults to `today`: a habit not scheduled today is noise when checking what is in play.
  const habitsScope: HabitsScope = prefs.habits_scope === "all" ? "all" : "today";
  const setHabitsScope = useCallback(
    (value: HabitsScope) => setField("habits_scope", value),
    [setField],
  );

  const setHabitGroupExpanded = useCallback(
    (groupId: string, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.habit_group_expanded;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "habit_group_expanded", { ...base, [groupId]: value });
      kick();
    },
    [store, kick],
  );

  // Which projects get a sidebar row. A preference, not a project field: a `project` op fans out to
  // every member, so one member's unpin would hide it for everyone. The `preference` entity is
  // user-private. Defaults to true, so a project shared with you shows up.
  const projectUnpinned = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.project_pinned;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === false;
    }
    return out;
  }, [prefs]);

  const projectPinned = useCallback(
    (projectId: string) => projectUnpinned[projectId] !== true,
    [projectUnpinned],
  );

  const setProjectPinned = useCallback(
    (projectId: string, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.project_pinned;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "project_pinned", { ...base, [projectId]: value });
      kick();
    },
    [store, kick],
  );

  // Favorites: target key (e.g. `project:p1`, `filter:f1`, `view:today`) -> boolean.
  const favorites = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.favorites;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === true) out[k] = true;
      }
    }
    return out;
  }, [prefs]);

  const isFavorite = useCallback((targetKey: string) => favorites[targetKey] === true, [favorites]);

  const setFavorite = useCallback(
    (targetKey: string, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.favorites;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "favorites", { ...base, [targetKey]: value });
      kick();
    },
    [store, kick],
  );

  const toggleFavorite = useCallback(
    (targetKey: string) => {
      const current = store.get("preference", PREF_ID)?.favorites;
      const base =
        current && typeof current === "object" ? (current as Record<string, unknown>) : {};
      const isFav = base[targetKey] === true;
      store.set("preference", PREF_ID, "favorites", { ...base, [targetKey]: !isFav });
      kick();
    },
    [store, kick],
  );

  const hiddenSmartViews = useMemo(() => {
    const out: Record<string, boolean> = {};
    const raw = prefs.menu_smart_views;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (v === false) out[k] = true;
      }
    }
    return out;
  }, [prefs]);

  const smartViewInMenu = useCallback(
    (view: SmartView) => hiddenSmartViews[view] !== true,
    [hiddenSmartViews],
  );

  const setSmartViewInMenu = useCallback(
    (view: SmartView, value: boolean) => {
      const raw = store.get("preference", PREF_ID)?.menu_smart_views;
      const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      store.set("preference", PREF_ID, "menu_smart_views", { ...base, [view]: value });
      kick();
    },
    [store, kick],
  );

  const setTheme = useCallback((v: ThemePref) => setField("theme", v), [setField]);
  const setAccent = useCallback((v: AccentName) => setField("accent", v), [setField]);
  const setWeekStartsOn = useCallback((v: number) => setField("week_starts_on", v), [setField]);
  const setTimezone = useCallback((v: string) => setField("timezone", v), [setField]);
  const setLastSeenTimezone = useCallback(
    (v: string) => setField("last_seen_timezone", v),
    [setField],
  );
  const setTimeFormat = useCallback((v: TimeFormatPref) => setField("time_format", v), [setField]);
  const setDateFormat = useCallback((v: DateFormatPref) => setField("date_format", v), [setField]);
  const setLanguage = useCallback((v: string) => setField("language", v), [setField]);
  const setRegion = useCallback((v: string) => setField("region", v), [setField]);
  const setRemindersEnabled = useCallback(
    (v: boolean) => setField("reminders_enabled", v),
    [setField],
  );
  const setSmartDatesEnabled = useCallback(
    (v: boolean) => setField("smart_dates_enabled", v),
    [setField],
  );
  const setHapticsEnabled = useCallback((v: boolean) => setField("haptics_enabled", v), [setField]);
  const setFocusEnabled = useCallback((v: boolean) => setField("focus_enabled", v), [setField]);
  const setFocusSoundEnabled = useCallback(
    (v: boolean) => setField("focus_sound_enabled", v),
    [setField],
  );
  const setHabitsEnabled = useCallback((v: boolean) => setField("habits_enabled", v), [setField]);
  const setCountdownsEnabled = useCallback(
    (v: boolean) => setField("countdowns_enabled", v),
    [setField],
  );
  const setStatsEnabled = useCallback((v: boolean) => setField("stats_enabled", v), [setField]);
  const setDefaultView = useCallback((v: SmartView) => setField("default_view", v), [setField]);
  const setOnboardingCompleted = useCallback(
    (v: boolean) => setField("onboarding_completed", v),
    [setField],
  );
  const setShowWeekNumbers = useCallback(
    (v: boolean) => setField("show_week_numbers", v),
    [setField],
  );
  const setToastDuration = useCallback((v: number) => setField("toast_duration", v), [setField]);
  const setSwipeRightAction = useCallback(
    (v: TaskSwipeAction) => setField("swipe_right_action", v),
    [setField],
  );
  const setSwipeLeftAction = useCallback(
    (v: TaskSwipeAction) => setField("swipe_left_action", v),
    [setField],
  );

  return {
    theme,
    setTheme,
    accent,
    setAccent,
    weekStartsOn,
    setWeekStartsOn,
    timezone,
    setTimezone,
    lastSeenTimezone,
    setLastSeenTimezone,
    timeFormat,
    setTimeFormat,
    dateFormat,
    setDateFormat,
    language,
    setLanguage,
    region,
    setRegion,
    remindersEnabled,
    setRemindersEnabled,
    smartDatesEnabled,
    setSmartDatesEnabled,
    hapticsEnabled,
    setHapticsEnabled,
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
    defaultView,
    setDefaultView,
    listPrefFor,
    setListPref,
    showDoneFor,
    setShowDone,
    folderExpanded,
    setFolderExpanded,
    habitGroupExpanded,
    setHabitGroupExpanded,
    habitsScope,
    setHabitsScope,
    projectPinned,
    setProjectPinned,
    isFavorite,
    setFavorite,
    toggleFavorite,
    favorites,
    onboardingCompleted,
    setOnboardingCompleted,
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
  };
}
