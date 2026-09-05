/**
 * The VIDEO's own transform — position/scale/rotation/opacity applied to the
 * source video itself, independent of any caption. This is the video-target
 * counterpart to shared/captionTransform.js's resolvePhraseParams/
 * resolveWordOverrideAtTime: a pure "resolve this target's properties at
 * time T" function, built on the SAME generic keyframe engine
 * (shared/keyframes.js) every other target already uses.
 *
 * Called by BOTH:
 *  - src/js/components/videoTransform.js (live preview — applies the result
 *    as a CSS transform on the <video> element every render tick)
 *  - backend/utils/videoTransformFilter.js (export — samples this same
 *    function across the export timeline to build ffmpeg filter
 *    expressions)
 * so preview and export can never independently drift apart — exactly the
 * same guarantee shared/captionAnimation.js's getAnimationTransform already
 * gives entrance animations.
 *
 * Storage shape (appState.videoTransform, src/store/transformStore.js):
 *   { offsetXPct, offsetYPct, scale, rotation, opacity, keyframes: [...] }
 * `keyframes` follows the exact same unified-entry format as every other
 * target's override (see shared/keyframes.js's own doc comment).
 */
import { resolveAnimatableField } from './keyframes.js';

export const VIDEO_TRANSFORM_DEFAULTS = {
  offsetXPct: 0, // % of frame width, translate from center (+right/-left)
  offsetYPct: 0, // % of frame height, translate from center (+down/-up)
  scale: 1,
  rotation: 0, // degrees
  opacity: 100 // 0-100
};

/**
 * Resolves the video's full transform at `currentTime` — keyframed
 * properties interpolate, un-keyframed ones fall back to the static
 * base value (or the default), exactly like every other target.
 * @param {object|undefined} videoTransform - appState.videoTransform.
 * @param {number} currentTime
 * @returns {{offsetXPct:number, offsetYPct:number, scale:number, rotation:number, opacity:number}}
 */
export function resolveVideoTransformAtTime(videoTransform, currentTime) {
  const override = videoTransform || {};
  return {
    offsetXPct: resolveAnimatableField(override, 'positionX', currentTime, override.offsetXPct ?? VIDEO_TRANSFORM_DEFAULTS.offsetXPct),
    offsetYPct: resolveAnimatableField(override, 'positionY', currentTime, override.offsetYPct ?? VIDEO_TRANSFORM_DEFAULTS.offsetYPct),
    scale: resolveAnimatableField(override, 'scale', currentTime, override.scale ?? VIDEO_TRANSFORM_DEFAULTS.scale),
    rotation: resolveAnimatableField(override, 'rotation', currentTime, override.rotation ?? VIDEO_TRANSFORM_DEFAULTS.rotation),
    opacity: resolveAnimatableField(override, 'opacity', currentTime, override.opacity ?? VIDEO_TRANSFORM_DEFAULTS.opacity)
  };
}

/** Whether the video has ANY keyframes at all — export uses this to decide whether the new filter stage is needed at all (byte-identical passthrough when false). */
export function hasAnyVideoKeyframes(videoTransform) {
  return Array.isArray(videoTransform?.keyframes) && videoTransform.keyframes.length > 0;
}

/** Whether the video's transform is the plain identity (no static override, no keyframes) — used to skip the CSS transform entirely in preview for the common case. */
export function isIdentityVideoTransform(videoTransform) {
  if (hasAnyVideoKeyframes(videoTransform)) return false;
  const t = videoTransform || {};
  return (t.offsetXPct ?? 0) === 0 && (t.offsetYPct ?? 0) === 0 && (t.scale ?? 1) === 1 && (t.rotation ?? 0) === 0 && (t.opacity ?? 100) === 100;
}
