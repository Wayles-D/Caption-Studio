/**
 * THE COMPOSITION in the editor — the canvas's shape and background, and the
 * video's styling and placement inside it (shared/composition.js). Every write
 * goes through updateState, so each is one undo step and is saved with the
 * project (src/store/compositionStore.js). Placement goes through
 * videoTransform.js, the video's one transform path — so once the video is
 * keyframed, a change here keys at the playhead exactly as the on-video drag
 * and the timeline's fields do.
 */
import { appState, updateState } from '../state.js';
import { normalizeComposition, normalizeVideoStyle, ASPECT_RATIOS } from '../../../shared/composition.js';
import { getCurrentVideoValue, setVideoValues } from './videoTransform.js';
import { getVideoBoxFraction } from './compositionView.js';

export function getCompositionSettings() {
  return normalizeComposition(appState.composition);
}

export function getVideoStyle() {
  return normalizeVideoStyle(appState.videoStyle);
}

export function setAspectRatio(aspectRatio) {
  if (!Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, aspectRatio)) return;
  const current = getCompositionSettings();
  if (current.aspectRatio === aspectRatio) return;
  updateState({ composition: { ...current, aspectRatio } }, { recordHistory: true });
}

export function setBackgroundColor(color, { recordHistory = true } = {}) {
  const current = getCompositionSettings();
  updateState({ composition: normalizeComposition({ ...current, background: { ...current.background, color } }) }, { recordHistory });
}

/** Merges into the video's styling: 'cornerRadius' at the top level, or the 'border' / 'shadow' group. */
export function patchVideoStyle(group, fields, { recordHistory = true } = {}) {
  const current = getVideoStyle();
  const next = group === 'border' || group === 'shadow'
    ? { ...current, [group]: { ...current[group], ...fields } }
    : { ...current, ...fields };
  updateState({ videoStyle: normalizeVideoStyle(next) }, { recordHistory });
}

/**
 * Snaps the video to a side of the canvas (or its centre) at its current
 * size: its edge on the canvas's edge. Positions are % of the canvas, so the
 * offset is half of whatever room the scaled video leaves.
 */
export function alignVideo(where) {
  const { width: fw, height: fh } = getVideoBoxFraction();
  const scale = getCurrentVideoValue('scale');
  const roomX = ((1 - fw * scale) / 2) * 100;
  const roomY = ((1 - fh * scale) / 2) * 100;
  const x = where === 'left' ? -roomX : where === 'right' ? roomX : where === 'center' ? 0 : getCurrentVideoValue('positionX');
  const y = where === 'top' ? -roomY : where === 'bottom' ? roomY : where === 'center' ? 0 : getCurrentVideoValue('positionY');
  setVideoValues({ positionX: x, positionY: y }, { recordHistory: true });
}

/** The video back to its resting place: whole, centred, upright, undecorated. */
export function resetVideo() {
  // One undo step: the first write records the state before both.
  setVideoValues({ positionX: 0, positionY: 0, scale: 1, rotation: 0 }, { recordHistory: true });
  updateState({ videoStyle: null }, { recordHistory: false });
}
