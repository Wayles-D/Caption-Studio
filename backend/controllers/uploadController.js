import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAudio, burnSubtitles } from '../utils/ffmpeg.js';
import { transcribeAudio } from '../services/whisperService.js';
import { generateSubtitleFromTranscript, generateUnifiedShadowSubtitle } from '../services/subtitleService.js';
import { resolveASSStyle } from '../utils/assWriter.js';
import { analyzeTranscript } from '../services/keywordAnalysisService.js';
import { groupWordsToPhrases } from '../utils/phraseGrouper.js';
import { cleanupJobAssets } from '../utils/cleanup.js';
import { tryRenderCaptionsWithGraphics, graphicsFramesDirFor, getLastGraphicsFailure } from '../utils/graphicsExport.js';
import { getVideoInfo, getAudioInfo } from '../utils/graphicsCompositor.js';
import { normalizeAudioTimeline, hasAnyAudio } from '../../shared/audioTimeline.js';

/**
 * Everything the ASS/libass fallback burn needs to mix the audio timeline
 * itself (see backend/utils/ffmpeg.js's burnSubtitles). The graphics path
 * already probed the video, so this only runs on the fallback branch — and
 * only when there is actually audio to mix, so an export with no audio edits
 * pays for no extra probe at all.
 *
 * Returning `{}` on any failure is deliberate: a probe that didn't work must
 * degrade to "burn the captions without the audio mix", never fail the render.
 */
async function resolveFallbackAudioOptions(videoPath, styles) {
  const audio = normalizeAudioTimeline(styles?.audio);
  if (!hasAnyAudio(audio)) return {};
  try {
    const { duration, hasAudio } = await getVideoInfo(videoPath);
    return { audio, duration, hasSourceAudio: hasAudio };
  } catch (err) {
    console.warn(`[Pipeline] Could not probe video for the audio mix, burning captions without it: ${err.message}`);
    return {};
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const activeJobIds = new Set();
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

function getMaxConcurrentJobs() {
  const configuredLimit = Number.parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);
  return Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 2;
}

/**
 * Extracts the flat, speaking-order word list from a Whisper transcription
 * payload, whether words live at the top level or nested inside segments.
 */
function extractFlatWords(transcriptionJSON) {
  if (transcriptionJSON.words && Array.isArray(transcriptionJSON.words)) {
    return transcriptionJSON.words;
  }
  const words = [];
  if (transcriptionJSON.segments) {
    for (const seg of transcriptionJSON.segments) {
      if (seg.words && Array.isArray(seg.words)) {
        words.push(...seg.words);
      }
    }
  }
  return words;
}

/**
 * Merges a flat, enriched word list (same length/order as extractFlatWords
 * produced) back into the transcription payload, matching whichever shape
 * (top-level words vs. per-segment words) the payload originally used.
 */
function mergeWordsIntoTranscription(transcriptionJSON, enrichedWords) {
  if (transcriptionJSON.words && Array.isArray(transcriptionJSON.words)) {
    transcriptionJSON.words = enrichedWords;
    return;
  }
  if (transcriptionJSON.segments) {
    let cursor = 0;
    for (const seg of transcriptionJSON.segments) {
      if (seg.words && Array.isArray(seg.words)) {
        seg.words = enrichedWords.slice(cursor, cursor + seg.words.length);
        cursor += seg.words.length;
      }
    }
  }
}


// Ensure output, transcripts and subtitles directories exist
const outputDir = path.join(__dirname, '../output');
const transcriptsDir = path.join(__dirname, '../transcripts');
const subtitlesDir = path.join(__dirname, '../subtitles');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
if (!fs.existsSync(transcriptsDir)) {
  fs.mkdirSync(transcriptsDir, { recursive: true });
}
if (!fs.existsSync(subtitlesDir)) {
  fs.mkdirSync(subtitlesDir, { recursive: true });
}

/**
 * Handles the video upload, triggers FFmpeg audio extraction,
 * sends audio WAV to Whisper API, records output json,
 * compiles ASS karaoke subtitles, burns subtitles into video,
 * and cleans up temporary files.
 */
export async function uploadAndExtractAudio(req, res, next) {
  const videoFile = req.file;

  if (!videoFile) {
    return res.status(400).json({
      success: false,
      message: 'No video file provided or file rejected by validations.'
    });
  }

  const videoPath = videoFile.path;
  const videoFilename = videoFile.filename;
  // Use the same base UUID for files
  const baseName = path.parse(videoFilename).name;
  const audioFilename = `${baseName}.wav`;
  const audioPath = path.join(outputDir, audioFilename);
  const transcriptFilename = `${baseName}.json`;
  const transcriptPath = path.join(transcriptsDir, transcriptFilename);
  const subtitleFilename = `${baseName}.ass`;
  const subtitlePath = path.join(subtitlesDir, subtitleFilename);
  const renderedVideoFilename = `${baseName}_captioned.mp4`;
  const renderedVideoPath = path.join(outputDir, renderedVideoFilename);

  if (activeJobIds.size >= getMaxConcurrentJobs()) {
    cleanupJobAssets(baseName);
    return res.status(503).json({
      success: false,
      message: 'The processing queue is full. Please try again shortly.'
    });
  }

  console.log(`[Pipeline] [${baseName}] Processing media pipeline:\n  Video: ${videoPath}\n  Audio: ${audioPath}\n  Transcript: ${transcriptPath}\n  Subtitles: ${subtitlePath}\n  Rendered: ${renderedVideoPath}`);

  activeJobIds.add(baseName);

  let activeProc = null;
  let isRequestFinished = false;

  // Handle client request cancellation/abort during upload/processing
  req.on('aborted', () => {
    if (!isRequestFinished) {
      console.log(`[Pipeline] [${baseName}] Warning: Client request aborted before completion. Initiating cleanup...`);
      if (activeProc) {
        try {
          activeProc.kill('SIGKILL');
          console.log(`[Pipeline] [${baseName}] Signal sent: Killed active FFmpeg child process.`);
        } catch (killErr) {
          console.error(`[Pipeline] [${baseName}] Error killing FFmpeg process:`, killErr.message);
        }
      }
      cleanupJobAssets(baseName);
    }
  });

  try {
    // 1. Extract audio from video file using local FFmpeg
    console.log(`[Pipeline] [${baseName}] Stage: Audio Extraction Started`);
    const audioExtractStart = Date.now();
    await extractAudio(videoPath, audioPath, {
      onSpawn: (proc) => { activeProc = proc; }
    });
    console.log(`[Pipeline] [${baseName}] Stage: Audio Extraction Completed (Duration: ${Date.now() - audioExtractStart}ms)`);
    activeProc = null;

    // 2. Send audio file to Whisper-compatible transcription service
    console.log(`[Pipeline] [${baseName}] Stage: Whisper Request Started`);
    const whisperStart = Date.now();
    const transcriptionJSON = await transcribeAudio(audioPath);
    console.log(`[Pipeline] [${baseName}] Stage: Whisper Request Completed (Duration: ${Date.now() - whisperStart}ms)`);

    // 3. Extract flat word-level data, run AI keyword emphasis tagging (best-effort,
    // never fails the pipeline), and merge the enriched words back into the
    // transcription payload before anything downstream reads it.
    let words = extractFlatWords(transcriptionJSON);

    console.log(`[Pipeline] [${baseName}] Stage: AI Content Analysis Started`);
    const keywordAnalysisStart = Date.now();
    // ONE analysis pass now produces three things: emphasis keywords (as
    // before), semantic content events, and suggested visual moments — see
    // keywordAnalysisService.js's analyzeTranscript. The events carry
    // timestamps already resolved from this transcript's own word timings, so
    // the editor never has to reconcile two clocks.
    const analysis = await analyzeTranscript(words);
    words = analysis.words;
    const contentEvents = analysis.contentEvents;
    const visualSuggestions = analysis.visualSuggestions;
    console.log(`[Pipeline] [${baseName}] Stage: AI Content Analysis Completed (Duration: ${Date.now() - keywordAnalysisStart}ms)`);

    mergeWordsIntoTranscription(transcriptionJSON, words);
    // Persisted alongside the words so a later /regenerate (which reads this
    // file) still has the analysis without paying for another model call.
    transcriptionJSON.contentEvents = contentEvents;
    transcriptionJSON.visualSuggestions = visualSuggestions;

    // 4. Save raw transcription JSON output (now enriched with keyword metadata)
    console.log(`[Pipeline] [${baseName}] Stage: Saving Transcript JSON...`);
    fs.writeFileSync(transcriptPath, JSON.stringify(transcriptionJSON, null, 2));
    console.log(`[Pipeline] [${baseName}] Stage: Transcripts saved`);

    // 5. Generate Advanced SubStation Alpha (.ass) style subtitles
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Generation Started`);
    const subtitleStart = Date.now();
    await generateSubtitleFromTranscript(transcriptPath, subtitlePath, { styles: req.body });
    // Only written when Style & Colors > Shadow Mode is 'unified' — a
    // separate silhouette track burnSubtitles composites as one blurred/
    // offset layer beneath the real captions (see ffmpeg.js).
    const shadowSubtitlePath = path.join(subtitlesDir, `${baseName}.shadow.ass`);
    await generateUnifiedShadowSubtitle(transcriptPath, shadowSubtitlePath, { styles: req.body });
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Generation Completed (Duration: ${Date.now() - subtitleStart}ms)`);

    // 6. Render the final captioned video. For presets/modes the shared
    // graphics renderer already covers (see shared/captionGraphics.js's
    // canDrawCaptionFrame), try that first — it composites the same PNGs
    // validated against this ASS pipeline during the graphics-renderer
    // migration. Any gap in scope, or any failure, falls straight back to
    // the existing ASS/libass burn below, unchanged.
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Rendering Started`);
    const renderStart = Date.now();
    const resolvedStyle = resolveASSStyle(req.body || {});
    const usedGraphicsRenderer = await tryRenderCaptionsWithGraphics(
      videoPath, words, req.body, renderedVideoPath, graphicsFramesDirFor(outputDir, baseName)
    );
    if (!usedGraphicsRenderer) {
      // The legacy ASS/libass burn has no blend-mode compositing support
      // (see graphicsCompositor.js's buildCaptionCompositeStages, which is
      // the only place this feature is implemented) — surfacing this in the
      // logs rather than silently dropping it, since this fallback is only
      // reached when the graphics pipeline is unsupported or throws.
      if (resolvedStyle.textBlendMode && resolvedStyle.textBlendMode !== 'normal') {
        console.warn(`[Pipeline] [${baseName}] Text Blend Mode '${resolvedStyle.textBlendMode}' requested but falling back to the ASS/libass pipeline, which does not support it — captions will render opaque.`);
      }
      await burnSubtitles(videoPath, subtitlePath, renderedVideoPath, {
        onSpawn: (proc) => { activeProc = proc; },
        shadowAssPath: resolvedStyle.shadowMode === 'unified' && fs.existsSync(shadowSubtitlePath) ? shadowSubtitlePath : null,
        unifiedShadow: resolvedStyle.unifiedShadow,
        // The audio timeline is mixed on THIS path too, so falling back to the
        // ASS renderer never silently drops the user's sound effects.
        ...(await resolveFallbackAudioOptions(videoPath, req.body))
      });
    }
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Rendering Completed (${usedGraphicsRenderer ? 'graphics' : 'ass'} pipeline, Duration: ${Date.now() - renderStart}ms)`);
    activeProc = null;

    // Clean up large intermediate temporary files - only WAV audio (video is retained for re-rendering)
    if (process.env.KEEP_TEMP_FILES !== 'true') {
      try {
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        console.log(`[Pipeline] [${baseName}] Cleaned up temporary audio file: ${audioFilename}`);
      } catch (err) {
        console.error(`[Pipeline] [${baseName}] Failed to delete audio file:`, err.message);
      }
    }

    // Mark completion to prevent client connection close handler from wiping files
    isRequestFinished = true;

    // Return localized relative paths for convenience
    const backendRoot = path.join(__dirname, '..');
    const relativeVideoPath = path.relative(backendRoot, videoPath);
    const relativeAudioPath = path.relative(backendRoot, audioPath);
    const relativeTranscriptPath = path.relative(backendRoot, transcriptPath);
    const relativeSubtitlePath = path.relative(backendRoot, subtitlePath);
    const relativeRenderedVideoPath = `/${path.relative(backendRoot, renderedVideoPath).replace(/\\/g, '/')}`;

    // Generate phrases from words for single source of truth captioning
    const phrases = groupWordsToPhrases(transcriptionJSON);

    const responsePayload = {
      success: true,
      message: 'Video processed, transcribing completed, subtitles compiled and burned successfully.',
      baseName,
      videoPath: relativeVideoPath.replace(/\\/g, '/'),
      audioPath: relativeAudioPath.replace(/\\/g, '/'),
      transcriptPath: relativeTranscriptPath.replace(/\\/g, '/'),
      subtitlePath: relativeSubtitlePath.replace(/\\/g, '/'),
      renderedVideoPath: relativeRenderedVideoPath,
      transcription: transcriptionJSON,
      words,
      phrases,
      // What the speech is DOING, as semantic moments with timestamps already
      // resolved from the word timings above (see analyzeTranscript). The
      // editor — not the model — decides which sound, if any, each of these
      // produces; see shared/soundProfiles.js.
      contentEvents,
      // Moments a supporting image would help. Surfaced as empty slots for the
      // user to fill; nothing is ever placed into one automatically.
      visualSuggestions,
      // Lets the frontend warn the user when caption transform keyframes
      // (position/rotation/scale) and text blend mode silently couldn't
      // reach this render — those only exist in the graphics pipeline (see
      // tryRenderCaptionsWithGraphics's own doc comment); the ASS/libass
      // fallback it swaps to on any failure renders plain, un-transformed
      // captions with no way to tell from the video alone that it happened.
      renderedWithEffects: usedGraphicsRenderer,
      // When the graphics renderer bailed, WHY — see graphicsExport.js's
      // recordFailure: the real cause used to reach the server console only.
      graphicsFailureReason: usedGraphicsRenderer ? null : getLastGraphicsFailure()
    };

    console.log(`[Pipeline] [${baseName}] Returning response payload keys:`, Object.keys(responsePayload));
    return res.status(200).json(responsePayload);

  } catch (error) {
    isRequestFinished = true;
    console.error(`[Pipeline] [${baseName}] Step Failure: Execution error in pipeline: ${error.message}`);
    
    // Immediate cleanup on error path
    cleanupJobAssets(baseName);
    next(error);
  } finally {
    activeJobIds.delete(baseName);
  }
}

/**
 * Receives one imported audio file (music, ambience, voiceover) and returns
 * the `assetId` the export pipeline will later resolve to a real path.
 *
 * WHY AN UPLOAD IS REQUIRED AT ALL. The preview decodes the file locally from
 * a blob URL and would work perfectly without ever contacting the server —
 * which is precisely the trap: the export runs server-side and cannot read a
 * blob URL, so a track that was never uploaded would sound correct in the
 * editor and be silently missing from the downloaded MP4. The client treats a
 * failure here as "the import failed" and creates no clip at all, rather than
 * leaving one that can only ever be heard in the preview.
 *
 * The duration is probed with the same FFmpeg banner read used for video, so
 * a browser that can't decode the format (FFmpeg's format support is much
 * broader than the Web Audio API's) still gets a usable clip length.
 */
export async function uploadAudioAsset(req, res) {
  const audioFile = req.file;

  if (!audioFile) {
    return res.status(400).json({
      success: false,
      message: 'No audio file provided or file rejected by validations.'
    });
  }

  let duration = null;
  try {
    ({ duration } = await getAudioInfo(audioFile.path));
  } catch (err) {
    // Not fatal: the client reads the decoded buffer's own duration too, and
    // an untrimmed clip exports correctly without a declared length.
    console.warn(`[AudioUpload] Could not probe duration for ${audioFile.filename}: ${err.message}`);
  }

  console.log(`[AudioUpload] Stored "${audioFile.originalname}" as ${audioFile.filename} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB${duration ? `, ${duration.toFixed(2)}s` : ''}).`);

  return res.status(200).json({
    success: true,
    assetId: audioFile.filename,
    name: audioFile.originalname,
    duration
  });
}

/**
 * Re-runs the transcript content analysis on demand, without re-transcribing
 * or re-rendering.
 *
 * This is the SAME single analysis pass the upload pipeline runs (same
 * service, same prompt) — it exists because the user needs a way to ask for
 * automatic sound effects on a project where the analysis hadn't run, or
 * hadn't succeeded, without re-uploading the video. Keyword tags come back
 * too; the caller decides whether to use them.
 */
export async function analyzeContent(req, res) {
  const { words } = req.body;

  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ success: false, message: 'words array is required and must not be empty.' });
  }

  const analysis = await analyzeTranscript(words);
  return res.status(200).json({
    success: true,
    words: analysis.words,
    contentEvents: analysis.contentEvents,
    visualSuggestions: analysis.visualSuggestions
  });
}

/**
 * Endpoint to explicitly trigger cleanup of the active workspace job.
 */
export async function workspaceCleanup(req, res) {
  const { baseName } = req.body;

  if (!isValidJobId(baseName)) {
    return res.status(400).json({ success: false, message: 'A valid job ID is required.' });
  }

  if (activeJobIds.has(baseName)) {
    return res.status(409).json({ success: false, message: 'The job is still processing and cannot be cleaned up.' });
  }

  cleanupJobAssets(baseName);
  return res.status(200).json({ success: true, message: 'Workspace cleaned up successfully.' });
}

/**
 * Handles transcript re-generation requests.
 * Accepts edited words array and style parameters, regenerates ASS subtitles,
 * and re-burns them into the original uploaded video without re-transcribing.
 */
export async function regenerateCaptions(req, res, next) {
  const { baseName, words, styles } = req.body;

  if (!baseName) {
    return res.status(400).json({ success: false, message: 'baseName is required.' });
  }

  if (!isValidJobId(baseName)) {
    return res.status(400).json({ success: false, message: 'baseName must be a valid job ID.' });
  }

  if (!words || !Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ success: false, message: 'words array is required and must not be empty.' });
  }

  const transcriptPath = path.join(transcriptsDir, `${baseName}.json`);
  const subtitlePath = path.join(subtitlesDir, `${baseName}.ass`);
  const renderedVideoPath = path.join(outputDir, `${baseName}_captioned.mp4`);

  // We need the original uploaded video to re-burn subtitles.
  // Check if it still exists in uploads, otherwise check if it was already cleaned up
  const uploadsDir = path.join(__dirname, '../uploads');
  let videoPath = path.join(uploadsDir, `${baseName}.mp4`);

  // If the original upload was cleaned, we cannot re-render
  if (!fs.existsSync(videoPath)) {
    // Try to find it with other extensions
    const extensions = ['.mov', '.webm'];
    let found = false;
    for (const ext of extensions) {
      const altPath = path.join(uploadsDir, `${baseName}${ext}`);
      if (fs.existsSync(altPath)) {
        videoPath = altPath;
        found = true;
        break;
      }
    }
    if (!found) {
      return res.status(400).json({
        success: false,
        message: 'Original video file not found. Please re-upload the video first.'
      });
    }
  }

  if (activeJobIds.has(baseName)) {
    return res.status(409).json({ success: false, message: 'This job is already being processed.' });
  }
  activeJobIds.add(baseName);

  console.log(`[Regenerate] Starting caption regeneration for job: ${baseName}`);

  let activeProc = null;
  let isRequestFinished = false;

  req.on('aborted', () => {
    if (!isRequestFinished) {
      console.log(`[Regenerate] [${baseName}] Client aborted regeneration request.`);
      if (activeProc) {
        try { activeProc.kill('SIGKILL'); } catch (e) {}
      }
    }
  });

  try {
    // 1. Save the edited words back to the transcript file for persistence.
    // The content analysis (semantic events / visual suggestions) stored by
    // the original upload is carried across rather than overwritten — it
    // describes the same speech, it cost a model call to produce, and
    // re-rendering with a different font has no bearing on it.
    let previousAnalysis = {};
    try {
      const previous = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (previous.contentEvents) previousAnalysis.contentEvents = previous.contentEvents;
      if (previous.visualSuggestions) previousAnalysis.visualSuggestions = previous.visualSuggestions;
    } catch {
      // No prior transcript (or unreadable) — nothing to carry over.
    }
    const editedTranscript = { words, ...previousAnalysis };
    fs.writeFileSync(transcriptPath, JSON.stringify(editedTranscript, null, 2));
    console.log(`[Regenerate] [${baseName}] Updated transcript JSON with ${words.length} edited words.`);

    // 2. Regenerate ASS subtitles from edited words with style parameters
    console.log(`[Regenerate] [${baseName}] Stage: Subtitle Regeneration Started`);
    const subtitleStart = Date.now();
    await generateSubtitleFromTranscript(transcriptPath, subtitlePath, { words, styles });
    const shadowSubtitlePath = path.join(subtitlesDir, `${baseName}.shadow.ass`);
    await generateUnifiedShadowSubtitle(transcriptPath, shadowSubtitlePath, { words, styles });
    console.log(`[Regenerate] [${baseName}] Stage: Subtitle Regeneration Completed (Duration: ${Date.now() - subtitleStart}ms)`);

    // 3. Re-render into the original video. Same graphics-first, ASS-fallback
    // policy as the initial upload pipeline (see uploadAndExtractAudio).
    console.log(`[Regenerate] [${baseName}] Stage: Video Re-Rendering Started`);
    const renderStart = Date.now();
    const resolvedStyle = resolveASSStyle(styles || {});
    const usedGraphicsRenderer = await tryRenderCaptionsWithGraphics(
      videoPath, words, styles, renderedVideoPath, graphicsFramesDirFor(outputDir, baseName)
    );
    if (!usedGraphicsRenderer) {
      if (resolvedStyle.textBlendMode && resolvedStyle.textBlendMode !== 'normal') {
        console.warn(`[Regenerate] [${baseName}] Text Blend Mode '${resolvedStyle.textBlendMode}' requested but falling back to the ASS/libass pipeline, which does not support it — captions will render opaque.`);
      }
      await burnSubtitles(videoPath, subtitlePath, renderedVideoPath, {
        onSpawn: (proc) => { activeProc = proc; },
        shadowAssPath: resolvedStyle.shadowMode === 'unified' && fs.existsSync(shadowSubtitlePath) ? shadowSubtitlePath : null,
        unifiedShadow: resolvedStyle.unifiedShadow,
        // See the matching call in uploadAndExtractAudio: the audio timeline
        // is mixed on the fallback path too, so a fallback can't silently
        // strip the sound effects out of the export.
        ...(await resolveFallbackAudioOptions(videoPath, styles))
      });
    }
    console.log(`[Regenerate] [${baseName}] Stage: Video Re-Rendering Completed (${usedGraphicsRenderer ? 'graphics' : 'ass'} pipeline, Duration: ${Date.now() - renderStart}ms)`);
    activeProc = null;

    isRequestFinished = true;

    const backendRoot = path.join(__dirname, '..');
    const relativeRenderedVideoPath = `/${path.relative(backendRoot, renderedVideoPath).replace(/\\/g, '/')}`;

    // Generate updated phrases for the frontend single source of truth preview
    const phrases = groupWordsToPhrases(editedTranscript);

    const responsePayload = {
      success: true,
      message: 'Captions regenerated and video re-rendered successfully.',
      renderedVideoPath: relativeRenderedVideoPath,
      phrases,
      // See the matching field on the initial-upload response above —
      // false means caption transform keyframes/blend mode were silently
      // dropped this render (ASS fallback).
      renderedWithEffects: usedGraphicsRenderer,
      // When the graphics renderer bailed, WHY — see graphicsExport.js's
      // recordFailure: the real cause used to reach the server console only.
      graphicsFailureReason: usedGraphicsRenderer ? null : getLastGraphicsFailure()
    };

    console.log(`[Regenerate] [${baseName}] Returning response payload keys:`, Object.keys(responsePayload));
    return res.status(200).json(responsePayload);

  } catch (error) {
    isRequestFinished = true;
    console.error(`[Regenerate] [${baseName}] Error: ${error.message}`);
    next(error);
  } finally {
    activeJobIds.delete(baseName);
  }
}
