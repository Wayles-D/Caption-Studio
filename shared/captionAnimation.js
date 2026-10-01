/**
 * Caption entrance animation — a thin facade over the motion system
 * (shared/motion/), kept for the code and tests that speak in its original
 * terms. It holds NO animation maths of its own: every value here comes from
 * shared/motion's presets and evaluator, the same calls the renderer
 * (shared/captionGraphics.js) and the exporter
 * (backend/utils/graphicsFrameGenerator.js) make.
 *
 * Naming note: "animation" here is the entrance of a caption block or word —
 * not the pre-existing karaoke/pop/instant/typewriter word-REVEAL setting,
 * which is called animationMode (see captionConfig.js).
 */
import { listMotionPresets, SLIDE_DISTANCE } from './motion/presets.js';
import { entranceFromParams, evaluateMotion, resolveMotionWindow } from './motion/motion.js';

export { EASING_TYPES, applyEasing } from './motion/easing.js';

/** The entrance choices the editor offers, 'none' first. */
export const ANIMATION_TYPES = ['none', ...listMotionPresets('entrance')];

/** How far a slide travels, in font sizes, at intensity 1. */
export const SLIDE_DISTANCE_EM = SLIDE_DISTANCE;

/**
 * The entrance transform a params bag describes, at `currentTime`, for an
 * element spanning [elementStart, elementEnd) — in the original
 * {alpha, scale, offsetXEm, offsetYEm} shape.
 */
export function getAnimationTransform(params, currentTime, elementStart, elementEnd) {
  const d = evaluateMotion(entranceFromParams(params), currentTime, { start: elementStart, end: elementEnd ?? elementStart });
  return { alpha: d.opacity, scale: d.scale, offsetXEm: d.offsetX, offsetYEm: d.offsetY };
}

/**
 * The window a word's own entrance runs over: from the word's start (or its
 * container's, for 'together'), until the container ends. See
 * shared/motion/motion.js's resolveMotionWindow.
 */
export function resolveWordAnimationWindow(word, container, override) {
  return resolveMotionWindow({ anchor: override?.animationTiming === 'together' ? 'container' : 'self' }, word, container);
}
