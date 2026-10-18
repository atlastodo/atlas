import type { CreateTaskInput, Priority } from "@atlastodo/client-core";
import type { QuickAddResult } from "@atlastodo/shared";

/**
 * What quick-add's compose bar has been set to by hand, and how that combines with the screen's
 * defaults (Today pre-dates to end-of-today, a project screen pins its project) and what
 * `parseQuickAdd` read from the typed title.
 *
 * A key being present is what "pinned" means. Tapping a chip writes the field here, and until the
 * task is created it beats both the default and the text, so typing "#home" after choosing Work
 * does not move the task and "No date" (`due_at: null`) really clears the date. There is no
 * separate "touched" flag. Pure, so the precedence is testable without rendering an input.
 */

export interface ComposeDraft {
  due_at?: number | null;
  priority?: Priority;
  project_id?: string | null;
  section_id?: string | null;
  label_ids?: string[];
  recurrence?: string | null;
}

const unique = (ids: string[]): string[] => [...new Set(ids)];

/**
 * Fold a patch into the draft, where `undefined` unpins a field. A plain spread would leave the key
 * present, and an unpinned field would keep beating the default it should fall back to.
 */
export function mergeDraft(draft: ComposeDraft, patch: ComposeDraft): ComposeDraft {
  const next: ComposeDraft = { ...draft, ...patch };
  for (const key of Object.keys(patch) as (keyof ComposeDraft)[]) {
    if (patch[key] === undefined) delete next[key];
  }
  return next;
}

/**
 * The task to create: screen defaults, overridden by what was typed, overridden by what was tapped.
 * Labels union instead: a typed `@errand` and a tapped label both mean "also this one", and
 * `typedLabelIds` is the typed names resolved to ids at submit.
 */
export function composeInput(
  defaults: Partial<CreateTaskInput> | undefined,
  parsed: QuickAddResult,
  draft: ComposeDraft,
  typedLabelIds: string[] = [],
): CreateTaskInput {
  const label_ids = unique([...typedLabelIds, ...(draft.label_ids ?? [])]);
  return {
    ...defaults,
    ...parsed.input,
    ...draft,
    // A project chosen by hand drops the screen project's section unless one is set explicitly.
    ...(draft.project_id !== undefined && draft.section_id === undefined
      ? { section_id: null }
      : {}),
    ...(label_ids.length > 0 ? { label_ids } : {}),
  };
}

/** The effective value of each field, for the chips to display. */
export interface ComposeValue {
  due_at: number | null;
  /** P4 ("none") reads as unset, as it does everywhere else in the app. */
  priority: Priority | null;
  project_id: string | null;
  section_id: string | null;
  recurrence: string | null;
  /** Labels chosen from the picker -- the ones the bar can toggle back off. */
  label_ids: string[];
  /** Label names typed as `@name`; shown on the chip, removable only by editing the title. */
  typedLabels: string[];
}

/** What the chips should read, from the same three sources in the same order as {@link composeInput}. */
export function composeValue(
  defaults: Partial<CreateTaskInput> | undefined,
  parsed: QuickAddResult,
  draft: ComposeDraft,
): ComposeValue {
  const merged = { ...defaults, ...parsed.input, ...draft };
  const section_id =
    draft.section_id !== undefined
      ? draft.section_id
      : draft.project_id !== undefined && draft.project_id !== (defaults?.project_id ?? null)
        ? null
        : (defaults?.section_id ?? null);

  return {
    due_at: merged.due_at ?? null,
    priority: merged.priority != null && merged.priority < 4 ? merged.priority : null,
    project_id: merged.project_id ?? null,
    section_id,
    recurrence: merged.recurrence ?? null,
    label_ids: draft.label_ids ?? [],
    typedLabels: parsed.labels,
  };
}
