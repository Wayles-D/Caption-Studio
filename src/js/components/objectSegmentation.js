/**
 * OBJECT SEGMENTATION in the editor — which pixels belong to the SELECTED,
 * TRACKED object, over time. Consumers ask:
 *
 *   getSelectedSegmentation()   the selected object's segmentation record, if any
 *   getSelectedMaskAt(t)        its mask at t (shared/objects/segmentation.js's
 *                               getMaskAtTime) — null where there is none
 *
 * Tracking ends where this begins: the track (objectTracking.js) says where
 * the object is; each keyframe's crop and prompt come from it, and the frame's
 * detections (objectDetection.js's observeFrame — the same detector, the same
 * session cache) say who else is there. The model runs in its own worker
 * (src/js/objects/segmenterWorker.js — the GPU where it can, the CPU if not).
 * Nothing here draws (objectOverlay.js does, editor-only), and no renderer or
 * export runs it.
 *
 * Runs only when asked ("Segment") — never per frame, never in export. The
 * record (keyframe times and confidences) is saved with the project; the
 * pixels are an ANALYSIS FILE beside it (projectPersistence.js), deflated —
 * loaded on first need, and never all decoded at once.
 */
import { appState, updateState, subscribe } from '../state.js';
import {
  segmentTrack, segmentationCacheKey, isSegmentationValidFor, normalizeSegmentation, packMasks, unpackMasks,
  createMaskReader, getMaskAtTime, encodeRLE, buildSegmentation, DEFAULT_SEGMENTATION_CONFIG
} from '../../../shared/objects/segmentation.js';
import { getTrackAtTime } from '../../../shared/objects/tracking.js';
import { getSelectedTrack, getSelectedTrackKey } from './objectTracking.js';
import { getDetectionSource, getCacheKey, grabSegmentationInput, observeFrame } from './objectDetection.js';
import { putAnalysisFile, getAnalysisFile, deleteAnalysisFile } from '../projectPersistence.js';

let config = { ...DEFAULT_SEGMENTATION_CONFIG };

/** Dev/test aid: a different keyframe step etc. (a different cache key — never mixes with the default). */
export function setSegmentationConfig(patch) {
  config = { ...DEFAULT_SEGMENTATION_CONFIG, ...(patch || {}) };
}

// --- Finding a segmentation ------------------------------------------------------------

/** The segmentation of `track` (key `trackKey`) for the current settings — or null (none, or stale). */
export function getSegmentationFor(trackKey, track) {
  const key = segmentationCacheKey(trackKey, track, config);
  const rec = key ? appState.objectSegmentations?.[key] : null;
  return rec && isSegmentationValidFor(rec, trackKey, track, config) ? rec : null;
}

export function getSelectedSegmentation() {
  const track = getSelectedTrack();
  return track ? getSegmentationFor(getSelectedTrackKey(), track) : null;
}

// --- The pixels -------------------------------------------------------------------------

const readers = new Map(); // record key → reader, or the Promise loading it

async function deflate(bytes) {
  return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();
}
async function inflate(blob) {
  return new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}

/** The record's mask reader if it is in memory; otherwise starts loading it from the analysis file and returns null. */
function readerFor(record) {
  const r = readers.get(record.key);
  if (r && !(r instanceof Promise)) return r;
  if (!r) {
    const loading = (async () => {
      const blob = await getAnalysisFile(record.key);
      if (!blob) throw new Error('the masks are not on this device');
      const reader = createMaskReader(record, unpackMasks(await inflate(blob), record));
      readers.set(record.key, reader);
      // Whoever draws masks redraws now they are here.
      updateState({ segmentationStatus: { ...(appState.segmentationStatus || {}), loadedKey: record.key } }, { recordHistory: false });
      return reader;
    })().catch((err) => {
      readers.delete(record.key);
      console.warn('[Objects] Masks could not be loaded:', err);
      setStatus({ state: 'failed', message: err?.message || String(err), key: record.key });
    });
    readers.set(record.key, loading);
  }
  return null;
}

// The RUNNING job's masks so far — shown as they come, before the job ends.
let live = null; // { trackKey, reader }

/** The mask of `track` at `time` — null where there is none (or while its file is still loading). */
export function getMaskAt(trackKey, track, time) {
  if (live && live.trackKey === trackKey && !getSegmentationFor(trackKey, track)) {
    return getMaskAtTime(live.reader, (t) => getTrackAtTime(track, t), time);
  }
  const record = getSegmentationFor(trackKey, track);
  if (!record || record.status === 'failed') return null;
  const reader = readerFor(record);
  return reader ? getMaskAtTime(reader, (t) => getTrackAtTime(track, t), time) : null;
}

export function getSelectedMaskAt(time) {
  const track = getSelectedTrack();
  return track ? getMaskAt(getSelectedTrackKey(), track, time) : null;
}

// --- Running it ----------------------------------------------------------------------------

let worker = null;
let seq = 0;

/**
 * The model holds a few hundred MB in its worker. It is only needed while a
 * segmentation runs, so the worker is closed when the job ends — the editor
 * gets the memory back; the next job reloads the model (a second or two).
 */
function releaseWorker() {
  if (worker) { worker.terminate(); worker = null; }
}
export function isSegmenterLoaded() {
  return !!worker;
}

function getWorker() {
  if (!worker) worker = new Worker(new URL('../objects/segmenterWorker.js', import.meta.url), { type: 'module' });
  return worker;
}

/** One model pass in the worker. */
function runModel(input) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.error) reject(new Error(e.data.error));
      else {
        if (e.data.backend && appState.segmentationStatus?.backend !== e.data.backend) setStatus({ backend: e.data.backend, gpuNote: e.data.gpuNote || null });
        resolve({ logits: e.data.logits, lowRes: e.data.lowRes, iou: e.data.iou });
      }
    };
    w.addEventListener('message', onMessage);
    // The worker gets its OWN copy: the crop's pixels are read again here
    // afterwards (the mask's colour identity — segmentation.js's
    // maskAppearance), and a transferred buffer is gone from this side.
    const image = input.image.slice();
    w.postMessage({ id, encoderUrl: '/models/mobilesam-encoder.onnx', decoderUrl: '/models/mobilesam-decoder.onnx', ...input, image }, [image.buffer]);
  });
}

// How long a keyframe takes on THIS device — learned from its last job (a
// GPU and a CPU differ ~3×; a fresh device starts from a guess by whether
// the browser has WebGPU at all).
const SPEED_KEY = 'bhynd:segment-seconds-per-keyframe';
function secondsPerKeyframe() {
  try {
    const v = Number(window.localStorage.getItem(SPEED_KEY));
    if (v > 0) return v;
  } catch { /* storage blocked: guess */ }
  return navigator.gpu ? 5 : 12;
}
function rememberSpeed(seconds) {
  try { if (seconds > 0) window.localStorage.setItem(SPEED_KEY, String(Math.round(seconds * 10) / 10)); } catch { /* fine */ }
}

/** Before starting: about how many keyframes, and how long, for the selected object. */
export function estimateSegmentation() {
  const track = getSelectedTrack();
  if (!track) return null;
  const keyframes = Math.max(2, Math.ceil((track.endTime - track.startTime) / 0.5) + 1);
  return { keyframes, seconds: Math.round(keyframes * secondsPerKeyframe()) };
}

function setStatus(patch) {
  updateState({ segmentationStatus: { ...(appState.segmentationStatus || {}), ...patch } }, { recordHistory: false });
}

let job = null;
let cancelled = false;

export function isSegmenting() {
  return !!job;
}

/** Stops a running segmentation; what was done so far is kept, marked partial. */
export function cancelSegmentation() {
  if (job) cancelled = true;
}

/**
 * Drops segmentations that no longer apply — their track gone, re-tracked
 * (another signature), or of another video — and their analysis files.
 */
export function dropStaleSegmentations() {
  // Not before the video is known: while a project reopens, every record
  // would look like another video's.
  if (!getCacheKey()) return;
  const all = appState.objectSegmentations || {};
  const keep = {};
  const drop = [];
  Object.entries(all).forEach(([key, rec]) => {
    const track = appState.objectTracks?.[rec?.trackKey];
    const sameVideo = track?.source?.detectionCacheKey === getCacheKey();
    if (rec && track && sameVideo && rec.key === segmentationCacheKey(rec.trackKey, track, rec.config)) keep[key] = rec;
    else drop.push(key);
  });
  if (!drop.length) return;
  drop.forEach((key) => { readers.delete(key); deleteAnalysisFile(key).catch(() => {}); });
  updateState({ objectSegmentations: keep }, { recordHistory: false });
}

/**
 * Segments the selected, tracked object — every keyframe of its track. A
 * segmentation that already exists for it (same track, same settings) is
 * reused, not redone.
 */
export async function segmentSelectedObject({ force = false } = {}) {
  if (job) return job;
  const track = getSelectedTrack();
  const trackKey = getSelectedTrackKey();
  const source = getDetectionSource();
  if (!track || !trackKey || !source) return null;
  if (!force && getSegmentationFor(trackKey, track)) return getSegmentationFor(trackKey, track);
  const key = segmentationCacheKey(trackKey, track, config);
  const detectionCacheKey = getCacheKey();
  cancelled = false;
  const liveKeyframes = [];
  const liveMasks = [];
  let grid = null;
  job = (async () => {
    const t0 = performance.now();
    setStatus({ state: 'segmenting', done: 0, total: 0, message: null, key, secondsLeft: estimateSegmentation()?.seconds ?? null });
    try {
      const { record, masks } = await segmentTrack({
        track,
        trackKey,
        frameSize: { width: source.width, height: source.height },
        config,
        boxAt: (t) => getTrackAtTime(track, t),
        grab: (t, crop) => grabSegmentationInput(t, crop),
        // Who else of its class is there — "not this" points (segmentation.js's negativePoints).
        others: async (t) => (await observeFrame(t)).candidates.filter((c) => c.class === track.class).map((c) => c.box),
        segment: runModel,
        onProgress: (done, total) => {
          const per = done ? (performance.now() - t0) / 1000 / done : secondsPerKeyframe();
          setStatus({ done, total, secondsLeft: Math.max(0, Math.round((total - done) * per)) });
        },
        // Each keyframe, as it is done: its mask shows on the frame at once.
        onKeyframe: (k) => {
          grid = k.grid;
          liveKeyframes.push(k.keyframe);
          liveMasks.push(encodeRLE(k.mask));
          const rec = buildSegmentation({ track, trackKey, config: k.config, grid, keyframes: liveKeyframes });
          live = { trackKey, reader: createMaskReader(rec, liveMasks) };
        },
        isCancelled: () => cancelled || getCacheKey() !== detectionCacheKey
      });
      if (getCacheKey() !== detectionCacheKey) return null; // the video changed meanwhile
      if (record.status === 'failed') throw new Error('nothing could be segmented');
      const blob = await deflate(packMasks(record, masks));
      await putAnalysisFile(record.key, blob);
      const stored = normalizeSegmentation({ ...record, artifact: { key: record.key, bytes: blob.size }, seconds: +((performance.now() - t0) / 1000).toFixed(1), backend: appState.segmentationStatus?.backend || null });
      readers.set(stored.key, createMaskReader(stored, masks.map(encodeRLE)));
      updateState({ objectSegmentations: { ...(appState.objectSegmentations || {}), [stored.key]: stored } }, { recordHistory: false });
      dropStaleSegmentations();
      if (record.keyframes.length) rememberSpeed((performance.now() - t0) / 1000 / (record.modelRuns || record.keyframes.length));
      setStatus({ state: 'done', message: null, secondsLeft: null });
      return stored;
    } catch (err) {
      console.warn('[Objects] Segmentation failed — editing is unaffected:', err);
      setStatus({ state: 'failed', message: err?.message || String(err) });
      return null;
    }
  })();
  job.finally(() => { job = null; live = null; releaseWorker(); });
  return job;
}

/** The segmentation in plain words, for the panel. */
export function describeSegmentation(record) {
  if (!record) return null;
  const titles = { completed: 'Segmented', 'low-confidence': 'Segmented — low confidence', partial: 'Segmented — stopped early', failed: 'Segmentation failed' };
  const kfs = record.keyframes;
  const hidden = kfs.filter((k) => k.hidden).length;
  const low = kfs.filter((k) => !k.hidden && k.level === 'low').length;
  const notes = [];
  if (hidden) notes.push(`${hidden} of ${kfs.length} keyframes without a mask (hidden behind something, or not itself).`);
  if (low) notes.push(`${low} low-confidence (partly hidden, or crossing).`);
  return {
    title: titles[record.status] || record.status,
    detail: `${kfs.length} keyframes, ${kfs[0]?.time.toFixed(1) ?? 0}–${kfs[kfs.length - 1]?.time.toFixed(1) ?? 0}s${record.seconds ? ` · ${record.seconds}s on the ${record.backend === 'gpu' ? 'GPU' : 'CPU'}` : ''}.`,
    note: notes.length ? notes.join(' ') : null,
    confidence: record.confidence
  };
}

export function setMaskView(view) {
  if (['off', 'overlay', 'silhouette', 'boundary'].includes(view)) updateState({ maskView: view }, { recordHistory: false });
}

// A re-tracked object (or a removed track) leaves its old masks stale.
subscribe('objectTracks', () => dropStaleSegmentations());
