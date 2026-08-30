import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard shadcn/ui `cn()` helper: merges conditional className fragments
// (clsx) then resolves conflicting Tailwind utilities in favor of the
// last one (tailwind-merge) — e.g. cn('p-2', condition && 'p-4') correctly
// yields just 'p-4' instead of leaving both classes present.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
