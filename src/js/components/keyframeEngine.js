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
 * Today there are three real target families, each already fully built:
 *  - src/js/components/canvasTransform.js — caption/word/keyword/group,
 *    selected by clicking on the canvas.
 *  - src/js/components/videoTransform.js — the video itself, selected via
 *    the timeline panel's persistent "Video" chip.
 *  - src/js/components/textElements.js — a manual caption / text overlay
 *    (shared/textElement.js), selected by clicking it on the canvas, on its
 *    timeline clip, or in the Overlay panel's list. This was the first
 *    target added through the seam described above, and needed no change to
 *    shared/keyframes.js or to the timeline UI beyond one label.
 * The selections are mutually exclusive (each module deselects the others on
 * its own selection — see their own doc comments).
 */
import { appState } from '../state.js';
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
import {
  isTextTargetSelected,
  addOrUpdateTextElementKeyframeAtPlayhead,
  hasTextElementKeyframeAtPlayhead,
  currentTextElementHasKeyframes,
  getCurrentTextElementValue,
  setTextElementValue,
  getTextElementKeyframeTimestamps,
  getTextElementKeyframeEntries,
  deleteTextElementKeyframeAt,
  moveTextElementKeyframeAt
} from './textElements.js';

const CAPTION_KIND_LABELS = { word: 'Word', keyword: 'Keyword', caption: 'Caption', group: 'Group' };

/**
 * The single active target, resolved fresh on every call (cheap — both
 * underlying modules just read module-level state) — no caching, so it's
 * always correct after either module's own selection changes.
 * @returns {{kind:string, label:string}|null}
 */
export function getActiveTarget() {
  if (isVideoTargetSelected()) return { kind: 'video', label: 'Video' };
  // Checked before the canvas target: selecting a text element zeroes the
  // caption-side selection (canvasTransform.js's selectTextElementTarget),
  // so getCanvasKeyframeTarget already returns null here — this branch is
  // what gives the selection a target of its own rather than none at all.
  if (isTextTargetSelected()) return { kind: 'text', label: 'Text' };
  const canvasTarget = getCanvasKeyframeTarget();
  if (!canvasTarget) return null;
  return { kind: canvasTarget.kind, label: CAPTION_KIND_LABELS[canvasTarget.kind] || 'Selection' };
}

/**
 * WHAT the active target's keyframes belong to on the timeline, so the
 * timeline can draw them on that object's own clip rather than on the video
 * strip: the video, a text element (by id), or a transcript caption (by the
 * phrase it is in, and — for a word, keyword or group — its word indexes).
 * @returns {{kind:'video'}|{kind:'text', id:string}|{kind:'caption', phrase:object|null, wordIndexes:number[]|null}|null}
 */
export function getActiveTargetHost() {
  if (isVideoTargetSelected()) return { kind: 'video' };
  if (isTextTargetSelected()) return { kind: 'text', id: appState.selectedTextElementId };
  const canvasTarget = getCanvasKeyframeTarget();
  if (!canvasTarget) return null;
  return { kind: 'caption', phrase: canvasTarget.phrase || null, wordIndexes: canvasTarget.wordIndexes || null };
}

export function selectVideoTarget() {
  selectVideo();
  deselectCanvasSelection();
}

export { isVideoTargetSelected, onVideoTargetChange };

export function addOrUpdateKeyframeAtPlayhead() {
  if (isVideoTargetSelected()) addOrUpdateVideoKeyframeAtPlayhead();
  else if (isTextTargetSelected()) addOrUpdateTextElementKeyframeAtPlayhead();
  else addOrUpdateCanvasKeyframeAtPlayhead();
}

/**
 * The keyframe button, CapCut-style: on a keyframe it REMOVES it; anywhere
 * else it adds one. Pressing it twice without moving the playhead undoes the
 * first press.
 */
export function toggleKeyframeAtPlayhead() {
  if (!hasKeyframeAtPlayhead()) {
    addOrUpdateKeyframeAtPlayhead();
    return;
  }
  const t = document.getElementById('preview-video')?.currentTime ?? 0;
  const entries = getKeyframeEntries();
  const nearest = entries.reduce((best, k) => (best == null || Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best), null);
  if (nearest) deleteKeyframeAt(nearest.t);
}

export function hasKeyframeAtPlayhead() {
  if (isVideoTargetSelected()) return hasVideoKeyframeAtPlayhead();
  if (isTextTargetSelected()) return hasTextElementKeyframeAtPlayhead();
  return hasCanvasKeyframeAtPlayhead();
}

export function activeTargetHasKeyframes() {
  if (isVideoTargetSelected()) return currentVideoHasKeyframes();
  if (isTextTargetSelected()) return currentTextElementHasKeyframes();
  return canvasSelectionHasKeyframes();
}

export function getCurrentValue(property) {
  if (isVideoTargetSelected()) return getCurrentVideoValue(property);
  if (isTextTargetSelected()) return getCurrentTextElementValue(property);
  return getCanvasCurrentValue(property);
}

export function setValue(property, value) {
  if (isVideoTargetSelected()) setVideoValue(property, value);
  else if (isTextTargetSelected()) setTextElementValue(property, value);
  else setCanvasValue(property, value);
}

/** Every keyframe entry's timestamp for the active target, sorted — backs the timeline panel's lane markers. */
export function getKeyframeTimestamps() {
  if (isVideoTargetSelected()) return getVideoKeyframeTimestamps();
  if (isTextTargetSelected()) return getTextElementKeyframeTimestamps();
  return getCanvasKeyframeTimestamps();
}

/** Raw `{t, easing, values}[]` entries for the active target — lets the timeline panel show a marker on only the property lane(s) each entry actually defines. */
export function getKeyframeEntries() {
  if (isVideoTargetSelected()) return getVideoKeyframeEntries();
  if (isTextTargetSelected()) return getTextElementKeyframeEntries();
  return getCanvasKeyframeEntries();
}

export function deleteKeyframeAt(time) {
  if (isVideoTargetSelected()) deleteVideoKeyframeAt(time);
  else if (isTextTargetSelected()) deleteTextElementKeyframeAt(time);
  else deleteCanvasKeyframeAt(time);
}

export function moveKeyframeAt(oldTime, newTime) {
  if (isVideoTargetSelected()) moveVideoKeyframeAt(oldTime, newTime);
  else if (isTextTargetSelected()) moveTextElementKeyframeAt(oldTime, newTime);
  else moveCanvasKeyframeAt(oldTime, newTime);
}
