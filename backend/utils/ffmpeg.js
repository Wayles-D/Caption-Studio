import { spawn } from 'child_process';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

/**
 * Extracts audio from a video file and converts it to a standard WAV format:
 * - WAV container (pcm_s16le)
 * - Mono (1 channel)
 * - 16kHz sample rate
 * - PCM 16-bit
 * 
 * @param {string} inputPath - Absolute path to the uploaded video file.
 * @param {string} outputPath - Absolute path where the extracted wav file will be saved.
 * @returns {Promise<string>} Resolves with the outputPath if successful.
 */
export function extractAudio(inputPath, outputPath) {
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

    let stderrData = '';

    ffmpegProc.stdout.on('data', (data) => {
      // ffmpeg writes most logs to stderr, but we capture stdout just in case
      console.log(`FFmpeg stdout: ${data}`);
    });

    ffmpegProc.stderr.on('data', (data) => {
      stderrData += data.toString();
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
        console.error(`FFmpeg process exited with code ${code}`);
        console.error(`FFmpeg error details:\n${stderrData}`);
        reject(new Error(`FFmpeg processing failed with exit code ${code}. Details: ${stderrData.slice(-500)}`));
      }
    });
  });
}
