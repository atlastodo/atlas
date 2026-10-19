import { isProjectShared, type LocalStore } from "@atlastodo/client-core";
import type { BundleEntity, ExportBundle } from "./dataTransfer";
import { derivedUuidV1, derivedUuidV2 } from "./ids";
import { DEFAULT_PROJECT_ICON, defaultColorForIndex } from "./projectStyle";
import { anchorMonthDay, parseRule, ruleToString } from "./recurrence";
import { endOfDay, isValidTimeZone, startOfDay } from "./zonedTime";

/**
 * TickTick CSV import: a pure CSV-to-`ExportBundle` converter, merged by `importBundle`.
 *
 * Entity ids are derived from the importing user and the TickTick ids, so a re-import updates
 * instead of duplicating (and overwrites later edits). The user is in the seed because TickTick
 * ids and list names are unique only per account: otherwise a private import could land in
 * someone else's shared project with the same list name.
 */

const PRIORITY_BY_TICKTICK: Record<string, number> = { "0": 4, "1": 3, "3": 2, "5": 1 };

export type TicktickKind = "project" | "section" | "label" | "task";

export interface TicktickImportOptions {
  userId: string;
  // Whether the legacy id ({@link ticktickUuid}) may be kept, so re-importing an older import stays idempotent.
  reuseLegacyId?: (kind: TicktickKind, id: string) => boolean;
  timeZone?: string;
  now?: number;
}

export interface TicktickImportCounts {
  projects: number;
  sections: number;
  labels: number;
  tasks: number;
  notes: number;
  subtasks: number;
  completed: number;
  abandoned: number;
}

// A code, not a sentence: the app owns the copy (i18n).
export type TicktickWarningCode =
  "folder" | "noTaskId" | "missingParent" | "repeat" | "reminders" | "checklist" | "timezone";

export interface TicktickWarning {
  code: TicktickWarningCode;
  detail?: string;
}

export interface TicktickImportResult {
  bundle: ExportBundle;
  counts: TicktickImportCounts;
  warnings: TicktickWarning[];
}

// RFC 4180: a quoted cell may span lines (TickTick's `Content` column). A leading BOM is stripped.
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c !== '"') {
        field += c;
      } else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// The pre-user id scheme, kept so a re-import recognises earlier imports; new ids use {@link ticktickUuidV2}.
export function ticktickUuid(kind: string, key: string): string {
  return derivedUuidV1(`ticktick:${kind}`, key);
}

export function ticktickUuidV2(userId: string, kind: string, key: string): string {
  return derivedUuidV2(`ticktick:v2:${userId}:${kind}`, key);
}

// Keep a legacy id only for this user's own entities: in a shared project it may be another member's import.
export function ticktickLegacyIdReusable(
  store: Pick<LocalStore, "get" | "list">,
): (kind: TicktickKind, id: string) => boolean {
  const privateProject = (projectId: unknown) =>
    typeof projectId === "string" &&
    store.get("project", projectId) !== null &&
    !isProjectShared(store, projectId);
  return (kind, id) => {
    const fields = store.get(kind, id);
    if (fields === null) return false;
    switch (kind) {
      case "project":
        return privateProject(id);
      case "section":
        return privateProject(fields.project_id);
      case "task":
        return fields.project_id == null || privateProject(fields.project_id);
      case "label":
        return true;
    }
  };
}

const MAX_DATE_MS = 8.64e15;

// Hand-rolled because `Date.parse` is engine-dependent for the compact `+0000` offset.
function parseTicktickDate(raw: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      raw.trim(),
    );
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(
    Number,
  ) as [number, number, number, number, number, number];
  const zone = m[7];
  // `Date.UTC` would roll Feb 30 into March; drop nonexistent dates instead.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const [oh, om] = [Number(digits.slice(0, 2)), Number(digits.slice(2))];
    if (oh > 14 || om > 59) return null;
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  return Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

export function ticktickToBundle(
  text: string,
  options: TicktickImportOptions,
): TicktickImportResult {
  const fallbackZone = options.timeZone || undefined;
  const now = options.now ?? Date.now();
  const ids = new Map<string, string>();
  const idFor = (kind: TicktickKind, key: string): string => {
    const memo = `${kind}\u0000${key}`;
    let id = ids.get(memo);
    if (id === undefined) {
      const legacy = ticktickUuid(kind, key);
      id = options.reuseLegacyId?.(kind, legacy)
        ? legacy
        : ticktickUuidV2(options.userId, kind, key);
      ids.set(memo, id);
    }
    return id;
  };

  const rows = parseCsvRows(text);
  // TickTick prefixes a few metadata lines, so the header is the first row that looks like one.
  const headerIndex = rows.findIndex((r) => r.includes("Title") && r.includes("List Name"));
  if (headerIndex === -1) throw new Error("not-ticktick-csv");
  const header = rows[headerIndex]!.map((h) => h.trim());
  const records = rows.slice(headerIndex + 1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((name, i) => {
      rec[name] = (cells[i] ?? "").trim();
    });
    return rec;
  });

  const warnings: TicktickWarning[] = [];
  const seenWarnings = new Set<string>();
  const warn = (code: TicktickWarningCode, detail?: string) => {
    const key = `${code}:${detail ?? ""}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(detail == null ? { code } : { code, detail });
  };

  const projects = new Map<string, BundleEntity>();
  const sections = new Map<string, BundleEntity>();
  const labels = new Map<string, BundleEntity>();
  const sectionOrder = new Map<string, number>();
  const tasks: { entity: BundleEntity; bucket: string; order: number; index: number }[] = [];
  const counts: TicktickImportCounts = {
    projects: 0,
    sections: 0,
    labels: 0,
    tasks: 0,
    notes: 0,
    subtasks: 0,
    completed: 0,
    abandoned: 0,
  };

  const known = new Set(records.map((r) => r.taskId).filter(Boolean));

  records.forEach((rec, index) => {
    const sourceId = rec.taskId ?? "";
    if (!sourceId) {
      warn("noTaskId");
      return;
    }

    // Project (a TickTick list); the Inbox list is Atlas's project-less Inbox.
    const listName = rec["List Name"] ?? "";
    const folderName = rec["Folder Name"] ?? "";
    if (folderName) warn("folder", folderName);
    const isInbox = listName === "" || listName.toLowerCase() === "inbox";
    const listKey = folderName ? `${folderName}/${listName}` : listName;
    let projectId: string | undefined;
    if (!isInbox) {
      projectId = idFor("project", listKey);
      if (!projects.has(projectId)) {
        projects.set(projectId, {
          id: projectId,
          fields: {
            name: listName,
            kind: "project",
            icon: DEFAULT_PROJECT_ICON,
            color: defaultColorForIndex(projects.size),
            sort_order: projects.size,
          },
        });
      }
    }

    // Section (a TickTick kanban column).
    const columnName = rec["Column Name"] ?? "";
    let sectionId: string | undefined;
    if (projectId && columnName) {
      sectionId = idFor("section", `${listKey}\u0000${columnName}`);
      if (!sections.has(sectionId)) {
        sections.set(sectionId, {
          id: sectionId,
          fields: { project_id: projectId, name: columnName, sort_order: 0 },
        });
        sectionOrder.set(sectionId, Number(rec["Column Order"] ?? "") || 0);
      }
    }

    // Labels (TickTick tags).
    const labelIds = (rec.Tags ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => {
        const id = idFor("label", tag.toLowerCase());
        if (!labels.has(id)) {
          labels.set(id, {
            id,
            fields: { name: tag, color: defaultColorForIndex(labels.size) },
          });
        }
        return id;
      });

    // The task itself.
    const content = rec.Content ?? "";
    const isNote = (rec.Kind ?? "").toUpperCase() === "NOTE";
    const title = rec.Title || content.split("\n")[0]?.trim() || "Untitled";
    const created = parseTicktickDate(rec["Created Time"] ?? "") ?? now;
    const completedAt = parseTicktickDate(rec["Completed Time"] ?? "");
    const status = rec.Status ?? "0";
    let zone = rec.Timezone || fallbackZone;
    if (rec.Timezone && !isValidTimeZone(rec.Timezone)) {
      warn("timezone", rec.Timezone);
      zone = fallbackZone;
    }
    const allDay = (rec["Is All Day"] ?? "").toLowerCase() === "true";

    const fields: Record<string, unknown> = {};
    if (projectId) fields.project_id = projectId;
    if (sectionId) fields.section_id = sectionId;

    const parentSource = rec.parentId ?? "";
    if (parentSource) {
      if (known.has(parentSource)) {
        fields.parent_id = idFor("task", parentSource);
        counts.subtasks++;
      } else {
        warn("missingParent");
      }
    }

    fields.title = title;
    if (content) fields.notes = content;
    fields.priority = PRIORITY_BY_TICKTICK[rec.Priority ?? ""] ?? 4;

    // Status 0 normal, 2 completed, -1 abandoned (archived, as it has no Atlas equivalent).
    fields.is_completed = status === "2";
    if (status === "2") {
      fields.completed_at = completedAt ?? created;
      counts.completed++;
    } else if (status === "-1") {
      fields.archived_at = completedAt ?? created;
      counts.abandoned++;
    }

    const due = parseTicktickDate(rec["Due Date"] ?? "");
    const dueAt = due == null ? null : allDay ? endOfDay(due, zone) : due;
    if (dueAt != null) fields.due_at = dueAt;
    const start = parseTicktickDate(rec["Start Date"] ?? "");
    if (start != null) fields.start_at = allDay ? startOfDay(start, zone) : start;

    const repeat = (rec.Repeat ?? "").replace(/^RRULE:/i, "").trim();
    if (repeat) {
      const rule = parseRule(repeat);
      if (!rule) warn("repeat", repeat);
      else if (dueAt == null) fields.recurrence = ruleToString(rule);
      // A monthly rule falls on the due date's day, as one set in the app does.
      else fields.recurrence = anchorMonthDay(ruleToString(rule), dueAt, zone);
    }
    if (rec.Reminder) warn("reminders");
    if ((rec["Is Check list"] ?? "").toUpperCase() === "Y") warn("checklist");

    if (labelIds.length > 0) fields.label_ids = labelIds;
    fields.created_at = created;
    fields.updated_at = created;

    counts.tasks++;
    if (isNote) counts.notes++;
    tasks.push({
      entity: { id: idFor("task", sourceId), fields },
      bucket: `${projectId ?? ""}|${sectionId ?? ""}`,
      order: Number(rec.Order ?? "") || 0,
      index,
    });
  });

  // TickTick's `Order` is a sparse signed integer; rank each bucket 0..n-1 (ties by file order).
  const buckets = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const list = buckets.get(task.bucket) ?? [];
    list.push(task);
    buckets.set(task.bucket, list);
  }
  for (const list of buckets.values()) {
    list
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .forEach((task, rank) => {
        task.entity.fields.sort_order = rank;
      });
  }

  // Sections rank per project by the kanban column's own order.
  const byProject = new Map<string, BundleEntity[]>();
  for (const section of sections.values()) {
    const key = String(section.fields.project_id);
    const list = byProject.get(key) ?? [];
    list.push(section);
    byProject.set(key, list);
  }
  for (const list of byProject.values()) {
    list
      .sort((a, b) => (sectionOrder.get(a.id) ?? 0) - (sectionOrder.get(b.id) ?? 0))
      .forEach((section, rank) => {
        section.fields.sort_order = rank;
      });
  }

  counts.projects = projects.size;
  counts.sections = sections.size;
  counts.labels = labels.size;

  // Containers before their contents, so the server can resolve each task's project for fan-out.
  const entities: Record<string, BundleEntity[]> = {};
  if (projects.size > 0) entities.project = [...projects.values()];
  if (sections.size > 0) entities.section = [...sections.values()];
  if (labels.size > 0) entities.label = [...labels.values()];
  if (tasks.length > 0) entities.task = tasks.map((t) => t.entity);

  return {
    bundle: { app: "atlas-todo", version: 1, exportedAt: now, entities },
    counts,
    warnings,
  };
}
