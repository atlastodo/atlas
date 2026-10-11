import {
  Bell,
  CalendarClock,
  Database,
  LifeBuoy,
  ListChecks,
  Menu,
  Monitor,
  Palette,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Tag,
  UserRound,
} from "../ui/icons";
import type { LucideIcon } from "../ui/icons";
import { isOnlineWeb } from "../auth/serverUrl";

/**
 * The Settings screen's sections, and how the `?section=` query picks one.
 *
 * Settings shows **one section at a time**, selected by the URL (`/settings?section=labels`), so a
 * section is deep-linkable and survives a refresh. Two navs drive the same param: the wide sidebar
 * (which the `(drawer)` layout swaps for this list while Settings is open) and the phone's pill bar.
 * Both read this one list, so they cannot disagree on order, labels or what an unknown id means.
 */
export type SettingsSectionId =
  | "appearance"
  | "sidebar"
  | "tasks"
  | "calendar"
  | "features"
  | "notifications"
  | "labels"
  | "data"
  | "server"
  | "devices"
  | "desktop"
  | "help"
  | "account"
  | "admin";

export interface SettingsSection {
  id: SettingsSectionId;
  labelKey: string;
  icon: LucideIcon;
}

const ALL_SECTIONS: SettingsSection[] = [
  { id: "appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "sidebar", labelKey: "settings.sidebarMenu", icon: Menu },
  { id: "tasks", labelKey: "settings.tasksGestures", icon: ListChecks },
  { id: "calendar", labelKey: "settings.calendarTime", icon: CalendarClock },
  { id: "features", labelKey: "settings.features", icon: SlidersHorizontal },
  { id: "notifications", labelKey: "settings.notifications", icon: Bell },
  { id: "labels", labelKey: "label.manage", icon: Tag },
  { id: "data", labelKey: "settings.data", icon: Database },
  { id: "server", labelKey: "settings.server", icon: Server },
  { id: "devices", labelKey: "settings.devices", icon: Smartphone },
  { id: "desktop", labelKey: "settings.desktop", icon: Monitor },
  { id: "help", labelKey: "settings.help", icon: LifeBuoy },
  { id: "account", labelKey: "settings.account", icon: UserRound },
  { id: "admin", labelKey: "settings.admin", icon: ShieldCheck },
];

/**
 * The sections this user can open. Admin (accounts, error reports, instance settings) is only
 * listed for an administrator (`isAdmin`, a UI hint -- the server re-checks every `/admin/*`
 * request). Server section is hidden when using the app online via web, as the app defaults to the
 * active website URL. Local-only mode has no server and no sessions, so neither Server nor Devices.
 * Desktop app only shows inside the desktop app.
 */
export function settingsSections(admin: boolean, localOnly = false): SettingsSection[] {
  return ALL_SECTIONS.filter((s) => {
    if (s.id === "admin" && !admin) return false;
    if (s.id === "server" && (localOnly || isOnlineWeb())) return false;
    if (s.id === "devices" && localOnly) return false;
    if (s.id === "desktop" && !isDesktopApp()) return false;
    return true;
  });
}

/**
 * The section a raw `?section=` value selects. A missing, unknown or not-permitted id (an old link,
 * a typo, `admin` for a non-admin) falls back to the first section rather than an empty page.
 */
export function resolveSettingsSection(
  raw: string | string[] | undefined,
  sections: SettingsSection[],
): SettingsSectionId {
  const id = Array.isArray(raw) ? raw[0] : raw;
  return sections.find((s) => s.id === id)?.id ?? sections[0]!.id;
}

/** Running inside the Electron desktop app, whose preload exposes `window.atlasDesktop`. */
function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { atlasDesktop?: unknown }).atlasDesktop != null
  );
}
