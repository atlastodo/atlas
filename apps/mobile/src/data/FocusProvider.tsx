import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  advance,
  phaseDurationMs,
  rehydrateRun,
  type Phase,
  type PomodoroConfig,
  type RunSnapshot,
} from "@atlastodo/shared";
import { useFocusSessions } from "../hooks/useFocusSessions";
import { usePomodoroConfig } from "../hooks/usePomodoroConfig";
import { usePreferences } from "../hooks/usePreferences";
import { AuthContext } from "../auth/AuthContext";
import { chime } from "../lib/chime";
import { haptics } from "../lib/haptics";
import {
  FOCUS_PHASE_ID,
  cancelScheduled,
  onNotificationsReset,
  scheduleNotification,
} from "../lib/notify";

/** A run that could not be saved or cleared is only a lost resume -- never worth a crash report. */
function ignoreStorageError(err: unknown): void {
  console.warn("[atlas focus] could not persist the focus run:", err);
}

/**
 * The running pomodoro/focus timer. Lives in a provider so it survives navigation, and logs a
 * `focus_session` with the actually-focused time when a work phase ends (naturally, skipped or
 * stopped).
 *
 * Every phase begins on a deliberate tap: when a clock runs out the run parks on the next phase at
 * full length with `awaitingStart` set. A run that is not running consumes no wall time, so nothing
 * is replayed for a closed app.
 *
 * A phone suspends JS timers in the background, so the clock is kept honest three ways: the tick
 * measures a wall-clock delta, `AppState` triggers a recompute on foreground, and the phase's end
 * instant is handed to the OS as a scheduled notification. The persisted run is restored in an
 * effect after mount (AsyncStorage is async) and recomputed by the shared `rehydrateRun`.
 *
 * The run belongs to the signed-in account: persisted per user, and a sign-out
 * (`cancelAllAppNotifications`) drops it along with its alarm.
 */
export interface FocusContextValue {
  active: boolean;
  taskId: string | null;
  phase: Phase;
  remainingMs: number;
  running: boolean;
  /** The phase is loaded at full length but not started: the UI offers "Start break", not "Resume". */
  awaitingStart: boolean;
  completedWork: number;
  config: PomodoroConfig;
  /** Begin a fresh run. `null` starts an untethered session, tracked but attributed to no task. */
  start: (taskId: string | null) => void;
  pause: () => void;
  /** Resume a paused phase, or start one that is awaiting its first tap -- the same verb for both. */
  resume: () => void;
  skip: () => void;
  stop: () => void;
}

const FocusContext = createContext<FocusContextValue | null>(null);

const TICK_MS = 1000;

/** Book the phase-end alert for `at` in `t`'s language; one id, so it replaces any pending one. */
function bookFocusAlarm(t: TFunction, at: number, phase: RunSnapshot["phase"]): void {
  const work = phase === "work";
  void scheduleNotification(
    t(work ? "focus.alertWorkTitle" : "focus.alertBreakTitle"),
    t(work ? "focus.alertWorkBody" : "focus.alertBreakBody"),
    at,
    FOCUS_PHASE_ID,
  );
}
/** AsyncStorage key prefix for the running timer (device-local, not synced). */
const FOCUS_RUN_KEY = "atlas.focusRun";

/** Per account: a run resumed under someone else's session would bank its focus time there. */
function focusRunKey(userId: string): string {
  return `${FOCUS_RUN_KEY}:${userId}`;
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const userId = useContext(AuthContext)?.session?.user.id ?? null;
  // Keyed by account, so another user never inherits the in-memory run of the one before.
  return (
    <FocusRunProvider key={userId ?? ""} runKey={userId ? focusRunKey(userId) : null}>
      {children}
    </FocusRunProvider>
  );
}

/** The provider proper, for one account. `runKey` is null without a session: nothing persists. */
function FocusRunProvider({ runKey, children }: { runKey: string | null; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { config } = usePomodoroConfig();
  const { logSession } = useFocusSessions();
  const { focusSoundEnabled } = usePreferences();

  const [run, setRun] = useState<RunSnapshot | null>(null);
  const lastTick = useRef<number>(Date.now());

  // Latest values for intervals and listeners, without re-subscribing them on every change.
  const configRef = useRef(config);
  configRef.current = config;
  const runRef = useRef<RunSnapshot | null>(run);
  runRef.current = run;
  const soundRef = useRef(focusSoundEnabled);
  soundRef.current = focusSoundEnabled;
  const tRef = useRef(t);
  tRef.current = t;

  /** The instant the OS alert is currently set for, so ticking does not reschedule it every second. */
  const alarmAt = useRef<number | null>(null);

  /**
   * Hand the running phase's end instant to the OS as one scheduled notification, or take it back
   * when paused, awaiting a tap or stopped. Inert on web, where the in-app tick is the only alert.
   */
  const syncAlarm = useCallback((next: RunSnapshot | null) => {
    const at = next?.running ? Date.now() + next.remainingMs : null;
    if (at === null) {
      if (alarmAt.current === null) return;
      alarmAt.current = null;
      void cancelScheduled(FOCUS_PHASE_ID);
      return;
    }
    // `now + remaining` drifts a few ms per tick; only a real move (resume, skip, new phase) is
    // worth another round trip to the OS.
    if (alarmAt.current !== null && Math.abs(at - alarmAt.current) < 2 * TICK_MS) return;
    alarmAt.current = at;
    bookFocusAlarm(tRef.current, at, next!.phase);
  }, []);

  // The pending alert keeps the text it was booked with, so a language change books it again.
  const language = i18n.language;
  const alarmLanguage = useRef(language);
  useEffect(() => {
    if (alarmLanguage.current === language) return;
    alarmLanguage.current = language;
    const at = alarmAt.current;
    const current = runRef.current;
    if (at !== null && current?.running) bookFocusAlarm(tRef.current, at, current.phase);
  }, [language]);

  /** Commit a run state; every mutation goes through here so state, ref and OS alert stay in step. */
  const apply = useCallback(
    (next: RunSnapshot | null) => {
      runRef.current = next;
      setRun(next);
      syncAlarm(next);
    },
    [syncAlarm],
  );

  /**
   * Recompute the run against the wall clock, banking any work phase that finished in the meantime.
   * `accurateAt` is the last instant the snapshot was known to be correct.
   */
  const catchUp = useCallback(
    (snapshot: RunSnapshot, accurateAt: number) => {
      const { run: next, sessions } = rehydrateRun(
        snapshot,
        accurateAt,
        Date.now(),
        configRef.current,
      );
      for (const s of sessions) logSession(s);
      lastTick.current = Date.now();
      apply(next);
    },
    [logSession, apply],
  );

  // Restore any persisted run once, on mount; the rehydrate logs a work phase that finished while closed.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    // A run saved under the unscoped key cannot be tied to an account, so it is never resumed.
    // Storage failures here are caught: an uncaught rejection would be filed as a crash.
    AsyncStorage.removeItem(FOCUS_RUN_KEY).catch(ignoreStorageError);
    if (!runKey) return;
    let cancelled = false;
    AsyncStorage.getItem(runKey)
      .catch(() => null)
      .then((raw) => {
        if (cancelled || !raw) return;
        let saved: (RunSnapshot & { savedAt?: number }) | null = null;
        try {
          saved = JSON.parse(raw) as RunSnapshot & { savedAt?: number };
        } catch {
          return;
        }
        if (!saved || typeof saved.savedAt !== "number") return;
        // `null` is a valid taskId (an untethered run); only a wrong type is rejected.
        if (saved.taskId !== null && typeof saved.taskId !== "string") return;
        const { savedAt, ...snapshot } = saved;
        // Absent `awaitingStart` means "not awaiting".
        catchUp({ ...snapshot, awaitingStart: snapshot.awaitingStart === true }, savedAt);
      });
    return () => {
      cancelled = true;
    };
  }, [catchUp, runKey]);

  // Persist the run on every change; clear it when the run ends.
  useEffect(() => {
    if (!runKey) return;
    const saved = run
      ? AsyncStorage.setItem(runKey, JSON.stringify({ ...run, savedAt: Date.now() }))
      : AsyncStorage.removeItem(runKey);
    saved.catch(ignoreStorageError);
  }, [run, runKey]);

  // The session ended, and every notification with it: drop the run rather than leave it for the
  // next sign-in. The key is removed explicitly; the provider unmounts before the persist effect runs.
  useEffect(
    () =>
      onNotificationsReset(() => {
        apply(null);
        if (runKey) AsyncStorage.removeItem(runKey).catch(ignoreStorageError);
      }),
    [apply, runKey],
  );

  // JS timers are suspended in the background, so recompute from `lastTick` (the last instant the
  // run was accurate). No alert here: the OS notification already announced the phase end.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      const r = runRef.current;
      if (state !== "active" || !r?.running) return;
      catchUp(r, lastTick.current);
    });
    return () => sub.remove();
  }, [catchUp]);

  const flushWork = useCallback(
    (r: RunSnapshot, now: number) => {
      if (r.phase === "work" && r.workElapsedMs > 0) {
        logSession({
          taskId: r.taskId,
          startedAt: r.workStartedAt,
          endedAt: now,
          durationMs: r.workElapsedMs,
        });
      }
    },
    [logSession],
  );

  const advancePhase = useCallback(
    (r: RunSnapshot, now: number): RunSnapshot => {
      flushWork(r, now);
      const { phase, completedWork } = advance(
        { phase: r.phase, completedWork: r.completedWork },
        configRef.current,
      );
      return {
        ...r,
        phase,
        completedWork,
        remainingMs: phaseDurationMs(phase, configRef.current),
        running: false,
        awaitingStart: true,
        workStartedAt: now,
        workElapsedMs: 0,
      };
    },
    [flushWork],
  );

  // Reading the run from a ref rather than a `setRun` updater keeps the phase-end side effects
  // (logging, alerting) out of the reducer, which React may invoke twice.
  useEffect(() => {
    if (!run?.running) return;
    lastTick.current = Date.now();
    const id = setInterval(() => {
      const prev = runRef.current;
      if (!prev?.running) return;
      const now = Date.now();
      const delta = now - lastTick.current;
      lastTick.current = now;
      const ticked: RunSnapshot = {
        ...prev,
        remainingMs: prev.remainingMs - delta,
        workElapsedMs: prev.phase === "work" ? prev.workElapsedMs + delta : prev.workElapsedMs,
      };
      if (ticked.remainingMs > 0) {
        apply(ticked);
        return;
      }
      // Alert here; the notification's foreground banner is silent so the two do not double up.
      apply(advancePhase(ticked, now));
      haptics.success();
      if (soundRef.current) chime();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [run?.running, advancePhase, apply]);

  const start = useCallback(
    (taskId: string | null) => {
      const now = Date.now();
      lastTick.current = now;
      apply({
        taskId,
        phase: "work",
        completedWork: 0,
        remainingMs: phaseDurationMs("work", configRef.current),
        running: true,
        awaitingStart: false,
        workStartedAt: now,
        workElapsedMs: 0,
      });
    },
    [apply],
  );

  const pause = useCallback(() => {
    const r = runRef.current;
    if (r) apply({ ...r, running: false });
  }, [apply]);

  const resume = useCallback(() => {
    const r = runRef.current;
    if (!r) return;
    const now = Date.now();
    lastTick.current = now;
    apply({
      ...r,
      running: true,
      awaitingStart: false,
      // Beginning a phase (not un-pausing) starts its clock, so `started_at` is when work began.
      workStartedAt: r.awaitingStart ? now : r.workStartedAt,
    });
  }, [apply]);

  const skip = useCallback(() => {
    const r = runRef.current;
    if (r) apply(advancePhase(r, Date.now()));
  }, [apply, advancePhase]);

  const stop = useCallback(() => {
    const r = runRef.current;
    if (r) flushWork(r, Date.now());
    apply(null);
  }, [apply, flushWork]);

  const value = useMemo<FocusContextValue>(
    () => ({
      active: run !== null,
      taskId: run?.taskId ?? null,
      phase: run?.phase ?? "work",
      remainingMs: run?.remainingMs ?? 0,
      running: run?.running ?? false,
      awaitingStart: run?.awaitingStart ?? false,
      completedWork: run?.completedWork ?? 0,
      config,
      start,
      pause,
      resume,
      skip,
      stop,
    }),
    [run, config, start, pause, resume, skip, stop],
  );

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error("useFocus must be used within a FocusProvider");
  return ctx;
}
