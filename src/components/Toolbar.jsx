/**
 * Top Toolbar — React port of src/js/components/toolbar.js (see the
 * migration plan's Stage 2). Undo/redo/reset still delegate to the exact
 * same src/js/state.js functions (undo/redo/resetStyles/updateState) —
 * those are imperative actions operating on state.js's own history stacks,
 * not themselves reactive state, so there's nothing to gain by routing them
 * through a Zustand action.
 *
 * canUndo/canRedo have no backing Zustand field (they're derived on the fly
 * from state.js's internal history/redo stacks and only ever pushed via the
 * 'history' pub/sub event) — bridged into React via useSyncExternalStore,
 * the standard way to subscribe a component to a non-React data source.
 *
 * The "Import Video" button (id="btn-select-file") and "Generate Video"
 * button (id="btn-toolbar-export") keep their exact ids: main.js looks them
 * up indirectly via the onImportVideo/onExportVideo callback props instead
 * of by id now, but other code (none currently) could still find them by id
 * if needed, matching the pre-migration DOM shape.
 */
import { useSyncExternalStore } from 'react';
import { undo, redo, resetStyles, updateState, subscribe, getHistoryState } from '../js/state.js';
import { ToggleSwitch } from './ToggleSwitch.jsx';

function useCanUndo() {
  return useSyncExternalStore(
    (cb) => subscribe('history', cb),
    () => getHistoryState().canUndo
  );
}

function useCanRedo() {
  return useSyncExternalStore(
    (cb) => subscribe('history', cb),
    () => getHistoryState().canRedo
  );
}

export function Toolbar({ onImportVideo, onExportVideo }) {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();

  return (
    <>
      <div className="flex items-center gap-2.5">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-[var(--accent-color)]">
          <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M7 10H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7 14H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="font-bold text-[15px] tracking-[-0.02em] text-[var(--text-primary)]">Caption Studio</span>
        <span className="text-[10px] font-extrabold bg-[var(--accent-gradient)] text-[var(--text-on-accent)] px-1.5 py-0.5 rounded uppercase tracking-[0.05em]">PRO</span>
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
        <div className="flex items-center gap-1 bg-[var(--bg-input)] p-[3px] rounded-[var(--radius-sm)] border border-[var(--border-color)]">
          <button
            type="button" id="btn-toolbar-undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}
            className="bg-transparent border-0 text-[var(--text-secondary)] w-7 h-7 rounded-md flex items-center justify-center
              cursor-pointer transition-all duration-150 hover:enabled:bg-white/10 hover:enabled:text-[var(--text-primary)]
              disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6" /><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" /></svg>
          </button>
          <button
            type="button" id="btn-toolbar-redo" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => redo()}
            className="bg-transparent border-0 text-[var(--text-secondary)] w-7 h-7 rounded-md flex items-center justify-center
              cursor-pointer transition-all duration-150 hover:enabled:bg-white/10 hover:enabled:text-[var(--text-primary)]
              disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" /></svg>
          </button>
        </div>

        <div className="w-px h-6 bg-[var(--border-color)]" />

        <button
          type="button" id="btn-toolbar-reset" onClick={() => resetStyles()}
          className="bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] text-xs font-semibold
            px-3 py-1.5 rounded-[var(--radius-sm)] flex items-center gap-1.5 cursor-pointer transition-all duration-200
            hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-color-hover)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          Reset Style
        </button>

        <button
          type="button" id="btn-select-file" onClick={() => onImportVideo?.()}
          className="bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] text-xs font-semibold
            px-3 py-1.5 rounded-[var(--radius-sm)] flex items-center gap-1.5 cursor-pointer transition-all duration-200
            hover:bg-[var(--bg-card-hover)] hover:border-[var(--border-color-hover)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          Import Video
        </button>

        <div className="relative">
          <button
            type="button" id="btn-toolbar-export" onClick={() => onExportVideo?.()}
            className="bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] text-xs font-bold px-3.5 py-1.5
              rounded-[var(--radius-sm)] flex items-center gap-1.5 cursor-pointer shadow-[var(--shadow-glow)]
              transition-all duration-200 hover:bg-[var(--accent-hover)] hover:-translate-y-px"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Generate Video
          </button>
          <p className="text-[11px] text-[var(--text-muted)] m-0 absolute top-full right-0 mt-1.5 w-max max-w-[220px]
            px-[9px] py-[5px] bg-[var(--bg-toolbar)] border border-[var(--border-color)] rounded-[var(--radius-sm)]
            text-right leading-[1.4] pointer-events-none z-[100]">Generate a new video with your latest caption edits before downloading.</p>
        </div>

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

