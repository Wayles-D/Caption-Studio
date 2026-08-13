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
 * Burns an ASS subtitle file into a video file using FFmpeg and libass. When
 * options.shadowAssPath is provided (Unified Caption Shadow mode — see
 * subtitleService.generateUnifiedShadowSubtitle), also composites that
 * silhouette track as a single blurred/offset layer beneath the real
 * captions, rather than approximating it with per-glyph shadows:
 *
 *   1. Render the shadow-only ASS track onto a fully transparent canvas
 *      (`geq` on a `format=yuva420p` clip derived from the input video, so it
 *      inherits the real dimensions/framerate/duration without needing to
 *      probe them) — `ass=...:alpha=1` is required for libass to actually
 *      preserve/output the resulting alpha here (it's a no-op without it).
 *   2. Gaussian-approximate blur (`boxblur`, alpha included) that whole
 *      rasterized layer as ONE image, so adjacent glyphs/words merge into a
 *      single continuous silhouette instead of a shadow behind every
 *      individual character.
 *   3. Overlay that blurred layer onto the source video, offset by the
 *      configured distance (expressed as fractions of the ASS design canvas
 *      via `main_w`/`main_h` filter expressions, so it scales correctly at
 *      any output resolution without needing that resolution numerically).
 *   4. Burn the real foreground caption track on top, unchanged.
 *
 * @param {string} inputVideoPath - Absolute path to the input video file.
 * @param {string} assPath - Absolute path to the ASS subtitles file.
 * @param {string} outputPath - Absolute path where the rendered video will be saved.
 * @param {object} options - Options containing callbacks like onSpawn, and
 *   optionally { shadowAssPath, unifiedShadow: { blurAss, offsetXAss, offsetYAss } }.
 * @returns {Promise<string>} Resolves with the outputPath if successful.
 */
export function burnSubtitles(inputVideoPath, assPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error('FFmpeg static binary path could not be resolved.'));
    }

    // Use relative paths to avoid Windows colons (drive letters) and spaces in parent paths
    const relativeAssPath = path.relative(process.cwd(), assPath).replace(/\\/g, '/');

    // Resolve local fonts directory for libass font discovery
    const fontsDir = path.join(path.dirname(assPath), '..', 'fonts');
    const relativeFontsDir = path.relative(process.cwd(), fontsDir).replace(/\\/g, '/');

    // Set up filter argument with fontsdir to point libass at our bundled font library
    const assFilter = `ass='${relativeAssPath}':fontsdir='${relativeFontsDir}'`;

    let args;

    if (options.shadowAssPath) {
      const relativeShadowAssPath = path.relative(process.cwd(), options.shadowAssPath).replace(/\\/g, '/');
      const shadowAssFilter = `ass='${relativeShadowAssPath}':fontsdir='${relativeFontsDir}':alpha=1`;

      const unified = options.unifiedShadow || {};
      const blurAss = unified.blurAss ?? 6;
      const offsetXAss = unified.offsetXAss ?? 0;
      const offsetYAss = unified.offsetYAss ?? 4;

      // PlayResX/PlayResY (see assWriter.js) is the design canvas both ASS
      // tracks position/size themselves against; boxblur's radius and
      // overlay's offset are expressed as expressions of the ACTUAL decoded
      // frame size (`h`/`main_w`/`main_h`) scaled by that same ratio, so the
      // result is correct at whatever resolution the source video actually is.
      const filterComplex = [
        `[0:v]format=yuva420p,geq=r=0:g=0:b=0:a=0[shadow_base]`,
        `[shadow_base]${shadowAssFilter}[shadow_text]`,
        `[shadow_text]boxblur=luma_radius='h/1920*${blurAss}':luma_power=2:chroma_radius='h/1920*${blurAss}':chroma_power=2:alpha_radius='h/1920*${blurAss}':alpha_power=2[shadow_blurred]`,
        `[0:v][shadow_blurred]overlay=x='main_w/1080*${offsetXAss}':y='main_h/1920*${offsetYAss}':format=auto[with_shadow]`,
        `[with_shadow]${assFilter}[outv]`
      ].join(';');

      args = [
        '-y',
        '-i', inputVideoPath,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'copy',
        outputPath
      ];
    } else {
      // OPTIMIZED FFmpeg parameters:
      // -c:v libx264: Explicitly specify libx264 video encoder
      // -preset ultrafast: Use fastest encoding speed preset to minimize RAM/CPU footprints on Render
      // -crf 23: Balance visual quality compression ratio
      // -c:a copy: Directly copy audio streams without re-encoding to save RAM/CPU
      args = [
        '-y',
        '-i', inputVideoPath,
        '-vf', assFilter,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'copy',
        outputPath
      ];
    }

    console.log(`Executing FFmpeg Subtitle Burn command: ${ffmpegPath} ${args.join(' ')}`);

    const memBefore = process.memoryUsage();
    const startTime = Date.now();

    // Spawn with inherited FONTCONFIG_FILE env so libass can find our fonts.conf
    const spawnEnv = { ...process.env };
    const ffmpegProc = spawn(ffmpegPath, args, { env: spawnEnv });
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
