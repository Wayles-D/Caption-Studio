/**
 * THE one module that mutates appState.textElements — manual caption events
 * and text overlays (see shared/textElement.js for the record shape and why
 * these can't live in the transcript's own `phrases` array).
 *
 * Deliberately shaped like src/js/components/audioTimeline.js, because the
 * problem is the same one: a list of independent, id'd, timed clips that the
 * timeline drags/trims/deletes and that both the preview and the exporter
 * read. Same conventions, for the same reasons:
 *   - every write goes through ONE function per list, which re-sorts and
 *     hands updateState a NEW array reference (updateState compares by
 *     identity, so an in-place mutation is invisible to it);
 *   - `recordHistory: false` during a live drag, `true` on the commit, so a
 *     gesture is one undo step rather than sixty;
 *   - normalize on every write, not just on read.
 */
import { appState, updateState } from '../state.js';
import {
  createTextElement,
  normalizeTextElement,
  MIN_TEXT_ELEMENT_DURATION,
  DEFAULT_TEXT_ELEMENT_DURATION
} from '../../../shared/textElement.js';
import {
  KEYFRAME_PROPERTIES,
  PHRASE_FIELD_TO_PROPERTY,
  routeFieldsThroughKeyframes,
  upsertKeyframeEntry,
  removeKeyframeEntry,
  moveKeyframeEntry,
  findKeyframeEntryNear,
  evaluatePropertyAtTime
} from '../../../shared/keyframes.js';

// Property -> the element style field holding its STATIC (un-keyframed)
// value. Identical to a caption phrase's mapping, which is the point: an
// element is positioned/scaled/rotated in exactly the same units a caption
// is, so the timeline's lanes and ranges apply unchanged.
const STATIC_FIELD_BY_PROPERTY = {
  positionX: 'customPosX', positionY: 'customPosY',
  rotation: 'rotation', scale: 'captionScaleMultiplier', opacity: 'opacity'
};
const KEYFRAME_PROPERTY_DEFAULTS = { positionX: 50, positionY: 50, rotation: 0, scale: 1, opacity: 100 };

/** The playhead — the same `#preview-video` every other part of the editor treats as the single source of time. */
export function getPlayheadTime() {
  return document.getElementById('preview-video')?.currentTime ?? 0;
}

function getVideoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

/** Keeps a clip from being dragged off either end of the timeline. */
function clampToTimeline(time) {
  const duration = getVideoDuration();
  const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(0, time));
}

function writeTextElements(next, recordHistory = true) {
  updateState(
    { textElements: next.slice().sort((a, b) => a.start - b.start) },
    { recordHistory }
  );
}

export function getTextElements() {
  return appState.textElements || [];
}

export function getTextElement(id) {
  return getTextElements().find((el) => el.id === id) || null;
}

/**
 * Creates an element at the playhead (or wherever the caller says).
 *
 * `style` starts EMPTY on purpose — an empty style bag means "inherit the
 * caption look", so a new overlay immediately matches the video the user is
 * already building instead of appearing as unstyled default text. Every key
 * they then change is stored here and wins over the inherited value.
 */
export function addTextElement({ kind = 'overlay', start = getPlayheadTime(), text = '', ...overrides } = {}) {
  const duration = getVideoDuration();
  const clampedStart = clampToTimeline(start);
  // Keep the whole clip on the timeline where possible, rather than letting
  // its tail hang past the end of the video where it can't be grabbed.
  const end = duration > 0
    ? Math.min(duration, clampedStart + DEFAULT_TEXT_ELEMENT_DURATION)
    : clampedStart + DEFAULT_TEXT_ELEMENT_DURATION;

  const { style: overrideStyle, ...restOverrides } = overrides;
  const element = createTextElement({
    kind,
    start: clampedStart,
    end: Math.max(clampedStart + MIN_TEXT_ELEMENT_DURATION, end),
    text,
    ...restOverrides,
    // Placement is seeded explicitly rather than inherited. Inheriting the
    // caption's `position` would drop every new overlay exactly on top of
    // the caption (both at the bottom), where it's indistinguishable from
    // it — and, worse, 'bottom' is an ANCHORED position, so there'd be no
    // customPosX/Y for a drag to write into. Centre + 'manual' puts it
    // somewhere visible and makes it draggable from its very first frame.
    // Everything about how it LOOKS still inherits the caption.
    style: { position: 'manual', customPosX: 50, customPosY: 50, ...(overrideStyle || {}) }
  });
  writeTextElements([...getTextElements(), element]);
  selectTextElement(element.id);
  return element;
}

export function updateTextElement(id, patch, { recordHistory = true } = {}) {
  const elements = getTextElements();
  const idx = elements.findIndex((el) => el.id === id);
  if (idx === -1) return null;
  const next = elements.slice();
  next[idx] = normalizeTextElement({ ...elements[idx], ...patch });
  writeTextElements(next, recordHistory);
  return next[idx];
}

/** Merges style fields; null deletes a key so it goes back to inheriting. */
export function updateTextElementStyle(id, styleFields, { recordHistory = true } = {}) {
  const element = getTextElement(id);
  if (!element) return null;
  const nextStyle = { ...element.style };
  Object.entries(styleFields).forEach(([field, value]) => {
    if (value == null) delete nextStyle[field];
    else nextStyle[field] = value;
  });
  return updateTextElement(id, { style: nextStyle }, { recordHistory });
}

/** Moves the whole clip, preserving its duration. */
export function moveTextElement(id, start, options) {
  const element = getTextElement(id);
  if (!element) return null;
  const duration = element.end - element.start;
  const videoDuration = getVideoDuration();
  const maxStart = videoDuration > 0 ? Math.max(0, videoDuration - duration) : Number.MAX_SAFE_INTEGER;
  const nextStart = Math.min(maxStart, clampToTimeline(start));
  return updateTextElement(id, { start: nextStart, end: nextStart + duration }, options);
}

/**
 * Trims one edge, in timeline time. Unlike an audio clip there is no source
 * media behind this, so trimming the head is a plain start move that does NOT
 * drag the tail with it — the simpler half of audioTimeline's trim.
 */
export function trimTextElement(id, edge, timelineTime, options) {
  const element = getTextElement(id);
  if (!element) return null;
  const t = clampToTimeline(timelineTime);
  if (edge === 'start') {
    return updateTextElement(id, { start: Math.min(t, element.end - MIN_TEXT_ELEMENT_DURATION) }, options);
  }
  return updateTextElement(id, { end: Math.max(t, element.start + MIN_TEXT_ELEMENT_DURATION) }, options);
}

export function setTextElementEnabled(id, enabled) {
  return updateTextElement(id, { enabled: !!enabled });
}

export function removeTextElement(id) {
  const elements = getTextElements();
  const next = elements.filter((el) => el.id !== id);
  if (next.length === elements.length) return;
  writeTextElements(next);
  if (appState.selectedTextElementId === id) selectTextElement(null);
}

// --- Selection (editor UI only — never undo-tracked, never exported) --------

export function selectTextElement(id) {
  if (appState.selectedTextElementId === id) return;
  updateState({ selectedTextElementId: id }, { recordHistory: false });
}

export function getSelectedTextElement() {
  const id = appState.selectedTextElementId;
  return id ? getTextElement(id) : null;
}

export function removeSelectedTextElement() {
  const id = appState.selectedTextElementId;
  if (id) removeTextElement(id);
}

// --- Keyframes -------------------------------------------------------------
//
// The text target's keyframe read/write API, modelled on
// src/js/components/videoTransform.js's — same shape, same shared engine
// (shared/keyframes.js), plugged into the same dispatcher
// (src/js/components/keyframeEngine.js). A text element is simpler than a
// caption: there is no wordIndex fan-out, no scope toggle, no group
// membership, just one element and one keyframe list.
//
// The "override" these functions operate on is the element's own style bag
// plus its keyframe list — deliberately the SAME shape a caption phrase's
// override has (see shared/keyframes.js's PHRASE_FIELD_TO_PROPERTY), which
// is why that field map and every range in the timeline panel are reused
// verbatim rather than duplicated for a second target kind.

function getSelectedId() {
  return appState.selectedTextElementId || null;
}

/** The selected element as a keyframe override: static fields + keyframe list. */
function getOverride(id = getSelectedId()) {
  const element = id ? getTextElement(id) : null;
  if (!element) return null;
  return { ...(element.style || {}), keyframes: element.keyframes || [] };
}

/** True while a text element is the active keyframe target (see keyframeEngine.js). */
export function isTextTargetSelected() {
  return !!getSelectedId() && !!getTextElement(getSelectedId());
}

/**
 * Current resolved (static-or-keyframed) value for `property` at the
 * playhead — what the timeline panel's property inputs display.
 */
export function getCurrentTextElementValue(property) {
  const override = getOverride();
  if (!override) return KEYFRAME_PROPERTY_DEFAULTS[property];
  const kfValue = evaluatePropertyAtTime(override.keyframes, property, getPlayheadTime());
  if (kfValue !== undefined) return kfValue;
  const field = STATIC_FIELD_BY_PROPERTY[property];
  return override[field] != null ? override[field] : KEYFRAME_PROPERTY_DEFAULTS[property];
}

/**
 * Writes one animatable property on the selected element, auto-keying through
 * the same shared primitive captions/words/the video use: once a property has
 * been keyframed, an ordinary edit updates the keyframe AT the playhead
 * rather than silently overwriting the static base underneath the animation.
 */
export function setTextElementValue(property, value, { recordHistory = true } = {}) {
  const id = getSelectedId();
  const element = id ? getTextElement(id) : null;
  if (!element) return;
  const field = STATIC_FIELD_BY_PROPERTY[property];
  const existing = getOverride(id);
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(
    existing, { [field]: value }, PHRASE_FIELD_TO_PROPERTY, getPlayheadTime(), getCurrentTextElementValue
  );
  const patch = { style: { ...(element.style || {}), ...remainingFields } };
  // A position written here is a manual one, for the same reason
  // resolveTextElementParams stamps it on the read side.
  if (remainingFields.customPosX != null || remainingFields.customPosY != null) patch.style.position = 'manual';
  if (nextKeyframes) patch.keyframes = nextKeyframes;
  updateTextElement(id, patch, { recordHistory });
}

/**
 * Several properties in one write — what an on-canvas drag/resize/rotate
 * gesture uses (see canvasTransform.js's text branch), exactly as the video
 * target's own gestures use setVideoValues.
 *
 * Routing a gesture through here rather than writing the style field
 * directly is what makes dragging a KEYFRAMED element update the keyframe at
 * the playhead instead of silently changing the static base underneath the
 * animation — where the edit would appear to do nothing, because the
 * keyframe track wins on the read side.
 */
export function setTextElementValues(valuesByProperty, { recordHistory = true } = {}) {
  const id = getSelectedId();
  const element = id ? getTextElement(id) : null;
  if (!element) return;
  const fields = {};
  Object.entries(valuesByProperty).forEach(([property, value]) => {
    fields[STATIC_FIELD_BY_PROPERTY[property]] = value;
  });
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(
    getOverride(id), fields, PHRASE_FIELD_TO_PROPERTY, getPlayheadTime(), getCurrentTextElementValue
  );
  const patch = { style: { ...(element.style || {}), ...remainingFields } };
  if (remainingFields.customPosX != null || remainingFields.customPosY != null) patch.style.position = 'manual';
  if (nextKeyframes) patch.keyframes = nextKeyframes;
  updateTextElement(id, patch, { recordHistory });
}

/** Snapshots every animatable property's CURRENT value into one entry at the playhead. */
export function addOrUpdateTextElementKeyframeAtPlayhead() {
  const id = getSelectedId();
  const element = id ? getTextElement(id) : null;
  if (!element) return;
  const valuesPatch = {};
  KEYFRAME_PROPERTIES.forEach((property) => { valuesPatch[property] = getCurrentTextElementValue(property); });
  updateTextElement(id, {
    keyframes: upsertKeyframeEntry(element.keyframes, getPlayheadTime(), valuesPatch)
  }, { recordHistory: true });
}

export function hasTextElementKeyframeAtPlayhead() {
  return !!findKeyframeEntryNear(getOverride()?.keyframes, getPlayheadTime());
}

export function currentTextElementHasKeyframes() {
  const list = getOverride()?.keyframes;
  return Array.isArray(list) && list.length > 0;
}

export function getTextElementKeyframeTimestamps() {
  return (getOverride()?.keyframes || []).map((k) => k.t).sort((a, b) => a - b);
}

export function getTextElementKeyframeEntries() {
  return getOverride()?.keyframes || [];
}

export function deleteTextElementKeyframeAt(time) {
  const id = getSelectedId();
  const element = id ? getTextElement(id) : null;
  if (!element) return;
  const next = removeKeyframeEntry(element.keyframes, time);
  if (next !== element.keyframes) updateTextElement(id, { keyframes: next }, { recordHistory: true });
}

export function moveTextElementKeyframeAt(oldTime, newTime) {
  const id = getSelectedId();
  const element = id ? getTextElement(id) : null;
  if (!element) return;
  const next = moveKeyframeEntry(element.keyframes, oldTime, newTime);
  if (next !== element.keyframes) updateTextElement(id, { keyframes: next }, { recordHistory: true });
}
