/**
 * Hybrid Logical Clock; must stay in lock-step with `crates/atlas-core/src/hlc.rs` so both sides
 * order operations identically. Timestamps compare by (wallMs, counter, node), `node` (device id)
 * being the final tiebreak.
 */

export interface Hlc {
  wallMs: number;
  counter: number;
  node: string;
}

/**
 * The largest counter a clock emits; a tick past it carries into the next millisecond (counter 0).
 * Mirrors `MAX_COUNTER` in `hlc.rs`; the server rejects pushed timestamps above it.
 */
export const MAX_COUNTER = 0xffff;

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

export class HlcClock {
  private last: Hlc;

  constructor(private readonly node: string) {
    this.last = { wallMs: 0, counter: 0, node };
  }

  current(): Hlc {
    return { ...this.last };
  }

  now(physicalMs: number): Hlc {
    const wallMs = Math.max(physicalMs, this.last.wallMs);
    const counter = wallMs === this.last.wallMs ? this.last.counter + 1 : 0;
    return this.emit(wallMs, counter);
  }

  update(remote: Hlc, physicalMs: number): Hlc {
    const wallMs = Math.max(physicalMs, this.last.wallMs, remote.wallMs);
    let counter: number;
    if (wallMs === this.last.wallMs && wallMs === remote.wallMs) {
      counter = Math.max(this.last.counter, remote.counter) + 1;
    } else if (wallMs === this.last.wallMs) {
      counter = this.last.counter + 1;
    } else if (wallMs === remote.wallMs) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }
    return this.emit(wallMs, counter);
  }

  /**
   * Sets the last stamp, backwards too. Only for a clock found running fast: the caller must pass
   * a stamp no lower than any it still has to beat.
   */
  rewind(to: Hlc): void {
    this.last = { wallMs: to.wallMs, counter: to.counter, node: this.node };
  }

  private emit(wallMs: number, counter: number): Hlc {
    this.last =
      counter > MAX_COUNTER
        ? { wallMs: wallMs + 1, counter: 0, node: this.node }
        : { wallMs, counter, node: this.node };
    return { ...this.last };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * `node` + 1, reading the uuid as a 128-bit big-endian integer (Postgres and Rust order uuids by
 * bytes). Null for the largest uuid.
 */
function uuidPlusOne(node: string): string | null {
  if (!UUID_RE.test(node)) throw new Error(`HLC node is not a uuid: ${node}`);
  const digits = node.toLowerCase().replace(/-/g, "").split("");
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = parseInt(digits[i]!, 16);
    if (d < 15) {
      digits[i] = (d + 1).toString(16);
      const hex = digits.join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    digits[i] = "0";
  }
  return null;
}

/**
 * The smallest HLC above `ts`. A repair at it beats exactly the value it repairs, loses to every
 * later edit, and is the same on every device.
 */
export function successorHlc(ts: Hlc): Hlc {
  const node = uuidPlusOne(ts.node);
  if (node === null) return { wallMs: ts.wallMs, counter: ts.counter + 1, node: MIN_UUID };
  return { wallMs: ts.wallMs, counter: ts.counter, node };
}
