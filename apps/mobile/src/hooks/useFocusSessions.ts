import { useCallback, useMemo } from "react";
import { toFocusSession, trackedMsForTask, type FocusSession } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

export interface LoggedSession {
  /** The task the time is attributed to, or `null` for an untethered session. */
  taskId: string | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface UseFocusSessions {
  sessions: FocusSession[];
  /** Sessions logged against a task, newest first. */
  forTask: (taskId: string) => FocusSession[];
  /** Total tracked focus time (ms) for a task. */
  trackedMs: (taskId: string) => number;
  /**
   * Persist a completed work session; returns its id. Zero-length sessions are ignored.
   * A `null` task is stored as an empty `task_id`, which `trackedMsForTask` never matches against a
   * real id, so untethered time counts towards the Stats totals without being attributed.
   */
  logSession: (session: LoggedSession) => string | null;
}

/**
 * Logged focus sessions: `focus_session` entities in the shared store. Ids come from
 * `store.newEntityId()` (Hermes has no global crypto).
 */
export function useFocusSessions(): UseFocusSessions {
  const { store, version, kick } = useStore();

  const sessions = useMemo(
    () => store.list("focus_session").map((e) => toFocusSession(e.id, e.fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const forTask = useCallback(
    (taskId: string) =>
      sessions.filter((s) => s.task_id === taskId).sort((a, b) => b.started_at - a.started_at),
    [sessions],
  );

  const trackedMs = useCallback((taskId: string) => trackedMsForTask(sessions, taskId), [sessions]);

  const logSession = useCallback(
    ({ taskId, startedAt, endedAt, durationMs }: LoggedSession) => {
      if (durationMs <= 0) return null;
      const id = store.newEntityId();
      store.set("focus_session", id, "task_id", taskId ?? "");
      store.set("focus_session", id, "started_at", startedAt);
      store.set("focus_session", id, "ended_at", endedAt);
      store.set("focus_session", id, "duration_ms", durationMs);
      store.set("focus_session", id, "created_at", Date.now());
      kick();
      return id;
    },
    [store, kick],
  );

  return { sessions, forTask, trackedMs, logSession };
}
