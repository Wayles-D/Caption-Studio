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
 *   kind: 'interlude' — a CINEMATIC TEXT INTERLUDE: a full-frame composition
 *                      (a solid background plus this same text) that replaces
 *                      the video's PICTURE for its span while the video's
 *                      audio carries on underneath. Nothing about the source
 *                      video changes — the renderer simply paints this over
 *                      it, opaque, for [start, end). See
 *                      resolveInterludeBackground and orderForCompositing.
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

export const TEXT_ELEMENT_KINDS = ['caption', 'overlay', 'interlude'];

/** What a freshly created element occupies, before the user drags its edges. */
export const DEFAULT_TEXT_ELEMENT_DURATION = 3;
/**
 * An interlude's default span. Shorter than a text overlay's: it takes the
 * whole picture away, so its natural length is one beat of the speech — long
 * enough to read three or four words, short enough not to lose the video.
 */
export const DEFAULT_INTERLUDE_DURATION = 2;

/** The interlude's own full-frame fill. A record rather than a bare colour, so gradients or images can follow as new types. */
export const DEFAULT_INTERLUDE_BACKGROUND = { type: 'color', color: '#FFFFFF' };

/**
 * The look a NEW interlude starts from — seeded into its style bag, the same
 * sparse bag every text element uses.
 *
 * Seeded rather than inherited, which is the opposite of an overlay. An
 * overlay inheriting the caption look is right: it sits over the same video.
 * An interlude is a card of its own, and the caption look carries things that
 * are wrong on one — a black outline, a boxed background, keyword colours,
 * pop scaling — so it starts from a neutral, unboxed, non-keyword preset and
 * clean type, and the user styles it from there. Every key is an ordinary
 * getStyleParams() key (plus the layout keys resolveGeometry reads), so every
 * control in the Text panel applies to it.
 */
export const INTERLUDE_DEFAULT_STYLE = {
  preset: 'caps-white',
  fontFamily: 'Montserrat',
  fontWeight: '800',
  fontSize: 30,
  // Word spacing is authored in px, not em: the caption default (4px) suits
  // 14px caption type and all but closes the gap between words at this size.
  wordSpacing: 9,
  textCase: 'uppercase',
  activeWordColor: '#111111',
  inactiveWordColor: '#111111',
  outlineSize: 0,
  shadowMode: 'none',
  shadowSize: 0,
  backgroundColor: 'transparent',
  enableKeywordHighlighting: false,
  animationMode: 'karaoke',
  position: 'manual',
  customPosX: 50,
  customPosY: 50,
  textAlign: 'center',
  lineHeight: 1.1,
  textMaxWidth: 80,
  letterSpacing: 1,
  captionAnimationType: 'fade',
  captionAnimationDuration: 0.4
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** An interlude's background, normalized; null for every other kind. */
export function resolveInterludeBackground(element) {
  if (!element || element.kind !== 'interlude') return null;
  const bg = element.background && typeof element.background === 'object' ? element.background : {};
  return {
    type: 'color',
    color: HEX_COLOR.test(bg.color || '') ? bg.color.toUpperCase() : DEFAULT_INTERLUDE_BACKGROUND.color
  };
}

/**
 * A new interlude over [start, end) — THE one way one is made.
 *
 * The editor's "+ Cinematic Text" calls this with the playhead; a future
 * suggestion pass would call it with a range resolved from transcript words
 * ("create an interlude from 12.4s to 14.2s"). Both get the same ordinary
 * record, which the user then edits like any other — a suggester never needs
 * to know how one is drawn.
 */
export function createInterlude({ start = 0, end, text = '', background, style = {}, ...overrides } = {}) {
  return createTextElement({
    kind: 'interlude',
    start,
    end: end ?? start + DEFAULT_INTERLUDE_DURATION,
    text,
    background: { ...DEFAULT_INTERLUDE_BACKGROUND, ...(background || {}) },
    style: { ...INTERLUDE_DEFAULT_STYLE, ...style },
    ...overrides
  });
}
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
    id: createClipId(idPrefixFor(kind)),
    kind,
    start,
    end: start + (kind === 'interlude' ? DEFAULT_INTERLUDE_DURATION : DEFAULT_TEXT_ELEMENT_DURATION),
    text,
    enabled: true,
    style,
    ...overrides
  });
}

function idPrefixFor(kind) {
  return kind === 'caption' ? 'mcap' : kind === 'interlude' ? 'intl' : 'txt';
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
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId(idPrefixFor(kind)),
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
    keyframes: Array.isArray(raw.keyframes) ? raw.keyframes : [],
    // Only an interlude has one; every other kind keeps exactly the shape it
    // always had.
    ...(kind === 'interlude' ? { background: resolveInterludeBackground({ kind, background: raw.background }) } : {}),
    // Only an element made FROM a caption has these (see
    // textElementFromCaption); a typed element keeps its original shape.
    ...(normalizeTiming(raw.timing) ? { timing: normalizeTiming(raw.timing) } : {}),
    ...(raw.source && raw.source.kind === 'caption' && raw.source.event ? { source: { kind: 'caption', event: raw.source.event, transform: raw.source.transform || null } } : {}),
    // Sound effects LINKED to this element (their clip ids): they move with
    // it and are removed with it — see textElements.js's moveTextElement /
    // removeTextElement. Ordinary SFX clips otherwise; only the link lives here.
    ...(Array.isArray(raw.soundIds) && raw.soundIds.some((s) => typeof s === 'string' && s)
      ? { soundIds: [...new Set(raw.soundIds.filter((s) => typeof s === 'string' && s))] }
      : {})
  };
}

/**
 * Per-word timing for an element made from a caption: each word's own spoken
 * offset from the element's start and its length, the transcript word it came
 * from, whether it is a keyword, and whether a line breaks after it. Null
 * when absent or malformed.
 */
function normalizeTiming(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = raw.map((t) => ({
    word: String(t?.word ?? ''),
    offset: Math.max(0, finiteOr(t?.offset, 0)),
    duration: Math.max(0.01, finiteOr(t?.duration, 0.01)),
    wordIndex: Number.isInteger(t?.wordIndex) ? t.wordIndex : null,
    isKeyword: !!t?.isKeyword,
    breakAfter: !!t?.breakAfter
  })).filter((t) => t.word.trim().length > 0);
  return out.length ? out : null;
}

/**
 * A text element made FROM one of the transcript's captions — the caption
 * capsule's "Cinematic text" / "Text overlay" action, and the seam a future
 * suggestion pass would use to turn a spoken line into a card.
 *
 * It keeps what makes it the caption it was:
 *   - its span, words and line breaks;
 *   - each word's REAL spoken timing (as offsets from the element's start, so
 *     moving the element carries them along) — the karaoke highlight, pop and
 *     typewriter reveal therefore behave exactly as they do on the caption,
 *     instead of every word being lit for the element's whole life;
 *   - its transcript word indices and keyword flags, so per-word styling and
 *     keyword highlighting made on those words still apply;
 *   - for an OVERLAY, the caption's own edits too — its position, rotation,
 *     scale, size, animation and keyframes — so it looks exactly as it did.
 *     An INTERLUDE is a card of its own and starts from the cinematic look.
 *
 * source records the caption it came from, so it can be turned back.
 */
export function textElementFromCaption({ kind = 'interlude', event, words, transform = null }) {
  const breaks = new Set(event.breakAfterIndices || []);
  const timing = [];
  event.wordIndices.forEach((idx, pos) => {
    const w = (words || [])[idx];
    const word = String(w?.word ?? w?.text ?? '').trim();
    if (!w || !word) return;
    timing.push({
      word,
      offset: Math.max(0, finiteOr(w.start, event.start) - event.start),
      duration: Math.max(0.01, finiteOr(w.end, event.end) - finiteOr(w.start, event.start)),
      wordIndex: idx,
      isKeyword: !!w.isKeyword,
      breakAfter: breaks.has(pos)
    });
  });
  const text = timing.map((t, i) => t.word + (i < timing.length - 1 ? (kind === 'interlude' && t.breakAfter ? '\n' : ' ') : '')).join('');

  let style = {};
  let keyframes = [];
  if (kind === 'interlude') {
    style = { ...INTERLUDE_DEFAULT_STYLE };
  } else if (transform) {
    // The caption's own "This Caption" edits, in the element's style keys —
    // the same field names resolvePhraseParams reads them as.
    if (transform.customPosX != null || transform.customPosY != null) {
      style.position = 'manual';
      if (transform.customPosX != null) style.customPosX = transform.customPosX;
      if (transform.customPosY != null) style.customPosY = transform.customPosY;
    }
    if (transform.rotation != null) style.rotation = transform.rotation;
    if (transform.fontSize != null) style.fontSize = transform.fontSize;
    if (transform.captionScaleMultiplier != null) style.captionScaleMultiplier = transform.captionScaleMultiplier;
    if (transform.opacity != null) style.opacity = transform.opacity;
    if (transform.animationType != null) style.captionAnimationType = transform.animationType;
    if (transform.animationDuration != null) style.captionAnimationDuration = transform.animationDuration;
    if (transform.animationEasing != null) style.captionAnimationEasing = transform.animationEasing;
    if (transform.animationIntensity != null) style.captionAnimationIntensity = transform.animationIntensity;
    if (Array.isArray(transform.keyframes)) keyframes = transform.keyframes;
  }

  const common = { start: event.start, end: event.end, text, style, keyframes, timing, source: { kind: 'caption', event: { ...event }, transform: transform || null } };
  return kind === 'interlude'
    ? createInterlude(common)
    : createTextElement({ kind: kind === 'caption' ? 'caption' : 'overlay', ...common });
}

/**
 * The element's per-word timing, but only while its text still reads as
 * those words in that order. Once the text is edited into different words the
 * timing no longer describes it, and the element falls back to showing every
 * word for its whole span — what a typed element does.
 */
function activeTiming(element) {
  const timing = element.timing;
  if (!Array.isArray(timing) || !timing.length) return null;
  const tokens = String(element.text || '').split(/\s+/).filter(Boolean);
  if (tokens.length !== timing.length) return null;
  return tokens.every((tok, i) => tok === timing[i].word) ? timing : null;
}

/**
 * Whether an element draws anything. A text element with no words draws
 * nothing and is skipped — but an interlude's BACKGROUND is content in its
 * own right (a black beat with no words is a legitimate edit), so an
 * interlude always draws. One predicate, used by the preview, the exporter
 * and the boundary list alike, so none of them can disagree about it.
 */
export function isTextElementRenderable(el) {
  return !!el && el.enabled !== false && (el.kind === 'interlude' || String(el.text || '').trim().length > 0);
}

/**
 * The draw order for everything active at one instant, and the rule for
 * overlapping interludes. Shared by the preview and the exporter.
 *
 *   1. manual captions — part of the caption layer, UNDER the picture's replacement
 *   2. ONE interlude   — the most recently started, if several overlap
 *   3. overlays        — independent artwork, on top of everything
 *
 * An interlude replaces the picture, so what it covers is the video AND the
 * captions over it; overlays are drawn after it, so an overlay placed during
 * an interlude still shows. When interludes overlap, only the latest-starting
 * one is drawn: it covers the frame completely anyway, and drawing exactly
 * one keeps the result well defined.
 *
 * In the export, manual captions are their own layer beneath this one (see
 * graphicsFrameGenerator.js), so the same order holds there structurally.
 */
export function orderForCompositing(active) {
  const list = Array.isArray(active) ? active : [];
  const interludes = list.filter((el) => el.kind === 'interlude');
  const top = interludes.length
    ? interludes.reduce((a, b) => (b.start > a.start || (b.start === a.start && b.id > a.id) ? b : a))
    : null;
  return [
    ...list.filter((el) => el.kind === 'caption'),
    ...(top ? [top] : []),
    ...list.filter((el) => el.kind !== 'caption' && el.kind !== 'interlude')
  ];
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
    isTextElementRenderable(el)
    && (kind == null || el.kind === kind)
    && time >= el.start
    // HALF-OPEN at the end: an element is on screen over [start, end), not
    // [start, end]. With back-to-back elements the inclusive form showed the
    // outgoing and incoming one together for one instant, and — because the
    // exporter used this same test to decide what a whole SEGMENT contains —
    // made every element bleed past its end in the rendered file (see
    // graphicsFrameGenerator.js's buildTextElementSegments). A clip's own
    // minimum duration (MIN_TEXT_ELEMENT_DURATION) keeps this from ever
    // making one invisible.
    && time < el.end
    // (Empty text is excluded by isTextElementRenderable: it would cost a
    // render pass and an export PNG for nothing — except on an interlude,
    // whose background is visible on its own.)
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
    if (!isTextElementRenderable(el)) return;
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
  // Made from a caption, text unchanged: the words keep their real spoken
  // timing and transcript identity (see textElementFromCaption). wordIndex is
  // carried deliberately here — the caption has become this element, so the
  // per-word styling made on those words belongs to it now.
  const timing = activeTiming(element);
  if (timing) {
    const words = timing.map((t) => ({
      word: t.word,
      start: element.start + t.offset,
      end: element.start + t.offset + t.duration,
      ...(t.wordIndex != null ? { wordIndex: t.wordIndex } : {}),
      isKeyword: t.isKeyword
    }));
    const breakAfterIndices = element.kind === 'interlude'
      ? newlineBreaks(element.text)
      : timing.map((t, i) => (t.breakAfter && i < timing.length - 1 ? i : -1)).filter((i) => i >= 0);
    return { start: element.start, end: element.end, words, breakAfterIndices };
  }

  // An interlude honours the line breaks typed into it — "THIS CHANGED /
  // EVERYTHING." is a composition, and where its lines break is part of it.
  // Other kinds keep flowing their words exactly as they always have.
  const lines = element.kind === 'interlude'
    ? String(element.text || '').split(/\r?\n/)
    : [String(element.text || '')];
  const words = [];
  const breakAfterIndices = [];
  lines.forEach((line, i) => {
    line.split(/\s+/).filter(Boolean).forEach((word) => words.push({ word, start: element.start, end: element.end }));
    if (i < lines.length - 1 && words.length && breakAfterIndices.at(-1) !== words.length - 1) breakAfterIndices.push(words.length - 1);
  });

  return { start: element.start, end: element.end, words, breakAfterIndices };
}

/** Word positions a line break follows, from newlines in the text. */
function newlineBreaks(text) {
  const breaks = [];
  let count = 0;
  String(text || '').split(/\r?\n/).forEach((line, i, lines) => {
    count += line.split(/\s+/).filter(Boolean).length;
    if (i < lines.length - 1 && count > 0 && breaks.at(-1) !== count - 1) breaks.push(count - 1);
  });
  return breaks;
}
