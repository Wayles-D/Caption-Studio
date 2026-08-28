/**
 * Right Sidebar: Video Inspector + Transcript Word-Chip Editor.
 *
 * React port of the vanilla src/js/components/rightInspector.js (see the
 * migration plan's Stage 2) — reads directly from useEditorStore (a real
 * Zustand hook, reactive to both React-originated and legacy
 * updateState()-originated changes, since both write into the same store —
 * see src/js/state.js's compatibility shim) instead of the old
 * subscribe('*', updateRightInspectorUI) pattern.
 *
 * The transcript word-chip editor is deliberately NOT reimplemented as
 * React-controlled elements: each chip is a native contentEditable <span>
 * the user types directly into, and main.js's triggerRegeneration reads
 * their live (possibly uncommitted) text at submit time via
 * collectEditedWords() — a plain DOM query. Letting React reconcile
 * contentEditable children while the user is actively editing them is a
 * well-known footgun (the cursor/edit gets clobbered on re-render), so this
 * component owns a plain container via a ref and rebuilds the chips
 * imperatively — the EXACT same buildWordChip DOM logic as before — only
 * when `words` itself changes (a new transcript), never on every render.
 */
import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/editorStore.js';
import { buildWordChip } from '../js/components/transcriptEditorState.js';

export function RightInspector({ onRegenerateCaptions }) {
  const uploadedFile = useEditorStore((s) => s.uploadedFile);
  const videoDuration = useEditorStore((s) => s.videoDuration);
  const fontFamily = useEditorStore((s) => s.fontFamily);
  const currentPreset = useEditorStore((s) => s.currentPreset);
  const animationMode = useEditorStore((s) => s.animationMode);
  const words = useEditorStore((s) => s.words);
  const isProcessing = useEditorStore((s) => s.isProcessing);

  const chipsContainerRef = useRef(null);

  useEffect(() => {
    const container = chipsContainerRef.current;
    if (!container) return;
    container.innerHTML = '';
    words.forEach((wordObj, idx) => {
      container.appendChild(buildWordChip(wordObj, idx));
    });
  }, [words]);

  const mins = Math.floor((videoDuration || 0) / 60);
  const secs = Math.floor((videoDuration || 0) % 60);
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

  return (
    <>
      <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Video Inspector</span>
          <span className="text-[10px] font-bold bg-[var(--status-wash-bg)] text-[var(--status)] px-2 py-0.5 rounded-[10px]" id="global-status-badge">Ready</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-[var(--text-muted)]">File</span>
            <span className="font-semibold text-[var(--text-primary)]">{uploadedFile ? uploadedFile.name : 'Demo Video'}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-[var(--text-muted)]">Duration</span>
            <span className="font-semibold text-[var(--text-primary)]">{durationLabel}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-[var(--text-muted)]">Canvas</span>
            <span className="font-semibold text-[var(--text-primary)]">1080 × 1920 (9:16)</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-1">
          <span className="text-[10px] font-bold bg-[var(--bg-input)] border border-[var(--border-color)] px-2 py-[3px] rounded-md text-[var(--text-secondary)]">{fontFamily}</span>
          <span className="text-[10px] font-bold bg-[var(--bg-input)] border border-[var(--border-color)] px-2 py-[3px] rounded-md text-[var(--text-secondary)]">{(currentPreset || '').toUpperCase()}</span>
          <span className="text-[10px] font-bold bg-[var(--bg-input)] border border-[var(--border-color)] px-2 py-[3px] rounded-md text-[var(--text-secondary)]">{(animationMode || '').toUpperCase()}</span>
        </div>
      </div>

      <div
        className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3 flex-1"
        id="transcript-card"
        style={{ display: words.length > 0 ? 'flex' : 'none' }}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]">Transcript Editor</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{words.length} words</span>
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">Click any word chip below to edit speech text:</p>
        <div
          className="flex-1 min-h-[180px] max-h-[300px] overflow-y-auto bg-[var(--bg-input)] border border-[var(--border-color)]
            rounded-[var(--radius-sm)] p-2.5 flex flex-wrap content-start gap-1.5"
          id="transcript-words-container"
          ref={chipsContainerRef}
        />
        <button
          type="button"
          id="btn-apply-render"
          className="w-full h-[38px] bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] font-bold text-xs
            rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:bg-[var(--accent-hover)]"
          disabled={isProcessing}
          onClick={() => onRegenerateCaptions?.()}
        >
          Re-render Captioned Video
        </button>
      </div>
    </>
  );
}

