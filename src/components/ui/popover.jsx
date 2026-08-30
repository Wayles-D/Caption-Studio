/**
 * Popover primitive — standard shadcn/ui composition pattern (Root/Trigger/
 * Content thinly wrapping @radix-ui/react-popover), styled with this app's
 * own design tokens (var(--bg-sidebar) etc., matching every other Stage 5
 * Tailwind conversion) rather than shadcn's default zinc/gray palette, so it
 * looks native to Caption Studio instead of visually foreign.
 *
 * Using the real Radix primitive (not a hand-rolled document-click listener)
 * is the actual fix for this app's long-running outside-click/focus
 * reliability problems: Radix's Popover has battle-tested dismiss-on-
 * outside-click, Escape-to-close, and focus-trap/return-focus behavior built
 * in and used by shadcn/ui itself in production across thousands of apps.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '../../lib/utils.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({ className, align = 'start', sideOffset = 8, ...props }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[1100] w-[232px] box-border rounded-[var(--radius-md)] border border-[var(--border-color-hover)]',
          'bg-[var(--bg-sidebar)] p-3.5 shadow-[var(--shadow-md)] outline-none',
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
