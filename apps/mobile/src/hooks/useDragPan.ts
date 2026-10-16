import { useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import type { PanGesture } from "react-native-gesture-handler";

/**
 * The pan a `ReorderableList` drags with: vertical only.
 *
 * By default the list builds a plain `Gesture.Pan()`, which activates on ~10dp in any direction, so
 * it beat `SwipeableRow`'s 12px horizontal threshold and cancelled the swipe-to-complete/reschedule
 * gesture on any reorderable list. Reordering is vertical, so the drag must not claim horizontals.
 *
 * `activeOffsetY` alone, with no `failOffsetX`: a horizontal drag then leaves this pan in `BEGAN`
 * rather than failing it. The library only ends a drag when the pan's state changes, so a pan that
 * failed before the row was lifted would never fire `onDragEnd`, leaving the row lifted for good.
 *
 * `panGesture` is the supported prop (`panActivateAfterLongPress` and `panEnabled` are deprecated).
 * One instance per list, since a gesture carries a handler tag and must not be shared between
 * `GestureDetector`s; hence the hook.
 *
 * The list still builds on gesture-handler's builder API and chains builder methods onto this pan,
 * so it must be a builder `Gesture.Pan()`. Its prop is typed with `PanGesture`, which gesture-handler
 * 3 gave to the hook-based pan, hence the cast.
 */
export function useDragPan(): PanGesture {
  return useMemo(() => Gesture.Pan().activeOffsetY([-10, 10]) as unknown as PanGesture, []);
}
