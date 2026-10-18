/**
 * DYNAMIC OCCLUSION in the editor — putting a text, image or shape layer
 * BEHIND a tracked subject (shared/objects/occlusion.js), and drawing the
 * subject where it belongs in the stack.
 *
 *   select a subject → track it → segment it → "Put behind <subject>"
 *   → the layer passes behind them: no keyframes, no mask painting.
 *
 * The model is in shared/objects/occlusion.js and explains the idea (the
 * subject takes its own place in the one layer stack). This file is the
 * editor's half: the state, the checks, and the PAINT of a subject run onto
 * its own canvas in the preview — the same pixels the export composites.
 *
 * Every write goes through updateState: `occlusions` is a document key
 * (src/store/objectStore.js), so relationships are undoable and saved.
 */
import { appState, updateState, registerStyleParamsExtra } from '../state.js';
import {
  createOcclusion, normalizeOcclusion, normalizeOcclusionList, occlusionTrackKeys,
  MIN_OCCLUSION_DURATION, OCCLUSION_MODES
} from '../../../shared/objects/occlusion.js';
import { isTrackValidFor } from '../../../shared/objects/tracking.js';
import { getTrackAtTime } from '../../../shared/objects/tracking.js';
import { videoTransformFor, drawMaskAlpha, maskWithEdges } from '../../../shared/objects/subject.js';
import { effectUnit } from '../../../shared/objects/effects.js';
import { getCacheKey } from './objectDetection.js';
import { getMaskAt, getSegmentationFor, awaitSegmentations, segmentationPayloadFor } from './objectSegmentation.js';
import { currentPlacement } from './objectOverlay.js';
import { getPlayheadTime } from './textElements.js';

function videoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

export function getOcclusions() {
  return normalizeOcclusionList(appState.occlusions);
}

/** The track a relationship points at — or null when it is gone or no longer applies to this video. */
export function getOcclusionTrack(relation) {
  const track = relation ? appState.objectTracks?.[relation.trackKey] : null;
  if (!track || !isTrackValidFor(track, relation.trackKey)) return null;
  return track.source?.detectionCacheKey === getCacheKey() ? track : null;
}

/**
 * Whether a subject can actually occlude anything: its track applies to this
 * video AND it has a segmentation. Without pixels there is nothing to hide
 * behind — and nothing is drawn rather than something wrong being drawn.
 */
export function canOcclude(trackKey) {
  const track = getOcclusionTrack({ trackKey });
  if (!track) return false;
  const record = getSegmentationFor(trackKey, track);
  return !!record && record.status !== 'failed';
}

export function isOcclusionLinked(relation) {
  return canOcclude(relation?.trackKey);
}

// --- Editing -------------------------------------------------------------------------

/** A new relationship: this layer goes behind this subject, for the subject's own stretch. */
export function addOcclusion({ trackKey, layerIds, mode = 'behind', label = '', start, end }) {
  const track = getOcclusionTrack({ trackKey });
  if (!track || !layerIds?.length) return null;
  const from = Number.isFinite(start) ? start : track.startTime;
  const to = Number.isFinite(end) ? end : Math.max(from + MIN_OCCLUSION_DURATION, track.endTime);
  const relation = createOcclusion({ trackKey, layerIds, mode, label: label || track.label || 'Object', start: from, end: to });
  if (!relation) return null;
  updateState({ occlusions: [...getOcclusions(), relation] }, { recordHistory: true });
  return relation;
}

export function updateOcclusion(id, patch, { recordHistory = true } = {}) {
  const list = getOcclusions();
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const next = list.slice();
  next[idx] = normalizeOcclusion({ ...list[idx], ...patch }) || list[idx];
  updateState({ occlusions: next }, { recordHistory });
  return next[idx];
}

export function removeOcclusion(id) {
  const list = getOcclusions();
  if (!list.some((r) => r.id === id)) return;
  updateState({ occlusions: list.filter((r) => r.id !== id) }, { recordHistory: true });
}

/** The relationship covering `layerId`, if any (a layer belongs behind at most one subject at a time). */
export function occlusionForLayer(layerId) {
  return getOcclusions().find((r) => r.layerIds.includes(layerId)) || null;
}

/**
 * Puts a layer behind a subject, or takes it out again — what the inspector's
 * one control does. Reuses an existing relationship for that subject rather
 * than making a second one.
 */
export function setLayerBehind(layerId, trackKey, mode = 'behind') {
  const existing = occlusionForLayer(layerId);
  if (existing) {
    const rest = existing.layerIds.filter((id) => id !== layerId);
    if (!trackKey) {
      if (rest.length) updateOcclusion(existing.id, { layerIds: rest });
      else removeOcclusion(existing.id);
      return null;
    }
    if (existing.trackKey === trackKey) return updateOcclusion(existing.id, { mode });
    if (rest.length) updateOcclusion(existing.id, { layerIds: rest });
    else removeOcclusion(existing.id);
  }
  if (!trackKey) return null;
  const sameSubject = getOcclusions().find((r) => r.trackKey === trackKey && r.mode === mode);
  if (sameSubject) return updateOcclusion(sameSubject.id, { layerIds: [...sameSubject.layerIds, layerId] });
  return addOcclusion({ trackKey, layerIds: [layerId], mode });
}

export function describeOcclusion(relation) {
  const where = relation.mode === 'front' ? 'In front of' : 'Behind';
  return `${where} ${relation.label || 'object'}`;
}

// --- The preview's subject pass ---------------------------------------------------------

let scratch = null;

/**
 * Draws ONE subject run: the video's own pixels, placed exactly as the
 * composition places them, cut out with this subject's mask — onto that run's
 * canvas, which sits above the layers behind it and below those in front.
 *
 * Returns false (and draws nothing) where there is no mask: the layers
 * beneath simply show, as they would without the relationship at all.
 */
export function paintSubjectRun(canvas, entry, time) {
  const video = document.getElementById('preview-video');
  if (!video || !(video.videoWidth > 0) || video.readyState < 2) return false;
  const track = getOcclusionTrack({ trackKey: entry.trackKey });
  if (!track) return false;
  const mask = getMaskAt(entry.trackKey, track, time);
  if (!mask) return false;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);

  const placement = currentPlacement(time);
  // The edge softening this subject's relationships ask for (the strongest
  // of them, so one setting never quietly undoes another's).
  const mine = getOcclusions().filter((r) => r.trackKey === entry.trackKey && r.enabled !== false);
  const feather = Math.max(0, ...mine.map((r) => r.feather || 0), 0);
  const grow = Math.max(0, ...mine.map((r) => r.grow ?? 4), 0);
  const a = { x: mask.frame.x, y: mask.frame.y };
  const b = { x: mask.frame.x + mask.frame.width, y: mask.frame.y };
  const toCanvas = (p) => { const q = videoTransformFor(placement, W, H); return { x: q[0] * p.x + q[2] * p.y + q[4], y: q[1] * p.x + q[3] * p.y + q[5] }; };
  const ca = toCanvas(a);
  const cb = toCanvas(b);
  const frameCanvasWidth = Math.hypot(cb.x - ca.x, cb.y - ca.y);
  const alpha = maskWithEdges(mask, { expand: grow, feather }, effectUnit(W, H), frameCanvasWidth);

  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== W) scratch.width = W;
  if (scratch.height !== H) scratch.height = H;
  const sc = scratch.getContext('2d');
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'source-over';
  sc.clearRect(0, 0, W, H);
  sc.setTransform(...videoTransformFor(placement, W, H));
  sc.drawImage(video, 0, 0, 1, 1);
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'destination-in';
  drawMaskAlpha(sc, mask, alpha, placement, W, H, (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
  sc.globalCompositeOperation = 'source-over';
  ctx.drawImage(scratch, 0, 0);
  return true;
}

// --- The export ---------------------------------------------------------------------

/**
 * The relationships for the export, and the masks they need. Nothing at all
 * for a project without occlusion, so its payload is what it was.
 */
export function occlusionsPayload() {
  const relations = getOcclusions().filter((r) => r.enabled !== false && isOcclusionLinked(r));
  if (!relations.length) return {};
  const keys = occlusionTrackKeys(relations);
  const occlusionTracks = {};
  keys.forEach((k) => { if (appState.objectTracks?.[k]) occlusionTracks[k] = appState.objectTracks[k]; });
  // ...and the masks themselves: the same bytes the preview reads.
  return { occlusions: relations, occlusionTracks, occlusionSegmentations: segmentationPayloadFor(keys) };
}
registerStyleParamsExtra(occlusionsPayload);

/** Loads the masks an export will need (they live in IndexedDB and may not be in memory). */
export function prepareOcclusionsForExport() {
  return awaitSegmentations(occlusionTrackKeys(getOcclusions().filter((r) => r.enabled !== false && isOcclusionLinked(r))));
}

/** Debug/test aid: which layers are behind which subject at `time`, as the preview sees it. */
export function debugOcclusionAt(time) {
  return getOcclusions()
    .filter((r) => r.enabled !== false && time >= r.start && time < r.end && canOcclude(r.trackKey))
    .map((r) => ({ id: r.id, trackKey: r.trackKey, mode: r.mode, layerIds: r.layerIds, hasMask: !!getMaskAt(r.trackKey, getOcclusionTrack(r), time) }));
}

export { OCCLUSION_MODES, getTrackAtTime };

/**
 * The subjects a layer can actually be put behind: tracked for THIS video and
 * segmented. A track without a segmentation is left out — there would be no
 * pixels to hide behind, and offering it would promise something that does
 * nothing.
 */
export function availableSubjects() {
  const tracks = appState.objectTracks || {};
  return Object.keys(tracks)
    .filter((trackKey) => canOcclude(trackKey))
    .map((trackKey) => ({ trackKey, label: tracks[trackKey].label || 'Object', track: tracks[trackKey] }));
}
