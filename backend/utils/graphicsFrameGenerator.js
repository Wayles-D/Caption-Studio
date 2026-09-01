/**
 * Milestone 2: server-side frame generation for the shared graphics renderer
 * (shared/captionGraphics.js). Renders one transparent PNG per timing slice
 * of a phrase — the SAME word-boundary slicing algorithm assWriter.js's
 * generateStaticHighlightDialogueEvents already uses for the ASS/karaoke
 * export (a slice per phrase.start/end + every word's own start/end, so a
 * redraw only happens exactly when the active word actually changes) — using
 * @napi-rs/canvas, a Canvas2D-compatible implementation with prebuilt
 * binaries (no native compile step, so it deploys on Render the same way
 * ffmpeg-static already does). Only re-rendering at word boundaries, rather
 * than every video frame, is what keeps this within the app's existing
 * memory budget (see backend/utils/ffmpeg.js's doc comments on the same
 * concern for the Unified Shadow layer).
 *
 * This module intentionally has no video-composition logic of its own — see
 * backend/utils/graphicsCompositor.js for turning these PNGs + timings into
 * the final video via FFmpeg. Caption Analysis → Layout/Timing (this file's
 * slicing) → Styling (getCSSPreviewFromConfig) → Graphics (drawCaptionFrame)
 * → Compositing (graphicsCompositor.js) stay separate, per the migration's
 * architecture.
 */
import fs from 'fs';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import { getCSSPreviewFromConfig } from '../../shared/captionConfig.js';
import { canDrawCaptionFrame, isGraphicsRendererDefault, drawCaptionFrameForExport, drawRollingStackFrameForExport } from '../../shared/captionGraphics.js';
import { buildRollingStackWindowSlices } from '../../shared/rollingStack.js';
import { resolvePhraseParams, resolveWordOverride } from '../../shared/captionTransform.js';
import { resolveAnimationConfig } from '../../shared/captionAnimation.js';
import { registerBackendCanvasFonts } from './graphicsFontLoader.js';

/**
 * Whether a job with this style should render via the graphics pipeline
 * instead of ASS — delegates entirely to the shared
 * isGraphicsRendererDefault, the SAME check the frontend preview
 * uses to decide when to switch off the CSS/DOM renderer, so export can
 * never go live for a preset the preview hasn't (see
 * shared/captionGraphics.js's GRAPHICS_RENDERER_DEFAULT_PRESETS).
 */
export function canGenerateGraphicsFrames(params) {
  const cssConfig = getCSSPreviewFromConfig(params);
  return isGraphicsRendererDefault(cssConfig);
}

/**
 * Computes the same word-boundary time slices as assWriter.js's
 * generateStaticHighlightDialogueEvents (karaoke/instant/pop): the phrase's
 * own start/end plus every word's start/end, deduped, sorted, and paired
 * into adjacent [start, end) windows, dropping degenerate (<1ms) slices.
 */
function computeBoundarySlices(phrase) {
  const clamp = (t) => Math.max(phrase.start, Math.min(phrase.end, t));
  const boundarySet = new Set([phrase.start, phrase.end]);
  phrase.words.forEach((w) => {
    boundarySet.add(clamp(w.start));
    boundarySet.add(clamp(w.end));
  });
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

  const slices = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start < 0.001) continue;
    slices.push({ start, end });
  }
  return slices;
}

// Fixed sampling rate used ONLY inside an active entrance-animation window —
// deliberately independent of the source video's own frame rate (an exact
// per-video-frame match isn't required for a smooth-looking ramp, and tying
// it to a possibly-high source fps would blow the PNG-count budget this
// module's boundary-slice design exists to protect — see this file's own
// header comment). 60ms (~16-17fps) is dense enough that a linear/eased
// alpha or scale ramp reads as continuous motion, not a slideshow.
const ANIMATION_SAMPLE_STEP_SECONDS = 0.06;

/**
 * Subdivides whichever boundary/window slices overlap an entrance
 * animation's own [animStart, animEnd) window into several fixed-step
 * sub-slices, leaving every slice OUTSIDE that window untouched. This is
 * what actually makes a caption's entrance animation visible in the
 * exported video: computeBoundarySlices/buildRollingStackWindowSlices are
 * intentionally coarse (one static PNG per word/chunk boundary, per this
 * module's memory-budget rationale) — animation frames need much finer
 * granularity, but ONLY for the brief window where the caption is actually
 * moving/fading, not for its entire (often multi-second) remaining lifetime.
 *
 * @param {{start:number,end:number}[]} slices - Time-ordered, non-overlapping, contiguous.
 * @param {number} animStart
 * @param {number} animEnd
 * @returns {{start:number,end:number}[]}
 */
function subdivideSlicesForAnimation(slices, animStart, animEnd) {
  if (!(animEnd > animStart)) return slices;

  const result = [];
  for (const slice of slices) {
    const overlapStart = Math.max(slice.start, animStart);
    const overlapEnd = Math.min(slice.end, animEnd);

    if (!(overlapEnd > overlapStart)) {
      result.push(slice);
      continue;
    }

    if (slice.start < overlapStart) result.push({ start: slice.start, end: overlapStart });

    let t = overlapStart;
    while (t < overlapEnd) {
      const next = Math.min(t + ANIMATION_SAMPLE_STEP_SECONDS, overlapEnd);
      if (next - t >= 0.001) result.push({ start: t, end: next });
      t = next;
    }

    if (slice.end > overlapEnd) result.push({ start: overlapEnd, end: slice.end });
  }
  return result;
}

/**
 * Keyword editing scope's per-word animation (see shared/captionTransform.js's
 * resolveWordOverride and shared/captionGraphics.js's per-word paint blocks)
 * needs the exact same export-side subdivision treatment as the caption/
 * Rolling-Stack-window-level animation above — otherwise a word's own
 * animation would render as a single static frame in the exported video even
 * though it animates correctly in the live preview (the same bug class
 * already found and fixed once for caption-level animation). Every word that
 * carries its own animation override gets its OWN [start, start+duration)
 * window subdivided independently, on top of whatever the caller already
 * produced — subdivideSlicesForAnimation leaves everything outside a given
 * window untouched, so calling it once per animated word composes safely
 * regardless of how many (if any) words in a phrase have one.
 */
function subdivideForWordAnimations(slices, words, params) {
  let result = slices;
  (words || []).forEach((w) => {
    const override = resolveWordOverride(params, w.wordIndex);
    if (!override || !override.animationType || override.animationType === 'none') return;
    const lifetime = Math.max(0, (w.end ?? w.start) - w.start);
    const duration = Math.min(override.animationDuration || 0.25, lifetime);
    if (duration <= 0) return;
    result = subdivideSlicesForAnimation(result, w.start, w.start + duration);
  });
  return result;
}

/**
 * Renders one transparent PNG per timing slice of `phrase` and writes them
 * into `outDir`. Each slice's frame is drawn at that slice's start time
 * (equivalent to any instant within [start, end) since, by construction, no
 * word's active/inactive state changes within a slice).
 *
 * @param {object} phrase - { start, end, words: [{word|text, start, end, isKeyword?}], breakAfterIndices? }
 * @param {object} params - Same raw style params object passed to getCSSPreviewFromConfig/getASSStyleFromConfig.
 * @param {number} canvasWidth - Output video's pixel width (frames are drawn 1:1, no scaling).
 * @param {number} canvasHeight - Output video's pixel height.
 * @param {string} outDir - Directory to write per-slice PNGs into (created if missing).
 * @returns {{start:number, end:number, file:string}[]} Slices with absolute PNG file paths, in time order.
 */
export function generatePhraseCaptionFrames(phrase, params, canvasWidth, canvasHeight, outDir) {
  registerBackendCanvasFonts();

  const cssConfig = getCSSPreviewFromConfig(params);
  if (!canDrawCaptionFrame(cssConfig)) {
    throw new Error('generatePhraseCaptionFrames: unsupported preset/mode for the graphics renderer (see shared/captionGraphics.js canDrawCaptionFrame).');
  }

  fs.mkdirSync(outDir, { recursive: true });

  let slices = computeBoundarySlices(phrase);

  // Entrance animation (shared/captionAnimation.js) needs several sampled
  // frames across its own short window, not the single static frame each
  // boundary slice normally gets — see subdivideSlicesForAnimation's doc
  // comment. The SAME clamp-to-lifetime rule getAnimationProgress applies at
  // draw time is applied here too, so the number of subdivided slices always
  // matches how long the animation will actually run.
  const animation = resolveAnimationConfig(params);
  if (animation.type !== 'none') {
    const animStart = phrase.start;
    const animEnd = animStart + Math.min(animation.duration, phrase.end - phrase.start);
    slices = subdivideSlicesForAnimation(slices, animStart, animEnd);
  }
  slices = subdivideForWordAnimations(slices, phrase.words, params);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  return slices.map((slice, idx) => {
    drawCaptionFrameForExport(ctx, {
      canvasWidth,
      canvasHeight,
      activePhrase: phrase,
      currentTime: slice.start,
      cssConfig,
      params
    });

    // Named by its own start time (milliseconds), not a per-call index — this
    // function is called once per phrase into a SHARED outDir when building a
    // whole video's caption track (see buildFullTimelineSegments), and every
    // phrase's start time is unique across that video, so this can't collide
    // the way a phrase-local index would.
    const file = path.join(outDir, `slice-${Math.round(slice.start * 1000)}.png`);
    fs.writeFileSync(file, canvas.toBuffer('image/png'));

    return { start: slice.start, end: slice.end, file };
  });
}

/**
 * Rolling Stack's frame generator — export counterpart to
 * generatePhraseCaptionFrames. Slices are window-boundary-based (see
 * shared/rollingStack.js's buildRollingStackWindowSlices — Active-Word
 * Selection), not per-word: a new PNG is only rendered when the on-screen
 * chunk window actually changes, which for typical 2-3-word chunks is far
 * fewer redraws than one-per-word, keeping this within the app's existing
 * memory budget the same way generatePhraseCaptionFrames does.
 *
 * @param {object} phrase - { start, end, words: [{word|text, start, end, isKeyword?}] }
 * @param {object} params - Same raw style params, including rollingStackLayerCount/rollingStackAlignment.
 * @param {number} canvasWidth - Output video's pixel width.
 * @param {number} canvasHeight - Output video's pixel height.
 * @param {string} outDir - Directory to write per-slice PNGs into (created if missing).
 * @returns {{start:number, end:number, file:string}[]}
 */
export function generateRollingStackPhraseFrames(phrase, params, canvasWidth, canvasHeight, outDir) {
  registerBackendCanvasFonts();

  const cssConfig = getCSSPreviewFromConfig(params);
  if (!canDrawCaptionFrame(cssConfig)) {
    throw new Error('generateRollingStackPhraseFrames: unsupported preset/mode for the graphics renderer (see shared/captionGraphics.js canDrawCaptionFrame).');
  }

  fs.mkdirSync(outDir, { recursive: true });

  const layerCount = params.rollingStackLayerCount || 2;
  const windowSlices = buildRollingStackWindowSlices(phrase, layerCount);
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  const animation = resolveAnimationConfig(params);

  // Each window slice's own active (last) chunk is what entered the frame at
  // that slice's start — see shared/captionGraphics.js's
  // renderRollingStackResolvedFrame doc comment. Unlike sentence mode (one
  // phrase-wide animation window), Rolling Stack re-triggers the entrance
  // once per window change, so each slice gets its OWN animation window,
  // subdivided independently, then flattened back into one time-ordered list.
  const slices = windowSlices.flatMap((slice) => {
    let subSlices = [{ start: slice.start, end: slice.end }];
    if (animation.type !== 'none') {
      const activeChunk = slice.chunks[slice.chunks.length - 1];
      const animStart = activeChunk.start;
      const animEnd = animStart + Math.min(animation.duration, activeChunk.end - activeChunk.start);
      subSlices = subdivideSlicesForAnimation(subSlices, animStart, animEnd);
    }
    // Per-word animation (keyword scope) — only the words actually in THIS
    // window (not the whole phrase) can matter for this slice's own range.
    const wordsInWindow = slice.chunks.flatMap((c) => c.words || []);
    subSlices = subdivideForWordAnimations(subSlices, wordsInWindow, params);
    return subSlices.map((sub) => ({ ...sub, chunks: slice.chunks }));
  });

  return slices.map((slice) => {
    drawRollingStackFrameForExport(ctx, {
      canvasWidth,
      canvasHeight,
      windowChunks: slice.chunks,
      currentTime: slice.start,
      cssConfig,
      params,
      alignment: params.rollingStackAlignment,
      createOffscreenCanvas: (w, h) => createCanvas(w, h)
    });

    const file = path.join(outDir, `slice-${Math.round(slice.start * 1000)}.png`);
    fs.writeFileSync(file, canvas.toBuffer('image/png'));

    return { start: slice.start, end: slice.end, file };
  });
}

/**
 * Writes one fully-transparent PNG at the given resolution — the "nothing is
 * captioned right now" filler segment used to bridge gaps between phrases
 * (and before the first / after the last) when building a full-video caption
 * track (see buildFullTimelineSegments). A freshly created canvas is already
 * fully transparent, so this is just an unmodified toBuffer() — no drawing.
 */
function generateBlankFrame(canvasWidth, canvasHeight, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const file = path.join(outDir, 'blank.png');
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}

/**
 * Builds ONE contiguous, gap-filled sequence of timed PNG segments spanning
 * the entire video — every phrase's own slices (generatePhraseCaptionFrames)
 * plus a shared blank filler segment for every stretch where nothing is
 * captioned (before the first phrase, between phrases, after the last).
 * "Contiguous" matters here: see graphicsCompositor.js's concat-based
 * compositor, which plays segments back-to-back purely by their declared
 * durations — unlike the per-slice `overlay:enable=between(...)` approach,
 * it has no notion of absolute time, so any coverage gap would desync every
 * segment after it.
 *
 * @param {object[]} phrases - Time-ordered phrases (as sanitizePhraseTimings produces).
 * @param {object} params - Same raw style params passed to getCSSPreviewFromConfig/getASSStyleFromConfig.
 * @param {number} canvasWidth - Output video's pixel width.
 * @param {number} canvasHeight - Output video's pixel height.
 * @param {number} videoDuration - Total video duration in seconds.
 * @param {string} outDir - Directory to write PNGs into.
 * @returns {{start:number, end:number, file:string}[]} Contiguous, time-ordered segments covering [0, videoDuration).
 */
export function buildFullTimelineSegments(phrases, params, canvasWidth, canvasHeight, videoDuration, outDir) {
  const blankFile = generateBlankFrame(canvasWidth, canvasHeight, outDir);
  const pushGap = (segments, start, end) => {
    if (end - start >= 0.001) segments.push({ start, end, file: blankFile });
  };

  // Caption mode is a global style setting, not per-phrase, so this is
  // resolved once and used for every phrase in the video.
  const cssConfig = getCSSPreviewFromConfig(params);
  const generatePhraseFrames = cssConfig.captionMode === 'rolling-stack'
    ? generateRollingStackPhraseFrames
    : generatePhraseCaptionFrames;

  const segments = [];
  let cursor = 0;

  [...phrases].sort((a, b) => a.start - b.start).forEach((phrase) => {
    pushGap(segments, cursor, phrase.start);
    const phraseParams = resolvePhraseParams(params, phrase);
    segments.push(...generatePhraseFrames(phrase, phraseParams, canvasWidth, canvasHeight, outDir));
    cursor = phrase.end;
  });
  pushGap(segments, cursor, videoDuration);

  return segments;
}
