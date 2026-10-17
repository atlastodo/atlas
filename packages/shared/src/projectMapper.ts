import type { Project, ProjectKind, ProjectView } from "@atlastodo/client-core";

/**
 * Map a store entity to a typed {@link Project} and build the fields written on creation, like
 * `taskMapper.ts`.
 */

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

export function toProject(id: string, fields: Record<string, unknown>): Project {
  const kind: ProjectKind = fields.kind === "folder" ? "folder" : "project";
  return {
    id,
    owner_id: str(fields.owner_id),
    name: str(fields.name),
    color: str(fields.color),
    icon: str(fields.icon),
    sort_order: num(fields.sort_order, 0),
    // Not the sidebar pin: that is per-user and lives on the private `preference` entity
    // (`project_pinned`), since a project op fans out to every member and one member's unpin would
    // hide it for all. This is the server's own flag; nothing reads it yet.
    is_favorite: fields.is_favorite === true,
    parent_id: typeof fields.parent_id === "string" ? fields.parent_id : null,
    kind,
    default_view: fields.default_view === "board" ? "board" : "list",
    archived_at: typeof fields.archived_at === "number" ? fields.archived_at : null,
    deleted_at: typeof fields.deleted_at === "number" ? fields.deleted_at : null,
  };
}

/**
 * The fields written when creating a project or folder. `parent_id` is always written, even null,
 * so a later move is a plain update.
 */
export function projectCreateFields(input: {
  name: string;
  color?: string;
  icon?: string;
  sort_order?: number;
  kind?: ProjectKind;
  parent_id?: string | null;
  default_view?: ProjectView;
}): Record<string, unknown> {
  return {
    // Only when chosen: an unset view reads as "list".
    ...(input.default_view ? { default_view: input.default_view } : {}),
    name: input.name,
    color: input.color ?? "",
    icon: input.icon ?? "",
    kind: input.kind ?? "project",
    parent_id: input.parent_id ?? null,
    sort_order: input.sort_order ?? 0,
  };
}
