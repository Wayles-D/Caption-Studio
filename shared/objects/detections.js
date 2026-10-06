/**
 * OBJECT DETECTIONS — what the detector found in a video's frames, in a form
 * any future consumer (tracking, segmentation, object-aware effects) can read
 * without knowing which model found it.
 *
 *   DetectionSet                      one video, one model, one setting
 *   ├── source     { kind: 'video', key }   (video identity + length)
 *   ├── model      { id, version }
 *   ├── settings   { storeMinConfidence }
 *   └── frames[]   one per analysed frame, time-sorted
 *       ├── time         seconds into the video (authoritative)
 *       └── detections[]
 *           ├── id          unique: this frame + this box (never shared)
 *           ├── class       the detector's own class name ('person', 'cup'…)
 *           ├── label       a human-readable name for the UI
 *           ├── confidence  0-1
 *           ├── box         { x, y, width, height }, 0-1 of the UPRIGHT video
 *           │               frame (as the browser and ffmpeg both display it)
 *           └── time        the frame's time again, so a detection stands alone
 *
 * NOT IDENTITY. Two people in one frame are two detections; the same person
 * in two frames is two detections too. Linking them over time is tracking
 * (a later milestone) — nothing here pretends to.
 *
 * VIDEO SPACE. Boxes are fractions of the video frame, so they never depend
 * on the editor's size, the canvas's shape, the zoom or the export
 * resolution. Placing them on the canvas or the screen is
 * shared/objects/coordinates.js's job.
 */
import { classLabel } from './yolox.js';

/** The detector models BHYND knows. Bump a version and every cached result for it is redone. */
export const DETECTION_MODELS = {
  // YOLOX-Tiny: 20MB, COCO 80 classes, ~0.3s a frame on one CPU thread. Chosen
  // over Nano (3.7MB, ~3x faster), which on real footage read a wall sign as a
  // traffic light in every frame and found fewer people.
  'yolox-tiny': { id: 'yolox-tiny', version: '0.1.1rc0', file: 'yolox_tiny.onnx', inputSize: 416, license: 'Apache-2.0' }
};
export const DEFAULT_MODEL_ID = 'yolox-tiny';

/** Everything at or above this is KEPT; the display threshold filters further, so changing it never needs a re-scan. */
export const STORE_MIN_CONFIDENCE = 0.25;
/** What the editor shows by default — below this a box is more likely noise than an object. */
export const DEFAULT_MIN_CONFIDENCE = 0.45;

const finite = (v, fallback = null) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** The identity of a video as analysed: anything that changes the video changes the key. */
export function videoSourceKey({ videoId, duration, width, height }) {
  if (!videoId) return null;
  const d = finite(duration);
  return `video:${videoId}:${d == null ? '?' : d.toFixed(2)}:${width || '?'}x${height || '?'}`;
}

/** Which cache a result belongs in — the video, the model and the settings together. */
export function detectionCacheKey(sourceKey, modelId = DEFAULT_MODEL_ID) {
  const m = DETECTION_MODELS[modelId];
  return sourceKey && m ? `${sourceKey}|${m.id}@${m.version}|min${STORE_MIN_CONFIDENCE}` : null;
}

/** A frame's time as the id stem: milliseconds, so two frames never collide. */
const timeStem = (t) => String(Math.round(t * 1000)).padStart(7, '0');

/** Raw detector output for one frame → normalized detections with unique ids. */
export function makeFrameDetections(time, raw) {
  return (raw || [])
    .map((d) => normalizeDetection({ ...d, class: d.class ?? d.cls, time }, 0))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence)
    .map((d, i) => ({ ...d, id: `det-${timeStem(time)}-${i}` }));
}

export function normalizeDetection(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const cls = typeof raw.class === 'string' && raw.class ? raw.class : null;
  const b = raw.box || {};
  const x = finite(b.x);
  const y = finite(b.y);
  const w = finite(b.width);
  const h = finite(b.height);
  const time = finite(raw.time);
  if (!cls || x == null || y == null || !(w > 0) || !(h > 0) || time == null) return null;
  const box = { x: clamp01(x), y: clamp01(y), width: Math.min(1 - clamp01(x), w), height: Math.min(1 - clamp01(y), h) };
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `det-${timeStem(time)}-${index}`,
    class: cls,
    label: typeof raw.label === 'string' && raw.label ? raw.label : classLabel(cls),
    confidence: clamp01(finite(raw.confidence, 0)),
    box,
    time
  };
}

/** A stored detection set, normalized; null for anything that isn't one (or is for a model no longer current). */
export function normalizeDetectionSet(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = DETECTION_MODELS[raw.model?.id];
  if (!model || raw.model.version !== model.version) return null;
  const frames = (Array.isArray(raw.frames) ? raw.frames : [])
    .map((f) => ({ time: finite(f?.time), detections: (f?.detections || []).map(normalizeDetection).filter(Boolean) }))
    .filter((f) => f.time != null && f.time >= 0)
    .sort((a, b) => a.time - b.time);
  return {
    source: raw.source && typeof raw.source === 'object' ? { ...raw.source } : null,
    model: { id: model.id, version: model.version },
    settings: { storeMinConfidence: STORE_MIN_CONFIDENCE },
    frames
  };
}

/** Whether a stored set is authoritative for this video and model — anything else is stale. */
export function isDetectionSetValidFor(set, cacheKey) {
  return !!set && !!cacheKey && detectionCacheKey(set.source?.key, set.model?.id) === cacheKey;
}

/** The frame analysed at (or within `tolerance` of) `time`, or null. */
export function frameAt(set, time, tolerance = 0.02) {
  if (!set?.frames?.length) return null;
  let best = null;
  for (const f of set.frames) {
    const d = Math.abs(f.time - time);
    if (d <= tolerance && (!best || d < Math.abs(best.time - time))) best = f;
  }
  return best;
}

/** A frame's detections at or above a confidence. */
export function visibleDetections(frame, minConfidence = DEFAULT_MIN_CONFIDENCE) {
  return (frame?.detections || []).filter((d) => d.confidence >= minConfidence);
}

/** Adds (or replaces) one frame's detections in a set, keeping it time-sorted. */
export function withFrame(set, time, detections) {
  const frames = (set?.frames || []).filter((f) => Math.abs(f.time - time) > 1e-4);
  frames.push({ time, detections });
  frames.sort((a, b) => a.time - b.time);
  return { ...set, frames };
}

/**
 * THE SAMPLING STRATEGY — which frames a scan analyses, kept apart from the
 * detector so tracking can replace it. Evenly spaced, one every `interval`
 * seconds, at most `maxFrames` (a long video spreads them further apart),
 * starting half an interval in so the first frame isn't a black fade-in.
 */
export function sampleTimes(duration, { interval = 1, maxFrames = 60 } = {}) {
  if (!(duration > 0)) return [];
  const count = Math.max(1, Math.min(maxFrames, Math.floor(duration / interval)));
  const step = duration / count;
  return Array.from({ length: count }, (_, i) => +((i + 0.5) * step).toFixed(3));
}
