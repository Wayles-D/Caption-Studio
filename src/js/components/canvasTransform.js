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
 * and box.cssPxScale (== canvasWidth/cssPixelWidth, the same ratio
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
import { setWordKeyword } from './transcriptEditorState.js';
import { deselectVideoTarget } from './videoTransform.js';
import { getTextElement, updateTextElement, updateTextElementStyle, setTextElementValues, selectTextElement } from './textElements.js';
import { getCanvasContentRect } from '../utils/canvasGeometry.js';
import { wordOffsetToCanvasPx, canvasPxToWordOffset } from '../../../shared/captionGraphics.js';

/**
 * The graphics canvas's own backing-store width — the pixel space
 * currentBox/word rects are reported in (see preview.js's
 * prepareGraphicsCanvas, which sizes it, and measureSentenceFrame, which
 * measures against it). Word position offsets convert through this on their
 * way in/out of the authored 330-box unit they're stored in.
 */
function getCanvasBackingWidth() {
  return document.getElementById('captions-canvas')?.width || 0;
}
import {
  PHRASE_FIELD_TO_PROPERTY,
  WORD_FIELD_TO_PROPERTY,
  KEYFRAME_PROPERTIES,
  findKeyframeEntryNear,
  upsertKeyframeEntry,
  removeKeyframeEntry,
  moveKeyframeEntry,
  evaluatePropertyAtTime,
  routeFieldsThroughKeyframes as routeFieldsThroughKeyframesAtTime
} from '../../../shared/keyframes.js';

/** Current playhead position — the single source of "what time is it" every keyframe read/write in this module uses. */
function getPlayheadTime() {
  return document.getElementById('preview-video')?.currentTime ?? 0;
}

/** Thin wrapper supplying the current playhead time to the shared, target-agnostic auto-keying primitive (see shared/keyframes.js's routeFieldsThroughKeyframes — also used, independently, by src/js/components/videoTransform.js for the Video target). */
function routeFieldsThroughKeyframes(existing, fields, fieldToProperty, readCurrentValue) {
  return routeFieldsThroughKeyframesAtTime(existing, fields, fieldToProperty, getPlayheadTime(), readCurrentValue);
}

let overlayEl, hitAreaEl, boxEl, rotateHandleEl, toolbarEl, scopeThisBtn, scopeAllBtn, resetBtn, rotationLabelEl;
let scopeThisKeywordBtn, scopeAllKeywordsBtn, scopeSelectKeywordsBtn, keywordMultiSelectDoneBtn, keywordMultiSelectLabelEl;
let animationTypeSelect, animScopeThisBtn, animScopeSameTypeBtn, animScopeAllWordsBtn, animScopeThisCaptionBtn, animScopeAllCaptionsBtn, animationSectionLabelEl;
let keywordToggleBtn, groupStartBtn, groupConfirmBtn, groupMultiSelectLabelEl;
let selected = false;
// { x, y, width, height, centerX, centerY, rotationDeg, cssPxScale, phrase, mode, words?, chunks? }
// in canvas backing-store px. NOTE cssPxScale (canvas px per ON-SCREEN CSS
// px, for DOM handle placement) is NOT the renderer's own authored pxScale
// (canvas px per 330-box px) — see shared/captionGraphics.js's
// resolveGeometry, which returns both under deliberately distinct names.
let currentBox = null;

// --- Text elements (manual captions + overlays) ---------------------------
//
// A text element is a WHOLE, independent object, not a piece of the
// transcript — it has no wordIndex, no phrase key, and no group. So it gets
// its own tiny selection state beside the caption machinery rather than
// being squeezed through it: `selected` still means "something is
// highlighted", and selectedTextElementId being set is what makes that
// something a text element (selectedWordIndex/selectedGroupId are both null
// in that case, which is precisely why currentSelectionTarget and
// getKeyframeTarget need an explicit check for it rather than inferring
// "caption" from two nulls).
//
// Everything downstream is shared: the same overlay DOM, the same box/handle
// geometry, the same drag/resize/rotate gestures — only the WRITE target
// differs (updateTextElementStyle instead of applyTransformFields).

// This frame's on-screen boxes, in the same canvas backing-store px as
// currentBox, pushed by preview.js's syncTextElementsCanvas — one per
// element actually visible at the current time, in draw order (so the LAST
// match under a click is the topmost one).
let textElementBoxes = [];
let selectedTextElementId = null;

// The individual word currently selected within currentBox, or null when the
// selection is at the whole-caption/group level. Independent of `selected`:
// `selected` means "something is highlighted" (word OR caption); this says
// WHICH of the two kinds it is.
let selectedWordIndex = null;

// The GROUP currently selected/displayed when selectedWordIndex is null —
// either a caption's own default group key (getPhraseTransformKey(phrase),
// reused as-is so "This Caption"/"All Captions" scope keeps meaning exactly
// what it always has for the common, untouched case — see isFullPhraseGroup)
// or a custom id created by the explicit grouping flow below. null means
// nothing is selected at all. See getEffectiveGroupId's doc comment for how
// a word's actual group membership is derived from this plus per-word
// `groupId` overrides.
let selectedGroupId = null;

// The transform key of the caption the user last EXPLICITLY clicked as a
// whole (i.e. the selection made at line ~1647 below), kept separate from
// selectedGroupId/currentBox.phrase — those two auto-follow whatever caption
// is on screen right now (see updateCanvasTransformOverlay's staleness
// check), which is the right, deliberate UX for on-canvas drag/resize/rotate
// during normal playback, but WRONG for keyframing: scrubbing the playhead
// away from a caption to set a second keyframe at a later time used to
// silently re-target selectedGroupId at whichever DIFFERENT caption is now
// on screen, so the second keyframe landed on the wrong caption entirely
// (confirmed via a captured real export payload — two single-keyframe
// entries under two different phrase keys instead of one two-point track).
// getKeyframeTarget() below resolves the phrase from THIS key instead of
// currentBox.phrase whenever it's set, so keyframe reads/writes keep
// targeting the caption the user actually meant regardless of where the
// playhead wanders afterward. Cleared on a genuine new selection (a
// different word/group click, or a full deselect) — see those branches in
// the hitAreaEl pointerdown handler and deselectCanvasSelection.
let explicitCaptionSelectionKey = null;

/** Looks up a phrase by its own transform key across the FULL transcript (not just whatever's in currentBox right now) — see explicitCaptionSelectionKey's doc comment for why keyframe target resolution can't rely on currentBox.phrase alone. */
function resolvePhraseByTransformKey(key) {
  if (key == null) return null;
  return (appState.phrases || []).find((p) => getPhraseTransformKey(p) === key) || null;
}

/**
 * Re-derives explicitCaptionSelectionKey from whatever selection state a
 * click handler just set, instead of each branch guessing inline — a click
 * on a WORD that happens to belong to its caption's own (untouched) default
 * group is functionally the same "select the whole caption" outcome as a
 * click on the caption's empty padding (see the hitAreaEl handler below,
 * both paths can set selectedGroupId to the phrase's default key), so both
 * must pin identically. Call this at the end of every branch that changes
 * selectedWordIndex/selectedGroupId, instead of setting
 * explicitCaptionSelectionKey by hand in each one.
 */
function syncExplicitCaptionPin() {
  explicitCaptionSelectionKey = (selectedWordIndex == null && selectedGroupId != null && isFullPhraseGroup(selectedGroupId))
    ? selectedGroupId
    : null;
}

// "Select Keywords" mode state — see initCanvasTransform's scope-button
// wiring and the hitAreaEl pointerdown handler's isSelectingKeywords branch.
// Neither is Zustand-backed (like selectedWordIndex above, these are
// transient editor-UI concerns, not persisted/undo-tracked data); only the
// RESULT of using them — writes into appState.captionTransforms — is.
let isSelectingKeywords = false;
let keywordMultiSelection = null; // Set<number> | null
let keywordMarkerEls = [];

// Explicit word-grouping's own pick-multiple-words mode — same shape as
// "Select Keywords" above but keyword status is deliberately NOT a gate
// here (any word, normal or keyword, can be picked — see this feature's own
// requirement that keyword status must never determine group membership).
let isSelectingGroup = false;
let groupMultiSelection = null; // Set<number> | null
let groupMarkerEls = [];

let drag = null; // { kind: 'move'|'resize'|'rotate', pointerId, phrase, wordIndex?, groupId?, groupMembers?, groupStart? }

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
/**
 * Resolves `field`'s CURRENT effective value on `override` — its live
 * keyframe-interpolated value at the current playhead if the field's mapped
 * property has any keyframes (see shared/keyframes.js's
 * evaluatePropertyAtTime), otherwise the plain static field, otherwise
 * `fallback`. Every animatable field now ALWAYS auto-keys on write (see
 * routeFieldsThroughKeyframes's doc comment) — the plain static field is
 * never populated for one of KEYFRAME_PROPERTIES once it's been touched
 * even once, so a caller that only checked the static field would silently
 * see a stale/default value the instant an edit auto-created that
 * property's first keyframe. This is exactly the read-side counterpart of
 * shared/captionTransform.js's resolvePhraseParams/resolveWordOverrideAtTime
 * (the render path), just against a raw field name instead of a resolved
 * style-params object.
 */
function resolveEffectiveField(override, field, fieldToProperty, fallback) {
  const property = fieldToProperty[field];
  if (property) {
    const kfValue = evaluatePropertyAtTime(override?.keyframes, property, getPlayheadTime());
    if (kfValue !== undefined) return kfValue;
  }
  return override && override[field] != null ? override[field] : fallback;
}

function effectiveValue(phrase, field, globalValue) {
  if (appState.transformApplyScope !== 'this' || !phrase) return globalValue;
  const key = getPhraseTransformKey(phrase);
  const override = appState.captionTransforms[key];
  return resolveEffectiveField(override, field, PHRASE_FIELD_TO_PROPERTY, globalValue);
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
  return resolveEffectiveField(override, field, WORD_FIELD_TO_PROPERTY, fallback);
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
 * for the whole box.
 *
 * A word's OWN additional offset/rotation/scale override (wordBoxFor — the
 * SAME resolved geometry the selection box already follows once a word IS
 * selected, and the SAME adjustment shared/captionGraphics.js's paint step
 * applies via its own extra ctx.translate/rotate/scale) is then applied
 * before testing, so hit-testing agrees with both the rendered pixels and
 * the selection box instead of a THIRD, independent "wherever this word
 * used to be" answer. An earlier revision intentionally skipped this
 * (hit-testing a transformed word against its pre-transform footprint,
 * reasoning that "a fresh click always starts from an untransformed word")
 * — true only the very first time a word is ever moved. Confirmed as a real,
 * user-visible bug once a word already has an override: clicking its new,
 * visible position missed every time (nothing there, hit-test-wise); only
 * clicking its stale original footprint selected it, at which point the
 * selection box (correctly using wordBoxFor) would jump to the real
 * position — a visible desync between what's clickable and what's rendered.
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
 * one line. Gaps are measured between words' RAW (pre-override) layout
 * rects — adjacent-word spacing is a property of the text layout, not of
 * whichever one word happens to have been dragged elsewhere.
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

    const adjusted = wordBoxFor(w, box);
    const ownRad = (-((adjusted.rotationDeg || 0) - (box.rotationDeg || 0)) * Math.PI) / 180;
    const adx = localX - adjusted.centerX;
    const ady = localY - adjusted.centerY;
    const wordLocalX = adjusted.centerX + (adx * Math.cos(ownRad) - ady * Math.sin(ownRad));
    const wordLocalY = adjusted.centerY + (adx * Math.sin(ownRad) + ady * Math.cos(ownRad));

    return wordLocalX >= adjusted.x - padLeft && wordLocalX <= adjusted.x + adjusted.width + padRight &&
      wordLocalY >= adjusted.y - MAX_PAD && wordLocalY <= adjusted.y + adjusted.height + MAX_PAD;
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
  // Stored offsets are in the authored 330-box unit (see
  // shared/captionGraphics.js's wordOffsetToCanvasPx) — converted here into
  // the canvas backing-store px space word.x/word.y live in, so the
  // selection box lands exactly where the renderer paints the glyph.
  const canvasW = getCanvasBackingWidth();
  const offsetX = wordOffsetToCanvasPx(effectiveWordValue(word.wordIndex, 'offsetXPx', 0) || 0, canvasW);
  const offsetY = wordOffsetToCanvasPx(effectiveWordValue(word.wordIndex, 'offsetYPx', 0) || 0, canvasW);
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
    cssPxScale: box.cssPxScale,
    wordIndex: word.wordIndex
  };
}

/**
 * DYNAMIC GROUPING — a group bounding box represents the words CURRENTLY in
 * that group, based on their current positions, not the caption's original
 * boundaries (see this feature's own requirement).
 *
 * A word's effective group id is:
 *   - whatever `groupId` its own transform override says, if it has one
 *     (a string = explicit custom group from the grouping flow below, or
 *     `null` = explicitly detached/standalone, e.g. after being dragged
 *     individually out of its caption's default group — see endDrag), or
 *   - otherwise, its caption's own default group — reusing
 *     getPhraseTransformKey(phrase) AS THE GROUP ID, so an untouched
 *     caption's "group" is byte-identical to its existing phrase-transform
 *     identity (isFullPhraseGroup below is what keeps This Caption/All
 *     Captions scope meaning exactly what it always has for this default
 *     case).
 *
 * Keyword vs. normal status never enters into this — only the explicit
 * `groupId` override (or its absence) does, per this feature's requirement.
 */
function getEffectiveGroupId(wordIndex, phrase) {
  if (wordIndex == null) return null;
  const override = appState.captionTransforms[getWordTransformKey(wordIndex)];
  if (override && Object.prototype.hasOwnProperty.call(override, 'groupId')) return override.groupId;
  return phrase ? getPhraseTransformKey(phrase) : null;
}

/** Every wordIndex currently on screen (see getWordCandidates) whose effective group id matches `groupId`. */
function getGroupMemberIndexes(groupId) {
  if (!currentBox || groupId == null) return [];
  return getWordCandidates(currentBox)
    .filter((w) => getEffectiveGroupId(w.wordIndex, currentBox.phrase) === groupId)
    .map((w) => w.wordIndex);
}

/**
 * True only for the common, untouched case: `groupId` IS this caption's own
 * default group AND every word currently on screen still belongs to it (none
 * detached, none pulled into a custom group). This is what keeps the
 * EXISTING whole-caption move/resize/rotate + This Caption/All Captions
 * scope buttons working byte-for-byte as before for a caption nobody has
 * touched yet — see applyTransformFields's phrase-level writes, still used
 * exactly as-is whenever this returns true. The moment any word in the
 * caption is detached or grouped elsewhere, this flips to false and group
 * transforms switch to the per-member fan-out path (see beginMove/
 * onPointerMove/endDrag) so the transform only ever affects the words
 * actually still in the group.
 */
function isFullPhraseGroup(groupId) {
  if (!currentBox || !currentBox.phrase) return false;
  const defaultKey = getPhraseTransformKey(currentBox.phrase);
  if (groupId !== defaultKey) return false;
  const all = getWordCandidates(currentBox);
  return all.length > 0 && all.every((w) => getEffectiveGroupId(w.wordIndex, currentBox.phrase) === defaultKey);
}

/**
 * The group's own bounding box, computed fresh from its CURRENT members'
 * CURRENT (offset/scale-adjusted, via wordBoxFor) positions — never from the
 * caption's static original layout. A word moved out (different/`null`
 * groupId) is excluded automatically since getGroupMemberIndexes no longer
 * returns it; a word moved further away just shifts the min/max bounds this
 * frame, since wordBoxFor always reflects its live offset.
 */
function computeGroupBox(groupId) {
  if (!currentBox || groupId == null) return null;
  const candidates = getWordCandidates(currentBox).filter(
    (w) => getEffectiveGroupId(w.wordIndex, currentBox.phrase) === groupId
  );
  if (!candidates.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  candidates.forEach((w) => {
    const box = wordBoxFor(w, currentBox);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  });

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    rotationDeg: currentBox.rotationDeg || 0,
    cssPxScale: currentBox.cssPxScale,
    phrase: currentBox.phrase,
    groupId
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
/**
 * Writes fields directly into a phrase's own captionTransforms[phraseKey]
 * entry, unconditionally (no transformApplyScope branching) — the write
 * primitive both applyTransformFields's "This Caption" branch AND keyframe
 * writes (setPropertyValueForCurrentSelection) use. Keyframes always target
 * the exact selected phrase instance regardless of the This/All Captions
 * toggle (see this file's own keyframe-scope decision, documented at
 * getKeyframeTarget) — routing through applyTransformFields's scope check
 * would silently send a keyframe edit to the GLOBAL style fields instead
 * whenever "All Captions" happens to be the current scope, since that's its
 * default (see src/store/transformStore.js's TRANSFORM_DEFAULTS).
 */
function writePhraseFields(phrase, fields, { recordHistory }) {
  const key = getPhraseTransformKey(phrase);
  const existing = appState.captionTransforms[key] || {};
  // Action-driven auto-keying (see routeFieldsThroughKeyframes's own doc
  // comment): ANY animatable field written here — the very first time or
  // the hundredth — creates/updates a keyframe entry at the current
  // playhead instead of overwriting a plain static value. readCurrentValue
  // supplies whatever this specific write doesn't itself touch (e.g.
  // rotating leaves position/scale/opacity to resolve their own current
  // value) so the resulting entry is always a full, coherent snapshot.
  const readCurrentValue = (property) => {
    const kfValue = evaluatePropertyAtTime(existing.keyframes, property, getPlayheadTime());
    if (kfValue !== undefined) return kfValue;
    const field = PHRASE_STATIC_FIELD_BY_PROPERTY[property];
    const staticValue = existing[field] != null ? existing[field] : KEYFRAME_PROPERTY_DEFAULTS[property];
    return effectiveValue(phrase, field, staticValue);
  };
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(existing, fields, PHRASE_FIELD_TO_PROPERTY, readCurrentValue);
  const nextEntry = { ...existing, ...remainingFields };
  if (nextKeyframes) nextEntry.keyframes = nextKeyframes;
  const nextMap = { ...appState.captionTransforms, [key]: nextEntry };
  updateState({ captionTransforms: nextMap }, { recordHistory });
}

function applyTransformFields(fields, { recordHistory, phrase }) {
  const targetPhrase = phrase || currentBox?.phrase;
  if (!currentBox && !targetPhrase) return;
  if (appState.transformApplyScope === 'this' && targetPhrase) {
    writePhraseFields(targetPhrase, fields, { recordHistory });
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
  // Action-driven auto-keying, full-snapshot — see writePhraseFields's own
  // (matching) comment.
  const readCurrentValue = (property) => {
    const kfValue = evaluatePropertyAtTime(existing.keyframes, property, getPlayheadTime());
    if (kfValue !== undefined) return kfValue;
    return effectiveWordValue(wordIndex, WORD_STATIC_FIELD_BY_PROPERTY[property], KEYFRAME_PROPERTY_DEFAULTS[property]);
  };
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(existing, fields, WORD_FIELD_TO_PROPERTY, readCurrentValue);
  const nextEntry = { ...existing, ...remainingFields };
  if (nextKeyframes) nextEntry.keyframes = nextKeyframes;
  const nextMap = { ...appState.captionTransforms, [key]: nextEntry };
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
 *
 * appState.words entries don't carry their own `.wordIndex` field (only
 * phrase-embedded word copies do, stamped by backend/utils/phraseGrouper.js)
 * — a flat word's ARRAY POSITION doubles as its wordIndex instead (the same
 * identity convention transcriptEditorState.js's applyLiveWordEdit/
 * setWordKeyword and collectEditedWords already rely on), so this maps over
 * the array index, not a non-existent `w.wordIndex` property.
 */
function getAllKeywordWordIndexes() {
  return (appState.words || []).reduce((acc, w, i) => { if (w.isKeyword) acc.push(i); return acc; }, []);
}

/** Word-scope counterpart to getAllKeywordWordIndexes — every NORMAL (non-keyword) word's index across the whole transcript. */
function getAllNormalWordIndexes() {
  return (appState.words || []).reduce((acc, w, i) => { if (!w.isKeyword) acc.push(i); return acc; }, []);
}

/** Every word's index across the whole transcript, regardless of keyword status — backs the "All Words" animation scope. */
function getAllWordIndexesFlat() {
  return (appState.words || []).map((_, i) => i);
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
 * ANIMATION TARGET + SCOPE — a target/scope system independent of both
 * transformApplyScope (move/resize/rotate's caption-only scope) and
 * keywordApplyScope (move/resize/rotate's keyword fan-out): "what is
 * selected" (selectedWordIndex/selectedGroupId) determines the DEFAULT
 * target, but appState.animationApplyScope lets the user explicitly widen
 * it before applying an animation — see this feature's own doc comment in
 * transformStore.js for the full value list.
 *
 * Resolves which wordIndexes an animation field-write should fan out to for
 * a WORD-level scope value ('this'/'same-type'/'all-words'). 'this-caption'/
 * 'all-captions' are handled by the caller (applyAnimationFields) instead,
 * since those escalate to a phrase-level write, not a per-word one.
 */
function getWordIndexesForAnimationScope(scope, wordIndex) {
  if (wordIndex == null) return [];
  if (scope === 'all-words') return getAllWordIndexesFlat();
  if (scope === 'same-type') {
    return isKeywordIndex(wordIndex) ? getAllKeywordWordIndexes() : getAllNormalWordIndexes();
  }
  return [wordIndex];
}

/**
 * Caption-level counterpart to applyTransformFields, but driven by an
 * explicit `isAllCaptions` flag instead of reading appState.transformApplyScope
 * — animation's caption-level scope is its OWN independent choice
 * (appState.animationApplyScope), not a repurposing of the position/resize/
 * rotate scope toggle, so a user can have "All Captions" position but "This
 * Caption" animation (or vice versa) without the two fighting over one
 * shared field. Otherwise identical semantics to applyTransformFields:
 * "this caption" writes into captionTransforms[phraseKey]; "all captions"
 * writes the same field names onto global appState (which
 * shared/captionAnimation.js's resolveAnimationConfig already reads as the
 * fallback for any un-overridden phrase) and releases this phrase's own
 * leftover override so it doesn't keep rendering stale.
 */
function applyPhraseAnimationFields(fields, isAllCaptions, { recordHistory }) {
  const targetPhrase = currentBox?.phrase;
  if (!targetPhrase) return;
  if (!isAllCaptions) {
    const key = getPhraseTransformKey(targetPhrase);
    const existing = appState.captionTransforms[key] || {};
    const nextMap = { ...appState.captionTransforms, [key]: { ...existing, ...fields } };
    updateState({ captionTransforms: nextMap }, { recordHistory });
    return;
  }
  const globalFields = {
    captionAnimationType: fields.animationType,
    captionAnimationDuration: fields.animationDuration,
    captionAnimationEasing: fields.animationEasing,
    captionAnimationIntensity: fields.animationIntensity
  };
  let nextTransforms = appState.captionTransforms;
  const key = getPhraseTransformKey(targetPhrase);
  if (key in nextTransforms) {
    nextTransforms = { ...nextTransforms };
    delete nextTransforms[key];
  }
  updateState({ ...globalFields, captionTransforms: nextTransforms }, { recordHistory });
}

/**
 * Single dispatch point for every animation-field write from the canvas
 * Animation control — the ONE place that decides, from the current
 * selection (word/keyword/caption/group) plus appState.animationApplyScope,
 * whether this write targets one word, a same-type/all-words fan-out (each
 * getting its OWN independent per-word override — see
 * getWordIndexesForAnimationScope), or the whole caption/all captions
 * (shared/captionTransform.js's resolvePhraseParams, extended by this
 * feature to also merge animation fields). Never writes a caption-level
 * field when a word-level scope is chosen, and never fans out to multiple
 * words when a caption-level scope is chosen — the two paths are mutually
 * exclusive per write, matching "an animation belongs to a TARGET, not to
 * the current caption" (this feature's own architectural rule).
 */
function applyAnimationFields(fields, opts) {
  if (selectedWordIndex != null) {
    const scope = appState.animationApplyScope;
    if (scope === 'this-caption' || scope === 'all-captions') {
      applyPhraseAnimationFields(fields, scope === 'all-captions', opts);
      return;
    }
    getWordIndexesForAnimationScope(scope, selectedWordIndex).forEach((idx) => applyWordTransformFields(idx, fields, opts));
    return;
  }
  // Whole caption/group selected — word-only scope values ('this'/
  // 'same-type'/'all-words') are meaningless without a word selected, so
  // only the all-captions/not-all-captions distinction matters here.
  applyPhraseAnimationFields(fields, appState.animationApplyScope === 'all-captions', opts);
}

/**
 * Clears keyword-scope AND animation-scope UI state back to their defaults
 * — called whenever the selection ANCHOR changes (a different word/caption
 * is clicked, or nothing is selected at all) so neither scope choice ever
 * silently carries over onto an unrelated later edit. Deliberately NOT
 * called between edits to the SAME still-selected word/keyword, so choosing
 * "All Keywords"/"All Words" once and then editing several times in a row
 * keeps applying to all of them, as expected.
 */
function resetKeywordScopeState() {
  if (appState.keywordApplyScope !== 'this') {
    updateState({ keywordApplyScope: 'this' }, { recordHistory: false });
  }
  if (appState.animationApplyScope !== 'this') {
    updateState({ animationApplyScope: 'this' }, { recordHistory: false });
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
    const scale = box.cssPxScale || 1;
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

function clearGroupMultiSelectMarkers() {
  groupMarkerEls.forEach((el) => el.remove());
  groupMarkerEls = [];
}

/**
 * Grouping's own counterpart to renderKeywordMultiSelectMarkers — identical
 * box math (wordBoxFor + pxScale), different marker class/color (see
 * style.css's .caption-transform-group-marker) so the two multi-select modes
 * are visually distinct if either is ever active.
 */
function renderGroupMultiSelectMarkers() {
  clearGroupMultiSelectMarkers();
  if (!groupMultiSelection || !groupMultiSelection.size || !currentBox || !overlayEl) return;
  const candidates = getWordCandidates(currentBox);
  groupMultiSelection.forEach((idx) => {
    const word = candidates.find((w) => w.wordIndex === idx);
    if (!word) return;
    const box = wordBoxFor(word, currentBox);
    const scale = box.cssPxScale || 1;
    const marker = document.createElement('div');
    marker.className = 'caption-transform-group-marker';
    marker.style.left = `${box.x / scale}px`;
    marker.style.top = `${box.y / scale}px`;
    marker.style.width = `${box.width / scale}px`;
    marker.style.height = `${box.height / scale}px`;
    marker.style.transform = box.rotationDeg ? `rotate(${box.rotationDeg}deg)` : '';
    marker.style.transformOrigin = 'center center';
    overlayEl.appendChild(marker);
    groupMarkerEls.push(marker);
  });
}

/**
 * Ends "Group Words" picking. When `commit` is true and at least one word
 * was picked, stamps a brand-new groupId onto every picked word's transform
 * override (overriding whatever group/detached state it had before — this
 * is an explicit, deliberate regrouping) and selects the new group as the
 * current display target. Always clears the picking UI either way.
 */
function finishGroupSelection(commit) {
  if (commit && groupMultiSelection && groupMultiSelection.size) {
    const newGroupId = `group-${Date.now()}-${Math.round(Math.random() * 1e4)}`;
    groupMultiSelection.forEach((idx) => {
      applyWordTransformFields(idx, { groupId: newGroupId }, { recordHistory: true });
    });
    resetKeywordScopeState();
    selected = true;
    selectedWordIndex = null;
    selectedGroupId = newGroupId;
  }
  isSelectingGroup = false;
  groupMultiSelection = null;
  clearGroupMultiSelectMarkers();
  positionBoxElement();
  updateScopeButtons();
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
  if (selectedGroupId != null && !isFullPhraseGroup(selectedGroupId)) {
    // A partial/custom group has no phrase-level field of its own to reset
    // (see applyTransformFields's full-phrase-only branch below) — resetting
    // it means releasing each current member's own per-word override
    // entirely, via the exact same resetWordTransform a lone word's Reset
    // already uses. This also drops each member's `groupId`, so resetting a
    // group naturally dissolves it and returns every member to its
    // caption's plain default group, at its original position — the
    // sensible "back to how it started" behavior for Reset.
    getGroupMemberIndexes(selectedGroupId).forEach((idx) => resetWordTransform(idx));
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
  const pad = paddingCssPx * (box.cssPxScale || 1);
  return {
    ...box,
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2
  };
}

// Smallest selection box (CSS px) that still leaves somewhere to GRAB. The
// corner resize handles are 14px dots pulled half-outward (margin:-7px), so
// each one covers ~7px inside every corner; a box smaller than roughly
// 30x30 is therefore entirely covered by its own handles and every drag
// lands on a resize instead of a move.
//
// This became reachable once the preview started rendering at true export
// scale (see shared/captionGraphics.js's resolveGeometry): a 14px-authored
// caption in a phone-frame displayed at ~168px is only ~15x9 CSS px on
// screen. Confirmed by a real drag test — the gesture produced scale:4 with
// zero position change, i.e. a resize, because the handles swallowed the
// whole word.
const MIN_GRAB_BOX_CSS_PX = { width: 34, height: 30 };

/**
 * Grows a box symmetrically about its own center until it's at least
 * MIN_GRAB_BOX_CSS_PX in each axis. Symmetric about the SAME center on
 * purpose: every gesture's math is center-relative (move uses a pointer
 * delta, resize uses distance-from-center, rotate uses angle-from-center),
 * so this changes only what's drawn and what's clickable, never what a
 * drag computes — the same property inflateBox above already relies on.
 */
function ensureMinimumGrabBox(box) {
  const scale = box.cssPxScale || 1;
  const minW = MIN_GRAB_BOX_CSS_PX.width * scale;
  const minH = MIN_GRAB_BOX_CSS_PX.height * scale;
  const padX = Math.max(0, (minW - box.width) / 2);
  const padY = Math.max(0, (minH - box.height) / 2);
  if (!padX && !padY) return box;
  return {
    ...box,
    x: box.x - padX,
    y: box.y - padY,
    width: box.width + padX * 2,
    height: box.height + padY * 2
  };
}

/**
 * The box currently shown/dragged: the selected word's own rect (see
 * wordBoxFor) when selectedWordIndex is set, otherwise the currently
 * selected GROUP's box — dynamically recomputed from its current members
 * (see computeGroupBox), padded for display (see inflateBox above). Every
 * drag/resize/rotate/position function reads this instead of currentBox
 * directly so the same code path naturally serves both selection targets;
 * the padding is symmetric around the same center, so it doesn't change
 * what a drag/resize/rotate gesture computes.
 */
function getDisplayBox() {
  // Checked BEFORE currentBox: a text element is independent of the
  // transcript, so it can be selected (and dragged) on a frame where no
  // caption is on screen at all and currentBox is therefore null.
  if (selectedTextElementId) {
    const entry = textElementBoxes.find((b) => b.id === selectedTextElementId);
    return entry ? ensureMinimumGrabBox(inflateBox(entry.box, CAPTION_SELECTION_PADDING_CSS_PX)) : null;
  }
  if (!currentBox) return null;
  if (selectedWordIndex != null) {
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === selectedWordIndex);
    if (word) return ensureMinimumGrabBox(wordBoxFor(word, currentBox));
  }
  if (selectedGroupId != null) {
    const groupBox = computeGroupBox(selectedGroupId);
    if (groupBox) return ensureMinimumGrabBox(inflateBox(groupBox, CAPTION_SELECTION_PADDING_CSS_PX));
  }
  return null;
}

/**
 * Keeps the rotate handle reachable when the box's rotated position pushes
 * it above the actual browser viewport — confirmed via a real end-to-end
 * drag-to-corner test: dragging a caption to the frame's top edge (now
 * legitimately visible past .phone-frame's own clipped boundary — see
 * style.css's .caption-transform-overlay doc comment) pushed the rotate
 * handle's `top: -64px` offset far enough up that it landed above y=0,
 * behind the app's own header bar — visible nowhere, clickable nowhere.
 * Reads the handle's own natural (CSS-rotated) position via
 * getBoundingClientRect() — already correct for any rotation angle, since
 * the browser did that math — and only overrides it with an explicit
 * `position: fixed` when that natural position would actually fall outside
 * the viewport, clamping it back to a visible margin. Purely cosmetic: the
 * actual rotate gesture (beginRotate/onPointerMove) computes its angle from
 * the POINTER position relative to the box's own center, never from the
 * handle element's position, so clamping where the handle is drawn changes
 * nothing about how rotating it behaves once grabbed.
 */
function clampRotateHandleToViewport() {
  if (!rotateHandleEl) return;
  rotateHandleEl.style.position = '';
  rotateHandleEl.style.left = '';
  rotateHandleEl.style.top = '';
  const rect = rotateHandleEl.getBoundingClientRect();
  if (!rect.width && !rect.height) return; // hidden/not laid out yet
  const margin = 10;
  // The app's own top header bar sits at a HIGHER z-index (100) than this
  // overlay (20) and spans the full page width — clamping the handle to
  // merely "within the viewport" (y >= 0) still landed it fully behind that
  // header whenever the natural position was less than the header's own
  // height, confirmed by document.elementFromPoint() returning the header,
  // not the handle, at the "clamped" point. Reading the header's own live
  // rect (rather than hardcoding its height) means this stays correct if
  // the header's height ever changes.
  const header = document.querySelector('header');
  const minY = (header ? header.getBoundingClientRect().bottom : 0) + margin;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const clampedCx = Math.max(margin, Math.min(window.innerWidth - margin, cx));
  const clampedCy = Math.max(minY, Math.min(window.innerHeight - margin, cy));
  if (clampedCx === cx && clampedCy === cy) return;
  // .caption-transform-handle has `margin: -7px` (centers the 14px dot on
  // its own left/top anchor point rather than the anchor being its
  // top-left corner) — that margin still applies once `position` switches
  // to `fixed`, so left/top must be the CENTER point directly, not
  // clampedC{x,y} minus half the handle's size (that double-applied the
  // centering offset, landing the handle exactly 7px off in both axes —
  // confirmed via a real getBoundingClientRect() vs. inline-style diff).
  rotateHandleEl.style.position = 'fixed';
  rotateHandleEl.style.left = `${clampedCx}px`;
  rotateHandleEl.style.top = `${clampedCy}px`;
}

function positionBoxElement() {
  const box = getDisplayBox();
  if (!boxEl || !box) return;
  const scale = box.cssPxScale || 1;
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
  // Counter-rotate the toolbar (scope/animation buttons, reset, the rotation
  // label) so its TEXT stays upright and readable regardless of the box's
  // own rotation — confirmed via user report + screenshot: at e.g. 270° the
  // toolbar's own labels were rendering sideways, forcing the user to
  // visually chase whichever direction the caption itself was pointing.
  // Rotating it by the exact opposite angle, inside the already-rotated
  // parent, cancels that inherited rotation back to 0 net degrees — the
  // toolbar's own translate(-50%, -8px) positioning (its default CSS rule)
  // still has to be restated here since setting `transform` inline replaces
  // the whole property, not just adds to it.
  const controlsBelow = shouldPlaceControlsBelow();
  boxEl.classList.toggle('controls-below', controlsBelow);
  if (toolbarEl) {
    const baseTranslate = controlsBelow ? 'translate(-50%, 8px)' : 'translate(-50%, -8px)';
    toolbarEl.style.transform = box.rotationDeg
      ? `${baseTranslate} rotate(${-box.rotationDeg}deg)`
      : '';
  }
  clampRotateHandleToViewport();
}

/**
 * Whether the box's controls (toolbar + rotate handle, normally ABOVE it —
 * see style.css's .controls-below rules) should flip to below instead —
 * true whenever the box's actual rendered top edge is too close to the
 * app's own always-on-top header for the ~90px of space those controls
 * need above it. Reads boxEl's OWN getBoundingClientRect() (already correct
 * for whatever rotation is currently applied, since the browser did that
 * math) rather than re-deriving it from box.y/rotationDeg by hand.
 *
 * Deliberately checked EVERY call (not cached) — the box's top edge moves
 * with every drag/keyframe/interpolation tick, exactly the cases that
 * created this problem in the first place (see clampRotateHandleToViewport's
 * matching doc comment for the confirmed repro).
 */
function shouldPlaceControlsBelow() {
  if (!boxEl) return false;
  const header = document.querySelector('header');
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const CONTROLS_HEIGHT_PX = 90; // toolbar (~1-2 rows) + connecting line + rotate handle
  const boxRect = boxEl.getBoundingClientRect();
  return boxRect.top - CONTROLS_HEIGHT_PX < headerBottom;
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
  // A text element is its own target kind — none of the caption/keyword/
  // group scope buttons apply to it (there is no "all captions" for an
  // object that exists exactly once), so classifying it here is what keeps
  // every one of them hidden in updateScopeButtons.
  if (selectedTextElementId) return 'text';
  if (selectedWordIndex == null) {
    // A partial/custom group (some caption words detached, or an explicitly
    // grouped subset) has no phrase-level field of its own — This Caption/
    // All Captions scope only makes sense for the full, untouched caption
    // case (see isFullPhraseGroup), so it's classified separately here to
    // keep those buttons hidden for it (see updateScopeButtons).
    if (selectedGroupId != null && currentBox && !isFullPhraseGroup(selectedGroupId)) return 'group';
    return 'caption';
  }
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
 * What the animation type dropdown should currently display — the
 * currently-selected word's own override if one is selected, else the
 * current caption/group's phrase-level override, falling back to the global
 * appState.captionAnimationType either way (the exact same fallback chain
 * shared/captionAnimation.js's resolveAnimationConfig and
 * shared/captionTransform.js's resolvePhraseParams already use for
 * rendering, so the dropdown never shows a value the renderer wouldn't
 * actually use).
 */
function getCurrentAnimationTypeForDisplay() {
  if (selectedWordIndex != null) {
    const override = appState.captionTransforms[getWordTransformKey(selectedWordIndex)];
    return override?.animationType || 'none';
  }
  if (currentBox?.phrase) {
    const override = appState.captionTransforms[getPhraseTransformKey(currentBox.phrase)];
    if (override?.animationType != null) return override.animationType;
  }
  return appState.captionAnimationType || 'none';
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
  const suppressForMultiSelect = isSelectingKeywords || isSelectingGroup;

  const showCaptionScope = target === 'caption' && !suppressForMultiSelect;
  if (scopeThisBtn) scopeThisBtn.hidden = !showCaptionScope;
  if (scopeAllBtn) scopeAllBtn.hidden = !showCaptionScope;
  if (showCaptionScope) {
    scopeThisBtn?.classList.toggle('active', appState.transformApplyScope === 'this');
    scopeAllBtn?.classList.toggle('active', appState.transformApplyScope !== 'this');
  }

  const showKeywordScope = target === 'keyword' && !suppressForMultiSelect;
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

  // ANIMATION section — available for every selection target (word,
  // keyword, caption, or group), not just keywords: caption mode/style must
  // not determine whether editing is available, and the same applies to
  // animation specifically (this feature's own architectural rule). Exactly
  // which SCOPE buttons show depends on the target — see each button block
  // below — but the type select itself is always visible whenever anything
  // is selected.
  const showAnimationSection = (target === 'word' || target === 'keyword' || target === 'caption' || target === 'group') && !suppressForMultiSelect;
  const isWordTarget = target === 'word' || target === 'keyword';

  if (animationSectionLabelEl) animationSectionLabelEl.hidden = !showAnimationSection;

  if (animationTypeSelect) {
    animationTypeSelect.hidden = !showAnimationSection;
    if (showAnimationSection) {
      const current = getCurrentAnimationTypeForDisplay();
      if (animationTypeSelect.value !== current) animationTypeSelect.value = current;
    }
  }

  // "This Word"/"This Keyword" — same scope value ('this'), label swaps to
  // match the actual selection so it never reads as the wrong noun.
  if (animScopeThisBtn) {
    const show = showAnimationSection && isWordTarget;
    animScopeThisBtn.hidden = !show;
    if (show) {
      animScopeThisBtn.textContent = target === 'keyword' ? 'This Keyword' : 'This Word';
      animScopeThisBtn.classList.toggle('active', appState.animationApplyScope === 'this');
    }
  }

  // "All Keywords"/"All Normal Words" — same scope value ('same-type'),
  // fans out to every OTHER instance of the selected word's own type (see
  // getWordIndexesForAnimationScope), each animating independently.
  if (animScopeSameTypeBtn) {
    const show = showAnimationSection && isWordTarget;
    animScopeSameTypeBtn.hidden = !show;
    if (show) {
      animScopeSameTypeBtn.textContent = target === 'keyword' ? 'All Keywords' : 'All Normal Words';
      animScopeSameTypeBtn.classList.toggle('active', appState.animationApplyScope === 'same-type');
    }
  }

  // "All Words" — every word regardless of type, each animating
  // independently. Only offered from a NORMAL word (per this feature's own
  // spec: a keyword's list is This Keyword/All Keywords/This Caption/All
  // Captions — "All Words" isn't one of its options).
  if (animScopeAllWordsBtn) {
    const show = showAnimationSection && target === 'word';
    animScopeAllWordsBtn.hidden = !show;
    if (show) animScopeAllWordsBtn.classList.toggle('active', appState.animationApplyScope === 'all-words');
  }

  // "This Caption"/"All Captions" — escalates a word-level selection to the
  // whole caption/all captions (or is simply the default/only choice when a
  // caption/group is already the selection — see applyAnimationFields).
  if (animScopeThisCaptionBtn) {
    animScopeThisCaptionBtn.hidden = !showAnimationSection;
    if (showAnimationSection) {
      const isActive = isWordTarget
        ? appState.animationApplyScope === 'this-caption'
        : appState.animationApplyScope !== 'all-captions';
      animScopeThisCaptionBtn.classList.toggle('active', isActive);
    }
  }
  if (animScopeAllCaptionsBtn) {
    animScopeAllCaptionsBtn.hidden = !showAnimationSection;
    if (showAnimationSection) {
      animScopeAllCaptionsBtn.classList.toggle('active', appState.animationApplyScope === 'all-captions');
    }
  }

  // Manual keyword mark/unmark — available whenever a specific word is
  // selected, regardless of its current status, so AI-generated keywords
  // stay editable and a normal word can be promoted to one (see
  // setWordKeyword's doc comment: this is the SAME write path the transcript
  // editor's own toggle uses).
  if (keywordToggleBtn) {
    const showToggle = selectedWordIndex != null && !suppressForMultiSelect;
    keywordToggleBtn.hidden = !showToggle;
    if (showToggle) {
      const isKw = isKeywordIndex(selectedWordIndex);
      keywordToggleBtn.textContent = isKw ? 'Unmark Keyword' : 'Mark as Keyword';
      keywordToggleBtn.classList.toggle('active', isKw);
    }
  }

  // "Group Words" — starts the explicit multi-select flow (see
  // renderGroupMultiSelectMarkers/the hitAreaEl pointerdown handler's
  // isSelectingGroup branch). Available for any group-level selection
  // (a plain caption or an existing custom group), not for a single word.
  const showGroupStart = (target === 'caption' || target === 'group') && !suppressForMultiSelect;
  if (groupStartBtn) groupStartBtn.hidden = !showGroupStart;

  if (groupConfirmBtn) groupConfirmBtn.hidden = !isSelectingGroup;
  if (groupMultiSelectLabelEl) {
    groupMultiSelectLabelEl.hidden = !isSelectingGroup;
    if (isSelectingGroup) {
      const count = groupMultiSelection ? groupMultiSelection.size : 0;
      groupMultiSelectLabelEl.textContent = `${count} selected`;
    }
  }


  // While picking "Select Keywords"/"Group Words" instances, boxEl often
  // falls back to covering the WHOLE caption (see getDisplayBox — the anchor
  // word is frequently not part of whatever's on screen right now, since the
  // user is deliberately navigating elsewhere to find more instances).
  // Sitting on top of hitAreaEl, it would otherwise swallow every click
  // meant for findWordAtPoint's own multi-select toggle (see the hitAreaEl
  // pointerdown handler) before it ever gets there. Making it click-through
  // — except for the toolbar itself, which keeps its own `pointer-events:
  // auto` (see style.css) so Done/Group/the scope buttons stay clickable
  // throughout.
  if (boxEl) boxEl.style.pointerEvents = suppressForMultiSelect ? 'none' : '';
}

/**
 * Called once per rendered frame from preview.js's syncVideoSubtitles, right
 * after the graphics renderer draws (or skips) a frame.
 *
 * @param {object|null} box - measureSentenceFrame/measureRollingStackFrame's result, or null if nothing is on screen right now.
 * @param {object} phrase - The active phrase this box belongs to.
 * @param {'sentence'|'rolling-stack'} mode
 */
/**
 * Keeps the (now `position: fixed` — see style.css's .caption-transform-overlay
 * doc comment) overlay's own left/top/width/height glued to the real content
 * rect, in viewport px. Needed every time the overlay might actually be shown
 * (not just once at init): the content rect can change size across a tick
 * (window resize, the timeline panel resizing the workspace, DPR changes) and
 * a `fixed` element has no CSS shorthand equivalent to the old
 * `top:0;left:0;width:100%;height:100%` relative-to-parent trick — it must be
 * set explicitly.
 */
function syncOverlayToContentRect(el) {
  if (!el) return;
  const rect = getCanvasContentRect();
  if (!rect) return;
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

export function updateCanvasTransformOverlay(box, phrase, mode) {
  if (!overlayEl) return;

  if (!box) {
    hideCanvasTransformOverlay();
    return;
  }

  currentBox = { ...box, phrase, mode };
  overlayEl.classList.add('active');
  syncOverlayToContentRect(overlayEl);

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
    // Falls back to CURRENT caption's own default group (not a full
    // deselect) — a caption IS still on screen, mirroring the exact
    // rationale above for why word staleness doesn't fully deselect either.
    selectedGroupId = currentBox.phrase ? getPhraseTransformKey(currentBox.phrase) : null;
    resetKeywordScopeState();
  }

  // GROUP staleness/auto-follow — mirrors the word-level check above. A
  // selection representing "this caption's plain default group" has no
  // identity of its own beyond the phrase key, so when the phrase on screen
  // changes (playback advances to a new caption), selectedGroupId simply no
  // longer matches the new phrase's default key and is re-pointed at
  // whichever caption is on screen NOW — this is what makes a plain
  // whole-caption selection keep following playback exactly as it always
  // has. A genuinely custom/explicit group (or a default-group id from a
  // phrase that's since scrolled away) is instead kept ALIVE as long as at
  // least one of its members is still visible this frame, and only falls
  // back to the new caption's default group once none of them are.
  if (selectedWordIndex == null && selectedGroupId != null) {
    const defaultKeyNow = currentBox.phrase ? getPhraseTransformKey(currentBox.phrase) : null;
    if (selectedGroupId !== defaultKeyNow && getGroupMemberIndexes(selectedGroupId).length === 0) {
      selectedGroupId = defaultKeyNow;
    }
  }

  if (isSelectingKeywords) renderKeywordMultiSelectMarkers();
  if (isSelectingGroup) renderGroupMultiSelectMarkers();

  if (selected && !drag) {
    boxEl.hidden = false;
    positionBoxElement();
    updateScopeButtons();
  } else if (!drag) {
    boxEl.hidden = true;
  }

  notifySelectionChangedIfNeeded();
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
  // Text elements live on their own layer with their own selection, so a
  // frame with no CAPTION on it must not tear down the overlay they're
  // also using — that would make an on-screen overlay unclickable (the
  // overlay is `display: none` without `.active`) and hide its handles.
  // Reads last frame's box list, since this runs at the top of the tick
  // before syncTextElementsCanvas republishes; one frame of lag at the
  // moment the last element scrolls off is harmless.
  const keepForText = textElementBoxes.length > 0;
  if (overlayEl && !keepForText) overlayEl.classList.remove('active');
  if (boxEl && !selectedTextElementId) boxEl.hidden = true;
}

function clientToCssPoint(clientX, clientY) {
  const rect = getCanvasContentRect();
  return { x: clientX - rect.left, y: clientY - rect.top, rect };
}

/**
 * Publishes this frame's visible text-element boxes — called once per tick
 * by preview.js's syncTextElementsCanvas, from the SAME measure pass that
 * just drew them, so the box and the pixels can't disagree.
 *
 * Also re-shows/repositions the selection box itself, because a text
 * element's overlay can't ride along with the caption's: syncVideoSubtitles
 * calls hideCanvasTransformOverlay() at the top of EVERY tick, and the
 * updateCanvasTransformOverlay call that would normally undo that lives
 * behind several early returns (demo fallback, Word Mode, no active phrase)
 * that a text element is by definition independent of.
 */
export function setTextElementBoxes(boxes) {
  textElementBoxes = Array.isArray(boxes) ? boxes : [];

  // Selection can also originate from the TIMELINE (clicking the clip) or be
  // dropped by a delete, so appState — not this module — owns which element
  // is selected; the overlay just follows it.
  const stateId = appState.selectedTextElementId || null;
  if (stateId !== selectedTextElementId) {
    if (stateId) selectTextElementTarget(stateId);
    else clearTextElementSelection();
  }

  if (!overlayEl || !boxEl) return;

  // The overlay is `display: none` until `.active`, and its hit area is the
  // only thing that receives clicks — so it has to be live whenever ANY
  // text element is on screen, not merely once one is already selected.
  // Without this, the very first click on an overlay would never reach a
  // handler at all.
  if (textElementBoxes.length) {
    overlayEl.classList.add('active');
    syncOverlayToContentRect(overlayEl);
  }

  if (inlineEditingId) {
    // The element can still move under the caret (playback, a keyframe), so
    // the field follows it rather than being placed once.
    positionInlineEditor();
    return;
  }

  if (!selectedTextElementId) return;

  // Selected but not visible right now (the playhead moved outside the
  // element's own [start, end)) — hide the handles without DROPPING the
  // selection, exactly as the caption path does for a stale word: the
  // element still exists, it simply isn't on screen this instant.
  if (!textElementBoxes.some((b) => b.id === selectedTextElementId)) {
    if (!drag) boxEl.hidden = true;
    return;
  }

  if (!drag) {
    boxEl.hidden = false;
    positionBoxElement();
  }
}

// --- Inline text editing on the canvas -------------------------------------
//
// Double-click a text overlay on the video to type straight into it. The
// Overlay panel's Content field still works and stays the fuller surface;
// this exists because going to a side panel to fix a word you can see in
// front of you is exactly the kind of detour a caption editor shouldn't ask
// for.
//
// A real <textarea> laid over the element's own measured box, not a
// contenteditable canvas trick: it gets caret handling, selection, IME,
// undo-in-field and mobile keyboards for free, and it keeps the text a plain
// string rather than DOM that has to be parsed back.

let inlineEditorEl = null;
let inlineEditingId = null;

/** Positions the editor over the element's current on-screen box. */
function positionInlineEditor() {
  if (!inlineEditorEl || !inlineEditingId) return;
  const entry = textElementBoxes.find((b) => b.id === inlineEditingId);
  if (!entry) return;
  const scale = entry.box.cssPxScale || 1;
  const minWidth = 140;
  const width = Math.max(minWidth, entry.box.width / scale + 24);
  const height = Math.max(34, entry.box.height / scale + 16);
  inlineEditorEl.style.left = `${entry.box.centerX / scale - width / 2}px`;
  inlineEditorEl.style.top = `${entry.box.centerY / scale - height / 2}px`;
  inlineEditorEl.style.width = `${width}px`;
  inlineEditorEl.style.height = `${height}px`;
}

function startInlineEdit(id) {
  const element = getTextElement(id);
  if (!element || !inlineEditorEl) return;
  inlineEditingId = id;
  inlineEditorEl.value = element.text || '';
  inlineEditorEl.hidden = false;
  positionInlineEditor();
  inlineEditorEl.focus();
  inlineEditorEl.select();
  // The handles would sit on top of the field and swallow clicks meant for
  // the caret.
  if (boxEl) boxEl.hidden = true;
}

/**
 * Leaves edit mode. The live keystrokes were written with history off, so
 * this commits the finished text as ONE undo step — the same split every
 * gesture in this file uses.
 */
function endInlineEdit(commit = true) {
  if (!inlineEditingId || !inlineEditorEl) return;
  const id = inlineEditingId;
  const value = inlineEditorEl.value;
  inlineEditingId = null;
  inlineEditorEl.hidden = true;
  inlineEditorEl.blur();
  if (commit) updateTextElement(id, { text: value }, { recordHistory: true });
  if (boxEl && selectedTextElementId) {
    boxEl.hidden = false;
    positionBoxElement();
  }
}

/** True while the canvas editor has the caret — used to hold off gestures. */
export function isEditingTextElementInline() {
  return !!inlineEditingId;
}

/** Topmost visible text element under a viewport point, or null. */
function findTextElementAtClient(clientX, clientY) {
  if (!textElementBoxes.length) return null;
  const { x, y } = clientToCssPoint(clientX, clientY);
  // Reverse order: elements are drawn in list order, so the LAST one drawn
  // is the one visually on top and must win an overlapping hit.
  for (let i = textElementBoxes.length - 1; i >= 0; i--) {
    const { id, box } = textElementBoxes[i];
    const scale = box.cssPxScale || 1;
    const padded = ensureMinimumGrabBox(inflateBox(box, CAPTION_SELECTION_PADDING_CSS_PX));
    const cssBox = {
      centerX: padded.centerX / scale,
      centerY: padded.centerY / scale,
      width: padded.width / scale,
      height: padded.height / scale,
      rotationDeg: padded.rotationDeg
    };
    if (pointInRotatedBox(x, y, cssBox)) return { id, box };
  }
  return null;
}

/**
 * Makes a text element THE canvas selection, tearing down any caption-side
 * selection first — the overlay shows exactly one target at a time, and the
 * caption toolbar's scope/animation/keyword controls mean nothing for an
 * object that exists once and has no transcript behind it.
 */
function selectTextElementTarget(id) {
  resetKeywordScopeState();
  selected = true;
  selectedWordIndex = null;
  selectedGroupId = null;
  explicitCaptionSelectionKey = null;
  selectedTextElementId = id;
  if (toolbarEl) toolbarEl.hidden = true;
  selectTextElement(id);
  notifySelectionChangedIfNeeded();
}

function clearTextElementSelection() {
  if (inlineEditingId) endInlineEdit(true);
  if (!selectedTextElementId) return;
  selectedTextElementId = null;
  // `selected` is only ever true-because-of-a-text-element here (a text
  // selection zeroes selectedWordIndex/selectedGroupId), so dropping it is
  // dropping the whole selection — leaving it set would keep a box on
  // screen that getDisplayBox can no longer resolve.
  selected = false;
  if (toolbarEl) toolbarEl.hidden = false;
  if (boxEl) boxEl.hidden = true;
  selectTextElement(null);
}

/**
 * The element's currently-effective value for one style field — its own
 * override if it has one, else whatever the caption look it inherits from
 * supplies (see textElements.js: an empty style bag means "inherit"). Used
 * as the BASELINE a gesture composes onto, so a first drag on an untouched
 * element doesn't snap it away from where it's actually drawn.
 */
function effectiveTextElementValue(id, field, fallback) {
  const value = getTextElement(id)?.style?.[field];
  return value == null ? fallback : value;
}

/**
 * The element's complete pre-gesture state — its whole style bag AND its
 * keyframe list, not a handful of named fields.
 *
 * Whole-element on purpose: a gesture on a KEYFRAMED element writes into the
 * keyframe track rather than the static field (see
 * textElements.js's setTextElementValues), so a rewind that only restored
 * named style keys would leave the mutated keyframe behind. See endTextDrag
 * for why a gesture has to be able to rewind itself at all.
 */
function textElementSnapshot(id) {
  const element = getTextElement(id);
  if (!element) return null;
  return { style: { ...(element.style || {}) }, keyframes: element.keyframes || [] };
}

function beginTextMove(e) {
  const box = getDisplayBox();
  if (!box) return;
  const { x, y, rect } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.cssPxScale || 1;
  drag = {
    kind: 'move',
    pointerId: e.pointerId,
    textElementId: selectedTextElementId,
    startStyle: textElementSnapshot(selectedTextElementId),
    // Delta-based, for the same reason the whole-caption move is (see
    // onPointerMove): the element is grabbed wherever the user clicked, not
    // at its center, so snapping its anchor to the cursor would jump it by
    // the click-point-to-center distance on the first pixel of movement.
    startPointerXPct: (x / rect.width) * 100,
    startPointerYPct: (y / rect.height) * 100,
    // Read from the box the renderer just produced, NOT from the stored
    // style: an element that has never been dragged may have no
    // customPosX/Y of its own yet, and starting from a default of 0 would
    // fling it into the frame's top-left corner.
    startPosXPct: ((box.centerX / scale) / rect.width) * 100,
    startPosYPct: ((box.centerY / scale) / rect.height) * 100
  };
  hitAreaEl.setPointerCapture(e.pointerId);
}

function beginTextResize(e, corner) {
  const box = getDisplayBox();
  if (!box) return;
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.cssPxScale || 1;
  drag = {
    kind: 'resize',
    pointerId: e.pointerId,
    textElementId: selectedTextElementId,
    corner,
    startStyle: textElementSnapshot(selectedTextElementId),
    startDist: Math.hypot(x - box.centerX / scale, y - box.centerY / scale) || 1,
    startFontSize: effectiveTextElementValue(selectedTextElementId, 'fontSize', appState.fontSize)
  };
  e.target.setPointerCapture(e.pointerId);
}

function beginTextRotate(e) {
  drag = {
    kind: 'rotate', pointerId: e.pointerId, textElementId: selectedTextElementId,
    startStyle: textElementSnapshot(selectedTextElementId)
  };
  e.target.setPointerCapture(e.pointerId);
}

/**
 * Live gesture updates, all with recordHistory:false — endDrag commits the
 * finished gesture as ONE undo step (the same split every other drag in this
 * file and in audioTimeline.js uses).
 */
function onTextPointerMove(e) {
  const box = getDisplayBox();
  if (!box) return;
  const id = drag.textElementId;
  const { x, y, rect } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.cssPxScale || 1;
  const centerX = box.centerX / scale;
  const centerY = box.centerY / scale;

  if (drag.kind === 'move') {
    const xPct = (x / rect.width) * 100;
    const yPct = (y / rect.height) * 100;
    // Through setTextElementValues, not a raw style write: on a keyframed
    // element this updates the keyframe AT the playhead instead of the
    // static base underneath it (which the keyframe track would win over,
    // making the drag look like it did nothing). It also stamps
    // position:'manual' — an element inheriting an ANCHORED position has
    // nowhere to put a dragged coordinate.
    setTextElementValues({
      positionX: Math.max(0, Math.min(100, drag.startPosXPct + (xPct - drag.startPointerXPct))),
      positionY: Math.max(0, Math.min(100, drag.startPosYPct + (yPct - drag.startPointerYPct)))
    }, { recordHistory: false });
  } else if (drag.kind === 'resize') {
    // fontSize is a plain style field, not one of the five animatable
    // properties (scale is captionScaleMultiplier) — exactly as a caption's
    // own corner-resize writes fontSize rather than keyframing scale.
    const ratio = (Math.hypot(x - centerX, y - centerY) || 1) / drag.startDist;
    updateTextElementStyle(id, {
      fontSize: Math.max(6, Math.min(150, Math.round(drag.startFontSize * ratio)))
    }, { recordHistory: false });
  } else if (drag.kind === 'rotate') {
    const angleDeg = (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
    setTextElementValues({ rotation: Math.round(angleDeg + 90) }, { recordHistory: false });
  }
}

/**
 * Commits a finished gesture as exactly ONE undo step.
 *
 * Rewinds to the pre-gesture values first, with history OFF, then re-applies
 * the final ones with history ON. That looks redundant but isn't:
 * state.js's pushHistorySnapshot snapshots the CURRENT state at the moment
 * of the recording write, and the live drag has already written its result
 * into that state with recordHistory:false — so committing straight away
 * would push a snapshot identical to the outcome and make undo a no-op
 * (confirmed: the first version of this did exactly that).
 */
function endTextDrag(d) {
  const id = d.textElementId;
  const final = textElementSnapshot(id);
  if (!final) return;
  if (d.startStyle) updateTextElement(id, d.startStyle, { recordHistory: false });
  updateTextElement(id, final, { recordHistory: true });
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
  const scale = currentBox.cssPxScale || 1;
  return findWordAtPoint(x * scale, y * scale, currentBox);
}

/**
 * Whether the current group-level selection needs the per-MEMBER fan-out
 * transform path instead of the original whole-phrase path — true for any
 * group that ISN'T the untouched, full caption (a partial default group with
 * some words detached, or an explicit custom group). See isFullPhraseGroup's
 * own doc comment for why the full-phrase case still goes through the
 * original applyTransformFields path unchanged.
 */
function isPartialGroupTransform() {
  return selectedWordIndex == null && selectedGroupId != null && !isFullPhraseGroup(selectedGroupId);
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
  const { x, y, rect } = clientToCssPoint(e.clientX, e.clientY);
  const isGroupFanOut = isPartialGroupTransform();
  const groupMembers = isGroupFanOut ? getGroupMemberIndexes(selectedGroupId) : null;
  const groupStart = isGroupFanOut
    ? new Map(groupMembers.map((idx) => [idx, {
        offsetXPx: effectiveWordValue(idx, 'offsetXPx', 0),
        offsetYPx: effectiveWordValue(idx, 'offsetYPx', 0)
      }]))
    : null;
  // Whole-caption move baseline (see onPointerMove's matching branch): the
  // caption's OWN current resolved position, read from currentBox itself —
  // the SAME geometry the renderer just drew this frame from (see
  // shared/captionGraphics.js's measureSentenceFrame: centerX/centerY are
  // resolved through the full chain — per-phrase override, else the
  // caption's actual style-driven default position (e.g. center/bottom),
  // else keyframe interpolation). Deliberately NOT getCurrentValueForProperty
  // here: that helper's fallback bottoms out at the flat
  // KEYFRAME_PROPERTY_DEFAULTS (positionX/Y = 0) the moment there's no
  // per-phrase override yet, regardless of the style's actual default
  // position — using it as a drag baseline would silently snap an
  // untouched, e.g. bottom-anchored caption to (0, 0) on the very first
  // pixel of movement. currentBox.centerX/centerY carry no such gap.
  const isWholeCaptionMove = wordIndex == null && !isGroupFanOut;
  const frameRect = isWholeCaptionMove ? getCanvasContentRect() : null;
  const boxScale = currentBox.cssPxScale || 1;
  drag = {
    kind: 'move',
    pointerId: e.pointerId,
    phrase: currentBox.phrase,
    wordIndex,
    groupId: isGroupFanOut ? selectedGroupId : null,
    groupMembers,
    groupStart,
    // Word move is a pixel offset relative to where the drag STARTED, not a
    // frame-relative percentage (see onPointerMove) — capture the pointer's
    // own starting CSS position and the word's already-applied offset so the
    // gesture composes with any prior drag instead of resetting it.
    startPointerX: x,
    startPointerY: y,
    startOffsetXPx: wordIndex != null ? effectiveWordValue(wordIndex, 'offsetXPx', 0) : 0,
    startOffsetYPx: wordIndex != null ? effectiveWordValue(wordIndex, 'offsetYPx', 0) : 0,
    startPointerXPct: isWholeCaptionMove ? (x / rect.width) * 100 : 0,
    startPointerYPct: isWholeCaptionMove ? (y / rect.height) * 100 : 0,
    startPosXPct: isWholeCaptionMove && frameRect ? ((currentBox.centerX / boxScale) / frameRect.width) * 100 : 0,
    startPosYPct: isWholeCaptionMove && frameRect ? ((currentBox.centerY / boxScale) / frameRect.height) * 100 : 0
  };
  hitAreaEl.setPointerCapture(e.pointerId);
}

function beginResize(e, corner) {
  if (!currentBox) return;
  const box = getDisplayBox();
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.cssPxScale || 1;
  const centerX = box.centerX / scale;
  const centerY = box.centerY / scale;
  const startDist = Math.hypot(x - centerX, y - centerY) || 1;
  const wordIndex = selectedWordIndex;
  const isGroupFanOut = isPartialGroupTransform();
  const groupMembers = isGroupFanOut ? getGroupMemberIndexes(selectedGroupId) : null;
  const groupStart = isGroupFanOut
    ? new Map(groupMembers.map((idx) => [idx, effectiveWordValue(idx, 'fontScale', 1)]))
    : null;
  const startFontSize = wordIndex != null
    ? effectiveWordValue(wordIndex, 'fontScale', 1)
    : effectiveValue(currentBox.phrase, 'fontSize', appState.fontSize);
  drag = {
    kind: 'resize', pointerId: e.pointerId, startDist, startFontSize, corner, phrase: currentBox.phrase, wordIndex,
    groupId: isGroupFanOut ? selectedGroupId : null, groupMembers, groupStart
  };
  e.target.setPointerCapture(e.pointerId);
}

function beginRotate(e) {
  if (!currentBox) return;
  const isGroupFanOut = isPartialGroupTransform();
  let groupMembers = null, groupStart = null, startAngle = null;
  if (isGroupFanOut) {
    groupMembers = getGroupMemberIndexes(selectedGroupId);
    groupStart = new Map(groupMembers.map((idx) => [idx, effectiveWordValue(idx, 'rotationDeg', 0)]));
    const box = getDisplayBox();
    const { x, y } = clientToCssPoint(e.clientX, e.clientY);
    const scale = box.cssPxScale || 1;
    startAngle = (Math.atan2(y - box.centerY / scale, x - box.centerX / scale) * 180) / Math.PI;
  }
  drag = {
    kind: 'rotate', pointerId: e.pointerId, phrase: currentBox.phrase, wordIndex: selectedWordIndex,
    groupId: isGroupFanOut ? selectedGroupId : null, groupMembers, groupStart, startAngle
  };
  e.target.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  // Checked before the currentBox guard: a text element can be dragged on a
  // frame with no caption on screen, where currentBox is null.
  if (drag && drag.textElementId) { onTextPointerMove(e); return; }
  if (!drag || !currentBox) return;
  const box = getDisplayBox();
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = box.cssPxScale || 1;
  const centerX = box.centerX / scale;
  const centerY = box.centerY / scale;
  const wordIndex = drag.wordIndex;

  if (drag.kind === 'move') {
    if (wordIndex != null) {
      // A word's move is a plain pixel offset from its own laid-out
      // position (see shared/captionGraphics.js's per-word ctx.translate),
      // not a percentage of the whole frame like a caption's customPosX/Y —
      // a word has no independent "anchor" of its own to express as a
      // frame-relative percentage.
      //
      // Stored in the AUTHORED 330-box unit (see
      // shared/captionGraphics.js's wordOffsetToCanvasPx), the same unit
      // fontSize/spacing/outline are authored in — NOT canvas backing-store
      // px, which is what this used to store. Canvas px is resolution-
      // dependent: the preview canvas is ~168-322px wide while the export
      // canvas is the video's real width (e.g. 1080px), so the same stored
      // number moved the word a completely different fraction of the frame
      // in each renderer, and a word dragged far left in the preview came
      // out near its default position in the exported file.
      const deltaCssX = x - drag.startPointerX;
      const deltaCssY = y - drag.startPointerY;
      const canvasW = getCanvasBackingWidth();
      writeWordFields(wordIndex, {
        offsetXPx: drag.startOffsetXPx + canvasPxToWordOffset(deltaCssX * scale, canvasW),
        offsetYPx: drag.startOffsetYPx + canvasPxToWordOffset(deltaCssY * scale, canvasW)
      }, { recordHistory: false });
    } else if (drag.groupMembers) {
      // GROUP move: translate every current member by the SAME pixel delta
      // — a plain rigid-body move of only the words actually in this group
      // right now (see this feature's own requirement that transforming the
      // group must not affect anything else). Bypasses writeWordFields'
      // keyword-scope fan-out on purpose: a group drag's intent is "move
      // these specific word instances", not "apply to every instance of
      // this keyword across the transcript" — those are orthogonal concerns
      // (grouping never depends on keyword status either).
      const deltaCssX = x - drag.startPointerX;
      const deltaCssY = y - drag.startPointerY;
      // Same authored-unit conversion as the single-word branch above.
      const canvasWGroup = getCanvasBackingWidth();
      drag.groupMembers.forEach((idx) => {
        const start = drag.groupStart.get(idx);
        applyWordTransformFields(idx, {
          offsetXPx: start.offsetXPx + canvasPxToWordOffset(deltaCssX * scale, canvasWGroup),
          offsetYPx: start.offsetYPx + canvasPxToWordOffset(deltaCssY * scale, canvasWGroup)
        }, { recordHistory: false });
      });
    } else {
      // Delta from where the drag STARTED, added to the caption's OWN
      // starting position (see beginMove) — NOT the raw cursor position as
      // an absolute frame percentage. The caption is grabbed wherever the
      // user actually clicked on it (rarely its exact center), so snapping
      // its anchor straight to the cursor's own position produced a sudden
      // jump equal to the click-point-to-anchor distance on the very first
      // pixel of movement, and made the caption's motion feel disconnected
      // from the cursor for the rest of the gesture (confirmed: the word-move
      // branch above never had this bug, since it was already delta-based).
      const { rect } = clientToCssPoint(e.clientX, e.clientY);
      const xPct = (x / rect.width) * 100;
      const yPct = (y / rect.height) * 100;
      const nextXPct = Math.max(0, Math.min(100, drag.startPosXPct + (xPct - drag.startPointerXPct)));
      const nextYPct = Math.max(0, Math.min(100, drag.startPosYPct + (yPct - drag.startPointerYPct)));
      applyTransformFields({ customPosX: nextXPct, customPosY: nextYPct }, { recordHistory: false, phrase: drag.phrase });
    }
  } else if (drag.kind === 'resize') {
    const dist = Math.hypot(x - centerX, y - centerY) || 1;
    const ratio = dist / drag.startDist;
    if (wordIndex != null) {
      const nextScale = Math.max(0.3, Math.min(4, drag.startFontSize * ratio));
      writeWordFields(wordIndex, { fontScale: nextScale }, { recordHistory: false });
    } else if (drag.groupMembers) {
      // Same ratio applied multiplicatively to each member's OWN starting
      // scale, so members that already had different sizes keep their
      // relative proportions while the group resizes together.
      drag.groupMembers.forEach((idx) => {
        const startScale = drag.groupStart.get(idx) || 1;
        const nextScale = Math.max(0.3, Math.min(4, startScale * ratio));
        applyWordTransformFields(idx, { fontScale: nextScale }, { recordHistory: false });
      });
    } else {
      const nextFontSize = Math.max(6, Math.min(150, Math.round(drag.startFontSize * ratio)));
      applyTransformFields({ fontSize: nextFontSize }, { recordHistory: false, phrase: drag.phrase });
    }
  } else if (drag.kind === 'rotate') {
    const angleDeg = (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
    if (wordIndex != null) {
      const rotationDeg = Math.round(angleDeg + 90);
      writeWordFields(wordIndex, { rotationDeg }, { recordHistory: false });
    } else if (drag.groupMembers) {
      // Each member's rotation increases by the SAME angle delta from its
      // own starting rotation — keeps members' relative rotation offsets
      // while the group appears to rotate together (a simplification vs.
      // full rigid-body rotation around the group's center, which would
      // also need to reposition each member — out of scope here since the
      // requirement is only that the transform stays confined to current
      // members, not a specific rotation physics).
      const angleDelta = angleDeg - drag.startAngle;
      drag.groupMembers.forEach((idx) => {
        const startRot = drag.groupStart.get(idx) || 0;
        applyWordTransformFields(idx, { rotationDeg: Math.round(startRot + angleDelta) }, { recordHistory: false });
      });
    } else {
      const rotationDeg = Math.round(angleDeg + 90);
      applyTransformFields({ rotation: rotationDeg }, { recordHistory: false, phrase: drag.phrase });
    }
  }
}

function endDrag() {
  if (!drag) return;
  const finished = drag;
  const { kind, phrase, wordIndex, groupMembers, textElementId } = drag;
  drag = null;

  if (textElementId) {
    endTextDrag(finished);
    return;
  }

  if (groupMembers) {
    // Commit each member's just-set field as its own undo step, re-reading
    // through effectiveWordValue for the same reason the single-word/
    // whole-phrase commits below do (the live value during the drag was
    // written with recordHistory:false).
    groupMembers.forEach((idx) => {
      if (kind === 'move') {
        applyWordTransformFields(idx, {
          offsetXPx: effectiveWordValue(idx, 'offsetXPx', 0),
          offsetYPx: effectiveWordValue(idx, 'offsetYPx', 0)
        }, { recordHistory: true });
      } else if (kind === 'resize') {
        applyWordTransformFields(idx, { fontScale: effectiveWordValue(idx, 'fontScale', 1) }, { recordHistory: true });
      } else if (kind === 'rotate') {
        applyWordTransformFields(idx, { rotationDeg: effectiveWordValue(idx, 'rotationDeg', 0) }, { recordHistory: true });
      }
    });
    return;
  }

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
    // DYNAMIC GROUPING: an individual word transform is what pulls a word
    // OUT of whatever group it's currently in — its caption's plain default
    // group, OR an explicit custom group from the grouping flow — so it
    // stamps `groupId: null` (standalone) any time this word is transformed
    // on its own and ISN'T ALREADY standalone, so the group it's leaving
    // immediately recomputes its bounding box/membership without it (see
    // computeGroupBox/getGroupMemberIndexes). Only skipped when the word is
    // already standalone (groupId already exactly `null`), since re-writing
    // the same value is a harmless no-op anyway.
    const key = getWordTransformKey(wordIndex);
    const alreadyStandalone = appState.captionTransforms[key]?.groupId === null;
    const groupPatch = alreadyStandalone ? {} : { groupId: null };

    if (kind === 'move') {
      writeWordFields(wordIndex, {
        ...groupPatch,
        offsetXPx: effectiveWordValue(wordIndex, 'offsetXPx', 0),
        offsetYPx: effectiveWordValue(wordIndex, 'offsetYPx', 0)
      }, { recordHistory: true });
    } else if (kind === 'resize') {
      writeWordFields(wordIndex, { ...groupPatch, fontScale: effectiveWordValue(wordIndex, 'fontScale', 1) }, { recordHistory: true });
    } else if (kind === 'rotate') {
      writeWordFields(wordIndex, { ...groupPatch, rotationDeg: effectiveWordValue(wordIndex, 'rotationDeg', 0) }, { recordHistory: true });
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
  // Text elements' on-screen CSS rects (relative to the canvas content
  // rect), so a test can click the exact right spot instead of assuming
  // where a percentage-positioned overlay landed.
  window.__debugTextElementRects = () => textElementBoxes.map(({ id, box }) => {
    const s = box.cssPxScale || 1;
    return { id, centerX: box.centerX / s, centerY: box.centerY / s, width: box.width / s, height: box.height / s };
  });
  window.__debugSelectedTextElementId = () => selectedTextElementId;

  window.__debugWordScreenRect = (wordIndex) => {
    if (!currentBox) return null;
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === wordIndex);
    if (!word) return null;
    const box = wordBoxFor(word, currentBox);
    const scale = box.cssPxScale || 1;
    return { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale, centerX: box.centerX / scale, centerY: box.centerY / scale };
  };
  window.__debugKeywordScopeState = () => ({
    selectedWordIndex, isSelectingKeywords,
    keywordMultiSelection: keywordMultiSelection ? Array.from(keywordMultiSelection) : null
  });
  window.__debugCaptionBoxRect = () => {
    if (!currentBox) return null;
    const scale = currentBox.cssPxScale || 1;
    return { x: currentBox.x / scale, y: currentBox.y / scale, width: currentBox.width / scale, height: currentBox.height / scale, centerX: currentBox.centerX / scale, centerY: currentBox.centerY / scale };
  };
  window.__debugGroupState = () => ({
    selectedWordIndex, selectedGroupId, isSelectingGroup,
    groupMultiSelection: groupMultiSelection ? Array.from(groupMultiSelection) : null,
    isFullPhraseGroup: selectedGroupId != null ? isFullPhraseGroup(selectedGroupId) : null,
    members: selectedGroupId != null ? getGroupMemberIndexes(selectedGroupId) : null
  });
  window.__debugKeyframePin = () => ({
    explicitCaptionSelectionKey,
    currentBoxPhraseKey: currentBox?.phrase ? getPhraseTransformKey(currentBox.phrase) : null,
    selectedGroupId,
    resolvedTarget: getKeyframeTarget(),
    phrasesCount: (appState.phrases || []).length
  });
  window.__debugGroupBoxRect = () => {
    if (!currentBox || selectedGroupId == null) return null;
    const box = computeGroupBox(selectedGroupId);
    if (!box) return null;
    const scale = box.cssPxScale || 1;
    return { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale, centerX: box.centerX / scale, centerY: box.centerY / scale };
  };
  window.__debugEffectiveGroupId = (wordIndex) => (currentBox ? getEffectiveGroupId(wordIndex, currentBox.phrase) : null);
  // Unlike __debugWordScreenRect (wordBoxFor's offset-adjusted rect, i.e.
  // where a word actually renders), this returns the word's RAW pre-offset
  // rect — the coordinates findWordAtPoint hit-tests against (see its own
  // doc comment: a moved word's hit target intentionally stays at its
  // original footprint). Automated tests need this to click a spot that
  // will actually register as a hit on an already-moved word.
  window.__debugWordRawScreenRect = (wordIndex) => {
    if (!currentBox) return null;
    const word = getWordCandidates(currentBox).find((w) => w.wordIndex === wordIndex);
    if (!word) return null;
    const scale = currentBox.cssPxScale || 1;
    return { x: word.x / scale, y: word.y / scale, width: word.width / scale, height: word.height / scale, centerX: (word.x + word.width / 2) / scale, centerY: (word.y + word.height / 2) / scale };
  };
}

export function initCanvasTransform() {
  overlayEl = document.getElementById('caption-transform-overlay');
  hitAreaEl = document.getElementById('caption-transform-hit-area');
  boxEl = document.getElementById('caption-transform-box');
  rotateHandleEl = document.getElementById('caption-transform-handle-rotate');
  toolbarEl = document.getElementById('caption-transform-toolbar');
  scopeThisBtn = document.getElementById('btn-transform-scope-this');
  scopeAllBtn = document.getElementById('btn-transform-scope-all');
  resetBtn = document.getElementById('btn-transform-reset');
  rotationLabelEl = document.getElementById('caption-transform-rotation-label');
  scopeThisKeywordBtn = document.getElementById('btn-transform-scope-this-keyword');
  scopeAllKeywordsBtn = document.getElementById('btn-transform-scope-all-keywords');
  scopeSelectKeywordsBtn = document.getElementById('btn-transform-scope-select-keywords');
  keywordMultiSelectDoneBtn = document.getElementById('btn-transform-keyword-multiselect-done');
  keywordMultiSelectLabelEl = document.getElementById('caption-transform-keyword-multiselect-label');
  animationSectionLabelEl = document.getElementById('caption-transform-animation-label');
  animationTypeSelect = document.getElementById('select-canvas-animation-type');
  animScopeThisBtn = document.getElementById('btn-anim-scope-this');
  animScopeSameTypeBtn = document.getElementById('btn-anim-scope-same-type');
  animScopeAllWordsBtn = document.getElementById('btn-anim-scope-all-words');
  animScopeThisCaptionBtn = document.getElementById('btn-anim-scope-this-caption');
  animScopeAllCaptionsBtn = document.getElementById('btn-anim-scope-all-captions');
  keywordToggleBtn = document.getElementById('btn-transform-toggle-keyword');
  groupStartBtn = document.getElementById('btn-transform-group-start');
  groupConfirmBtn = document.getElementById('btn-transform-group-confirm');
  groupMultiSelectLabelEl = document.getElementById('caption-transform-group-multiselect-label');
  inlineEditorEl = document.getElementById('text-element-inline-editor');
  if (!overlayEl || !hitAreaEl || !boxEl) return;

  updateScopeButtons();

  if (inlineEditorEl) {
    // Live keystrokes with history OFF; endInlineEdit commits the finished
    // text as one undo step.
    inlineEditorEl.addEventListener('input', () => {
      if (inlineEditingId) {
        updateTextElement(inlineEditingId, { text: inlineEditorEl.value }, { recordHistory: false });
      }
    });
    inlineEditorEl.addEventListener('blur', () => endInlineEdit(true));
    inlineEditorEl.addEventListener('keydown', (e) => {
      // Escape leaves without committing; the live writes are already in
      // state, so "cancel" here just means "stop editing" — Undo is the way
      // back, exactly as it is for every other edit.
      if (e.key === 'Escape') { e.stopPropagation(); endInlineEdit(true); return; }
      // Enter finishes; Shift+Enter is a real newline, since a text overlay
      // can legitimately be more than one line.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); endInlineEdit(true); return; }
      // Every other key (Backspace included) belongs to the field. Stopping
      // propagation keeps the timeline's own Delete/Backspace shortcut from
      // seeing it at all.
      e.stopPropagation();
    });
    // The overlay's own pointer handlers would otherwise start a drag or
    // deselect the element the moment the user clicks to place a caret.
    inlineEditorEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Double-click a text overlay to edit it in place.
  hitAreaEl.addEventListener('dblclick', (e) => {
    const hit = findTextElementAtClient(e.clientX, e.clientY);
    if (hit) startInlineEdit(hit.id);
  });
  boxEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.caption-transform-handle') || e.target.closest('.caption-transform-toolbar')) return;
    if (selectedTextElementId) startInlineEdit(selectedTextElementId);
  });

  // The overlay is `position: fixed` (see style.css's doc comment on
  // .caption-transform-overlay) precisely so .phone-frame's overflow:hidden
  // can't clip its handles — but that means its own left/top/width/height
  // need to be kept in sync with the real content rect explicitly (a
  // `fixed` element has no "100% of my parent" shorthand). tick()'s own
  // per-frame updateCanvasTransformOverlay call already re-syncs it
  // constantly while anything is selected/active; this additional resize
  // listener is only for the OTHERWISE-static case — the overlay staying
  // positioned correctly for a NEW selection made right after a resize,
  // before any tick has run again.
  window.addEventListener('resize', () => syncOverlayToContentRect(overlayEl));

  hitAreaEl.addEventListener('pointerdown', (e) => {
    // TEXT ELEMENTS FIRST, and before the currentBox guard. They render on
    // their own layer ABOVE the caption canvas, so a click that lands on
    // one must resolve to it rather than to whatever caption happens to be
    // underneath — and they exist independently of the transcript, so a
    // click on one must work on frames where there's no caption at all.
    // A press that lands while the inline editor is open is the user
    // clicking AWAY from it — finish that edit first, then treat the press
    // normally.
    if (inlineEditingId) endInlineEdit(true);

    const textHit = findTextElementAtClient(e.clientX, e.clientY);
    if (textHit) {
      deselectVideoTarget();
      if (selectedTextElementId !== textHit.id) selectTextElementTarget(textHit.id);
      boxEl.hidden = false;
      positionBoxElement();
      updateScopeButtons();
      // Move on THIS press rather than only selecting — same reason the
      // caption branch below does it: press-hold-drag has to work on the
      // first gesture, not only after a select-then-press-again.
      beginTextMove(e);
      return;
    }
    // Clicked away from every text element — release the text selection
    // before the caption logic below claims the click.
    clearTextElementSelection();

    if (!currentBox) {
      selected = false;
      boxEl.hidden = true;
      return;
    }
    // A canvas selection and the Video target (see videoTransform.js) are
    // mutually exclusive — the timeline panel's property lanes always show
    // exactly ONE target. Interacting with a caption/word here always wins.
    deselectVideoTarget();
    const { x, y } = clientToCssPoint(e.clientX, e.clientY);
    const scale = currentBox.cssPxScale || 1;

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

    // "Group Words" mode — same toggle-membership pattern as "Select
    // Keywords" above, but ANY word qualifies (no isKeyword gate): keyword
    // status must never determine group membership (see this feature's own
    // requirement).
    if (isSelectingGroup) {
      if (word) {
        if (!groupMultiSelection) groupMultiSelection = new Set();
        if (groupMultiSelection.has(word.wordIndex)) groupMultiSelection.delete(word.wordIndex);
        else groupMultiSelection.add(word.wordIndex);
        renderGroupMultiSelectMarkers();
        updateScopeButtons();
      }
      return;
    }

    if (word) {
      // TWO-STEP SELECTION, now group-membership-aware: a word hit doesn't
      // jump straight to word-level selection — it only drills in if the
      // GROUP this word currently belongs to (its default caption group, or
      // a custom group from the explicit grouping flow — see
      // getEffectiveGroupId) is ALREADY the one on screen, or if this exact
      // word is already the one selected (keeps a drag/re-click on it
      // working as before). A word with NO group at all (explicitly
      // detached/standalone, effective group id `null` — see endDrag) has
      // no wider group to represent, so a first click selects it directly
      // instead of forcing a redundant intermediate "group of one" step.
      // Keyword vs. normal status never factors into any of this — see this
      // file's top doc comment.
      const wordGroupId = getEffectiveGroupId(word.wordIndex, currentBox.phrase);
      const alreadyThisWordSelected = selectedWordIndex === word.wordIndex;
      const alreadyShowingWordsGroup = selected && selectedWordIndex == null &&
        wordGroupId != null && selectedGroupId === wordGroupId;

      if (alreadyThisWordSelected) {
        // Already this exact word's selection — unchanged existing behavior.
        boxEl.hidden = false;
        positionBoxElement();
        updateScopeButtons();
        beginMove(e);
        return;
      }

      if (wordGroupId == null || alreadyShowingWordsGroup) {
        // Standalone word (drill in immediately), or a second click within
        // the already-selected group (drill in) — both land on selecting
        // THIS word specifically.
        resetKeywordScopeState();
        selected = true;
        selectedWordIndex = word.wordIndex;
        selectedGroupId = null;
        syncExplicitCaptionPin();
        boxEl.hidden = false;
        positionBoxElement();
        updateScopeButtons();
        beginMove(e);
        return;
      }

      // First click on a word belonging to a group not yet on screen —
      // select that whole group first, exactly like clicking the caption's
      // padding does below. If that group turns out to be the phrase's own
      // untouched default group (the common case), this pins it exactly like
      // a click on the caption's padding would — see syncExplicitCaptionPin's
      // doc comment for why a word click and a padding click must agree.
      if (selectedWordIndex != null) resetKeywordScopeState();
      selected = true;
      selectedWordIndex = null;
      selectedGroupId = wordGroupId;
      syncExplicitCaptionPin();
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
      // caption's overall padding area — this is CURRENT CAPTION selection:
      // the caption's plain default group, on screen right now, as a unit.
      if (selectedWordIndex != null) resetKeywordScopeState();
      selected = true;
      selectedWordIndex = null;
      selectedGroupId = currentBox.phrase ? getPhraseTransformKey(currentBox.phrase) : null;
      // A genuine, deliberate click on the whole caption — pin it as the
      // keyframe target (see explicitCaptionSelectionKey's doc comment)
      // regardless of where the playhead wanders afterward.
      syncExplicitCaptionPin();
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
      selectedGroupId = null;
      explicitCaptionSelectionKey = null;
      resetKeywordScopeState();
      boxEl.hidden = true;
    }
  });

  boxEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.caption-transform-handle') || e.target.closest('.caption-transform-toolbar')) return;

    // A selected text element's box sits on top of hitAreaEl, so this is
    // where its own re-drag starts. No drill-in step: a text element has no
    // words to descend into.
    if (selectedTextElementId) { beginTextMove(e); return; }

    // While a GROUP is selected (selectedWordIndex null), this box spans the
    // whole group, so it's what actually receives a click meant to drill
    // into one specific word (see hitTestWordAtClient's doc comment above).
    // Once a word IS selected this box shrinks to just that word's own
    // bounds (see getDisplayBox), so any other word is already outside it
    // and reaches hitAreaEl underneath directly — no special-casing needed
    // there.
    if (selectedWordIndex == null && selectedGroupId != null) {
      const word = hitTestWordAtClient(e.clientX, e.clientY);
      if (word) {
        const wordGroupId = getEffectiveGroupId(word.wordIndex, currentBox.phrase);
        resetKeywordScopeState();
        if (wordGroupId === selectedGroupId) {
          // Second click within the currently-shown group — drill into it.
          selectedWordIndex = word.wordIndex;
          selectedGroupId = null;
        } else if (wordGroupId == null) {
          // Rare overlap: a standalone word's box happens to sit under this
          // group's box — select it directly, same as hitAreaEl would.
          selectedWordIndex = word.wordIndex;
          selectedGroupId = null;
        } else {
          // Rare overlap: a DIFFERENT group's word sits under this box —
          // treat as a fresh first click on that other group.
          selectedWordIndex = null;
          selectedGroupId = wordGroupId;
        }
        // Re-derive the pin from whatever the three branches above just
        // settled on (see syncExplicitCaptionPin's doc comment) rather than
        // assuming every drill-in leaves the whole caption.
        syncExplicitCaptionPin();
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
      if (selectedTextElementId) beginTextResize(e, handle.dataset.handle);
      else beginResize(e, handle.dataset.handle);
    });
  });

  if (rotateHandleEl) {
    rotateHandleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (selectedTextElementId) beginTextRotate(e);
      else beginRotate(e);
    });
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (selected || isSelectingGroup)) {
      selected = false;
      selectedWordIndex = null;
      selectedGroupId = null;
      explicitCaptionSelectionKey = null;
      clearTextElementSelection();
      resetKeywordScopeState();
      if (isSelectingGroup) finishGroupSelection(false);
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
  if (keywordToggleBtn) {
    keywordToggleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    keywordToggleBtn.addEventListener('click', () => {
      if (selectedWordIndex == null) return;
      setWordKeyword(selectedWordIndex, !isKeywordIndex(selectedWordIndex));
      updateScopeButtons();
    });
  }
  if (groupStartBtn) {
    groupStartBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    groupStartBtn.addEventListener('click', () => {
      isSelectingGroup = true;
      groupMultiSelection = new Set();
      renderGroupMultiSelectMarkers();
      updateScopeButtons();
    });
  }
  if (groupConfirmBtn) {
    groupConfirmBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    groupConfirmBtn.addEventListener('click', () => finishGroupSelection(true));
  }
  if (animationTypeSelect) {
    animationTypeSelect.addEventListener('pointerdown', (e) => e.stopPropagation());
    animationTypeSelect.addEventListener('change', (e) => {
      // Duration/easing/intensity still come from the sidebar's existing
      // global controls (this feature's own requirement: reuse the existing
      // engine, don't duplicate its controls) — the canvas only chooses the
      // TYPE and the TARGET/SCOPE; applyAnimationFields decides where these
      // exact same field values actually get written.
      const fields = {
        animationType: e.target.value,
        animationDuration: appState.captionAnimationDuration,
        animationEasing: appState.captionAnimationEasing,
        animationIntensity: appState.captionAnimationIntensity
      };
      applyAnimationFields(fields, { recordHistory: true });
    });
  }
  if (animScopeThisBtn) {
    animScopeThisBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    animScopeThisBtn.addEventListener('click', () => {
      updateState({ animationApplyScope: 'this' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (animScopeSameTypeBtn) {
    animScopeSameTypeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    animScopeSameTypeBtn.addEventListener('click', () => {
      updateState({ animationApplyScope: 'same-type' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (animScopeAllWordsBtn) {
    animScopeAllWordsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    animScopeAllWordsBtn.addEventListener('click', () => {
      updateState({ animationApplyScope: 'all-words' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (animScopeThisCaptionBtn) {
    animScopeThisCaptionBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    animScopeThisCaptionBtn.addEventListener('click', () => {
      updateState({ animationApplyScope: 'this-caption' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (animScopeAllCaptionsBtn) {
    animScopeAllCaptionsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    animScopeAllCaptionsBtn.addEventListener('click', () => {
      updateState({ animationApplyScope: 'all-captions' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
}

/**
 * KEYFRAME TARGET — read model for src/js/components/keyframeEngine.js (the
 * generic target dispatcher the timeline panel talks to — see
 * src/js/components/timelinePanel.js). Reuses the exact same selection
 * classification every other feature in this file already relies on
 * (currentSelectionTarget/isFullPhraseGroup/getGroupMemberIndexes) —
 * keyframes introduce no new selection concept, and no dedicated "select an
 * element to keyframe" step: whatever is already selected on the canvas
 * (word/keyword/caption/group) IS the keyframe target, exactly like a video
 * editor keyframes whatever clip is currently selected. This module knows
 * nothing about the VIDEO target — that's src/js/components/videoTransform.js,
 * dispatched to by keyframeEngine.js alongside this one.
 *
 *   - word/keyword selected -> one wordIndex, keyed via getWordTransformKey.
 *   - whole (untouched) caption selected -> phrase-keyed, via
 *     getPhraseTransformKey — no wordIndexes (a single shared entry list).
 *   - a custom/partial group selected -> fans out to every CURRENT member's
 *     OWN wordIndex/entry list, matching how the existing group-drag feature
 *     already treats members independently (each keeps its own start value).
 *
 * Returns null when nothing is selected — callers (the toolbar's keyframe
 * button, the timeline markers) hide themselves entirely in that case.
 */
export function getKeyframeTarget() {
  if (!selected) return null;
  if (selectedWordIndex != null) {
    return { kind: isKeywordIndex(selectedWordIndex) ? 'keyword' : 'word', wordIndexes: [selectedWordIndex], phrase: currentBox?.phrase || null };
  }
  if (selectedGroupId != null && currentBox) {
    if (isFullPhraseGroup(selectedGroupId)) {
      // Prefer the explicitly-pinned caption over currentBox.phrase — the
      // latter is whatever's on screen THIS tick, which silently drifts to a
      // different caption once the playhead scrubs away (see
      // explicitCaptionSelectionKey's doc comment). Falls back to
      // currentBox.phrase when nothing is pinned (defensive; should always be
      // set together with isFullPhraseGroup returning true via the click
      // handler above, but never trust that invariant blindly here).
      const pinnedPhrase = resolvePhraseByTransformKey(explicitCaptionSelectionKey);
      return { kind: 'caption', wordIndexes: null, phrase: pinnedPhrase || currentBox.phrase };
    }
    const members = getGroupMemberIndexes(selectedGroupId);
    if (!members.length) return null;
    return { kind: 'group', wordIndexes: members, phrase: currentBox.phrase || null };
  }
  return null;
}

/* =========================================================================
 * Per-word STYLE (font / colour / outline / shadow / italic / underline).
 *
 * Deliberately separate from the transform writers above: a transform field
 * can be keyframed and is routed through routeFieldsThroughKeyframes, while
 * a style field is static by design (a font family or a colour has no
 * meaningful value halfway between two keyframes), so it is written as a
 * plain nested `style` object on the SAME per-word override entry. See
 * shared/captionTransform.js's resolveWordStyleOverride for the contract and
 * shared/captionGraphics.js's applyWordStyleOverride for how it's painted.
 * ====================================================================== */

/**
 * The word the per-word style panel should be editing, or null when the
 * current selection isn't a single word. Keywords count: a keyword is still
 * one specific word occurrence, and styling it individually must beat the
 * keyword tier for that one instance.
 *
 * @returns {{wordIndex:number, text:string, isKeyword:boolean, style:object}|null}
 */
export function getSelectedWordStyleTarget() {
  if (!selected || selectedWordIndex == null) return null;
  const sourceWord = (appState.words || [])[selectedWordIndex];
  return {
    wordIndex: selectedWordIndex,
    text: sourceWord ? (sourceWord.word || sourceWord.text || '') : '',
    isKeyword: isKeywordIndex(selectedWordIndex),
    style: (appState.captionTransforms[getWordTransformKey(selectedWordIndex)] || {}).style || {}
  };
}

/**
 * Merges style fields onto one word's override. The merge is NESTED — the
 * generic transform writer does a shallow spread, which would replace the
 * whole style object and silently wipe every other styled property each time
 * a single control moved.
 *
 * A field set to null is DELETED rather than stored, so "inherit" is
 * represented by absence — that's what lets resolveWordStyleOverride report
 * an emptied-out style as "no override at all" and keep the renderers on
 * their original fast paths.
 */
export function applyWordStyleFields(wordIndex, styleFields, { recordHistory = true } = {}) {
  if (wordIndex == null) return;
  const key = getWordTransformKey(wordIndex);
  const existing = appState.captionTransforms[key] || {};
  const nextStyle = { ...(existing.style || {}) };
  Object.entries(styleFields).forEach(([field, value]) => {
    if (value == null) delete nextStyle[field];
    else nextStyle[field] = value;
  });
  const nextEntry = { ...existing, style: nextStyle };
  updateState({ captionTransforms: { ...appState.captionTransforms, [key]: nextEntry } }, { recordHistory });
}

/**
 * Drops a word's style override entirely, returning it to whatever the
 * preset/keyword tier/global controls say — without touching that same
 * word's position/scale/rotation/animation, which live on the same entry.
 */
export function resetWordStyle(wordIndex) {
  if (wordIndex == null) return;
  const key = getWordTransformKey(wordIndex);
  const existing = appState.captionTransforms[key];
  if (!existing || !existing.style) return;
  const { style, ...rest } = existing;
  const nextMap = { ...appState.captionTransforms };
  // An entry that was ONLY a style override is removed outright rather than
  // left behind as an empty object.
  if (Object.keys(rest).length) nextMap[key] = rest;
  else delete nextMap[key];
  updateState({ captionTransforms: nextMap }, { recordHistory: true });
}

// --- Selection change notification (for React surfaces) ---------------------
//
// selectedWordIndex/selectedGroupId are assigned from a dozen different
// handlers, so rather than instrument every assignment (and inevitably miss
// one), the descriptor is diffed once per overlay sync — the same tick that
// already repositions the box and refreshes the scope buttons. One hook, no
// way for a selection change to escape it.
const selectionListeners = [];
let lastSelectionSignature = null;

export function onSelectionChange(cb) {
  selectionListeners.push(cb);
  return () => {
    const idx = selectionListeners.indexOf(cb);
    if (idx !== -1) selectionListeners.splice(idx, 1);
  };
}

function notifySelectionChangedIfNeeded() {
  const target = getKeyframeTarget();
  const signature = target ? `${target.kind}:${(target.wordIndexes || []).join(',')}` : 'none';
  if (signature === lastSelectionSignature) return;
  lastSelectionSignature = signature;
  selectionListeners.forEach((cb) => {
    try { cb(); } catch (err) { console.error('[canvasTransform] selection listener failed:', err); }
  });
}

const WORD_STATIC_FIELD_BY_PROPERTY = { positionX: 'offsetXPx', positionY: 'offsetYPx', rotation: 'rotationDeg', scale: 'fontScale', opacity: 'opacity' };
const PHRASE_STATIC_FIELD_BY_PROPERTY = { positionX: 'customPosX', positionY: 'customPosY', rotation: 'rotation', scale: 'captionScaleMultiplier', opacity: 'opacity' };
const KEYFRAME_PROPERTY_DEFAULTS = { positionX: 0, positionY: 0, rotation: 0, scale: 1, opacity: 100 };

/**
 * Every per-target override object a keyframe read/write should touch, for
 * the current selection (see getKeyframeTarget). `readCurrentValue(property)`
 * resolves the value that property CURRENTLY has — the live keyframe-
 * interpolated value at the current playhead when it's been keyframed
 * (same math shared/keyframes.js's evaluatePropertyAtTime feeds the
 * renderer), otherwise the plain effective static value (today's existing
 * effectiveValue/effectiveWordValue fallback chain) — this is what the
 * toolbar's keyframe button snapshots when it creates/updates an entry.
 */
function getKeyframeOverrideEntries(target) {
  if (!target) return [];
  const time = getPlayheadTime();

  if (target.wordIndexes) {
    return target.wordIndexes.map((wordIndex) => {
      const key = getWordTransformKey(wordIndex);
      return {
        key,
        readCurrentValue: (property) => {
          const list = appState.captionTransforms[key]?.keyframes;
          const kfValue = evaluatePropertyAtTime(list, property, time);
          if (kfValue !== undefined) return kfValue;
          return effectiveWordValue(wordIndex, WORD_STATIC_FIELD_BY_PROPERTY[property], KEYFRAME_PROPERTY_DEFAULTS[property]);
        }
      };
    });
  }
  if (target.phrase) {
    const key = getPhraseTransformKey(target.phrase);
    return [{
      key,
      readCurrentValue: (property) => {
        const list = appState.captionTransforms[key]?.keyframes;
        const kfValue = evaluatePropertyAtTime(list, property, time);
        if (kfValue !== undefined) return kfValue;
        const field = PHRASE_STATIC_FIELD_BY_PROPERTY[property];
        const override = appState.captionTransforms[key];
        const staticValue = override && override[field] != null ? override[field] : KEYFRAME_PROPERTY_DEFAULTS[property];
        return effectiveValue(target.phrase, field, staticValue);
      }
    }];
  }
  return [];
}

/**
 * THE keyframe control — one action, exactly like a video editor's clip-level
 * "add keyframe" diamond: captures EVERY animatable property's current
 * value (position/scale/rotation/opacity) into ONE keyframe entry at the
 * current playhead time, for whatever is currently selected. If an entry
 * already exists there, its values are updated in place rather than
 * duplicated (see shared/keyframes.js's upsertKeyframeEntry). This is the
 * ONLY way a target starts being keyframed — from this point on, ordinary
 * edits (drag/resize/rotate on canvas) auto-key the touched property at
 * wherever the playhead currently is (see routeFieldsThroughKeyframes),
 * without needing this button again — pressing it a second time elsewhere
 * just re-anchors a full snapshot there too, which is harmless and
 * sometimes exactly what's wanted (e.g. re-asserting "still centered" at a
 * new time before nudging just one property).
 */
export function addOrUpdateKeyframeAtPlayhead() {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return;
  const time = getPlayheadTime();

  let nextTransforms = appState.captionTransforms;
  entries.forEach(({ key, readCurrentValue }) => {
    const existing = nextTransforms[key] || {};
    const valuesPatch = {};
    KEYFRAME_PROPERTIES.forEach((property) => { valuesPatch[property] = readCurrentValue(property); });
    const nextKeyframes = upsertKeyframeEntry(existing.keyframes, time, valuesPatch);
    nextTransforms = { ...nextTransforms, [key]: { ...existing, keyframes: nextKeyframes } };
  });
  updateState({ captionTransforms: nextTransforms }, { recordHistory: true });
}

/** Whether a keyframe entry (any properties) exists at the current playhead time, for the current selection — drives the toolbar button's filled/hollow diamond. First entry wins when a group fans out to several (they're expected to move together). */
export function hasKeyframeAtPlayhead() {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return false;
  const list = appState.captionTransforms[entries[0].key]?.keyframes;
  return !!findKeyframeEntryNear(list, getPlayheadTime());
}

/** Whether the current selection has ANY keyframes at all (any property, any time) — drives whether the timeline marker row/legend shows up at all. */
export function currentSelectionHasKeyframes() {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  return entries.some(({ key }) => {
    const list = appState.captionTransforms[key]?.keyframes;
    return Array.isArray(list) && list.length > 0;
  });
}

/**
 * The current resolved (static-or-keyframed) value for `property`, for the
 * current selection — backs the small supporting Opacity control in the
 * on-canvas toolbar (opacity has no drag/resize/rotate gesture of its own
 * to "just edit normally", so it keeps a minimal direct control — see
 * setPropertyValueForCurrentSelection).
 */
export function getCurrentValueForProperty(property) {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return KEYFRAME_PROPERTY_DEFAULTS[property];
  return entries[0].readCurrentValue(property);
}

/**
 * Writes a new value for ONE property on the current selection — used only
 * by the toolbar's small Opacity control (see PreviewStage.jsx), since
 * opacity has no on-canvas drag gesture the way position/scale/rotation do.
 * Dispatches through the SAME writePhraseFields/applyWordTransformFields
 * paths every other on-canvas edit already uses, so undo/redo and the
 * auto-keying in routeFieldsThroughKeyframes apply identically here — once
 * opacity has been keyframed (via addOrUpdateKeyframeAtPlayhead), moving
 * this slider auto-keys at the current playhead instead of overwriting a
 * single static value, exactly like a canvas drag would for position.
 */
export function setPropertyValueForCurrentSelection(property, value) {
  const target = getKeyframeTarget();
  if (!target) return;
  if (target.kind === 'caption') {
    const field = PHRASE_STATIC_FIELD_BY_PROPERTY[property];
    writePhraseFields(target.phrase, { [field]: value }, { recordHistory: true });
    return;
  }
  // applyWordTransformFields directly, NOT writeWordFields — a keyframe
  // write always targets only the exact selected word(s)/group members (see
  // getKeyframeTarget's own doc comment on this scope decision), so a
  // keyword's own keywordApplyScope ('all'/'select' fan-out) must NOT apply
  // here the way it does for an ordinary on-canvas drag.
  const field = WORD_STATIC_FIELD_BY_PROPERTY[property];
  (target.wordIndexes || []).forEach((wordIndex) => {
    applyWordTransformFields(wordIndex, { [field]: value }, { recordHistory: true });
  });
}

/** Every keyframe entry's timestamp for the current selection — backs the timeline panel's lane markers (see src/js/components/timelinePanel.js, via keyframeEngine.js). One marker per entry, matching how it was created (see addOrUpdateKeyframeAtPlayhead) — not one per property. */
export function getKeyframeTimestampsForCurrentSelection() {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  const times = new Set();
  entries.forEach(({ key }) => {
    (appState.captionTransforms[key]?.keyframes || []).forEach((k) => times.add(k.t));
  });
  return Array.from(times).sort((a, b) => a - b);
}

/**
 * The raw keyframe entries (`{t, easing, values}[]`) for the current
 * selection — unlike getKeyframeTimestampsForCurrentSelection, this exposes
 * WHICH properties each entry actually defines, so the timeline panel can
 * show a marker on only the relevant property lane(s) (Position/Scale/
 * Rotation/Opacity) instead of every lane. First entry's list wins when a
 * group fans out to several targets (they're expected to move together,
 * same convention as hasKeyframeAtPlayhead).
 */
export function getKeyframeEntriesForCurrentSelection() {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return [];
  return appState.captionTransforms[entries[0].key]?.keyframes || [];
}

/** Deletes the whole keyframe entry (every property it holds) at ~`time`, for the current selection — the timeline marker's delete affordance. */
export function deleteAllKeyframesAt(time) {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return;

  let nextTransforms = appState.captionTransforms;
  entries.forEach(({ key }) => {
    const existing = nextTransforms[key];
    if (!existing?.keyframes) return;
    const nextKeyframes = removeKeyframeEntry(existing.keyframes, time);
    if (nextKeyframes !== existing.keyframes) {
      nextTransforms = { ...nextTransforms, [key]: { ...existing, keyframes: nextKeyframes } };
    }
  });
  if (nextTransforms !== appState.captionTransforms) {
    updateState({ captionTransforms: nextTransforms }, { recordHistory: true });
  }
}

/** Moves the whole keyframe entry at ~`oldTime` to `newTime`, for the current selection — the timeline marker's drag-to-retime affordance. */
export function moveAllKeyframesAt(oldTime, newTime) {
  const target = getKeyframeTarget();
  const entries = getKeyframeOverrideEntries(target);
  if (!entries.length) return;

  let nextTransforms = appState.captionTransforms;
  entries.forEach(({ key }) => {
    const existing = nextTransforms[key];
    if (!existing?.keyframes) return;
    const nextKeyframes = moveKeyframeEntry(existing.keyframes, oldTime, newTime);
    if (nextKeyframes !== existing.keyframes) {
      nextTransforms = { ...nextTransforms, [key]: { ...existing, keyframes: nextKeyframes } };
    }
  });
  if (nextTransforms !== appState.captionTransforms) {
    updateState({ captionTransforms: nextTransforms }, { recordHistory: true });
  }
}

/**
 * Clears any active canvas selection (word/keyword/caption/group) — called
 * by src/js/components/timelinePanel.js when the user picks the "Video"
 * target chip, so the Video target and a canvas selection stay mutually
 * exclusive (see videoTransform.js's deselectVideoTarget, called the other
 * direction from this module's hitAreaEl pointerdown handler above).
 */
export function deselectCanvasSelection() {
  if (!selected && !isSelectingGroup) return;
  selected = false;
  selectedWordIndex = null;
  selectedGroupId = null;
  explicitCaptionSelectionKey = null;
  clearTextElementSelection();
  resetKeywordScopeState();
  if (isSelectingGroup) finishGroupSelection(false);
  if (boxEl) boxEl.hidden = true;
}
