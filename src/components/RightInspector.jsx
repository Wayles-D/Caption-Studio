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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore.js';
import { useAudioStore } from '../store/audioStore.js';
import { buildWordChip, refreshWordSoundMarks, markTranscriptSearch, hideWordActions, reanchorWordActions } from '../js/components/transcriptEditorState.js';
import { toggleShortcutsDialog } from '../js/components/keyboardShortcuts.js';

// Matches SidebarInspector's SIDEBAR_SECTION_KEYS pattern — App.jsx's mobile
// bottom toolbar uses these two ids to show just one block at a time.
export const RIGHT_INSPECTOR_SECTION_KEYS = ['video-info', 'transcript'];

const normalizeWord = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Where a search lands in the transcript: the first word index of every
 * match, and every word inside a match (a phrase search marks all its words).
 * One word: anywhere inside a word ("off" finds "OFFICE"). Several: in order,
 * each but the last whole, the last as a beginning ("home off" finds
 * "home office").
 */
export function findTranscriptMatches(words, query) {
  const tokens = String(query || '').trim().split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!tokens.length) return { starts: [], marked: [] };
  const norm = words.map((w) => normalizeWord(w.word));
  const starts = [];
  const marked = new Set();
  for (let i = 0; i + tokens.length <= norm.length; i++) {
    const ok = tokens.length === 1
      ? norm[i].includes(tokens[0])
      : tokens.every((t, k) => (k === tokens.length - 1 ? norm[i + k].startsWith(t) : norm[i + k] === t));
    if (!ok) continue;
    starts.push(i);
    for (let k = 0; k < tokens.length; k++) marked.add(i + k);
  }
  return { starts, marked: [...marked] };
}

/**
 * @param {string} [sectionFilter] - When set (mobile bottom-sheet mode),
 * renders ONLY the one block whose key matches ('video-info' or
 * 'transcript') instead of both.
 */
export function RightInspector({ sectionFilter, active = true }) {
  const show = (key) => sectionFilter == null || sectionFilter === key;
  const uploadedFile = useEditorStore((s) => s.uploadedFile);
  const videoDuration = useEditorStore((s) => s.videoDuration);
  const fontFamily = useEditorStore((s) => s.fontFamily);
  const currentPreset = useEditorStore((s) => s.currentPreset);
  const animationMode = useEditorStore((s) => s.animationMode);
  const words = useEditorStore((s) => s.words);
  // Rebuilding chips is also how a keyword indication (word-chip-keyword
  // class, applied in buildWordChip) gets shown/hidden when the sidebar's
  // "AI Keywords" toggle changes, and how a manual keyword toggle's chip
  // refreshes its own star button — see transcriptEditorState.js.
  const enableKeywordHighlighting = useEditorStore((s) => s.enableKeywordHighlighting);

  const chipsContainerRef = useRef(null);

  useEffect(() => {
    const container = chipsContainerRef.current;
    if (!container) return;
    // A rebuild (a keyword toggled, say) replaces the word being worked on —
    // put the focus back on it, so its options and caret stay where they were.
    const active = document.activeElement;
    const focused = active?.classList?.contains('word-chip') && container.contains(active) ? active.dataset.index : null;
    container.innerHTML = '';
    words.forEach((wordObj, idx) => {
      container.appendChild(buildWordChip(wordObj, idx));
    });
    if (focused != null) container.querySelector(`.word-chip[data-index="${focused}"]`)?.focus({ preventScroll: true });
  }, [words, enableKeywordHighlighting]);

  // Each chip's ♪ shows whether a sound sits on that word — kept current as
  // clips are added, moved or deleted, without rebuilding the chips.
  const soundEvents = useAudioStore((s) => s.soundEvents);
  useEffect(() => refreshWordSoundMarks(chipsContainerRef.current), [soundEvents, words, enableKeywordHighlighting]);

  // SEARCH — focused the moment the transcript opens, like the sound
  // library's: you just type. Matches are marked in the text; the current one
  // is put on the video with its options open. Enter / ↓ next, Shift+Enter /
  // ↑ previous, Esc clears.
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const matches = useMemo(() => findTranscriptMatches(words, query), [words, query]);
  const currentWord = matches.starts.length ? matches.starts[Math.min(current, matches.starts.length - 1)] : null;
  // The transcript is permanently mounted on desktop (only shown/hidden), so
  // "opened" is this prop turning true — the focus has to follow it.
  useEffect(() => {
    if (!active || sectionFilter === 'video-info') return undefined;
    searchRef.current?.focus();
    return () => hideWordActions();
  }, [active, sectionFilter]);
  // The words are plain DOM (see the header), so the marks are applied to
  // them — after any rebuild, too (this runs after the rebuild effect above).
  useEffect(() => {
    markTranscriptSearch(matches.marked, currentWord);
    if (currentWord == null) reanchorWordActions();
  }, [matches, currentWord, enableKeywordHighlighting]);
  const step = (dir) => {
    if (!matches.starts.length) return;
    setCurrent((c) => (Math.min(c, matches.starts.length - 1) + dir + matches.starts.length) % matches.starts.length);
  };
  const onSearchKey = (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (query) { setQuery(''); setCurrent(0); hideWordActions(); } else e.currentTarget.blur();
    }
  };

  const mins = Math.floor((videoDuration || 0) / 60);
  const secs = Math.floor((videoDuration || 0) % 60);
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

  return (
    <>
      {show('video-info') && (
        <div className="flex flex-col gap-5">
          {/* What is open — named once, by the file, not by a panel title. */}
          <section className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col min-w-0">
                <span className="text-[12px] font-medium text-[var(--text-muted)]">Video</span>
                <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)] truncate" title={uploadedFile ? uploadedFile.name : 'Demo video'}>
                  {uploadedFile ? uploadedFile.name : 'Demo video'}
                </span>
              </div>
              <span
                id="global-status-badge"
                className="shrink-0 mt-0.5 text-[12px] font-medium text-[var(--accent-wash-text)] bg-[var(--accent-wash-bg)] pl-1.5 pr-2 py-0.5 rounded-full flex items-center gap-1.5"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-color)]" aria-hidden="true" />Ready
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-px rounded-xl overflow-hidden border border-[var(--border-color)] bg-[var(--border-color)]">
              <div className="bg-[var(--bg-card)] px-3 py-2.5 flex flex-col gap-0.5">
                <dt className="text-[12px] text-[var(--text-muted)]">Duration</dt>
                <dd className="text-[13px] font-medium text-[var(--text-primary)] font-[family-name:var(--font-mono)] tabular-nums">{durationLabel}</dd>
              </div>
              <div className="bg-[var(--bg-card)] px-3 py-2.5 flex flex-col gap-0.5">
                <dt className="text-[12px] text-[var(--text-muted)]">Canvas</dt>
                <dd className="text-[13px] font-medium text-[var(--text-primary)]">1080 × 1920 <span className="text-[var(--text-muted)]">9:16</span></dd>
              </div>
            </dl>
          </section>

          <section className="flex flex-col gap-2">
            <span className="text-[12px] font-medium text-[var(--text-muted)]">Caption look</span>
            <div className="flex flex-wrap gap-1.5">
              {[fontFamily, currentPreset, animationMode].filter(Boolean).map((tag) => (
                <span key={tag} className="text-[11.5px] font-medium bg-[var(--bg-card)] border border-[var(--border-color)] px-2 py-1 rounded-md text-[var(--text-secondary)] capitalize">
                  {String(tag).replace(/-/g, ' ')}
                </span>
              ))}
            </div>
          </section>

          {/* For someone new: where things are, in three lines. */}
          <section className="flex flex-col gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3.5">
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">Getting around</span>
            <ul className="flex flex-col gap-2 text-[12px] leading-snug text-[var(--text-secondary)]">
              <li className="flex gap-2"><span className="text-[var(--accent-color)]" aria-hidden="true">1</span>Click a caption on the video, then click a word to style just that word.</li>
              <li className="flex gap-2"><span className="text-[var(--accent-color)]" aria-hidden="true">2</span>The tools below are grouped: Captions, Words, Add, Scene, Project.</li>
              <li className="flex gap-2"><span className="text-[var(--accent-color)]" aria-hidden="true">3</span>Space plays and pauses. Ctrl+Z undoes anything.</li>
            </ul>
            <button
              type="button"
              onClick={() => toggleShortcutsDialog(true)}
              className="self-start text-[12px] font-medium text-[var(--accent-wash-text)] bg-transparent border-0 p-0 cursor-pointer hover:underline underline-offset-2"
            >
              All keyboard shortcuts
            </button>
          </section>
        </div>
      )}

      {show('transcript') && (
        <div
          className="flex flex-col gap-3 h-full"
          id="transcript-card"
          style={{ display: words.length > 0 ? 'flex' : 'none' }}
        >
          <div className="transcript-search">
            <svg className="transcript-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              ref={searchRef}
              id="transcript-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search the transcript"
              aria-label="Search the transcript"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCurrent(0); }}
              onKeyDown={onSearchKey}
            />
            {query.trim() && (
              <span className="transcript-search-count" id="transcript-search-count" aria-live="polite">
                {matches.starts.length ? `${Math.min(current, matches.starts.length - 1) + 1} of ${matches.starts.length}` : 'No matches'}
              </span>
            )}
            {matches.starts.length > 1 && (
              <span className="flex">
                <button type="button" className="transcript-search-step" aria-label="Previous match" onMouseDown={(e) => e.preventDefault()} onClick={() => step(-1)}>↑</button>
                <button type="button" className="transcript-search-step" aria-label="Next match" onMouseDown={(e) => e.preventDefault()} onClick={() => step(1)}>↓</button>
              </span>
            )}
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[12px] leading-snug text-[var(--text-secondary)] m-0">Click a word to edit it or see its options.</p>
            <span className="shrink-0 text-[11px] font-medium text-[var(--text-muted)] font-[family-name:var(--font-mono)] tabular-nums">{words.length} words</span>
          </div>
          <div className="transcript-words" id="transcript-words-container" ref={chipsContainerRef} />
        </div>
      )}
    </>
  );
}
