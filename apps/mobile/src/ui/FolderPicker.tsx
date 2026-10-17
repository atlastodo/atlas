import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Project } from "@atlastodo/client-core";
import { DEFAULT_FOLDER_ICON, flattenProjectTree, resolveProjectColor } from "@atlastodo/shared";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { projectIconFor } from "./projectIcons";
import { Check, Folder } from "./icons";
import { haptics } from "../lib/haptics";

/**
 * Choose the folder a project (or another folder) lives in: "No folder" plus the indented folder
 * tree, current one ticked. Not a mode on `MoveToPicker`, whose two-step flow and Inbox row are
 * task concepts. `disabledIds` are not listed, so a folder is never offered its own subtree; that
 * is an affordance, not the enforcement (`useProjects.setProjectParent` runs the cycle guard,
 * since the sync path bypasses the server's parent check).
 */
export function FolderPicker({
  visible,
  folders,
  currentParentId,
  disabledIds,
  onPick,
  onClose,
}: {
  visible: boolean;
  folders: Project[];
  currentParentId: string | null;
  disabledIds?: ReadonlySet<string>;
  onPick: (parentId: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rows = flattenProjectTree(folders).filter((r) => !disabledIds?.has(r.project.id));

  const choose = (parentId: string | null) => {
    haptics.selection();
    onPick(parentId);
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="max-h-[70%]">
        <Text className="pb-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">
          {t("projects.moveToFolder")}
        </Text>
        <SheetScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("projects.noFolder")}
            onPress={() => choose(null)}
            className="flex-row items-center gap-3 py-3 web:cursor-pointer"
          >
            <Folder size={18} className="text-neutral-500" />
            <Text className="flex-1 text-sm text-neutral-900 dark:text-neutral-100">
              {t("projects.noFolder")}
            </Text>
            {currentParentId === null && <Check size={16} className="text-accent-600" />}
          </Pressable>
          {rows.map(({ project, depth }) => {
            const Icon = projectIconFor(project.icon || DEFAULT_FOLDER_ICON);
            return (
              <Pressable
                key={project.id}
                accessibilityRole="button"
                // Action-phrased: the list behind this sheet carries the same folder name.
                accessibilityLabel={t("projects.moveTo", { name: project.name })}
                onPress={() => choose(project.id)}
                className="flex-row items-center gap-3 py-3 web:cursor-pointer"
              >
                <View style={{ width: depth * 16 }} />
                <Icon size={18} color={resolveProjectColor(project)} />
                <Text className="flex-1 text-sm text-neutral-900 dark:text-neutral-100">
                  {project.name}
                </Text>
                {currentParentId === project.id && <Check size={16} className="text-accent-600" />}
              </Pressable>
            );
          })}
        </SheetScrollView>
      </View>
    </BottomSheet>
  );
}
