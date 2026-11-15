/**
 * SELECT ONCE, AND IT FOLLOWS — the video segmenter (EdgeTAM, tamWorker.js)
 * run over a span of the timeline, stored as an ordinary segmentation.
 *
 * The point of this module is what it does NOT introduce. A finished job is a
 * normal track in appState.objectTracks and a normal segmentation record in
 * appState.objectSegmentations — the same two objects the still-image pipeline
 * produces. Occlusion, subject isolation, object effects, the preview overlay
 * and the exporter all read those and only those, so none of them know or care
 * which engine made the masks. Measured on segment.mp4 against the true
 * pixels, this engine's masks: mean IoU 0.929 vs the old pipeline's 0.884,
 * worst spill on the wrong person 4.4% vs 11.3% — from ONE box, with no
 * tracker, no keyframe grid and no morph between distant snapshots.
 *
 * Three wires carry the compatibility, each load-bearing:
 *
 *  - The TRACK is synthesised from the masks themselves: each frame's sample
 *    box is the mask's own bounds. It is stamped by buildTrack and keyed by
 *    trackCacheKey over a synthetic detection id, because consumers VERIFY
 *    that (occlusion's getOcclusionTrack calls isTrackValidFor, which
 *    recomputes the key). An invented key would be rejected there.
 *
 *  - The RECORD is built under the SAME config the lookups recompute their
 *    keys with (getSegmentationConfig) — stored under any other config it
 *    simply would not be found. The config's `step` therefore describes the
 *    old engine's grid, not this one's sampling; `engine`/`engineFps` carry
 *    the truth, and ride outside the key on purpose.
 *
 *  - The span is SPARSE on purpose: frames cost ~2.6s each on weak integrated
 *    graphics (Gate 0), so this runs where a layer actually sits behind the
 *    subject — a few seconds — never a whole clip.
 *
 * WHERE, NOT EVERYWHERE (the occlusion workflow, as in Resolve): an effect
 * lives exactly as long as the layer it hides. The person is picked right
 * from the layer's own panel (startPickingBehind — no trip to the Objects
 * panel, no whole-video track/segment), followed over the layer's time only,
 * and when the layer is later stretched or moved the effect follows it
 * (initFollowAlongLayers): only the NEW seconds are processed, grown outward
 * from the last good mask. A moment where the model loses its nerve (under
 * HOLD_GAP_SECONDS) keeps the last good mask instead of dropping it, so a
 * still talking head never has the layer pop to the front for a frame.
 */
import { appState, updateState, subscribe } from '../state.js';
import { buildTrack, trackCacheKey, DEFAULT_TRACK_CONFIG } from '../../../shared/objects/tracking.js';
import { MANUAL_CLASS } from '../../../shared/objects/templateMatch.js';
import { buildSegmentation, gridFor, maskLevel } from '../../../shared/objects/segmentation.js';
import { getSegmentationConfig, storeSegmentationResult, getMaskAt, loadMaskRows } from './objectSegmentation.js';
import { getCacheKey, getDetectionSource, getSelectedObject, setObjectsMode, detectCurrentFrame } from './objectDetection.js';
import { setLayerBehind, getOcclusions, updateOcclusion } from './occlusion.js';
import { getLayerStack } from './layerStack.js';
import { useFollowStore } from '../../store/followStore.js';

/** The encoder's input square (tamWorker.js resizes every frame to this). */
const INPUT = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Below this, the model is saying "I no longer see the object": the keyframe is stored hidden. */
const MIN_OBJECT_SCORE = 0;
/** Frames per second followed. Six is ample for occlusion (the reader morphs between frames) and keeps a 5s effect around a minute on weak graphics. */
export const FOLLOW_FPS = 6;
/** A run of "not seen" frames this short, next to seen ones, is the model losing its nerve — not the person leaving. It keeps the nearest good mask. */
export const HOLD_GAP_SECONDS = 0.8;
/** Coverage slack: a layer edge this close to the processed span needs no more frames. */
const COVER_SLACK = 0.12;

let worker = null;
let seq = 0;
let running = null;
let cancelled = false;

/**
 * The model holds hundreds of MB of GPU memory. It stays loaded for a short
 * while after a job — stretching a layer right after putting it behind
 * someone is the normal next step, and loading the model a second time
 * moments after the first was dropped is what brought the browser down —
 * then goes, so an idle editor gets the memory back.
 */
const WORKER_IDLE_MS = 45000;
let idleTimer = null;

function getWorker() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!worker) worker = new Worker(new URL('../objects/tamWorker.js', import.meta.url), { type: 'module' });
  return worker;
}

function releaseWorkerNow() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) { worker.terminate(); worker = null; }
  releaseFrameVideo();
}

// --- The frames come from a PRIVATE video ----------------------------------------
//
// A follow seeks frame by frame. Doing that on the preview made the picture
// jump about (and stop playing) for as long as a job ran — including the
// automatic ones a stretched clip starts. So jobs read a private, detached
// copy of the same source instead (the object detector does the same — see
// objectDetection.js's lanes): the preview never moves. If the copy cannot
// load, the job falls back to the preview, as before.

let frameVideo = null;

function once(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener(event, on); reject(new Error(`timed out waiting for the video (${event})`)); }, timeoutMs);
    const on = () => { clearTimeout(timer); target.removeEventListener(event, on); resolve(); };
    target.addEventListener(event, on);
  });
}

async function privateVideo() {
  const url = getDetectionSource()?.url;
  if (!url) return null;
  if (!frameVideo) {
    frameVideo = document.createElement('video');
    frameVideo.muted = true;
    frameVideo.playsInline = true;
    frameVideo.preload = 'auto';
    frameVideo.crossOrigin = 'anonymous';
  }
  if (frameVideo.dataset.src !== url) {
    frameVideo.dataset.src = url;
    frameVideo.src = url;
  }
  if (!(frameVideo.readyState >= 2)) await once(frameVideo, 'loadeddata', 15000);
  return frameVideo;
}

function releaseFrameVideo() {
  if (!frameVideo) return;
  frameVideo.removeAttribute('src');
  frameVideo.load();
  frameVideo = null;
}

function releaseWorker() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseWorkerNow, WORKER_IDLE_MS);
}

function ask(message, transfer = []) {
  const id = ++seq;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const cleanup = () => { w.removeEventListener('message', onMessage); w.removeEventListener('error', onError); };
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      cleanup();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    // A worker that dies (out of memory, a lost GPU) never answers: fail the
    // job in plain sight instead of waiting forever, and start fresh next time.
    const onError = (e) => {
      cleanup();
      if (worker === w) { worker = null; w.terminate(); }
      reject(new Error(e?.message || 'the segmenter stopped'));
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ id, ...message }, transfer);
  });
}

const modelUrls = () => ({
  encoder: '/models/edgetam/vision_encoder.onnx',
  decoder: '/models/edgetam/mask_decoder.onnx',
  memoryEncoder: '/models/edgetam/memory_encoder.onnx',
  memoryAttention: '/models/edgetam/memory_attention.onnx',
  bankParams: '/models/edgetam/bank_params.json'
});

function seek(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-3 && video.readyState >= 2) return resolve();
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** The current video frame as the encoder wants it: 1024x1024, CHW, ImageNet-normalized. */
function framePixels(video, scratch) {
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, INPUT, INPUT);
  const { data } = ctx.getImageData(0, 0, INPUT, INPUT);
  const plane = INPUT * INPUT;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (data[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

export function isTamSegmenting() {
  return !!running;
}

export function cancelTamSegmentation() {
  cancelled = true;
}

const round4 = (t) => +t.toFixed(4);

/** One job at a time on the one worker; the video goes back where it was. */
function exclusive(job) {
  if (running) return running;
  cancelled = false;
  running = (async () => {
    let video = await privateVideo().catch((err) => {
      console.warn('[Occlusion] Private video unavailable, using the preview:', err?.message || err);
      return null;
    });
    // The fallback: the preview itself, paused for the job and put back after.
    const preview = video ? null : document.getElementById('preview-video');
    const wasAt = preview?.currentTime ?? 0;
    const wasPaused = preview?.paused ?? true;
    if (preview) { preview.pause(); video = preview; }
    try {
      return await job(video);
    } finally {
      releaseWorker();
      if (preview) {
        await seek(preview, wasAt);
        if (!wasPaused) preview.play().catch(() => {});
      }
    }
  })();
  running.finally(() => { running = null; });
  return running;
}

/**
 * Runs the model outward from the frame `box` describes: forward to `end`,
 * then — prompted afresh at the same frame — backward to `start`. Returns the
 * rows it produced (time → {keyframe, mask, sample}), or null when cancelled.
 * The model's memory has no sense of direction, so a reversed feed propagates
 * just as well — the box can be drawn at any moment, not only the first.
 */
async function runSpan(video, { box, start, end, boxTime, fps, grid, margin, onFrame }) {
  const scratch = document.createElement('canvas');
  scratch.width = INPUT;
  scratch.height = INPUT;
  const clampEnd = Math.min(end, video.duration);
  const at = Math.max(start, Math.min(boxTime, clampEnd));
  const forwardTimes = [];
  for (let t = at; t <= clampEnd + 1e-6; t += 1 / fps) forwardTimes.push(round4(t));
  // The span's own last and first moments are always frames: a grid that
  // stops short of them left the layer's final (or first) instant with no
  // mask, so it jumped in front right at the end.
  if (clampEnd - forwardTimes[forwardTimes.length - 1] > 1e-3) forwardTimes.push(round4(clampEnd));
  const backwardTimes = [];
  for (let t = at; t >= start - 1e-6; t -= 1 / fps) backwardTimes.push(round4(t));
  if (backwardTimes[backwardTimes.length - 1] - start > 1e-3) backwardTimes.push(round4(start));
  const total = forwardTimes.length + Math.max(0, backwardTimes.length - 1);

  const rows = new Map();
  let done = 0;
  let perFrame = null;
  const runLeg = async (times) => {
    let lastBox = box;
    for (let i = 0; i < times.length; i++) {
      if (cancelled) return false;
      const time = times[i];
      // The prompt frame must still RUN on the second leg (it seeds the
      // memory), but its result is already stored.
      const duplicate = rows.has(time);
      if (duplicate && i > 0) continue;
      await seek(video, time);
      const pixels = framePixels(video, scratch);
      const frameStart = performance.now();
      const reply = await ask(
        i === 0
          ? { op: 'prompt', models: modelUrls(), pixels, box, margin, gridWidth: grid.width, gridHeight: grid.height }
          : { op: 'track', pixels, margin, gridWidth: grid.width, gridHeight: grid.height },
        [pixels.buffer]
      );
      perFrame = (performance.now() - frameStart) / 1000;
      if (duplicate) continue;
      // The model's own belief it still sees the object. Below zero it is
      // telling us the object is gone — stored as hidden (see holdShortGaps
      // for when that is believed).
      const seen = reply.box && reply.score > MIN_OBJECT_SCORE;
      const confidence = seen ? Math.max(0, Math.min(1, reply.iou)) : 0;
      if (seen) lastBox = reply.box;
      rows.set(time, {
        keyframe: {
          time,
          confidence: +confidence.toFixed(3),
          level: maskLevel(confidence),
          state: seen ? 'tracked' : 'uncertain',
          ...(seen ? {} : { hidden: true })
        },
        mask: seen ? reply.alpha : new Uint8Array(grid.width * grid.height),
        // The track's box IS the mask's own bounds — the silhouette's
        // account of where it is; the whole reason there is no tracker.
        sample: { time, box: { ...lastBox }, confidence: seen ? confidence : 0.1, state: seen ? 'tracked' : 'uncertain' }
      });
      done += 1;
      onFrame?.({ done, total, secondsLeft: Math.max(0, Math.round((total - done) * (perFrame ?? 3))) });
    }
    return true;
  };

  await ask({ op: 'reset' });
  if (!(await runLeg(forwardTimes))) return null;
  if (backwardTimes.length > 1) {
    await ask({ op: 'reset' });
    if (!(await runLeg(backwardTimes))) return null;
  }
  return rows;
}

const isSeen = (row) => !row.keyframe.hidden;

/**
 * A short run of "not seen" frames beside seen ones is the model wavering on
 * a person who never left — keep the nearest good mask there rather than let
 * the layer jump in front for a moment. A longer run (they really walked out,
 * or someone crossed in front) stays hidden.
 * @param {Array} ordered rows sorted by time — modified in place
 */
export function holdShortGaps(ordered, maxGap = HOLD_GAP_SECONDS) {
  let i = 0;
  while (i < ordered.length) {
    if (isSeen(ordered[i])) { i++; continue; }
    let j = i;
    while (j + 1 < ordered.length && !isSeen(ordered[j + 1])) j++;
    const left = i > 0 ? ordered[i - 1] : null;
    const right = j + 1 < ordered.length ? ordered[j + 1] : null;
    const span = (right?.keyframe.time ?? ordered[j].keyframe.time) - (left?.keyframe.time ?? ordered[i].keyframe.time);
    if ((left || right) && span <= maxGap + 1e-6) {
      for (let k = i; k <= j; k++) {
        const t = ordered[k].keyframe.time;
        const src = !right || (left && t - left.keyframe.time <= right.keyframe.time - t) ? left : right;
        ordered[k] = {
          keyframe: { ...src.keyframe, time: t, confidence: +(src.keyframe.confidence * 0.9).toFixed(3), held: true },
          mask: src.mask,
          sample: { ...src.sample, time: t, box: { ...src.sample.box } }
        };
      }
    }
    i = j + 1;
  }
  return ordered;
}

/** Stores rows as a track + segmentation every consumer reads. */
async function storeRows(rows, { detection, cacheKey, grid, segConfig, fps, t0 }) {
  const ordered = holdShortGaps([...rows.keys()].sort((a, b) => a - b).map((t) => rows.get(t)));
  const samples = ordered.map((r) => r.sample);
  if (samples.filter((s) => s.state === 'tracked').length < 2) return null;
  const track = buildTrack({
    detection,
    config: DEFAULT_TRACK_CONFIG,
    samples,
    ends: {},
    source: { detectionCacheKey: cacheKey, engine: 'edgetam' }
  });
  const trackKey = trackCacheKey(cacheKey, detection.id, DEFAULT_TRACK_CONFIG);
  const record = buildSegmentation({
    track,
    trackKey,
    // The lookup's own config, so the record is findable; the truth about
    // this engine rides alongside, outside the key (see the header).
    config: { ...segConfig, engine: 'edgetam', engineFps: fps },
    grid,
    keyframes: ordered.map((r) => r.keyframe)
  });
  // The track first: dropStaleSegmentations (inside the store) keeps only
  // records whose track already exists.
  updateState({ objectTracks: { ...(appState.objectTracks || {}), [trackKey]: track } }, { recordHistory: false });
  const stored = await storeSegmentationResult({
    record,
    masks: ordered.map((r) => r.mask),
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    backend: 'edgetam'
  });
  return { trackKey, track, record: stored };
}

/**
 * Follows whatever is inside `box` from `start` to `end`, and stores the
 * result as a track + segmentation every existing consumer can read.
 *
 * @param {object} opts.box     Normalized {x,y,width,height} around the object, at `boxTime`.
 * @param {number} opts.start   Seconds. Where following begins.
 * @param {number} opts.end     Seconds. Where following stops.
 * @param {number} [opts.boxTime=start] Seconds — the frame the box actually describes.
 * @param {number} [opts.fps=FOLLOW_FPS] Sampling rate across the span.
 * @param {string} [opts.label='Subject']
 * @param {function} [opts.onProgress] ({done, total, secondsLeft})
 * @returns {Promise<{trackKey, track, record}|null>} null when cancelled or nothing was found.
 */
export function tamSegmentSpan({ box, start, end, boxTime = start, fps = FOLLOW_FPS, label = 'Subject', onProgress = null }) {
  if (running) return running;
  const source = getDetectionSource();
  const cacheKey = getCacheKey();
  if (!document.getElementById('preview-video') || !source || !cacheKey || !box || !(end > start)) return Promise.resolve(null);
  return exclusive(async (video) => {
    const t0 = performance.now();
    // One grid for the whole record, shaped by the object at its start —
    // exactly how the still-image engine chooses it.
    const segConfig = getSegmentationConfig();
    const grid = gridFor(box, source.width, source.height, segConfig.gridLongSide);
    const at = Math.max(start, Math.min(boxTime, Math.min(end, video.duration)));
    const rows = await runSpan(video, { box, start, end, boxTime: at, fps, grid, margin: segConfig.margin, onFrame: onProgress });
    if (!rows) return null;
    const detection = { id: `tam_${Date.now().toString(36)}`, class: MANUAL_CLASS, label, time: at };
    return storeRows(rows, { detection, cacheKey, grid, segConfig, fps, t0 });
  });
}

/**
 * Grows an existing follow to cover [start, end] — processing ONLY the
 * seconds it does not have yet, each new stretch prompted with the mask at
 * the nearest edge it does have. The track keeps its identity (same
 * detection id → same trackKey), so every relationship pointing at it just
 * keeps working; its record is replaced by the merged one.
 * @returns {Promise<{trackKey, track, record}|'covered'|null>}
 */
export function extendFollow(trackKey, start, end, { onProgress = null } = {}) {
  if (running) return running.then(() => extendFollow(trackKey, start, end, { onProgress }));
  return exclusive(async (video) => {
    const loaded = await loadMaskRows(trackKey);
    if (!loaded || loaded.record.config?.engine !== 'edgetam') {
      console.warn('[Occlusion] Cannot extend:', !loaded ? 'its masks are not loaded' : 'made by another engine');
      return null;
    }
    const { record, track, rows: existing } = loaded;
    if (!existing.length) { console.warn('[Occlusion] Cannot extend: no frames stored'); return null; }
    const first = existing[0].keyframe.time;
    const last = existing[existing.length - 1].keyframe.time;
    const needsBefore = start < first - COVER_SLACK;
    const needsAfter = end > last + COVER_SLACK;
    if (!needsBefore && !needsAfter) return 'covered';

    const t0 = performance.now();
    const fps = record.config.engineFps || FOLLOW_FPS;
    const segConfig = getSegmentationConfig();
    const seenNear = (fromStart) => (fromStart ? existing : [...existing].reverse()).find(isSeen);
    const legs = [];
    if (needsBefore) legs.push({ row: seenNear(true), from: Math.max(0, start), to: first });
    if (needsAfter) legs.push({ row: seenNear(false), from: last, to: Math.min(end, video.duration) });
    const frames = legs.reduce((n, l) => n + Math.ceil((l.to - l.from) * fps) + 1, 0);
    let doneBefore = 0;

    const merged = new Map(existing.map((r) => [round4(r.keyframe.time), r]));
    for (const leg of legs) {
      if (!leg.row) continue;
      const edge = leg.from === last ? last : first;
      const rows = await runSpan(video, {
        box: leg.row.sample.box,
        boxTime: edge,
        start: leg.from,
        end: leg.to,
        fps,
        grid: record.grid,
        margin: segConfig.margin,
        onFrame: ({ done, secondsLeft }) => onProgress?.({ done: doneBefore + done, total: frames, secondsLeft })
      });
      if (!rows) return null;
      let added = 0;
      rows.forEach((row, t) => { if (!merged.has(t)) { merged.set(t, row); added += 1; } });
      console.info('[Occlusion] Extended', leg.from.toFixed(2), '→', leg.to.toFixed(2), ':', added, 'new frames');
      doneBefore += rows.size;
    }
    const detection = { id: track.sourceObjectId, class: track.class, label: track.label, time: track.startTime };
    return storeRows(merged, { detection, cacheKey: track.source?.detectionCacheKey || getCacheKey(), grid: record.grid, segConfig, fps, t0 });
  });
}

/** Test/debug aid: the stored mask the rest of the app would read at `time` — through the very same reader path every consumer uses, not a shortcut. */
export function tamMaskAt(trackKey, time) {
  const track = appState.objectTracks?.[trackKey];
  return track ? getMaskAt(trackKey, track, time) : null;
}

/**
 * The object the user currently has selected in the Objects panel — a clicked
 * detection or a drawn box — as a candidate for following. Null when there is
 * nothing usable.
 */
export function followableSelection() {
  const sel = getSelectedObject();
  if (!sel?.box || !Number.isFinite(sel.timestamp)) return null;
  return { box: sel.box, time: sel.timestamp, label: sel.label || 'Subject' };
}

/** A layer's time on screen, or null. */
function layerSpan(layerId) {
  const item = getLayerStack().find((e) => e.id === layerId)?.item;
  return item && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start
    ? { start: item.start, end: item.end }
    : null;
}

/** The span a relationship should cover: every one of its layers' time on screen. */
function relationLayerSpan(relation) {
  const spans = relation.layerIds.map(layerSpan).filter(Boolean);
  if (!spans.length) return null;
  return { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) };
}

const PROBLEMS = {
  'no-selection': 'Click the person on the video first — or drag a box around them.',
  'not-found': 'They couldn’t be followed from that. Try a tighter box, on a frame where they’re clearly visible.',
  'no-layer': 'This layer has no time on screen yet — give it a start and an end first.',
  busy: 'Another person is still being followed — give it a moment, then try again.'
};
export function describeFollowProblem(reason) {
  return PROBLEMS[reason] || 'Something went wrong following them. Try again from a clearer frame.';
}

/**
 * THE ONE-CLICK FLOW: follow the selected object for exactly the time this
 * layer is on screen, then put the layer behind it.
 * Resolves to { ok: true, trackKey, relation } — or { ok: false, reason }.
 */
export async function followSelectionBehindLayer(layerId, { fps = FOLLOW_FPS, onProgress = null } = {}) {
  if (running) return { ok: false, reason: 'busy' };
  const selection = followableSelection();
  if (!selection) return { ok: false, reason: 'no-selection' };
  const span = layerSpan(layerId);
  if (!span) return { ok: false, reason: 'no-layer' };
  const store = useFollowStore.getState();
  store.setProblem(null);
  store.setJob({ layerId, kind: 'follow', label: selection.label, done: 0, total: 0, secondsLeft: null });
  try {
    const result = await tamSegmentSpan({
      box: selection.box,
      boxTime: selection.time,
      start: span.start,
      end: span.end,
      fps,
      label: selection.label,
      onProgress: (p) => {
        store.setJob({ layerId, kind: 'follow', label: selection.label, ...p });
        onProgress?.(p);
      }
    });
    if (!result) {
      const reason = cancelled ? 'cancelled' : 'not-found';
      if (reason !== 'cancelled') store.setProblem({ layerId, message: describeFollowProblem(reason) });
      return { ok: false, reason };
    }
    const relation = setLayerBehind(layerId, result.trackKey);
    // Exactly the layer's span (the job's frames land on its own grid).
    if (relation) updateOcclusion(relation.id, { start: span.start, end: span.end, followsLayer: true }, { recordHistory: false });
    return { ok: true, trackKey: result.trackKey, relation };
  } finally {
    store.setJob(null);
  }
}

// --- Picking the person, from the layer's own panel ---------------------------------

let pickStop = null;

/**
 * "Put behind someone": turns the video into a picker — click the person (a
 * detected box), or drag a box around anything — and the moment something is
 * picked, follows it over this layer's time and puts the layer behind it. No
 * Objects panel, no whole-video track or segment step.
 */
export function startPickingBehind(layerId) {
  cancelPicking();
  const store = useFollowStore.getState();
  store.setProblem(null);
  const before = getSelectedObject()?.detectionId ?? null;
  const video = document.getElementById('preview-video');
  video?.pause();
  setObjectsMode(true);
  detectCurrentFrame().catch(() => {});
  store.setPicking({ layerId });
  const off = subscribe('selectedObject', () => {
    const now = getSelectedObject();
    if (!now || now.detectionId === before) return;
    cancelPicking();
    followSelectionBehindLayer(layerId);
  });
  // Escape is "never mind".
  const onKey = (e) => { if (e.key === 'Escape') cancelPicking(); };
  document.addEventListener('keydown', onKey, true);
  pickStop = () => { off(); document.removeEventListener('keydown', onKey, true); setObjectsMode(false); };
}

export function cancelPicking() {
  if (pickStop) { const stop = pickStop; pickStop = null; stop(); }
  if (useFollowStore.getState().picking) useFollowStore.getState().setPicking(null);
}

// --- Effects that follow their layers ---------------------------------------------------

let reconcileTimer = null;
// Extensions already tried, by track and span — one attempt each, so a span
// that cannot be covered can never turn into a loop of model runs.
const attempted = new Set();

/**
 * Keeps every "behind" relationship that follows its layer in step with it:
 * the effect's start and end become the layer's, and if the layer now runs
 * past what was processed, the missing seconds are processed — only those.
 * Debounced, so a trim drag settles before anything runs.
 */
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, 700);
}

async function reconcile() {
  if (running) { running.finally(scheduleReconcile); return; }
  for (const relation of getOcclusions()) {
    if (relation.followsLayer === false || relation.mode !== 'behind') continue;
    const span = relationLayerSpan(relation);
    if (!span) continue;
    if (Math.abs(span.start - relation.start) > 1e-3 || Math.abs(span.end - relation.end) > 1e-3) {
      // Folds into the layer edit's own Undo step (no history entry of its own).
      updateOcclusion(relation.id, { start: span.start, end: span.end }, { recordHistory: false });
    }
    const track = appState.objectTracks?.[relation.trackKey];
    if (track?.source?.engine !== 'edgetam') continue;
    if (span.start >= track.startTime - COVER_SLACK && span.end <= track.endTime + COVER_SLACK) continue;
    const attempt = relation.trackKey + '|' + span.start.toFixed(2) + '|' + span.end.toFixed(2);
    if (attempted.has(attempt)) continue;
    attempted.add(attempt);
    const layerId = relation.layerIds[0];
    const store = useFollowStore.getState();
    store.setJob({ layerId, kind: 'extend', label: track.label || 'subject', done: 0, total: 0, secondsLeft: null });
    try {
      const out = await extendFollow(relation.trackKey, span.start, span.end, {
        onProgress: (p) => store.setJob({ layerId, kind: 'extend', label: track.label || 'subject', ...p })
      });
      if (out === null && !cancelled) store.setProblem({ layerId, message: 'The new part couldn’t be followed. Try putting it behind them again.' });
    } catch (err) {
      console.warn('[Occlusion] Extending the follow failed:', err);
      store.setProblem({ layerId, message: 'The new part couldn’t be followed. Try putting it behind them again.' });
    } finally {
      store.setJob(null);
    }
    // One at a time; anything else that changed meanwhile is picked up next.
    scheduleReconcile();
    return;
  }
}

let following = false;
/** Starts keeping occlusion effects in step with their layers (once). */
export function initFollowAlongLayers() {
  if (following) return;
  following = true;
  ['textElements', 'imageLayers', 'shapeLayers', 'occlusions'].forEach((key) => subscribe(key, scheduleReconcile));
}
