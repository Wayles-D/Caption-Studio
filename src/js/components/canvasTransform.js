/**
 * On-canvas caption transform controls (CapCut-style move/resize/rotate).
 *
 * Editor-only UI, layered above the graphics-renderer <canvas> (see
 * shared/captionGraphics.js) — it never draws into the exported video.
 * Position is expressed as customPosX/customPosY percentages (the SAME
 * fields initManualDragPositioning in preview.js already writes for manual
 * drag positioning), "resize" is expressed as the existing `fontSize` style
 * property (uniform scale, not per-axis stretch — matches the architecture's
 * existing single size knob rather than inventing a parallel scale field),
 * and "rotate" is the new `rotation` degrees field (see shared/
 * captionGraphics.js's resolveGeometry). Reusing these three existing fields
 * is what lets the SAME graphics renderer draw the transformed result in
 * both preview and export with zero extra plumbing beyond what
 * shared/captionTransform.js's resolvePhraseParams already does.
 *
 * Every frame, preview.js calls updateCanvasTransformOverlay(box, phrase,
 * mode) with the just-measured bounding box (shared/captionGraphics.js's
 * measureSentenceFrame/measureRollingStackFrame) — the box IS the coordinate
 * conversion: it's reported in the canvas's own backing-store pixel space,
 * and box.pxScale (== canvasWidth/cssPixelWidth, the same ratio
 * resolveGeometry computes) converts it to the phone-frame's on-screen CSS
 * px this module positions its DOM handles in. No separate coordinate system
 * is invented here.
 *
 * SELECTION TARGET vs. EDIT SCOPE — two independent axes, never conflated:
 *
 *   SELECTION TARGET  (what is being edited)
 *     - a single word (`selectedWordIndex` set) — see "WORD SELECTION" below
 *     - the current caption/group (`selected` true, `selectedWordIndex` null)
 *       — whichever phrase is on screen at the current playback time
 *
 *   EDIT SCOPE  (where the resulting change is applied) — appState.transformApplyScope
 *     - 'this' — only the current caption INSTANCE (keyed by
 *       getPhraseTransformKey, effectively "this occurrence", not "every
 *       phrase with the same text")
 *     - 'all'  — every caption that doesn't have its own per-phrase override
 *
 * Scope only ever applies to the CAPTION-level target. A selected WORD is
 * always edited on its own — there is no "all captions" equivalent for one
 * specific word occurrence — so word writes go through
 * applyWordTransformFields, which ignores transformApplyScope entirely (see
 * shared/captionTransform.js's getWordTransformKey doc comment).
 *
 * KEYWORD SCOPE — a third, independent case layered on top of the above,
 * never replacing it: when the selected WORD is specifically a keyword
 * (word.isKeyword), a separate scope choice (appState.keywordApplyScope:
 * 'this'|'all'|'select') decides whether an edit fans out to every keyword
 * instance across the whole transcript, or to a hand-picked subset
 * (keywordMultiSelection below), instead of just that one instance. A
 * NORMAL (non-keyword) word's edits are completely untouched by any of
 * this — they still always go through the plain applyWordTransformFields
 * exactly as before this feature existed. See applyKeywordScopedTransformFields.
 */
import { appState, updateState } from '../state.js';
import { getPhraseTransformKey, getWordTransformKey } from '../../../shared/captionTransform.js';

let overlayEl, hitAreaEl, boxEl, rotateHandleEl, scopeThisBtn, scopeAllBtn, resetBtn, rotationLabelEl;
let scopeThisKeywordBtn, scopeAllKeywordsBtn, scopeSelectKeywordsBtn, keywordMultiSelectDoneBtn, keywordMultiSelectLabelEl, keywordAnimationSelect;
let selected = false;
let currentBox = null; // { x, y, width, height, centerX, centerY, rotationDeg, pxScale, phrase, mode, words?, chunks? } in canvas backing-store px

// The individual word currently selected within currentBox, or null when the
// selection is at the whole-caption/group level. Independent of `selected`:
// `selected` means "something is highlighted" (word OR caption); this says
// WHICH of the two kinds it is.
let selectedWordIndex = null;

// "Select Keywords" mode state — see initCanvasTransform's scope-button
// wiring and the hitAreaEl pointerdown handler's isSelectingKeywords branch.
// Neither is Zustand-backed (like selectedWordIndex above, these are
// transient editor-UI concerns, not persisted/undo-tracked data); only the
// RESULT of using them — writes into appState.captionTransforms — is.
let isSelectingKeywords = false;
let keywordMultiSelection = null; // Set<number> | null
let keywordMarkerEls = [];

let drag = null; // { kind: 'move'|'resize'|'rotate', pointerId, phrase, wordIndex? }

/**
 * Reads the value a CAPTION-level (not word-level) transform field should
 * currently show/commit for `phrase`, honoring EDIT SCOPE:
 *   - 'all'  → always the live global field. A per-phrase override that may
 *     exist from an earlier "This Caption" edit on this SAME phrase is
 *     deliberately NOT consulted — under "All Captions" scope the user is
 *     editing the shared/global value, and letting a stale override win here
 *     was the exact bug this fixes: a drag would move the caption live
 *     (onPointerMove correctly writes the global field), then SNAP BACK the
 *     instant the pointer was released, because the old commit step called
 *     this function unconditionally and it always preferred the override.
 *   - 'this' → the phrase's own override if it has one, else the global
 *     field (its normal fallback).
 */
function effectiveValue(phrase, field, globalValue) {
  if (appState.transformApplyScope !== 'this' || !phrase) return globalValue;
  const key = getPhraseTransformKey(phrase);
  const override = appState.captionTransforms[key];
  return override && override[field] != null ? override[field] : globalValue;
}

/**
 * Word-level counterpart to effectiveValue — a word's own transform override
 * (offsetXPx/offsetYPx/rotationDeg/fontScale) is ALWAYS scoped to that one
 * word, regardless of transformApplyScope (see this file's top doc comment),
 * so there is no "which scope" branch here.
 */
function effectiveWordValue(wordIndex, field, fallback) {
  if (wordIndex == null) return fallback;
  const override = appState.captionTransforms[getWordTransformKey(wordIndex)];
  return override && override[field] != null ? override[field] : fallback;
}

/**
 * Flattens currentBox's per-word rects (sentence mode's `words`, or Rolling
 * Stack's `chunks[i].words`) into one list to hit-test/search — a caption
 * with no per-word data yet (an unmigrated mode, or nothing on screen)
 * simply yields an empty list, so callers fall back to the existing
 * whole-box (current-caption) behavior automatically.
 */
function getWordCandidates(box) {
  if (!box) return [];
  if (Array.isArray(box.words)) return box.words;
  if (Array.isArray(box.chunks)) return box.chunks.flatMap((c) => c.words || []);
  return [];
}

/**
 * Finds which word (if any) a canvas-backing-store-px point falls inside,
 * within currentBox's own rotated frame. Word rects (box.words/box.chunks[].words)
 * are reported in the SAME pre-rotation local space as the block's own x/y
 * (see measureSentenceFrame/measureRollingStackFrame) — so the point is first
 * un-rotated around the block's center exactly like pointInRotatedBox does
 * for the whole box, then compared against each word's own rect. A word's
 * OWN additional rotation/offset override (if it already has one) is
 * intentionally not un-done here — hit-testing a word that's already been
 * transformed uses its pre-transform footprint, a deliberate simplification
 * since a fresh click always starts from an untransformed word.
 *
 * Horizontal tolerance is clamped to at most half the gap to each
 * IMMEDIATE horizontal neighbor (words already sorted left-to-right within
 * a line) — a flat, generous padding would fully swallow the few px of
 * wordSpacingPx between two tightly-packed words (e.g. "CLAUDE IS GOOD" on
 * one line), leaving no point anywhere in that gap that resolves to
 * "no word" — which is exactly the click a user makes to select the CURRENT
 * CAPTION as a whole rather than an individual word (see this file's top
 * doc comment on selection target vs. edit scope). Vertical tolerance
 * doesn't need this treatment since word rects don't tile vertically within
 * one line.
 */
function findWordAtPoint(px, py, box) {
  const candidates = getWordCandidates(box);
  if (!candidates.length) return null;

  const rad = (-(box.rotationDeg || 0) * Math.PI) / 180;
  const dx = px - box.centerX;
  const dy = py - box.centerY;
  const localX = box.centerX + (dx * Math.cos(rad) - dy * Math.sin(rad));
  const localY = box.centerY + (dx * Math.sin(rad) + dy * Math.cos(rad));

  const MAX_PAD = 4;
  return candidates.find((w) => {
    const sameRow = candidates.filter((o) => o !== w && o.y === w.y);
    const prevGap = sameRow.filter((o) => o.x + o.width <= w.x)
      .reduce((closest, o) => Math.min(closest, w.x - (o.x + o.width)), Infinity);
    const nextGap = sameRow.filter((o) => o.x >= w.x + w.width)
      .reduce((closest, o) => Math.min(closest, o.x - (w.x + w.width)), Infinity);
    // Leaves roughly the middle 30% of a gap as a genuine "no word" dead
    // zone (0.35 each side, not 0.5) — clamping to exactly half would let
    // two adjacent words' padding meet with zero margin, still leaving no
    // point that reliably resolves to "the caption, not a word".
    const padLeft = Math.min(MAX_PAD, prevGap * 0.35);
    const padRight = Math.min(MAX_PAD, nextGap * 0.35);
    return localX >= w.x - padLeft && localX <= w.x + w.width + padRight &&
      localY >= w.y - MAX_PAD && localY <= w.y + w.height + MAX_PAD;
  }) || null;
}

/**
 * Builds the on-screen box for one selected word, in the SAME canvas
 * backing-store px space as currentBox — the word's own rect, inflated by
 * any transform override it already has (so the selection handles stay
 * glued to the word's actual current position/size/rotation after a
 * drag/resize/rotate, exactly like currentBox already does for the whole
 * caption via captionTransforms). Composes the word's own extra rotation on
 * TOP of the parent block's rotation, since that's how it's actually painted
 * (see shared/captionGraphics.js's per-word ctx.save/rotate).
 */
function wordBoxFor(word, box) {
  const scale = effectiveWordValue(word.wordIndex, 'fontScale', 1) || 1;
  const offsetX = effectiveWordValue(word.wordIndex, 'offsetXPx', 0) || 0;
  const offsetY = effectiveWordValue(word.wordIndex, 'offsetYPx', 0) || 0;
  const ownRotation = effectiveWordValue(word.wordIndex, 'rotationDeg', 0) || 0;

  const centerX = word.x + word.width / 2 + offsetX;
  const centerY = word.y + word.height / 2 + offsetY;
  const width = word.width * scale;
  const height = word.height * scale;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    centerX,
    centerY,
    rotationDeg: (box.rotationDeg || 0) + ownRotation,
    pxScale: box.pxScale,
    wordIndex: word.wordIndex
  };
}

/**
 * Writes one or more CAPTION-level transform fields, honoring EDIT SCOPE.
 * "This Caption" writes into appState.captionTransforms[phraseKey] (an
 * immutable copy — appState objects are never mutated in place, so undo/
 * redo snapshots taken by reference stay correct); "All Captions" writes
 * the same field names directly onto global style state — the exact fields
 * every phrase already falls back to when it has no override, so no
 * special-casing is needed anywhere else.
 */
function applyTransformFields(fields, { recordHistory, phrase }) {
  const targetPhrase = phrase || currentBox?.phrase;
  if (!currentBox && !targetPhrase) return;
  if (appState.transformApplyScope === 'this' && targetPhrase) {
    const key = getPhraseTransformKey(targetPhrase);
    const existing = appState.captionTransforms[key] || {};
    const nextMap = { ...appState.captionTransforms, [key]: { ...existing, ...fields } };
    updateState({ captionTransforms: nextMap }, { recordHistory });
  } else {
    // customPosX/Y only take effect when position === 'manual' (see
    // getCSSPreviewFromConfig/getASSStyleFromConfig) — a global move-drag
    // switches it on automatically, the same way "This Caption" scope's
    // resolvePhraseParams forces it for a per-phrase override, so a move
    // gesture always visibly moves the caption regardless of the position
    // dropdown's current setting.
    const globalFields = 'customPosX' in fields || 'customPosY' in fields
      ? { ...fields, position: 'manual' }
      : fields;

    // "All Captions" scope is being used to manipulate THIS SPECIFIC
    // caption instance right now — resolvePhraseParams always prefers a
    // per-phrase override over the global value when one exists (by design,
    // for "This Caption" edits to survive everything else), which would
    // otherwise make this exact caption look completely unresponsive to an
    // "All Captions" drag: the global field updates correctly, but THIS
    // instance keeps rendering at its old override position regardless,
    // because its own override still wins. Dragging it while scope is "All"
    // unambiguously means "this position should apply everywhere, including
    // here" — so its own leftover override (if any) is released as part of
    // the same gesture, letting it fall back to (and move with) the global
    // value being set, exactly like every other un-overridden caption.
    let nextTransforms = appState.captionTransforms;
    if (targetPhrase) {
      const key = getPhraseTransformKey(targetPhrase);
      if (key in nextTransforms) {
        nextTransforms = { ...nextTransforms };
        delete nextTransforms[key];
      }
    }
    if (nextTransforms !== appState.captionTransforms) {
      updateState({ ...globalFields, captionTransforms: nextTransforms }, { recordHistory });
      return;
    }
    updateState(globalFields, { recordHistory });
  }
}

/**
 * Word-level counterpart to applyTransformFields — always writes into
 * appState.captionTransforms[getWordTransformKey(wordIndex)], regardless of
 * the This/All scope toggle: that toggle exists to choose between "just this
 * caption" and "every caption", neither of which is a meaningful choice for
 * an edit to one specific WORD, which is inherently narrower than either.
 */
function applyWordTransformFields(wordIndex, fields, { recordHistory }) {
  if (wordIndex == null) return;
  const key = getWordTransformKey(wordIndex);
  const existing = appState.captionTransforms[key] || {};
  const nextMap = { ...appState.captionTransforms, [key]: { ...existing, ...fields } };
  updateState({ captionTransforms: nextMap }, { recordHistory });
}

/**
 * Every keyword instance's wordIndex across the ENTIRE transcript (not just
 * what's on screen right now) — appState.words is the flat, whole-video word
 * list every other keyword-identity lookup in this codebase already uses
 * (see transcriptEditorState.js), so "All Keywords" genuinely spans every
 * caption, not just the currently visible one, using the real isKeyword
 * flag/wordIndex identity rather than matching on text (per this feature's
 * own requirement).
 */
function getAllKeywordWordIndexes() {
  return (appState.words || []).filter((w) => w.isKeyword).map((w) => w.wordIndex);
}

/** Whether `wordIndex` is currently a keyword, per the actual word data (not appearance) — see getWordCandidates. */
function isKeywordIndex(wordIndex) {
  if (wordIndex == null || !currentBox) return false;
  return !!getWordCandidates(currentBox).find((w) => w.wordIndex === wordIndex)?.isKeyword;
}

/**
 * Keyword-scope counterpart to applyWordTransformFields — fans the SAME
 * fields out to every keyword instance ('all') or to the confirmed
 * "Select Keywords" set ('select'), reusing applyWordTransformFields as the
 * single per-word write primitive either way; 'this' (the default) is
 * byte-identical to calling applyWordTransformFields directly. Only ever
 * called for a word already confirmed to be a keyword — a normal word's
 * edits never pass through here (see the call sites in onPointerMove/endDrag).
 */
function applyKeywordScopedTransformFields(wordIndex, fields, opts) {
  const scope = appState.keywordApplyScope;
  if (scope === 'all') {
    getAllKeywordWordIndexes().forEach((idx) => applyWordTransformFields(idx, fields, opts));
  } else if (scope === 'select' && keywordMultiSelection && keywordMultiSelection.size) {
    keywordMultiSelection.forEach((idx) => applyWordTransformFields(idx, fields, opts));
  } else {
    applyWordTransformFields(wordIndex, fields, opts);
  }
}

/**
 * Single dispatch point for every word-level write (move/resize/rotate, live
 * and on commit) — keyword words fan out per keywordApplyScope, normal words
 * go straight through applyWordTransformFields exactly as before this
 * feature existed. Used instead of calling applyWordTransformFields directly
 * at the onPointerMove/endDrag call sites.
 */
function writeWordFields(wordIndex, fields, opts) {
  if (isKeywordIndex(wordIndex)) {
    applyKeywordScopedTransformFields(wordIndex, fields, opts);
  } else {
    applyWordTransformFields(wordIndex, fields, opts);
  }
}

/** Reset counterpart to applyKeywordScopedTransformFields — same scope fan-out, applied to resetWordTransform instead of a field write. */
function resetKeywordScopedTransform(wordIndex) {
  const scope = appState.keywordApplyScope;
  if (scope === 'all') {
    getAllKeywordWordIndexes().forEach((idx) => resetWordTransform(idx));
  } else if (scope === 'select' && keywordMultiSelection && keywordMultiSelection.size) {
    keywordMultiSelection.forEach((idx) => resetWordTransform(idx));
  } else {
    resetWordTransform(wordIndex);
  }
}

/**
 * Clears keyword-scope UI state back to its defaults — called whenever the
 * selection ANCHOR changes (a different word/caption is clicked, or nothing
 * is selected at all) so a scope choice never silently carries over onto an
 * unrelated later edit. Deliberately NOT called between edits to the SAME
 * still-selected keyword, so choosing "All Keywords" once and then dragging
 * several times in a row keeps applying to all of them, as expected.
 */
function resetKeywordScopeState() {
  if (appState.keywordApplyScope !== 'this') {
    updateState({ keywordApplyScope: 'this' }, { recordHistory: false });
  }
  isSelectingKeywords = false;
  keywordMultiSelection = null;
  clearKeywordMultiSelectMarkers();
}

function clearKeywordMultiSelectMarkers() {
  keywordMarkerEls.forEach((el) => el.remove());
  keywordMarkerEls = [];
}

/**
 * Renders one small highlight marker per keyword instance currently in
 * keywordMultiSelection, positioned with the exact same box math
 * positionBoxElement already uses for the single-selection box (wordBoxFor +
 * pxScale) — plain absolutely-positioned, pointer-events:none <div>s (see
 * style.css's .caption-transform-keyword-marker) so they never intercept
 * clicks meant for the hit-area beneath them.
 */
function renderKeywordMultiSelectMarkers() {
  clearKeywordMultiSelectMarkers();
  if (!keywordMultiSelection || !keywordMultiSelection.size || !currentBox || !overlayEl) return;
  const candidates = getWordCandidates(currentBox);
  keywordMultiSelection.forEach((idx) => {
    const word = candidates.find((w) => w.wordIndex === idx);
    if (!word) return;
    const box = wordBoxFor(word, currentBox);
    const scale = box.pxScale || 1;
    const marker = document.createElement('div');
    marker.className = 'caption-transform-keyword-marker';
    marker.style.left = `${box.x / scale}px`;
    marker.style.top = `${box.y / scale}px`;
    marker.style.width = `${box.width / scale}px`;
    marker.style.height = `${box.height / scale}px`;
    marker.style.transform = box.rotationDeg ? `rotate(${box.rotationDeg}deg)` : '';
    marker.style.transformOrigin = 'center center';
    overlayEl.appendChild(marker);
    keywordMarkerEls.push(marker);
  });
}

function resetWordTransform(wordIndex) {
  const key = getWordTransformKey(wordIndex);
  if (!(key in appState.captionTransforms)) return;
  const nextMap = { ...appState.captionTransforms };
  delete nextMap[key];
  updateState({ captionTransforms: nextMap }, { recordHistory: true });
}

function resetCurrentTransform() {
  if (!currentBox) return;
  if (selectedWordIndex != null) {
    if (isKeywordIndex(selectedWordIndex)) {
      resetKeywordScopedTransform(selectedWordIndex);
    } else {
      resetWordTransform(selectedWordIndex);
    }
    return;
  }
  if (appState.transformApplyScope === 'this' && currentBox.phrase) {
    const key = getPhraseTransformKey(currentBox.phrase);
    if (!(key in appState.captionTransforms)) return;
    const nextMap = { ...appState.captionTransforms };
    delete nextMap[key];
    updateState({ captionTransforms: nextMap }, { recordHistory: true });
  } else {
    // Also release this caption's own leftover "This Caption" override (if
    // any), for the same reason applyTransformFields does on an "All
    // Captions" drag — otherwise Reset would restore the global defaults
    // but this ONE caption would keep rendering at its old override,
    // silently ignoring the reset it was just asked to perform.
    const updates = { customPosX: 50, customPosY: 85, rotation: 0, fontSize: 14 };
    if (currentBox.phrase) {
      const key = getPhraseTransformKey(currentBox.phrase);
      if (key in appState.captionTransforms) {
        const nextMap = { ...appState.captionTransforms };
        delete nextMap[key];
        updates.captionTransforms = nextMap;
      }
    }
    updateState(updates, { recordHistory: true });
  }
}

function pointInRotatedBox(px, py, box) {
  const rad = (-(box.rotationDeg || 0) * Math.PI) / 180;
  const dx = px - box.centerX;
  const dy = py - box.centerY;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(localX) <= box.width / 2 + 4 && Math.abs(localY) <= box.height / 2 + 4;
}

function getPhoneFrame() {
  return document.querySelector('.phone-frame');
}

// Extra breathing room (CSS px, converted to the box's own backing-store px
// via pxScale) drawn around the whole-caption/group selection box only — a
// purely visual/interaction adjustment so the border and resize/rotate
// handles aren't glued to the text and don't crowd clicking a word inside
// it. Deliberately not applied to a single selected WORD's box (wordBoxFor),
// which should keep hugging that one word tightly, and never touches
// currentBox itself — hit-testing (findWordAtPoint/pointInRotatedBox) and
// the graphics renderer keep reading the real, unpadded measurement.
const CAPTION_SELECTION_PADDING_CSS_PX = 16;

function inflateBox(box, paddingCssPx) {
  const pad = paddingCssPx * (box.pxScale || 1);
  return {
    ...box,
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2
  };
}

/**
 * The box currently shown/dragged: the selected word's own rect (see
 * wordBoxFor) when selectedWordIndex is set, otherwise the whole caption's
 * box, padded for display (see inflateBox above) — the ONLY box that existed
 * before word-level selection. Every drag/resize/rotate/position function
 * reads this instead of currentBox directly so the same code path naturally
 * serves both selection targets; the padding is symmetric around the same
 * center, so it doesn't change what a drag/resize/rotate gesture computes.
 */
function getDisplayBox() {
  if (!currentBox) return null;
  if (selectedWordIndex != null) {
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === selectedWordIndex);
    if (word) return wordBoxFor(word, currentBox);
  }
  return inflateBox(currentBox, CAPTION_SELECTION_PADDING_CSS_PX);
}

function positionBoxElement() {
  const box = getDisplayBox();
  if (!boxEl || !box) return;
  const scale = box.pxScale || 1;
  const cssX = box.x / scale;
  const cssY = box.y / scale;
  const cssW = box.width / scale;
  const cssH = box.height / scale;

  boxEl.style.left = `${cssX}px`;
  boxEl.style.top = `${cssY}px`;
  boxEl.style.width = `${cssW}px`;
  boxEl.style.height = `${cssH}px`;
  boxEl.style.transform = box.rotationDeg ? `rotate(${box.rotationDeg}deg)` : '';
  boxEl.style.transformOrigin = 'center center';
  if (rotationLabelEl) rotationLabelEl.textContent = `${Math.round(box.rotationDeg || 0)}°`;
}

/**
 * What the current on-canvas selection actually IS — the answer decides
 * WHICH scope buttons make sense to show at all (see this feature's own doc
 * comment at the top of the file: selection target vs. edit scope are
 * always two separate questions). 'caption' when nothing/only the whole
 * block is selected, 'keyword' or 'word' when a specific word is, split by
 * its real isKeyword data (never by appearance).
 */
function currentSelectionTarget() {
  if (selectedWordIndex == null) return 'caption';
  // While actively picking "Select Keywords" instances, the anchor keyword
  // itself may have scrolled off screen (the user is deliberately navigating
  // elsewhere to find more instances to add) — isKeywordIndex can only ever
  // check words in the CURRENT box, so it would wrongly read as "not a
  // keyword" (word not found) and hide the whole keyword toolbar mid-session.
  // Once a session starts from a real keyword, it stays classified as one
  // for its duration regardless of what's currently on screen.
  if (isSelectingKeywords || appState.keywordApplyScope !== 'this') return 'keyword';
  return isKeywordIndex(selectedWordIndex) ? 'keyword' : 'word';
}

/**
 * Syncs every scope-related toolbar element to the current selection target
 * + scope state. Only ONE of the three button groups (caption / keyword /
 * keyword-multiselect-in-progress) is ever visible at once — "Do not show
 * confusing options that do not apply to the current selection" is this
 * feature's own explicit requirement. A plain normal word shows none of
 * them (Reset stays available regardless — it's not scope-specific).
 */
function updateScopeButtons() {
  const target = currentSelectionTarget();

  const showCaptionScope = target === 'caption';
  if (scopeThisBtn) scopeThisBtn.hidden = !showCaptionScope;
  if (scopeAllBtn) scopeAllBtn.hidden = !showCaptionScope;
  if (showCaptionScope) {
    scopeThisBtn?.classList.toggle('active', appState.transformApplyScope === 'this');
    scopeAllBtn?.classList.toggle('active', appState.transformApplyScope !== 'this');
  }

  const showKeywordScope = target === 'keyword' && !isSelectingKeywords;
  [scopeThisKeywordBtn, scopeAllKeywordsBtn, scopeSelectKeywordsBtn].forEach((btn) => { if (btn) btn.hidden = !showKeywordScope; });
  if (showKeywordScope) {
    scopeThisKeywordBtn?.classList.toggle('active', appState.keywordApplyScope === 'this');
    scopeAllKeywordsBtn?.classList.toggle('active', appState.keywordApplyScope === 'all');
    scopeSelectKeywordsBtn?.classList.toggle('active', appState.keywordApplyScope === 'select');
  }

  const showMultiSelectUi = target === 'keyword' && isSelectingKeywords;
  if (keywordMultiSelectDoneBtn) keywordMultiSelectDoneBtn.hidden = !showMultiSelectUi;
  if (keywordMultiSelectLabelEl) {
    keywordMultiSelectLabelEl.hidden = !showMultiSelectUi;
    if (showMultiSelectUi) {
      const count = keywordMultiSelection ? keywordMultiSelection.size : 0;
      keywordMultiSelectLabelEl.textContent = `${count} selected`;
    }
  }

  if (keywordAnimationSelect) {
    keywordAnimationSelect.hidden = target !== 'keyword';
    if (target === 'keyword') {
      const override = appState.captionTransforms[getWordTransformKey(selectedWordIndex)];
      const current = override?.animationType || 'none';
      if (keywordAnimationSelect.value !== current) keywordAnimationSelect.value = current;
    }
  }

  // While picking "Select Keywords" instances, boxEl often falls back to
  // covering the WHOLE caption (see getDisplayBox — the anchor word is
  // frequently not part of whatever's on screen right now, since the user is
  // deliberately navigating elsewhere to find more instances). Sitting on
  // top of hitAreaEl, it would otherwise swallow every click meant for
  // findWordAtPoint's own multi-select toggle (see the hitAreaEl pointerdown
  // handler) before it ever gets there. Making it click-through — except for
  // the toolbar itself, which keeps its own `pointer-events: auto` (see
  // style.css) so Done/the scope buttons stay clickable throughout.
  if (boxEl) boxEl.style.pointerEvents = isSelectingKeywords ? 'none' : '';
}

/**
 * Called once per rendered frame from preview.js's syncVideoSubtitles, right
 * after the graphics renderer draws (or skips) a frame.
 *
 * @param {object|null} box - measureSentenceFrame/measureRollingStackFrame's result, or null if nothing is on screen right now.
 * @param {object} phrase - The active phrase this box belongs to.
 * @param {'sentence'|'rolling-stack'} mode
 */
export function updateCanvasTransformOverlay(box, phrase, mode) {
  if (!overlayEl) return;

  if (!box) {
    hideCanvasTransformOverlay();
    return;
  }

  currentBox = { ...box, phrase, mode };
  overlayEl.classList.add('active');

  // A selected word only stays selected across ticks if it's still actually
  // present in this frame's box (e.g. still part of the active phrase/
  // Rolling Stack window) — otherwise the caption it belonged to has since
  // scrolled off, and clinging to a stale wordIndex would show handles for a
  // word no longer on screen. Falls back to whole-caption selection rather
  // than fully deselecting, since a caption IS still on screen.
  // Skipped while actively picking "Select Keywords" instances (the anchor
  // keyword is EXPECTED to scroll off screen as the user deliberately
  // navigates elsewhere to find more instances — see currentSelectionTarget's
  // matching doc comment) AND once a broader keyword scope ('all'/'select')
  // has actually been confirmed: that choice is a durable decision the user
  // just made, not something to silently discard the next time the video
  // happens to scroll the anchor out of view before they've had a chance to
  // drag it again. Only the default 'this' scope (ordinary single-word/
  // keyword editing, unchanged from before this feature existed) still
  // clears on staleness, exactly as it always has.
  if (!isSelectingKeywords && appState.keywordApplyScope === 'this' &&
      selectedWordIndex != null && !getWordCandidates(currentBox).some((w) => w.wordIndex === selectedWordIndex)) {
    selectedWordIndex = null;
    resetKeywordScopeState();
  }

  if (isSelectingKeywords) renderKeywordMultiSelectMarkers();

  if (selected && !drag) {
    boxEl.hidden = false;
    positionBoxElement();
    updateScopeButtons();
  } else if (!drag) {
    boxEl.hidden = true;
  }
}

/**
 * Hides the overlay entirely — called whenever the current frame has no
 * graphics-rendered caption on screen (nothing to select/transform), so
 * stale handles never linger over a demo caption, Word Mode, or a
 * still-CSS-rendered preset/mode.
 *
 * Deliberately does NOT clear `selected`/selectedWordIndex — preview.js
 * calls this unconditionally at the top of EVERY syncVideoSubtitles tick as
 * a defensive reset, then re-shows the overlay moments later in the same
 * call whenever a caption is actually on screen (see
 * updateCanvasTransformOverlay's own stale-selection check just above, which
 * is the right place to drop a selection that's genuinely no longer valid).
 * Clearing selectedWordIndex here would deselect the just-selected word on
 * literally every frame, before its own re-selection logic ever runs.
 */
export function hideCanvasTransformOverlay() {
  currentBox = null;
  if (overlayEl) overlayEl.classList.remove('active');
  if (boxEl) boxEl.hidden = true;
}

function clientToCssPoint(clientX, clientY) {
  const rect = getPhoneFrame().getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top, rect };
}

/**
 * Shared word hit-test used by BOTH hitAreaEl and boxEl's pointerdown
 * handlers — needed because once the whole-caption/group is selected, boxEl
 * spans the entire caption and physically sits on top of hitAreaEl beneath
 * it, so a second click meant to drill into one specific word lands on boxEl
 * instead and would otherwise never reach the word-vs-caption logic at all.
 */
function hitTestWordAtClient(clientX, clientY) {
  if (!currentBox) return null;
  const { x, y } = clientToCssPoint(clientX, clientY);
  const scale = currentBox.pxScale || 1;
  return findWordAtPoint(x * scale, y * scale, currentBox);
}

function beginMove(e) {
  if (!currentBox) return;
  // Pin the phrase (and, when one is selected, the word) this gesture
  // targets at drag-start — currentBox is reassigned every render tick (see
  // updateCanvasTransformOverlay) to whatever's on screen AT THE CURRENT
  // PLAYBACK TIME, so without pinning it, a drag that happens to straddle a
  // phrase/chunk boundary (video still playing) could silently retarget
  // mid-gesture onto the NEXT caption's/word's override instead of the one
  // the user actually grabbed.
  const wordIndex = selectedWordIndex;
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  drag = {
    kind: 'move',
    pointerId: e.pointerId,
    phrase: currentBox.phrase,
    wordIndex,
    // Word move is a pixel offset relative to where the drag STARTED, not a
    // frame-relative percentage (see onPointerMove) — capture the pointer's
    // own starting CSS position and the word's already-applied offset so the
    // gesture composes with any prior drag instead of resetting it.
    startPointerX: x,
    startPointerY: y,
    startOffsetXPx: wordIndex != null ? effectiveWordValue(wordIndex, 'offsetXPx', 0) : 0,
    startOffsetYPx: wordIndex != null ? effectiveWordValue(wordIndex, 'offsetYPx', 0) : 0
  };
  hitAreaEl.setPointerCapture(e.pointerId);
}

function beginResize(e, corner) {
  if (!currentBox) return;
  const box = getDisplayBox();
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.pxScale || 1;
  const centerX = box.centerX / scale;
  const centerY = box.centerY / scale;
  const startDist = Math.hypot(x - centerX, y - centerY) || 1;
  const wordIndex = selectedWordIndex;
  const startFontSize = wordIndex != null
    ? effectiveWordValue(wordIndex, 'fontScale', 1)
    : effectiveValue(currentBox.phrase, 'fontSize', appState.fontSize);
  drag = { kind: 'resize', pointerId: e.pointerId, startDist, startFontSize, corner, phrase: currentBox.phrase, wordIndex };
  e.target.setPointerCapture(e.pointerId);
}

function beginRotate(e) {
  if (!currentBox) return;
  drag = { kind: 'rotate', pointerId: e.pointerId, phrase: currentBox.phrase, wordIndex: selectedWordIndex };
  e.target.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!drag || !currentBox) return;
  const box = getDisplayBox();
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.pxScale || 1;
  const centerX = box.centerX / scale;
  const centerY = box.centerY / scale;
  const wordIndex = drag.wordIndex;

  if (drag.kind === 'move') {
    if (wordIndex != null) {
      // A word's move is a plain pixel offset from its own laid-out
      // position (see shared/captionGraphics.js's per-word ctx.translate),
      // not a percentage of the whole frame like a caption's customPosX/Y —
      // a word has no independent "anchor" of its own to express as a
      // frame-relative percentage. Offset is stored in canvas backing-store
      // px (the space captionGraphics.js's paint loop actually uses), so the
      // CSS-px pointer delta is scaled up by pxScale before being added to
      // whatever offset the word already had at drag-start.
      const deltaCssX = x - drag.startPointerX;
      const deltaCssY = y - drag.startPointerY;
      writeWordFields(wordIndex, {
        offsetXPx: drag.startOffsetXPx + deltaCssX * scale,
        offsetYPx: drag.startOffsetYPx + deltaCssY * scale
      }, { recordHistory: false });
    } else {
      const { rect } = clientToCssPoint(e.clientX, e.clientY);
      const xPct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      const yPct = Math.max(0, Math.min(100, (y / rect.height) * 100));
      applyTransformFields({ customPosX: xPct, customPosY: yPct }, { recordHistory: false, phrase: drag.phrase });
    }
  } else if (drag.kind === 'resize') {
    const dist = Math.hypot(x - centerX, y - centerY) || 1;
    const ratio = dist / drag.startDist;
    if (wordIndex != null) {
      const nextScale = Math.max(0.3, Math.min(4, drag.startFontSize * ratio));
      writeWordFields(wordIndex, { fontScale: nextScale }, { recordHistory: false });
    } else {
      const nextFontSize = Math.max(6, Math.min(150, Math.round(drag.startFontSize * ratio)));
      applyTransformFields({ fontSize: nextFontSize }, { recordHistory: false, phrase: drag.phrase });
    }
  } else if (drag.kind === 'rotate') {
    const angleDeg = (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
    const rotationDeg = Math.round(angleDeg + 90);
    if (wordIndex != null) {
      writeWordFields(wordIndex, { rotationDeg }, { recordHistory: false });
    } else {
      applyTransformFields({ rotation: rotationDeg }, { recordHistory: false, phrase: drag.phrase });
    }
  }
}

function endDrag() {
  if (!drag) return;
  const { kind, phrase, wordIndex } = drag;
  drag = null;
  // Commit the whole gesture as one undo step, mirroring
  // initManualDragPositioning's own drag-then-commit pattern. Re-reads the
  // value through effectiveValue/effectiveWordValue (scope-aware:
  // captionTransforms override for "This Caption"/a selected word, global
  // appState field for "All Captions") rather than always the raw global —
  // reading the raw global unconditionally was a real bug: for "This
  // Caption" (or a word) the actual just-set value lives in
  // captionTransforms[key], not the (untouched) global field, so this commit
  // step was silently overwriting the drag's own result with a stale global
  // value the instant the pointer was released.
  if (wordIndex != null) {
    if (kind === 'move') {
      writeWordFields(wordIndex, {
        offsetXPx: effectiveWordValue(wordIndex, 'offsetXPx', 0),
        offsetYPx: effectiveWordValue(wordIndex, 'offsetYPx', 0)
      }, { recordHistory: true });
    } else if (kind === 'resize') {
      writeWordFields(wordIndex, { fontScale: effectiveWordValue(wordIndex, 'fontScale', 1) }, { recordHistory: true });
    } else if (kind === 'rotate') {
      writeWordFields(wordIndex, { rotationDeg: effectiveWordValue(wordIndex, 'rotationDeg', 0) }, { recordHistory: true });
    }
    return;
  }
  if (kind === 'move') {
    applyTransformFields({
      customPosX: effectiveValue(phrase, 'customPosX', appState.customPosX),
      customPosY: effectiveValue(phrase, 'customPosY', appState.customPosY)
    }, { recordHistory: true, phrase });
  } else if (kind === 'resize') {
    applyTransformFields({ fontSize: effectiveValue(phrase, 'fontSize', appState.fontSize) }, { recordHistory: true, phrase });
  } else if (kind === 'rotate') {
    applyTransformFields({ rotation: effectiveValue(phrase, 'rotation', appState.rotation) }, { recordHistory: true, phrase });
  }
}

// Dev-only test hook (mirrors App.jsx's window.__appState/__updateState) —
// reports a word's current on-screen CSS rect (relative to .phone-frame) so
// automated tests can click the exact right spot without guessing layout
// coordinates. Never included in a production build (see App.jsx's own
// identical guard).
if (import.meta.env.DEV) {
  window.__debugWordScreenRect = (wordIndex) => {
    if (!currentBox) return null;
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === wordIndex);
    if (!word) return null;
    const box = wordBoxFor(word, currentBox);
    const scale = box.pxScale || 1;
    return { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale, centerX: box.centerX / scale, centerY: box.centerY / scale };
  };
  window.__debugKeywordScopeState = () => ({
    selectedWordIndex, isSelectingKeywords,
    keywordMultiSelection: keywordMultiSelection ? Array.from(keywordMultiSelection) : null
  });
  window.__debugCaptionBoxRect = () => {
    if (!currentBox) return null;
    const scale = currentBox.pxScale || 1;
    return { x: currentBox.x / scale, y: currentBox.y / scale, width: currentBox.width / scale, height: currentBox.height / scale, centerX: currentBox.centerX / scale, centerY: currentBox.centerY / scale };
  };
}

export function initCanvasTransform() {
  overlayEl = document.getElementById('caption-transform-overlay');
  hitAreaEl = document.getElementById('caption-transform-hit-area');
  boxEl = document.getElementById('caption-transform-box');
  rotateHandleEl = document.getElementById('caption-transform-handle-rotate');
  scopeThisBtn = document.getElementById('btn-transform-scope-this');
  scopeAllBtn = document.getElementById('btn-transform-scope-all');
  resetBtn = document.getElementById('btn-transform-reset');
  rotationLabelEl = document.getElementById('caption-transform-rotation-label');
  scopeThisKeywordBtn = document.getElementById('btn-transform-scope-this-keyword');
  scopeAllKeywordsBtn = document.getElementById('btn-transform-scope-all-keywords');
  scopeSelectKeywordsBtn = document.getElementById('btn-transform-scope-select-keywords');
  keywordMultiSelectDoneBtn = document.getElementById('btn-transform-keyword-multiselect-done');
  keywordMultiSelectLabelEl = document.getElementById('caption-transform-keyword-multiselect-label');
  keywordAnimationSelect = document.getElementById('select-keyword-transform-animation');
  if (!overlayEl || !hitAreaEl || !boxEl) return;

  updateScopeButtons();

  hitAreaEl.addEventListener('pointerdown', (e) => {
    if (!currentBox) return;
    const { x, y } = clientToCssPoint(e.clientX, e.clientY);
    const scale = currentBox.pxScale || 1;

    // Word hit-test first — findWordAtPoint/currentBox.words/.chunks are all
    // in canvas backing-store px, so the CSS-px pointer point is scaled UP
    // to match (the inverse of every other conversion in this file, which
    // scales box fields DOWN to CSS px). A hit here selects that ONE word;
    // words sharing a Rolling Stack window (or a Sentence-mode line) each
    // get their own independent selection even though they render together.
    const word = findWordAtPoint(x * scale, y * scale, currentBox);

    // "Select Keywords" mode: clicks toggle membership in the confirmed set
    // instead of starting a new selection/drag — the originally-selected
    // keyword (the "anchor") stays selectedWordIndex throughout, so a
    // property change made afterward still originates from it.
    if (isSelectingKeywords) {
      if (word && word.isKeyword) {
        if (!keywordMultiSelection) keywordMultiSelection = new Set();
        if (keywordMultiSelection.has(word.wordIndex)) keywordMultiSelection.delete(word.wordIndex);
        else keywordMultiSelection.add(word.wordIndex);
        renderKeywordMultiSelectMarkers();
        updateScopeButtons();
      }
      return;
    }

    if (word) {
      // TWO-STEP SELECTION: a word hit doesn't jump straight to word-level
      // selection — it only drills in if the whole caption/group this word
      // belongs to is ALREADY the current selection (selected with no word
      // singled out yet), or if this exact word is already the one selected
      // (keeps a drag/re-click on it working as before). Any other click on
      // a word — nothing selected yet, or a DIFFERENT word/caption was
      // selected — selects the whole current caption/group first, exactly
      // like clicking the caption's padding does below. This restores
      // "click a caption to select it as a whole" without touching how an
      // already-drilled-in word behaves once selected. Keyword vs. normal
      // status never factors into this — see this file's top doc comment.
      const alreadyGroupSelected = selected && selectedWordIndex == null;
      const alreadyThisWordSelected = selectedWordIndex === word.wordIndex;

      if (alreadyGroupSelected && !alreadyThisWordSelected) {
        resetKeywordScopeState();
        selected = true;
        selectedWordIndex = word.wordIndex;
        boxEl.hidden = false;
        positionBoxElement();
        updateScopeButtons();
        beginMove(e);
        return;
      }

      if (!alreadyThisWordSelected) {
        if (selectedWordIndex != null) resetKeywordScopeState();
        selected = true;
        selectedWordIndex = null;
        boxEl.hidden = false;
        positionBoxElement();
        updateScopeButtons();
        beginMove(e);
        return;
      }

      // Already this exact word's selection — unchanged existing behavior.
      boxEl.hidden = false;
      positionBoxElement();
      updateScopeButtons();
      beginMove(e);
      return;
    }

    const boxCss = {
      centerX: currentBox.centerX / scale,
      centerY: currentBox.centerY / scale,
      width: currentBox.width / scale,
      height: currentBox.height / scale,
      rotationDeg: currentBox.rotationDeg
    };
    if (pointInRotatedBox(x, y, boxCss)) {
      // Missed every individual word's rect but still landed inside the
      // whole caption's box (e.g. its padding) — this is CURRENT CAPTION
      // selection: the caption on screen right now, as a unit.
      if (selectedWordIndex != null) resetKeywordScopeState();
      selected = true;
      selectedWordIndex = null;
      boxEl.hidden = false;
      positionBoxElement();
      updateScopeButtons();
      // Start moving on THIS SAME press instead of only selecting — a real
      // press-hold-drag-release gesture on a not-yet-selected caption used to
      // just select it and go nowhere (the user would have had to release
      // and press a second time, now landing on the newly-visible box, to
      // actually move it). This is what made drag-to-move look broken.
      beginMove(e);
    } else {
      selected = false;
      selectedWordIndex = null;
      resetKeywordScopeState();
      boxEl.hidden = true;
    }
  });

  boxEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.caption-transform-handle') || e.target.closest('.caption-transform-toolbar')) return;

    // While the WHOLE caption/group is selected (selectedWordIndex null),
    // this box spans the entire caption, so it's what actually receives a
    // click meant to drill into one specific word (see hitTestWordAtClient's
    // doc comment above). Once a word IS selected this box shrinks to just
    // that word's own bounds (see getDisplayBox), so any other word is
    // already outside it and reaches hitAreaEl underneath directly — no
    // special-casing needed there.
    if (selectedWordIndex == null) {
      const word = hitTestWordAtClient(e.clientX, e.clientY);
      if (word) {
        resetKeywordScopeState();
        selectedWordIndex = word.wordIndex;
        positionBoxElement();
        updateScopeButtons();
        beginMove(e);
        return;
      }
    }
    beginMove(e);
  });

  boxEl.querySelectorAll('.caption-transform-handle[data-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginResize(e, handle.dataset.handle);
    });
  });

  if (rotateHandleEl) {
    rotateHandleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginRotate(e);
    });
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) {
      selected = false;
      selectedWordIndex = null;
      resetKeywordScopeState();
      boxEl.hidden = true;
    }
  });

  if (scopeThisBtn) {
    scopeThisBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeThisBtn.addEventListener('click', () => {
      updateState({ transformApplyScope: 'this' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (scopeAllBtn) {
    scopeAllBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeAllBtn.addEventListener('click', () => {
      updateState({ transformApplyScope: 'all' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', resetCurrentTransform);
  }

  if (scopeThisKeywordBtn) {
    scopeThisKeywordBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeThisKeywordBtn.addEventListener('click', () => {
      updateState({ keywordApplyScope: 'this' }, { recordHistory: false });
      keywordMultiSelection = null;
      clearKeywordMultiSelectMarkers();
      updateScopeButtons();
    });
  }
  if (scopeAllKeywordsBtn) {
    scopeAllKeywordsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeAllKeywordsBtn.addEventListener('click', () => {
      updateState({ keywordApplyScope: 'all' }, { recordHistory: false });
      keywordMultiSelection = null;
      clearKeywordMultiSelectMarkers();
      updateScopeButtons();
    });
  }
  if (scopeSelectKeywordsBtn) {
    scopeSelectKeywordsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeSelectKeywordsBtn.addEventListener('click', () => {
      isSelectingKeywords = true;
      keywordMultiSelection = new Set(selectedWordIndex != null ? [selectedWordIndex] : []);
      renderKeywordMultiSelectMarkers();
      updateScopeButtons();
    });
  }
  if (keywordMultiSelectDoneBtn) {
    keywordMultiSelectDoneBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    keywordMultiSelectDoneBtn.addEventListener('click', () => {
      isSelectingKeywords = false;
      updateState({ keywordApplyScope: 'select' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (keywordAnimationSelect) {
    keywordAnimationSelect.addEventListener('pointerdown', (e) => e.stopPropagation());
    keywordAnimationSelect.addEventListener('change', (e) => {
      if (selectedWordIndex == null) return;
      const fields = {
        animationType: e.target.value,
        animationDuration: appState.captionAnimationDuration,
        animationEasing: appState.captionAnimationEasing,
        animationIntensity: appState.captionAnimationIntensity
      };
      applyKeywordScopedTransformFields(selectedWordIndex, fields, { recordHistory: true });
    });
  }
}
