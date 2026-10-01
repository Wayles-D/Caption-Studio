/**
 * Easing — the one place a timing curve lives, for every part of the motion
 * system: an entrance's progress (./motion.js) and the interpolation between
 * two keyframes (../keyframes.js) both come through applyEasing.
 *
 * A curve is a function from linear progress t in [0, 1] to eased progress.
 * Curves are looked up by name, so a stored motion or keyframe only ever
 * holds a string — plain, serializable data.
 *
 * Room to grow without touching any caller: a cubic-bezier, spring, bounce
 * or elastic curve is one more registerEasing() call (or, for a
 * parameterised curve, a resolver for an object spec in resolveEasing).
 */

const CURVES = new Map([
  ['linear', (t) => t],
  ['ease-in', (t) => t * t],
  ['ease-out', (t) => 1 - (1 - t) * (1 - t)],
  ['ease-in-out', (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)]
]);

/** The easing names a motion or keyframe may carry, in menu order. */
export const EASING_TYPES = [...CURVES.keys()];

/** What a motion uses when it names none (or an unknown one). */
export const DEFAULT_EASING = 'ease-out';

/** Adds (or replaces) a named curve. `fn` maps [0, 1] to eased progress, with fn(0) = 0 and fn(1) = 1. */
export function registerEasing(name, fn) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') throw new Error('registerEasing: a name and a curve function are required');
  CURVES.set(name, fn);
  if (!EASING_TYPES.includes(name)) EASING_TYPES.push(name);
}

export function isEasing(name) {
  return CURVES.has(name);
}

/** The curve for an easing name — linear for anything unknown. */
export function resolveEasing(spec) {
  return CURVES.get(spec) || CURVES.get('linear');
}

/** Eases progress `t` (clamped to [0, 1]) along the named curve. */
export function applyEasing(t, easing) {
  return resolveEasing(easing)(Math.max(0, Math.min(1, t)));
}
