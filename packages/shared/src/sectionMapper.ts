import type { Section } from "@atlastodo/client-core";

/**
 * Map a generic local-store entity to a typed {@link Section} (a Kanban column within a project),
 * and build the fields to write when creating one. Mirrors `taskMapper.ts` / `projectMapper.ts`.
 */

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

export function toSection(id: string, fields: Record<string, unknown>): Section {
  return {
    id,
    project_id: str(fields.project_id),
    name: str(fields.name),
    sort_order: num(fields.sort_order, 0),
    deleted_at: typeof fields.deleted_at === "number" ? fields.deleted_at : null,
    archived_at: typeof fields.archived_at === "number" ? fields.archived_at : null,
  };
}

/** The fields to write when creating a section locally. */
export function sectionCreateFields(input: {
  project_id: string;
  name: string;
  sort_order?: number;
}): Record<string, unknown> {
  return {
    project_id: input.project_id,
    name: input.name,
    sort_order: input.sort_order ?? 0,
  };
}
