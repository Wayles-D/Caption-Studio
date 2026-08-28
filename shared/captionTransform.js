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

  return merged;
}
