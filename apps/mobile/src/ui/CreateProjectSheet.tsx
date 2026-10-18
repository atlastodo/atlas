import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "@atlastodo/client-core";
import {
  DEFAULT_FOLDER_ICON,
  DEFAULT_PROJECT_ICON,
  defaultColorForIndex,
  flattenProjectTree,
} from "@atlastodo/shared";
import { useProjects } from "../hooks/useProjects";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";
import { haptics } from "../lib/haptics";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { ListPicker } from "./ListPicker";
import { Segmented } from "./Segmented";
import { StylePicker } from "./StylePicker";
import { Kanban, ListTodo } from "./icons";
import {
  DISABLED_BUTTON_CLASS,
  DISABLED_BUTTON_TEXT_CLASS,
  PLACEHOLDER_COLOR,
} from "./useSheetDismiss";

/**
 * Creating a project or folder, in a sheet (a centred dialog on wide web): name, icon, colour, the
 * folder it goes in and, for a project, the view it opens in. The colour starts on the one a quick
 * create would have picked, so a name and Enter is still enough.
 */
export function CreateProjectSheet({
  visible,
  kind = "project",
  parentId = null,
  onClose,
  onCreated,
}: {
  visible: boolean;
  kind?: "project" | "folder";
  /** The folder preselected (the one being browsed, or the sidebar folder it was opened from). */
  parentId?: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { projects, folders, createProject, createFolder } = useProjects();
  const folder = kind === "folder";
  const defaultIcon = folder ? DEFAULT_FOLDER_ICON : DEFAULT_PROJECT_ICON;
  const nextColor = () => defaultColorForIndex(folder ? folders.length : projects.length);

  const [name, setName] = useState("");
  const [icon, setIcon] = useState(defaultIcon);
  const [color, setColor] = useState(nextColor);
  const [parent, setParent] = useState(parentId ?? "");
  const [view, setView] = useState<ProjectView>("list");

  // Re-seed on the closed->open edge, so each create starts fresh in the right folder.
  const [wasOpen, setWasOpen] = useState(false);
  if (visible && !wasOpen) {
    setWasOpen(true);
    setName("");
    setIcon(defaultIcon);
    setColor(nextColor());
    setParent(parentId ?? "");
    setView("list");
  } else if (!visible && wasOpen) {
    setWasOpen(false);
  }

  const escape = useCancelOnEscape(onClose);
  const trimmed = name.trim();

  const submit = () => {
    if (!trimmed) return;
    haptics.success();
    const opts = { parentId: parent || null, icon, color };
    const id = folder
      ? createFolder(trimmed, opts)
      : createProject(trimmed, { ...opts, defaultView: view });
    onClose();
    onCreated(id);
  };

  const folderOptions = [
    { value: "", label: t("projects.noFolder") },
    ...flattenProjectTree(folders).map(({ project, depth }) => ({
      value: project.id,
      label: `${" ".repeat(depth)}${project.name}`,
    })),
  ];

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={folder ? t("projects.newFolder") : t("workspace.newProject")}
    >
      <SheetScrollView showsVerticalScrollIndicator={false} contentContainerClassName="gap-5 pb-1">
        <TextInput
          ref={escape.ref}
          accessibilityLabel={t("projects.name")}
          placeholder={folder ? t("projects.folderNamePlaceholder") : t("projects.namePlaceholder")}
          placeholderTextColor={PLACEHOLDER_COLOR}
          value={name}
          onChangeText={setName}
          onKeyPress={escape.onKeyPress}
          onSubmitEditing={submit}
          autoFocus
          className="rounded-md border border-neutral-200 px-3 py-2.5 text-base text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          {...KEEP_FOCUS_SUBMIT}
        />

        <StylePicker
          iconLabel={t("workspace.projectIcon")}
          colorLabel={t("workspace.projectColor")}
          selectedIcon={icon}
          defaultIcon={defaultIcon}
          selectedColor={color}
          onSetIcon={setIcon}
          onSetColor={setColor}
        />

        <View>
          {folders.length > 0 && (
            <ListPicker
              label={t("projects.folder")}
              value={parent}
              options={folderOptions}
              onChange={setParent}
            />
          )}
          {!folder && (
            <View className="flex-row items-center justify-between gap-4 border-t border-neutral-100 py-3.5 dark:border-neutral-900">
              <Text className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {t("projects.defaultView")}
              </Text>
              <Segmented
                value={view}
                options={[
                  { value: "list", label: t("board.viewList"), icon: ListTodo },
                  { value: "board", label: t("board.viewBoard"), icon: Kanban },
                ]}
                onChange={setView}
                label={t("projects.defaultView")}
              />
            </View>
          )}
        </View>

        <View className="flex-row justify-end gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.cancel")}
            onPress={onClose}
            className="rounded-md px-3 py-2 web:cursor-pointer"
          >
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">
              {t("common.cancel")}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.create")}
            disabled={!trimmed}
            onPress={submit}
            accessibilityState={{ disabled: !trimmed }}
            className={
              "rounded-md px-4 py-2 " +
              (trimmed ? "bg-accent-600 web:cursor-pointer" : DISABLED_BUTTON_CLASS)
            }
          >
            <Text
              className={
                "text-sm font-semibold " + (trimmed ? "text-white" : DISABLED_BUTTON_TEXT_CLASS)
              }
            >
              {t("common.create")}
            </Text>
          </Pressable>
        </View>
      </SheetScrollView>
    </BottomSheet>
  );
}
