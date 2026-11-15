/**
 * Finds what is hanging the editor, by asking the browser rather than guessing.
 *
 * A "hang" is a long task: one turn of the event loop that ran so long the
 * page could not paint or answer a click. The browser reports those through
 * PerformanceObserver, but it will not say which of OUR loops was inside it —
 * so the loops mark themselves with phase(), and a long task is attributed to
 * whichever phase was running when it started.
 *
 * Four candidates were measured and cleared before this existed (the timeline
 * refresh loop, its per-frame JSON.stringify memos, the Objects-mode mask
 * morph, and undo history growth), which is exactly why this reports instead
 * of assuming: the next guess would have been the fifth.
 *
 * DEV ONLY. main.jsx installs it behind import.meta.env.DEV, so nothing here
 * ships in a built file.
 */

const LONG_TASK_MS = 80;

let current = 'idle';
let installed = false;

/** The slowest single run of each phase, and how much time it has taken in total. */
const totals = new Map();

/**
 * Runs `fn` as a named phase, so any long task overlapping it is attributed
 * here. Returns whatever `fn` returns; never swallows its errors.
 */
export function phase(name, fn) {
  const previous = current;
  current = name;
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - start;
    const seen = totals.get(name) || { calls: 0, total: 0, worst: 0 };
    seen.calls += 1;
    seen.total += ms;
    if (ms > seen.worst) seen.worst = ms;
    totals.set(name, seen);
    current = previous;
  }
}

/** What the editor has spent its time on since the page loaded. */
export function hangReport() {
  const rows = [...totals.entries()]
    .map(([name, v]) => ({
      phase: name,
      calls: v.calls,
      totalMs: Math.round(v.total),
      worstMs: +v.worst.toFixed(1),
      avgMs: +(v.total / v.calls).toFixed(2)
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  // eslint-disable-next-line no-console
  console.table(rows);
  const mem = performance.memory;
  if (mem) {
    // eslint-disable-next-line no-console
    console.log(`[hangWatch] heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB of ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)}MB`);
  }
  return rows;
}

export function installHangWatch() {
  if (installed) return;
  installed = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue;
        const mem = performance.memory;
        // eslint-disable-next-line no-console
        console.warn(
          `[hangWatch] ${Math.round(entry.duration)}ms blocked during "${current}"`
          + (mem ? ` — heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : '')
        );
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long-task timing is not available everywhere; the phase totals below
    // still work, and hangReport() remains useful on its own.
  }
  window.__hangReport = hangReport;
  // eslint-disable-next-line no-console
  console.log(`[hangWatch] watching. Anything over ${LONG_TASK_MS}ms is logged; call __hangReport() for the totals.`);
}
