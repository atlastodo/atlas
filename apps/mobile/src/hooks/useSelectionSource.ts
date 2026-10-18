import { useEffect, useRef } from "react";
import type { Task } from "@atlastodo/client-core";
import { useSelection } from "../data/SelectionProvider";
import { useScreenFocused } from "../data/ScreenFocusContext";

/**
 * Register a list's tasks as the current selection source, so "select all" works from any list
 * surface without threading ids through every screen, and prune the selection as the list changes.
 *
 * Two sets answer different questions:
 *
 * - `shown`: the rows on screen (a collapsed group's rows are excluded). It is what "select all"
 *   means, registered via `setVisibleIds`.
 * - `known`: every task the list contains, collapsed groups included, defaulting to `shown`. The
 *   prune runs against this: pruning against `shown` would drop a selected task that is merely
 *   off-screen (collapsed, or absent for a frame during a re-derive).
 *
 * Only the focused screen participates. The drawer/tabs keep visited screens mounted, so a
 * background list would leave its ids in the shared slot ("select all" grabbing another view's
 * tasks) and prune the focused screen's selection. A selection is also scoped to its view: it is
 * cleared when the list loses focus.
 */
export function useSelectionSource(shown: Task[], known: Task[] = shown): void {
  const { setVisibleIds, selected, retain, mode, clear } = useSelection();
  const focused = useScreenFocused();
  const shownIds = shown.map((t) => t.id).join(",");
  const knownIds = known.map((t) => t.id).join(",");

  // Own the "select all" source only while focused, and give it up on blur.
  useEffect(() => {
    if (!focused) return;
    setVisibleIds(shownIds === "" ? [] : shownIds.split(","));
  }, [focused, shownIds, setVisibleIds]);
  useEffect(() => {
    if (!focused) return;
    return () => setVisibleIds(null);
  }, [focused, setVisibleIds]);

  // A selection is scoped to its view: clear it when this list loses focus.
  const wasFocused = useRef(focused);
  useEffect(() => {
    if (wasFocused.current && !focused) clear();
    wasFocused.current = focused;
  }, [focused, clear]);

  useEffect(() => {
    if (!focused || !mode || selected.size === 0) return;
    const knownList = knownIds === "" ? [] : knownIds.split(",");
    // An empty list is almost always a transient re-derive frame; pruning would drop the whole selection.
    if (knownList.length === 0) return;
    const present = new Set(knownList);
    // Select mode stays on even if the selection empties; the toolbar's Clear/Exit leaves it.
    if ([...selected].some((id) => !present.has(id))) retain(knownList);
  }, [focused, knownIds, selected, retain, mode]);
}
