import { useEffect, useMemo, useState, type ReactElement } from "react";
import { FlatList, Platform, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_FOLDER_ICON,
  DEFAULT_PROJECT_ICON,
  flattenProjectTree,
  projectDescendantIds,
  resolveProjectColor,
} from "@atlastodo/shared";
import type { FlatProjectRow } from "@atlastodo/shared";
import type { Project } from "@atlastodo/client-core";
import { useProjects } from "../hooks/useProjects";
import { usePreferences } from "../hooks/usePreferences";
import { useProjectMembers } from "../hooks/useProjectMembers";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";
import { useToast } from "../data/ToastProvider";
import { StyleEditor, StyleAction } from "../ui/StyleEditor";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { FolderPicker } from "../ui/FolderPicker";
import { CreateProjectSheet } from "../ui/CreateProjectSheet";
import { projectIconFor } from "../ui/projectIcons";
import { EmptyState } from "../ui/EmptyState";
import { LIST_WIDTH_STYLE } from "../ui/listWidth";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  Folder,
  FolderInput,
  FolderPlus,
  Hash,
  LogOut,
  Plus,
  Trash2,
} from "../ui/icons";
import { haptics } from "../lib/haptics";
import { useContextMenu } from "../hooks/useContextMenu";

/**
 * Projects: the list of projects with icon and colour, header buttons that open the create sheet,
 * and per-project edit
 * (icon/colour/rename/archive/delete). Tapping a project opens it (`onOpenProject`); long-press
 * opens the style sheet. A blank colour falls back to a stable id-hashed one.
 */

/**
 * One row, a project or a folder. Its own component because it holds hover state: the folder
 * chevron shows on the right on hover (always on native) so icons and names share a left edge.
 * The name and pin are sibling pressables: nesting one in another renders a `<button>` in a
 * `<button>` on web.
 */
function ProjectRow({
  row: { project, depth, hasChildren },
  expanded,
  onPress,
  onEdit,
}: {
  row: FlatProjectRow;
  expanded: boolean;
  onPress: () => void;
  onEdit: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isWeb = Platform.OS === "web";
  // Web right-click opens the same sheet as a long-press; a no-op on native.
  const contextRef = useContextMenu(() => onEdit());
  const folder = project.kind === "folder";
  const Icon = projectIconFor(project.icon || (folder ? DEFAULT_FOLDER_ICON : undefined));
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    // The whole row highlights on hover, as task rows do, not just the pressable label.
    <View
      ref={contextRef}
      className="flex-row items-center gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-900 web:hover:bg-neutral-50 dark:web:hover:bg-neutral-900"
    >
      <View style={{ width: depth * 16 }} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={project.name}
        accessibilityState={folder ? { expanded } : undefined}
        onPress={onPress}
        onLongPress={() => {
          haptics.impact("medium");
          onEdit();
        }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        className="min-w-0 flex-1 flex-row items-center gap-3 web:cursor-pointer"
      >
        <View accessible accessibilityLabel={project.icon || (folder ? "folder" : "hash")}>
          <Icon size={isWeb ? 18 : 20} color={resolveProjectColor(project)} />
        </View>
        <Text
          className={
            "flex-1 font-medium text-neutral-900 dark:text-neutral-100 " +
            (isWeb ? "text-sm" : "text-lg")
          }
        >
          {project.name}
        </Text>
        {folder && hasChildren && (hovered || !isWeb) && (
          <Chevron size={14} className="text-neutral-500" />
        )}
      </Pressable>
    </View>
  );
}

export interface ProjectsScreenProps {
  onOpenProject?: (project: Project) => void;
  /** Opens a project just created here (the route supplies navigation). */
  onCreated?: (id: string) => void;
  rootId?: string | null;
  /** Receives the New folder / New project buttons (`null` on unmount) for the nav header's `headerRight`. */
  onHeaderActions?: (actions: ReactElement | null) => void;
}

export function ProjectsScreen({
  onOpenProject,
  onCreated,
  rootId = null,
  onHeaderActions,
}: ProjectsScreenProps = {}) {
  const { t } = useTranslation();
  const {
    projects,
    folders,
    renameProject,
    updateProject,
    duplicateProject,
    removeProject,
    setProjectArchived,
    setProjectParent,
  } = useProjects();
  const { forProject, isOwner } = useProjectMembers();
  const { api, session } = useAuth();
  const { kick } = useStore();
  const toast = useToast();
  const { folderExpanded, setFolderExpanded, isFavorite, toggleFavorite } = usePreferences();
  const [creating, setCreating] = useState<"project" | "folder" | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [moving, setMoving] = useState<Project | null>(null);
  const [leavingProject, setLeavingProject] = useState<Project | null>(null);

  // Only an owner may delete/archive a shared project; a non-owner can only leave it. An unshared
  // project is owned by its creator.
  const owner = editing ? isOwner(editing.id) : true;
  const shared = editing ? forProject(editing.id).length > 0 : false;
  const isFolder = editing?.kind === "folder";
  const isFav = editing ? isFavorite(`project:${editing.id}`) : false;

  const all = useMemo(() => [...projects, ...folders], [projects, folders]);

  const rows = useMemo(() => {
    const collapsed = new Set(folders.filter((f) => !folderExpanded(f.id)).map((f) => f.id));
    const scoped =
      rootId === null
        ? all
        : (() => {
            const inside = projectDescendantIds(all, rootId);
            return all
              .filter((p) => inside.has(p.id))
              .map((p) => (p.parent_id === rootId ? { ...p, parent_id: null } : p));
          })();
    return flattenProjectTree(scoped, collapsed);
  }, [all, folders, folderExpanded, rootId]);

  const headerActions = useMemo(
    () => (
      <View className="shrink-0 flex-row items-center gap-1 pr-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("projects.newFolder")}
          onPress={() => setCreating("folder")}
          hitSlop={8}
          className="rounded-md p-1.5 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
        >
          <FolderPlus size={18} className="text-neutral-500" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.newProject")}
          onPress={() => setCreating("project")}
          className="flex-row items-center gap-1 rounded-md bg-accent-600 px-2.5 py-1.5 web:cursor-pointer web:hover:bg-accent-700"
        >
          <Plus size={16} className="text-white" />
          <Text className="text-sm font-semibold text-white">{t("workspace.newProject")}</Text>
        </Pressable>
      </View>
    ),
    [t],
  );
  useEffect(() => {
    onHeaderActions?.(headerActions);
    return () => onHeaderActions?.(null);
  }, [onHeaderActions, headerActions]);

  const moveToFolder = (project: Project, parentId: string | null) => {
    const undo = setProjectParent(project.id, parentId);
    // `null` means the move was refused as a cycle; the picker does not offer those targets, so this only fires if the tree changed mid-choice.
    if (!undo) {
      toast.show(t("projects.moveCycle"));
      return;
    }
    toast.show(t("toast.movedToFolder"), { label: t("common.undo"), run: undo });
  };

  const leaveProject = async (p: Project) => {
    setLeavingProject(null);
    const myId = session?.user.id;
    if (!myId) return;
    try {
      await api.removeMember(p.id, myId);
      kick();
      toast.show(t("toast.projectLeft"));
    } catch {
      toast.show(t("toast.leaveFailed"));
    }
  };

  return (
    <View className="flex-1 bg-white dark:bg-zinc-950">
      <FlatList
        data={rows}
        contentContainerStyle={LIST_WIDTH_STYLE}
        keyExtractor={(row) => row.project.id}
        ListEmptyComponent={
          <EmptyState
            icon={rootId === null ? Hash : Folder}
            title={rootId === null ? t("workspace.noProjects") : t("projects.emptyFolder")}
            description={rootId === null ? t("projects.emptyHint") : undefined}
            actions={[
              {
                label: t("workspace.newProject"),
                onPress: () => setCreating("project"),
                primary: true,
              },
            ]}
          />
        }
        renderItem={({ item }) => (
          <ProjectRow
            row={item}
            expanded={folderExpanded(item.project.id)}
            onPress={() =>
              item.project.kind === "folder"
                ? setFolderExpanded(item.project.id, !folderExpanded(item.project.id))
                : onOpenProject?.(item.project)
            }
            onEdit={() => setEditing(item.project)}
          />
        )}
      />

      <CreateProjectSheet
        visible={creating !== null}
        kind={creating ?? "project"}
        parentId={rootId}
        onClose={() => setCreating(null)}
        onCreated={(id) => {
          if (creating === "project") onCreated?.(id);
        }}
      />

      <StyleEditor
        open={!!editing}
        name={editing?.name ?? ""}
        nameLabel={t("board.rename")}
        iconLabel={t("workspace.projectIcon")}
        colorLabel={t("workspace.projectColor")}
        selectedIcon={editing?.icon || DEFAULT_PROJECT_ICON}
        defaultIcon={DEFAULT_PROJECT_ICON}
        selectedColor={editing ? resolveProjectColor(editing) : ""}
        isFavorite={isFav}
        onToggleFavorite={() => {
          if (editing) {
            toggleFavorite(`project:${editing.id}`);
            toast.show(isFav ? t("toast.favRemoved") : t("toast.favAdded"));
          }
        }}
        onRename={(name) => editing && renameProject(editing.id, name)}
        onSetIcon={(icon) => editing && updateProject(editing.id, { icon })}
        onSetColor={(color) => editing && updateProject(editing.id, { color })}
        onClose={() => setEditing(null)}
        footer={(close) => (
          <>
            {/* A folder holds no tasks, so there is nothing to deep-duplicate. */}
            {!isFolder && (
              <StyleAction
                icon={CopyPlus}
                label={t("common.duplicate")}
                onPress={() => {
                  if (!editing) return;
                  const { undo } = duplicateProject(editing.id);
                  toast.show(t("toast.projectDuplicated"), { label: t("common.undo"), run: undo });
                  close();
                }}
              />
            )}
            <StyleAction
              icon={FolderInput}
              label={t("projects.moveToFolder")}
              onPress={() => {
                const project = editing;
                close();
                setMoving(project);
              }}
            />
            {owner && (
              <StyleAction
                icon={Archive}
                label={t("common.archive")}
                accessibilityLabel={t("workspace.archiveProject")}
                onPress={() => {
                  if (!editing) return;
                  const id = editing.id;
                  setProjectArchived(id, true);
                  toast.show(t("toast.projectArchived"), {
                    label: t("common.undo"),
                    run: () => setProjectArchived(id, false),
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
                  if (!editing) return;
                  const undo = removeProject(editing.id);
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
                  const p = editing;
                  close();
                  setLeavingProject(p);
                }}
              />
            )}
          </>
        )}
      />

      <FolderPicker
        visible={moving != null}
        folders={folders}
        currentParentId={moving?.parent_id ?? null}
        disabledIds={
          moving ? new Set([moving.id, ...projectDescendantIds(all, moving.id)]) : new Set<string>()
        }
        onPick={(parentId) => moving && moveToFolder(moving, parentId)}
        onClose={() => setMoving(null)}
      />

      <ConfirmDialog
        visible={leavingProject != null}
        title={t("workspace.leaveProjectTitle")}
        message={t("workspace.leaveProjectMessage", { name: leavingProject?.name ?? "" })}
        confirmLabel={t("workspace.leaveProject")}
        danger
        onConfirm={() => leavingProject && void leaveProject(leavingProject)}
        onCancel={() => setLeavingProject(null)}
      />
    </View>
  );
}
