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
import { Platform } from "react-native";
import { haptics } from "../lib/haptics";

/**
 * Multi-select for task lists. On a phone: long-press a row to enter select mode, then tap rows.
 *
 * Web adds click-drag "paint" selection (`paintBegin`/`paintOver`/`paintConsumeClick` plus a
 * `window` pointerup listener). It is a mouse gesture with no phone equivalent, so rows wire it
 * through `usePaintHandlers`, a no-op on native, and the `window` listener is guarded by
 * `Platform.OS === "web"`.
 *
 * Mounted around the drawer shell, so the selection survives list re-renders but not navigation.
 */

export interface SelectionApi {
  /** Ids of the currently selected tasks. */
  selected: Set<string>;
  /** Number of selected tasks (drives the toolbar's visibility + count). */
  count: number;
  /** Whether a given task id is selected. */
  has: (id: string) => boolean;
  /** Toggle one task's selection. */
  toggle: (id: string) => void;
  /** Add ids to the selection. */
  add: (ids: string[]) => void;
  /**
   * Select every task in the registered list. Returns false, doing nothing, when none is
   * registered, so Cmd/Ctrl-A keeps the browser's meaning.
   */
  selectAll: () => boolean;
  /** Clear the selection, which also leaves select mode. */
  clear: () => void;
  /**
   * Keep only the given ids selected, to drop rows that left the list. Unlike {@link clear} it
   * never leaves select mode.
   */
  retain: (keep: string[]) => void;
  /** Whether select mode is on (the Select button or a long-press turns it on). */
  mode: boolean;
  /** Enter select mode with nothing selected yet (the visible Select button). */
  enter: () => void;
  /** Long-press a row: enter select mode and select it in one step. */
  beginWith: (id: string) => void;
  /**
   * Register the ids of the currently visible list, so `selectAll` needs no prop threading; `null`
   * when the list leaves (its screen lost focus).
   */
  setVisibleIds: (ids: string[] | null) => void;
  /**
   * Begin a click-drag "paint" anchored at `id` (web only). An already-selected anchor deselects
   * the swath, else selects. Nothing changes until the pointer crosses into another row.
   */
  paintBegin: (id: string) => void;
  /**
   * The pointer entered row `id` mid-paint: set the selection to the anchor-to-`id` range over the
   * pre-gesture snapshot, so dragging back reverts rows.
   */
  paintOver: (id: string) => void;
  /** Move mid-paint on touch by deltaY (native touch drag). */
  paintMove: (deltaY: number) => void;
  /** End any in-progress paint (touch release or cancel). */
  paintEnd: () => void;
  /** Register a rendered row's layout height for touch drag resolution. */
  registerRowHeight: (id: string, height: number) => void;
  /** Unregister a row's layout height on unmount. */
  unregisterRowHeight: (id: string) => void;
  /**
   * Read once in a row's select handler: true (and disarms) only for the anchor row's trailing
   * click after a paint that moved, so it is not toggled back.
   */
  paintConsumeClick: (id: string) => boolean;
}

const SelectionContext = createContext<SelectionApi | null>(null);

/**
 * What a task row needs from the selection: paint and row-height plumbing, all stable callbacks. A
 * separate context because the full {@link SelectionApi} changes with every selection change, and a
 * row reading it would re-render on each one; a row's own `selected` and `selectMode` come as props.
 */
export type SelectionRowApi = Pick<
  SelectionApi,
  | "paintBegin"
  | "paintOver"
  | "paintMove"
  | "paintEnd"
  | "registerRowHeight"
  | "unregisterRowHeight"
  | "paintConsumeClick"
>;

const SelectionRowContext = createContext<SelectionRowApi | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setModeState] = useState(false);
  // The active list's ids live in a ref so `selectAll` reads the latest without being recreated.
  const visibleIds = useRef<string[]>([]);
  const hasSource = useRef(false);

  // Paint state, all refs (the gesture needs no re-render of its own). The gesture is a range from
  // the anchor row to the row under the pointer; dragging back toward the anchor reverts rows to
  // their pre-gesture state. Driven from `usePaintHandlers.web.ts`.
  const painting = useRef(false);
  const paintAnchor = useRef<string | null>(null);
  const paintAnchorIndex = useRef(-1);
  const paintMoved = useRef(false);
  const paintTarget = useRef<"select" | "deselect">("select");
  const paintBase = useRef<Set<string>>(new Set());
  // Only the anchor row's trailing click is swallowed (scoped to its id, self-clearing).
  const suppressClickId = useRef<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // Lets the mount-time `pointermove` effect (empty deps) call the current `paintOver`.
  const paintOverRef = useRef<(id: string) => void>(() => {});

  const setVisibleIds = useCallback((ids: string[] | null) => {
    visibleIds.current = ids ?? [];
    hasSource.current = ids !== null;
  }, []);

  // End any paint when the pointer is released anywhere; a moved paint arms the click-swallow. Web only.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const end = () => {
      if (painting.current && paintMoved.current && paintAnchor.current) {
        const anchor = paintAnchor.current;
        suppressClickId.current = anchor;
        // Released off the anchor row: no click follows, so do not stay armed.
        setTimeout(() => {
          if (suppressClickId.current === anchor) suppressClickId.current = null;
        }, 0);
      }
      painting.current = false;
      paintAnchor.current = null;
      paintMoved.current = false;
    };
    // A document-level hit-test rather than per-row `onPointerEnter`: `SwipeableRow`'s
    // `GestureDetector` captures the pointer on the anchor, so sibling rows never fire it.
    // `elementFromPoint` is capture-immune and a captured `pointermove` still bubbles to `window`.
    // Rows carry a `data-atlas-row="<id>"` marker (`usePaintHandlers.web`'s `dataSet`).
    const move = (e: PointerEvent) => {
      if (!painting.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = (el as Element | null)?.closest?.("[data-atlas-row]");
      const id = row?.getAttribute("data-atlas-row");
      if (id) paintOverRef.current(id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const paintBegin = useCallback((id: string) => {
    painting.current = true;
    paintAnchor.current = id;
    paintMoved.current = false;
    paintBase.current = new Set(selectedRef.current);
    paintAnchorIndex.current = visibleIds.current.indexOf(id);
    paintTarget.current = selectedRef.current.has(id) ? "deselect" : "select";
  }, []);

  const paintOver = useCallback((id: string) => {
    if (!painting.current || paintAnchorIndex.current < 0) return;
    const idx = visibleIds.current.indexOf(id);
    if (idx < 0) return;
    paintMoved.current = true;
    const lo = Math.min(paintAnchorIndex.current, idx);
    const hi = Math.max(paintAnchorIndex.current, idx);
    const range = visibleIds.current.slice(lo, hi + 1);
    const select = paintTarget.current === "select";
    // From the pre-gesture base every move, so shrinking the range reverts rows.
    setSelected(() => {
      const next = new Set(paintBase.current);
      for (const x of range) {
        if (select) next.add(x);
        else next.delete(x);
      }
      return next;
    });
  }, []);
  paintOverRef.current = paintOver;

  const rowHeights = useRef<Map<string, number>>(new Map());
  const registerRowHeight = useCallback((id: string, height: number) => {
    if (height > 0) rowHeights.current.set(id, height);
  }, []);
  const unregisterRowHeight = useCallback((id: string) => {
    rowHeights.current.delete(id);
  }, []);

  const paintEnd = useCallback(() => {
    if (painting.current && paintMoved.current && paintAnchor.current) {
      const anchor = paintAnchor.current;
      suppressClickId.current = anchor;
      setTimeout(() => {
        if (suppressClickId.current === anchor) suppressClickId.current = null;
      }, 50);
    }
    painting.current = false;
    paintAnchor.current = null;
    paintMoved.current = false;
  }, []);

  const paintMove = useCallback(
    (deltaY: number) => {
      if (!painting.current || paintAnchorIndex.current < 0) return;
      if (Math.abs(deltaY) > 6) {
        paintMoved.current = true;
      }
      const ids = visibleIds.current;
      const anchorIdx = paintAnchorIndex.current;
      if (anchorIdx < 0 || anchorIdx >= ids.length) return;
      const defaultH = 56;

      let targetIdx = anchorIdx;
      if (deltaY > 0) {
        let threshold = (rowHeights.current.get(ids[anchorIdx]!) ?? defaultH) / 2;
        for (let i = anchorIdx + 1; i < ids.length; i++) {
          const h = rowHeights.current.get(ids[i]!) ?? defaultH;
          if (deltaY >= threshold) {
            targetIdx = i;
            threshold += h;
          } else {
            break;
          }
        }
      } else if (deltaY < 0) {
        const absDelta = -deltaY;
        let threshold = (rowHeights.current.get(ids[anchorIdx]!) ?? defaultH) / 2;
        for (let i = anchorIdx - 1; i >= 0; i--) {
          const h = rowHeights.current.get(ids[i]!) ?? defaultH;
          if (absDelta >= threshold) {
            targetIdx = i;
            threshold += h;
          } else {
            break;
          }
        }
      }

      const targetId = ids[targetIdx];
      if (targetId) {
        paintOver(targetId);
      }
    },
    [paintOver],
  );

  const paintConsumeClick = useCallback((id: string) => {
    if (suppressClickId.current !== id) return false;
    suppressClickId.current = null;
    return true;
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setModeState(false);
  }, []);

  const retain = useCallback((keep: string[]) => {
    const set = new Set(keep);
    setSelected((prev) => {
      if ([...prev].every((id) => set.has(id))) return prev;
      return new Set([...prev].filter((id) => set.has(id)));
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const add = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!hasSource.current) return false;
    setSelected(new Set(visibleIds.current));
    setModeState(true);
    return true;
  }, []);

  const enter = useCallback(() => setModeState(true), []);

  const beginWith = useCallback((id: string) => {
    haptics.impact("medium");
    setModeState(true);
    setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  const value = useMemo<SelectionApi>(
    () => ({
      selected,
      count: selected.size,
      has: (id) => selected.has(id),
      toggle,
      add,
      selectAll,
      clear,
      retain,
      mode,
      enter,
      beginWith,
      setVisibleIds,
      paintBegin,
      paintOver,
      paintMove,
      paintEnd,
      registerRowHeight,
      unregisterRowHeight,
      paintConsumeClick,
    }),
    [
      selected,
      mode,
      toggle,
      add,
      selectAll,
      clear,
      retain,
      enter,
      beginWith,
      setVisibleIds,
      paintBegin,
      paintOver,
      paintMove,
      paintEnd,
      registerRowHeight,
      unregisterRowHeight,
      paintConsumeClick,
    ],
  );

  const rowValue = useMemo<SelectionRowApi>(
    () => ({
      paintBegin,
      paintOver,
      paintMove,
      paintEnd,
      registerRowHeight,
      unregisterRowHeight,
      paintConsumeClick,
    }),
    [
      paintBegin,
      paintOver,
      paintMove,
      paintEnd,
      registerRowHeight,
      unregisterRowHeight,
      paintConsumeClick,
    ],
  );

  return (
    <SelectionContext.Provider value={value}>
      <SelectionRowContext.Provider value={rowValue}>{children}</SelectionRowContext.Provider>
    </SelectionContext.Provider>
  );
}

export function useSelection(): SelectionApi {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used within a SelectionProvider");
  return ctx;
}

/**
 * Like {@link useSelection} but returns `null` without a provider, for `usePaintHandlers`, which a
 * row mounts even in provider-less tests.
 */
export function useSelectionOptional(): SelectionApi | null {
  return useContext(SelectionContext);
}

/** The row-facing part of the selection ({@link SelectionRowApi}), or `null` without a provider. */
export function useSelectionRow(): SelectionRowApi | null {
  return useContext(SelectionRowContext);
}
