import { useEffect, useMemo, useState } from "react";
import { Keyboard, Platform, ScrollView, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_DUE_HOUR,
  DEFAULT_DUE_MINUTE,
  dayOffset,
  formatRule,
  isAllDayTask,
  makeFormatters,
  makeInstant,
  zonedParts,
} from "@atlastodo/shared";
import type { Priority } from "@atlastodo/client-core";
import type { DateTimePickerEvent } from "./DateTimePicker";
import type { ComposeDraft, ComposeValue } from "../lib/composeDraft";
import { ComposeSheet } from "./composeBar/ComposeSheet";
import { DueSheetBody, DueWebPanel } from "./composeBar/DuePanel";
import { LabelSheetBody, LabelWebPanel } from "./composeBar/LabelPanel";
import { ChipButton, type PanelKind } from "./composeBar/parts";
import { PrioritySheetBody, PriorityWebPanel } from "./composeBar/PriorityPanel";
import { ProjectSheetBody, ProjectWebPanel } from "./composeBar/ProjectPanel";
import { RecurrenceSheetBody, RecurrenceWebPanel } from "./composeBar/RecurrencePanel";
import { useSheetDismiss } from "./useSheetDismiss";
import { useWebPanelBehavior } from "./composeBar/useWebPanelBehavior";

/**
 * The row of chips under quick-add: set a task's due date, priority, project, labels and
 * recurrence while creating it. Each chip shows the field's effective value (`lib/composeDraft`).
 * Tapping opens the options in place on web, or in a bottom sheet with Cancel/Save on mobile.
 */

type Panel = PanelKind | null;

export interface TaskComposeBarProps {
  value: ComposeValue;
  onChange: (patch: ComposeDraft) => void;
  projects: { id: string; name: string }[];
  sections?: { id: string; project_id: string; name: string }[];
  labels: { id: string; name: string; color?: string }[];
  onCreateProject?: (name: string) => string;
  onCreateLabel?: (name: string, color?: string) => string;
  now: number;
  timeZone?: string;
  formatDue: (ms: number) => string;
  onClearDue?: () => void;
  /** Fired after every press in the bar, so quick-add can hand the caret back to the title field. */
  onInteract?: () => void;
}

export function TaskComposeBar({
  value,
  onChange,
  projects,
  sections = [],
  labels,
  onCreateProject,
  onCreateLabel,
  now,
  timeZone,
  formatDue,
  onClearDue,
  onInteract,
}: TaskComposeBarProps) {
  const { t } = useTranslation();
  const fmt = useMemo(() => makeFormatters({ timeZone }), [timeZone]);
  const summarizeRule = (rule: string) => formatRule(rule, (key, params) => t(key, params));
  const [panel, setPanel] = useState<Panel>(null);
  const [picking, setPicking] = useState(false);

  const [localProjects, setLocalProjects] = useState<{ id: string; name: string }[]>(projects);
  const [localLabels, setLocalLabels] =
    useState<{ id: string; name: string; color?: string }[]>(labels);
  const [newProjectName, setNewProjectName] = useState("");
  const [newLabelName, setNewLabelName] = useState("");

  useEffect(() => {
    setLocalProjects((prev) => (prev === projects ? prev : projects));
  }, [projects]);

  useEffect(() => {
    setLocalLabels((prev) => (prev === labels ? prev : labels));
  }, [labels]);

  // Mobile edits a draft in the sheet and applies it on Save; web applies each pick directly.
  const [draftDue, setDraftDue] = useState<number | null | undefined>(undefined);
  const [draftPriority, setDraftPriority] = useState<Priority | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null | undefined>(undefined);
  const [draftSectionId, setDraftSectionId] = useState<string | null | undefined>(undefined);
  const [draftLabelIds, setDraftLabelIds] = useState<string[]>([]);
  const [draftRecurrence, setDraftRecurrence] = useState<string | null | undefined>(undefined);

  const [projectStep, setProjectStep] = useState<string | null>(null);
  const [webProjectStep, setWebProjectStep] = useState<string | null>(null);

  const pick = (patch: ComposeDraft) => {
    onChange(patch);
    setPanel(null);
    setPicking(false);
    setProjectStep(null);
    setWebProjectStep(null);
    onInteract?.();
  };

  const close = () => {
    setPanel(null);
    setPicking(false);
    setProjectStep(null);
    setWebProjectStep(null);
    onInteract?.();
  };

  const open = (next: PanelKind) => {
    if (Platform.OS !== "web") {
      Keyboard.dismiss();
      if (next === "due") setDraftDue(value.due_at ?? null);
      if (next === "priority") setDraftPriority(value.priority ?? 4);
      if (next === "project") {
        setDraftProjectId(value.project_id);
        setDraftSectionId(value.section_id);
        setProjectStep(null);
      }
      if (next === "label") setDraftLabelIds([...value.label_ids]);
      if (next === "recurrence") setDraftRecurrence(value.recurrence ?? null);
      setPanel(next);
      onInteract?.();
    } else {
      if (next === "project") setWebProjectStep(null);
      // Web: focus follows the panel so Tab/arrows act on its options and Escape closes it.
      setPanel(next);
    }
  };

  const confirm = () => {
    if (panel === "due") {
      onChange({ due_at: draftDue });
    } else if (panel === "priority") {
      onChange({ priority: draftPriority ?? 4 });
    } else if (panel === "project") {
      onChange({ project_id: draftProjectId, section_id: draftSectionId });
    } else if (panel === "label") {
      onChange({ label_ids: draftLabelIds });
    } else if (panel === "recurrence") {
      onChange({ recurrence: draftRecurrence });
    }
    close();
  };

  const cancel = () => {
    close();
  };

  const panelRef = useWebPanelBehavior(panel, cancel);
  const sheet = useSheetDismiss(cancel, panel !== null);

  const onPickDate = (event: DateTimePickerEvent, date?: Date) => {
    setPicking(false);
    if (event.type === "set" && date) {
      const p = zonedParts(date.getTime(), timeZone);
      const ms = makeInstant(
        p.year,
        p.month,
        p.day,
        DEFAULT_DUE_HOUR,
        DEFAULT_DUE_MINUTE,
        0,
        timeZone,
      );
      if (Platform.OS === "web") pick({ due_at: ms });
      else setDraftDue(ms);
    }
  };

  const handleAddProject = () => {
    const name = newProjectName.trim();
    if (!name) return;
    if (Platform.OS !== "web") {
      Keyboard.dismiss();
    }
    // Only the store-backed creator may mint the id: an invented one would point at a project that does not exist.
    if (!onCreateProject) return;
    const id = onCreateProject(name);
    const newProj = { id, name };
    setLocalProjects((prev) => (prev.some((p) => p.id === id) ? prev : [newProj, ...prev]));
    pick({ project_id: id, section_id: null });
    setNewProjectName("");
  };

  const handleAddLabel = () => {
    const name = newLabelName.trim();
    if (!name) return;
    if (Platform.OS !== "web") {
      Keyboard.dismiss();
    }
    if (!onCreateLabel) return;
    const id = onCreateLabel(name);
    const newLbl = { id, name, color: "#6366f1" };
    setLocalLabels((prev) => (prev.some((l) => l.id === id) ? prev : [newLbl, ...prev]));
    if (Platform.OS === "web") {
      onChange({ label_ids: [...value.label_ids, id] });
    } else {
      setDraftLabelIds((prev) => (prev.includes(id) ? prev : [id, ...prev]));
    }
    setNewLabelName("");
  };

  const toggleLabelWeb = (id: string) => {
    onChange({
      label_ids: value.label_ids.includes(id)
        ? value.label_ids.filter((x) => x !== id)
        : [...value.label_ids, id],
    });
    onInteract?.();
  };

  const toggleLabelDraft = (id: string) =>
    setDraftLabelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const dueText = (ms: number): string => {
    const offset = dayOffset(ms, now, timeZone);
    const timeStr = isAllDayTask(ms, timeZone) ? "" : `, ${fmt.time(ms)}`;
    if (offset === 0) return `${t("task.scheduleToday")}${timeStr}`;
    if (offset === 1) return `${t("task.scheduleTomorrow")}${timeStr}`;
    return formatDue(ms);
  };

  const labelNames = [
    ...value.typedLabels,
    ...value.label_ids.map((id) => localLabels.find((l) => l.id === id)?.name).filter(Boolean),
  ];
  const projectName = localProjects.find((p) => p.id === value.project_id)?.name;
  const sectionName = sections.find((s) => s.id === value.section_id)?.name;
  const projectChipText = projectName
    ? sectionName
      ? `${projectName} / ${sectionName}`
      : projectName
    : value.project_id != null
      ? undefined
      : t("moveTo.inbox");

  const stepProject = localProjects.find((p) => p.id === projectStep);

  const panelTitle =
    panel === "due"
      ? t("taskDetail.dueDate")
      : panel === "priority"
        ? t("taskDetail.priority")
        : panel === "project"
          ? stepProject
            ? stepProject.name
            : t("taskDetail.project")
          : panel === "label"
            ? t("label.heading")
            : panel === "recurrence"
              ? t("recurrence.repeat")
              : "";

  const duePicker = { now, timeZone, picking, setPicking, onPickDate };

  if (Platform.OS === "web" && panel !== null) {
    return (
      <View
        ref={panelRef}
        {...({ tabIndex: -1 } as object)}
        accessibilityLabel={t("quickAdd.details")}
        className="w-full gap-2.5 pt-1 web:outline-none"
      >
        {panel === "due" && (
          <DueWebPanel {...duePicker} dueAt={value.due_at} pick={pick} onBack={close} />
        )}

        {panel === "priority" && (
          <PriorityWebPanel priority={value.priority} pick={pick} onBack={close} />
        )}

        {panel === "project" && (
          <ProjectWebPanel
            projects={localProjects}
            sections={sections}
            projectId={value.project_id}
            sectionId={value.section_id}
            step={webProjectStep}
            setStep={setWebProjectStep}
            pick={pick}
            canCreate={!!onCreateProject}
            newName={newProjectName}
            setNewName={setNewProjectName}
            onAdd={handleAddProject}
            onBack={close}
          />
        )}

        {panel === "label" && (
          <LabelWebPanel
            labels={localLabels}
            selectedIds={value.label_ids}
            onToggle={toggleLabelWeb}
            canCreate={!!onCreateLabel}
            newName={newLabelName}
            setNewName={setNewLabelName}
            onAdd={handleAddLabel}
            onClose={close}
          />
        )}

        {panel === "recurrence" && (
          <RecurrenceWebPanel
            recurrence={value.recurrence}
            onChange={(rule) => {
              onChange({ recurrence: rule });
              onInteract?.();
            }}
            onClose={close}
          />
        )}
      </View>
    );
  }

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        accessibilityLabel={t("quickAdd.details")}
        className="w-full"
        contentContainerClassName={
          Platform.OS === "web"
            ? "flex-row items-center gap-1.5 py-0.5 pr-2"
            : "flex-row items-center gap-2 py-1 pr-2"
        }
      >
        <ChipButton
          kind="due"
          field={t("taskDetail.dueDate")}
          value={value.due_at != null ? dueText(value.due_at) : null}
          onPress={() => open("due")}
          onRemove={value.due_at != null ? onClearDue : undefined}
          removeLabel={t("quickAdd.unlinkDate")}
        />
        <ChipButton
          kind="priority"
          field={t("taskDetail.priority")}
          value={value.priority != null && value.priority < 4 ? `P${value.priority}` : null}
          onPress={() => open("priority")}
        />
        <ChipButton
          kind="project"
          field={t("taskDetail.project")}
          value={projectChipText}
          onPress={() => open("project")}
        />
        <ChipButton
          kind="label"
          field={t("label.heading")}
          value={
            labelNames.length > 0
              ? labelNames.length > 1
                ? `${labelNames[0]} +${labelNames.length - 1}`
                : `${labelNames[0]}`
              : null
          }
          onPress={() => open("label")}
        />
        <ChipButton
          kind="recurrence"
          field={t("recurrence.repeat")}
          value={value.recurrence != null ? summarizeRule(value.recurrence) : null}
          onPress={() => open("recurrence")}
        />
      </ScrollView>

      {Platform.OS !== "web" && panel !== null && (
        <ComposeSheet
          title={panelTitle}
          onBack={
            panel === "project" && projectStep !== null ? () => setProjectStep(null) : undefined
          }
          onRequestClose={cancel}
          onSave={confirm}
          anim={sheet}
        >
          {panel === "due" && (
            <DueSheetBody
              {...duePicker}
              draftDue={draftDue}
              setDraftDue={setDraftDue}
              dueText={dueText}
            />
          )}

          {panel === "priority" && (
            <PrioritySheetBody draftPriority={draftPriority} setDraftPriority={setDraftPriority} />
          )}

          {panel === "project" && (
            <ProjectSheetBody
              projects={localProjects}
              sections={sections}
              projectId={draftProjectId}
              sectionId={draftSectionId}
              step={projectStep}
              onStepInto={(id) => {
                setDraftProjectId(id);
                setDraftSectionId(null);
                setProjectStep(id);
              }}
              pick={pick}
              canCreate={!!onCreateProject}
              newName={newProjectName}
              setNewName={setNewProjectName}
              onAdd={handleAddProject}
            />
          )}

          {panel === "label" && (
            <LabelSheetBody
              labels={localLabels}
              selectedIds={draftLabelIds}
              onToggle={toggleLabelDraft}
              canCreate={!!onCreateLabel}
              newName={newLabelName}
              setNewName={setNewLabelName}
              onAdd={handleAddLabel}
            />
          )}

          {panel === "recurrence" && (
            <RecurrenceSheetBody
              draftRecurrence={draftRecurrence}
              setDraftRecurrence={setDraftRecurrence}
              summarizeRule={summarizeRule}
            />
          )}
        </ComposeSheet>
      )}
    </>
  );
}
