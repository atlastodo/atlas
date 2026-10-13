import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isAdmin } from "@atlas/client-core";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";
import { useIsWide } from "../hooks/useIsWide";
import {
  resolveSettingsSection,
  settingsSections,
  type SettingsSectionId,
} from "../nav/settingsNav";
import { ScreenFade } from "../ui/ScreenFade";
import { AdminPanel, type AdminTab } from "./AdminPanel";
import { AccountSection } from "./settings/AccountSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { CalendarSection } from "./settings/CalendarSection";
import { DataSection } from "./settings/DataSection";
import { DesktopSection } from "./settings/DesktopSection";
import { ApiTokensSection } from "./settings/ApiTokensSection";
import { DevicesSection } from "./settings/DevicesSection";
import { FeaturesSection } from "./settings/FeaturesSection";
import { HelpSection } from "./settings/HelpSection";
import { LabelsSection } from "./settings/LabelsSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ServerSection } from "./settings/ServerSection";
import { SidebarSection } from "./settings/SidebarSection";
import { TasksSection } from "./settings/TasksSection";

export { relativeLabel } from "./settings/relativeLabel";

/**
 * Settings. Every value is a field on the synced preference entity, written through
 * `usePreferences`, so it follows the account across devices.
 *
 * Each section is its own component under `settings/`; this screen picks the one the URL names and
 * lays out the navigation around it (a pill bar on a phone, the drawer's sidebar when wide).
 *
 * Every `<select>` is a {@link ListPicker} (RN has no select; the timezone list is searchable). The
 * server URL cannot apply itself: a phone app cannot rebind its `ApiClient`, so it saves and says
 * so. Data export/import splits by platform in `lib/dataTransfer`.
 */

/** A section's content, mounted only while selected, so e.g. the devices list is fetched only when opened. */
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
  const isWide = useIsWide();
  const { session } = useAuth();
  const { localOnly } = useStore();
  const pillScrollViewRef = useRef<ScrollView>(null);
  const pillX = useRef<Partial<Record<SettingsSectionId, number>>>({});

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

  const renderSections = () => (
    <View className="gap-6">
      <SettingsPane id="appearance" active={active}>
        <AppearanceSection />
      </SettingsPane>
      <SettingsPane id="sidebar" active={active}>
        <SidebarSection />
      </SettingsPane>
      <SettingsPane id="tasks" active={active}>
        <TasksSection />
      </SettingsPane>
      <SettingsPane id="calendar" active={active}>
        <CalendarSection />
      </SettingsPane>
      <SettingsPane id="features" active={active}>
        <FeaturesSection />
      </SettingsPane>
      <SettingsPane id="notifications" active={active}>
        <NotificationsSection />
      </SettingsPane>
      <SettingsPane id="labels" active={active}>
        <LabelsSection />
      </SettingsPane>
      <SettingsPane id="data" active={active}>
        <DataSection />
      </SettingsPane>
      <SettingsPane id="server" active={active}>
        <ServerSection />
      </SettingsPane>
      <SettingsPane id="devices" active={active}>
        <DevicesSection />
      </SettingsPane>
      <SettingsPane id="apiTokens" active={active}>
        <ApiTokensSection />
      </SettingsPane>
      <SettingsPane id="desktop" active={active}>
        <DesktopSection />
      </SettingsPane>
      <SettingsPane id="help" active={active}>
        <HelpSection onOpenAbout={onOpenAbout} />
      </SettingsPane>
      <SettingsPane id="account" active={active}>
        <AccountSection />
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
    </ScreenFade>
  );
}
