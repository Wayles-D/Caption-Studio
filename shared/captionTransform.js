/**
 * Per-caption on-canvas transform overrides (see
 * src/js/components/canvasTransform.js). appState.captionTransforms is a map
 * keyed by getPhraseTransformKey(phrase) -> { customPosX?, customPosY?,
 * rotation?, fontSize? }, populated only for the phrases a user has actually
 * dragged/resized/rotated with "Apply to THIS CAPTION" — every other phrase
 * keeps using the plain global style params untouched, exactly as before
 * this feature existed. "Apply to ALL CAPTIONS" never writes into this map;
 * it writes the SAME global fields (customPosX/customPosY/rotation/fontSize)
 * this file already reads for the no-override case, so it needs no special
 * casing here at all.
 *
 * Shared (not frontend-only) because the backend export pipeline
 * (backend/utils/graphicsFrameGenerator.js) must resolve the exact same
 * per-phrase params the preview used, from the exact same `styles` payload
 * the frontend sent (see src/main.js's regenerate call).
 */

/**
 * A stable per-phrase key. Rounds to hundredths of a second so float noise
 * in phrase.start (e.g. from JSON round-tripping) can't split one logical
 * phrase into two different map keys between preview and export.
 */
export function getPhraseTransformKey(phrase) {
  return String(Math.round((phrase?.start || 0) * 100));
}

/**
 * Merges a phrase-specific transform override (if any) on top of the base
 * style params. Returns `baseParams` unchanged (same reference) when there's
 * no override for this phrase, so callers that don't care about transforms
 * see zero behavior change.
 *
 * A position override (customPosX/customPosY) forces position:'manual' for
 * THIS PHRASE ONLY — it never mutates global state — so a per-caption move
 * takes effect regardless of what the global `position` setting is, while
 * every other phrase keeps resolving from the global position/customPosX/Y
 * exactly as before.
 */
export function resolvePhraseParams(baseParams, phrase) {
  const overrides = baseParams && baseParams.captionTransforms;
  if (!overrides) return baseParams;

  const key = getPhraseTransformKey(phrase);
  const override = overrides[key];
  if (!override) return baseParams;

  const merged = { ...baseParams };
  if (override.customPosX != null || override.customPosY != null) {
    merged.position = 'manual';
    if (override.customPosX != null) merged.customPosX = override.customPosX;
    if (override.customPosY != null) merged.customPosY = override.customPosY;
  }
  if (override.rotation != null) merged.rotation = override.rotation;
  if (override.fontSize != null) merged.fontSize = override.fontSize;
  // Caption-level entrance animation, scoped to "This Caption" — the
  // per-target animation scope feature (src/js/components/canvasTransform.js)
  // writes these onto THIS phrase's own override exactly like every other
  // "This Caption" field above; without merging them here, a "This Caption"
  // animation choice would update captionTransforms correctly but never
  // actually reach shared/captionAnimation.js's getAnimationTransform (which
  // only ever reads captionAnimationType/Duration/Easing/Intensity off the
  // resolved params object), silently doing nothing.
  if (override.animationType != null) merged.captionAnimationType = override.animationType;
  if (override.animationDuration != null) merged.captionAnimationDuration = override.animationDuration;
  if (override.animationEasing != null) merged.captionAnimationEasing = override.animationEasing;
  if (override.animationIntensity != null) merged.captionAnimationIntensity = override.animationIntensity;

  return merged;
}

/**
 * A stable per-WORD key, independent of any phrase. Deliberately NOT
 * `${phraseKey}:${wordIndex}` — phraseGrouper.js's `wordIndex` is already the
 * word's position in the ENTIRE flat transcript (stamped once, before the
 * transcript is split into phrases), so it alone is a globally unique,
 * stable identity that survives text edits and doesn't require the word's
 * owning phrase to be in scope to look itself up — Rolling Stack's renderer
 * (shared/captionGraphics.js's paintRollingStackLines) never receives a
 * phrase, only `windowChunks` (each chunk's `words` already carry their own
 * `wordIndex`, see shared/rollingStack.js's buildRollingStackChunks).
 *
 * The `w` prefix guarantees no collision with getPhraseTransformKey's plain
 * numeric strings in the same captionTransforms map.
 *
 * A word-level override is always scoped to that one word specifically —
 * there is no "all captions" equivalent for an individual word occurrence,
 * so unlike phrase overrides, word overrides are never read/written any
 * differently based on transformApplyScope (see
 * src/js/components/canvasTransform.js's applyWordTransformFields).
 */
export function getWordTransformKey(wordIndex) {
  return `w${wordIndex}`;
}

/**
 * Looks up a single word's on-canvas transform override, if any —
 * `{ offsetXPx?, offsetYPx?, rotationDeg?, fontScale?, animationType?,
 * animationDuration?, animationEasing?, animationIntensity? }`, applied at
 * paint time around that word's own rendered pivot, additively on top of
 * whatever phrase/global transform already placed the block it's part of.
 * The animation* fields (keyword-scope editing feature) are resolved through
 * the exact same shared/captionAnimation.js engine the caption/Rolling-Stack-
 * window-level animation uses, just anchored to this word's own [start,end)
 * — see shared/captionGraphics.js's per-word paint blocks. Returns null (not
 * baseParams) since callers apply this per-word inside a paint loop, not as
 * a whole-params merge like resolvePhraseParams.
 */
export function resolveWordOverride(baseParams, wordIndex) {
  const overrides = baseParams && baseParams.captionTransforms;
  if (!overrides || wordIndex == null) return null;
  return overrides[getWordTransformKey(wordIndex)] || null;
}
