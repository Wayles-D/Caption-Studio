/**
 * Top bar — brand and project on the left, the session's actions on the
 * right, with exactly ONE filled button (Export): the eye should land on the
 * thing that finishes the job. Everything else is quiet until hovered.
 *
 * Reset still delegates to the exact same src/js/state.js function
 * (resetStyles) — an imperative action, not itself reactive state.
 *
 * Undo/Redo live in the timeline header, next to the Keyframe/Advanced
 * buttons (see src/js/components/timelinePanel.js) — they are history for
 * the same edits the timeline is the primary surface for.
 *
 * Import only happens via the upload dropzone (PreviewStage's "Select
 * Video" button).
 *
 * "Export" is App.jsx's handleDownloadVideo, which renders the current
 * edits fresh before serving the file, so Export always produces up-to-date
 * output in one click.
 */
import { useEffect, useRef, useState } from 'react';
import { appState, resetStyles, subscribe, updateState } from '../js/state.js';
import { discardSavedProject } from '../js/projectPersistence.js';
import { SKIP_SPLASH_ONCE } from './SplashScreen.jsx';
import { useThemeStore } from '../store/themeStore.js';
import { BrandMark } from './BrandMark.jsx';

// Quiet chrome: no border, no fill until hovered. Labels collapse to icons
// on narrow screens (the aria-label still names them).
const GHOST = `h-8 px-2.5 rounded-lg border-0 bg-transparent text-[var(--text-secondary)] text-[12.5px] font-medium
  flex items-center gap-1.5 cursor-pointer transition-colors duration-[var(--dur-fast)]
  hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:bg-[var(--bg-pressed)] disabled:opacity-50`;
const ICON_BTN = `h-8 w-8 rounded-lg border-0 bg-transparent text-[var(--text-secondary)] grid place-items-center
  cursor-pointer transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`;
const PRIMARY = `h-8 px-3.5 rounded-lg border-0 bg-[var(--accent-gradient)] text-[var(--text-on-accent)] text-[12.5px] font-semibold
  flex items-center gap-1.5 cursor-pointer shadow-[var(--shadow-glow)] transition-[background-color,transform] duration-[var(--dur-fast)]
  hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-60`;

/**
 * NEW PROJECT — the open project (its video and every edit) is saved in this
 * browser and comes back on every visit; this is how to put it away and
 * start again from the upload screen. It cannot be undone, so it asks first.
 *
 * Starting over reloads the page rather than resetting state in place: a
 * fresh page is the one reset that provably leaves nothing of the old
 * project behind (players, workers, caches, history). The saved copy is
 * deleted first, so the reload opens empty — and skips the intro.
 */
function NewProjectButton() {
  const [loaded, setLoaded] = useState(() => !!appState.isLoaded);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  useEffect(() => subscribe('isLoaded', () => setLoaded(!!appState.isLoaded)), []);
  // Escape, or a click anywhere else, is "no".
  useEffect(() => {
    if (!asking) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setAsking(false); };
    const onDown = (e) => { if (!box.current?.contains(e.target)) setAsking(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [asking]);
  if (!loaded) return null;

  const startNew = async () => {
    setBusy(true);
    document.getElementById('preview-video')?.pause();
    await discardSavedProject();
    try { window.sessionStorage.setItem(SKIP_SPLASH_ONCE, '1'); } catch { /* the intro just plays */ }
    window.location.reload();
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button" id="btn-toolbar-new" className={GHOST} onClick={() => setAsking((a) => !a)}
        aria-expanded={asking} aria-label="New project"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        <span className="max-sm:hidden">New project</span>
      </button>
      {asking && (
        <div
          id="new-project-confirm" role="dialog" aria-label="Start a new project"
          className="bhynd-pop absolute right-0 top-[calc(100%+8px)] w-[290px] bg-[var(--bg-raised)] border border-[var(--border-color)]
            rounded-[14px] shadow-[var(--shadow-lg)] p-4 flex flex-col gap-2.5 z-[1001]"
        >
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">Start a new project?</span>
          <span className="text-[12.5px] text-[var(--text-secondary)] leading-relaxed">
            This removes the current video and all its edits from this browser. Export first if you want to keep it.
          </span>
          <div className="flex justify-end gap-2 mt-1">
            <button type="button" id="new-project-cancel" className={GHOST} onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
            <button type="button" id="new-project-confirm-btn" className={PRIMARY} onClick={startNew} disabled={busy}>
              {busy ? 'Clearing…' : 'Start new project'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeButton() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const light = theme === 'light';
  return (
    <button
      type="button" id="theme-toggle" className={ICON_BTN}
      onClick={() => {
        toggleTheme();
        // Kept in step for anything that still reads it from the editor state.
        updateState({ theme: light ? 'dark' : 'light' }, { recordHistory: false });
      }}
      aria-label={light ? 'Switch to dark mode' : 'Switch to light mode'}
      title={light ? 'Dark mode' : 'Light mode'}
    >
      {light ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      )}
    </button>
  );
}

export function Toolbar({ onExportVideo }) {
  return (
    <>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="flex items-center gap-2 shrink-0 text-[var(--text-primary)]">
          {/* The mark is decorative here: the wordmark beside it already says
              "bhYnd", so a screen reader would hear it twice. */}
          <BrandMark className="h-7 w-7" />
          <span className="font-semibold text-[16px] tracking-[-0.02em]">bhYnd</span>
        </div>

        <span className="h-5 w-px bg-[var(--border-color)] shrink-0 max-sm:hidden" aria-hidden="true" />

        <input
          type="text"
          id="project-title-input"
          aria-label="Project name"
          className="min-w-0 w-full max-w-[280px] h-8 bg-transparent border border-transparent rounded-lg text-[var(--text-primary)]
            font-[family-name:var(--font-main)] text-[13px] font-medium px-2 transition-colors duration-[var(--dur-fast)]
            outline-none hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-input)] focus:border-[var(--border-color-hover)] max-sm:hidden"
          defaultValue="Untitled Short Video"
          title="Rename project"
          onChange={(e) => {
            const newTitle = e.target.value.trim() || 'Untitled Project';
            updateState({ projectName: newTitle }, { recordHistory: false });
          }}
        />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button type="button" id="btn-toolbar-reset" onClick={() => resetStyles()} className={GHOST} aria-label="Reset caption style" title="Reset the caption style to its defaults">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          <span className="max-md:hidden">Reset style</span>
        </button>

        <NewProjectButton />

        <ThemeButton />

        <span className="h-5 w-px bg-[var(--border-color)] mx-1.5" aria-hidden="true" />

        <button type="button" id="btn-toolbar-export" onClick={() => onExportVideo?.()} className={PRIMARY}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          Export
        </button>
      </div>
    </>
  );
}
