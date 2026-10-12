/**
 * Realtime sync over `GET /sync/ws` (see `crates/atlas-server/src/sync/ws.rs`), authenticated by a
 * single-use ticket, not the access token. Transport only (connect, backoff, teardown);
 * `SyncClient` decodes and applies payloads. The stream only accelerates polling.
 */

/** The minimal socket surface used; satisfied by DOM and RN `WebSocket` and by test fakes. */
export interface RealtimeSocket {
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export type RealtimeState = "off" | "connecting" | "live";

/** Reconnect backoff: 1 s doubling to a 30 s cap, reset by a successful open. */
export const REALTIME_BACKOFF_BASE_MS = 1_000;
export const REALTIME_BACKOFF_MAX_MS = 30_000;

/** Close codes the server ends a sync socket with (`close_code` in `sync/ws.rs`). */
export const WS_CLOSE = {
  /** Fell behind the live stream: reconnect, and the backfill covers what was dropped. */
  LAGGED: 1013,
  /** A backfill page failed to load after the handshake. */
  BACKFILL_FAILED: 1011,
  /** The access token that asked for the socket's ticket expired: reconnect with a new ticket. */
  TOKEN_EXPIRED: 4401,
  /** The session was ended server-side; reconnecting is refused until the device signs in again. */
  SESSION_REVOKED: 4403,
  /** Retention purged ops above the cursor: the owner must re-bootstrap from the snapshot. */
  CURSOR_EXPIRED: 4410,
} as const;

function closeCodeOf(ev: unknown): number | undefined {
  const code = (ev as { code?: unknown } | null | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

function retryAfterOf(err: unknown): number | undefined {
  const ms = (err as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === "number" && ms > 0 ? ms : undefined;
}

export interface RealtimeClientOptions {
  /** Called per attempt since a ticket opens one socket; null while signed out. A rejection counts as a failed attempt. */
  url: () => Promise<string | null>;
  onPayload: (payload: unknown) => void;
  onState?: (state: RealtimeState) => void;
  /** Close that reconnecting cannot fix (4403 session revoked, 4410 cursor expired); the client has stopped. */
  onClose?: (code: number) => void;
  socketFactory?: (url: string) => RealtimeSocket;
}

/**
 * Sent on every request (`x-atlas-sync-protocol`) and in the WebSocket URL; the server answers 426
 * below its minimum. 4: `__enc: 2`, 5: ticket instead of token in the URL, 6: key rotations.
 */
export const SYNC_PROTOCOL = 6;

/** The protocol rides as a param since headers are unavailable. */
export function buildSyncWsUrl(baseUrl: string, ticket: string, since: number): string {
  const base = baseUrl.replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/sync/ws?ticket=${encodeURIComponent(ticket)}&since=${since}&protocol=${SYNC_PROTOCOL}`;
}

function defaultSocketFactory(url: string): RealtimeSocket {
  return new WebSocket(url) as unknown as RealtimeSocket;
}

export class RealtimeClient {
  private readonly opts: RealtimeClientOptions;
  private readonly socketFactory: (url: string) => RealtimeSocket;

  private socket: RealtimeSocket | null = null;
  private state: RealtimeState = "off";
  private started = false;
  private stopped = false;
  private attemptId = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = REALTIME_BACKOFF_BASE_MS;
  /** Consecutive 1011 closes; each socket opened (resetting `backoffMs`), so this keeps a failing backfill from retrying every second. */
  private backfillFailures = 0;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
  }

  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    this.attempt();
  }

  dispose(): void {
    this.stopped = true;
    this.attemptId++; // invalidate any in-flight socket's handlers
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState("off");
  }

  isLive(): boolean {
    return this.state === "live";
  }

  currentState(): RealtimeState {
    return this.state;
  }

  private setState(state: RealtimeState): void {
    if (state !== this.state) {
      this.state = state;
      this.opts.onState?.(state);
    }
  }

  private attempt(): void {
    if (this.stopped) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const id = ++this.attemptId;
    this.setState("connecting");
    void this.connect(id);
  }

  private async connect(id: number): Promise<void> {
    let url: string | null;
    try {
      url = await this.opts.url();
    } catch (err) {
      if (this.stopped || id !== this.attemptId) return;
      // No ticket: offline, the server down or refusing. A 429 names its own wait.
      this.scheduleReconnect(undefined, retryAfterOf(err));
      return;
    }
    // Disposed or superseded while the ticket was in flight: unused.
    if (this.stopped || id !== this.attemptId) return;
    // Signed out (or nothing to connect to): retry later, a session may appear.
    if (!url) {
      this.scheduleReconnect();
      return;
    }

    const socket = this.socketFactory(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.stopped || id !== this.attemptId) return;
      this.backoffMs = REALTIME_BACKOFF_BASE_MS; // a working connection resets the backoff
      this.setState("live");
    };
    socket.onmessage = (ev) => {
      if (this.stopped || id !== this.attemptId) return;
      // The server sends only text frames, each a self-contained pull-shaped payload.
      if (typeof ev.data !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // a garbage frame is skipped; polling reconciles anything it contained
      }
      this.opts.onPayload(payload);
    };
    // onclose always follows onerror, and a rejected upgrade produces both without an open, so
    // close is the single failure handler.
    socket.onerror = () => {};
    socket.onclose = (ev) => {
      if (this.stopped || id !== this.attemptId) return;
      this.socket = null;
      const code = closeCodeOf(ev);
      if (code === WS_CLOSE.SESSION_REVOKED || code === WS_CLOSE.CURSOR_EXPIRED) {
        // Reconnecting would be refused, or would skip purged ops: stop and let the owner act.
        this.dispose();
        this.opts.onClose?.(code);
        return;
      }
      if (code === WS_CLOSE.BACKFILL_FAILED) {
        this.setState("connecting");
        this.backfillFailures++;
        this.scheduleReconnect(
          Math.min(REALTIME_BACKOFF_BASE_MS * 2 ** this.backfillFailures, REALTIME_BACKOFF_MAX_MS),
        );
        return;
      }
      this.backfillFailures = 0;
      this.setState("connecting");
      if (code === WS_CLOSE.TOKEN_EXPIRED) {
        // The session's access token ran out; the next ticket request gets a 401 and refreshes it.
        // The base delay keeps us past the expiry.
        this.scheduleReconnect(REALTIME_BACKOFF_BASE_MS);
        return;
      }
      // Dropped, or never opened: the server down, the network gone, or the ticket refused. The
      // next attempt asks for a new ticket after the backoff.
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(delayMs?: number, atLeastMs?: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer); // replace, never stack two pending retries
    let delay = delayMs;
    if (delay === undefined) {
      delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, REALTIME_BACKOFF_MAX_MS);
    }
    if (atLeastMs !== undefined) delay = Math.max(delay, atLeastMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attempt();
    }, delay);
  }
}
