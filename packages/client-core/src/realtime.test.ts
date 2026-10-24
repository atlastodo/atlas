import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RealtimeClient,
  buildSyncWsUrl,
  REALTIME_BACKOFF_BASE_MS,
  REALTIME_BACKOFF_MAX_MS,
  type RealtimeClientOptions,
  type RealtimeSocket,
  type RealtimeState,
} from "./realtime";

/**
 * A controllable fake socket: the client assigns the `on*` handlers, the test drives the events.
 * Mirrors the minimal {@link RealtimeSocket} surface — no DOM, no React Native, no Node APIs.
 */
class FakeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  /** Fire the close event; `code` is the server's close code, absent for a failed handshake. */
  closeEvent(code?: number): void {
    this.onclose?.(code === undefined ? undefined : { code });
  }
}

/** A client wired to {@link FakeSocket} plus recorders; tests poke the last socket directly. */
function harness(opts: Partial<RealtimeClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const payloads: unknown[] = [];
  const states: RealtimeState[] = [];
  const closes: number[] = [];
  let issued = 0;
  // A new ticket per call, as the server issues them.
  const url = vi.fn(async () => `ws://x/sync/ws?ticket=t${++issued}&since=0`);
  const client = new RealtimeClient({
    url,
    onPayload: (p) => payloads.push(p),
    onState: (s) => states.push(s),
    onClose: (code) => closes.push(code),
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    ...opts,
  });
  return { client, sockets, payloads, states, closes, url };
}

/** Let a pending ticket request settle (the URL is asked for before each socket is made). */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("RealtimeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects with a ticket from the URL builder and reports live on open", async () => {
    const { client, sockets, states } = harness();
    client.start();
    expect(states).toEqual(["connecting"]);
    await settle();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("ws://x/sync/ws?ticket=t1&since=0");

    // The upgrade succeeded — the server redeemed the ticket.
    sockets[0]!.open();
    expect(states).toEqual(["connecting", "live"]);
    expect(client.isLive()).toBe(true);
  });

  it("delivers parsed payloads in order and skips non-text or garbage frames", async () => {
    const { client, sockets, payloads } = harness();
    client.start();
    await settle();
    const socket = sockets[0]!;
    socket.open();

    socket.message(JSON.stringify({ operations: ["backfill-op"], cursor: 5 }));
    socket.message("not json");
    socket.message(42); // the server sends only text frames
    socket.message(JSON.stringify({ operations: ["live-op"], cursor: 6 }));

    expect(payloads).toEqual([
      { operations: ["backfill-op"], cursor: 5 },
      { operations: ["live-op"], cursor: 6 },
    ]);
  });

  it("reconnects with exponential backoff after a drop and resets on a successful open", async () => {
    const { client, sockets } = harness();
    client.start();
    await settle();

    // Open, drop, reconnect: the first retry waits the base delay.
    sockets[0]!.open();
    sockets[0]!.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // Fail again without opening: the delay doubles.
    sockets[1]!.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2 - 1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    // A successful open resets the backoff: the next drop retries from the base again.
    sockets[2]!.open();
    sockets[2]!.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS - 1);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(4);
  });

  it("caps the backoff at 30s across consecutive failures", async () => {
    const { client, sockets } = harness();
    client.start();
    await settle();
    // Fail 1s, 2s, 4s, 8s, 16s, then every delay after is the cap.
    const steps = [1000, 2000, 4000, 8000, 16000];
    for (const ms of steps) {
      sockets.at(-1)!.closeEvent();
      await vi.advanceTimersByTimeAsync(ms);
    }
    sockets.at(-1)!.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_MAX_MS - 1);
    expect(sockets).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(7);
  });

  it("asks for a new ticket on every attempt, since one opens a single socket", async () => {
    const { client, sockets, url } = harness();
    client.start();
    await settle();
    sockets[0]!.closeEvent(); // a refused handshake: the ticket is spent either way
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS);
    sockets[1]!.open();
    sockets[1]!.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS);

    expect(url).toHaveBeenCalledTimes(3);
    expect(sockets.map((s) => s.url)).toEqual([
      "ws://x/sync/ws?ticket=t1&since=0",
      "ws://x/sync/ws?ticket=t2&since=0",
      "ws://x/sync/ws?ticket=t3&since=0",
    ]);
  });

  it("backs off when the ticket request fails, and keeps retrying", async () => {
    let offline = true;
    const url = vi.fn(async () => {
      if (offline) throw new Error("network down");
      return "ws://x/sync/ws?ticket=t&since=0";
    });
    const { client, sockets, states } = harness({ url });
    client.start();
    await settle();
    expect(sockets).toHaveLength(0);
    expect(states.at(-1)).toBe("connecting");

    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS); // second attempt: still offline
    expect(url).toHaveBeenCalledTimes(2);
    offline = false;
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2 - 1);
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(1);
  });

  it("waits out a refused ticket request's Retry-After when it is longer than the backoff", async () => {
    const limited = Object.assign(new Error("rate limited"), { retryAfterMs: 20_000 });
    const url = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(limited)
      .mockResolvedValue("ws://x/sync/ws?ticket=t&since=0");
    const { client, sockets } = harness({ url });
    client.start();
    await settle();

    await vi.advanceTimersByTimeAsync(20_000 - 1);
    expect(url).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(1);
  });

  it("retries without a socket while the URL builder returns null, then connects", async () => {
    let session: string | null = null;
    const { client, sockets } = harness({
      url: async () => (session ? `ws://x?ticket=${session}&since=0` : null),
    });
    client.start();
    await settle();
    expect(sockets).toHaveLength(0); // signed out: nothing to connect with

    session = "t";
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(1); // signed in; the next attempt picks it up
  });

  it("dispose closes the socket, cancels pending reconnects, and ignores late events", async () => {
    const { client, sockets, states } = harness();
    client.start();
    await settle();
    const socket = sockets[0]!;
    socket.open();
    client.dispose();

    expect(socket.closed).toBe(true);
    expect(client.isLive()).toBe(false);
    expect(states.at(-1)).toBe("off");

    // A real socket may still fire onclose after close() — it must not resurrect the client.
    socket.closeEvent();
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
  });

  it("opens no socket with a ticket that arrives after dispose", async () => {
    let issue!: (url: string) => void;
    const url = vi.fn(() => new Promise<string | null>((resolve) => (issue = resolve)));
    const { client, sockets } = harness({ url });
    client.start();
    client.dispose();
    issue("ws://x/sync/ws?ticket=late&since=0");
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_MAX_MS * 2);
    expect(sockets).toHaveLength(0);
    expect(url).toHaveBeenCalledTimes(1);
  });

  it("ignores events from a socket a newer attempt replaced", async () => {
    const { client, sockets } = harness();
    client.start();
    await settle();
    const stale = sockets[0]!;
    stale.closeEvent(); // failed handshake → schedule the retry
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(2);

    // A replaced socket's late close (a real one can still fire after close()) must be dropped:
    // no duplicate retry timer stacking another attempt.
    sockets[1]!.closeEvent(); // this one is fresh: handled, retried after 2s
    stale.closeEvent(); // stale: ignored
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2);
    expect(sockets).toHaveLength(3);
  });
});

describe("RealtimeClient close codes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects a lagged socket (1013) at the base delay so its backfill covers the drop", async () => {
    const { client, sockets } = harness();
    client.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.closeEvent(1013);
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(2);
  });

  it("backs off on repeated backfill failures (1011) even though each socket opened", async () => {
    const { client, sockets } = harness();
    client.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.closeEvent(1011);
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    sockets[1]!.closeEvent(1011);
    // A second consecutive failure waits longer than the first did.
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS * 2);
    expect(sockets).toHaveLength(3);
  });

  it("reconnects with a new ticket after the base delay when the token expired (4401)", async () => {
    const { client, sockets, url } = harness();
    client.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.closeEvent(4401);

    // The ticket request that follows refreshes the expired token, as any 401 does.
    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_BASE_MS - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(url).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it("stops for good when the session was revoked (4403) and reports it", async () => {
    const { client, sockets, closes, states, url } = harness();
    client.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.closeEvent(4403);

    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_MAX_MS * 4);
    expect(sockets).toHaveLength(1);
    expect(url).toHaveBeenCalledTimes(1);
    expect(closes).toEqual([4403]);
    expect(states.at(-1)).toBe("off");
  });

  it("stops and reports an expired cursor (4410) so the owner can re-bootstrap", async () => {
    const { client, sockets, closes } = harness();
    client.start();
    await settle();
    sockets[0]!.open();
    sockets[0]!.closeEvent(4410);

    await vi.advanceTimersByTimeAsync(REALTIME_BACKOFF_MAX_MS * 4);
    expect(sockets).toHaveLength(1);
    expect(closes).toEqual([4410]);
  });
});

describe("buildSyncWsUrl", () => {
  it("maps http(s) to ws(s), strips a trailing slash, encodes the ticket and declares the protocol", () => {
    expect(buildSyncWsUrl("https://api.example.com/", "a/b+c", 7)).toBe(
      "wss://api.example.com/sync/ws?ticket=a%2Fb%2Bc&since=7&protocol=7",
    );
    expect(buildSyncWsUrl("http://localhost:8080", "t", 0)).toBe(
      "ws://localhost:8080/sync/ws?ticket=t&since=0&protocol=7",
    );
  });
});
