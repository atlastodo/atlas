import { KEY_TRUST_ID, type EntityKind, type LocalStore } from "@atlastodo/client-core";

// Excludes `project_member` (the server rejects client pushes) and `activity` (a read-only audit log).
export const PORTABLE_KINDS: EntityKind[] = [
  "task",
  "project",
  "section",
  "label",
  "comment",
  "preference",
  "saved_filter",
  "reminder",
  "focus_session",
  "habit",
  "habit_checkin",
];

export interface BundleEntity {
  id: string;
  fields: Record<string, unknown>;
}

export interface ExportBundle {
  app: "atlas-todo";
  version: 1;
  exportedAt: number;
  entities: Record<string, BundleEntity[]>;
}

// The server stores ids canonical, so any other form would be refused on push or come back as a different entity.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Key trust records are never exported or imported: a file must not add to the account's own trust decisions.
function isKeyTrust(kind: string, id: string): boolean {
  return kind === "preference" && id === KEY_TRUST_ID;
}

export function exportData(store: LocalStore, now: number = Date.now()): ExportBundle {
  const entities: Record<string, BundleEntity[]> = {};
  for (const kind of PORTABLE_KINDS) {
    const rows = store
      .list(kind)
      .filter((e) => !isKeyTrust(kind, e.id))
      .map((e) => ({ id: e.id, fields: e.fields }));
    if (rows.length > 0) entities[kind] = rows;
  }
  return { app: "atlas-todo", version: 1, exportedAt: now, entities };
}

export function serializeBundle(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function bundleFilename(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `atlas-todo-export-${y}-${m}-${day}.json`;
}

export function parseBundle(text: string): ExportBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid-json");
  }
  if (!raw || typeof raw !== "object") throw new Error("invalid-bundle");
  const b = raw as Record<string, unknown>;
  if (b.app !== "atlas-todo") throw new Error("not-atlas-bundle");
  if (b.version !== 1) throw new Error("unsupported-version");
  if (!b.entities || typeof b.entities !== "object") throw new Error("invalid-bundle");
  return raw as ExportBundle;
}

// Each field is re-set with a fresh HLC, so imports win on conflict and nothing is deleted.
export function importBundle(
  store: LocalStore,
  kick: () => void,
  bundle: ExportBundle,
): { count: number } {
  const portable = new Set<string>(PORTABLE_KINDS);
  let count = 0;
  for (const [kind, rows] of Object.entries(bundle.entities)) {
    if (!portable.has(kind)) continue;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const { id, fields } = row as BundleEntity;
      if (typeof id !== "string" || !UUID_RE.test(id)) continue;
      if (!fields || typeof fields !== "object") continue;
      if (isKeyTrust(kind, id)) continue;
      for (const [field, value] of Object.entries(fields)) {
        store.set(kind as EntityKind, id, field, value);
      }
      count++;
    }
  }
  if (count > 0) kick();
  return { count };
}
