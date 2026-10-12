import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Segmented } from "../ui/Segmented";
import { AdminReportsScreen } from "./AdminReportsScreen";
import { AdminSettingsScreen } from "./AdminSettingsScreen";
import { AdminUsersScreen } from "./AdminUsersScreen";

export type AdminTab = "users" | "reports" | "settings";

const TABS: { value: AdminTab; labelKey: string }[] = [
  { value: "users", labelKey: "admin.users" },
  { value: "reports", labelKey: "admin.reports" },
  { value: "settings", labelKey: "admin.settings" },
];

/** The tab a raw `?tab=` value selects; a missing or unknown one opens the account list. */
export function resolveAdminTab(raw: string | string[] | undefined): AdminTab {
  const id = Array.isArray(raw) ? raw[0] : raw;
  return TABS.find((tab) => tab.value === id)?.value ?? "users";
}

/**
 * Settings' Admin section: accounts, error reports and instance settings behind one switcher. The
 * tab lives in the URL (`/settings?section=admin&tab=reports`) like the section does, so it
 * deep-links; the route writes it. Each tab scrolls itself (the lists are virtualized), so
 * Settings renders this outside its page ScrollView.
 */
export function AdminPanel({
  tab,
  onSelectTab,
}: {
  tab?: string | string[];
  onSelectTab: (tab: AdminTab) => void;
}) {
  const { t } = useTranslation();
  const active = resolveAdminTab(tab);
  return (
    <View className="w-full max-w-2xl flex-1 self-center">
      <View className="px-4 pt-3">
        <Segmented
          value={active}
          options={TABS.map((s) => ({ value: s.value, label: t(s.labelKey) }))}
          onChange={onSelectTab}
          label={t("admin.title")}
        />
      </View>
      {active === "users" ? (
        <AdminUsersScreen />
      ) : active === "reports" ? (
        <AdminReportsScreen />
      ) : (
        <AdminSettingsScreen />
      )}
    </View>
  );
}
