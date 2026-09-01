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
 */
import { appState, updateState } from '../state.js';
import { getPhraseTransformKey, getWordTransformKey } from '../../../shared/captionTransform.js';

let overlayEl, hitAreaEl, boxEl, rotateHandleEl, scopeThisBtn, scopeAllBtn, resetBtn, rotationLabelEl;
let selected = false;
let currentBox = null; // { x, y, width, height, centerX, centerY, rotationDeg, pxScale, phrase, mode, words?, chunks? } in canvas backing-store px

// The individual word currently selected within currentBox, or null when the
// selection is at the whole-caption/group level. Independent of `selected`:
// `selected` means "something is highlighted" (word OR caption); this says
// WHICH of the two kinds it is.
let selectedWordIndex = null;

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
    resetWordTransform(selectedWordIndex);
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

/**
 * The box currently shown/dragged: the selected word's own rect (see
 * wordBoxFor) when selectedWordIndex is set, otherwise the whole caption's
 * box — the ONLY box that existed before word-level selection. Every drag/
 * resize/rotate/position function reads this instead of currentBox directly
 * so the same code path naturally serves both selection targets.
 */
function getDisplayBox() {
  if (!currentBox) return null;
  if (selectedWordIndex != null) {
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === selectedWordIndex);
    if (word) return wordBoxFor(word, currentBox);
  }
  return currentBox;
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

function updateScopeButtons() {
  if (scopeThisBtn) scopeThisBtn.classList.toggle('active', appState.transformApplyScope === 'this');
  if (scopeAllBtn) scopeAllBtn.classList.toggle('active', appState.transformApplyScope !== 'this');
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
  if (selectedWordIndex != null && !getWordCandidates(currentBox).some((w) => w.wordIndex === selectedWordIndex)) {
    selectedWordIndex = null;
  }

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
      applyWordTransformFields(wordIndex, {
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
      applyWordTransformFields(wordIndex, { fontScale: nextScale }, { recordHistory: false });
    } else {
      const nextFontSize = Math.max(6, Math.min(150, Math.round(drag.startFontSize * ratio)));
      applyTransformFields({ fontSize: nextFontSize }, { recordHistory: false, phrase: drag.phrase });
    }
  } else if (drag.kind === 'rotate') {
    const angleDeg = (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
    const rotationDeg = Math.round(angleDeg + 90);
    if (wordIndex != null) {
      applyWordTransformFields(wordIndex, { rotationDeg }, { recordHistory: false });
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
      applyWordTransformFields(wordIndex, {
        offsetXPx: effectiveWordValue(wordIndex, 'offsetXPx', 0),
        offsetYPx: effectiveWordValue(wordIndex, 'offsetYPx', 0)
      }, { recordHistory: true });
    } else if (kind === 'resize') {
      applyWordTransformFields(wordIndex, { fontScale: effectiveWordValue(wordIndex, 'fontScale', 1) }, { recordHistory: true });
    } else if (kind === 'rotate') {
      applyWordTransformFields(wordIndex, { rotationDeg: effectiveWordValue(wordIndex, 'rotationDeg', 0) }, { recordHistory: true });
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

export function initCanvasTransform() {
  overlayEl = document.getElementById('caption-transform-overlay');
  hitAreaEl = document.getElementById('caption-transform-hit-area');
  boxEl = document.getElementById('caption-transform-box');
  rotateHandleEl = document.getElementById('caption-transform-handle-rotate');
  scopeThisBtn = document.getElementById('btn-transform-scope-this');
  scopeAllBtn = document.getElementById('btn-transform-scope-all');
  resetBtn = document.getElementById('btn-transform-reset');
  rotationLabelEl = document.getElementById('caption-transform-rotation-label');
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
    if (word) {
      selected = true;
      selectedWordIndex = word.wordIndex;
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
      boxEl.hidden = true;
    }
  });

  boxEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.caption-transform-handle') || e.target.closest('.caption-transform-toolbar')) return;
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
}
