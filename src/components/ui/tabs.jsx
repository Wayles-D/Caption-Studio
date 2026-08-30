/**
 * Tabs primitive — standard shadcn/ui composition pattern thinly wrapping
 * @radix-ui/react-tabs, styled with this app's own design tokens. Used by
 * ColorPickerField to switch between HEX / RGB / HSL editing views —
 * Radix's Tabs gives real roving-tabindex keyboard navigation (arrow keys
 * between tabs, Home/End) for free.
 */
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '../../lib/utils.js';

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }) {
  return (
    <TabsPrimitive.List
      className={cn(
        'grid grid-cols-3 gap-1 bg-[var(--bg-input)] p-1 rounded-[var(--radius-sm)] border border-[var(--border-color)]',
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'text-[11px] font-bold text-[var(--text-secondary)] rounded-md py-1.5 transition-all duration-200',
        'data-[state=active]:bg-[var(--bg-card)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-[var(--shadow-sm)]',
        'outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-color)]',
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Content className={cn('mt-2.5', className)} {...props} />;
}
