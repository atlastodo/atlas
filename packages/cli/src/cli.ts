import { parseArgs } from "node:util";
import {
  AtlasClient,
  AtlasError,
  InvalidApiTokenError,
  parseDue,
  type ConnectOptions,
  type CreateTaskOptions,
  type TaskPatch,
  type TaskQuery,
  type TaskStatus,
} from "@atlas/sdk";
import pkg from "../package.json" with { type: "json" };

export const USAGE = `atlas ${pkg.version} - Atlas Todo from the command line, for scripts and n8n.

Configuration (environment):
  ATLAS_URL     the server, e.g. https://app.atlastodo.dev (or --url)
  ATLAS_TOKEN   an API token from Settings > API tokens (environment only, never a flag)
  ATLAS_TZ      time zone for dates, e.g. Europe/Copenhagen (default: the system's)

Commands (all print JSON):
  projects list
  labels list
  tasks list [--project P] [--status open|completed|all] [--label L] [--search TEXT]
             [--due-before DATE] [--due-after DATE] [--filter "today & p1"]
  tasks get ID
  tasks add --title TEXT [--notes TEXT] [--due DATE] [--priority 1-4] [--project P]
            [--label L]... [--recurrence RRULE] [--json OBJECT]
  tasks quick "Pay rent tomorrow #Home p1 @bills"
  tasks update ID [same fields as add] [--json OBJECT]
  tasks complete ID
  tasks reopen ID
  tasks delete ID
  changes [--since CURSOR]   tasks created, updated, completed and deleted after CURSOR;
                             without one, only the current cursor to start from

DATE is YYYY-MM-DD, YYYY-MM-DDTHH:MM (in ATLAS_TZ), ISO 8601 with an offset, unix ms, today,
tomorrow, or none. P and L are names or ids. --json takes the fields as one JSON object
(title, notes, due, priority, project, labels, recurrence), handy when templating from n8n.

Errors go to stderr as {"error": ..., "code": ...} with exit code 1 (2 for usage errors).`;

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** For tests: a stand-in for `AtlasClient.connect`. */
  connect?: (opts: ConnectOptions) => Promise<AtlasClient>;
}

class UsageError extends Error {}

const OPTIONS = {
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  project: { type: "string" },
  status: { type: "string" },
  label: { type: "string", multiple: true },
  search: { type: "string" },
  filter: { type: "string" },
  "due-before": { type: "string" },
  "due-after": { type: "string" },
  title: { type: "string" },
  notes: { type: "string" },
  due: { type: "string" },
  priority: { type: "string" },
  recurrence: { type: "string" },
  json: { type: "string" },
  since: { type: "string" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

/** Run one command; resolves the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    return usage(io, err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(pkg.version);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(USAGE);
    return values.help ? 0 : 2;
  }

  const serverUrl = values.url ?? io.env.ATLAS_URL;
  const token = io.env.ATLAS_TOKEN;
  if (!serverUrl) return usage(io, "set ATLAS_URL (or pass --url)");
  if (!token) return usage(io, "set ATLAS_TOKEN to an API token");
  const timeZone = io.env.ATLAS_TZ || undefined;

  let client: AtlasClient | null = null;
  try {
    const command = positionals.slice(0, 2).join(" ");
    const target = positionals[2];
    // Check the command before connecting: a typo should not cost a full sync.
    if (!COMMANDS.has(command)) throw new UsageError(`unknown command "${positionals.join(" ")}"`);
    if (NEEDS_ID.has(command) && !target) throw new UsageError(`"${command}" needs a task id`);
    if (command === "tasks quick" && !target) throw new UsageError(`"tasks quick" needs the text`);
    const connect = io.connect ?? ((o: ConnectOptions) => AtlasClient.connect(o));
    const atlas = await connect({ serverUrl, token, timeZone });
    client = atlas;
    const result = await dispatch(atlas, command, target, values, timeZone);
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) return usage(io, err.message);
    io.stderr(JSON.stringify(describe(err)));
    return 1;
  } finally {
    client?.close();
  }
}

const NEEDS_ID = new Set([
  "tasks get",
  "tasks update",
  "tasks complete",
  "tasks reopen",
  "tasks delete",
]);
const COMMANDS = new Set([
  "projects list",
  "labels list",
  "tasks list",
  "tasks add",
  "tasks quick",
  "changes",
  ...NEEDS_ID,
]);

async function dispatch(
  atlas: AtlasClient,
  command: string,
  id: string | undefined,
  values: Values,
  timeZone: string | undefined,
): Promise<unknown> {
  switch (command) {
    case "projects list":
      return atlas.projects();
    case "labels list":
      return atlas.labels();
    case "tasks list":
      return atlas.tasks(listQuery(values, timeZone));
    case "tasks get": {
      const task = atlas.task(id!);
      if (!task) throw new AtlasError("unknown_task", `no task "${id}"`);
      return task;
    }
    case "tasks add": {
      const fields = taskFields(values, timeZone);
      if (!fields.title) throw new UsageError("tasks add needs --title (or a title in --json)");
      return atlas.createTask(fields as CreateTaskOptions);
    }
    case "tasks quick":
      return atlas.quickAdd(id!);
    case "tasks update": {
      const { project, labels, title, ...rest } = taskFields(values, timeZone);
      const patch: TaskPatch = { ...rest };
      if (title !== undefined) patch.title = title;
      if (project !== undefined) patch.project_id = project;
      if (labels !== undefined) patch.label_ids = labels;
      return atlas.updateTask(id!, patch);
    }
    case "tasks complete":
      return atlas.completeTask(id!);
    case "tasks reopen":
      return atlas.reopenTask(id!);
    case "tasks delete":
      await atlas.deleteTask(id!);
      return { deleted: id };
    case "changes": {
      if (values.since === undefined) return { cursor: atlas.cursor() };
      const since = Number(values.since);
      if (!Number.isInteger(since) || since < 0) {
        throw new UsageError("--since takes a cursor from an earlier run");
      }
      return atlas.changes(since);
    }
  }
  throw new UsageError(`unknown command "${command}"`);
}

function listQuery(values: Values, timeZone: string | undefined): TaskQuery {
  const status = values.status as TaskStatus | undefined;
  if (status && !["open", "completed", "all"].includes(status)) {
    throw new UsageError("--status is open, completed or all");
  }
  if ((values.label?.length ?? 0) > 1) throw new UsageError("tasks list takes one --label");
  return {
    project: values.project,
    status,
    label: values.label?.[0],
    search: values.search,
    filter: values.filter,
    dueBefore: optionalDue(values["due-before"], timeZone),
    dueAfter: optionalDue(values["due-after"], timeZone),
  };
}

function optionalDue(value: string | undefined, timeZone: string | undefined): number | undefined {
  return value === undefined ? undefined : (parseDue(value, timeZone) ?? undefined);
}

interface TaskFields extends Omit<TaskPatch, "project_id" | "label_ids"> {
  project?: string | null;
  labels?: string[];
}

/** The task fields from flags, over those from `--json`. */
function taskFields(values: Values, timeZone: string | undefined): TaskFields {
  let json: Record<string, unknown> = {};
  if (values.json !== undefined) {
    try {
      json = JSON.parse(values.json) as Record<string, unknown>;
    } catch {
      throw new UsageError("--json is not valid JSON");
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new UsageError("--json must be an object");
    }
  }
  const pick = (flag: string | undefined, key: string): unknown =>
    flag !== undefined ? flag : json[key];
  const fields: TaskFields = {};
  const title = pick(values.title, "title");
  if (title !== undefined) fields.title = String(title);
  const notes = pick(values.notes, "notes");
  if (notes !== undefined) fields.notes = String(notes);
  const due = pick(values.due, "due") ?? json.due_at;
  if (due !== undefined) fields.due_at = parseDue(due as string | number | null, timeZone);
  const priority = pick(values.priority, "priority");
  if (priority !== undefined) fields.priority = Number(priority) as TaskPatch["priority"];
  const project = pick(values.project, "project") ?? json.project_id;
  if (project !== undefined) fields.project = project === null ? null : String(project);
  const recurrence = pick(values.recurrence, "recurrence");
  if (recurrence !== undefined) fields.recurrence = recurrence ? String(recurrence) : null;
  const labels = values.label ?? json.labels;
  if (labels !== undefined) {
    if (!Array.isArray(labels)) throw new UsageError("labels must be a list");
    fields.labels = labels.map(String);
  }
  return fields;
}

function usage(io: Io, message: string): number {
  io.stderr(JSON.stringify({ error: message, code: "usage" }));
  io.stderr("Run `atlas --help` for the commands.");
  return 2;
}

function describe(err: unknown): { error: string; code: string; status?: number } {
  if (err instanceof AtlasError) return { error: err.message, code: err.code };
  if (err instanceof InvalidApiTokenError) {
    return { error: "ATLAS_TOKEN is not an Atlas API token", code: "invalid_token" };
  }
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    const data = (err as { data?: { code?: unknown } }).data;
    const code =
      typeof data?.code === "string"
        ? data.code
        : status === 401
          ? "unauthorized"
          : status === 429
            ? "rate_limited"
            : "server_error";
    const hint = status === 401 ? " (revoked or wrong token?)" : "";
    return { error: `${(err as Error).message}${hint}`, code, status };
  }
  return { error: err instanceof Error ? err.message : String(err), code: "error" };
}
