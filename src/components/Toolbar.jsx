/**
 * Top Toolbar — React port of src/js/components/toolbar.js (see the
 * migration plan's Stage 2). Reset still delegates to the exact same
 * src/js/state.js function (resetStyles) — an imperative action, not
 * itself reactive state, so there's nothing to gain by routing it through
 * a Zustand action.
 *
 * Undo/Redo have moved down to the timeline header, next to the Keyframe/
 * Advanced buttons (see src/js/components/timelinePanel.js) — they're
 * history-editing controls for the SAME keyframe/style edits the timeline
 * is the primary surface for, so they now live with the rest of the
 * editing controls instead of the nav.
 *
 * Import now only happens via the upload dropzone (PreviewStage's "Select
 * Video" button) — the nav no longer has its own separate Import Video
 * button/entry point.
 *
 * "Export" replaces the old separate "Generate Video" (pre-render) and
 * floating-playback-bar "Download" buttons with a single nav action —
 * onExportVideo is App.jsx's handleDownloadVideo, which already renders the
 * current edits fresh before serving the file, so Export always produces
 * up-to-date output in one click.
 */
import { useEffect, useRef, useState } from 'react';
import { appState, resetStyles, subscribe, updateState } from '../js/state.js';
import { discardSavedProject } from '../js/projectPersistence.js';
import { SKIP_SPLASH_ONCE } from './SplashScreen.jsx';
import { ToggleSwitch } from './ToggleSwitch.jsx';

const SECONDARY = `bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] text-xs font-semibold
  px-3 py-1.5 rounded-[var(--radius-sm)] flex items-center gap-1.5 cursor-pointer transition-all duration-200
  hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-color-hover)]`;

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
      <button type="button" id="btn-toolbar-new" className={SECONDARY} onClick={() => setAsking((a) => !a)} aria-expanded={asking}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></svg>
        New Project
      </button>
      {asking && (
        <div
          id="new-project-confirm" role="dialog" aria-label="Start a new project"
          className="absolute right-0 top-[calc(100%+8px)] w-[280px] bg-[var(--bg-card)] border border-[var(--border-color)]
            rounded-[var(--radius-md)] shadow-[var(--shadow-md)] p-4 flex flex-col gap-3 z-[1001]"
        >
          <span className="text-[13px] font-bold text-[var(--text-primary)]">Start a new project?</span>
          <span className="text-[12px] text-[var(--text-secondary)] leading-snug">
            This removes the current video and all its edits from this browser. Export first if you want to keep it.
          </span>
          <div className="flex justify-end gap-2">
            <button type="button" id="new-project-cancel" className={SECONDARY} onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
            <button
              type="button" id="new-project-confirm-btn" onClick={startNew} disabled={busy}
              className="bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] text-xs font-bold px-3 py-1.5
                rounded-[var(--radius-sm)] cursor-pointer disabled:opacity-60"
            >
              {busy ? 'Clearing…' : 'Start new project'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Toolbar({ onExportVideo }) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        {/* The bhYnd mark, as artwork rather than the hand-drawn SVG that used
            to stand in for it. alt is empty on purpose: the wordmark beside it
            already says "bhYnd", so a screen reader announcing it twice would
            be noise, not information. */}
        <img className="h-10 w-12 border-0 rounded-[6px]" src="/Logo.jpeg" alt="" />
        <span className="font-bold text-[15px] tracking-[-0.02em] text-[var(--text-primary)]">bhYnd</span>
      </div>

      <div className="flex-1 max-w-[320px] mx-5">
        <input
          type="text"
          id="project-title-input"
          className="w-full bg-transparent border border-transparent rounded-[var(--radius-sm)] text-[var(--text-primary)]
            font-[family-name:var(--font-main)] text-[13px] font-semibold px-2 py-1 text-center transition-all duration-200
            outline-none hover:bg-[var(--bg-input)] hover:border-[var(--border-color)] focus:bg-[var(--bg-input)] focus:border-[var(--border-color)]"
          defaultValue="Untitled Short Video"
          title="Click to rename project"
          onChange={(e) => {
            const newTitle = e.target.value.trim() || 'Untitled Project';
            updateState({ projectName: newTitle }, { recordHistory: false });
          }}
        />
      </div>

      <div className="flex items-center gap-3">
        <NewProjectButton />

        <button type="button" id="btn-toolbar-reset" onClick={() => resetStyles()} className={SECONDARY}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          Reset Style
        </button>

        <button
          type="button" id="btn-toolbar-export" onClick={() => onExportVideo?.()}
          className="bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] text-xs font-bold px-3.5 py-1.5
            rounded-[var(--radius-sm)] flex items-center gap-1.5 cursor-pointer shadow-[var(--shadow-glow)]
            transition-all duration-200 hover:bg-[var(--accent-hover)] hover:-translate-y-px"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          Export
        </button>

        <ToggleSwitch
          id="theme-toggle-checkbox"
          title="Toggle Light / Dark mode"
          onChange={(e) => {
            const newTheme = e.target.checked ? 'light' : 'dark';
            document.body.classList.toggle('light-theme', e.target.checked);
            updateState({ theme: newTheme }, { recordHistory: false });
          }}
        />
      </div>
    </>
  );
}

