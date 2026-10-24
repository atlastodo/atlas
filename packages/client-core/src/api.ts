/** Typed HTTP client: auth, key distribution, membership, reports, admin and `/sync/*`. A 401 rotates the refresh token once. */

import type {
  AdminAuditEntry,
  AdminInviteView,
  AdminSettingsView,
  AdminUserView,
  AuthResponse,
  AuthUser,
  BugReportPayload,
  BugReportSummary,
  BugReportView,
  InviteView,
  MemberRole,
  MemberView,
  MissingProjectKey,
  PendingKeyRotation,
  Operation,
  ProjectKeysResponse,
  RecoverAccountPayload,
  RecoveryKeysResponse,
  RegisterRecoveryKeyPayload,
  ReplaceRecoveryKeyPayload,
  SaltResponse,
  SessionView,
  ApiTokenView,
  ApiTokenSessionResponse,
  CreateApiTokenPayload,
  UserPublicKeyResponse,
  SigningKeyResponse,
  ChangePasswordPayload,
  AppKeyRow,
  MigrateRootKeyPayload,
  PutRecoveryRootKeyPayload,
  RootKeyResponse,
  AccountProof,
  PasskeyAssertionResponse,
  PasskeyCreationOptions,
  PasskeyReauthResponse,
  PasskeyRegistrationPayload,
  PasskeyRequestOptions,
  PasskeyView,
} from "./types";
import {
  DEK_KEY_ID,
  Keyring,
  MissingScopeKey,
  isEncryptedEnvelope,
  kdfToWire,
  type EncryptedPayload,
  type KeyScope,
  type PasswordKdf,
  type SealedInvitePreview,
  type SealedKey,
  type WrappedProjectKey,
} from "./crypto";
import { SYNC_PROTOCOL, buildSyncWsUrl } from "./realtime";
import { LEGACY_DISCOVERY, parseDiscovery, type ServerDiscovery } from "./discovery";
import { isLegacyWireKind, legacyEncrypted } from "./fieldPolicy";
import {
  EMPTY_SCOPE_STORE,
  batchLinksOf,
  confirmRepairs,
  expectedKeyScope,
  keyForScope,
  openFieldValue,
  openOptionsFor,
  resolveScope,
  sharedProjectIds,
  type Repair,
  type ScopeKey,
  type ScopeStore,
} from "./scope";
import { KEY_TRUST_ID, readKeyTrust } from "./trust";
import { decodeOps, encodeOp, sealedRepair, type DecodeContext, type WireOp } from "./wire";
import type { LegacyKeysPage } from "./legacy";

export type { WireOp } from "./wire";

/** Sync without an unlocked keyring would push plaintext or store ciphertext as content. Transient. */
export class E2eeLockedError extends Error {
  constructor() {
    super("the E2EE keyring is locked");
    this.name = "E2eeLockedError";
  }
}

/** Protocol 7: under its wire kind and scope, the field tagged and the value sealed with `key()`. */
function encodeWireOp(
  op: Operation,
  keyring: Keyring | null | undefined,
  key: () => ScopeKey,
): WireOp {
  if (!keyring?.hasKeys()) throw new E2eeLockedError();
  return encodeOp(op, key());
}

/** Explicit scope: `projectId`'s key (throws when not held) or the DEK when null; never falls back. */
export function toEncryptedWire(
  op: Operation,
  keyring?: Keyring | null,
  projectId?: string | null,
): WireOp {
  return encodeWireOp(op, keyring, () => {
    if (!projectId)
      return { key: keyring!.getDek(), keyId: DEK_KEY_ID, scope: { kind: "personal" } };
    const pek = keyring!.getProjectKey(projectId);
    if (!pek) throw new MissingScopeKey(projectId);
    const scope: KeyScope = { kind: "project", projectId };
    return { key: pek, keyId: keyring!.canonicalKeyId(projectId)!, scope };
  });
}

/**
 * One wire op, decoded on its own: a current one opened with the keys of its scope (still sealed
 * without them), a legacy one by the protocol 6 rules, where `projectId` null is personal and
 * undefined unknown (any held key may open). Throws for an op the decoder drops.
 */
export function fromEncryptedWire(
  w: WireOp,
  keyring?: Keyring | null,
  projectId?: string | null,
): Operation {
  if (!isLegacyWireKind(w.entity) && w.entity !== "project_member") {
    const [d] = decodeOps([w], {
      keyring: keyring?.hasKeys() ? keyring : null,
      store: { kindOf: () => null },
      openLegacy: () => null,
    });
    if (!d) throw new Error(`dropped ${w.entity} op ${w.id}`);
    return d.op;
  }
  const ts = { wallMs: w.ts.wall_ms, counter: w.ts.counter, node: w.ts.node };
  const base = { id: w.id, entity: w.entity as Operation["entity"], entityId: w.entity_id, ts };
  if (w.op === "delete") return { ...base, op: "delete" };
  let value = w.value;
  if (keyring?.hasKeys() && isEncryptedEnvelope(value) && legacyEncrypted(w.entity, w.field)) {
    const expected: KeyScope | null =
      projectId === undefined
        ? null
        : projectId === null
          ? { kind: "personal" }
          : { kind: "project", projectId };
    const at = { entity: w.entity, entityId: w.entity_id, field: w.field };
    const opened = openFieldValue(
      keyring,
      value,
      at,
      expected,
      openOptionsFor(base.entity, w.entity_id, true),
    );
    if (opened) value = opened.value;
    else console.warn(`[atlas-e2ee] no key opens ${w.entity}.${w.field} (${w.entity_id})`);
  }
  return { ...base, op: "set", field: w.field, value };
}

type WireReport = {
  id: string;
  kind: string;
  message: string;
  stack?: string;
  description?: string;
  app_version: string;
  platform: string;
  os_version?: string;
  route?: string;
  device_id?: string;
  diagnostics: Record<string, unknown>;
  breadcrumbs: BugReportPayload["breadcrumbs"];
  occurred_at: number;
};

export function toWireReport(r: BugReportPayload): WireReport {
  return {
    id: r.id,
    kind: r.kind,
    message: r.message,
    stack: r.stack,
    description: r.description,
    app_version: r.appVersion,
    platform: r.platform,
    os_version: r.osVersion,
    route: r.route,
    device_id: r.deviceId,
    diagnostics: {
      sync_status: r.diagnostics.syncStatus,
      last_sync_at: r.diagnostics.lastSyncAt,
      pending: r.diagnostics.pending,
      quarantined: r.diagnostics.quarantined,
      last_error_kind: r.diagnostics.lastErrorKind,
      last_error_status: r.diagnostics.lastErrorStatus,
      last_error_message: r.diagnostics.lastErrorMessage,
      online: r.diagnostics.online,
    },
    breadcrumbs: r.breadcrumbs,
    occurred_at: r.occurredAt,
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export class UpgradeRequiredError extends ApiError {
  constructor(
    public readonly minProtocol?: number,
    data?: unknown,
  ) {
    super(426, "upgrade_required", data);
    this.name = "UpgradeRequiredError";
  }
}

export function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const code = (err.data as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

export const SNAPSHOT_PAGE_KEYS = 500;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Short enough to beat the OS TCP timeout, which can take minutes on phones. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/** `AbortSignal.timeout` where available, else a timer (older React Native); `dispose` clears it. */
function createRequestTimeout(ms: number): { signal?: AbortSignal; dispose: () => void } {
  if (ms <= 0) return { signal: undefined, dispose: () => {} };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), dispose: () => {} };
  }
  if (typeof AbortController === "undefined") return { signal: undefined, dispose: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Covers the DOMException forms and React Native's plain `Error`. */
function isTimeoutAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError" || /abort/i.test(err.message);
}

export interface BlobDownload {
  size: number | null;
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

async function* readerChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let done = false;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        done = true;
        throw new NetworkError(err instanceof Error ? err.message : "Blob download failed", err);
      }
      if (next.done) {
        done = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
  }
}

async function* wholeBody(res: Response): AsyncGenerator<Uint8Array> {
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : "Blob download failed", err);
  }
  yield new Uint8Array(bytes);
}

/** Longer than the JSON cap: 25 MiB on a slow uplink would otherwise never finish. */
export const BLOB_FETCH_TIMEOUT_MS = 120_000;

/** Body-credential endpoints: a 401 means a wrong credential, and a rotation would burn the refresh token. */
const CREDENTIAL_PATHS = new Set([
  "/auth/login",
  "/auth/signup",
  "/auth/refresh",
  "/auth/logout",
  "/auth/recover",
  "/auth/recovery-keys",
  "/auth/salt",
  "/auth/account/cancel-deletion",
  "/auth/api-token/session",
  "/auth/passkeys/login",
  "/auth/passkeys/login/options",
  "/auth/passkeys/signup/options",
]);

const SUPERSEDED_WAITS = 8;
const SUPERSEDED_WAIT_MS = 250;

/** Token storage shared by every web tab. Rotation re-reads first and writes the new pair under `withRefreshLock`. */
export interface TokenStore {
  read(): Promise<{ accessToken?: string; refreshToken?: string } | null>;
  write(auth: AuthResponse): Promise<void>;
  withRefreshLock?<T>(fn: () => Promise<T>): Promise<T>;
  /** Lock cannot exclude siblings; only then ask for the server's reuse grace (elsewhere reuse is theft). */
  refreshGrace?(): boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string;
  refreshToken?: string;
  keyring?: Keyring | null;
  fetch?: FetchLike;
  /** React Native's global fetch base64-encodes binary bodies, so the app passes its own. */
  blobFetch?: FetchLike;
  fetchTimeoutMs?: number;
  onTokens?: (auth: AuthResponse) => void;
  tokenStore?: TokenStore;
  onUpgradeRequired?: (info: { minProtocol?: number }) => void;
  /** The refresh token was rejected: terminal. A 403 `reason` says why (e.g. `account_disabled`). */
  onAuthExpired?: (reason: ApiError) => void;
  /**
   * For a session without a refresh token that can open itself again (an API token): called on
   * a 401, resolves a new access token, and the request is retried once with it.
   */
  reauthenticate?: () => Promise<string>;
  /**
   * The apps this client syncs ({@link SYNC_APPS_HEADER} on every request): pull, the snapshot,
   * the socket and the export then carry only their ops, and push refuses any other. Omitted, the
   * server treats the client as todo, as every client predating app-scoped sync. A cursor is only
   * good for the scope it was pulled under: changing it means re-bootstrapping from the snapshot.
   * Needs the server's `app_scoped_sync` capability.
   */
  apps?: readonly string[];
}

/** Header naming a request's app scope (`apps.rs` in the server). */
export const SYNC_APPS_HEADER = "x-atlas-sync-apps";

/** `GET /auth/apps` entry: an app the instance offers, and whether the account has it enabled. */
export interface AccountAppView {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  enabled_at?: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private token?: string;
  private refreshToken?: string;
  private keyring: Keyring | null = null;
  private scopeStore: ScopeStore | null = null;
  private scopeUserId: string | undefined;
  private legacyDone = false;
  private readonly fetchImpl: FetchLike;
  private readonly blobFetchImpl: FetchLike;
  private readonly fetchTimeoutMs: number;
  private readonly onTokens?: (auth: AuthResponse) => void;
  private readonly onAuthExpired?: (reason: ApiError) => void;
  private readonly tokenStore?: TokenStore;
  private readonly onUpgradeRequired?: (info: { minProtocol?: number }) => void;
  private readonly reauthenticate?: () => Promise<string>;
  private reauthenticating: Promise<string> | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly consumed = new Set<string>();
  private readonly syncApps?: string;

  constructor(opts: ApiClientOptions) {
    if (opts.apps !== undefined) {
      if (opts.apps.length === 0) throw new Error("an app scope names at least one app");
      this.syncApps = [...new Set(opts.apps)].sort().join(",");
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.refreshToken = opts.refreshToken;
    this.keyring = opts.keyring ?? null;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.blobFetchImpl = opts.blobFetch ?? this.fetchImpl;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.onTokens = opts.onTokens;
    this.onAuthExpired = opts.onAuthExpired;
    this.tokenStore = opts.tokenStore;
    this.onUpgradeRequired = opts.onUpgradeRequired;
    this.reauthenticate = opts.reauthenticate;
  }

  setKeyring(keyring: Keyring | null): void {
    this.keyring = keyring;
  }

  getKeyring(): Keyring | null {
    return this.keyring;
  }

  /** Resolves key scopes (a shared-task edit may lack `project_id`) and the user whose role gates repairs. */
  setScopeContext(store: ScopeStore | null, userId?: string): void {
    this.scopeStore = store;
    this.scopeUserId = userId;
  }

  confirmRepairs(repairs: Repair[]): Repair[] {
    if (!this.keyring?.hasKeys()) return [];
    return confirmRepairs(
      this.scopeStore ?? EMPTY_SCOPE_STORE,
      this.keyring,
      this.scopeUserId,
      repairs,
    );
  }

  /** Legacy migration done: plaintext in encrypted fields and v1 values are then dropped. Local, so the server cannot roll it back. */
  setLegacyMigrated(done: boolean): void {
    this.legacyDone = done;
  }

  isLegacyMigrated(): boolean {
    return this.legacyDone || readKeyTrust(this.scopeStore ?? EMPTY_SCOPE_STORE).legacyMigrated;
  }

  /** The real kind of an entity the attached store holds by this id. */
  private kindOfEntity(id: string): Operation["entity"] | null {
    const store = this.scopeStore as
      (ScopeStore & { kindOf?(id: string): Operation["entity"] | null }) | null;
    return store?.kindOf?.(id) ?? null;
  }

  private isCanonical(keyId: string, scope: KeyScope): boolean {
    if (scope.kind === "personal") return keyId === DEK_KEY_ID;
    return this.keyring?.canonicalKeyId(scope.projectId) === keyId;
  }

  private unlockedKeyring(): Keyring {
    if (!this.keyring?.hasKeys()) throw new E2eeLockedError();
    return this.keyring;
  }

  setTokens(token: string | undefined, refreshToken?: string): void {
    this.token = token;
    this.refreshToken = refreshToken;
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "x-atlas-sync-protocol": String(SYNC_PROTOCOL) };
    if (this.syncApps) headers[SYNC_APPS_HEADER] = this.syncApps;
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  private async errorFor(res: Response): Promise<ApiError> {
    const data = (await res.json().catch(() => null)) as {
      min_protocol?: unknown;
      error?: unknown;
    } | null;
    if (res.status === 426) {
      const min = typeof data?.min_protocol === "number" ? data.min_protocol : undefined;
      this.onUpgradeRequired?.({ minProtocol: min });
      return new UpgradeRequiredError(min, data);
    }
    const message = data && typeof data.error === "string" ? data.error : res.statusText;
    const retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"));
    return new ApiError(res.status, message, data, retryAfterMs);
  }

  private async rawRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = this.baseHeaders();
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    const timeout = createRequestTimeout(this.fetchTimeoutMs);
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
      });
    } catch (err) {
      if (isTimeoutAbort(err)) {
        // Aborted by our own cap: say so with the number, to tell it from an unreachable server.
        throw new NetworkError(`Network request timed out after ${this.fetchTimeoutMs}ms`, err);
      }
      throw new NetworkError(err instanceof Error ? err.message : "Network request failed", err);
    } finally {
      timeout.dispose();
    }

    if (!res.ok) throw await this.errorFor(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.rawRequest<T>(method, path, body);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        this.refreshToken &&
        !CREDENTIAL_PATHS.has(path.split("?")[0]!)
      ) {
        await this.doRefresh();
        return this.rawRequest<T>(method, path, body);
      }
      if (
        err instanceof ApiError &&
        err.status === 401 &&
        !this.refreshToken &&
        this.reauthenticate &&
        !CREDENTIAL_PATHS.has(path.split("?")[0]!)
      ) {
        // Concurrent 401s share one exchange.
        this.reauthenticating ??= this.reauthenticate().finally(() => {
          this.reauthenticating = null;
        });
        this.token = await this.reauthenticating;
        return this.rawRequest<T>(method, path, body);
      }
      throw err;
    }
  }

  /**
   * Concurrent callers share one rotation: refresh tokens are single-use, and presenting a consumed
   * one revokes the whole family. A 401/403 is terminal (`onAuthExpired`); 429 and network errors are not.
   */
  private doRefresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const rotate = () => this.rotate();
    const lock = this.tokenStore?.withRefreshLock?.bind(this.tokenStore);
    this.refreshing = (lock ? lock(rotate) : rotate()).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async rotate(): Promise<void> {
    if (await this.adoptStoredTokens()) return;
    const presented = this.refreshToken;
    let auth: AuthResponse;
    try {
      const grace = this.tokenStore?.refreshGrace?.() === true;
      auth = await this.rawRequest<AuthResponse>("POST", "/auth/refresh", {
        refresh_token: presented,
        ...(grace ? { grace: true } : {}),
      });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        if (presented) this.consumed.add(presented);
        // Lock-less race: the sibling's rotation may have landed after our read;
        // `refresh_superseded` confirms it.
        const waits = apiErrorCode(err) === "refresh_superseded" ? SUPERSEDED_WAITS : 0;
        if (await this.adoptStoredTokens(waits)) return;
        this.token = undefined;
        this.refreshToken = undefined;
        this.onAuthExpired?.(err);
      }
      throw err;
    }
    if (presented) this.consumed.add(presented);
    this.token = auth.access_token;
    this.refreshToken = auth.refresh_token;
    if (this.tokenStore) {
      try {
        await this.tokenStore.write(auth); // before the lock is released
      } catch (err) {
        // The rotated pair works in memory; failing the request over storage would not help.
        console.warn("[atlas] could not persist rotated tokens:", err);
      }
    }
    this.onTokens?.(auth);
  }

  /** Adopt a sibling's rotated pair, re-reading up to `waits` times while it lands. */
  private async adoptStoredTokens(waits = 0): Promise<boolean> {
    if (!this.tokenStore) return false;
    for (let attempt = 0; ; attempt++) {
      const stored = await this.tokenStore.read().catch(() => null);
      const refresh = stored?.refreshToken;
      if (refresh && refresh !== this.refreshToken && !this.consumed.has(refresh)) {
        this.token = stored.accessToken;
        this.refreshToken = refresh;
        return true;
      }
      if (attempt >= waits) return false;
      await new Promise((resolve) => setTimeout(resolve, SUPERSEDED_WAIT_MS));
    }
  }

  /** A spent token must not be adopted: presenting it again reads as theft. */
  hasPresented(refreshToken: string): boolean {
    return this.consumed.has(refreshToken);
  }

  private blobTimeoutMs(): number {
    if (this.fetchTimeoutMs <= 0) return 0;
    return Math.max(this.fetchTimeoutMs, BLOB_FETCH_TIMEOUT_MS);
  }

  private async blobRequest(
    method: "PUT" | "GET",
    path: string,
    body?: Uint8Array | Blob,
  ): Promise<Response> {
    const headers = this.baseHeaders();
    if (body !== undefined) headers["content-type"] = "application/octet-stream";

    let res: Response;
    const timeout = createRequestTimeout(this.blobTimeoutMs());
    try {
      res = await this.blobFetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        // ArrayBufferView bodies are accepted by every fetch runtime; the DOM typing rejects them
        // only over ArrayBuffer-vs-SharedArrayBuffer generics.
        body: body as unknown as BodyInit | undefined,
        signal: timeout.signal,
      });
    } catch (err) {
      if (isTimeoutAbort(err)) {
        throw new NetworkError(`Blob request timed out after ${this.blobTimeoutMs()}ms`, err);
      }
      throw new NetworkError(err instanceof Error ? err.message : "Blob request failed", err);
    } finally {
      timeout.dispose();
    }

    if (!res.ok) throw await this.errorFor(res);
    return res;
  }

  private async blobRequestWithRefresh(
    method: "PUT" | "GET",
    path: string,
    body?: Uint8Array | Blob,
  ): Promise<Response> {
    try {
      return await this.blobRequest(method, path, body);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && this.refreshToken) {
        await this.doRefresh();
        return this.blobRequest(method, path, body);
      }
      throw err;
    }
  }

  /** `sha` is the sha256 of the exact bytes (409 on mismatch). The queue re-PUTs after a crash, so `"exists"` is fine. */
  async putBlob(sha: string, body: Uint8Array | Blob): Promise<"stored" | "exists"> {
    const res = await this.blobRequestWithRefresh("PUT", `/attachments/blobs/${sha}`, body);
    return res.status === 201 ? "stored" : "exists";
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    const res = await this.blobRequestWithRefresh("GET", `/attachments/blobs/${sha}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async streamBlob(sha: string): Promise<BlobDownload> {
    const res = await this.blobRequestWithRefresh("GET", `/attachments/blobs/${sha}`);
    const declared = Number(res.headers?.get?.("content-length"));
    const size = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    const reader =
      typeof res.body?.getReader === "function"
        ? (res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>)
        : null;
    return { size, chunks: reader ? readerChunks(reader) : wholeBody(res) };
  }

  /**
   * `GET /discovery`, public. A server that predates it (a 404, or the web app's HTML in its
   * place) is {@link LEGACY_DISCOVERY}; network and server errors still throw.
   */
  async getDiscovery(): Promise<ServerDiscovery> {
    try {
      return parseDiscovery(await this.rawRequest("GET", "/discovery"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return LEGACY_DISCOVERY;
      if (err instanceof SyntaxError) return LEGACY_DISCOVERY;
      throw err;
    }
  }

  /** A server too old to answer counts as enabled with `maxBlobBytes: null`. */
  async getAttachmentConfig(): Promise<{ enabled: boolean; maxBlobBytes: number | null }> {
    let body: unknown;
    try {
      body = await this.request("GET", "/attachments/config");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404)
        return { enabled: true, maxBlobBytes: null };
      throw err;
    }
    const config = body as { enabled?: unknown; max_blob_bytes?: unknown } | null;
    if (typeof config?.enabled !== "boolean") return { enabled: true, maxBlobBytes: null };
    const max = config.max_blob_bytes;
    return {
      enabled: config.enabled,
      maxBlobBytes: typeof max === "number" && max > 0 ? max : null,
    };
  }

  signup(req: {
    email: string;
    /** The auth hash; absent for a passkey signup (`passkey`). */
    password?: string;
    /** Sign up with a passkey instead of a password (after `passkeySignupOptions`). */
    passkey?: Omit<PasskeyRegistrationPayload, "current_password" | "reauth_token">;
    displayName?: string;
    invite?: string;
    deviceName?: string;
    /** Survives a reinstall; the server replaces this install's older sessions. */
    installKey?: string;
    salt: string;
    publicKey: string;
    recoveryPublicKey: string;
    /** The legacy MEK wraps; absent for a passkey signup. */
    encryptedDek?: { iv: string; ct: string };
    encryptedPrivateKey?: { iv: string; ct: string };
    recoveryEncryptedDek: { iv: string; ct: string };
    recoveryEncryptedPrivateKey: { iv: string; ct: string };
    kdf?: PasswordKdf;
    signingPublicKey?: string;
    encryptedSigningKey?: { v?: number; iv: string; ct: string };
    /** The account root key (see `newAccountRoot`): the client-chosen id its wraps bind, its slots and app keys. */
    root?: {
      userId: string;
      /** The password slot; absent for a passkey signup, whose slot is the passkey's. */
      encryptedRootKey?: { v: 1; iv: string; ct: string };
      recoveryEncryptedRootKey: { v: 1; iv: string; ct: string };
      appKeys: AppKeyRow[];
    };
  }): Promise<AuthResponse> {
    return this.request("POST", "/auth/signup", {
      email: req.email,
      password: req.password,
      passkey: req.passkey,
      display_name: req.displayName ?? "",
      invite: req.invite,
      device_name: req.deviceName,
      install_key: req.installKey,
      salt: req.salt,
      public_key: req.publicKey,
      recovery_public_key: req.recoveryPublicKey,
      encrypted_dek: req.encryptedDek,
      encrypted_private_key: req.encryptedPrivateKey,
      recovery_encrypted_dek: req.recoveryEncryptedDek,
      recovery_encrypted_private_key: req.recoveryEncryptedPrivateKey,
      ...(req.kdf ? kdfToWire(req.kdf) : {}),
      signing_public_key: req.signingPublicKey,
      encrypted_signing_key: req.encryptedSigningKey,
      ...(req.root
        ? {
            user_id: req.root.userId,
            encrypted_root_key: req.root.encryptedRootKey,
            recovery_encrypted_root_key: req.root.recoveryEncryptedRootKey,
            app_keys: req.root.appKeys,
          }
        : {}),
    });
  }
  /** `installKey` survives a reinstall; the server replaces this install's older sessions. */
  login(
    email: string,
    password: string,
    deviceName?: string,
    installKey?: string,
  ): Promise<AuthResponse> {
    return this.request("POST", "/auth/login", {
      email,
      password,
      device_name: deviceName,
      install_key: installKey,
    });
  }
  getSalt(email: string): Promise<SaltResponse> {
    return this.request("GET", `/auth/salt?email=${encodeURIComponent(email)}`);
  }
  getRecoveryKeys(email: string): Promise<RecoveryKeysResponse> {
    return this.request("GET", `/auth/recovery-keys?email=${encodeURIComponent(email)}`);
  }
  recoverAccount(payload: RecoverAccountPayload): Promise<void> {
    return this.request("POST", "/auth/recover", payload);
  }
  registerRecoveryKey(payload: RegisterRecoveryKeyPayload): Promise<void> {
    return this.request("PUT", "/auth/recovery-key", payload);
  }
  replaceRecoveryKey(payload: ReplaceRecoveryKeyPayload): Promise<void> {
    return this.request("POST", "/auth/recovery-key/replace", payload);
  }
  changePassword(payload: ChangePasswordPayload): Promise<void> {
    return this.request("POST", "/auth/change-password", payload);
  }
  /** The account's root key password slot and app keys (interactive sessions only). */
  getRootKey(): Promise<RootKeyResponse> {
    return this.request("GET", "/auth/root-key");
  }
  /** Set once: 409 `root_key_exists` when another device migrated the account first. */
  migrateRootKey(payload: MigrateRootKeyPayload): Promise<void> {
    return this.request("POST", "/auth/root-key", payload);
  }
  /** Fill an empty recovery slot; 409 `key_already_stored` when one is set. */
  putRecoveryRootKey(payload: PutRecoveryRootKeyPayload): Promise<void> {
    return this.request("PUT", "/auth/root-key/recovery", payload);
  }
  /** Store a new app's key under the root key; set once (409 `key_already_stored`). */
  putAppKey(
    app: string,
    wrapped: Pick<AppKeyRow, "wrapped_key" | "wrapped_private_key">,
  ): Promise<void> {
    return this.request("PUT", `/auth/app-keys/${encodeURIComponent(app)}`, wrapped);
  }
  /** The instance's apps and whether this account has each enabled (interactive sessions only). */
  async listAccountApps(): Promise<AccountAppView[]> {
    return (await this.request<{ apps: AccountAppView[] }>("GET", "/auth/apps")).apps;
  }
  /** Enable an app for the account; idempotent. Use `enableApp` (rootKey.ts), which keys it first. */
  enableAccountApp(app: string): Promise<AccountAppView> {
    return this.request("PUT", `/auth/apps/${encodeURIComponent(app)}`);
  }
  getUserPublicKey(email: string): Promise<UserPublicKeyResponse> {
    return this.request("GET", `/users/public-key?email=${encodeURIComponent(email)}`);
  }
  getSigningKey(): Promise<SigningKeyResponse> {
    return this.request("GET", "/auth/signing-key");
  }
  /** Write-once: 409 `signing_key_already_set` if a different key is stored. */
  putSigningKey(publicKey: string, wrapped: { v?: number; iv: string; ct: string }): Promise<void> {
    return this.request("PUT", "/auth/signing-key", {
      signing_public_key: publicKey,
      encrypted_signing_key: wrapped,
    });
  }
  logout(refreshToken: string | undefined = this.refreshToken): Promise<void> {
    if (!refreshToken) return Promise.resolve();
    return this.request("POST", "/auth/logout", { refresh_token: refreshToken });
  }
  /**
   * Needs the current auth hash, or a passkey proof: a bearer token alone must not schedule a
   * deletion. The server drops the account's passkeys with it.
   */
  deleteAccount(proof: string | AccountProof): Promise<void> {
    const body =
      typeof proof === "string"
        ? { password: proof }
        : "reauth_token" in proof
          ? { reauth_token: proof.reauth_token }
          : { password: proof.current_password };
    return this.request("DELETE", "/auth/account", body);
  }
  /** Make the account passkey-only; 409 `last_unlock_method` without a passkey. */
  removePassword(proof: AccountProof): Promise<void> {
    return this.request("DELETE", "/auth/password", proof);
  }

  /** Begin a passkey signup for the account id the signup will use. */
  async passkeySignupOptions(req: {
    userId: string;
    email: string;
    displayName?: string;
  }): Promise<PasskeyCreationOptions> {
    const res: { options: PasskeyCreationOptions } = await this.request(
      "POST",
      "/auth/passkeys/signup/options",
      { user_id: req.userId, email: req.email, display_name: req.displayName ?? "" },
    );
    return res.options;
  }
  /** Begin adding a passkey to the signed-in account. */
  async passkeyRegisterOptions(): Promise<PasskeyCreationOptions> {
    const res: { options: PasskeyCreationOptions } = await this.request(
      "POST",
      "/auth/passkeys/register/options",
    );
    return res.options;
  }
  /** Finish adding a passkey; needs a proof (`current_password` or `reauth_token`). */
  registerPasskey(payload: PasskeyRegistrationPayload): Promise<PasskeyView> {
    return this.request("POST", "/auth/passkeys", payload);
  }
  listPasskeys(): Promise<PasskeyView[]> {
    return this.request("GET", "/auth/passkeys");
  }
  renamePasskey(id: string, name: string): Promise<void> {
    return this.request("PATCH", `/auth/passkeys/${id}`, { name });
  }
  /** 409 `last_unlock_method` for the last passkey of an account without a password. */
  removePasskey(id: string, proof: AccountProof): Promise<void> {
    return this.request("DELETE", `/auth/passkeys/${id}`, proof);
  }
  /** Begin a passkey sign-in: discoverable, or naming the account's passkeys for `email`. */
  async passkeyLoginOptions(email?: string): Promise<PasskeyRequestOptions> {
    const res: { options: PasskeyRequestOptions } = await this.request(
      "POST",
      "/auth/passkeys/login/options",
      email ? { email } : {},
    );
    return res.options;
  }
  /** Finish a passkey sign-in: a session, plus `passkey` (the root key under its slot). */
  passkeyLogin(req: {
    credential: PasskeyAssertionResponse;
    deviceName?: string;
    installKey?: string;
  }): Promise<AuthResponse> {
    return this.request("POST", "/auth/passkeys/login", {
      credential: req.credential,
      device_name: req.deviceName,
      install_key: req.installKey,
    });
  }
  async passkeyReauthOptions(): Promise<PasskeyRequestOptions> {
    const res: { options: PasskeyRequestOptions } = await this.request(
      "POST",
      "/auth/passkeys/reauth/options",
    );
    return res.options;
  }
  /** A single-use, five-minute proof that stands in for the current password. */
  passkeyReauth(credential: PasskeyAssertionResponse): Promise<PasskeyReauthResponse> {
    return this.request("POST", "/auth/passkeys/reauth", { credential });
  }
  cancelAccountDeletion(payload: {
    email: string;
    password: string;
    install_key?: string;
  }): Promise<AuthResponse> {
    return this.request("POST", "/auth/account/cancel-deletion", payload);
  }
  me(): Promise<AuthUser> {
    return this.request("GET", "/auth/me");
  }

  listSessions(): Promise<SessionView[]> {
    return this.request("GET", "/auth/sessions");
  }
  /** The current device is refused (use `logout`). */
  revokeSession(deviceId: string): Promise<void> {
    return this.request("DELETE", `/auth/sessions/${deviceId}`);
  }
  revokeOtherSessions(): Promise<void> {
    return this.request("POST", "/auth/sessions/revoke-others");
  }
  renameSession(deviceId: string, name: string): Promise<void> {
    return this.request("PATCH", `/auth/sessions/${deviceId}`, { name });
  }
  exportData(): Promise<unknown> {
    return this.request("GET", "/auth/export");
  }

  listApiTokens(): Promise<ApiTokenView[]> {
    return this.request("GET", "/auth/api-tokens");
  }
  /** Build the payload with `generateApiToken` and `wrapKeysForApiToken`. */
  createApiToken(payload: CreateApiTokenPayload): Promise<ApiTokenView> {
    return this.request("POST", "/auth/api-tokens", payload);
  }
  revokeApiToken(id: string): Promise<void> {
    return this.request("DELETE", `/auth/api-tokens/${id}`);
  }
  /** Open a session with a token's id and auth value (`deriveApiTokenKeys`); no bearer needed. */
  openApiTokenSession(tokenId: string, auth: string): Promise<ApiTokenSessionResponse> {
    return this.request("POST", "/auth/api-token/session", { token_id: tokenId, auth });
  }

  listProjectKeys(): Promise<ProjectKeysResponse> {
    return this.request("GET", "/project-keys");
  }
  listMissingProjectKeys(): Promise<MissingProjectKey[]> {
    return this.request("GET", "/project-keys/missing");
  }
  putProjectKey(
    projectId: string,
    encryptedPek: WrappedProjectKey | EncryptedPayload,
    keyId: string,
  ): Promise<void> {
    return this.request("PUT", `/projects/${projectId}/keys`, {
      encrypted_pek: encryptedPek,
      key_id: keyId,
    });
  }
  putMemberProjectKey(
    projectId: string,
    memberId: string,
    sealed: SealedKey,
    keyId: string,
    signature: string,
  ): Promise<void> {
    return this.request("PUT", `/projects/${projectId}/member-keys/${memberId}`, {
      encrypted_pek: sealed,
      key_id: keyId,
      signature,
    });
  }
  listKeyRotations(): Promise<PendingKeyRotation[]> {
    return this.request("GET", "/project-keys/rotations");
  }
  /** The new key becomes canonical and older ones retire. 409 `rotation_not_pending` if another owner won. */
  completeKeyRotation(projectId: string, keyId: string, request: number): Promise<void> {
    return this.request("POST", `/projects/${projectId}/key-rotation`, {
      key_id: keyId,
      request,
    });
  }

  /** Works without a token: a crash at startup or on the login screen has no session. */
  submitReport(report: BugReportPayload): Promise<void> {
    return this.request("POST", "/reports", toWireReport(report));
  }

  listReports(
    params: {
      resolved?: boolean;
      limit?: number;
      beforeMs?: number;
    } = {},
  ): Promise<BugReportSummary[]> {
    const q = new URLSearchParams();
    if (params.resolved !== undefined) q.set("resolved", String(params.resolved));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.beforeMs !== undefined) q.set("before_ms", String(params.beforeMs));
    const suffix = q.toString();
    return this.request("GET", `/admin/reports${suffix ? `?${suffix}` : ""}`);
  }
  getReport(id: string): Promise<BugReportView> {
    return this.request("GET", `/admin/reports/${id}`);
  }
  setReportResolved(id: string, resolved: boolean): Promise<BugReportView> {
    return this.request("PATCH", `/admin/reports/${id}`, { resolved });
  }
  deleteReport(id: string): Promise<void> {
    return this.request("DELETE", `/admin/reports/${id}`);
  }
  deleteAllReports(resolved?: boolean): Promise<{ deleted: number }> {
    const suffix = resolved === undefined ? "" : `?resolved=${resolved}`;
    return this.request("DELETE", `/admin/reports${suffix}`);
  }

  listUsers(
    params: {
      search?: string;
      limit?: number;
      beforeId?: string;
    } = {},
  ): Promise<AdminUserView[]> {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.beforeId !== undefined) q.set("before_id", params.beforeId);
    const suffix = q.toString();
    return this.request("GET", `/admin/users${suffix ? `?${suffix}` : ""}`);
  }
  setUserAdmin(id: string, isAdmin: boolean): Promise<AdminUserView> {
    return this.request("PATCH", `/admin/users/${id}`, { is_admin: isAdmin });
  }
  setUserDisabled(id: string, disabled: boolean): Promise<AdminUserView> {
    return this.request("PATCH", `/admin/users/${id}`, { disabled });
  }
  logoutUserDevices(id: string): Promise<void> {
    return this.request("POST", `/admin/users/${id}/logout`);
  }
  /** Schedules the 30-day deletion; answers with the updated account. */
  deleteUser(id: string): Promise<AdminUserView> {
    return this.request("DELETE", `/admin/users/${id}`);
  }

  listSignupInvites(params: { limit?: number } = {}): Promise<AdminInviteView[]> {
    const suffix = params.limit !== undefined ? `?limit=${params.limit}` : "";
    return this.request("GET", `/admin/invites${suffix}`);
  }
  createSignupInvite(daysValid?: number): Promise<AdminInviteView> {
    return this.request("POST", "/admin/invites", daysValid ? { days_valid: daysValid } : {});
  }
  revokeSignupInvite(id: string): Promise<void> {
    return this.request("DELETE", `/admin/invites/${id}`);
  }

  getAdminSettings(): Promise<AdminSettingsView> {
    return this.request("GET", "/admin/settings");
  }
  updateAdminSettings(settings: { signup_enabled: boolean }): Promise<AdminSettingsView> {
    return this.request("PATCH", "/admin/settings", settings);
  }
  listAudit(
    params: {
      limit?: number;
      beforeId?: number;
    } = {},
  ): Promise<AdminAuditEntry[]> {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.beforeId !== undefined) q.set("before_id", String(params.beforeId));
    const suffix = q.toString();
    return this.request("GET", `/admin/audit${suffix ? `?${suffix}` : ""}`);
  }

  /** Ops of a shared project whose key we lack are all deferred, so members never get half an edit. */
  async syncPush(
    ops: Operation[],
  ): Promise<{ cursor: number; applied: number; from?: number; deferred: string[] }> {
    const keyring = this.unlockedKeyring();
    const store = this.scopeStore ?? EMPTY_SCOPE_STORE;
    const batch = batchLinksOf(ops);
    const shared = sharedProjectIds(store);
    const scopes = ops.map((op) => resolveScope(store, op.entity, op.entityId, batch));
    const blocked = (i: number) => {
      const scope = scopes[i]!;
      return (
        scope.kind === "project" &&
        shared.has(scope.projectId) &&
        !keyring.getProjectKey(scope.projectId)
      );
    };
    const deferred: string[] = [];
    const wireOps: WireOp[] = [];
    ops.forEach((op, i) => {
      if (blocked(i)) deferred.push(op.id);
      else wireOps.push(encodeWireOp(op, keyring, () => keyForScope(keyring, scopes[i]!, shared)));
    });
    if (wireOps.length === 0) return { cursor: 0, applied: 0, deferred };
    const res = await this.request<{ cursor: number; applied: number; from?: number }>(
      "POST",
      "/sync/push",
      { operations: wireOps },
    );
    return { ...res, deferred };
  }
  async syncPull(
    since: number,
  ): Promise<{ operations: Operation[]; cursor: number; repairs: Repair[] }> {
    this.unlockedKeyring();
    const res = await this.request<{ operations: WireOp[]; cursor: number }>(
      "GET",
      `/sync/pull?since=${since}`,
    );
    return this.decodeWirePayload(res);
  }
  /** `next` is the previous page's opaque token, sent back verbatim; absent in the result means last page. */
  async syncSnapshot(
    next?: string,
  ): Promise<{ operations: Operation[]; cursor: number; next?: string; repairs: Repair[] }> {
    this.unlockedKeyring();
    const q =
      next === undefined
        ? `?limit=${SNAPSHOT_PAGE_KEYS}`
        : `?next=${encodeURIComponent(next)}&limit=${SNAPSHOT_PAGE_KEYS}`;
    const res = await this.request<{ operations: WireOp[]; cursor: number; next?: string }>(
      "GET",
      `/sync/snapshot${q}`,
    );
    return { ...this.decodeWirePayload(res), next: res.next };
  }
  /** The one decode path for pull, snapshot and websocket payloads. Throws on a malformed payload. */
  decodeWirePayload(payload: unknown): {
    operations: Operation[];
    cursor: number;
    from?: number;
    repairs: Repair[];
  } {
    const keyring = this.unlockedKeyring();
    if (typeof payload !== "object" || payload === null) throw new Error("malformed sync payload");
    const operations = (payload as { operations?: unknown }).operations;
    const cursor = (payload as { cursor?: unknown }).cursor;
    const from = (payload as { from?: unknown }).from;
    if (!Array.isArray(operations) || typeof cursor !== "number")
      throw new Error("malformed sync payload");
    const wireOps = operations as WireOp[];
    const store = this.scopeStore ?? EMPTY_SCOPE_STORE;
    const legacy = !this.isLegacyMigrated();
    // Legacy rows (protocol 6) carry their links in plaintext, so their scopes resolve first.
    const legacyLinks = batchLinksOf(
      wireOps.filter((w) => isLegacyWireKind(w.entity)).map((w) => fromEncryptedWire(w, null)),
    );
    const shared = sharedProjectIds(store);
    const ctx: DecodeContext = {
      keyring,
      store: { kindOf: (id) => this.kindOfEntity(id) },
      openLegacy: (op) => {
        const at = { entity: op.entity, entityId: op.entityId, field: op.field, ts: op.ts };
        const trustState = op.entity === "preference" && op.entityId === KEY_TRUST_ID;
        if (!isEncryptedEnvelope(op.value)) {
          // Plaintext in an encrypted field: old-client content before the legacy migration;
          // after it, only a forgery.
          if (!legacy || trustState) {
            console.warn(
              `[atlas-e2ee] dropped plaintext in ${op.entity}.${op.field} (${op.entityId})`,
            );
            return null;
          }
          return op;
        }
        const expected = expectedKeyScope(
          keyring,
          resolveScope(store, op.entity, op.entityId, legacyLinks),
          shared,
        );
        const opened = openFieldValue(
          keyring,
          op.value,
          at,
          expected,
          openOptionsFor(op.entity, op.entityId, legacy),
        );
        if (!opened) {
          // Kept as the envelope: a key that arrives later may open it where it is.
          console.warn(`[atlas-e2ee] no key opens ${op.entity}.${op.field} (${op.entityId})`);
          return op;
        }
        return { ...op, value: opened.value };
      },
    };
    const decoded = decodeOps(wireOps, ctx);
    // Current values opened with the keys of the scope they arrived in; their entities' scopes are
    // known now that their links are readable.
    const batch = batchLinksOf(decoded.map((d) => d.op));
    const repairs: Repair[] = [];
    for (const d of decoded) {
      if (d.legacy || !d.opened) continue;
      const expected = expectedKeyScope(
        keyring,
        resolveScope(store, d.op.entity, d.op.entityId, batch),
        shared,
      );
      const repair = sealedRepair(d, expected, (keyId, scope) => this.isCanonical(keyId, scope));
      if (repair) repairs.push(repair);
    }
    const out = decoded.map((d) => d.op);
    return { operations: out, cursor, from: typeof from === "number" ? from : undefined, repairs };
  }
  /** The protocol 6 entities this partition still holds, a page at a time (`migrateLegacy`). */
  legacyKeys(next?: string): Promise<LegacyKeysPage> {
    const q = next === undefined ? "" : `?next=${encodeURIComponent(next)}`;
    return this.request("GET", `/sync/legacy/keys${q}`);
  }
  /** Drop re-encoded protocol 6 entities from this partition; answers how many it still held. */
  async dropLegacy(keys: { entity: string; entity_id: string }[]): Promise<number> {
    const res = await this.request<{ dropped: number }>("POST", "/sync/legacy/drop", {
      entities: keys,
    });
    return res.dropped;
  }
  /**
   * Whether this account may re-write every field of the entity: its own activity only (the server
   * names the pusher as the actor), a shared project only as its owner (archive and delete are
   * owner-only), a shared project's item only as an active member.
   */
  mayReencode(kind: Operation["entity"], entityId: string): boolean {
    const store = this.scopeStore;
    const user = this.scopeUserId;
    if (!store || !user) return false;
    if (kind === "activity" && store.rawField("activity", entityId, "actor_id") !== user) {
      return false;
    }
    const scope = resolveScope(store, kind, entityId);
    if (scope.kind === "unknown") return false;
    if (scope.kind === "personal") return true;
    const rows = store
      .list("project_member")
      .filter((e) => e.fields.project_id === scope.projectId && e.fields.state === "active");
    if (rows.length === 0) return true; // unshared: the account's own
    const mine = rows.find((e) => e.fields.user_id === user);
    if (!mine) return false;
    return kind !== "project" || mine.fields.role === "owner";
  }
  /** WebSockets cannot set headers and proxies may log the URL, so it carries a single-use 30 s ticket, never the access token. */
  async syncWsUrl(since: number): Promise<string | null> {
    if (!this.token) return null;
    const { ticket } = await this.request<{ ticket: string }>("POST", "/sync/ws-ticket");
    return buildSyncWsUrl(this.baseUrl, ticket, since);
  }

  listMembers(projectId: string): Promise<MemberView[]> {
    return this.request("GET", `/projects/${projectId}/members`);
  }
  /** `preview`: what the invitee is shown before accepting (`sealInvitePreview`). */
  inviteMember(
    projectId: string,
    email: string,
    role: MemberRole,
    preview?: SealedInvitePreview,
  ): Promise<MemberView> {
    return this.request("POST", `/projects/${projectId}/members`, {
      email,
      role,
      ...(preview ? { preview } : {}),
    });
  }
  acceptInvite(projectId: string): Promise<void> {
    return this.request("POST", `/projects/${projectId}/accept`);
  }
  declineInvite(projectId: string): Promise<void> {
    return this.request("POST", `/projects/${projectId}/decline`);
  }
  updateMemberRole(projectId: string, userId: string, role: MemberRole): Promise<MemberView> {
    return this.request("PATCH", `/projects/${projectId}/members/${userId}`, { role });
  }
  removeMember(projectId: string, userId: string): Promise<void> {
    return this.request("DELETE", `/projects/${projectId}/members/${userId}`);
  }
  claimProjectOwnership(projectId: string): Promise<MemberView> {
    return this.request("POST", `/projects/${projectId}/claim-ownership`);
  }
  listInvites(): Promise<InviteView[]> {
    return this.request("GET", "/invites");
  }
}
