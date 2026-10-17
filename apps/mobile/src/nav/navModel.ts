import {
  Archive,
  Bell,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  CircleCheckBig,
  Clock,
  Flame,
  Hash,
  Inbox,
  Info,
  ListFilter,
  ListTodo,
  Sun,
  Timer,
  Trash2,
  UserRound,
} from "../ui/icons";
import type { LucideIcon } from "../ui/icons";
import type { FeatureFlag } from "../hooks/useFeature";
import { isSmartView, type SmartView } from "@atlastodo/shared";

/**
 * The app's selectable views: which exist, what they are called and which icon. The paths live in
 * the `app/` route tree, so the route segment doubles as the view id (`viewPath` relies on it).
 *
 * The smart-view list and its type guard come from `@atlastodo/shared` (`views.ts`), so the nav cannot
 * drift from the stored `default_view` validation; only the nav shape is this app's own.
 */

// Re-exported so the nav vocabulary is importable from one place.
export { isSmartView };
export type { SmartView };

export interface NavItem {
  view: SmartView;
  /** i18n key (catalogs in `@atlastodo/shared/locales`); `label` is the fallback until translated. */
  labelKey: string;
  label: string;
  icon: LucideIcon;
}

/** The smart lists, in sidebar order. */
export const NAV: NavItem[] = [
  { view: "today", labelKey: "nav.today", label: "Today", icon: Sun },
  { view: "upcoming", labelKey: "nav.upcoming", label: "Upcoming", icon: CalendarClock },
  { view: "inbox", labelKey: "nav.inbox", label: "Inbox", icon: Inbox },
  { view: "assigned", labelKey: "nav.assigned", label: "Assigned to me", icon: UserRound },
  { view: "all", labelKey: "nav.all", label: "All tasks", icon: ListTodo },
  { view: "completed", labelKey: "nav.completed", label: "Completed", icon: CircleCheckBig },
];

/** The three lists that get a bottom tab; the rest live in the drawer. */
export const PRIMARY_TABS: SmartView[] = ["today", "upcoming", "inbox"];

/**
 * Drawer entries that are not smart lists. Kept apart from {@link NAV} because they are not valid
 * `default_view` targets ({@link isSmartView}). `name` is the route segment under `app/(drawer)/`.
 */
export interface DrawerExtra {
  name: string;
  labelKey: string;
  label: string;
  icon: LucideIcon;
}

export const DRAWER_EXTRA: DrawerExtra[] = [
  { name: "projects", labelKey: "nav.projects", label: "Projects", icon: Hash },
  { name: "calendar", labelKey: "nav.calendar", label: "Calendar", icon: CalendarDays },
  { name: "filters", labelKey: "nav.filters", label: "Filters", icon: ListFilter },
  { name: "notifications", labelKey: "nav.notifications", label: "Notifications", icon: Bell },
  { name: "archive", labelKey: "nav.archive", label: "Archive", icon: Archive },
  { name: "trash", labelKey: "nav.trash", label: "Recently deleted", icon: Trash2 },
  { name: "about", labelKey: "nav.about", label: "About", icon: Info },
];

/**
 * The optional, feature-gated views. Each carries a {@link FeatureFlag}; the drawer hides its entry
 * and the command palette drops its command when the flag is off (`useFeature`). `name` is the
 * route segment under `app/(drawer)/`.
 */
export interface FeatureView {
  name: string;
  labelKey: string;
  label: string;
  icon: LucideIcon;
  flag: FeatureFlag;
}

export const FEATURE_VIEWS: FeatureView[] = [
  { name: "focus", labelKey: "nav.focus", label: "Focus", icon: Timer, flag: "focus" },
  { name: "habits", labelKey: "nav.habits", label: "Habits", icon: Flame, flag: "habits" },
  { name: "stats", labelKey: "nav.stats", label: "Stats", icon: ChartColumn, flag: "stats" },
  {
    name: "countdowns",
    labelKey: "nav.countdowns",
    label: "Countdowns",
    icon: Clock,
    flag: "countdowns",
  },
];

/** The route path for a smart view, e.g. `today` -> `/today`. */
export function viewPath(view: SmartView): string {
  return `/${view}`;
}
