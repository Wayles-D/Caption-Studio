import { spawn } from 'child_process';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

/**
 * Format bytes into MB.
 */
function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Format memory usage output.
 */
function formatMemory(mem) {
  return `RSS: ${formatBytes(mem.rss)} | Heap: ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`;
}

/**
 * Extracts audio from a video file and converts it to a standard WAV format:
 * - WAV container (pcm_s16le)
 * - Mono (1 channel)
 * - 16kHz sample rate
 * - PCM 16-bit
 * 
 * @param {string} inputPath - Absolute path to the uploaded video file.
 * @param {string} outputPath - Absolute path where the extracted wav file will be saved.
 * @param {object} options - Options containing callbacks like onSpawn.
 * @returns {Promise<string>} Resolves with the outputPath if successful.
 */
export function extractAudio(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    // Check if ffmpeg-static resolved the path
    if (!ffmpegPath) {
      return reject(new Error('FFmpeg static binary path could not be resolved by ffmpeg-static package.'));
    }

    // Arguments:
    // -y            Overwrite output files without asking
    // -i inputPath  Input file
    // -vn           Disable video recording/output
    // -acodec pcm_s16le Force 16-bit PCM codec
    // -ar 16000     Set audio sample rate to 16000 Hz
    // -ac 1         Set audio channels to 1 (mono)
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      outputPath
    ];

    console.log(`Executing FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);

    const ffmpegProc = spawn(ffmpegPath, args);
    if (options.onSpawn) {
      options.onSpawn(ffmpegProc);
    }

    const stderrLines = [];

    ffmpegProc.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpegProc.stderr.on('data', (data) => {
      const text = data.toString();
      // Keep output rolling in memory to avoid unbounded memory growth
      const newLines = text.split('\n');
      stderrLines.push(...newLines);
      if (stderrLines.length > 50) {
        stderrLines.splice(0, stderrLines.length - 50);
      }
    });

    ffmpegProc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('FFmpeg executable not found. Please ensure FFmpeg is installed and added to the system PATH.'));
      } else {
        reject(err);
      }
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        const errorSummary = stderrLines.join('\n');
        console.error(`FFmpeg process exited with code ${code}`);
        console.error(`FFmpeg error details:\n${errorSummary}`);
        reject(new Error(`FFmpeg processing failed with exit code ${code}. Details: ${errorSummary.slice(-500)}`));
      }
    });
  });
}

/**
 * Burns an ASS subtitle file into a video file using FFmpeg and libass.
 * 
 * @param {string} inputVideoPath - Absolute path to the input video file.
 * @param {string} assPath - Absolute path to the ASS subtitles file.
 * @param {string} outputPath - Absolute path where the rendered video will be saved.
 * @param {object} options - Options containing callbacks like onSpawn.
 * @returns {Promise<string>} Resolves with the outputPath if successful.
 */
export function burnSubtitles(inputVideoPath, assPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error('FFmpeg static binary path could not be resolved.'));
    }

    // Use relative paths to avoid Windows colons (drive letters) and spaces in parent paths
    const relativeAssPath = path.relative(process.cwd(), assPath).replace(/\\/g, '/');
    
    // Set up filter argument
    // Use the ass filter. Wrap path in single quotes.
    const assFilter = `ass='${relativeAssPath}'`;

    // OPTIMIZED FFmpeg parameters:
    // -c:v libx264: Explicitly specify libx264 video encoder
    // -preset ultrafast: Use fastest encoding speed preset to minimize RAM/CPU footprints on Render
    // -crf 23: Balance visual quality compression ratio
    // -c:a copy: Directly copy audio streams without re-encoding to save RAM/CPU
    const args = [
      '-y',
      '-i', inputVideoPath,
      '-vf', assFilter,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'copy',
      outputPath
    ];

    console.log(`Executing FFmpeg Subtitle Burn command: ${ffmpegPath} ${args.join(' ')}`);

    const memBefore = process.memoryUsage();
    const startTime = Date.now();

    const ffmpegProc = spawn(ffmpegPath, args);
    if (options.onSpawn) {
      options.onSpawn(ffmpegProc);
    }

    const stderrLines = [];

    ffmpegProc.stdout.on('data', (data) => {
      console.log(`FFmpeg burn stdout: ${data.toString()}`);
    });

    ffmpegProc.stderr.on('data', (data) => {
      const text = data.toString();
      // Keep output rolling in memory to avoid unbounded memory growth
      const newLines = text.split('\n');
      stderrLines.push(...newLines);
      if (stderrLines.length > 50) {
        stderrLines.splice(0, stderrLines.length - 50);
      }
    });

    ffmpegProc.on('error', (err) => {
      reject(err);
    });

    ffmpegProc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const memAfter = process.memoryUsage();
      const rssDelta = memAfter.rss - memBefore.rss;

      console.log(`[FFmpeg Burn Metrics]
  Duration: ${duration}ms
  Exit Code: ${code}
  Memory Before: ${formatMemory(memBefore)}
  Memory After: ${formatMemory(memAfter)}
  Delta RSS: ${formatBytes(rssDelta)}
      `);

      if (code === 0) {
        resolve(outputPath);
      } else {
        const errorSummary = stderrLines.join('\n');
        console.error(`FFmpeg subtitle burn process exited with code ${code}`);
        console.error(`FFmpeg burn error details:\n${errorSummary}`);
        reject(new Error(`FFmpeg subtitle burning failed. Details: ${errorSummary.slice(-500)}`));
      }
    });
  });
}
