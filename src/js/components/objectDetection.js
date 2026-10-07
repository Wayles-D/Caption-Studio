/**
 * OBJECT DETECTION in the editor — the one place that knows which video is
 * analysed, grabs its frames, runs the detector (in a Web Worker), caches
 * the results and holds the user's SELECTED OBJECT. Consumers ask:
 *
 *   getDetectionsAt(t)     what was found in the frame at t (if analysed)
 *   getSelectedObject()    which detected object the user means
 *
 * and never see frames, models or pixels. Placing boxes on the canvas or the
 * screen is shared/objects/coordinates.js's job.
 *
 * Runs only when asked (scan the video, or look at the paused frame) — never
 * per frame, never in export. Frames come from a PRIVATE hidden <video>, so
 * analysis never moves the user's playhead. The browser decodes it upright
 * (rotation metadata applied), the same orientation the preview shows and
 * ffmpeg exports, so a box means the same thing everywhere.
 *
 * SELECTION IS NOT TRACKING: a selected object is one detection, in one
 * frame — or a box the user DREW round anything the detector missed
 * (selectManualObject). Nothing here follows it through time.
 */
import { appState, subscribe, updateState } from '../state.js';
import {
  DETECTION_MODELS, DEFAULT_MODEL_ID, STORE_MIN_CONFIDENCE,
  videoSourceKey, detectionCacheKey, makeFrameDetections, normalizeDetectionSet,
  isDetectionSetValidFor, frameAt, visibleDetections, withFrame, sampleTimes
} from '../../../shared/objects/detections.js';
import { appearanceOf } from '../../../shared/objects/appearance.js';
import { zoomRect, fromRegion, thumbnail } from '../../../shared/objects/frames.js';
import { manualObjectId, normalizeManualBox, MANUAL_CLASS, MANUAL_LABEL, MATCHER } from '../../../shared/objects/templateMatch.js';

const MODEL_ID = DEFAULT_MODEL_ID;
/** Frames are analysed at most this long on their long side — plenty for a 416px model. */
const MAX_FRAME_SIDE = 960;

function getPreviewVideo() {
  return document.getElementById('preview-video');
}

/** The video being analysed — its identity is what keys every result. */
export function getDetectionSource() {
  const v = getPreviewVideo();
  const src = v?.currentSrc || v?.src;
  if (!src || !(v.duration > 0) || !(v.videoWidth > 0)) return null;
  const videoId = appState.baseName || (appState.uploadedFile?.demo ? 'demo' : appState.uploadedFile?.name) || 'video';
  const key = videoSourceKey({ videoId, duration: v.duration, width: v.videoWidth, height: v.videoHeight });
  return { kind: 'video', key, url: src, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
}

export function getCacheKey() {
  return detectionCacheKey(getDetectionSource()?.key, MODEL_ID);
}

/** The valid detection set for the current video and model, or null (none yet, or stale). */
export function getDetectionSet() {
  const key = getCacheKey();
  const set = key ? appState.objectDetections?.[key] : null;
  return isDetectionSetValidFor(set, key) ? set : null;
}

/** How close the playhead must be to an analysed frame for its boxes to apply: half a frame. */
function frameTolerance() {
  return 1 / 60;
}

/** The analysed frame at `t` (or null), and its detections above the display threshold. */
export function getDetectionsAt(t) {
  const frame = frameAt(getDetectionSet(), t, frameTolerance());
  return frame ? { time: frame.time, detections: visibleDetections(frame, appState.objectMinConfidence) } : null;
}

// --- Frames ------------------------------------------------------------------

// LANES: each its own private video and its own detector worker, so the
// tracker's two directions (forward, backward) run side by side. Lane 0 is
// also everything else's (scans, the paused frame).
const lanes = [];

function getLane(i = 0) {
  if (!lanes[i]) lanes[i] = { video: null, src: null, queue: Promise.resolve(), worker: null };
  return lanes[i];
}

function frameVideo(url, lane) {
  const l = getLane(lane);
  if (!l.video) {
    l.video = document.createElement('video');
    l.video.muted = true;
    l.video.playsInline = true;
    l.video.preload = 'auto';
    l.video.crossOrigin = 'anonymous';
  }
  if (l.src !== url) {
    l.video.src = url;
    l.src = url;
  }
  return l.video;
}

function once(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener(event, on); reject(new Error(`timed out waiting for the video (${event})`)); }, timeoutMs);
    const on = () => { clearTimeout(timer); target.removeEventListener(event, on); resolve(); };
    target.addEventListener(event, on);
  });
}

// One user of a lane's video at a time: a scan and a track (or a track and
// a paused-frame detection) must never seek it under each other.
function grabFrame(url, time, { lane = 0, region = null } = {}) {
  const l = getLane(lane);
  const run = l.queue.then(() => grabFrameNow(url, time, lane, region));
  l.queue = run.catch(() => {});
  return run;
}

/**
 * The frame at `time`, as RGBA pixels at up to MAX_FRAME_SIDE, from a
 * private video — and, with `region`, that region cropped from the video at
 * its FULL resolution, sized for the detector (shared/objects/frames.js).
 */
/** A lane's private video, loaded and showing the frame at `time`. */
async function seekPrivate(url, time, lane) {
  const v = frameVideo(url, lane);
  if (!(v.readyState >= 1)) await once(v, 'loadedmetadata', 15000);
  const target = Math.min(Math.max(0, time), Math.max(0, v.duration - 0.01));
  if (Math.abs(v.currentTime - target) > 1e-4 || v.readyState < 2) {
    const seeked = once(v, 'seeked', 15000);
    v.currentTime = target;
    await seeked;
  }
  return v;
}

/**
 * SEGMENTATION's input (objectSegmentation.js): the crop of the frame at
 * `time`, drawn straight from the private video at its full resolution and
 * resized to the encoder's input — HWC RGB 0-255 floats. Through lane 0's
 * lock, like every other read of that video.
 * @param {{x:number, y:number, width:number, height:number, inputWidth:number, inputHeight:number}} crop video pixels (segmentation.js's cropFor)
 */
export function grabSegmentationInput(time, crop) {
  const source = getDetectionSource();
  if (!source) return Promise.reject(new Error('no video to analyse'));
  const l = getLane(0);
  const run = l.queue.then(async () => {
    const v = await seekPrivate(source.url, time, 0);
    const c = new OffscreenCanvas(crop.inputWidth, crop.inputHeight).getContext('2d', { willReadFrequently: true });
    c.drawImage(v, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.inputWidth, crop.inputHeight);
    const rgba = c.getImageData(0, 0, crop.inputWidth, crop.inputHeight).data;
    const data = new Float32Array(crop.inputWidth * crop.inputHeight * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { data[j] = rgba[i]; data[j + 1] = rgba[i + 1]; data[j + 2] = rgba[i + 2]; }
    return { data };
  });
  l.queue = run.catch(() => {});
  return run;
}

/**
 * A MANUAL object's look at a frame (shared/objects/templateMatch.js):
 * `region` (0-1) of the frame at `time`, drawn from the private video at its
 * full resolution into outWidth×outHeight RGBA, and the frame's greyscale
 * thumbnail (camera motion, cuts). The direction picks the lane, as
 * observeFrame's does.
 */
export function grabRegion(time, region, outWidth, outHeight, { direction = 0 } = {}) {
  const source = getDetectionSource();
  if (!source) return Promise.reject(new Error('no video to analyse'));
  const lane = direction < 0 && (navigator.hardwareConcurrency || 2) >= 4 ? 1 : 0;
  const l = getLane(lane);
  const run = l.queue.then(async () => {
    const v = await seekPrivate(source.url, time, lane);
    const c = new OffscreenCanvas(outWidth, outHeight).getContext('2d', { willReadFrequently: true });
    c.imageSmoothingQuality = 'high';
    c.drawImage(v, region.x * v.videoWidth, region.y * v.videoHeight, region.width * v.videoWidth, region.height * v.videoHeight, 0, 0, outWidth, outHeight);
    const image = c.getImageData(0, 0, outWidth, outHeight);
    const tw = Math.min(MAX_FRAME_SIDE, v.videoWidth);
    const th = Math.max(1, Math.round((v.videoHeight * tw) / v.videoWidth));
    const whole = new OffscreenCanvas(tw, th).getContext('2d', { willReadFrequently: true });
    whole.drawImage(v, 0, 0, tw, th);
    const frame = whole.getImageData(0, 0, tw, th);
    return { image: { data: image.data, width: outWidth, height: outHeight }, thumb: thumbnail({ data: frame.data, width: tw, height: th }) };
  });
  l.queue = run.catch(() => {});
  return run;
}

async function grabFrameNow(url, time, lane, region) {
  const v = await seekPrivate(url, time, lane);
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(1, Math.round(v.videoWidth * scale));
  const h = Math.max(1, Math.round(v.videoHeight * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const frame = { data: img.data, width: w, height: h };
  if (!region) return frame;
  const r = zoomRect(region, v.videoWidth, v.videoHeight);
  const zc = new OffscreenCanvas(r.width, r.height).getContext('2d', { willReadFrequently: true });
  zc.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, r.width, r.height);
  const zoom = zc.getImageData(0, 0, r.width, r.height);
  return { ...frame, zoom: { data: zoom.data, width: r.width, height: r.height } };
}

// --- The detector --------------------------------------------------------------

let seq = 0;

function getWorker(lane = 0) {
  const l = getLane(lane);
  if (!l.worker) l.worker = new Worker(new URL('../objects/detectorWorker.js', import.meta.url), { type: 'module' });
  return l.worker;
}

function detect(frame, lane = 0) {
  const id = ++seq;
  const model = DETECTION_MODELS[MODEL_ID];
  return new Promise((resolve, reject) => {
    const w = getWorker(lane);
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.detections);
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, modelUrl: `/models/${model.file}`, inputSize: model.inputSize, frame, minScore: STORE_MIN_CONFIDENCE }, [frame.data.buffer]);
  });
}

function setStatus(patch) {
  updateState({ objectStatus: { ...(appState.objectStatus || {}), ...patch } }, { recordHistory: false });
}

/** Stores one analysed frame under the current cache key; drops sets for any other video. */
function storeFrame(source, cacheKey, time, detections) {
  const existing = appState.objectDetections?.[cacheKey];
  const base = isDetectionSetValidFor(existing, cacheKey)
    ? existing
    : normalizeDetectionSet({ source: { kind: 'video', key: source.key }, model: { id: MODEL_ID, version: DETECTION_MODELS[MODEL_ID].version }, frames: [] });
  const next = withFrame(base, time, makeFrameDetections(time, detections));
  // Only the current video's set is kept: a replaced video takes its
  // detections with it, so nothing stale can be mistaken for the new one.
  updateState({ objectDetections: { [cacheKey]: next } }, { recordHistory: false });
}

let busy = null;

/**
 * Clears `busy` when THIS job ends — after it has been assigned. (A job with
 * nothing to do finishes synchronously; clearing inside it ran before the
 * assignment, leaving a finished job looking busy forever.)
 */
function track(job) {
  job.finally(() => { if (busy === job) busy = null; });
  return job;
}

/** Analyses one frame (cached: a frame already analysed is never redone). */
export async function detectFrame(time) {
  const source = getDetectionSource();
  const cacheKey = getCacheKey();
  if (!source || !cacheKey) throw new Error('no video to analyse');
  const cached = frameAt(getDetectionSet(), time, frameTolerance());
  if (cached) return cached;
  const frame = await grabFrame(source.url, time);
  const detections = await detect(frame);
  if (getCacheKey() !== cacheKey) return null; // the video changed meanwhile
  storeFrame(source, cacheKey, time, detections);
  return frameAt(getDetectionSet(), time, frameTolerance());
}

/** Detects the frame the preview is showing. */
export async function detectCurrentFrame() {
  const t = getPreviewVideo()?.currentTime ?? 0;
  if (busy) return busy;
  busy = (async () => {
    setStatus({ state: 'detecting', done: 0, total: 1, message: null });
    try {
      const frame = await detectFrame(t);
      setStatus({ state: 'ready', done: 1, total: 1 });
      return frame;
    } catch (err) {
      console.warn('[Objects] Detection failed — editing is unaffected:', err);
      setStatus({ state: 'failed', message: err?.message || String(err) });
      return null;
    }
  })();
  return track(busy);
}

/**
 * Scans the whole video at the sampling strategy's frames (see
 * shared/objects/detections.js's sampleTimes), skipping any already
 * analysed. Progress is real: frames done of frames to do.
 */
export async function scanVideo(options = {}) {
  if (busy) return busy;
  const source = getDetectionSource();
  if (!source) return null;
  busy = (async () => {
    const times = sampleTimes(source.duration, options);
    const todo = times.filter((t) => !frameAt(getDetectionSet(), t, frameTolerance()));
    setStatus({ state: 'detecting', done: 0, total: todo.length, message: null });
    try {
      for (let i = 0; i < todo.length; i++) {
        if (getDetectionSource()?.key !== source.key) break;
        await detectFrame(todo[i]);
        setStatus({ done: i + 1 });
      }
      setStatus({ state: 'ready' });
      return getDetectionSet();
    } catch (err) {
      console.warn('[Objects] Scan failed — editing is unaffected:', err);
      setStatus({ state: 'failed', message: err?.message || String(err) });
      return null;
    }
  })();
  return track(busy);
}

// What the tracker has looked at this session: kept in memory (a re-track
// reuses it), never saved — a long track would otherwise add hundreds of
// frames of boxes to the project.
const observations = new Map();
const MAX_OBSERVATIONS = 400;

/**
 * A frame's detections WITH their appearance fingerprints, and its
 * thumbnail — what the tracker (src/js/components/objectTracking.js)
 * consumes. With `region` (0-1 of the frame) the detector looks at that
 * region alone, zoomed (shared/objects/frames.js); `direction` picks the
 * lane, so forward and backward never wait for each other.
 */
export async function observeFrame(time, { region = null, direction = 0 } = {}) {
  const source = getDetectionSource();
  const cacheKey = getCacheKey();
  if (!source || !cacheKey) throw new Error('no video to analyse');
  const key = `${cacheKey}|${time.toFixed(3)}|${region ? [region.x, region.y, region.width].map((n) => n.toFixed(3)).join(',') : 'all'}`;
  if (observations.has(key)) return observations.get(key);
  // A second lane only where there are cores for it; otherwise the two
  // directions take turns on one.
  const lane = direction < 0 && (navigator.hardwareConcurrency || 2) >= 4 ? 1 : 0;
  const pixels = await grabFrame(source.url, time, { lane, region });
  let detections;
  const scanned = !region && frameAt(getDetectionSet(), time, frameTolerance());
  if (scanned) detections = scanned.detections;
  else {
    // The detector transfers (consumes) its pixels — give it a copy.
    const input = region ? pixels.zoom : { data: new Uint8ClampedArray(pixels.data), width: pixels.width, height: pixels.height };
    const raw = await detect(input, lane);
    if (getCacheKey() !== cacheKey) throw new Error('the video changed');
    detections = makeFrameDetections(time, fromRegion(raw, region));
  }
  const obs = { time, thumb: thumbnail(pixels), candidates: detections.map((d) => ({ ...d, appearance: appearanceOf(pixels, d.box) })) };
  observations.set(key, obs);
  if (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value);
  return obs;
}

export function isDetecting() {
  return !!busy;
}

// --- The selected object (the OBJECT TARGET) ----------------------------------

/**
 * The detected object the user picked — what a future feature (tracking,
 * segmentation, an object-aware effect) will act on. Undoable and saved.
 * @returns {{detectionId:string, class:string, label:string, confidence:number, timestamp:number, box:object, source:{key:string, model:string}}|null}
 */
export function getSelectedObject() {
  const sel = appState.selectedObject;
  if (!sel) return null;
  // Belongs to this video and model, or it is stale and means nothing here.
  return sel.source?.key === getCacheKey() ? sel : null;
}

export function selectObject(detection) {
  if (!detection) return clearSelectedObject();
  updateState({
    selectedObject: {
      detectionId: detection.id,
      class: detection.class,
      label: detection.label,
      confidence: detection.confidence,
      timestamp: detection.time,
      box: { ...detection.box },
      source: { key: getCacheKey(), model: `${MODEL_ID}@${DETECTION_MODELS[MODEL_ID].version}` }
    }
  }, { recordHistory: true });
}

/**
 * Selects ANYTHING: a box the user drew on the frame at `time` (0-1 of the
 * video), whether or not the detector found something there. It is then
 * tracked by its own pixels (objectTracking.js → templateMatch.js) — and
 * segmented and given effects like any detected object.
 * @returns {object|null} the selection, or null when there is no video or the box is too small
 */
export function selectManualObject(box, time) {
  const source = getDetectionSource();
  if (!source) return null;
  const b = normalizeManualBox(box, source.width, source.height);
  if (!b) return null;
  const selection = {
    detectionId: manualObjectId(time, b),
    class: MANUAL_CLASS,
    label: MANUAL_LABEL,
    confidence: 1,
    timestamp: time,
    box: b,
    manual: true,
    source: { key: getCacheKey(), model: `${MATCHER.id}@${MATCHER.version}` }
  };
  updateState({ selectedObject: selection }, { recordHistory: true });
  return selection;
}

export function clearSelectedObject() {
  if (appState.selectedObject) updateState({ selectedObject: null }, { recordHistory: true });
}

export function setObjectsMode(on) {
  updateState({ objectsMode: !!on }, { recordHistory: false });
}

/**
 * A display name that tells same-class detections apart within a frame:
 * "Person 1", "Person 2" (largest first, so the numbering is stable).
 */
export function displayNames(detections) {
  const byClass = new Map();
  [...detections].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height).forEach((d) => {
    const list = byClass.get(d.class) || [];
    list.push(d);
    byClass.set(d.class, list);
  });
  const names = new Map();
  byClass.forEach((list) => list.forEach((d, i) => names.set(d.id, list.length > 1 ? `${d.label} ${i + 1}` : d.label)));
  return names;
}

let started = false;

export function initObjectDetection() {
  if (started) return;
  started = true;
  // A different video: the old video's detections no longer apply — dropped
  // at the next store (storeFrame keeps only the current key), and never
  // read before then (getDetectionSet checks the key).
  const reset = () => { setStatus({ state: 'idle', done: 0, total: 0, message: null }); };
  ['baseName', 'uploadedFile'].forEach((k) => subscribe(k, reset));
  // Paused in Objects mode on a frame not yet analysed: analyse it.
  const v = () => getPreviewVideo();
  const maybeDetect = () => {
    if (!appState.objectsMode || v()?.paused === false) return;
    const t = v()?.currentTime ?? 0;
    if (frameAt(getDetectionSet(), t, frameTolerance())) return;
    // Still busy with another frame (the one the tool opened on, say): look
    // again when it is done — otherwise the frame paused on now is never
    // analysed.
    if (busy) { busy.finally(() => setTimeout(maybeDetect, 0)); return; }
    detectCurrentFrame();
  };
  document.addEventListener('seeked', (e) => { if (e.target?.id === 'preview-video') maybeDetect(); }, true);
  document.addEventListener('pause', (e) => { if (e.target?.id === 'preview-video') maybeDetect(); }, true);
  subscribe('objectsMode', maybeDetect);
}
