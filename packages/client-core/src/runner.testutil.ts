/**
 * What the tests need of a test runner beyond `bun:test`'s `vi`: an advance of the fake clock
 * that lets promise continuations run between timers, polling until an assertion holds, and
 * a mock's type for a function a fake installed with `vi.fn`.
 */
import { vi, type Mock } from "bun:test";

/** Lets every pending promise continuation run. `setImmediate` is not faked by `bun:test`. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Advances the fake clock by `ms`, one millisecond at a time, running the promise
 * continuations of each due timer before the next: a timer a continuation schedules fires
 * within this advance when it falls due inside it, as it would in real time.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  const target = Date.now() + ms;
  await flush();
  while (Date.now() < target) {
    // With no timer pending, nothing can fire in between: jump to the target.
    vi.advanceTimersByTime(vi.getTimerCount() === 0 ? target - Date.now() : 1);
    await flush();
  }
}

/** Real milliseconds: `process.hrtime` does not follow the fake clock. */
const realNow = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Retries `assertion` every `interval` ms until it passes, or rethrows its last failure after
 * `timeout` ms of real time. Under fake timers each retry first advances the fake clock by
 * `interval`, so timers the code under test waits on fire.
 */
export async function waitFor<T>(
  assertion: () => T | Promise<T>,
  { timeout = 1000, interval = 50 } = {},
): Promise<T> {
  const deadline = realNow() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (realNow() >= deadline) throw error;
    }
    if (vi.isFakeTimers()) {
      vi.advanceTimersByTime(interval);
      await flush();
    } else {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

/** `fn` typed as the `vi.fn` mock a fake installed in its place. */
export const mocked = <T extends (...args: never[]) => unknown>(fn: T): Mock<T> =>
  fn as unknown as Mock<T>;
