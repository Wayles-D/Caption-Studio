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
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getCSSPreviewFromConfig } from '../../shared/captionConfig.js';
import { canDrawCaptionFrame, isGraphicsRendererDefault, drawCaptionFrameForExport, drawRollingStackFrameForExport } from '../../shared/captionGraphics.js';
import { buildRollingStackWindowSlices } from '../../shared/rollingStack.js';
import { resolvePhraseParams, resolveWordOverride, getPhraseTransformKey } from '../../shared/captionTransform.js';
import { resolveAnimationConfig } from '../../shared/captionAnimation.js';
import { getKeyframeTimeRange } from '../../shared/keyframes.js';
import {
  normalizeTextElementList,
  getActiveTextElements,
  getTextElementBoundaryTimes,
  textElementToPhrase
} from '../../shared/textElement.js';
import { registerBackendCanvasFonts } from './graphicsFontLoader.js';

/**
 * Whether a job with this style should render via the graphics pipeline
 * instead of ASS — delegates entirely to the shared
 * isGraphicsRendererDefault, the SAME check the frontend preview uses to
 * decide when to switch off the CSS/DOM renderer, so export can never go
 * live for a mode/preset the preview hasn't (see
 * shared/captionGraphics.js's canDrawCaptionFrame).
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
    if (!override) return;
    if (override.animationType && override.animationType !== 'none') {
      const lifetime = Math.max(0, (w.end ?? w.start) - w.start);
      const duration = Math.min(override.animationDuration || 0.25, lifetime);
      if (duration > 0) result = subdivideSlicesForAnimation(result, w.start, w.start + duration);
    }
    // Real timeline keyframes (see shared/keyframes.js) need the exact same
    // dense-sampling treatment as an entrance animation — otherwise a
    // word's keyframed position/scale/rotation/opacity would render as a
    // single static frame in the exported video despite animating correctly
    // in live preview.
    const kfRange = getKeyframeTimeRange(override);
    if (kfRange) result = subdivideSlicesForAnimation(result, kfRange.min, kfRange.max);
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
 * @param {object} params - RAW style params object (pre phrase-merge) — same object passed to getCSSPreviewFromConfig/getASSStyleFromConfig; this function resolves the phrase-specific merge itself, once statically for detection and once per slice for keyframe-correct rendering (see shared/captionTransform.js's resolvePhraseParams).
 * @param {number} canvasWidth - Output video's pixel width (frames are drawn 1:1, no scaling).
 * @param {number} canvasHeight - Output video's pixel height.
 * @param {string} outDir - Directory to write per-slice PNGs into (created if missing).
 * @param {object} [transformKeyPhrase=phrase] - The phrase whose getPhraseTransformKey identifies this target's captionTransforms entry — defaults to `phrase` itself (the normal sentence/rolling-stack case). Word Mode (see generateWordModePhraseFrames) passes the REAL multi-word phrase here while `phrase` is a synthetic single-word stand-in used only for boundary-slicing, so a phrase-level keyframe/override still resolves under the SAME key the live preview uses (which always keys off the real phrase — see src/js/components/preview.js).
 * @returns {{start:number, end:number, file:string}[]} Slices with absolute PNG file paths, in time order.
 */
export function generatePhraseCaptionFrames(phrase, params, canvasWidth, canvasHeight, outDir, transformKeyPhrase = phrase) {
  registerBackendCanvasFonts();

  // Static (non-time-varying) phrase merge — used only for mode/preset
  // detection and boundary/animation-window computation below, none of
  // which needs to vary per-instant. Real timeline keyframes are resolved
  // fresh per SLICE further down (see the map() callback) — this is the fix
  // for a real gap: this function used to receive an already phrase-merged,
  // one-time-resolved params object, which made a phrase-level keyframe
  // impossible to animate across a phrase's own slices in export (it would
  // hold whatever value was true at the FIRST slice for the whole phrase).
  const staticPhraseParams = resolvePhraseParams(params, transformKeyPhrase);
  const cssConfig = getCSSPreviewFromConfig(staticPhraseParams);
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
  const animation = resolveAnimationConfig(staticPhraseParams);
  if (animation.type !== 'none') {
    const animStart = phrase.start;
    const animEnd = animStart + Math.min(animation.duration, phrase.end - phrase.start);
    slices = subdivideSlicesForAnimation(slices, animStart, animEnd);
  }
  // Real timeline keyframes on the PHRASE itself (position/scale/rotation/
  // opacity) — same dense-sampling treatment as the entrance animation
  // above, over the union range of every keyframed property (see
  // shared/keyframes.js's getKeyframeTimeRange).
  const phraseOverride = params.captionTransforms?.[getPhraseTransformKey(transformKeyPhrase)];
  const phraseKfRange = getKeyframeTimeRange(phraseOverride);
  if (phraseKfRange) {
    slices = subdivideSlicesForAnimation(slices, phraseKfRange.min, phraseKfRange.max);
  }
  slices = subdivideForWordAnimations(slices, phrase.words, staticPhraseParams);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  return slices.map((slice, idx) => {
    // Per-slice phrase-params resolution — the one place a phrase-level
    // keyframe actually gets its correct, time-varying value baked into the
    // frame (see resolvePhraseParams's optional currentTime argument).
    // Recomputing cssConfig too matters because position keyframes are
    // expressed as customPosX/customPosY, which getCSSPreviewFromConfig
    // bakes into fixed overlay anchors — the same pattern the live preview
    // already uses every render tick (see src/js/components/preview.js).
    const sliceParams = resolvePhraseParams(params, transformKeyPhrase, slice.start);
    const sliceCssConfig = sliceParams === params ? cssConfig : getCSSPreviewFromConfig(sliceParams);
    drawCaptionFrameForExport(ctx, {
      canvasWidth,
      canvasHeight,
      activePhrase: phrase,
      currentTime: slice.start,
      cssConfig: sliceCssConfig,
      params: sliceParams,
      createOffscreenCanvas: (w, h) => createCanvas(w, h)
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
 * @param {object} params - RAW style params (pre phrase-merge), including rollingStackLayerCount/rollingStackAlignment — see generatePhraseCaptionFrames's doc comment for why this function resolves the phrase merge itself rather than receiving it pre-resolved.
 * @param {number} canvasWidth - Output video's pixel width.
 * @param {number} canvasHeight - Output video's pixel height.
 * @param {string} outDir - Directory to write per-slice PNGs into (created if missing).
 * @returns {{start:number, end:number, file:string}[]}
 */
export function generateRollingStackPhraseFrames(phrase, params, canvasWidth, canvasHeight, outDir) {
  registerBackendCanvasFonts();

  const staticPhraseParams = resolvePhraseParams(params, phrase);
  const cssConfig = getCSSPreviewFromConfig(staticPhraseParams);
  if (!canDrawCaptionFrame(cssConfig)) {
    throw new Error('generateRollingStackPhraseFrames: unsupported preset/mode for the graphics renderer (see shared/captionGraphics.js canDrawCaptionFrame).');
  }

  fs.mkdirSync(outDir, { recursive: true });

  const layerCount = staticPhraseParams.rollingStackLayerCount || 2;
  const windowSlices = buildRollingStackWindowSlices(phrase, layerCount);
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  const animation = resolveAnimationConfig(staticPhraseParams);
  const phraseOverride = params.captionTransforms?.[getPhraseTransformKey(phrase)];
  const phraseKfRange = getKeyframeTimeRange(phraseOverride);

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
    // Real timeline keyframes on the phrase itself — same treatment as
    // sentence mode's generatePhraseCaptionFrames.
    if (phraseKfRange) {
      subSlices = subdivideSlicesForAnimation(subSlices, phraseKfRange.min, phraseKfRange.max);
    }
    // Per-word animation (keyword scope) — only the words actually in THIS
    // window (not the whole phrase) can matter for this slice's own range.
    const wordsInWindow = slice.chunks.flatMap((c) => c.words || []);
    subSlices = subdivideForWordAnimations(subSlices, wordsInWindow, staticPhraseParams);
    return subSlices.map((sub) => ({ ...sub, chunks: slice.chunks }));
  });

  return slices.map((slice) => {
    // Per-slice phrase-params resolution — see the matching comment in
    // generatePhraseCaptionFrames for why this must happen per slice rather
    // than once for the whole phrase.
    const sliceParams = resolvePhraseParams(params, phrase, slice.start);
    const sliceCssConfig = sliceParams === params ? cssConfig : getCSSPreviewFromConfig(sliceParams);
    drawRollingStackFrameForExport(ctx, {
      canvasWidth,
      canvasHeight,
      windowChunks: slice.chunks,
      currentTime: slice.start,
      cssConfig: sliceCssConfig,
      params: sliceParams,
      alignment: sliceParams.rollingStackAlignment,
      createOffscreenCanvas: (w, h) => createCanvas(w, h)
    });

    const file = path.join(outDir, `slice-${Math.round(slice.start * 1000)}.png`);
    fs.writeFileSync(file, canvas.toBuffer('image/png'));

    return { start: slice.start, end: slice.end, file };
  });
}

/**
 * Word Mode's frame generator — export counterpart to Word Mode's preview
 * path (see src/js/components/preview.js's syncVideoSubtitles), which draws
 * the SAME sentence-mode renderer fed a synthetic one-word "phrase" rather
 * than a separate renderer, so export can't visually disagree with preview.
 * Slices `phrase` into one single-word mini-phrase per transcript word
 * (each spanning just that word's own [start, end)) and renders each via
 * generatePhraseCaptionFrames — since only one word is ever on screen at a
 * time in this mode, unlike sentence mode's one-PNG-per-boundary-slice.
 *
 * @param {object} phrase - { start, end, words: [{word|text, start, end, isKeyword?, wordIndex}] }
 * @param {object} params
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {string} outDir
 * @returns {{start:number, end:number, file:string}[]}
 */
export function generateWordModePhraseFrames(phrase, params, canvasWidth, canvasHeight, outDir) {
  return phrase.words.flatMap((w) => {
    const singleWordPhrase = { words: [w], breakAfterIndices: [], start: w.start, end: w.end };
    // Pass the REAL (multi-word) phrase as the transform-key phrase — a
    // phrase-level override/keyframe must resolve under the same
    // getPhraseTransformKey the live preview uses, which always keys off
    // the real phrase in Word Mode too (see preview.js's syncVideoSubtitles,
    // which resolves phrase params from the real `activePhrase` BEFORE
    // branching into Word Mode's synthetic single-word rendering).
    return generatePhraseCaptionFrames(singleWordPhrase, params, canvasWidth, canvasHeight, outDir, phrase);
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
/**
 * Re-renders whichever segments a manually placed caption / text overlay
 * overlaps, so the two end up composited into ONE png per slice.
 *
 * This runs as a POST-PASS over the caption segments rather than as a rewrite
 * of the slicer above, for two reasons. First, the compositor
 * (graphicsCompositor.js) plays segments back-to-back purely by declared
 * duration and has no notion of absolute time — so there is exactly one
 * caption-track stream, and overlapping content has to be flattened into the
 * same picture rather than added as a parallel track. Second, a project with
 * no text elements must keep producing byte-identical frames, which it does
 * here by returning the original array untouched.
 *
 * Splitting matters: a text element's own start/end rarely line up with a
 * caption's word boundaries, so any segment it partially covers is cut at the
 * element's edges and only the covered part is redrawn.
 */
async function compositeTextElementsIntoSegments(segments, textElements, params, canvasWidth, canvasHeight, outDir) {
  const active = (textElements || []).filter((el) => el.enabled && String(el.text || '').trim());
  if (!active.length) return segments;

  registerBackendCanvasFonts();

  // Every instant at which the visible set changes — used to cut segments so
  // a redraw never spans a moment where text appears or disappears.
  const boundaries = getTextElementBoundaryTimes(active);
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // The caption raster already written for each segment, decoded once and
  // reused across every sub-slice cut out of it. loadImage is async (a
  // Buffer assigned straight to Image.src decodes to nothing here, silently),
  // which is the only reason this function and its caller are async.
  const captionImages = new Map();
  for (const segment of segments) {
    if (!captionImages.has(segment.file)) {
      captionImages.set(segment.file, await loadImage(segment.file));
    }
  }

  const out = [];
  for (const segment of segments) {
    const cuts = [segment.start, ...boundaries.filter((t) => t > segment.start && t < segment.end), segment.end]
      .sort((a, b) => a - b);

    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i];
      const end = cuts[i + 1];
      if (end - start < 0.001) continue;

      const visible = getActiveTextElements(active, start);
      if (!visible.length) {
        // Nothing of ours here — reuse the caption's own already-rendered png
        // rather than re-rasterising an identical frame.
        out.push({ start, end, file: segment.file });
        continue;
      }

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      // The caption that was already rendered for this slice goes down first,
      // so text composites ON TOP — the same z-order the preview uses (its
      // text layer sits above the captions canvas).
      const captionImage = captionImages.get(segment.file);
      if (captionImage) ctx.drawImage(captionImage, 0, 0);

      visible.forEach((element) => {
        const elementParams = { ...params, ...element.style };
        drawCaptionFrameForExport(ctx, {
          canvasWidth,
          canvasHeight,
          activePhrase: textElementToPhrase(element),
          currentTime: start,
          cssConfig: getCSSPreviewFromConfig(elementParams),
          params: elementParams,
          createOffscreenCanvas: (w, h) => createCanvas(w, h),
          clearCanvas: false
        });
      });

      const file = path.join(outDir, `text-${Math.round(start * 1000)}.png`);
      fs.writeFileSync(file, canvas.toBuffer('image/png'));
      out.push({ start, end, file });
    }
  }

  return out;
}

export async function buildFullTimelineSegments(phrases, params, canvasWidth, canvasHeight, videoDuration, outDir) {
  const blankFile = generateBlankFrame(canvasWidth, canvasHeight, outDir);
  const pushGap = (segments, start, end) => {
    if (end - start >= 0.001) segments.push({ start, end, file: blankFile });
  };

  // Caption mode is a global style setting, not per-phrase, so this is
  // resolved once and used for every phrase in the video.
  const cssConfig = getCSSPreviewFromConfig(params);
  const generatePhraseFrames = cssConfig.captionMode === 'rolling-stack'
    ? generateRollingStackPhraseFrames
    : cssConfig.captionMode === 'word'
    ? generateWordModePhraseFrames
    : generatePhraseCaptionFrames;

  const segments = [];
  let cursor = 0;

  [...phrases].sort((a, b) => a.start - b.start).forEach((phrase) => {
    pushGap(segments, cursor, phrase.start);
    // RAW params passed through unmerged — each generator resolves its own
    // phrase merge (once statically, once per slice) so phrase-level
    // keyframes can vary correctly across the phrase's own slices; see
    // generatePhraseCaptionFrames's doc comment for the full rationale.
    segments.push(...generatePhraseFrames(phrase, params, canvasWidth, canvasHeight, outDir));
    cursor = phrase.end;
  });
  pushGap(segments, cursor, videoDuration);

  // Manually placed captions + text overlays are flattened into these same
  // segments (see compositeTextElementsIntoSegments). A project with none
  // gets the original array back untouched.
  return compositeTextElementsIntoSegments(
    segments,
    normalizeTextElementList(params.textElements),
    params, canvasWidth, canvasHeight, outDir
  );
}
