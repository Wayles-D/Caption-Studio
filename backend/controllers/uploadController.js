import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractAudio, burnSubtitles } from '../utils/ffmpeg.js';
import { transcribeAudio } from '../services/whisperService.js';
import { generateSubtitleFromTranscript } from '../services/subtitleService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  console.log(`Received video file upload: ${videoFilename}`);
  console.log(`Processing media pipeline:\n  Video: ${videoPath}\n  Audio: ${audioPath}\n  Transcript: ${transcriptPath}\n  Subtitles: ${subtitlePath}\n  Rendered: ${renderedVideoPath}`);

  try {
    // 1. Extract audio from video file using local FFmpeg
    await extractAudio(videoPath, audioPath);
    console.log(`Successfully extracted WAV audio: ${audioFilename}`);

    // 2. Send audio file to Whisper-compatible transcription service
    console.log(`Starting transcription for ${audioFilename}...`);
    const transcriptionJSON = await transcribeAudio(audioPath);

    // 3. Save raw transcription JSON output
    fs.writeFileSync(transcriptPath, JSON.stringify(transcriptionJSON, null, 2));
    console.log(`Saved transcription output: ${transcriptFilename}`);

    // 4. Generate Advanced SubStation Alpha (.ass) style subtitles
    console.log(`Compiling Advanced SubStation Alpha subtitles for ${baseName}...`);
    await generateSubtitleFromTranscript(transcriptPath, subtitlePath);
    console.log(`Successfully output subtitle file: ${subtitleFilename}`);

    // 5. Burn subtitles into original uploaded video to create the final captioned video
    console.log(`Burning subtitles into video for ${baseName}...`);
    await burnSubtitles(videoPath, subtitlePath, renderedVideoPath);
    console.log(`Successfully generated captioned video: ${renderedVideoFilename}`);

    // Clean up temporary video file after subtitles are burned
    if (process.env.KEEP_TEMP_FILES !== 'true') {
      fs.unlink(videoPath, (err) => {
        if (err) {
          console.error(`Failed to delete temporary video file at ${videoPath}:`, err);
        } else {
          console.log(`Cleaned up temporary video file: ${videoFilename}`);
        }
      });
    } else {
      console.log(`KEEP_TEMP_FILES is true. Preserved video file: ${videoFilename}`);
    }

    // Clean up audio file after successful transcription, subtitle compile & video render
    if (process.env.KEEP_TEMP_FILES !== 'true') {
      fs.unlink(audioPath, (err) => {
        if (err) {
          console.error(`Failed to delete temporary audio file at ${audioPath}:`, err);
        } else {
          console.log(`Cleaned up temporary audio file: ${audioFilename}`);
        }
      });
    }

    // Return localized relative paths for convenience
    const backendRoot = path.join(__dirname, '..');
    const relativeVideoPath = path.relative(backendRoot, videoPath);
    const relativeAudioPath = path.relative(backendRoot, audioPath);
    const relativeTranscriptPath = path.relative(backendRoot, transcriptPath);
    const relativeSubtitlePath = path.relative(backendRoot, subtitlePath);
    const relativeRenderedVideoPath = path.relative(backendRoot, renderedVideoPath);

    // Return the required success payload
    return res.status(200).json({
      success: true,
      message: 'Video processed, transcribing completed, subtitles compiled and burned successfully.',
      videoPath: relativeVideoPath.replace(/\\/g, '/'),
      audioPath: relativeAudioPath.replace(/\\/g, '/'),
      transcriptPath: relativeTranscriptPath.replace(/\\/g, '/'),
      subtitlePath: relativeSubtitlePath.replace(/\\/g, '/'),
      renderedVideoPath: relativeRenderedVideoPath.replace(/\\/g, '/'),
      transcription: transcriptionJSON
    });

  } catch (error) {
    console.error(`Execution error in pipeline: ${error.message}`);

    // CLEANUP: Unlink any temporary video or audio file on failure
    if (process.env.KEEP_TEMP_FILES !== 'true') {
      if (fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
          console.log(`Cleaned up temporary video file due to failure: ${videoFilename}`);
        } catch (unlinkErr) {
          console.error(`Failed to delete video file on failure:`, unlinkErr);
        }
      }
      if (fs.existsSync(audioPath)) {
        try {
          fs.unlinkSync(audioPath);
          console.log(`Cleaned up temporary audio file due to failure: ${audioFilename}`);
        } catch (unlinkErr) {
          console.error(`Failed to delete audio file on failure:`, unlinkErr);
        }
      }
    }

    next(error);
  }
}


