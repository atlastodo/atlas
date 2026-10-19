import type { Task } from "@atlastodo/client-core";

export interface ClipboardContext {
  originOf?: (task: Task) => { project?: string; section?: string } | undefined;
  formatDue?: (ms: number) => string;
  formatStart?: (ms: number) => string;
  formatRecurrence?: (rule: string) => string;
  labelsOf?: (task: Task) => string[];
  assigneeOf?: (task: Task) => string | undefined;
}

/**
 * Serialize selected tasks to a readable clipboard block: one `- {title} (metadata)` line per task,
 * description indented beneath. Metadata carries all user data (due, start, priority p1..p3,
 * recurrence, estimate, labels, assignee, project/section); id-based fields appear only when the
 * caller supplies a resolver. The single serialization source of truth.
 */
export function serializeTasksForClipboard(tasks: Task[], ctx: ClipboardContext = {}): string {
  return tasks.flatMap((task) => taskLines(task, ctx)).join("\n");
}

function taskLines(task: Task, ctx: ClipboardContext): string[] {
  const lines = [`- ${task.title}${metaSuffix(task, ctx)}`];
  const notes = task.notes?.trim();
  if (notes) for (const line of notes.split("\n")) lines.push(`  ${line}`);
  return lines;
}

function metaSuffix(task: Task, ctx: ClipboardContext): string {
  const parts: string[] = [];
  if (task.due_at != null) {
    parts.push(`due ${ctx.formatDue ? ctx.formatDue(task.due_at) : isoDate(task.due_at)}`);
  }
  if (task.start_at != null) {
    const fmt = ctx.formatStart ?? ctx.formatDue ?? isoDate;
    parts.push(`start ${fmt(task.start_at)}`);
  }
  if (task.priority < 4) parts.push(`p${task.priority}`);
  if (task.recurrence) {
    parts.push(ctx.formatRecurrence ? ctx.formatRecurrence(task.recurrence) : task.recurrence);
  }
  if (task.estimate_min != null) parts.push(`~${task.estimate_min}m`);
  const labels = ctx.labelsOf?.(task) ?? [];
  for (const label of labels) parts.push(`@${label}`);
  const assignee = ctx.assigneeOf?.(task);
  if (assignee) parts.push(`assigned ${assignee}`);
  const origin = ctx.originOf?.(task);
  if (origin) {
    if (origin.project && origin.section) parts.push(`#${origin.project}/${origin.section}`);
    else if (origin.project) parts.push(`#${origin.project}`);
    else if (origin.section) parts.push(`#${origin.section}`);
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
