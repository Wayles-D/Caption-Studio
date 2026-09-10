import { useEffect } from 'react';

/**
 * Calls `handler` on any pointerdown outside every ref in `refs`. Accepts a
 * single ref or an array — pass every element the "outside" check should
 * exclude (e.g. both a dismissible panel AND the toggle button that opens
 * it, so re-clicking that button doesn't get treated as an outside click
 * and immediately reopen after this closes it). `enabled` lets callers skip
 * attaching the listener entirely while the dismissible UI isn't open.
 *
 * pointerdown (not click) so this fires before whatever the click would've
 * triggered, and covers touch/pen input the same as mouse.
 */
export function useClickOutside(refs, handler, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const refList = Array.isArray(refs) ? refs : [refs];

    function handlePointerDown(event) {
      const isInside = refList.some((ref) => ref?.current && ref.current.contains(event.target));
      if (!isInside) handler(event);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [refs, handler, enabled]);
}
