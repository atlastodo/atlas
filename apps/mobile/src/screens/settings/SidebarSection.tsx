import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { SMART_VIEWS } from "@atlas/shared";
import { useMotion } from "../../lib/motion";
import { usePreferences } from "../../hooks/usePreferences";
import { useProjects } from "../../hooks/useProjects";
import { Section } from "../../ui/Section";
import { Toggle } from "../../ui/Toggle";
import { ChevronDown, ChevronUp, Menu } from "../../ui/icons";

/** Which smart lists and projects the sidebar menu shows; the project list folds away. */
export function SidebarSection() {
  const { t } = useTranslation();
  const { smartViewInMenu, setSmartViewInMenu, projectPinned, setProjectPinned } = usePreferences();
  const { projects } = useProjects();
  const motion = useMotion();
  const [projectsMenuExpanded, setProjectsMenuExpanded] = useState(false);

  const toggleProjectsMenu = () => {
    setProjectsMenuExpanded((prev) => !prev);
  };

  return (
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
  );
}
