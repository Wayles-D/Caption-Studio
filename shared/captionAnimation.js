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

/**
 * Exported so shared/keyframes.js can reuse the exact same t-in-[0,1] curves
 * for keyframe-segment interpolation instead of duplicating the easing math
 * — this is the one place any easing curve lives, for both the single-shot
 * entrance animation and the real multi-keyframe timeline.
 */
export function applyEasing(t, easing) {
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

/** How far a slide travels, in font sizes, at intensity 1. */
export const SLIDE_DISTANCE_EM = 1;
// Opaque by the time the slide is ~40% of the way there (eased) — with the
// default ease-out that is the first ~60ms of a 0.25s entrance.
const slideAlpha = (progress) => Math.min(1, progress / 0.4);

/**
 * Turns an eased progress value into a concrete draw-time transform. Slide
 * offsets are returned in EMS — multiples of the text's own font size — and
 * the caller multiplies by its font size in px. A slide is an entrance OF
 * THE TEXT, so it travels a distance measured against the text: about one
 * line, whatever the frame's size. (It used to be a tenth of the frame —
 * 128px on a 1280px-tall video, two to three times a caption's height — so
 * the text visibly sat far from where it was going before it arrived.)
 *
 * A slide also fades in over the first part of its travel, so the text is
 * never seen standing still at the start offset: at progress 0 it is
 * invisible, and it is fully opaque well before it lands.
 *
 * Directions name the way the text MOVES: Slide Up rises into place from
 * below, Slide Left travels leftwards into place from the right.
 *
 * `type: 'none'` (or progress already 1) always resolves to the identity
 * transform — {alpha:1, scale:1, offsetXEm:0, offsetYEm:0} — so a caller can
 * apply this unconditionally without regressing the pre-animation output.
 *
 * @returns {{alpha:number, scale:number, offsetXEm:number, offsetYEm:number}}
 */
export function computeAnimationTransform(type, progress, intensity = 1) {
  const identity = { alpha: 1, scale: 1, offsetXEm: 0, offsetYEm: 0 };
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
      return { ...identity, alpha: slideAlpha(progress), offsetYEm: SLIDE_DISTANCE_EM * intensity * (1 - progress) };
    case 'slide-down':
      return { ...identity, alpha: slideAlpha(progress), offsetYEm: -SLIDE_DISTANCE_EM * intensity * (1 - progress) };
    case 'slide-left':
      return { ...identity, alpha: slideAlpha(progress), offsetXEm: SLIDE_DISTANCE_EM * intensity * (1 - progress) };
    case 'slide-right':
      return { ...identity, alpha: slideAlpha(progress), offsetXEm: -SLIDE_DISTANCE_EM * intensity * (1 - progress) };
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
  // Before its entrance begins, a thing with an entrance has not entered: it
  // is not drawn. For a whole caption this never comes up (it is not on
  // screen before it starts), but a WORD with its own entrance sits in a
  // caption that is already showing — and at progress 0 a slide or pop is
  // fully opaque at its start offset, so the word used to wait there,
  // visibly, until its own time came.
  if (animation.type !== 'none' && currentTime < elementStart) {
    return { alpha: 0, scale: 1, offsetXEm: 0, offsetYEm: 0 };
  }
  const progress = getAnimationProgress(currentTime, elementStart, elementEnd, animation);
  return computeAnimationTransform(animation.type, progress, animation.intensity);
}

/**
 * The window a word's own entrance animation runs over, for preview and
 * export alike (shared/captionGraphics.js paints with it,
 * backend/utils/graphicsFrameGenerator.js samples it).
 *
 *  - It STARTS at the word's own start — or, for a word set to animate
 *    together with the rest ('together'), at the start of the caption or
 *    text it belongs to, so every such word enters as one.
 *  - It may run until the caption ENDS, not just until the word stops being
 *    spoken: the word stays on screen after it is said, so a longer duration
 *    is a slower entrance. (It used to be clamped to the word's spoken
 *    length — a third of a second, typically — so raising the duration did
 *    nothing at all.)
 */
export function resolveWordAnimationWindow(word, container, override) {
  const start = override?.animationTiming === 'together' && container?.start != null
    ? container.start
    : word.start;
  const end = Math.max(start, container?.end ?? word.end ?? start);
  return { start, end };
}

/** A word override's own entrance, as the params getAnimationTransform reads. */
export function wordAnimationParams(override) {
  return {
    captionAnimationType: override?.animationType,
    captionAnimationDuration: override?.animationDuration,
    captionAnimationEasing: override?.animationEasing,
    captionAnimationIntensity: override?.animationIntensity
  };
}
