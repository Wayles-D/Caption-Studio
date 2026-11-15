/**
 * The transcript editor — DOM-level helpers shared between RightInspector.jsx
 * (which owns rendering the words; see its own doc comment for why they stay
 * plain contentEditable DOM nodes built imperatively rather than
 * React-controlled elements) and App.jsx (which reads the live edits at
 * regenerate time).
 *
 * The transcript reads like TEXT: the words, and nothing else, until one is
 * clicked (or found by the search) — then its options appear in one small bar
 * above it. See buildWordChip and showWordActions.
 */

import { appState, updateState, subscribe } from '../state.js';
import { getWordTransformKey } from '../../../shared/captionTransform.js';

// 'word-chip' itself carries no styling (kept only as a stable selector hook
// for collectEditedWords below); its look is in style.css (.word-chip) — a
// word in running text, not a button: nothing around it until hovered or
// selected.
const WORD_CHIP_BASE_CLASSES = 'word-chip';
const WORD_CHIP_EDITED_CLASSES = ['border-amber-500', 'bg-amber-500/15'];

/**
 * THE TRANSCRIPT READS LIKE TEXT. Each word is a plain, editable word — no
 * buttons beside it. What is SET on a word shows quietly on the word itself
 * (a keyword is bold in the captions' colour, a word with a sound has a dot
 * beneath it, a hidden word is struck through and faded). Its options —
 * keyword, sound, case, hide — appear in ONE small bar above the word you
 * click (or the search lands on), and nowhere else. See showWordActions.
 *
 * The word is still a contentEditable span: clicking it puts the caret in it,
 * so a typo is fixed by typing, as before. Wrapped in a plain span carrying
 * data-word-index (the hide state's hook and tests' handle).
 */
export function buildWordChip(wordObj, idx) {
  const wrap = document.createElement('span');
  wrap.className = 'word-chip-wrap';

  const chip = document.createElement('span');
  chip.className = WORD_CHIP_BASE_CLASSES;
  chip.contentEditable = 'true';
  chip.spellcheck = false;
  chip.textContent = wordObj.word || '';
  chip.dataset.index = idx;
  chip.dataset.originalText = wordObj.originalWord ?? wordObj.word ?? '';
  // Keyword status is purely a DISPLAY concern here (see setWordKeyword's
  // doc comment) — gated by the "AI Keywords" toggle so turning that off
  // hides the indication without touching wordObj.isKeyword itself.
  chip.classList.toggle('word-chip-keyword', !!wordObj.isKeyword && !!appState.enableKeywordHighlighting);
  if ((chip.textContent || '').trim() !== chip.dataset.originalText) chip.classList.add(...WORD_CHIP_EDITED_CLASSES);

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
    if (e.key === 'Escape') chip.blur();
  });

  // Leaving the word COMMITS the edit into the transcript itself (see
  // commitWordEdit) — and puts its options away, unless focus went into them.
  chip.addEventListener('blur', (e) => {
    commitWordEdit(idx, chip.textContent.trim());
    if (!actionBar?.contains(e.relatedTarget)) scheduleHideWordActions();
  });

  // Selecting a word is this word's "edit target": scrub the preview to its
  // own timestamp so the canvas is already showing it, and bring up its
  // options above it.
  //
  // The MIDDLE of the word, not its start. Transcript words usually touch —
  // the previous word ends on the very instant this one starts — and the
  // preview resolves a time on a shared boundary to the EARLIER word/phrase,
  // so seeking to `start` put the neighbour on the canvas. For the same reason
  // a playhead sitting exactly on a boundary doesn't count as "already here".
  chip.addEventListener('focus', () => {
    seekToWord(wordObj);
    showWordActions(idx);
  });

  wrap.dataset.wordIndex = String(idx);
  wrap.appendChild(chip);
  syncWordChipControls(wrap, idx);
  markWordSound(chip, wordObj);
  return wrap;
}

function seekToWord(wordObj) {
  const previewVideo = document.getElementById('preview-video');
  if (!previewVideo || typeof wordObj?.start !== 'number') return;
  const end = typeof wordObj.end === 'number' ? Math.max(wordObj.end, wordObj.start) : wordObj.start;
  const t = previewVideo.currentTime;
  if (!(t > wordObj.start && t < end)) previewVideo.currentTime = wordObj.start + (end - wordObj.start) / 2;
}

// --- A transcript word's own case, and switching a word off ------------------
// Written straight to the CAPTIONS' word store (appState.captionTransforms).
// The Word panel's applyWordStyleFields routes to whatever is selected — which
// may be a word inside a text overlay — so the transcript, which always means
// a transcript word, writes here and can never touch the wrong one.

const CASE_CHOICES = [
  { value: null, label: 'Same as caption' },
  { value: 'none', label: 'As typed' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
  { value: 'capitalize', label: 'Capitalized' }
];

function wordEntry(wordIndex) {
  return appState.captionTransforms?.[getWordTransformKey(wordIndex)] || null;
}

function writeTranscriptWordEntry(wordIndex, mutate) {
  if (wordIndex == null) return;
  const key = getWordTransformKey(wordIndex);
  const map = { ...(appState.captionTransforms || {}) };
  const next = mutate({ ...(map[key] || {}) });
  if (next && Object.keys(next).length) map[key] = next;
  else delete map[key];
  updateState({ captionTransforms: map }, { recordHistory: true });
}

export function isTranscriptWordHidden(wordIndex) {
  return !!wordEntry(wordIndex)?.hidden;
}

export function setTranscriptWordHidden(wordIndex, hidden) {
  writeTranscriptWordEntry(wordIndex, (entry) => {
    if (hidden) entry.hidden = true;
    else delete entry.hidden;
    return entry;
  });
}

export function getTranscriptWordCase(wordIndex) {
  return wordEntry(wordIndex)?.style?.textCase || null;
}

export function setTranscriptWordCase(wordIndex, textCase) {
  writeTranscriptWordEntry(wordIndex, (entry) => {
    const style = { ...(entry.style || {}) };
    if (textCase) style.textCase = textCase;
    else delete style.textCase;
    if (Object.keys(style).length) entry.style = style;
    else delete entry.style;
    return entry;
  });
}

/** Brings one word's quiet marks (hidden, own case) in line with its saved state. */
function syncWordChipControls(wrap, idx) {
  const hidden = isTranscriptWordHidden(idx);
  wrap.classList.toggle('word-chip-hidden', hidden);
  const chip = wrap.querySelector('.word-chip');
  if (chip) {
    chip.classList.toggle('has-case', !!getTranscriptWordCase(idx));
    chip.title = hidden ? 'Hidden from the captions' : '';
  }
}

/**
 * Re-syncs every word after ANY change to the word store — an undo of a hide,
 * a case set from the Word panel. Words are only rebuilt when the transcript
 * itself changes, so without this a word would keep showing the old state.
 */
export function syncAllWordChipControls() {
  document.querySelectorAll('#transcript-words-container [data-word-index]').forEach((wrap) => {
    syncWordChipControls(wrap, Number(wrap.dataset.wordIndex));
  });
  refreshWordActions();
}
subscribe('captionTransforms', syncAllWordChipControls);

// --- The word's options: ONE bar, above the word you're on ---------------------

let actionBar = null;
let actionWordIndex = null;
let hideTimer = null;

const ACTIONS = [
  { key: 'keyword', icon: '★', label: 'Keyword' },
  { key: 'sound', icon: '♪', label: 'Sound' },
  { key: 'case', icon: 'Aa', label: 'Case' },
  { key: 'hide', icon: '◉', label: 'Hide' }
];

function chipFor(index) {
  return document.querySelector(`#transcript-words-container .word-chip[data-index="${index}"]`);
}

function buildActionBar() {
  const el = document.createElement('div');
  el.id = 'word-actions';
  el.className = 'word-actions';
  // Part of the panel that opened it, for its click-outside check (useClickOutside).
  el.dataset.panelFloating = '';
  el.setAttribute('role', 'toolbar');
  el.hidden = true;
  ACTIONS.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'word-actions-btn';
    btn.dataset.wordAction = a.key;
    btn.innerHTML = `<span class="word-actions-icon" aria-hidden="true">${a.icon}</span><span class="word-actions-label">${a.label}</span>`;
    // Keeps the caret in the word: pressing an option must not end the edit.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      runWordAction(a.key, btn);
    });
    el.appendChild(btn);
  });
  document.body.appendChild(el);
  // The bar follows its word as the transcript (or anything) scrolls.
  window.addEventListener('scroll', positionWordActions, true);
  window.addEventListener('resize', positionWordActions);
  // A press anywhere that is not the transcript, the bar or its case menu
  // puts the options away.
  document.addEventListener('pointerdown', (e) => {
    if (el.hidden) return;
    const t = e.target;
    if (el.contains(t) || t.closest?.('#transcript-words-container, #transcript-search, #word-case-menu')) return;
    hideWordActions();
  }, true);
  return el;
}

function runWordAction(key, btn) {
  const idx = actionWordIndex;
  if (idx == null) return;
  const wordObj = (appState.words || [])[idx];
  if (!wordObj) return;
  if (key === 'keyword') setWordKeyword(idx, !wordObj.isKeyword);
  else if (key === 'sound') {
    if (typeof wordObj.start !== 'number') return;
    window.dispatchEvent(new CustomEvent('bhynd:add-sound-at', { detail: { word: wordObj } }));
  } else if (key === 'case') openWordCaseMenu(btn, idx);
  else if (key === 'hide') setTranscriptWordHidden(idx, !isTranscriptWordHidden(idx));
}

/** The options for word `index`, above it. */
export function showWordActions(index) {
  clearTimeout(hideTimer);
  if (!actionBar) actionBar = buildActionBar();
  actionWordIndex = index;
  actionBar.dataset.forWord = String(index);
  actionBar.setAttribute('aria-label', `Options for “${(appState.words || [])[index]?.word || ''}”`);
  actionBar.hidden = false;
  refreshWordActions();
}

export function hideWordActions() {
  clearTimeout(hideTimer);
  closeWordCaseMenu();
  if (actionBar) actionBar.hidden = true;
  actionWordIndex = null;
}

// A beat of grace, so moving from one word to the next doesn't flicker the bar.
function scheduleHideWordActions() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const active = document.activeElement;
    if (active?.classList?.contains('word-chip') || active?.id === 'transcript-search' || caseMenu) return;
    hideWordActions();
  }, 120);
}

/** The bar's buttons show the word's current state; the bar sits on its word. */
function refreshWordActions() {
  if (!actionBar || actionBar.hidden || actionWordIndex == null) return;
  const idx = actionWordIndex;
  const wordObj = (appState.words || [])[idx];
  const set = (key, on, label, title) => {
    const btn = actionBar.querySelector(`[data-word-action="${key}"]`);
    btn.classList.toggle('active', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (label) btn.querySelector('.word-actions-label').textContent = label;
    btn.title = title;
  };
  const hidden = isTranscriptWordHidden(idx);
  const ownCase = getTranscriptWordCase(idx);
  const caseLabel = CASE_CHOICES.find((c) => c.value === ownCase)?.label || 'Same as caption';
  set('keyword', !!wordObj?.isKeyword, 'Keyword', wordObj?.isKeyword ? 'A keyword — click to make it a normal word' : 'Make this a keyword');
  set('sound', wordHasSound(wordObj), 'Sound', wordHasSound(wordObj) ? 'Add another sound effect on this word' : 'Add a sound effect on this word');
  set('case', !!ownCase, 'Case', `Case: ${caseLabel} — click to change`);
  set('hide', hidden, hidden ? 'Show' : 'Hide', hidden ? 'Hidden from the captions — click to show it again' : 'Hide this word from the captions');
  actionBar.querySelector('[data-word-action="hide"] .word-actions-icon').textContent = hidden ? '◌' : '◉';
  positionWordActions();
}

function positionWordActions() {
  if (!actionBar || actionBar.hidden || actionWordIndex == null) return;
  const chip = chipFor(actionWordIndex);
  // Gone, or inside a panel that is not showing (display:none has no offsetParent).
  if (!chip || !chip.isConnected || chip.offsetParent === null) { actionBar.hidden = true; return; }
  const r = chip.getBoundingClientRect();
  const panel = chip.closest('#transcript-words-container')?.getBoundingClientRect();
  // Out of the transcript's view (scrolled away): put the bar away with it.
  if (panel && (r.bottom < panel.top || r.top > panel.bottom)) { actionBar.style.visibility = 'hidden'; return; }
  actionBar.style.visibility = '';
  const w = actionBar.offsetWidth;
  const h = actionBar.offsetHeight;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
  const above = r.top - h - 8;
  actionBar.style.left = `${left}px`;
  actionBar.style.top = `${above >= 8 ? above : r.bottom + 8}px`;
  actionBar.classList.toggle('below', above < 8);
}

/** Called after the words are rebuilt (a keyword toggle rebuilds them): the bar finds its word again. */
export function reanchorWordActions() {
  if (actionWordIndex == null || !actionBar || actionBar.hidden) return;
  refreshWordActions();
}

// --- Search ------------------------------------------------------------------

/**
 * Marks the search's matches in the transcript (`indices`), and the current
 * one (`current`, a word index or null): brings it into view, puts the video
 * on it and opens its options — the same as clicking it, minus the caret, so
 * typing keeps going into the search box.
 */
export function markTranscriptSearch(indices, current) {
  const container = document.getElementById('transcript-words-container');
  if (!container) return;
  const set = new Set(indices);
  container.querySelectorAll('.word-chip').forEach((chip) => {
    const i = Number(chip.dataset.index);
    chip.classList.toggle('is-match', set.has(i));
    chip.classList.toggle('is-current', i === current);
  });
  if (current == null) return;
  const chip = chipFor(current);
  if (!chip) return;
  chip.scrollIntoView({ block: 'nearest' });
  seekToWord((appState.words || [])[current]);
  showWordActions(current);
}

/** Within this of a word's start, a sound effect counts as being ON that word. */
const WORD_SOUND_TOLERANCE = 0.03;

function wordHasSound(wordObj) {
  return typeof wordObj?.start === 'number'
    && (appState.soundEvents || []).some((e) => Math.abs(e.startTime - wordObj.start) <= WORD_SOUND_TOLERANCE);
}

function markWordSound(chip, wordObj) {
  chip.classList.toggle('has-sound', wordHasSound(wordObj));
}

/**
 * Re-marks every word that has a sound effect on it. Words are only rebuilt
 * when `words` changes, so RightInspector calls this whenever `soundEvents`
 * does — adding, moving or deleting a clip is reflected here.
 */
export function refreshWordSoundMarks(container) {
  if (!container) return;
  const words = appState.words || [];
  container.querySelectorAll('.word-chip').forEach((chip) => {
    const wordObj = words[Number(chip.dataset.index)];
    if (wordObj) markWordSound(chip, wordObj);
  });
  refreshWordActions();
}

/** The small case menu — the timeline's own popover look, so it matches the app in every colour mode. */
let caseMenu = null;
function closeWordCaseMenu() {
  if (!caseMenu) return;
  caseMenu.cleanup();
  caseMenu.el.remove();
  caseMenu = null;
}
function openWordCaseMenu(anchor, wordIndex) {
  closeWordCaseMenu();
  const current = getTranscriptWordCase(wordIndex);
  const el = document.createElement('div');
  el.className = 'timeline-convert-menu';
  el.id = 'word-case-menu';
  el.dataset.panelFloating = '';
  el.setAttribute('role', 'menu');
  const heading = document.createElement('div');
  heading.className = 'timeline-convert-menu-heading';
  heading.textContent = 'Case for this word';
  el.appendChild(heading);
  CASE_CHOICES.forEach((choice) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'timeline-convert-menu-item';
    btn.dataset.caseChoice = choice.value ?? '';
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', choice.value === current ? 'true' : 'false');
    const label = document.createElement('span');
    label.className = 'timeline-convert-menu-label';
    label.textContent = (choice.value === current ? '✓ ' : '') + choice.label;
    btn.appendChild(label);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeWordCaseMenu();
      setTranscriptWordCase(wordIndex, choice.value);
    });
    el.appendChild(btn);
  });
  document.body.appendChild(el);

  // Below the button, kept on screen.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.position = 'fixed';
  el.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left))}px`;
  el.style.top = `${r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  el.style.zIndex = '1100';

  const onOutside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeWordCaseMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeWordCaseMenu(); };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  caseMenu = {
    el,
    cleanup: () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
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
  // Both fields: the renderer reads `word` first (shared/captionGraphics.js),
  // and phrases resolved from caption events carry both — so setting only
  // `text`, as this used to, left the old `word` on screen and the edit
  // never appeared.
  nextWords[wordIdx] = { ...nextWords[wordIdx], word: newText, text: newText };

  const nextPhrases = phrases.slice();
  nextPhrases[phraseIdx] = { ...targetPhrase, words: nextWords };

  updateState({ phrases: nextPhrases }, { recordHistory: false });
}

/**
 * Commits a typed word into the TRANSCRIPT (appState.words), the source
 * every caption is resolved from. Typing only patches the on-screen phrases
 * (applyLiveWordEdit — instant, and it can't disturb the caret); this makes
 * the edit stick: without it, anything that rebuilds the captions from the
 * transcript — moving or splitting a caption on the timeline, reopening the
 * project — quietly brought the old word back.
 *
 * The word keeps its original text (originalWord) so the chip can still
 * show it was edited. Every phrase copy of the word is patched in the same
 * write, as setWordKeyword does.
 */
function commitWordEdit(flatWordIndex, newText) {
  const idx = Number(flatWordIndex);
  const words = appState.words || [];
  const current = words[idx];
  if (!current || current.word === newText) return;
  const nextWords = words.slice();
  nextWords[idx] = { ...current, word: newText, originalWord: current.originalWord ?? current.word };
  const nextPhrases = (appState.phrases || []).map((phrase) => {
    if (!(phrase.words || []).some((w) => w.wordIndex === idx)) return phrase;
    return { ...phrase, words: phrase.words.map((w) => (w.wordIndex === idx ? { ...w, word: newText, text: newText } : w)) };
  });
  updateState({ words: nextWords, phrases: nextPhrases }, { recordHistory: true });
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
