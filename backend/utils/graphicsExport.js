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
  if (!canGenerateGraphicsFrames(params)) return false;
  if (!Array.isArray(words) || words.length === 0) return false;

  let phrases;
  try {
    phrases = sanitizePhraseTimings(groupWordsToPhrases({ words }));
  } catch (err) {
    console.error(`[GraphicsExport] Failed to group words into phrases, falling back to ASS: ${err.message}`);
    return false;
  }
  if (!phrases.length) return false;

  try {
    const { width, height, duration } = await getVideoInfo(videoPath);
    const segments = buildFullTimelineSegments(phrases, params, width, height, duration, framesDir);
    await compositeGraphicsCaptionTrack(videoPath, segments, outputVideoPath);
    console.log(`[GraphicsExport] Rendered ${segments.length} segments via the graphics pipeline (preset: ${params.preset || 'default'}).`);
    return true;
  } catch (err) {
    console.error(`[GraphicsExport] Graphics render failed, falling back to ASS: ${err.message}`);
    return false;
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
