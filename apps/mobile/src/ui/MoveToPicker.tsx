import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Project, Section } from "@atlastodo/client-core";
import { DEFAULT_FOLDER_ICON, flattenProjectTree, resolveProjectColor } from "@atlastodo/shared";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { Check, ChevronLeft, ChevronRight, Inbox, X } from "./icons";
import { projectIconFor } from "./projectIcons";

/**
 * "Move to": pick a target project, then a section within it (or "No section"). Choosing the Inbox
 * or a project with no sections resolves immediately. Used for bulk and single-task moves; the
 * caller supplies the target via {@link onPick} and does the write.
 */

export type MoveTarget = { project_id: string | null; section_id: string | null };

export interface MoveToPickerProps {
  title: string | null;
  projects: Project[];
  sections: Section[];
  currentProjectId?: string | null;
  currentSectionId?: string | null;
  /** "task" (default): project then section. "section": project only (moving a whole section, so no Inbox or section step). */
  mode?: "task" | "section";
  excludeProjectId?: string;
  onPick: (target: MoveTarget) => void;
  onClose: () => void;
}

export function MoveToPicker({
  title,
  projects,
  sections,
  currentProjectId,
  currentSectionId,
  mode = "task",
  excludeProjectId,
  onPick,
  onClose,
}: MoveToPickerProps) {
  const { t } = useTranslation();
  const open = title !== null;
  const [step, setStep] = useState<{ projectId: string | null } | null>(null);
  const projectList = projects.filter((p) => p.id !== excludeProjectId);
  const flatTree = flattenProjectTree(projectList);

  useEffect(() => {
    if (open) setStep(null);
  }, [open]);

  const chooseProject = (projectId: string | null) => {
    if (projectId === null) {
      onPick({ project_id: null, section_id: null });
      return;
    }
    if (mode === "section") {
      onPick({ project_id: projectId, section_id: null });
      return;
    }
    const pSections = sections
      .filter((s) => s.project_id === projectId && s.deleted_at == null && s.archived_at == null)
      .sort((a, b) => a.sort_order - b.sort_order);
    if (pSections.length === 0) {
      onPick({ project_id: projectId, section_id: null });
      return;
    }
    setStep({ projectId });
  };

  const projectSections =
    step && step.projectId !== null
      ? sections
          .filter(
            (s) => s.project_id === step.projectId && s.deleted_at == null && s.archived_at == null,
          )
          .sort((a, b) => a.sort_order - b.sort_order)
      : [];
  const stepProject = step ? projects.find((p) => p.id === step.projectId) : undefined;

  return (
    <BottomSheet visible={open} onClose={onClose}>
      <View className="gap-1">
        <View className="mb-2 flex-row items-center gap-2">
          {step && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.back")}
              onPress={() => setStep(null)}
            >
              <ChevronLeft size={20} className="text-neutral-500" />
            </Pressable>
          )}
          {stepProject &&
            (() => {
              const StepIcon = projectIconFor(stepProject.icon);
              const stepColor = resolveProjectColor(stepProject);
              return <StepIcon size={18} color={stepColor} />;
            })()}
          <Text
            numberOfLines={1}
            className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100"
          >
            {step ? (stepProject?.name ?? t("moveTo.title")) : t("moveTo.title")}
            {!step && title ? `: ${title}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={onClose}
          >
            <X size={20} className="text-neutral-500" />
          </Pressable>
        </View>

        <SheetScrollView className="max-h-96">
          {!step && (
            <>
              {mode === "task" && (
                <Row
                  icon={<Inbox size={16} className="text-neutral-500" />}
                  label={t("moveTo.inbox")}
                  selected={currentProjectId == null}
                  onPress={() => chooseProject(null)}
                />
              )}
              {flatTree.map(({ project: p, depth }) => {
                if (p.kind === "folder") {
                  const FolderIcon = projectIconFor(p.icon || DEFAULT_FOLDER_ICON);
                  const folderColor = resolveProjectColor(p);
                  return (
                    <Row
                      key={p.id}
                      icon={<FolderIcon size={16} color={folderColor} />}
                      label={p.name}
                      depth={depth}
                      disabled
                      selected={false}
                    />
                  );
                }
                const Icon = projectIconFor(p.icon);
                const color = resolveProjectColor(p);
                return (
                  <Row
                    key={p.id}
                    icon={<Icon size={16} color={color} />}
                    label={p.name}
                    depth={depth}
                    selected={
                      mode === "task" && currentProjectId === p.id && currentSectionId == null
                    }
                    chevron={mode === "task"}
                    onPress={() => chooseProject(p.id)}
                  />
                );
              })}
            </>
          )}

          {step && (
            <>
              <Row
                label={t("moveTo.noSection")}
                selected={currentProjectId === step.projectId && currentSectionId == null}
                onPress={() => onPick({ project_id: step.projectId, section_id: null })}
              />
              {projectSections.map((s) => (
                <Row
                  key={s.id}
                  label={s.name}
                  selected={currentSectionId === s.id}
                  onPress={() => onPick({ project_id: step.projectId, section_id: s.id })}
                />
              ))}
            </>
          )}
        </SheetScrollView>
      </View>
    </BottomSheet>
  );
}

function Row({
  icon,
  label,
  selected,
  chevron = false,
  depth = 0,
  disabled = false,
  onPress,
}: {
  icon?: React.ReactNode;
  label: string;
  selected: boolean;
  chevron?: boolean;
  depth?: number;
  disabled?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={disabled ? "header" : "button"}
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className={`flex-row items-center gap-3 rounded-md px-2 py-3 ${disabled ? "opacity-75" : "active:bg-neutral-100 dark:active:bg-neutral-800 web:cursor-pointer"}`}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {icon}
      <Text
        className={`flex-1 text-sm ${disabled ? "font-medium text-neutral-500 dark:text-neutral-400" : "text-neutral-900 dark:text-neutral-100"}`}
      >
        {label}
      </Text>
      {selected && <Check size={16} className="text-accent-600" />}
      {chevron && !selected && !disabled && <ChevronRight size={16} className="text-neutral-500" />}
    </Pressable>
  );
}
