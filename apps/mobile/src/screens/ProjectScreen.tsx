import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Platform, Pressable, Switch, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ACCENTS,
  DEFAULT_PROJECT_ICON,
  openTasks,
  rankBetween,
  resolveProjectColor,
  sortTasks,
  toProject,
} from "@atlastodo/shared";
import type { Task } from "@atlastodo/client-core";
import { useStore } from "../data/StoreProvider";
import { useAuth } from "../auth/AuthContext";
import { useTaskListView } from "../hooks/useTaskListView";
import { useProjects } from "../hooks/useProjects";
import { useProjectMembers } from "../hooks/useProjectMembers";
import { usePreferences } from "../hooks/usePreferences";
import { useIsWide } from "../hooks/useIsWide";
import { useSections } from "../hooks/useSections";
import { useToast } from "../data/ToastProvider";
import { useSelection } from "../data/SelectionProvider";
import { ProjectTaskList } from "../ui/ProjectTaskList";
import { bulkHandlers } from "./ViewTaskList";
import { GroupedTaskList } from "../ui/GroupedTaskList";
import { StyleEditor, StyleAction } from "../ui/StyleEditor";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { QuickAdd } from "../ui/QuickAdd";
import { ShareDialog } from "../ui/ShareDialog";
import {
  ProjectHeaderActions,
  headerLayoutFor,
  type HeaderLayout,
} from "../ui/ProjectHeaderActions";
import { Archive, CircleAlert, CopyPlus, Kanban, ListTodo, LogOut, Trash2 } from "../ui/icons";
import { Segmented } from "../ui/Segmented";
import { BoardScreen } from "./BoardScreen";

/**
 * One project's tasks, as a manually reorderable flat list (`ProjectTaskList`). Quick-add defaults
 * `project_id`. Navigation is injected (`onOpenTask`). The project's actions are the nav header's:
 * the screen builds them ({@link ProjectHeaderActions}) and hands them to the route through
 * `onHeaderActions`.
 */

export interface ProjectScreenProps {
  projectId: string;
  onOpenTask?: (task: Task) => void;
  /** Leave the project screen (the route supplies `router.back`); called after archive/delete. */
  onLeave?: () => void;
  /** List or Board, lifted to the route so it lives in the URL. Without it (tests) the screen uses local state. */
  mode?: "list" | "board";
  onSetMode?: (mode: "list" | "board") => void;
  /** Receives the project's header actions (`null` on unmount) for the nav header's `headerRight`. Only changes when what it shows changes. */
  onHeaderActions?: (actions: ReactElement | null) => void;
}

export function ProjectScreen({
  projectId,
  onOpenTask,
  onLeave,
  mode: modeProp,
  onSetMode,
  onHeaderActions,
}: ProjectScreenProps) {
  const { t } = useTranslation();
  const { store, version, kick, localOnly } = useStore();
  const { api, session } = useAuth();
  const view = useTaskListView(`project:${projectId}`);
  const isWide = useIsWide();
  const { renameProject, updateProject, duplicateProject, removeProject, setProjectArchived } =
    useProjects();
  const {
    forProject,
    isOwner,
    isOwnerDeletionScheduled: checkOwnerDeletion,
    claimOwnership,
  } = useProjectMembers();
  const { showDoneFor, setShowDone, isFavorite, toggleFavorite, accent } = usePreferences();
  const showDone = showDoneFor(projectId);
  const isFav = isFavorite(`project:${projectId}`);
  const {
    sections,
    createSection,
    renameSection,
    duplicateSection,
    removeSection,
    archiveSection,
    moveSectionToProject,
    reorderSection,
  } = useSections(projectId);
  const toast = useToast();
  const selection = useSelection();
  const [localMode, setLocalMode] = useState<"list" | "board">("list");
  const mode = modeProp ?? localMode;
  const setMode = (m: "list" | "board") => {
    setLocalMode(m);
    onSetMode?.(m);
  };
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [claiming, setClaiming] = useState(false);
  // The header spans this pane, not the window (a sidebar takes the rest), so its layout follows the
  // pane's measured width. Bucketed, so a resize only re-sets the header when the layout changes.
  const [headerLayout, setHeaderLayout] = useState<HeaderLayout | undefined>(undefined);
  const onRootLayout = (e: LayoutChangeEvent) =>
    setHeaderLayout(headerLayoutFor(e.nativeEvent.layout.width));

  // Only an owner may delete/archive a shared project; a non-owner can only leave it. An unshared
  // project has no member rows, so its creator is the implicit owner.
  const owner = isOwner(projectId);
  const shared = forProject(projectId).length > 0;

  const leaveProject = async () => {
    setLeaving(false);
    const myId = session?.user.id;
    if (!myId) return;
    try {
      // Removing yourself is a "leave": the server revokes your local copy. Not locally undoable, hence the confirm.
      await api.removeMember(projectId, myId);
      onLeave?.();
      kick();
      toast.show(t("toast.projectLeft"));
    } catch {
      toast.show(t("toast.leaveFailed"));
    }
  };

  const handleClaimOwnership = async () => {
    setClaiming(false);
    try {
      await claimOwnership(projectId);
      toast.show(t("projects.becomeOwnerSuccess"));
    } catch {
      toast.show(t("projects.becomeOwnerFailed"));
    }
  };

  const project = useMemo(() => {
    const e = store.get("project", projectId);
    return e ? toProject(projectId, e) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version, projectId]);

  // Everything in this project, completed included: the set a group widens from so a matched task's
  // parent or open subtask can nest. Project-scoped so a parent moved elsewhere is not dragged back.
  const projectTasks = useMemo(
    () => view.tasks.filter((task) => task.project_id === projectId),
    [view.tasks, projectId],
  );

  const tasks = useMemo(() => openTasks(projectTasks), [projectTasks]);

  const doneTasks = useMemo(
    () =>
      showDone
        ? view.tasks
            .filter((task) => task.project_id === projectId && task.is_completed)
            .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
        : [],
    [view.tasks, projectId, showDone],
  );

  const toggleFav = () => {
    toggleFavorite(`project:${projectId}`);
    toast.show(isFav ? t("toast.favRemoved") : t("toast.favAdded"));
  };

  // Memoised on what they show, with handlers read through a ref: the route passes the element to
  // `navigation.setOptions`, so a fresh element each render would re-set the header. The board
  // lacks Select and group/sort.
  const latest = useRef({ toggleFav, setMode, setListPref: view.setListPref });
  latest.current = { toggleFav, setMode, setListPref: view.setListPref };
  const hasProject = project !== null;
  const canSelect = mode === "list" && tasks.length > 0 && !selection.mode;
  const { group, sort } = view.listPref;
  const headerActions = useMemo(
    () =>
      hasProject ? (
        <ProjectHeaderActions
          mode={mode}
          onSetMode={(m) => latest.current.setMode(m)}
          isFavorite={isFav}
          onToggleFavorite={() => latest.current.toggleFav()}
          onEdit={() => setEditing(true)}
          onShare={localOnly ? undefined : () => setSharing(true)}
          canSelect={canSelect}
          listPref={mode === "list" ? { group, sort } : undefined}
          onChangeListPref={(patch) => latest.current.setListPref(patch)}
          accentColor={ACCENTS[accent][600]}
          layout={headerLayout}
        />
      ) : null,
    [hasProject, mode, isFav, canSelect, group, sort, accent, headerLayout, localOnly],
  );
  useLayoutEffect(() => {
    onHeaderActions?.(headerActions);
    return () => onHeaderActions?.(null);
  }, [onHeaderActions, headerActions]);

  if (!project) {
    return (
      <View className="flex-1 items-center justify-center bg-white dark:bg-zinc-950">
        <Text className="text-sm text-neutral-500">{t("common.nothingHere")}</Text>
      </View>
    );
  }

  const shareDialog = sharing ? (
    <ShareDialog
      projectId={projectId}
      projectName={project.name}
      onClose={() => setSharing(false)}
    />
  ) : null;

  const styleSheet = (
    <StyleEditor
      open={editing}
      name={project.name}
      nameLabel={t("board.rename")}
      iconLabel={t("workspace.projectIcon")}
      colorLabel={t("workspace.projectColor")}
      selectedIcon={project.icon || DEFAULT_PROJECT_ICON}
      defaultIcon={DEFAULT_PROJECT_ICON}
      selectedColor={resolveProjectColor(project)}
      isFavorite={isFav}
      onToggleFavorite={toggleFav}
      onRename={(name) => renameProject(project.id, name)}
      onSetIcon={(icon) => updateProject(project.id, { icon })}
      onSetColor={(color) => updateProject(project.id, { color })}
      onClose={() => setEditing(false)}
      extra={
        <View className="gap-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm text-neutral-700 dark:text-neutral-200">
              {t("board.showCompleted")}
            </Text>
            <Switch
              accessibilityLabel={t("board.showCompleted")}
              value={showDone}
              onValueChange={(v) => setShowDone(project.id, v)}
            />
          </View>
          <View className="flex-row items-center justify-between gap-4">
            <Text className="text-sm text-neutral-700 dark:text-neutral-200">
              {t("projects.defaultView")}
            </Text>
            <Segmented
              value={project.default_view}
              options={[
                { value: "list", label: t("board.viewList"), icon: ListTodo },
                { value: "board", label: t("board.viewBoard"), icon: Kanban },
              ]}
              onChange={(default_view) => updateProject(project.id, { default_view })}
              label={t("projects.defaultView")}
            />
          </View>
        </View>
      }
      footer={(close) => (
        <>
          <StyleAction
            icon={CopyPlus}
            label={t("common.duplicate")}
            onPress={() => {
              const { undo } = duplicateProject(project.id);
              toast.show(t("toast.projectDuplicated"), { label: t("common.undo"), run: undo });
              close();
            }}
          />
          {owner && (
            <StyleAction
              icon={Archive}
              label={t("common.archive")}
              accessibilityLabel={t("workspace.archiveProject")}
              onPress={() => {
                setProjectArchived(project.id, true);
                onLeave?.();
                toast.show(t("toast.projectArchived"), {
                  label: t("common.undo"),
                  run: () => setProjectArchived(project.id, false),
                });
                close();
              }}
            />
          )}
          {owner ? (
            <StyleAction
              icon={Trash2}
              label={t("common.delete")}
              accessibilityLabel={t("workspace.deleteProject")}
              danger
              onPress={() => {
                const undo = removeProject(project.id);
                onLeave?.();
                toast.show(shared ? t("toast.projectDeletedForAll") : t("toast.projectDeleted"), {
                  label: t("common.undo"),
                  run: undo,
                });
                close();
              }}
            />
          ) : (
            <StyleAction
              icon={LogOut}
              label={t("workspace.leaveProject")}
              accessibilityLabel={t("workspace.leaveProject")}
              danger
              onPress={() => {
                close();
                setLeaving(true);
              }}
            />
          )}
        </>
      )}
    />
  );

  const confirmLeave = (
    <ConfirmDialog
      visible={leaving}
      title={t("workspace.leaveProjectTitle")}
      message={t("workspace.leaveProjectMessage", { name: project.name })}
      confirmLabel={t("workspace.leaveProject")}
      danger
      onConfirm={() => void leaveProject()}
      onCancel={() => setLeaving(false)}
    />
  );

  const ownerScheduledForDeletion = !owner && checkOwnerDeletion(projectId);

  const ownerDeletionBanner = ownerScheduledForDeletion ? (
    <View
      testID="owner-deletion-banner"
      className="mx-4 my-2 flex-row items-center justify-between rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40"
    >
      <View className="flex-1 flex-row items-center gap-2 pr-2">
        <CircleAlert size={18} className="text-amber-600 dark:text-amber-400" />
        <Text className="flex-1 text-xs text-amber-800 dark:text-amber-300">
          {t("projects.ownerDeletionScheduled")}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => setClaiming(true)}
        className="rounded-md bg-amber-600 px-2.5 py-1.5 active:bg-amber-700 dark:bg-amber-500"
      >
        <Text className="text-xs font-medium text-white">{t("projects.becomeOwner")}</Text>
      </Pressable>
    </View>
  ) : null;

  const confirmClaim = (
    <ConfirmDialog
      visible={claiming}
      title={t("projects.becomeOwner")}
      message={t("projects.becomeOwnerConfirm")}
      confirmLabel={t("projects.becomeOwner")}
      onConfirm={() => void handleClaimOwnership()}
      onCancel={() => setClaiming(false)}
    />
  );

  if (mode === "board") {
    return (
      <View onLayout={onRootLayout} className="flex-1 bg-white dark:bg-zinc-950">
        {ownerDeletionBanner}
        <BoardScreen projectId={projectId} onOpenTask={onOpenTask} />
        {shareDialog}
        {styleSheet}
        {confirmLeave}
        {confirmClaim}
      </View>
    );
  }

  const addTaskToSection = (sectionId: string | null, title: string) => {
    const value = title.trim();
    if (!value) return;
    const siblings = sortTasks(
      tasks.filter((tk) => (tk.section_id ?? null) === sectionId),
      "manual",
    );
    const last = siblings.at(-1);
    view.create({
      title: value,
      project_id: projectId,
      section_id: sectionId,
      sort_order: rankBetween(last ? last.sort_order : null, null),
    });
  };

  const addSection = (name: string) =>
    createSection(name, sections.length ? sections[sections.length - 1]!.sort_order + 1 : 0);

  const duplicateSectionWithUndo = (id: string) => {
    const { undo } = duplicateSection(id);
    toast.show(t("toast.sectionDuplicated"), { label: t("common.undo"), run: undo });
  };

  const deleteSectionWithUndo = (id: string) => {
    const undo = removeSection(id);
    toast.show(t("toast.sectionDeleted"), { label: t("common.undo"), run: undo });
  };

  const archiveSectionWithUndo = (id: string) => {
    const undo = archiveSection(id);
    toast.show(t("toast.sectionArchived"), { label: t("common.undo"), run: undo });
  };

  const moveSectionWithUndo = (id: string, targetProjectId: string) => {
    const undo = moveSectionToProject(id, targetProjectId);
    toast.show(t("toast.sectionMoved"), { label: t("common.undo"), run: undo });
  };

  const selectSectionTasks = (cards: Task[]) => {
    selection.enter();
    selection.add(cards.map((c) => c.id));
  };

  const moveTaskToSection = (
    task: Task,
    patch: { section_id: string | null; sort_order: number; parent_id?: string | null },
  ) => {
    view.moveCard(task.id, patch);
    const target = patch.section_id
      ? (sections.find((s) => s.id === patch.section_id)?.name ?? t("board.noSection"))
      : t("board.noSection");
    toast.show(t("toast.movedToSection", { name: target }), {
      label: t("common.undo"),
      run: () =>
        view.moveCard(task.id, {
          section_id: task.section_id,
          sort_order: task.sort_order,
          parent_id: task.parent_id,
        }),
    });
  };

  // Manual + ungrouped keeps the drag-reorderable section list. Any other group/sort choice renders
  // the shared grouped surface (drag off), using the project's own synced `list_prefs` slot.
  const grouped = !(view.listPref.group === "none" && view.listPref.sort === "manual");

  const quickAddHeader = (
    <View>
      {ownerDeletionBanner}
      {/* A phone, web included, adds through the list's add button instead. */}
      {Platform.OS === "web" && isWide && (sections.length === 0 || grouped) && (
        <View className="px-4 py-2">
          <QuickAdd
            onAdd={view.create}
            onCreateProject={view.createProject}
            onCreateLabel={view.createLabel}
            resolveLabels={view.resolveLabels}
            smartDates={view.smartDates}
            resolveProject={view.resolveProject}
            projects={view.projects}
            labels={view.labels}
            now={view.now}
            formatDue={view.formatDue}
            defaults={{ project_id: projectId, section_id: null }}
            timeZone={view.timeZone}
          />
        </View>
      )}
    </View>
  );

  return (
    <View
      testID="project-screen"
      onLayout={onRootLayout}
      className="flex-1 bg-white dark:bg-zinc-950"
    >
      {grouped ? (
        <GroupedTaskList
          tasks={tasks}
          allTasks={projectTasks}
          now={view.now}
          timeZone={view.timeZone}
          groupBy={view.listPref.group}
          groupTitle={view.groupTitle}
          sortBy={view.listPref.sort}
          onReorder={(id, sortOrder) => view.reorderTask(id, sortOrder)}
          onReparent={view.reparentTask}
          onToggle={view.toggle}
          onSkipTask={view.skip}
          onOpen={onOpenTask}
          onReschedule={view.reschedule}
          formatDue={view.formatDue}
          {...bulkHandlers(view)}
          onUpdateTask={view.update}
          onCreateTask={view.create}
          onDiscardTask={view.discard}
          resolveLabels={view.resolveLabels}
          resolveProject={view.resolveProject}
          smartDates={view.smartDates}
          quickAddDefaults={{ project_id: projectId, section_id: null }}
          showToolbar={false}
          header={quickAddHeader}
        />
      ) : (
        <ProjectTaskList
          projectId={projectId}
          tasks={tasks}
          now={view.now}
          onToggle={view.toggle}
          onReschedule={view.reschedule}
          onSkipTask={view.skip}
          onOpen={onOpenTask}
          onReorder={(id, sortOrder) => view.reorderTask(id, sortOrder)}
          onReparent={view.reparentTask}
          onMoveToSection={moveTaskToSection}
          formatDue={view.formatDue}
          sections={sections}
          timeZone={view.timeZone}
          {...bulkHandlers(view)}
          onAddSection={addSection}
          onRenameSection={renameSection}
          onDuplicateSection={duplicateSectionWithUndo}
          onDeleteSection={deleteSectionWithUndo}
          onArchiveSection={archiveSectionWithUndo}
          onMoveSection={moveSectionWithUndo}
          onReorderSection={reorderSection}
          onSelectSectionTasks={selectSectionTasks}
          onAddTask={addTaskToSection}
          header={quickAddHeader}
          doneTasks={doneTasks}
          showDone={showDone}
          onUpdateTask={view.update}
          onCreateTask={view.create}
          onDiscardTask={view.discard}
          resolveLabels={view.resolveLabels}
          resolveProject={view.resolveProject}
          smartDates={view.smartDates}
          quickAddDefaults={{ project_id: projectId, section_id: null }}
        />
      )}
      {shareDialog}
      {styleSheet}
      {confirmLeave}
      {confirmClaim}
    </View>
  );
}
