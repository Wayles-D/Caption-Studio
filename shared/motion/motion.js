/**
 * The motion model and evaluator — WHEN a motion runs and HOW FAR along it
 * is, for any visual object.
 *
 * A MOTION is plain, serializable data:
 *
 *   {
 *     kind:      'entrance'           (later: 'exit' | 'emphasis' | 'loop')
 *     preset:    'slide-up'           a registered preset id (./presets.js)
 *     duration:  0.25                 seconds
 *     easing:    'ease-out'           a registered easing name (./easing.js)
 *     intensity: 1                    the preset's strength
 *     anchor:    'self' | 'container' where its time starts — see resolveMotionWindow
 *   }
 *
 * The evaluator is object-agnostic: it is given a motion, a time and the
 * WINDOW the motion runs in, and returns a motion delta (./presets.js). It
 * never asks what the object is. What an object contributes is only its
 * window (its own [start, end) and its container's) and, at render time, the
 * length one object unit stands for.
 *
 * Layout is not its business either: the object's renderer lays the object
 * out at rest first, and the delta is applied to that final geometry — so a
 * word sliding in can never push its neighbours (shared/captionGraphics.js).
 *
 * Projects store motions in the fields they always have (a caption's
 * captionAnimation* params, a word override's animation* fields); the
 * adapters below read those into this shape, so there is one project format.
 */
import { getMotionPreset, IDENTITY_DELTA, HIDDEN_DELTA } from './presets.js';
import { applyEasing, isEasing, DEFAULT_EASING } from './easing.js';

export const MOTION_KINDS = ['entrance', 'exit', 'emphasis', 'loop'];

/**
 * The kinds whose TIMING is implemented. Today that is the entrance alone:
 * anchored at its window's start, running for its duration, hidden before it
 * begins (motionProgress / evaluateMotion). An exit needs its window anchored
 * to the END, a loop needs a period, an emphasis its own placement in the
 * object's life — none of which exists yet. A motion of any other kind is
 * therefore INERT (evaluates to no change, is never sampled) rather than
 * silently run with entrance timing; implementing a kind means adding its
 * timing here, beside the entrance's.
 */
const TIMED_KINDS = new Set(['entrance']);

export function isMotionKindTimed(kind) {
  return TIMED_KINDS.has(kind);
}
export const DEFAULT_MOTION_DURATION = 0.25;

/**
 * A complete, safe motion — or null for "no motion" (a missing or 'none'
 * preset, or one that isn't registered). Missing or invalid fields fall
 * back to fixed defaults rather than letting NaN into the draw path.
 */
export function normalizeMotion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const preset = getMotionPreset(raw.preset);
  if (!preset) return null;
  const duration = parseFloat(raw.duration);
  const intensity = parseFloat(raw.intensity);
  return {
    kind: preset.kind,
    preset: preset.id,
    duration: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_MOTION_DURATION,
    easing: isEasing(raw.easing) ? raw.easing : DEFAULT_EASING,
    intensity: Number.isFinite(intensity) && intensity > 0 ? intensity : 1,
    anchor: raw.anchor === 'container' ? 'container' : 'self'
  };
}

// --- Adapters from stored fields -------------------------------------------

/**
 * The entrance a params bag describes: a caption's (global, or "This
 * Caption" merged in by shared/captionTransform.js's resolvePhraseParams),
 * or a text element's (its style bag, see shared/textElement.js's
 * resolveTextElementParams).
 */
export function entranceFromParams(params) {
  if (!params) return null;
  return normalizeMotion({
    preset: params.captionAnimationType,
    duration: params.captionAnimationDuration,
    easing: params.captionAnimationEasing,
    intensity: params.captionAnimationIntensity
  });
}

/**
 * The entrance a single WORD's override describes (captionTransforms['w<n>'],
 * or a text element's wordTransforms). `animationTiming: 'together'` is the
 * stored form of anchor 'container': the word enters with its caption.
 */
export function entranceFromWordOverride(override) {
  if (!override) return null;
  return normalizeMotion({
    preset: override.animationType,
    duration: override.animationDuration,
    easing: override.animationEasing,
    intensity: override.animationIntensity,
    anchor: override.animationTiming === 'together' ? 'container' : 'self'
  });
}

// --- An object's motions -----------------------------------------------------
//
// Every object is evaluated through its LIST of motions — at most one per
// kind (an entrance, later an emphasis and an exit beside it) — never through
// "its entrance" directly. The renderer and the exporter only ever call
// motionsFrom* / evaluateMotions / motionActiveSpans, so giving an object
// a second kind of motion later changes the adapters below and the timing
// above, and nothing that draws or samples.
//
// Storage is unchanged: a caption's, card's or word's entrance stays in the
// fields it has always had, and these adapters read it into the list. A
// future stored list (other kinds) would be read here too, beside them.

/**
 * A clean motion list: normalized motions, at most ONE PER KIND, in
 * MOTION_KINDS order. Kinds never displace each other; a later motion of the
 * same kind replaces the earlier one (as any second write to one slot does).
 */
export function normalizeMotionList(list) {
  const byKind = new Map();
  (Array.isArray(list) ? list : []).forEach((raw) => {
    const motion = normalizeMotion(raw);
    if (motion) byKind.set(motion.kind, motion);
  });
  return MOTION_KINDS.filter((k) => byKind.has(k)).map((k) => byKind.get(k));
}

const NO_MOTIONS = Object.freeze([]);
const listOf = (motion) => (motion ? [motion] : NO_MOTIONS);

/** The motions a params bag gives its object (a caption, or a text element's style). */
export function motionsFromParams(params) {
  return listOf(entranceFromParams(params));
}

/** The motions a single word's override gives it. */
export function motionsFromWordOverride(override) {
  return listOf(entranceFromWordOverride(override));
}

/**
 * All of an object's motions at `time`, as one delta — each in its own
 * window (resolveMotionWindow, from the object's span and its container's),
 * combined with combineMotionDeltas. With one motion this IS evaluateMotion.
 */
export function evaluateMotions(motions, time, own, container = own) {
  if (!motions || !motions.length) return IDENTITY_DELTA;
  if (motions.length === 1) return evaluateMotion(motions[0], time, resolveMotionWindow(motions[0], own, container));
  return motions.reduce((d, motion) => combineMotionDeltas(d, evaluateMotion(motion, time, resolveMotionWindow(motion, own, container))), IDENTITY_DELTA);
}

/** Where any of an object's motions is moving — what the exporter samples densely. */
export function motionActiveSpans(motions, own, container = own) {
  const spans = [];
  (motions || []).forEach((motion) => {
    const span = motionActiveSpan(motion, resolveMotionWindow(motion, own, container));
    if (span) spans.push(span);
  });
  return spans;
}

// --- Timing ------------------------------------------------------------------

/**
 * The window a motion runs in, from the object's own span and its
 * container's (the caption a word sits in; for a whole caption or text
 * element, its own span again):
 *
 *  - it STARTS at the object's own start — or the container's, for a motion
 *    anchored to it ('container': every such word enters as one);
 *  - it may run until the CONTAINER ends: a word stays on screen after it
 *    is said, so a long duration is a slow entrance, not a cut-off one.
 */
export function resolveMotionWindow(motion, own, container = own) {
  const start = motion?.anchor === 'container' && container?.start != null ? container.start : own.start;
  const end = Math.max(start, container?.end ?? own.end ?? start);
  return { start, end };
}

/**
 * Where in `window` the motion is actually moving — [start, start + its
 * duration], cut to the window — or null if it never moves. What the
 * exporter samples densely (backend/utils/graphicsFrameGenerator.js).
 */
export function motionActiveSpan(motion, window) {
  if (!motion || !TIMED_KINDS.has(motion.kind)) return null;
  const end = window.start + Math.min(motion.duration, window.end - window.start);
  return { start: window.start, end };
}

/**
 * Eased progress in [0, 1] at `time`, or -1 before the motion has begun.
 * The duration never outlasts the window: a motion in a window shorter than
 * its duration finishes exactly when the window ends.
 */
export function motionProgress(motion, time, window) {
  const effective = Math.min(motion.duration, Math.max(0, window.end - window.start)) || 0;
  if (effective <= 0) return 1;
  const elapsed = time - window.start;
  if (elapsed < 0) return -1;
  if (elapsed === 0) return 0;
  if (elapsed >= effective) return 1;
  return applyEasing(elapsed / effective, motion.easing);
}

/**
 * THE evaluator: how `motion` changes its object at `time`, as a motion
 * delta (./presets.js). Shared by the preview and the exporter, which is
 * what makes the two agree.
 *
 *  - no motion, or a finished one: IDENTITY_DELTA (the object at rest);
 *  - an entrance that hasn't begun: HIDDEN_DELTA — a thing that has an
 *    entrance has not arrived before it.
 */
export function evaluateMotion(motion, time, window) {
  if (!motion || !TIMED_KINDS.has(motion.kind)) return IDENTITY_DELTA;
  if (motion.kind === 'entrance' && time < window.start) return HIDDEN_DELTA;
  const progress = motionProgress(motion, time, window);
  if (progress >= 1) return IDENTITY_DELTA;
  return getMotionPreset(motion.preset).evaluate(Math.max(0, progress), motion.intensity);
}

/**
 * Two deltas as one — for an object with more than one motion running
 * (later: an entrance and an emphasis). Multipliers multiply, offsets and
 * rotations add.
 */
export function combineMotionDeltas(a, b) {
  if (a === IDENTITY_DELTA) return b;
  if (b === IDENTITY_DELTA) return a;
  return {
    opacity: a.opacity * b.opacity,
    scale: a.scale * b.scale,
    offsetX: a.offsetX + b.offsetX,
    offsetY: a.offsetY + b.offsetY,
    rotation: a.rotation + b.rotation
  };
}

export function isIdentityDelta(d) {
  return d === IDENTITY_DELTA || (d.opacity === 1 && d.scale === 1 && !d.offsetX && !d.offsetY && !d.rotation);
}

/**
 * Base state + motion = what is drawn. For an object whose renderer works
 * in plain numbers (rather than canvas transforms): `base` is
 * { x, y, scale, rotation, opacity } and `unit` the length of one object
 * unit in x/y's own units. The base object is never modified.
 */
export function applyMotionToState(base, d, unit = 1) {
  if (isIdentityDelta(d)) return base;
  return {
    ...base,
    x: (base.x || 0) + d.offsetX * unit,
    y: (base.y || 0) + d.offsetY * unit,
    scale: (base.scale ?? 1) * d.scale,
    rotation: (base.rotation || 0) + d.rotation,
    opacity: (base.opacity ?? 1) * d.opacity
  };
}
