import { useEffect } from 'react';

// Radix UI (Popover, DropdownMenu, Select, etc. — see src/components/ui/*)
// renders its open content through a React Portal attached to
// document.body, entirely OUTSIDE whatever DOM subtree a `ref` here points
// at — so a click inside, say, ColorPickerField's popover (built on
// @radix-ui/react-popover, used from a color swatch that lives inside a
// bottom-sheet/side-panel this hook is watching) has a target that is not a
// descendant of any watched ref, reads as "outside", and closes the whole
// panel — taking the popover down with it before the click can do anything
// (drag the saturation square, click a slider, type a hex value). Every
// Radix Popper-based primitive stamps this exact attribute on its portaled
// wrapper regardless of which trigger opened it or where the portal target
// is, so treating it as "inside" here covers the color picker today and any
// future Radix popover/dropdown/select without each one needing its own
// special case.
const RADIX_PORTAL_SELECTOR = '[data-radix-popper-content-wrapper]';

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
      const isInside = refList.some((ref) => ref?.current && ref.current.contains(event.target))
        || event.target.closest?.(RADIX_PORTAL_SELECTOR);
      if (!isInside) handler(event);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [refs, handler, enabled]);
}
