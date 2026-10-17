import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Task } from "@atlastodo/client-core";
import { cursorStep } from "@atlastodo/shared";
import { useScreenFocused } from "./ScreenFocusContext";

/**
 * The web keyboard cursor: a single "focused row" over the on-screen task list, driven by
 * j/k/o/c/x/t (see `@atlastodo/shared`'s `dispatchHotkey`). The hotkey listener lives at the app root
 * while lists live in screens, so the active list registers its rows and actions here. Inert on
 * native (no hardware keyboard).
 */

/** The on-screen list the cursor acts on. Registered through {@link useCursorList}. */
export interface ActiveList {
  /** The visible rows in display order (read lazily, so the registration survives task changes). */
  getTasks: () => Task[];
  open: (task: Task) => void;
  toggle: (task: Task) => void;
  reschedule: (task: Task) => void;
  remove: (task: Task) => void;
}

export interface CursorContextValue {
  /** The focused row id, or null. Consumed by the list to highlight the row. */
  cursorId: string | null;
  /** Register the active list; pass the same object to {@link clearActiveList}. */
  setActiveList: (list: ActiveList) => void;
  clearActiveList: (list: ActiveList) => void;
  next: () => void;
  prev: () => void;
  openCursor: () => void;
  completeCursor: () => void;
  rescheduleCursor: () => void;
  deleteCursor: () => void;
  /**
   * Register a quick-add input of the focused screen (see {@link useQuickAddHotkeyTarget}); returns
   * the unregister.
   */
  registerQuickAdd: (focus: () => void) => () => void;
  /** Focus the focused screen's first quick-add (a / q); false when there is none. */
  focusQuickAdd: () => boolean;
}

const CursorContext = createContext<CursorContextValue | null>(null);

export function CursorProvider({ children }: { children: ReactNode }) {
  const [cursorId, setCursorId] = useState<string | null>(null);
  // Mirrored in a ref so the stable action closures read the latest value.
  const cursorRef = useRef<string | null>(null);
  const activeRef = useRef<ActiveList | null>(null);
  // The focused screen's quick-add inputs, in mount order (the top one first).
  const quickAdds = useRef<(() => void)[]>([]);
  const registerQuickAdd = useCallback((focus: () => void) => {
    quickAdds.current = [...quickAdds.current, focus];
    return () => {
      quickAdds.current = quickAdds.current.filter((f) => f !== focus);
    };
  }, []);
  const focusQuickAdd = useCallback(() => {
    const first = quickAdds.current[0];
    if (!first) return false;
    first();
    return true;
  }, []);

  const setActiveList = useCallback((list: ActiveList) => {
    activeRef.current = list;
    // A new screen's list starts with no focused row.
    cursorRef.current = null;
    setCursorId(null);
  }, []);
  const clearActiveList = useCallback((list: ActiveList) => {
    // On navigation the next screen may register before the old one's cleanup runs.
    if (activeRef.current === list) {
      activeRef.current = null;
      cursorRef.current = null;
      setCursorId(null);
    }
  }, []);

  const move = useCallback((dir: 1 | -1) => {
    const list = activeRef.current;
    if (!list) return;
    const nextId = cursorStep(
      list.getTasks().map((t) => t.id),
      cursorRef.current,
      dir,
    );
    cursorRef.current = nextId;
    setCursorId(nextId);
  }, []);

  // Run an action against the focused row, if still present. A locked row (undecryptable here)
  // only opens: other actions would write a task nobody here can read.
  const act = useCallback((pick: (list: ActiveList) => (task: Task) => void, writes = true) => {
    const list = activeRef.current;
    const id = cursorRef.current;
    if (!list || id == null) return;
    const task = list.getTasks().find((t) => t.id === id);
    if (task && !(writes && task.locked)) pick(list)(task);
  }, []);

  const value = useMemo<CursorContextValue>(
    () => ({
      cursorId,
      setActiveList,
      clearActiveList,
      next: () => move(1),
      prev: () => move(-1),
      openCursor: () => act((l) => l.open, false),
      completeCursor: () => act((l) => l.toggle),
      rescheduleCursor: () => act((l) => l.reschedule),
      deleteCursor: () => act((l) => l.remove),
      registerQuickAdd,
      focusQuickAdd,
    }),
    [cursorId, setActiveList, clearActiveList, move, act, registerQuickAdd, focusQuickAdd],
  );

  return <CursorContext.Provider value={value}>{children}</CursorContext.Provider>;
}

export function useCursor(): CursorContextValue {
  const ctx = useContext(CursorContext);
  if (!ctx) throw new Error("useCursor must be used within a CursorProvider");
  return ctx;
}

/**
 * Make `list` the one the cursor acts on while its screen is focused, and return the cursor's row id
 * for highlighting (null while unfocused).
 *
 * Registered on focus, not mount: the drawer/tabs keep visited screens mounted, so a list
 * registered on mount would take keys for rows nobody can see. Losing focus clears the registration
 * and the cursor. `list` may be a fresh object every render; a stable wrapper reads the latest
 * through a ref, so a re-render never resets the cursor.
 */
export function useCursorList(list: ActiveList): string | null {
  const { cursorId, setActiveList, clearActiveList } = useCursor();
  const focused = useScreenFocused();
  const latest = useRef(list);
  latest.current = list;
  const stable = useRef<ActiveList | null>(null);
  if (!stable.current) {
    stable.current = {
      getTasks: () => latest.current.getTasks(),
      open: (task) => latest.current.open(task),
      toggle: (task) => latest.current.toggle(task),
      reschedule: (task) => latest.current.reschedule(task),
      remove: (task) => latest.current.remove(task),
    };
  }
  useEffect(() => {
    if (!focused) return;
    const registered = stable.current!;
    setActiveList(registered);
    return () => clearActiveList(registered);
  }, [focused, setActiveList, clearActiveList]);
  return focused ? cursorId : null;
}

/**
 * Make a quick-add input the target of the a / q shortcut while its screen is focused. The first
 * one mounted on the screen (the one at the top) wins. Inert outside a `CursorProvider`.
 */
export function useQuickAddHotkeyTarget(focus: () => void): void {
  const register = useContext(CursorContext)?.registerQuickAdd;
  const focused = useScreenFocused();
  const latest = useRef(focus);
  latest.current = focus;
  useEffect(() => {
    if (!register || !focused) return;
    return register(() => latest.current());
  }, [register, focused]);
}
