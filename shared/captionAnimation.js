/**
 * Caption entrance-animation math — shared by BOTH the live preview
 * (src/js/components/preview.js, via shared/captionGraphics.js's
 * drawCaptionFrame/drawRollingStackFrame) and the server-side export
 * (backend/utils/graphicsFrameGenerator.js, via drawCaptionFrameForExport/
 * drawRollingStackFrameForExport). Neither caller computes animation
 * progress on its own — both hand this module a `currentTime` and an
 * element's `[start, end)` window and get back the exact same eased
 * progress/transform, so preview and export can never draw a caption at two
 * different points in its entrance animation for the same currentTime.
 *
 * Naming note: this is deliberately NOT called "animationMode" anywhere —
 * that name is already taken by the pre-existing karaoke/pop/instant/
 * typewriter word-reveal-timing setting (see captionConfig.js). This module
 * concerns a separate, orthogonal concept: how the caption BLOCK as a whole
 * enters, independent of which word-highlight mode is active.
 *
 * Scope (the animation foundation, not the final animation library): only
 * an ENTRANCE animation is modeled (the caption appearing), not an exit —
 * matching the initial spec (fade/pop/scale/slide-in only). Adding an exit
 * animation later is additive (a second progress calculation anchored to
 * `end` instead of `start`), not a redesign of what's here.
 */

export const ANIMATION_TYPES = [
  'none', 'fade', 'pop', 'scale', 'slide-up', 'slide-down', 'slide-left', 'slide-right'
];

export const EASING_TYPES = ['linear', 'ease-in', 'ease-out', 'ease-in-out'];

/** Reusable t-in-[0,1] -> eased-t-in-[0,1] curves — the one place any easing math lives. */
const EASING_FUNCTIONS = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
};

function applyEasing(t, easing) {
  const fn = EASING_FUNCTIONS[easing] || EASING_FUNCTIONS.linear;
  return fn(Math.max(0, Math.min(1, t)));
}

/**
 * Normalizes a raw animation config (whatever subset of fields the caller's
 * `params` object carries) into a complete, safe-to-use shape. Missing/
 * invalid fields fall back to a fixed default rather than propagating NaN
 * into the draw path.
 */
export function resolveAnimationConfig(params) {
  const type = ANIMATION_TYPES.includes(params?.captionAnimationType) ? params.captionAnimationType : 'none';
  const rawDuration = parseFloat(params?.captionAnimationDuration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0.25;
  const easing = EASING_TYPES.includes(params?.captionAnimationEasing) ? params.captionAnimationEasing : 'ease-out';
  const rawIntensity = parseFloat(params?.captionAnimationIntensity);
  const intensity = Number.isFinite(rawIntensity) && rawIntensity > 0 ? rawIntensity : 1;
  return { type, duration, easing, intensity };
}

/**
 * Eased 0->1 entrance progress at `currentTime`, relative to `elementStart`.
 * Duration is clamped so the animation can never run longer than the
 * element's own lifetime (elementEnd - elementStart) — a caption shorter
 * than the configured animation duration finishes animating exactly when it
 * ends, never mid-motion past its own last visible instant.
 *
 * Returns 1 (fully "arrived", no visual effect) whenever animation is
 * disabled/type 'none' — callers can multiply this straight into an alpha/
 * scale/offset without a separate enabled check.
 */
export function getAnimationProgress(currentTime, elementStart, elementEnd, animation) {
  if (!animation || animation.type === 'none') return 1;
  const lifetime = Math.max(0, (elementEnd ?? elementStart) - elementStart);
  const effectiveDuration = Math.min(animation.duration, lifetime) || 0;
  if (effectiveDuration <= 0) return 1;
  const elapsed = currentTime - elementStart;
  if (elapsed <= 0) return 0;
  if (elapsed >= effectiveDuration) return 1;
  return applyEasing(elapsed / effectiveDuration, animation.easing);
}

/**
 * Turns an eased progress value into a concrete draw-time transform. All
 * offsets are returned as FRACTIONS of the canvas's own width/height (not
 * absolute px) so the same numbers produce a proportionally identical
 * animation at any canvas resolution — the caller multiplies by its own
 * canvasWidth/canvasHeight, exactly like resolveGeometry's pxScale pattern
 * in shared/captionGraphics.js.
 *
 * `type: 'none'` (or progress already 1) always resolves to the identity
 * transform — {alpha:1, scale:1, offsetXRatio:0, offsetYRatio:0} — so a
 * caller can apply this unconditionally without regressing the pre-
 * animation pixel output.
 *
 * @returns {{alpha:number, scale:number, offsetXRatio:number, offsetYRatio:number}}
 */
export function computeAnimationTransform(type, progress, intensity = 1) {
  const identity = { alpha: 1, scale: 1, offsetXRatio: 0, offsetYRatio: 0 };
  if (!type || type === 'none' || progress >= 1) return identity;

  switch (type) {
    case 'fade':
      return { ...identity, alpha: progress };
    case 'pop': {
      // Starts noticeably smaller and snaps up to full size — a punchier,
      // shorter-feeling entrance than SCALE.
      const startScale = Math.max(0.05, 1 - 0.4 * intensity);
      return { ...identity, scale: startScale + (1 - startScale) * progress };
    }
    case 'scale': {
      // Starts modestly larger and settles down to full size — a softer,
      // more deliberate entrance than POP.
      const startScale = 1 + 0.35 * intensity;
      return { ...identity, scale: startScale + (1 - startScale) * progress };
    }
    case 'slide-up':
      return { ...identity, offsetYRatio: 0.1 * intensity * (1 - progress) };
    case 'slide-down':
      return { ...identity, offsetYRatio: -0.1 * intensity * (1 - progress) };
    case 'slide-left':
      return { ...identity, offsetXRatio: -0.1 * intensity * (1 - progress) };
    case 'slide-right':
      return { ...identity, offsetXRatio: 0.1 * intensity * (1 - progress) };
    default:
      return identity;
  }
}

/**
 * Convenience wrapper combining the two steps above — the call every draw
 * site actually makes: given the raw params object and an element's
 * [start,end) window, resolve config + progress + transform in one go.
 */
export function getAnimationTransform(params, currentTime, elementStart, elementEnd) {
  const animation = resolveAnimationConfig(params);
  const progress = getAnimationProgress(currentTime, elementStart, elementEnd, animation);
  return computeAnimationTransform(animation.type, progress, animation.intensity);
}
