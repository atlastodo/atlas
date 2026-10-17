import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { formatRule, serializeTasksForClipboard, type ClipboardContext } from "@atlastodo/shared";
import { useToast } from "../data/ToastProvider";
import { useLabels } from "./useLabels";
import { useProjects } from "./useProjects";
import { useAllSections } from "./useAllSections";
import { useProjectMembers } from "./useProjectMembers";
import { useFormat } from "./useFormat";
import { copyText } from "../lib/clipboard";

/**
 * Copy tasks to the clipboard as the shared human-readable block, with every resolver the serializer
 * supports filled in. The serialization is `@atlastodo/shared`'s `serializeTasksForClipboard`; the
 * {@link ClipboardContext} is built once here so the same task copied from two screens gives the
 * same text, and a new copy surface inherits the full set.
 *
 * Id-based fields (labels, assignee) are resolved to names, since raw ids are meaningless once
 * pasted. `formatStart` is absent because the serializer falls back to `formatDue`.
 */
export interface TaskClipboard {
  /** Serialize, copy, and show the "Copied N tasks" toast. A no-op for an empty selection. */
  copyTasks: (tasks: Task[]) => Promise<void>;
}

export function useTaskClipboard(): TaskClipboard {
  const { t } = useTranslation();
  const toast = useToast();
  const format = useFormat();
  const { byId: labelById } = useLabels();
  const { projects } = useProjects();
  const allSections = useAllSections();
  const { byUserId } = useProjectMembers();

  const originOf = useCallback(
    (task: Task) => ({
      project: task.project_id ? projects.find((p) => p.id === task.project_id)?.name : undefined,
      section: task.section_id ? allSections.byId(task.section_id)?.name : undefined,
    }),
    [projects, allSections],
  );

  const labelsOf = useCallback(
    (task: Task) =>
      task.label_ids.flatMap((id) => {
        const name = labelById(id)?.name;
        return name ? [name] : [];
      }),
    [labelById],
  );

  // A plain display name, unlike the row's `assigneeOf`, which builds an avatar (initials + colour).
  const assigneeOf = useCallback(
    (task: Task) => {
      if (!task.assignee_id) return undefined;
      const member = byUserId(task.assignee_id);
      return member ? member.display_name || member.email : undefined;
    },
    [byUserId],
  );

  const copyTasks = useCallback(
    async (all: Task[]) => {
      // A locked task's title and fields are placeholders: it would paste as a blank line.
      const tasks = all.filter((task) => !task.locked);
      if (tasks.length === 0) return;
      const context: ClipboardContext = {
        originOf,
        labelsOf,
        assigneeOf,
        formatDue: format.dueChip,
        // Fall back to the raw rule string on the shapes `formatRule` cannot summarise.
        formatRecurrence: (rule) => formatRule(rule, (key, params) => t(key, params)) ?? rule,
      };
      const ok = await copyText(serializeTasksForClipboard(tasks, context));
      if (ok) toast.show(t("toast.copied", { count: tasks.length }));
    },
    [originOf, labelsOf, assigneeOf, format.dueChip, toast, t],
  );

  return { copyTasks };
}
