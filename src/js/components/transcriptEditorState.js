/**
 * Transcript word-chip editor — DOM-level helpers shared between
 * RightInspector.jsx (which owns rendering the chips, see its own doc
 * comment for why they stay plain contentEditable DOM nodes built
 * imperatively rather than React-controlled elements) and main.js (which
 * needs to read the user's live edits at regenerate time). Kept as plain
 * DOM queries/mutations — unchanged from the original vanilla
 * rightInspector.js — so behavior (edited-word highlighting, Enter-to-blur,
 * reading current chip text at submit time) is identical either way.
 */

/**
 * Builds one contentEditable word chip, wired exactly as before: marks
 * itself `.edited` when its text diverges from the original word, and
 * treats Enter as "done editing" (blur) rather than inserting a newline.
 */
// 'word-chip' itself carries no styling (kept only as a stable selector hook
// for collectEditedWords below); all visual styling comes from the Tailwind
// utility classes alongside it.
const WORD_CHIP_BASE_CLASSES = 'word-chip bg-[var(--bg-card)] border border-[var(--border-color)] rounded-md px-2 py-[3px] text-xs font-semibold text-[var(--text-primary)] outline-none cursor-text transition-all duration-150';
const WORD_CHIP_EDITED_CLASSES = ['border-amber-500', 'bg-amber-500/15'];

export function buildWordChip(wordObj, idx) {
  const chip = document.createElement('span');
  chip.className = WORD_CHIP_BASE_CLASSES;
  chip.contentEditable = 'true';
  chip.spellcheck = false;
  chip.textContent = wordObj.word || '';
  chip.dataset.index = idx;
  chip.dataset.originalText = wordObj.word || '';

  chip.addEventListener('input', () => {
    const currentText = chip.textContent.trim();
    if (currentText !== chip.dataset.originalText) {
      chip.classList.add(...WORD_CHIP_EDITED_CLASSES);
    } else {
      chip.classList.remove(...WORD_CHIP_EDITED_CLASSES);
    }
  });

  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      chip.blur();
    }
  });

  return chip;
}

/**
 * Collect word objects from the transcript editor's current chip contents
 * (including any live, uncommitted edits) — called at regenerate time from
 * main.js's triggerRegeneration.
 */
export function collectEditedWords(appState) {
  const transcriptWordsContainer = document.getElementById('transcript-words-container');
  if (!transcriptWordsContainer) return [];

  const chips = transcriptWordsContainer.querySelectorAll('.word-chip');
  return Array.from(chips).map((chip, idx) => {
    const originalWord = appState.words[idx];
    return {
      ...originalWord,
      word: chip.textContent.trim(),
      start: originalWord ? originalWord.start : 0,
      end: originalWord ? originalWord.end : 0
    };
  });
}
