import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but which always runs the latest `fn`. For event handlers
 * handed to memoised children (task rows): a fresh closure each render would re-render every one.
 *
 * Only for handlers called after commit (presses, gestures, timers), never during render: the ref
 * is updated in a layout effect, so a render would see the previous `fn`.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
