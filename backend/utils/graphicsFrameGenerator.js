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
import { canDrawCaptionFrame, isGraphicsRendererDefaultForPreset, drawCaptionFrameForExport } from '../../shared/captionGraphics.js';
import { registerBackendCanvasFonts } from './graphicsFontLoader.js';

/**
 * Whether a job with this style should render via the graphics pipeline
 * instead of ASS — delegates entirely to the shared
 * isGraphicsRendererDefaultForPreset, the SAME check the frontend preview
 * uses to decide when to switch off the CSS/DOM renderer, so export can
 * never go live for a preset the preview hasn't (see
 * shared/captionGraphics.js's GRAPHICS_RENDERER_DEFAULT_PRESETS).
 */
export function canGenerateGraphicsFrames(params) {
  const cssConfig = getCSSPreviewFromConfig(params);
  return isGraphicsRendererDefaultForPreset(cssConfig);
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

  const slices = computeBoundarySlices(phrase);
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

  const segments = [];
  let cursor = 0;

  [...phrases].sort((a, b) => a.start - b.start).forEach((phrase) => {
    pushGap(segments, cursor, phrase.start);
    segments.push(...generatePhraseCaptionFrames(phrase, params, canvasWidth, canvasHeight, outDir));
    cursor = phrase.end;
  });
  pushGap(segments, cursor, videoDuration);

  return segments;
}
