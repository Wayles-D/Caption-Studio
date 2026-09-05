/**
 * The VIDEO target's keyframe read/write API + live preview application —
 * the video-target counterpart to src/js/components/canvasTransform.js's
 * caption/word/keyword/group API. Much simpler than that module: there is
 * exactly ONE video, so no wordIndex fan-out, no scope toggle, no group
 * membership — just one override object, `appState.videoTransform`.
 *
 * Selection: the video and a canvas caption/word/keyword/group selection are
 * mutually exclusive (see canvasTransform.js's hitAreaEl pointerdown handler,
 * which calls deselectVideoTarget() the moment a caption/word is clicked).
 * `isVideoTargetSelected()`/`onVideoTargetChange` back the "Video" target
 * chip's active state in src/js/components/timelinePanel.js.
 */
import { appState, updateState } from '../state.js';
import {
  VIDEO_FIELD_TO_PROPERTY,
  KEYFRAME_PROPERTIES,
  routeFieldsThroughKeyframes,
  upsertKeyframeEntry,
  removeKeyframeEntry,
  moveKeyframeEntry,
  findKeyframeEntryNear,
  evaluatePropertyAtTime
} from '../../../shared/keyframes.js';
import { resolveVideoTransformAtTime, isIdentityVideoTransform } from '../../../shared/videoTransform.js';

const STATIC_FIELD_BY_PROPERTY = { positionX: 'offsetXPct', positionY: 'offsetYPct', scale: 'scale', rotation: 'rotation', opacity: 'opacity' };
const PROPERTY_DEFAULTS = { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 100 };

function getPlayheadTime() {
  return document.getElementById('preview-video')?.currentTime ?? 0;
}

function getOverride() {
  return appState.videoTransform || {};
}

/** Current resolved (static-or-keyframed) value for `property`, at the current playhead — what the timeline panel's Video property inputs display. */
export function getCurrentVideoValue(property) {
  const time = getPlayheadTime();
  const override = getOverride();
  const kfValue = evaluatePropertyAtTime(override.keyframes, property, time);
  if (kfValue !== undefined) return kfValue;
  const field = STATIC_FIELD_BY_PROPERTY[property];
  return override[field] != null ? override[field] : PROPERTY_DEFAULTS[property];
}

/**
 * Writes one field on the video's transform — the ONLY editing path for the
 * video target (it has no on-canvas drag/resize/rotate gesture the way
 * captions/words do), used by the timeline panel's per-lane numeric inputs.
 * Auto-keys via the SAME shared/keyframes.js primitive captions/words use —
 * once a property has been keyframed, changing it here updates the keyframe
 * at the current playhead instead of the static base value.
 */
export function setVideoValue(property, value, { recordHistory = true } = {}) {
  const field = STATIC_FIELD_BY_PROPERTY[property];
  const existing = getOverride();
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(existing, { [field]: value }, VIDEO_FIELD_TO_PROPERTY, getPlayheadTime());
  const next = { ...existing, ...remainingFields };
  if (nextKeyframes) next.keyframes = nextKeyframes;
  updateState({ videoTransform: next }, { recordHistory });
}

/** Writes several fields at once (e.g. a resize+move gesture that only touches scale, or a combined commit) — same auto-keying/history semantics as setVideoValue, batched into one state write instead of one per property. */
export function setVideoValues(valuesByProperty, { recordHistory = true } = {}) {
  const fields = {};
  Object.entries(valuesByProperty).forEach(([property, value]) => { fields[STATIC_FIELD_BY_PROPERTY[property]] = value; });
  const existing = getOverride();
  const { remainingFields, nextKeyframes } = routeFieldsThroughKeyframes(existing, fields, VIDEO_FIELD_TO_PROPERTY, getPlayheadTime());
  const next = { ...existing, ...remainingFields };
  if (nextKeyframes) next.keyframes = nextKeyframes;
  updateState({ videoTransform: next }, { recordHistory });
}

/** Snapshots every animatable property's CURRENT value into one keyframe entry at the playhead — the video-target counterpart to canvasTransform.js's addOrUpdateKeyframeAtPlayhead, same "one click = one coherent keyframe" model. */
export function addOrUpdateVideoKeyframeAtPlayhead() {
  const existing = getOverride();
  const time = getPlayheadTime();
  const valuesPatch = {};
  KEYFRAME_PROPERTIES.forEach((property) => { valuesPatch[property] = getCurrentVideoValue(property); });
  const nextKeyframes = upsertKeyframeEntry(existing.keyframes, time, valuesPatch);
  updateState({ videoTransform: { ...existing, keyframes: nextKeyframes } }, { recordHistory: true });
}

/** Whether a keyframe entry exists at the current playhead time — drives the timeline panel's "+ Keyframe" button active state. */
export function hasVideoKeyframeAtPlayhead() {
  return !!findKeyframeEntryNear(getOverride().keyframes, getPlayheadTime());
}

/** Whether the video has ANY keyframes at all (any property, any time). */
export function currentVideoHasKeyframes() {
  const list = getOverride().keyframes;
  return Array.isArray(list) && list.length > 0;
}

/** Every keyframe entry's timestamp, sorted — backs the timeline panel's lane markers. */
export function getVideoKeyframeTimestamps() {
  return (getOverride().keyframes || []).map((k) => k.t).sort((a, b) => a - b);
}

/** The raw keyframe entries (`{t, easing, values}[]`) — lets the timeline panel show a marker on only the relevant property lane(s). */
export function getVideoKeyframeEntries() {
  return getOverride().keyframes || [];
}

/** Deletes the whole keyframe entry (every property it holds) at ~`time`. */
export function deleteVideoKeyframeAt(time) {
  const existing = getOverride();
  const nextKeyframes = removeKeyframeEntry(existing.keyframes, time);
  if (nextKeyframes !== existing.keyframes) {
    updateState({ videoTransform: { ...existing, keyframes: nextKeyframes } }, { recordHistory: true });
  }
}

/** Moves the whole keyframe entry at ~`oldTime` to `newTime`. */
export function moveVideoKeyframeAt(oldTime, newTime) {
  const existing = getOverride();
  const nextKeyframes = moveKeyframeEntry(existing.keyframes, oldTime, newTime);
  if (nextKeyframes !== existing.keyframes) {
    updateState({ videoTransform: { ...existing, keyframes: nextKeyframes } }, { recordHistory: true });
  }
}

// --- Selection (mutually exclusive with a canvas caption/word/keyword/group
// selection — see canvasTransform.js's hitAreaEl pointerdown handler) ---
let videoTargetSelected = false;
const listeners = [];

export function selectVideoTarget() {
  if (videoTargetSelected) return;
  videoTargetSelected = true;
  listeners.forEach((cb) => cb());
}

export function deselectVideoTarget() {
  if (!videoTargetSelected) return;
  videoTargetSelected = false;
  listeners.forEach((cb) => cb());
}

export function isVideoTargetSelected() {
  return videoTargetSelected;
}

/** Notified whenever the video target is selected/deselected — the timeline panel resubscribes its property lanes to this. */
export function onVideoTargetChange(cb) {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

// --- Live preview application ---

/**
 * Applies the video's resolved transform at `currentTime` directly as CSS on
 * the `<video>` element — called once per render tick from preview.js,
 * completely independent of whether any caption exists (satisfies "must
 * work even if there are no captions involved"). Purely additive DOM styling
 * on the video element itself; the captions canvas/overlay sit on top and
 * are entirely unaffected (see src/components/PreviewStage.jsx's layering).
 */
export function applyVideoTransformToElement(currentTime) {
  const video = document.getElementById('preview-video');
  if (!video) return;
  const override = appState.videoTransform;
  if (isIdentityVideoTransform(override)) {
    // Common case (no override at all) — leave the element untouched rather
    // than writing a no-op identity transform every frame.
    if (video.style.transform) video.style.transform = '';
    if (video.style.opacity) video.style.opacity = '';
    return;
  }
  const resolved = resolveVideoTransformAtTime(override, currentTime);
  video.style.transform = `translate(${resolved.offsetXPct}%, ${resolved.offsetYPct}%) scale(${resolved.scale}) rotate(${resolved.rotation}deg)`;
  video.style.opacity = String(resolved.opacity / 100);
}
