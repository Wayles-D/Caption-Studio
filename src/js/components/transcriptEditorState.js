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

import { appState, updateState } from '../state.js';

/**
 * Builds one contentEditable word chip, wired exactly as before: marks
 * itself `.edited` when its text diverges from the original word, and
 * treats Enter as "done editing" (blur) rather than inserting a newline.
 *
 * On every keystroke it also pushes the live text into the matching word
 * inside appState.phrases (see applyLiveWordEdit below) so the graphics
 * preview — which renders from appState.phrases, not from this chip DOM —
 * reflects the edit immediately. It deliberately does NOT touch
 * appState.words: RightInspector's chip-rebuild effect depends on `words`,
 * and replacing that array on every keystroke would tear down and rebuild
 * every chip, clobbering the contentEditable caret mid-type. appState.words
 * stays the committed source read by collectEditedWords at regenerate time,
 * unchanged from its prior behavior.
 */
// 'word-chip' itself carries no styling (kept only as a stable selector hook
// for collectEditedWords below); all visual styling comes from the Tailwind
// utility classes alongside it.
const WORD_CHIP_BASE_CLASSES = 'word-chip bg-[var(--bg-card)] border border-[var(--border-color)] rounded-md px-2 py-[3px] text-xs font-semibold text-[var(--text-primary)] outline-none cursor-text transition-all duration-150';
const WORD_CHIP_EDITED_CLASSES = ['border-amber-500', 'bg-amber-500/15'];

/**
 * Word chips are wrapped in a plain (non-editable) span so the keyword
 * toggle button can sit next to the chip without becoming part of its
 * contentEditable content — an element nested INSIDE a contentEditable node
 * is fair game for the user to accidentally select/delete/type around,
 * which would corrupt both the transcript text and the toggle control. The
 * editable `.word-chip` itself is unchanged and stays the element
 * collectEditedWords/applyLiveWordEdit already look for.
 */
export function buildWordChip(wordObj, idx) {
  const wrap = document.createElement('span');
  wrap.className = 'inline-flex items-center gap-1';

  const chip = document.createElement('span');
  chip.className = WORD_CHIP_BASE_CLASSES;
  chip.contentEditable = 'true';
  chip.spellcheck = false;
  chip.textContent = wordObj.word || '';
  chip.dataset.index = idx;
  chip.dataset.originalText = wordObj.word || '';
  // Keyword status is purely a DISPLAY concern here (see setWordKeyword's
  // doc comment) — gated by the "AI Keywords" toggle (appState.
  // enableKeywordHighlighting) so turning that off hides the indication
  // without touching wordObj.isKeyword itself. RightInspector.jsx rebuilds
  // every chip (via this function) whenever either `words` or
  // `enableKeywordHighlighting` changes, so this class always reflects the
  // current toggle state.
  chip.classList.toggle('word-chip-keyword', !!wordObj.isKeyword && !!appState.enableKeywordHighlighting);

  chip.addEventListener('input', () => {
    const currentText = chip.textContent.trim();
    if (currentText !== chip.dataset.originalText) {
      chip.classList.add(...WORD_CHIP_EDITED_CLASSES);
    } else {
      chip.classList.remove(...WORD_CHIP_EDITED_CLASSES);
    }
    applyLiveWordEdit(idx, currentText);
  });

  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      chip.blur();
    }
  });

  // Selecting a chip is this word's "edit target": scrub the preview to its
  // own timestamp (when it isn't already the one on screen) so the canvas is
  // already showing this word, and any edit typed next is visible without
  // the user having to separately hunt for the right point in the video.
  chip.addEventListener('focus', () => {
    const previewVideo = document.getElementById('preview-video');
    if (!previewVideo || typeof wordObj.start !== 'number') return;
    const end = typeof wordObj.end === 'number' ? wordObj.end : wordObj.start;
    if (previewVideo.currentTime < wordObj.start || previewVideo.currentTime > end) {
      previewVideo.currentTime = wordObj.start;
    }
  });

  // Manual keyword toggle — writes through setWordKeyword (the single
  // canonical keyword write path also used by canvasTransform.js's on-canvas
  // toggle), so a change made here is immediately visible on the canvas too.
  const keywordToggle = document.createElement('button');
  keywordToggle.type = 'button';
  keywordToggle.className = 'word-chip-keyword-toggle' + (wordObj.isKeyword ? ' active' : '');
  keywordToggle.title = wordObj.isKeyword ? 'Unmark as keyword' : 'Mark as keyword';
  keywordToggle.textContent = '★';
  // Prevents the button click from stealing focus/caret away from the
  // contentEditable chip in a way that could disrupt an in-progress edit.
  keywordToggle.addEventListener('mousedown', (e) => e.preventDefault());
  keywordToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setWordKeyword(idx, !wordObj.isKeyword);
  });

  wrap.appendChild(chip);
  wrap.appendChild(keywordToggle);
  return wrap;
}

/**
 * Live-preview sync: finds the word inside appState.phrases whose
 * `wordIndex` matches this chip's position in the original flat transcript
 * (phraseGrouper.js stamps every phrase-embedded word with the index it had
 * in the flat word list it was grouped from — that index is already a
 * stable identity, unaffected by later text edits, so no new ID field is
 * needed), replaces just that word's text, and pushes the result through
 * updateState so the graphics preview's existing subscribe('*', ...)
 * re-render (see preview.js's initPreviewWorkspace) picks it up immediately.
 *
 * Rolling Stack keeps each word as its own object inside a chunk's `words`
 * array even when multiple words render adjacently as one visual stack line
 * (see shared/rollingStack.js) — replacing only the matched word object here
 * means sibling words in the same chunk/phrase are left untouched.
 *
 * recordHistory is off: phrase text isn't part of the undo-tracked style
 * slice, and pushing a snapshot on every keystroke would flood the
 * style-undo stack and clear its redo history while the user is typing.
 */
function applyLiveWordEdit(flatWordIndex, newText) {
  const phrases = appState.phrases;
  if (!Array.isArray(phrases) || !phrases.length) return;

  const idx = Number(flatWordIndex);
  let phraseIdx = -1;
  let wordIdx = -1;
  for (let p = 0; p < phrases.length; p++) {
    const w = (phrases[p].words || []).findIndex((word) => word.wordIndex === idx);
    if (w !== -1) {
      phraseIdx = p;
      wordIdx = w;
      break;
    }
  }
  if (phraseIdx === -1) return;

  const targetPhrase = phrases[phraseIdx];
  const nextWords = targetPhrase.words.slice();
  nextWords[wordIdx] = { ...nextWords[wordIdx], text: newText };

  const nextPhrases = phrases.slice();
  nextPhrases[phraseIdx] = { ...targetPhrase, words: nextWords };

  updateState({ phrases: nextPhrases }, { recordHistory: false });
}

/**
 * The single canonical write path for a word's `isKeyword` status — called
 * from BOTH the transcript editor's manual toggle button (above) and
 * canvasTransform.js's on-canvas keyword toggle, so there is exactly one
 * source of truth instead of two independently-maintained keyword flags
 * (see this feature's own architectural requirement).
 *
 * Patches `isKeyword` on every phrase.words[] entry matching this wordIndex
 * (immutably, same find-by-wordIndex + slice-and-replace pattern as
 * applyLiveWordEdit above) AND on appState.words[wordIndex] (its flat
 * position doubles as its wordIndex — see collectEditedWords/
 * applyLiveWordEdit's own doc comments on this identity). Both copies are
 * patched together, in one updateState call, because — unlike a rapid-fire
 * keystroke edit — a keyword toggle is a deliberate, infrequent action, so
 * there's no caret-clobbering risk in also updating `words` immediately
 * (RightInspector's chip-rebuild effect depends on it, and SHOULD rebuild
 * here to refresh the toggle button's/chip's own visual state).
 */
export function setWordKeyword(wordIndex, isKeyword) {
  const idx = Number(wordIndex);

  const phrases = appState.phrases;
  let nextPhrases = phrases;
  if (Array.isArray(phrases) && phrases.length) {
    let changed = false;
    const mapped = phrases.map((phrase) => {
      const wIdx = (phrase.words || []).findIndex((w) => w.wordIndex === idx);
      if (wIdx === -1) return phrase;
      changed = true;
      const nextPhraseWords = phrase.words.slice();
      nextPhraseWords[wIdx] = { ...nextPhraseWords[wIdx], isKeyword };
      return { ...phrase, words: nextPhraseWords };
    });
    if (changed) nextPhrases = mapped;
  }

  const words = appState.words;
  let nextWords = words;
  if (Array.isArray(words) && idx >= 0 && idx < words.length) {
    nextWords = words.slice();
    nextWords[idx] = { ...nextWords[idx], isKeyword };
  }

  const updates = {};
  if (nextPhrases !== phrases) updates.phrases = nextPhrases;
  if (nextWords !== words) updates.words = nextWords;
  if (Object.keys(updates).length) updateState(updates, { recordHistory: true });
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
