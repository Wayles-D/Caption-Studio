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
import { resetStyles, updateState } from '../js/state.js';
import { ToggleSwitch } from './ToggleSwitch.jsx';

export function Toolbar({ onExportVideo }) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        {/* BHYND mark — two interlocking brackets (the "bind/behind" weave —
            see the brand sheet). The "under" stroke is drawn three times:
            once in the header's own background color as a cutout so the
            "over" stroke reads as genuinely woven through it rather than
            just overlapping, then again at reduced opacity for depth,
            before the "over" stroke completes the weave. Colors come from
            the app's own theme tokens (accent teal / bg-toolbar) instead of
            the brand sheet's black-on-white so it sits naturally in both
            light and dark theme. */}
        <svg width="22" height="22" viewBox="0 0 100 100" fill="none">
          <path d="M 18 26 L 42 26 L 42 74 L 82 74" stroke="var(--bg-toolbar)" strokeWidth="20" strokeLinecap="square" strokeLinejoin="round" />
          <path d="M 18 26 L 42 26 L 42 74 L 82 74" stroke="var(--accent-color)" strokeWidth="14" strokeLinecap="square" strokeLinejoin="round" opacity="0.45" />
          <path d="M 18 74 L 58 74 L 58 26 L 82 26" stroke="var(--accent-color)" strokeWidth="14" strokeLinecap="square" strokeLinejoin="round" />
        </svg>
        <span className="font-bold text-[15px] tracking-[-0.02em] text-[var(--text-primary)]">BHYND</span>
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

