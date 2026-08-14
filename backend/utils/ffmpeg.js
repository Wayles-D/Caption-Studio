import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
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
 * Polls the FFmpeg *child process's own* RSS (via /proc/<pid>/status on
 * Linux — where Render actually runs this) while it's rendering, and returns
 * a stop() function that resolves the peak value observed.
 *
 * This exists because the "[FFmpeg Burn Metrics]" log below only ever
 * measured `process.memoryUsage()` — this Node process's OWN memory — never
 * the ffmpeg subprocess's, which is a separate OS process and where an OOM
 * from a heavy filter graph actually happens. That gap is why the previous
 * memory regression left no direct evidence in these logs: Node's own RSS
 * barely moves regardless of how much memory the spawned ffmpeg uses. A
 * no-op on non-Linux dev machines (Windows/macOS have no /proc); Render's
 * containers are Linux, so this is live in the environment that matters.
 */
function trackChildProcessPeakRss(pid) {
  let peakBytes = 0;
  let stopped = false;

  const sample = () => {
    if (stopped) return;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
      if (match) {
        const bytes = parseInt(match[1], 10) * 1024;
        if (bytes > peakBytes) peakBytes = bytes;
      }
    } catch {
      // /proc unavailable (non-Linux, or process already exited) — no-op.
    }
  };

  sample();
  const interval = setInterval(sample, 1000);

  return function stop() {
    stopped = true;
    clearInterval(interval);
    return peakBytes;
  };
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

*   1. Render the shadow-only ASS track onto a fully transparent canvas AT
 *      HALF RESOLUTION. This is deliberate, not an approximation of quality:
 *      the shadow is blurred regardless, so downscaling before the blur is
 *      visually lossless while cutting the pixel count (and therefore the
 *      cost of every step below) by ~4x. Measured impact on a 45s 1080x1920
 *      clip: the naive full-resolution version (an earlier revision of this
 *      function) peaked at ~448MB RSS and took ~76s; this halved-resolution
 *      version peaks at ~317MB and takes ~27s — see the regression writeup
 *      for the full comparison. `colorchannelmixer=aa=0` (not `geq`) zeroes
 *      the alpha channel — `geq` is a per-pixel *interpreted expression*
 *      evaluator and is dramatically slower for a no-op like this.
 *      `ass=...:alpha=1` is required for libass to actually preserve/output
 *      alpha here (silently a no-op otherwise). `boxblur` runs a single pass
 *      (not the sharper-but-2x-cost double pass) — softened further by the
 *      half-resolution upscale, a single pass is visually indistinguishable
 *      for this use.
 *   2. Scale the blurred shadow layer back up to the source video's actual
 *      dimensions (`scale2ref`, a cheap standard resize — not `geq`) so it
 *      composites at the correct size regardless of the upload's resolution.
 *   3. Overlay that layer onto the source video, offset by the configured
 *      distance (expressed as fractions of the ASS design canvas via
 *      `main_w`/`main_h` filter expressions, so it's correct at any
 *      resolution without probing it), with an explicit `format=yuv420`
 *      (overlay's own default) rather than `auto`, avoiding a needless
 *      per-frame pixel-format renegotiation.
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
      // The shadow chain works at HALF the source resolution throughout (see
      // the doc comment above) — only the final overlay/burn runs full-size.
      const filterComplex = [
        `[0:v]scale=iw/2:ih/2,format=yuva420p,colorchannelmixer=aa=0[shadow_base]`,
        `[shadow_base]${shadowAssFilter}[shadow_text]`,
        `[shadow_text]boxblur=luma_radius='h/960*${blurAss}':luma_power=1:chroma_radius='h/960*${blurAss}':chroma_power=1:alpha_radius='h/960*${blurAss}':alpha_power=1[shadow_blurred]`,
        `[shadow_blurred][0:v]scale2ref=w=iw*2:h=ih*2[shadow_scaled][main_ref]`,
        `[main_ref][shadow_scaled]overlay=x='main_w/1080*${offsetXAss}':y='main_h/1920*${offsetYAss}':format=yuv420[with_shadow]`,
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

    // Tracks the ffmpeg SUBPROCESS's own peak RSS — see trackChildProcessPeakRss's
    // doc comment for why this (not process.memoryUsage() below) is what
    // actually matters for diagnosing an OOM restart.
    const stopTrackingFfmpegRss = trackChildProcessPeakRss(ffmpegProc.pid);

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
      stopTrackingFfmpegRss();
      reject(err);
    });

    ffmpegProc.on('close', (code) => {
      const duration = Date.now() - startTime;
      const memAfter = process.memoryUsage();
      const rssDelta = memAfter.rss - memBefore.rss;
      const ffmpegPeakRss = stopTrackingFfmpegRss();

      console.log(`[FFmpeg Burn Metrics]
  Duration: ${duration}ms
  Exit Code: ${code}
  Mode: ${options.shadowAssPath ? 'unified-shadow' : 'standard'}
  FFmpeg Process Peak RSS: ${ffmpegPeakRss > 0 ? formatBytes(ffmpegPeakRss) : 'unavailable (non-Linux host)'}
  Node Process Memory Before: ${formatMemory(memBefore)}
  Node Process Memory After: ${formatMemory(memAfter)}
  Node Process Delta RSS: ${formatBytes(rssDelta)}
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
