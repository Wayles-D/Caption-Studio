/**
 * Production entry point for the shared graphics renderer's export path.
 * Wires together graphicsFrameGenerator.js (Layout/Timing + Graphics) and
 * graphicsCompositor.js (Compositing) into one call the upload/regenerate
 * controllers can try BEFORE falling back to the existing ASS/libass burn —
 * never instead of it. This is the one place that decides, per job, whether
 * the caption graphics pipeline is even attempted.
 *
 * Safety model: `canGenerateGraphicsFrames` gates on preset/mode scope (see
 * shared/captionGraphics.js's canDrawCaptionFrame) BEFORE anything is
 * rendered, and any failure during rendering/compositing is caught here and
 * reported as "not handled" rather than thrown — callers always have a
 * working fallback (the ASS pipeline) and a job can never fail outright
 * because the newer, less-exercised renderer hit a bug.
 */
import fs from 'fs';
import path from 'path';
import { canGenerateGraphicsFrames, buildFullTimelineSegments } from './graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack, getVideoInfo } from './graphicsCompositor.js';
import { groupWordsToPhrases, sanitizePhraseTimings } from './phraseGrouper.js';
import { getASSStyleFromConfig } from '../../shared/captionConfig.js';

/**
 * WHY this exists: every failure in this module degrades the job to the ASS
 * renderer, which silently drops video transforms AND caption transform
 * keyframes. The user only ever saw "the advanced renderer couldn't run this
 * time" while the actual cause — an ffmpeg filter-graph error, carrying the
 * real reason in its stderr tail — stayed buried in the server console. That
 * made a reproducible user-side failure effectively undiagnosable remotely.
 *
 * The reason is now recorded here and surfaced in the API response
 * (see uploadController.js's `graphicsFailureReason`) so a failing export
 * reports what actually broke instead of only that something did.
 */
let lastGraphicsFailure = null;

function recordFailure(stage, message, stack) {
  lastGraphicsFailure = { stage, message, stack: stack || null, at: new Date().toISOString() };
  return false;
}

/**
 * The reason the last `tryRenderCaptionsWithGraphics` call fell back, or null
 * if it succeeded. Read once per job by the controllers, right after the call.
 */
export function getLastGraphicsFailure() {
  return lastGraphicsFailure;
}

/**
 * Attempts to render captions for `videoPath` via the graphics pipeline.
 *
 * @param {string} videoPath - Absolute path to the source video.
 * @param {object[]} words - Flat, speaking-order word list (same shape groupWordsToPhrases expects).
 * @param {object} styles - Raw style params (same object passed to generateSubtitleFromTranscript's options.styles).
 * @param {string} outputVideoPath - Absolute path to write the rendered video to.
 * @param {string} framesDir - Absolute path for this job's scratch PNG directory (removed before returning, success or failure).
 * @returns {Promise<boolean>} true if the graphics pipeline produced outputVideoPath — caller should skip the ASS burn. false if the caller must fall back to the ASS pipeline (unsupported preset/mode, or a rendering failure).
 */
export async function tryRenderCaptionsWithGraphics(videoPath, words, styles, outputVideoPath, framesDir) {
  const params = styles || {};
  lastGraphicsFailure = null;
  if (!canGenerateGraphicsFrames(params)) {
    return recordFailure('unsupported-scope', `Preset/mode outside the graphics renderer's scope (captionMode='${params.captionMode}', preset='${params.preset || params.currentPreset}').`);
  }
  if (!Array.isArray(words) || words.length === 0) {
    return recordFailure('no-words', 'No words supplied to render.');
  }

  let phrases;
  try {
    phrases = sanitizePhraseTimings(groupWordsToPhrases({ words }));
  } catch (err) {
    console.error(`[GraphicsExport] Failed to group words into phrases, falling back to ASS: ${err.message}`, err.stack);
    return recordFailure('phrase-grouping', err.message, err.stack);
  }
  if (!phrases.length) return recordFailure('no-phrases', 'Word list produced no renderable phrases.');

  try {
    const { width, height, duration, hasAudio } = await getVideoInfo(videoPath);
    const segments = buildFullTimelineSegments(phrases, params, width, height, duration, framesDir);
    // The VIDEO's own keyframed transform (see shared/videoTransform.js) —
    // passed through so the exported file reproduces the same zoom/pan/
    // rotate/fade the live preview shows, independent of captions. The
    // resolved text blend mode (shared/captionConfig.js's own single source
    // of truth, same resolver the preview's getCSSPreviewFromConfig call
    // uses) is passed through the same way, so the exported file's caption
    // compositing matches the live preview exactly.
    await compositeGraphicsCaptionTrack(videoPath, segments, outputVideoPath, {
      videoTransform: params.videoTransform,
      duration,
      canvasWidth: width,
      canvasHeight: height,
      textBlendMode: getASSStyleFromConfig(params).textBlendMode,
      // The audio timeline (sound effects + imported audio tracks — see
      // shared/audioTimeline.js). Passed through the same way videoTransform
      // above is, so the exported file's audio is resolved from the exact
      // data the live preview schedules its playback from.
      audio: params.audio,
      hasSourceAudio: hasAudio
    });
    console.log(`[GraphicsExport] Rendered ${segments.length} segments via the graphics pipeline (preset: ${params.preset || 'default'}).`);
    return true;
  } catch (err) {
    // The full stack (not just err.message) is the whole point of this log
    // line — this catch is the ONLY place a graphics-render bug ever
    // surfaces (see this function's own doc comment: failures here are
    // swallowed and silently degrade to the ASS pipeline, which can't
    // reproduce caption transform keyframes or text blend mode at all), so
    // without it a real bug here is unfindable from logs alone.
    console.error(`[GraphicsExport] Graphics render failed, falling back to ASS: ${err.message}`);
    console.error(err.stack);
    // Also reported back to the client — see recordFailure's doc comment on why
    // console-only was not enough to diagnose this remotely.
    return recordFailure('render', err.message, err.stack);
  } finally {
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.error(`[GraphicsExport] Failed to remove scratch frames dir ${framesDir}: ${cleanupErr.message}`);
    }
  }
}

/**
 * Where a job's scratch caption-frame PNGs live — outside the output/
 * uploads/transcripts/subtitles dirs cleanup.js already sweeps, so it's
 * exposed here for the controllers to pass in and for cleanup.js's orphan
 * sweep to also cover (see runPeriodicCleanup).
 */
export function graphicsFramesDirFor(baseOutputDir, baseName) {
  return path.join(baseOutputDir, `${baseName}_graphics_frames`);
}
