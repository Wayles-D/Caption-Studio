/**
 * The welcome screen — the bhYnd mark assembling itself over the whole
 * window on load, then getting out of the way.
 *
 * It covers the app rather than replacing it: App.jsx mounts underneath at
 * the same moment, so the editor is warm and laid out by the time the splash
 * fades. Nothing waits on this.
 *
 * It is also always skippable. A splash that cannot be dismissed is a wall,
 * and this one sits between the user and a Select Video button they may have
 * come back to the tab specifically to press — so any press or key ends it
 * early, and prefers-reduced-motion skips the reveal entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BhyndIntro } from './BhyndIntro.jsx';

// How long the finished mark is held before it starts to leave. Short: the
// animation has already had its moment by then.
const HOLD_MS = 650;
// Matches the fade in the inline style below. Kept in JS because the unmount
// has to happen after the paint finishes, not alongside it.
const FADE_MS = 450;

/**
 * Whether to show the splash at all for this page load.
 *
 * `?splash=0` turns it off, which is how the e2e suite gets to the editor
 * without waiting four seconds in all eighty-odd specs. The splash has its
 * own spec that omits the flag and drives the real thing.
 *
 * Starting a NEW PROJECT reloads the page (see Toolbar.jsx) — straight back
 * to the start screen, not through the intro again: it leaves a one-time
 * SKIP_SPLASH_ONCE mark, used up here.
 */
export const SKIP_SPLASH_ONCE = 'bhynd:skip-splash-once';

export function shouldShowSplash() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.sessionStorage.getItem(SKIP_SPLASH_ONCE)) {
      window.sessionStorage.removeItem(SKIP_SPLASH_ONCE);
      return false;
    }
  } catch { /* storage blocked: the splash just plays */ }
  try {
    return new URLSearchParams(window.location.search).get('splash') !== '0';
  } catch {
    return true;
  }
}

export function SplashScreen({ onDone }) {
  const [leaving, setLeaving] = useState(false);
  const timers = useRef([]);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // Both the settle path and the skip path funnel through here, so a press
  // during the hold cannot queue a second exit on top of the first.
  const dismiss = useCallback(() => {
    setLeaving((already) => {
      if (already) return already;
      timers.current.push(setTimeout(() => doneRef.current?.(), FADE_MS));
      return true;
    });
  }, []);

  const handleSettled = useCallback(() => {
    timers.current.push(setTimeout(dismiss, HOLD_MS));
  }, [dismiss]);

  useEffect(() => {
    const onKey = () => dismiss();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [dismiss]);

  return (
    <div
      id="bhynd-splash"
      role="status"
      aria-label="bhYnd"
      onPointerDown={dismiss}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[#050607]"
      style={{
        opacity: leaving ? 0 : 1,
        // Stops taking presses the instant it starts leaving, so a click
        // aimed at the app underneath during the fade lands on the app.
        pointerEvents: leaving ? 'none' : 'auto',
        transition: `opacity ${FADE_MS}ms ease`
      }}
    >
      <BhyndIntro
        onSettled={handleSettled}
        style={{ width: 'min(88vmin, 520px)', height: 'min(88vmin, 520px)' }}
      />
    </div>
  );
}
