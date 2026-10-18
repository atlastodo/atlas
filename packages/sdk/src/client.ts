import {
  ApiClient,
  Keyring,
  LocalStore,
  SyncClient,
  deriveApiTokenKeys,
  hydrateProjectKeys,
  isProjectCreator,
  parseApiToken,
  readKeyTrust,
  reviveLockedValues,
  unwrapApiTokenKeys,
  unwrapSigningKey,
  type CreateTaskInput,
  type FetchLike,
  type Label,
  type Operation,
  type Priority,
  type Project,
  type Task,
} from "@atlastodo/client-core";
import {
  allTasks,
  createTask,
  evaluate,
  parse as parseFilter,
  parseQuickAdd,
  softDeleteTask,
  toProject,
  toTask,
  toggleTask,
  updateTask,
} from "@atlastodo/shared";

/**
 * A headless Atlas client for integrations, signed in with a personal API token.
 *
 * `connect` opens a session with the token, unwraps the account keys the token carries, and pulls
 * the account into memory, decrypting it on this machine: the server only ever sees ciphertext.
 * Reads are then local; every write is pushed before its promise resolves. Task rules (recurring
 * completion, soft deletes, locked tasks) are the app's own, from `@atlastodo/shared`.
 */

export interface ConnectOptions {
  /** The Atlas server, e.g. `https://app.atlastodo.dev` (an `/api` suffix is fine too). */
  serverUrl: string;
  /** An `atlas_pat_…` token from Settings → API tokens. */
  token: string;
  fetch?: FetchLike;
  /** IANA zone for due dates and recurrence; the runtime's by default. */
  timeZone?: string;
}

export type TaskStatus = "open" | "completed" | "all";

export interface TaskQuery {
  /** A project id or name (case-insensitive). */
  project?: string;
  /** Default `open`. */
  status?: TaskStatus;
  /** Unix ms bounds on the due date; tasks without one are left out when either is set. */
  dueBefore?: number;
  dueAfter?: number;
  /** A label id or name (case-insensitive). */
  label?: string;
  /** Case-insensitive substring of the title or notes. */
  search?: string;
  /** The app's filter syntax (`today & p1`, `#Work | @errand`, `overdue`). */
  filter?: string;
}

/** A task as integrations see it: the app's task plus resolved project and label names. */
export interface TaskView extends Task {
  project_name: string | null;
  labels: string[];
}

export interface CreateTaskOptions extends Partial<Omit<CreateTaskInput, "title">> {
  title: string;
  /** A project name, resolved like `project_id` (ignored when `project_id` is given). */
  project?: string;
  /** Label names; unknown ones are an error. */
  labels?: string[];
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "notes"
    | "priority"
    | "due_at"
    | "start_at"
    | "recurrence"
    | "project_id"
    | "section_id"
    | "label_ids"
    | "estimate_min"
    | "assignee_id"
  >
>;

export interface Changes {
  /** Pass back as `since` next time. */
  cursor: number;
  created: TaskView[];
  updated: TaskView[];
  completed: TaskView[];
  /** Soft-deleted (in the trash) or purged; purged ones carry only their id. */
  deleted: (TaskView | { id: string })[];
}

export class AtlasError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

export class AtlasClient {
  private constructor(
    private readonly api: ApiClient,
    private readonly store: LocalStore,
    private readonly sync: SyncClient,
    readonly userId: string,
    private readonly timeZone: string | undefined,
  ) {}

  static async connect(opts: ConnectOptions): Promise<AtlasClient> {
    const parts = parseApiToken(opts.token);
    const { auth } = deriveApiTokenKeys(parts);
    const baseUrl = opts.serverUrl.replace(/\/+$/, "");
    const api: ApiClient = new ApiClient({
      baseUrl,
      fetch: opts.fetch,
      // Token sessions have no refresh token: an expired one is opened again.
      reauthenticate: async () => (await api.openApiTokenSession(parts.id, auth)).access_token,
    });
    const session = await api.openApiTokenSession(parts.id, auth);
    api.setTokens(session.access_token);

    const { dek, privateKey } = unwrapApiTokenKeys(parts, session.user_id, session);
    const keyring = new Keyring({ dek, privateKey, publicKey: session.public_key });
    if (session.encrypted_signing_key && session.signing_public_key) {
      try {
        keyring.setSigningKey(
          unwrapSigningKey(session.encrypted_signing_key, dek, session.signing_public_key),
        );
      } catch {
        // Only needed to rotate or deliver project keys, which this client never does.
      }
    }
    api.setKeyring(keyring);

    // The token id is this client's device: its HLC node and its session's device id.
    const store = new LocalStore(parts.id, { newId: () => globalThis.crypto.randomUUID() });
    api.setScopeContext(store, session.user_id);
    const sync = new SyncClient(store, api, { cursor: 0 });
    const client = new AtlasClient(api, store, sync, session.user_id, opts.timeZone);
    await client.initialSync(keyring);
    return client;
  }

  /** Pull everything, then load the shared projects' keys under the synced trust state. */
  private async initialSync(keyring: Keyring): Promise<void> {
    await this.syncOrThrow();
    const result = await hydrateProjectKeys(this.api, keyring, {
      isCreator: (projectId) => isProjectCreator(this.store, projectId, this.userId),
      trust: readKeyTrust(this.store),
      userId: this.userId,
      trustWriter: this.store,
    });
    if (result.changed) {
      reviveLockedValues(this.store, keyring, this.userId, !this.api.isLegacyMigrated());
      await this.syncOrThrow();
    }
  }

  private async syncOrThrow(): Promise<void> {
    const result = await this.sync.sync();
    if (result.skipped) {
      throw new AtlasError("sync_skipped", `sync did not run (${result.skipped}); try again later`);
    }
  }

  /** Push pending writes; throws when any did not reach the server. */
  private async push(): Promise<void> {
    await this.syncOrThrow();
    const pending = this.store.unsyncedOps().length;
    if (pending > 0) {
      throw new AtlasError(
        "not_pushed",
        `${pending} change(s) did not reach the server (a shared project whose key is missing?)`,
      );
    }
  }

  /** The server cursor this client has pulled up to. */
  cursor(): number {
    return this.sync.currentCursor();
  }

  /** Projects and folders that are neither archived nor in the trash. */
  projects(): Project[] {
    return this.store
      .list("project")
      .map((e) => toProject(e.id, e.fields))
      .filter((p) => p.archived_at == null && p.deleted_at == null)
      .sort((a, b) => a.sort_order - b.sort_order);
  }

  labels(): Label[] {
    return this.store
      .list("label")
      .filter((e) => e.fields.deleted_at == null)
      .map((e) => ({
        id: e.id,
        owner_id: typeof e.fields.owner_id === "string" ? e.fields.owner_id : "",
        name: typeof e.fields.name === "string" ? e.fields.name : "",
        color: typeof e.fields.color === "string" ? e.fields.color : "",
      }));
  }

  private projectId(ref: string): string {
    const lower = ref.toLowerCase();
    const project =
      this.projects().find((p) => p.id === ref) ??
      this.projects().find((p) => p.name.toLowerCase() === lower);
    if (!project) throw new AtlasError("unknown_project", `no project "${ref}"`);
    return project.id;
  }

  private labelId(ref: string): string {
    const lower = ref.replace(/^@/, "").toLowerCase();
    const label =
      this.labels().find((l) => l.id === ref) ??
      this.labels().find((l) => l.name.toLowerCase() === lower);
    if (!label) throw new AtlasError("unknown_label", `no label "${ref}"`);
    return label.id;
  }

  private view(task: Task): TaskView {
    const names = new Map(this.labels().map((l) => [l.id, l.name]));
    const project = task.project_id ? this.store.get("project", task.project_id) : null;
    return {
      ...task,
      project_name: project && typeof project.name === "string" ? project.name : null,
      labels: task.label_ids.map((id) => names.get(id)).filter((n): n is string => n != null),
    };
  }

  private rawTask(id: string): Task {
    const fields = this.store.get("task", id);
    if (!fields) throw new AtlasError("unknown_task", `no task "${id}"`);
    return toTask(id, fields);
  }

  /** One task by id, trashed or not; null when there is none. */
  task(id: string): TaskView | null {
    const fields = this.store.get("task", id);
    return fields ? this.view(toTask(id, fields)) : null;
  }

  /** Tasks not in the trash or archived, filtered by `query`. */
  tasks(query: TaskQuery = {}): TaskView[] {
    const status = query.status ?? "open";
    const projectId = query.project ? this.projectId(query.project) : null;
    const labelId = query.label ? this.labelId(query.label) : null;
    const search = query.search?.toLowerCase();
    let filter: ReturnType<typeof parseFilter> | null = null;
    if (query.filter) {
      filter = parseFilter(query.filter);
      if (!filter.ok) {
        throw new AtlasError("bad_filter", `${filter.error} (at ${filter.at})`);
      }
    }
    const now = Date.now();
    const labelNames = new Map(this.labels().map((l) => [l.id, l.name]));
    const ctx = {
      now,
      timeZone: this.timeZone,
      labelsOf: (t: Task) => t.label_ids.map((id) => labelNames.get(id) ?? ""),
      projectNameOf: (t: Task) => {
        const p = t.project_id ? this.store.get("project", t.project_id) : null;
        return p && typeof p.name === "string" ? p.name : null;
      },
    };
    return allTasks(this.store)
      .filter((t) => t.deleted_at == null && t.archived_at == null)
      .filter((t) => status === "all" || t.is_completed === (status === "completed"))
      .filter((t) => projectId == null || t.project_id === projectId)
      .filter((t) => labelId == null || t.label_ids.includes(labelId))
      .filter((t) => {
        if (query.dueBefore == null && query.dueAfter == null) return true;
        if (t.due_at == null) return false;
        return (
          (query.dueBefore == null || t.due_at < query.dueBefore) &&
          (query.dueAfter == null || t.due_at >= query.dueAfter)
        );
      })
      .filter(
        (t) =>
          !search ||
          t.title.toLowerCase().includes(search) ||
          t.notes.toLowerCase().includes(search),
      )
      .filter((t) => !filter?.ok || evaluate(filter.ast, t, ctx))
      .map((t) => this.view(t));
  }

  /** Create a task and push it. */
  async createTask(input: CreateTaskOptions): Promise<TaskView> {
    const { project, labels, ...rest } = input;
    if (!rest.title?.trim()) throw new AtlasError("bad_input", "a task needs a title");
    const create: CreateTaskInput = { ...rest, title: rest.title.trim() };
    if (create.project_id) create.project_id = this.projectId(create.project_id);
    else if (project) create.project_id = this.projectId(project);
    if (labels?.length) {
      create.label_ids = [...(create.label_ids ?? []), ...labels.map((l) => this.labelId(l))];
    }
    if (create.priority != null) create.priority = checkPriority(create.priority);
    const id = createTask(this.store, create, this.timeZone);
    await this.push();
    return this.view(this.rawTask(id));
  }

  /**
   * Create a task from one line in the app's quick-add syntax:
   * `Pay rent every month on the 1st #Home p1 @bills`.
   */
  async quickAdd(text: string): Promise<TaskView> {
    const projects = this.projects();
    const labels = this.labels();
    const parsed = parseQuickAdd(text, Date.now(), {
      timeZone: this.timeZone,
      projectIdByName: (name) =>
        projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null,
      isKnownLabel: (name) => labels.some((l) => l.name.toLowerCase() === name.toLowerCase()),
    });
    return this.createTask({ ...parsed.input, labels: parsed.labels });
  }

  /** Change a task's fields and push. Unchanged values are skipped. */
  async updateTask(id: string, patch: TaskPatch): Promise<TaskView> {
    const task = this.rawTask(id);
    const clean: Partial<Task> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (clean as Record<string, unknown>)[key] = value;
    }
    if (clean.project_id) clean.project_id = this.projectId(clean.project_id);
    if (clean.priority != null) clean.priority = checkPriority(clean.priority);
    if (clean.label_ids) clean.label_ids = clean.label_ids.map((l) => this.labelId(l));
    if (!updateTask(this.store, task, clean, this.userId, Date.now(), this.timeZone)) {
      if (task.locked || this.rawTask(id).locked) throw lockedError(id);
      return this.view(task);
    }
    await this.push();
    return this.view(this.rawTask(id));
  }

  /**
   * Complete a task (no-op when it already is). A recurring task with a due date spawns its next
   * occurrence, returned as `next`.
   */
  async completeTask(id: string): Promise<{ task: TaskView; next: TaskView | null }> {
    return this.setCompleted(id, true);
  }

  async reopenTask(id: string): Promise<{ task: TaskView; next: TaskView | null }> {
    return this.setCompleted(id, false);
  }

  private async setCompleted(
    id: string,
    completed: boolean,
  ): Promise<{ task: TaskView; next: TaskView | null }> {
    const task = this.rawTask(id);
    if (task.locked) throw lockedError(id);
    if (task.is_completed === completed) return { task: this.view(task), next: null };
    const spawned = toggleTask(this.store, task, this.userId, Date.now(), this.timeZone);
    await this.push();
    return {
      task: this.view(this.rawTask(id)),
      next: spawned ? this.view(this.rawTask(spawned)) : null,
    };
  }

  /** Move a task to the trash, as the app's delete does. */
  async deleteTask(id: string): Promise<void> {
    const task = this.rawTask(id);
    if (task.deleted_at != null) return;
    if (!softDeleteTask(this.store, task)) throw lockedError(id);
    await this.push();
  }

  /**
   * Tasks changed on the server after `since` (a cursor from an earlier call or {@link cursor}).
   * Each task is listed once, under the first of deleted, created, completed, updated that its
   * changes match, with its current state.
   */
  async changes(since: number): Promise<Changes> {
    await this.syncOrThrow();
    const until = this.cursor();
    const touched = new Map<string, Operation[]>();
    let cursor = since;
    while (cursor < until) {
      const page = await this.api.syncPull(cursor);
      for (const op of page.operations) {
        if (op.entity !== "task") continue;
        const ops = touched.get(op.entityId) ?? [];
        ops.push(op);
        touched.set(op.entityId, ops);
      }
      if (page.operations.length === 0 || page.cursor <= cursor) break;
      cursor = page.cursor;
    }
    const out: Changes = {
      cursor: Math.max(until, cursor),
      created: [],
      updated: [],
      completed: [],
      deleted: [],
    };
    for (const [id, ops] of touched) {
      const fields = this.store.get("task", id);
      const has = (field: string, pred: (v: unknown) => boolean = () => true) =>
        ops.some((o) => o.op === "set" && o.field === field && pred(o.value));
      if (!fields) {
        out.deleted.push({ id });
        continue;
      }
      const view = this.view(toTask(id, fields));
      if (ops.some((o) => o.op === "delete") || has("deleted_at", (v) => v != null)) {
        out.deleted.push(view);
      } else if (has("created_at")) out.created.push(view);
      else if (has("is_completed", (v) => v === true)) out.completed.push(view);
      else out.updated.push(view);
    }
    return out;
  }

  /** Stop background timers. Every write has already been pushed. */
  close(): void {
    this.sync.dispose();
  }
}

function checkPriority(p: unknown): Priority {
  if (p === 1 || p === 2 || p === 3 || p === 4) return p;
  throw new AtlasError("bad_input", "priority must be 1 (highest) to 4 (none)");
}

function lockedError(id: string): AtlasError {
  return new AtlasError(
    "task_locked",
    `task "${id}" is in a shared project whose key this token cannot open`,
  );
}
