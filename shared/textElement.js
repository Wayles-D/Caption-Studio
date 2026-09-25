/**
 * Manually-authored timed text — the data model behind both "manual caption
 * events" and "text overlays".
 *
 * ONE record type, discriminated by `kind`, because the two differ in what
 * they MEAN, not in what they can do:
 *
 *   kind: 'caption'  — a caption the user placed and timed themselves, shown
 *                      on the captions lane, inheriting caption styling.
 *   kind: 'overlay'  — an independent piece of text over the video, on its
 *                      own lane, unrelated to the transcript.
 *
 * Both carry the same `style` bag and render through the same engine, so a
 * styling feature added later reaches both without being built twice. That
 * shared-capability/split-semantics arrangement is the whole point; a second
 * parallel implementation for "basic text" is explicitly what this avoids.
 *
 * Why these can't just be transcript phrases: `appState.phrases` is derived
 * SERVER-side by backend/utils/phraseGrouper.js from `words` on every
 * export/regenerate, and isn't undo-tracked. Anything pushed into it from the
 * client is silently discarded the next time the video renders. These records
 * are persisted, undo-tracked state of their own instead.
 *
 * Pure: no DOM, no canvas, no FFmpeg. Deliberately shared by the preview and
 * the export frame generator so the two can never disagree about which text
 * is on screen at a given instant — the same reason shared/audioTimeline.js
 * is shared.
 */
import { createClipId } from './audioTimeline.js';
import { resolveAnimatableField } from './keyframes.js';

export const TEXT_ELEMENT_KINDS = ['caption', 'overlay'];

/** What a freshly created element occupies, before the user drags its edges. */
export const DEFAULT_TEXT_ELEMENT_DURATION = 3;
/** Never let a clip collapse to something unclickable on the timeline. */
export const MIN_TEXT_ELEMENT_DURATION = 0.1;

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A new element starting at `start`.
 *
 * `style` is a SPARSE bag using the exact key names src/js/state.js's
 * getStyleParams() emits (fontFamily, activeWordColor, outlineSize, …). An
 * absent key means "inherit whatever the caption style says", matching the
 * null-is-inherit convention the global colour fields and
 * resolveWordStyleOverride already use. A fully independent element simply
 * sets more keys; nothing here caps what it may contain, which is what keeps
 * text at visual parity with captions as new style features land.
 */
export function createTextElement({ kind = 'overlay', start = 0, text = '', style = {}, ...overrides } = {}) {
  return normalizeTextElement({
    id: createClipId(kind === 'caption' ? 'mcap' : 'txt'),
    kind,
    start,
    end: start + DEFAULT_TEXT_ELEMENT_DURATION,
    text,
    enabled: true,
    style,
    ...overrides
  });
}

export function normalizeTextElement(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const kind = TEXT_ELEMENT_KINDS.includes(raw.kind) ? raw.kind : 'overlay';
  const start = Math.max(0, finiteOr(raw.start, 0));
  // An inverted or collapsed window (possible after dragging one trim handle
  // past the other) would otherwise render as a clip that can never be
  // visible and can never be grabbed again to fix.
  const end = Math.max(start + MIN_TEXT_ELEMENT_DURATION, finiteOr(raw.end, start + DEFAULT_TEXT_ELEMENT_DURATION));

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId(kind === 'caption' ? 'mcap' : 'txt'),
    kind,
    start,
    end,
    text: typeof raw.text === 'string' ? raw.text : '',
    enabled: raw.enabled !== false,
    style: raw.style && typeof raw.style === 'object' ? { ...raw.style } : {},
    // Kept OUTSIDE `style` on purpose. `style` is spread straight over the
    // caption params (see resolveTextElementParams), and params has no
    // `keyframes` key — putting them there would leak an array into the
    // renderer's params bag and make "reset style" silently delete the
    // element's animation. Same `{t, easing, values}[]` shape every other
    // keyframed target uses (shared/keyframes.js).
    keyframes: Array.isArray(raw.keyframes) ? raw.keyframes : []
  };
}

/**
 * Normalizes a whole list, tolerating a JSON STRING as well as an array.
 *
 * The string case is not defensive padding: the initial-upload path posts
 * state as FormData, where every value is stringified, while the regenerate
 * path posts real JSON (see src/App.jsx). The backend receives one or the
 * other depending on which path ran, so the list normalizer has to accept
 * both — exactly what normalizeAudioTimeline does for the same reason.
 */
export function normalizeTextElementList(raw) {
  let source = raw;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return []; }
  }
  if (!Array.isArray(source)) return [];
  return source
    .map(normalizeTextElement)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

/** Every element that should be on screen at `time` (enabled, and in range). */
export function getActiveTextElements(elements, time, kind = null) {
  if (!Array.isArray(elements)) return [];
  return elements.filter((el) => (
    el.enabled
    && (kind == null || el.kind === kind)
    && time >= el.start
    && time <= el.end
    // Empty text would contribute an invisible block that still costs a
    // render pass and, worse, an export PNG.
    && String(el.text || '').trim().length > 0
  ));
}

/**
 * Every instant at which the set of visible text changes — the element's own
 * edges. The export frame generator unions these with the transcript's own
 * phrase/word boundaries to decide where one rendered frame has to end and
 * the next begin.
 */
export function getTextElementBoundaryTimes(elements) {
  if (!Array.isArray(elements)) return [];
  const times = [];
  elements.forEach((el) => {
    if (!el.enabled || !String(el.text || '').trim()) return;
    times.push(el.start, el.end);
  });
  return times;
}

/**
 * THE one place an element's render params are resolved: the caption's own
 * params, the element's style bag on top, then its keyframes on top of that.
 *
 * Both renderers call this — src/js/components/preview.js's
 * syncTextElementsCanvas and backend/utils/graphicsFrameGenerator.js's
 * composite pass — so the preview and the exported file cannot resolve an
 * element differently. That is the same reason this module is shared at all.
 *
 * The field-to-property mapping is deliberately identical to a caption
 * phrase's (shared/keyframes.js's PHRASE_FIELD_TO_PROPERTY): an element's
 * position is a frame percentage, its scale a multiplier, its rotation
 * degrees — exactly like a caption's — so the timeline's property lanes,
 * their ranges, and the interpolation engine are all reused as-is rather
 * than reimplemented for a second kind of target.
 *
 * An element with no keyframes returns early, so it renders byte-for-byte
 * as it did before this function grew a keyframe branch.
 */
export function resolveTextElementParams(baseParams, element, currentTime) {
  const merged = {
    ...baseParams,
    // Blending happens at COMPOSITE time, per layer — never inherited from
    // the caption. Without this, an overlay on a project using a blend mode
    // for its transparent caption look would carry that mode along, and the
    // exporter would apply it to text the user had deliberately coloured.
    // (The preview has always had a separate, unblended text canvas, so this
    // was a preview/export divergence: correct on screen, wrong in the file.)
    textBlendMode: 'normal',
    ...(element.style || {})
  };
  const keyframes = element.keyframes;
  if (!Array.isArray(keyframes) || !keyframes.length || currentTime == null) return merged;

  const override = { keyframes };
  const posX = resolveAnimatableField(override, 'positionX', currentTime, merged.customPosX);
  const posY = resolveAnimatableField(override, 'positionY', currentTime, merged.customPosY);
  if (posX != null || posY != null) {
    // A keyframed position is by definition a manual one — an anchored
    // position ('bottom', 'center') has nowhere to put an interpolated
    // coordinate, so it would animate to nothing at all.
    merged.position = 'manual';
    if (posX != null) merged.customPosX = posX;
    if (posY != null) merged.customPosY = posY;
  }
  const rotation = resolveAnimatableField(override, 'rotation', currentTime, merged.rotation);
  if (rotation != null) merged.rotation = rotation;
  merged.captionScaleMultiplier = resolveAnimatableField(
    override, 'scale', currentTime, merged.captionScaleMultiplier != null ? merged.captionScaleMultiplier : 1
  );
  merged.opacity = resolveAnimatableField(
    override, 'opacity', currentTime, merged.opacity != null ? merged.opacity : 100
  );
  return merged;
}

/**
 * Adapts an element to the shape the caption renderer already consumes, so a
 * hand-authored element draws through the exact same path as a transcript
 * phrase rather than a parallel one.
 *
 * Every word is given the element's OWN full time span rather than a share of
 * it: word timings drive the active/inactive highlight model
 * (resolveWordDrawSpec) and typewriter reveal, and a manually typed line has
 * no per-word timing to honour — so every word reads as active for the whole
 * element, which is the "just show this text" behaviour expected here.
 *
 * `wordIndex` is deliberately omitted: it addresses the flat transcript, and
 * borrowing an index would make this text share per-word style overrides with
 * a real transcript word. resolveWordOverride returns null for a missing
 * index, so these words simply carry no per-word overrides.
 */
export function textElementToPhrase(element) {
  const words = String(element.text || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ word, start: element.start, end: element.end }));

  return { start: element.start, end: element.end, words, breakAfterIndices: [] };
}
