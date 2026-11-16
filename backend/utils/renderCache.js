/**
 * BACKGROUND RENDERING (V2.3.2): the export is rendered while the user edits,
 * so pressing Export only has to join what is already there.
 *
 * The video is cut into CHUNKS of about ten seconds, on the frame grid. Each
 * chunk carries a fingerprint of everything that decides its pixels: the
 * source, the export size, the encoder, the canvas and composition, and — per
 * layer — the frames that fall inside the chunk, by their CONTENT (a hash of
 * each PNG) and their times relative to the chunk. An edit at 1:40 changes
 * only the chunks around 1:40; restyling every caption changes them all. A
 * chunk whose fingerprint is unchanged is kept as it is.
 *
 * When the edits settle, the editor posts the project (POST
 * /api/upload/prerender). A PASS then draws the frames once (the same
 * prepareGraphicsRender the one-pass export uses), fingerprints every chunk,
 * and composites the changed ones one at a time, below normal priority. A new
 * edit cancels the pass — the chunk being rendered is abandoned — and a new
 * pass starts from the newer project.
 *
 * Export (renderFromChunks) brings the cache up to date with the exported
 * project at normal priority — nothing to do when the background got there
 * first — then joins the chunks without re-encoding and mixes the sound once,
 * over the whole (sound effects and music cross chunk edges freely).
 *
 * Chunks are video only, no audio, at the video's fixed frame rate.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { prepareGraphicsRender } from './graphicsExport.js';
import { compositeGraphicsCaptionTrack, exportEncoderInUse, frameRateValue } from './graphicsCompositor.js';
import { buildAudioMixGraph } from './audioMixFilter.js';

const CHUNK_SECONDS = 10;

/** baseName → { dir, want, doneKey, draining, passKey, chunks: Map<index, {hash, file}>, plan, proc, failed } */
const jobs = new Map();

const sha1 = (data) => crypto.createHash('sha1').update(data).digest('hex');

/** The key of one exported project: same words, same styles, same size → same file. */
export function projectKey(words, styles, exportSize) {
  return sha1(JSON.stringify({ words, styles, exportSize }));
}

export function renderCacheDirFor(baseOutputDir, baseName) {
  return path.join(baseOutputDir, `${baseName}_render_cache`);
}

function jobFor(baseName, dir) {
  let job = jobs.get(baseName);
  if (!job) {
    job = { dir, want: null, doneKey: null, draining: null, passKey: null, chunks: new Map(), plan: null, proc: null, failed: null };
    jobs.set(baseName, job);
  }
  return job;
}

/** Where a background render stands, for the export dialog. */
export function prerenderStatus(baseName) {
  const job = jobs.get(baseName);
  if (!job?.plan) return null;
  const ready = job.plan.chunks.filter((c) => job.chunks.get(c.index)?.hash === c.hash && fs.existsSync(job.chunks.get(c.index).file)).length;
  return {
    exportSize: job.plan.exportSize,
    ready,
    total: job.plan.chunks.length,
    // Up to date with the last project the editor sent — and nothing newer waiting.
    upToDate: !!job.want && job.doneKey === job.want.key,
    rendering: !!job.draining
  };
}

/**
 * The project as it is now — start (or restart) the background render. Returns
 * at once; the work happens in the background, below normal priority.
 */
export function requestPrerender(baseName, { videoPath, words, styles, exportSize, dir }) {
  const job = jobFor(baseName, dir);
  const key = projectKey(words, styles, exportSize);
  if (job.want?.key === key) return;
  job.want = { key, videoPath, words, styles, exportSize, urgent: false };
  job.failed = null;
  // The pass in hand is for an older project: stop its chunk now.
  if (job.passKey && job.passKey !== key) {
    try { job.proc?.kill('SIGKILL'); } catch { /* already gone */ }
  }
  drain(job);
}

/** Runs passes until the cache matches the newest project wanted. */
function drain(job) {
  if (job.draining) return job.draining;
  job.draining = (async () => {
    // Not one synchronous step: with nothing to do, the finally below would
    // otherwise clear job.draining BEFORE this promise is stored in it.
    await null;
    try {
      while (job.want && job.doneKey !== job.want.key && job.failed?.key !== job.want.key) {
        const want = job.want;
        job.passKey = want.key;
        try {
          await runPass(job, want);
          if (job.want?.key === want.key) job.doneKey = want.key;
        } catch (err) {
          // Cancelled by a newer project: the loop picks that one up. Anything
          // else is a real failure — recorded, and the export renders in one pass.
          if (job.want?.key === want.key) {
            job.failed = { key: want.key, message: err.message };
            console.error(`[RenderCache] Background render failed: ${err.message}`);
          }
        }
      }
    } finally {
      job.passKey = null;
      job.draining = null;
    }
  })();
  return job.draining;
}

/** Each PNG's content hash, read once per pass. */
function fileHasher() {
  const memo = new Map();
  return (file) => {
    if (!file) return '';
    let h = memo.get(file);
    if (h === undefined) {
      try { h = sha1(fs.readFileSync(file)); } catch { h = 'missing'; }
      memo.set(file, h);
    }
    return h;
  };
}

/**
 * Every stream the compositor will read, by name: the caption track, the
 * keyword track, each layer run, and the object effects' streams. What a chunk
 * shows is decided by these, plus the settings outside them (see globalPart).
 */
function streamsOf(segments, opts) {
  const streams = [['captions', segments]];
  if (opts.keywordSegments?.length) streams.push(['keywords', opts.keywordSegments]);
  (opts.layerRuns || []).forEach((run, i) => {
    const { segments: runSegments, ...rest } = run;
    streams.push([`run${i}:${JSON.stringify(rest)}`, runSegments || []]);
  });
  const fx = opts.objectEffects || {};
  ['overlay', 'background', 'subjectMask'].forEach((name) => {
    if (fx[name]?.length) streams.push([`fx:${name}`, fx[name]]);
  });
  (fx.masks || []).forEach((mask, i) => streams.push([`fx:mask${i}:${mask.sigma}`, mask.segments || []]));
  return streams;
}

/** Settings every chunk shares — a change here re-renders them all. */
function globalPart(source, opts, exportSize, hashFile) {
  let stat = null;
  try { stat = fs.statSync(source); } catch { /* fingerprinted as missing */ }
  const composition = opts.composition ? { ...opts.composition, files: undefined } : null;
  const compositionFiles = Object.fromEntries(Object.entries(opts.composition?.files || {}).map(([k, f]) => [k, hashFile(f)]));
  return JSON.stringify({
    // Not its modified time: a video put back after the server purged it (or
    // kept alive by a touch) is the same video.
    source: [source, stat?.size],
    exportSize,
    encoder: exportEncoderInUse(),
    frameRate: opts.frameRate,
    canvas: [opts.canvasWidth, opts.canvasHeight],
    composition,
    compositionFiles,
    // The video's own transform, keyframes and all: a window renders through
    // the WHOLE export's chain (videoTransformFilter.js's absoluteFrom), whose
    // canvas is sized from every keyframe — so any change re-renders all chunks.
    videoTransform: opts.videoTransform || null,
    textBlendMode: opts.textBlendMode,
    // The STRUCTURE of the layer stack (how many streams, which kinds) —
    // their contents are per chunk.
    hasKeywords: !!opts.keywordSegments?.length
  });
}

/** The chunks of a video, on its frame grid. */
function planChunks(duration, fps) {
  const perChunk = Math.max(1, Math.round(CHUNK_SECONDS * fps));
  const totalFrames = Math.max(1, Math.ceil(duration * fps - 1e-6));
  const chunks = [];
  for (let first = 0, index = 0; first < totalFrames; first += perChunk, index += 1) {
    const frames = Math.min(perChunk, totalFrames - first);
    chunks.push({ index, start: first / fps, end: (first + frames) / fps, frames });
  }
  return chunks;
}

function chunkHash(chunk, globalHash, streams, hashFile) {
  const parts = streams.map(([name, segs]) => {
    const inside = [];
    for (const seg of segs) {
      if (seg.end <= chunk.start || seg.start >= chunk.end) continue;
      inside.push([
        Math.round((Math.max(seg.start, chunk.start) - chunk.start) * 1e4),
        Math.round((Math.min(seg.end, chunk.end) - chunk.start) * 1e4),
        hashFile(seg.file)
      ]);
    }
    return [name, inside];
  });
  return sha1(JSON.stringify([globalHash, chunk.frames, chunk.start.toFixed(6), parts]));
}

/** One pass: draw the frames, fingerprint every chunk, render the changed ones. */
async function runPass(job, want) {
  const cancelled = () => job.want?.key !== want.key;
  const passStart = Date.now();
  fs.mkdirSync(job.dir, { recursive: true });
  const framesDir = path.join(job.dir, `frames-${Date.now()}`);
  try {
    const prepared = await prepareGraphicsRender(want.videoPath, want.words, want.styles, framesDir, {
      exportSize: want.exportSize,
      hdSourcePath: path.join(job.dir, 'source-1080p.mp4')
    });
    if (!prepared) throw new Error('The graphics renderer cannot take this project; the export renders it in one pass.');
    if (cancelled()) throw new Error('cancelled');
    const { source, segments, compositeOpts } = prepared;
    const fps = frameRateValue(compositeOpts.frameRate) || 50;
    const hashFile = fileHasher();
    const streams = streamsOf(segments, compositeOpts);
    const globalHash = sha1(globalPart(source, compositeOpts, want.exportSize, hashFile));
    const chunks = planChunks(compositeOpts.duration, fps).map((c) => ({ ...c, hash: chunkHash(c, globalHash, streams, hashFile) }));
    job.plan = { exportSize: want.exportSize, chunks, audio: compositeOpts.audio, hasSourceAudio: compositeOpts.hasSourceAudio, duration: compositeOpts.duration };
    const stale = chunks.filter((c) => {
      const have = job.chunks.get(c.index);
      return !(have && have.hash === c.hash && fs.existsSync(have.file));
    });
    console.log(`[RenderCache] Frames drawn in ${Date.now() - passStart}ms; ${stale.length} of ${chunks.length} chunks to render${want.urgent ? ' (export waiting)' : ''}.`);
    for (const chunk of stale) {
      if (cancelled()) throw new Error('cancelled');
      const file = path.join(job.dir, `chunk-${String(chunk.index).padStart(4, '0')}-${chunk.hash.slice(0, 10)}.mp4`);
      const chunkStart = Date.now();
      await compositeGraphicsCaptionTrack(source, segments, file, {
        ...compositeOpts,
        audio: null,
        window: { start: chunk.start, frames: chunk.frames },
        // Below normal priority until an export is waiting on it.
        lowPriority: !want.urgent,
        onSpawn: (proc) => { job.proc = proc; }
      });
      job.proc = null;
      const old = job.chunks.get(chunk.index);
      job.chunks.set(chunk.index, { hash: chunk.hash, file });
      if (old && old.file !== file) fs.rm(old.file, { force: true }, () => {});
      console.log(`[RenderCache] Chunk ${chunk.index + 1}/${chunks.length} (${chunk.start.toFixed(1)}s) in ${Date.now() - chunkStart}ms`);
    }
    // Chunks past the end of a shorter project are no longer part of it.
    for (const [index, have] of job.chunks) {
      if (index >= chunks.length) { job.chunks.delete(index); fs.rm(have.file, { force: true }, () => {}); }
    }
  } finally {
    job.proc = null;
    fs.rm(framesDir, { recursive: true, force: true }, () => {});
  }
}

/**
 * EXPORT from the cache: brings it up to date with this exact project (at
 * normal priority — the editor is waiting), then joins the chunks and adds
 * the sound. Resolves true with the file written, false when the cache cannot
 * produce it (the caller then renders in one pass, as before).
 */
export async function renderFromChunks(baseName, { videoPath, words, styles, exportSize, dir, outputPath }) {
  const job = jobFor(baseName, dir);
  const key = projectKey(words, styles, exportSize);
  if (job.want?.key !== key) {
    requestPrerender(baseName, { videoPath, words, styles, exportSize, dir });
  }
  job.want.urgent = true;
  // A chunk already rendering for this project: up to normal priority now.
  if (job.proc) {
    try { os.setPriority(job.proc.pid, os.constants.priority.PRIORITY_NORMAL); } catch { /* stays low */ }
  }
  await drain(job);
  if (job.doneKey !== key) return false; // failed, or a newer project arrived meanwhile
  const plan = job.plan;
  const files = plan.chunks.map((c) => job.chunks.get(c.index));
  if (!files.every((f, i) => f && f.hash === plan.chunks[i].hash && fs.existsSync(f.file))) return false;
  const joinStart = Date.now();
  await joinChunks(files.map((f) => f.file), videoPath, plan, outputPath);
  console.log(`[RenderCache] Joined ${files.length} chunks and mixed the sound in ${Date.now() - joinStart}ms`);
  return true;
}

/** The chunks end to end (no re-encode), with the sound of the whole mixed once. */
function joinChunks(files, videoPath, plan, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(os.tmpdir(), `bhynd-chunks-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(listPath, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`).join('\n'), 'utf8');
    // Input 0 is the ORIGINAL — the sound mix reads its audio as [0:a] — and
    // input 1 the joined chunks.
    const inputArgs = ['-y', '-i', videoPath, '-f', 'concat', '-safe', '0', '-i', listPath];
    const audioMix = plan.audio && plan.duration
      ? buildAudioMixGraph(plan.audio, { duration: plan.duration, hasSourceAudio: plan.hasSourceAudio !== false, firstInputIndex: 2 })
      : null;
    if (audioMix) inputArgs.push(...audioMix.inputArgs);
    const args = [
      ...inputArgs,
      ...(audioMix ? ['-filter_complex', audioMix.filterStages.join(';')] : []),
      '-map', '1:v',
      ...(audioMix
        ? ['-map', audioMix.outputLabel, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
        : ['-map', '0:a?', '-c:a', 'copy']),
      '-c:v', 'copy',
      '-t', plan.duration.toFixed(6),
      outputPath
    ];
    const proc = spawn(ffmpegPath, args);
    const tail = [];
    proc.stderr.on('data', (d) => { tail.push(d.toString()); if (tail.length > 30) tail.shift(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      try { fs.unlinkSync(listPath); } catch { /* best effort */ }
      if (code === 0) resolve(outputPath);
      else reject(new Error(`Joining the chunks failed (${code}): ${tail.join('').slice(-400)}`));
    });
  });
}

/** Forget a job's cache (a new upload under the same name, or cleanup). */
export function dropRenderCache(baseName) {
  const job = jobs.get(baseName);
  if (!job) return;
  job.want = null;
  try { job.proc?.kill('SIGKILL'); } catch { /* gone */ }
  jobs.delete(baseName);
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
}
