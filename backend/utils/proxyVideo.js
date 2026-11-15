/**
 * EDITING PROXIES — a browser-safe copy of the uploaded video for the editor
 * to play, while the original stays untouched as the export master.
 *
 * WHY. Phones record HEVC (H.265), often 4K, often stored sideways with a
 * rotation tag. Browsers disagree on HEVC: on this Windows machine Chrome
 * decodes it on the GPU, Firefox cannot decode it at all without a paid
 * Windows codec — so a user on Firefox imported a video and got no picture
 * and no sound, only the separately-played sound effects. And even where 4K
 * HEVC does play, scrubbing it on integrated graphics is slow. Every serious
 * editor (Premiere, Resolve) solves this the same way: edit on a light proxy,
 * render the export from the original. That is what this does.
 *
 * THE PROXY: H.264 (every browser), long side at most 1920, rotation BAKED IN
 * (no tag left for a player to apply twice), AAC audio, faststart.
 *
 * TWO ENCODERS, tried in order:
 *   1. Intel Quick Sync, entirely on the GPU — decode, rotate, scale, encode.
 *      Measured on a real 3.5-minute 4K iPhone clip: 61 seconds.
 *   2. Software (libx264), when the GPU path is unavailable — a cloud server
 *      will usually have no Intel GPU. Same clip: 3m54s. Slower, always works.
 * The GPU result was checked pixel-for-pixel against the software one (mean
 * difference 0.4/255). Two traps cost a try each and are why the rotation is
 * handled by hand below: with hardware frames ffmpeg's automatic rotation
 * silently stops, AND it still copies the source's rotation tag — so the
 * first attempt played sideways, rotated twice. vpp_qsv also SCALES BEFORE
 * it transposes, so its w/h are the pre-rotation size, or the result is
 * squashed.
 */
import fs from 'fs';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

/** The proxy's long side. Plenty for an editing preview; 4K stays in the original. */
export const PROXY_LONG_SIDE = 1920;

/**
 * What the video is: codec, stored size, display rotation, duration.
 * Read from ffmpeg's own banner (the same way graphicsCompositor's
 * getVideoInfo does) so no extra probe binary is needed.
 */
export function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const video = stderr.match(/Stream #\d+:\d+[^\n]*?Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})/);
      if (!video) return reject(new Error(`Not a readable video: ${inputPath}`));
      const after = stderr.slice(stderr.indexOf(video[0]) + video[0].length);
      const nextStream = after.search(/Stream #\d+:\d+/);
      const block = nextStream === -1 ? after : after.slice(0, nextStream);
      const rot = block.match(/rotation of (-?\d+(?:\.\d+)?) degrees/i) || block.match(/rotate\s*:\s*(-?\d+)/i);
      // ffmpeg reports the rotation needed to DISPLAY it, counter-clockwise
      // positive: an iPhone held upright reads "-90". Normalised to 0/90/180/270.
      const rotation = rot ? ((Math.round(parseFloat(rot[1]) / 90) * 90 % 360) + 360) % 360 : 0;
      const dur = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve({
        codec: video[1].toLowerCase(),
        width: parseInt(video[2], 10),
        height: parseInt(video[3], 10),
        rotation,
        duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : null,
        hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(stderr)
      });
    });
  });
}

/**
 * Whether the browser can be trusted with the original as it is. H.264 at
 * proxy size or under plays everywhere (and every browser honours an H.264
 * rotation tag); anything else — HEVC, ProRes, 4K — gets a proxy.
 */
export function needsProxy(info) {
  const longSide = Math.max(info.width, info.height);
  return !(info.codec === 'h264' && longSide <= PROXY_LONG_SIDE);
}

/** The size to scale to, in STORED orientation (before any rotation), even, never upscaled. */
function storedTargetSize(info) {
  const longSide = Math.max(info.width, info.height);
  const k = Math.min(1, PROXY_LONG_SIDE / longSide);
  const even = (n) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(info.width), h: even(info.height) };
}

/** vpp_qsv's transpose for a display rotation; null when none is needed. */
function qsvTranspose(rotation) {
  // "rotation of -90" (normalised 270) is an iPhone held upright: turn clockwise.
  return { 0: null, 90: 'cclock', 180: 'reversal', 270: 'clock' }[rotation] ?? null;
}

function run(args, onSpawn) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    onSpawn?.(proc);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`))));
  });
}

const AUDIO = ['-c:a', 'aac', '-b:a', '128k'];
const CONTAINER = ['-movflags', '+faststart'];

/** All on the Intel GPU. Throws when Quick Sync is unavailable — the caller falls back. */
function proxyOnGpu(input, output, info, onSpawn) {
  const { w, h } = storedTargetSize(info);
  const transpose = qsvTranspose(info.rotation);
  const vpp = `vpp_qsv=${transpose ? `transpose=${transpose}:` : ''}w=${w}:h=${h}`;
  return run([
    '-hide_banner', '-loglevel', 'error', '-y',
    // Rotation is applied by hand (the transpose above), so the automatic one
    // is switched off AND the source's tag is zeroed — otherwise players
    // rotate a second time.
    '-noautorotate', '-display_rotation:v:0', '0',
    '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv',
    '-i', input,
    '-vf', vpp,
    '-c:v', 'h264_qsv', '-global_quality', '25',
    ...(info.hasAudio ? AUDIO : ['-an']),
    ...CONTAINER, output
  ], onSpawn);
}

/** Software: slower, works anywhere. ffmpeg's own autorotate bakes the rotation in. */
function proxyOnCpu(input, output, info, onSpawn) {
  const long = PROXY_LONG_SIDE;
  return run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-vf', `scale='if(gt(iw,ih),min(${long},iw),-2)':'if(gt(iw,ih),-2,min(${long},ih))'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    ...(info.hasAudio ? AUDIO : ['-an']),
    ...CONTAINER, output
  ], onSpawn);
}

/** Whether the GPU path has failed on this server — remembered, so it is not retried on every upload. */
let gpuUnavailable = process.env.BHYND_PROXY_GPU === '0';

/**
 * Makes the proxy. Resolves to { engine: 'gpu'|'cpu', seconds }.
 * Partial output from a failed attempt is removed before the next one.
 */
export async function makeProxy(input, output, info, { onSpawn } = {}) {
  const t0 = Date.now();
  if (!gpuUnavailable) {
    try {
      await proxyOnGpu(input, output, info, onSpawn);
      return { engine: 'gpu', seconds: +((Date.now() - t0) / 1000).toFixed(1) };
    } catch (err) {
      gpuUnavailable = true;
      console.warn(`[Proxy] GPU encoder unavailable, using software from now on: ${String(err.message).split('\n')[0]}`);
      try { fs.unlinkSync(output); } catch { /* nothing written */ }
    }
  }
  await proxyOnCpu(input, output, info, onSpawn);
  return { engine: 'cpu', seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

// --- Jobs ---------------------------------------------------------------------
// One proxy job per upload, run in the BACKGROUND: the upload's response does
// not wait for it (transcription and the proxy run side by side), and the
// editor asks for its status until it is ready.

const jobs = new Map(); // baseName -> { status, file, engine, seconds, error }

export function startProxyJob(baseName, input, output) {
  const job = { status: 'pending', file: output, engine: null, seconds: null, error: null };
  jobs.set(baseName, job);
  (async () => {
    try {
      const info = await probeVideo(input);
      if (!needsProxy(info)) {
        job.status = 'not-needed';
        return;
      }
      const result = await makeProxy(input, output, info);
      Object.assign(job, { status: 'ready', ...result });
      console.log(`[Proxy] [${baseName}] Ready in ${result.seconds}s on the ${result.engine.toUpperCase()}.`);
    } catch (err) {
      job.status = 'failed';
      job.error = String(err.message || err).split('\n')[0];
      console.error(`[Proxy] [${baseName}] Failed:`, job.error);
    }
  })();
  return job;
}

export function getProxyJob(baseName) {
  return jobs.get(baseName) || null;
}

export function forgetProxyJob(baseName) {
  jobs.delete(baseName);
}
