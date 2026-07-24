import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAudio, burnSubtitles } from '../utils/ffmpeg.js';
import { transcribeAudio } from '../services/whisperService.js';
import { generateSubtitleFromTranscript } from '../services/subtitleService.js';
import { groupWordsToPhrases } from '../utils/phraseGrouper.js';
import { cleanupJobAssets } from '../utils/cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single active workspace track across requests
let activeJobId = null;


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

  console.log(`[Pipeline] [${baseName}] Processing media pipeline:\n  Video: ${videoPath}\n  Audio: ${audioPath}\n  Transcript: ${transcriptPath}\n  Subtitles: ${subtitlePath}\n  Rendered: ${renderedVideoPath}`);

  // Purge any temporary assets from a previous job before starting
  if (activeJobId && activeJobId !== baseName) {
    console.log(`[Pipeline] Pre-upload Cleanup: Purging resources of previous job: ${activeJobId}`);
    cleanupJobAssets(activeJobId);
  }
  
  // Set current baseName as the active job workspace
  activeJobId = baseName;

  let activeProc = null;
  let isRequestFinished = false;

  // Handle client request cancellation/abort during upload/processing
  req.on('close', () => {
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

    // 3. Save raw transcription JSON output
    console.log(`[Pipeline] [${baseName}] Stage: Saving Transcript JSON...`);
    fs.writeFileSync(transcriptPath, JSON.stringify(transcriptionJSON, null, 2));
    console.log(`[Pipeline] [${baseName}] Stage: Transcripts saved`);

    // 4. Generate Advanced SubStation Alpha (.ass) style subtitles
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Generation Started`);
    const subtitleStart = Date.now();
    await generateSubtitleFromTranscript(transcriptPath, subtitlePath);
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Generation Completed (Duration: ${Date.now() - subtitleStart}ms)`);

    // 5. Burn subtitles into original uploaded video to create the final captioned video
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Rendering Started`);
    const renderStart = Date.now();
    await burnSubtitles(videoPath, subtitlePath, renderedVideoPath, {
      onSpawn: (proc) => { activeProc = proc; }
    });
    console.log(`[Pipeline] [${baseName}] Stage: Subtitle Rendering Completed (Duration: ${Date.now() - renderStart}ms)`);
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
    const relativeRenderedVideoPath = path.relative(backendRoot, renderedVideoPath);

    // Generate phrases from words for single source of truth captioning
    const phrases = groupWordsToPhrases(transcriptionJSON);

    // Return the required success payload including word-level data and phrases for editing/preview
    return res.status(200).json({
      success: true,
      message: 'Video processed, transcribing completed, subtitles compiled and burned successfully.',
      baseName,
      videoPath: relativeVideoPath.replace(/\\/g, '/'),
      audioPath: relativeAudioPath.replace(/\\/g, '/'),
      transcriptPath: relativeTranscriptPath.replace(/\\/g, '/'),
      subtitlePath: relativeSubtitlePath.replace(/\\/g, '/'),
      renderedVideoPath: relativeRenderedVideoPath.replace(/\\/g, '/'),
      transcription: transcriptionJSON,
      words,
      phrases
    });

  } catch (error) {
    isRequestFinished = true;
    console.error(`[Pipeline] [${baseName}] Step Failure: Execution error in pipeline: ${error.message}`);
    
    // Clear active job if current job failed
    if (activeJobId === baseName) {
      activeJobId = null;
    }

    // Immediate cleanup on error path
    cleanupJobAssets(baseName);
    next(error);
  }
}

/**
 * Endpoint to explicitly trigger cleanup of the active workspace job.
 */
export async function workspaceCleanup(req, res) {
  console.log(`[Workspace Cleanup] Explicit request to cleanup active job: ${activeJobId}`);
  if (activeJobId) {
    cleanupJobAssets(activeJobId);
    activeJobId = null;
    return res.status(200).json({
      success: true,
      message: 'Workspace cleaned up successfully.'
    });
  }
  return res.status(200).json({
    success: true,
    message: 'Workspace already clean.'
  });
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

  console.log(`[Regenerate] Starting caption regeneration for job: ${baseName}`);

  let activeProc = null;
  let isRequestFinished = false;

  req.on('close', () => {
    if (!isRequestFinished) {
      console.log(`[Regenerate] [${baseName}] Client aborted regeneration request.`);
      if (activeProc) {
        try { activeProc.kill('SIGKILL'); } catch (e) {}
      }
    }
  });

  try {
    // 1. Save the edited words back to the transcript file for persistence
    const editedTranscript = { words };
    fs.writeFileSync(transcriptPath, JSON.stringify(editedTranscript, null, 2));
    console.log(`[Regenerate] [${baseName}] Updated transcript JSON with ${words.length} edited words.`);

    // 2. Regenerate ASS subtitles from edited words with style parameters
    console.log(`[Regenerate] [${baseName}] Stage: Subtitle Regeneration Started`);
    const subtitleStart = Date.now();
    await generateSubtitleFromTranscript(transcriptPath, subtitlePath, { words, styles });
    console.log(`[Regenerate] [${baseName}] Stage: Subtitle Regeneration Completed (Duration: ${Date.now() - subtitleStart}ms)`);

    // 3. Re-burn subtitles into original video
    console.log(`[Regenerate] [${baseName}] Stage: Video Re-Rendering Started`);
    const renderStart = Date.now();
    await burnSubtitles(videoPath, subtitlePath, renderedVideoPath, {
      onSpawn: (proc) => { activeProc = proc; }
    });
    console.log(`[Regenerate] [${baseName}] Stage: Video Re-Rendering Completed (Duration: ${Date.now() - renderStart}ms)`);
    activeProc = null;

    isRequestFinished = true;

    const backendRoot = path.join(__dirname, '..');
    const relativeRenderedVideoPath = path.relative(backendRoot, renderedVideoPath).replace(/\\/g, '/');

    // Generate updated phrases for the frontend single source of truth preview
    const phrases = groupWordsToPhrases(editedTranscript);

    return res.status(200).json({
      success: true,
      message: 'Captions regenerated and video re-rendered successfully.',
      renderedVideoPath: relativeRenderedVideoPath,
      phrases
    });

  } catch (error) {
    isRequestFinished = true;
    console.error(`[Regenerate] [${baseName}] Error: ${error.message}`);
    next(error);
  }
}
