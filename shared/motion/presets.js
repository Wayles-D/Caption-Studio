/**
 * Motion presets — WHAT a named motion does to an object, as a function of
 * its eased progress. Nothing here knows when a motion runs (./motion.js
 * decides that) or what kind of object it is moving (the renderer applies
 * the result): a preset is pure shape.
 *
 * A preset returns a MOTION DELTA — how the object differs from its base
 * (resting) state at that progress:
 *
 *   {
 *     opacity:  multiplier on the base opacity          (1 = unchanged)
 *     scale:    multiplier on the base scale            (1 = unchanged)
 *     offsetX:  added to the base position, in OBJECT UNITS
 *     offsetY:  added to the base position, in OBJECT UNITS
 *     rotation: degrees added to the base rotation      (0 = unchanged)
 *   }
 *
 * Offsets are in object units — a length the object's renderer supplies
 * (for text, its font size) — so a slide travels a distance measured
 * against the thing that slides, at any resolution, on any kind of object.
 *
 * The delta never replaces the base state; it is applied on top of it at
 * render time (applyMotionDelta), so editing, undo and keyframes always see
 * the object's real, unanimated values.
 *
 * Adding a preset — a bounce, a wipe, an exit, a pulse — is one
 * registerMotionPreset() call; no evaluator or renderer changes.
 */

/** No change at all. Frozen and shared: returned whenever nothing moves. */
export const IDENTITY_DELTA = Object.freeze({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 0 });

/** Not drawn: an entrance that has not begun yet. */
export const HIDDEN_DELTA = Object.freeze({ opacity: 0, scale: 1, offsetX: 0, offsetY: 0, rotation: 0 });

/** How far a slide travels, in object units (font sizes, for text), at intensity 1. */
export const SLIDE_DISTANCE = 1;

const PRESETS = new Map();

/**
 * @param {{id: string, kind: 'entrance'|'exit'|'emphasis'|'loop', label?: string, evaluate: (progress: number, intensity: number) => object}} preset
 *   `evaluate` gets eased progress in [0, 1] (1 = the motion is complete)
 *   and the motion's intensity, and returns a partial delta (unset fields
 *   are unchanged).
 */
export function registerMotionPreset(preset) {
  if (!preset || typeof preset.id !== 'string' || typeof preset.evaluate !== 'function') {
    throw new Error('registerMotionPreset: an id and an evaluate function are required');
  }
  const evaluate = preset.evaluate;
  PRESETS.set(preset.id, {
    kind: 'entrance',
    label: preset.id,
    ...preset,
    // Whatever a preset leaves out is unchanged, so every caller always gets
    // a complete delta.
    evaluate: (progress, intensity) => {
      const d = evaluate(progress, intensity);
      return d && d.opacity !== undefined && d.scale !== undefined && d.offsetX !== undefined && d.offsetY !== undefined && d.rotation !== undefined
        ? d
        : { ...IDENTITY_DELTA, ...d };
    }
  });
}

export function getMotionPreset(id) {
  return PRESETS.get(id) || null;
}

/** Preset ids of one kind, in registration order. */
export function listMotionPresets(kind) {
  return [...PRESETS.values()].filter((p) => !kind || p.kind === kind).map((p) => p.id);
}

const delta = (fields) => ({ ...IDENTITY_DELTA, ...fields });

// A slide fades in over the first part of its travel, so the object is never
// seen standing still at its start offset: invisible at progress 0, opaque
// once it is 40% of the way there (eased) — with the default ease-out, the
// first ~60ms of a 0.25s entrance.
const slideOpacity = (p) => Math.min(1, p / 0.4);

// ---------------------------------------------------------------------------
// ENTRANCES — how an object arrives at its base state. Directions name the
// way the object MOVES: Slide Up rises into place from below, Slide Left
// travels leftwards into place from the right.
// ---------------------------------------------------------------------------

registerMotionPreset({ id: 'fade', kind: 'entrance', label: 'Fade', evaluate: (p) => delta({ opacity: p }) });

registerMotionPreset({
  id: 'pop', kind: 'entrance', label: 'Pop',
  // Starts noticeably smaller and snaps up to full size — punchier than Scale.
  evaluate: (p, intensity) => {
    const start = Math.max(0.05, 1 - 0.4 * intensity);
    return delta({ scale: start + (1 - start) * p });
  }
});

registerMotionPreset({
  id: 'scale', kind: 'entrance', label: 'Scale',
  // Starts modestly larger and settles down to full size — softer than Pop.
  evaluate: (p, intensity) => {
    const start = 1 + 0.35 * intensity;
    return delta({ scale: start + (1 - start) * p });
  }
});

const SLIDES = [
  ['slide-up', 'Slide Up', 0, 1],
  ['slide-down', 'Slide Down', 0, -1],
  ['slide-left', 'Slide Left', 1, 0],
  ['slide-right', 'Slide Right', -1, 0]
];
SLIDES.forEach(([id, label, dirX, dirY]) => registerMotionPreset({
  id, kind: 'entrance', label,
  // The START offset is (dirX, dirY) away from the base position; it closes
  // to nothing as progress reaches 1.
  evaluate: (p, intensity) => {
    const remaining = SLIDE_DISTANCE * intensity * (1 - p);
    return delta({ opacity: slideOpacity(p), offsetX: dirX ? dirX * remaining : 0, offsetY: dirY ? dirY * remaining : 0 });
  }
}));
