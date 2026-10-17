import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { FuzzyItem } from "@atlastodo/shared";
import { DRAWER_EXTRA, FEATURE_VIEWS, NAV, viewPath } from "../nav/navModel";
import { useFeature } from "./useFeature";
import { useHabits } from "./useHabits";
import { useProjects } from "./useProjects";
import { useSavedFilters } from "./useSavedFilters";

/**
 * The command palette's action list: the smart lists, drawer utility views, settings, and one
 * command per project, folder, habit and saved filter.
 *
 * A command carries an `href` (an expo-router path), never a closure, which keeps `router` out of
 * screens and hooks. `label` and optional `keywords` feed `@atlastodo/shared`'s `filterActions` ranking.
 */
export interface Command extends FuzzyItem {
  id: string;
  /** Right-aligned group hint. */
  hint?: string;
  /** The expo-router path to navigate to. */
  href: string;
}

export function useCommands(): Command[] {
  const { t } = useTranslation();
  const { projects, folders } = useProjects();
  const { habits, habitGroups } = useHabits();
  const { filters } = useSavedFilters();
  const habitsOn = useFeature("habits");
  const focusOn = useFeature("focus");
  const statsOn = useFeature("stats");
  const countdownsOn = useFeature("countdowns");
  const flags: Record<string, boolean> = useMemo(
    () => ({ habits: habitsOn, focus: focusOn, stats: statsOn, countdowns: countdownsOn }),
    [habitsOn, focusOn, statsOn, countdownsOn],
  );

  return useMemo(() => {
    const viewHint = t("palette.commands");
    const commands: Command[] = [];

    for (const item of NAV) {
      commands.push({
        id: `view:${item.view}`,
        label: t(item.labelKey, item.label),
        keywords: "go to view",
        hint: viewHint,
        href: viewPath(item.view),
      });
    }

    for (const item of DRAWER_EXTRA) {
      commands.push({
        id: `drawer:${item.name}`,
        label: t(item.labelKey, item.label),
        keywords: "go to view",
        hint: viewHint,
        href: `/${item.name}`,
      });
    }

    // Feature views, only while their flag is on (as the drawer).
    for (const item of FEATURE_VIEWS) {
      if (!flags[item.flag]) continue;
      commands.push({
        id: `feature:${item.name}`,
        label: t(item.labelKey, item.label),
        keywords: "go to view",
        hint: viewHint,
        href: `/${item.name}`,
      });
    }

    commands.push({
      id: "settings",
      label: t("common.settings"),
      keywords: "preferences options",
      hint: viewHint,
      href: "/settings",
    });

    commands.push({
      id: "onboarding",
      label: t("settings.onboarding"),
      keywords: "welcome setup onboarding wizard guide get started",
      hint: viewHint,
      href: "/onboarding",
    });

    for (const project of projects) {
      commands.push({
        id: `project:${project.id}`,
        label: t("palette.openBoard", { name: project.name }),
        keywords: `${project.name} project board`,
        href: `/project/${project.id}`,
      });
    }

    // The palette is how you reach a folder with no sidebar row.
    for (const folder of folders) {
      commands.push({
        id: `folder:${folder.id}`,
        label: t("palette.openFolder", { name: folder.name }),
        keywords: `${folder.name} folder projects`,
        href: `/project/${folder.id}`,
      });
    }

    // These open the habit rather than checking it in (a command carries an `href`, not a closure).
    if (flags.habits) {
      const groupName = new Map(habitGroups.map((g) => [g.id, g.name]));
      for (const habit of habits) {
        // A member's name says nothing about its routine in a flat result list, so the hint and
        // keywords name the routine.
        const routine = habit.parent_id !== null ? groupName.get(habit.parent_id) : undefined;
        commands.push({
          id: `habit:${habit.id}`,
          label: t("palette.openHabit", { name: habit.name }),
          keywords: `${habit.name} habit streak${routine !== undefined ? ` ${routine}` : ""}`,
          hint: routine,
          href: `/habit/${habit.id}`,
        });
      }
      for (const group of habitGroups) {
        commands.push({
          id: `habit-group:${group.id}`,
          label: t("palette.openHabitGroup", { name: group.name }),
          keywords: `${group.name} habit group routine`,
          href: `/habit/${group.id}`,
        });
      }
    }

    for (const filter of filters) {
      commands.push({
        id: `filter:${filter.id}`,
        label: t("palette.openFilter", { name: filter.name }),
        keywords: `${filter.name} ${filter.query} filter`,
        href: `/filter/${filter.id}`,
      });
    }

    return commands;
  }, [t, projects, folders, filters, habits, habitGroups, flags]);
}
