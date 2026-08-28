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
      <div className="inspector-card">
        <div className="inspector-card-header">
          <span className="card-title">Video Inspector</span>
          <span className="status-badge" id="global-status-badge">Ready</span>
        </div>
        <div className="meta-rows">
          <div className="meta-row">
            <span className="meta-label">File</span>
            <span className="meta-val">{uploadedFile ? uploadedFile.name : 'Demo Video'}</span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Duration</span>
            <span className="meta-val">{durationLabel}</span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Canvas</span>
            <span className="meta-val">1080 × 1920 (9:16)</span>
          </div>
        </div>

        <div className="badges-summary">
          <span className="badge-tag">{fontFamily}</span>
          <span className="badge-tag">{(currentPreset || '').toUpperCase()}</span>
          <span className="badge-tag">{(animationMode || '').toUpperCase()}</span>
        </div>
      </div>

      <div
        className="inspector-card transcript-card-col"
        id="transcript-card"
        style={{ display: words.length > 0 ? 'flex' : 'none' }}
      >
        <div className="inspector-card-header">
          <span className="card-title">Transcript Editor</span>
          <span className="word-count-chip">{words.length} words</span>
        </div>
        <p className="transcript-help">Click any word chip below to edit speech text:</p>
        <div className="transcript-chips-box" id="transcript-words-container" ref={chipsContainerRef} />
        <button
          type="button"
          id="btn-apply-render"
          className="btn btn-primary btn-apply-full"
          disabled={isProcessing}
          onClick={() => onRegenerateCaptions?.()}
        >
          Re-render Captioned Video
        </button>
      </div>
    </>
  );
}

