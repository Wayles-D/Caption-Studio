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
      <div className="toolbar-brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="logo-icon">
          <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M7 10H17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7 14H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="brand-title font-geist">Caption Studio</span>
        <span className="brand-badge">PRO</span>
      </div>

      <div className="toolbar-project">
        <input
          type="text"
          id="project-title-input"
          className="project-title-field"
          defaultValue="Untitled Short Video"
          title="Click to rename project"
          onChange={(e) => {
            const newTitle = e.target.value.trim() || 'Untitled Project';
            updateState({ projectName: newTitle }, { recordHistory: false });
          }}
        />
      </div>

      <div className="toolbar-actions">
        <div className="toolbar-group">
          <button type="button" id="btn-toolbar-undo" className="btn-icon-tool" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6" /><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" /></svg>
          </button>
          <button type="button" id="btn-toolbar-redo" className="btn-icon-tool" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => redo()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" /></svg>
          </button>
        </div>

        <div className="toolbar-divider" />

        <button type="button" id="btn-toolbar-reset" className="btn-toolbar-sec" onClick={() => resetStyles()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          Reset Style
        </button>

        <button type="button" id="btn-select-file" className="btn-toolbar-sec" onClick={() => onImportVideo?.()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          Import Video
        </button>

        <div className="toolbar-export-group">
          <button type="button" id="btn-toolbar-export" className="btn-toolbar-pri" onClick={() => onExportVideo?.()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Generate Video
          </button>
          <p className="field-hint toolbar-export-hint">Generate a new video with your latest caption edits before downloading.</p>
        </div>

        <label className="theme-toggle-label" title="Toggle Light / Dark mode">
          <input
            type="checkbox"
            id="theme-toggle-checkbox"
            onChange={(e) => {
              const newTheme = e.target.checked ? 'light' : 'dark';
              document.body.classList.toggle('light-theme', e.target.checked);
              updateState({ theme: newTheme }, { recordHistory: false });
            }}
          />
          <span className="theme-slider" />
        </label>
      </div>
    </>
  );
}

