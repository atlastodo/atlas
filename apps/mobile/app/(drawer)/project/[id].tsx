import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { DEFAULT_FOLDER_ICON, resolveProjectColor } from "@atlastodo/shared";
import { ProjectScreen } from "../../../src/screens/ProjectScreen";
import { ProjectsScreen } from "../../../src/screens/ProjectsScreen";
import { useProjects } from "../../../src/hooks/useProjects";
import { projectIconFor } from "../../../src/ui/projectIcons";
import { useHeaderRight, useHeaderTitle } from "../../../src/ui/useHeaderTitle";
import { ScreenFocusBoundary } from "../../../src/ui/ScreenFocusBoundary";

/**
 * A single project's tasks, as a drawer screen rather than pushed over the shell: a project is a
 * view like Today or a filter, so it keeps the sidebar (wide) or hamburger bar (narrow). The task
 * detail stays pushed (a focused editor).
 *
 * The project name is the header title (set here; otherwise a drawer screen's title is the raw
 * route name `[id]`), and the project's actions sit at the header's right. The screen builds them
 * since it owns what they open, and publishes them through `onHeaderActions`.
 */
export default function ProjectRoute() {
  const { t } = useTranslation();
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const { projects, folders } = useProjects();
  const folder = folders.find((f) => f.id === id);
  const project = projects.find((p) => p.id === id) ?? folder;

  useHeaderTitle({
    icon: projectIconFor(project?.icon || (folder ? DEFAULT_FOLDER_ICON : undefined)),
    title: project?.name ?? t("nav.projects"),
    color: project ? resolveProjectColor(project) : undefined,
  });
  const setHeaderRight = useHeaderRight();

  if (typeof id !== "string") return null;

  // A folder holds projects, not tasks, so opening one shows the Projects list scoped to its
  // subtree. Handled here rather than by redirect, so a bookmark or deep link on a folder works.
  if (folder) {
    return (
      <ScreenFocusBoundary>
        <ProjectsScreen
          rootId={id}
          onOpenProject={(p) => router.push(`/project/${p.id}`)}
          onCreated={(newId) => router.push(`/project/${newId}`)}
          onHeaderActions={setHeaderRight}
        />
      </ScreenFocusBoundary>
    );
  }

  return (
    <ScreenFocusBoundary>
      <ProjectScreen
        projectId={id}
        onOpenTask={(task) => router.push(`/task/${task.id}`)}
        // Not pushed, so "leave" navigates to a safe view rather than popping.
        onLeave={() => router.replace("/today")}
        // Board/List lives in the URL (?mode=board), so a refresh stays on the board instead of
        // resetting to the List view. setParams updates the current route's query in place.
        // Without one, the project's own default view.
        mode={mode === "board" || mode === "list" ? mode : (project?.default_view ?? "list")}
        onSetMode={(m) => router.setParams({ mode: m })}
        onHeaderActions={setHeaderRight}
      />
    </ScreenFocusBoundary>
  );
}
