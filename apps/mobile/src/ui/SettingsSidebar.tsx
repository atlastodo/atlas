import { useTranslation } from "react-i18next";
import { isAdmin } from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useStoreOptional } from "../data/StoreProvider";
import {
  resolveSettingsSection,
  settingsSections,
  type SettingsSectionId,
} from "../nav/settingsNav";
import {
  AppDrawerContent,
  type AppDrawerContentProps,
  type SidebarSection,
} from "./AppDrawerContent";
import { ChevronLeft } from "./icons";

/**
 * The wide sidebar while Settings is open: a Back row, then Settings' sections. The `(drawer)`
 * layout renders this in place of the app's rows, wrapping the same {@link AppDrawerContent}.
 * Router-free: the layout passes the raw `?section=` value and the two navigations.
 */
export function SettingsSidebar({
  section,
  onSelectSection,
  onBack,
  ...chrome
}: Omit<AppDrawerContentProps, "sections" | "activeHref" | "onNavigate"> & {
  section?: string | string[];
  onSelectSection: (id: SettingsSectionId) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { session } = useAuth();
  const localOnly = useStoreOptional()?.localOnly === true;
  const visible = settingsSections(isAdmin(session), localOnly);
  const active = resolveSettingsSection(section, visible);

  const sections: SidebarSection[] = [
    {
      key: "back",
      items: [
        { key: "back", label: t("common.back"), icon: ChevronLeft, href: null, onPress: onBack },
      ],
    },
    {
      key: "settings",
      // Each row's href marks the selected one; the press goes through `onSelectSection`, which writes that address.
      items: visible.map((s) => ({
        key: `settings-${s.id}`,
        label: t(s.labelKey),
        icon: s.icon,
        href: `/settings?section=${s.id}`,
        onPress: () => onSelectSection(s.id),
      })),
    },
  ];

  return (
    <AppDrawerContent
      {...chrome}
      sections={sections}
      activeHref={`/settings?section=${active}`}
      onNavigate={() => {}}
    />
  );
}
