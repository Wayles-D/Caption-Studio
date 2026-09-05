/**
 * THE generic target dispatcher — the one module src/js/components/
 * timelinePanel.js talks to. Everything about "which kind of target is
 * currently selected" is decided HERE, once; the timeline panel itself
 * knows nothing about captions, words, keywords, groups, or the video —
 * only "the active target has these keyframe entries, this current value
 * per property, add/delete/move keyframe."
 *
 * This is the extensibility seam: a future target type (image, shape,
 * sticker, audio) plugs in as one more branch here, reusing the SAME
 * shared/keyframes.js engine every existing branch already uses — the
 * timeline UI and the engine itself never need to change.
 *
 * Today there are two real target families, each already fully built:
 *  - src/js/components/canvasTransform.js — caption/word/keyword/group,
 *    selected by clicking on the canvas.
 *  - src/js/components/videoTransform.js — the video itself, selected via
 *    the timeline panel's persistent "Video" chip.
 * The two selections are mutually exclusive (each module deselects the
 * other on its own selection — see their own doc comments).
 */
import {
  getKeyframeTarget as getCanvasKeyframeTarget,
  addOrUpdateKeyframeAtPlayhead as addOrUpdateCanvasKeyframeAtPlayhead,
  hasKeyframeAtPlayhead as hasCanvasKeyframeAtPlayhead,
  currentSelectionHasKeyframes as canvasSelectionHasKeyframes,
  getCurrentValueForProperty as getCanvasCurrentValue,
  setPropertyValueForCurrentSelection as setCanvasValue,
  getKeyframeTimestampsForCurrentSelection as getCanvasKeyframeTimestamps,
  getKeyframeEntriesForCurrentSelection as getCanvasKeyframeEntries,
  deleteAllKeyframesAt as deleteCanvasKeyframeAt,
  moveAllKeyframesAt as moveCanvasKeyframeAt,
  deselectCanvasSelection
} from './canvasTransform.js';
import {
  isVideoTargetSelected,
  selectVideoTarget as selectVideo,
  onVideoTargetChange,
  addOrUpdateVideoKeyframeAtPlayhead,
  hasVideoKeyframeAtPlayhead,
  currentVideoHasKeyframes,
  getCurrentVideoValue,
  setVideoValue,
  getVideoKeyframeTimestamps,
  getVideoKeyframeEntries,
  deleteVideoKeyframeAt,
  moveVideoKeyframeAt
} from './videoTransform.js';

const CAPTION_KIND_LABELS = { word: 'Word', keyword: 'Keyword', caption: 'Caption', group: 'Group' };

/**
 * The single active target, resolved fresh on every call (cheap — both
 * underlying modules just read module-level state) — no caching, so it's
 * always correct after either module's own selection changes.
 * @returns {{kind:string, label:string}|null}
 */
export function getActiveTarget() {
  if (isVideoTargetSelected()) return { kind: 'video', label: 'Video' };
  const canvasTarget = getCanvasKeyframeTarget();
  if (!canvasTarget) return null;
  return { kind: canvasTarget.kind, label: CAPTION_KIND_LABELS[canvasTarget.kind] || 'Selection' };
}

export function selectVideoTarget() {
  selectVideo();
  deselectCanvasSelection();
}

export { isVideoTargetSelected, onVideoTargetChange };

export function addOrUpdateKeyframeAtPlayhead() {
  if (isVideoTargetSelected()) addOrUpdateVideoKeyframeAtPlayhead();
  else addOrUpdateCanvasKeyframeAtPlayhead();
}

export function hasKeyframeAtPlayhead() {
  return isVideoTargetSelected() ? hasVideoKeyframeAtPlayhead() : hasCanvasKeyframeAtPlayhead();
}

export function activeTargetHasKeyframes() {
  return isVideoTargetSelected() ? currentVideoHasKeyframes() : canvasSelectionHasKeyframes();
}

export function getCurrentValue(property) {
  return isVideoTargetSelected() ? getCurrentVideoValue(property) : getCanvasCurrentValue(property);
}

export function setValue(property, value) {
  if (isVideoTargetSelected()) setVideoValue(property, value);
  else setCanvasValue(property, value);
}

/** Every keyframe entry's timestamp for the active target, sorted — backs the timeline panel's lane markers. */
export function getKeyframeTimestamps() {
  return isVideoTargetSelected() ? getVideoKeyframeTimestamps() : getCanvasKeyframeTimestamps();
}

/** Raw `{t, easing, values}[]` entries for the active target — lets the timeline panel show a marker on only the property lane(s) each entry actually defines. */
export function getKeyframeEntries() {
  return isVideoTargetSelected() ? getVideoKeyframeEntries() : getCanvasKeyframeEntries();
}

export function deleteKeyframeAt(time) {
  if (isVideoTargetSelected()) deleteVideoKeyframeAt(time);
  else deleteCanvasKeyframeAt(time);
}

export function moveKeyframeAt(oldTime, newTime) {
  if (isVideoTargetSelected()) moveVideoKeyframeAt(oldTime, newTime);
  else moveCanvasKeyframeAt(oldTime, newTime);
}
