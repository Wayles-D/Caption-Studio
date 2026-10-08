/**
 * OBJECT-AWARE EFFECTS in the editor — putting an outline, glow, spotlight or
 * blur on a TRACKED object, editing it, and drawing it in the preview. The
 * model, the policy, the geometry and the drawing are shared/objects/
 * effects.js — the same ones the exporter runs.
 *
 *   select an object → track it (objectTracking.js) → addObjectEffect('glow')
 *   → the glow follows the track: no keyframes.
 *
 * An effect FOLLOWS its track by key (appState.objectTracks[effect.trackKey]),
 * never a copy of it, so re-tracking an object moves every effect on it, and
 * every effect on one object reads the one cached track. A track that no
 * longer applies (another video, another tracker version) leaves its effects
 * UNLINKED: kept, listed, but drawn nowhere — never at stale positions.
 *
 * Every write goes through updateState: objectEffects is a document key
 * (src/store/objectStore.js), so edits are undoable and saved with the
 * project. Gestures write with recordHistory:false while live and commit once.
 */
import { appState, updateState, registerStyleParamsExtra } from '../state.js';
import {
  createObjectEffect, normalizeObjectEffect, OBJECT_EFFECT_TYPES, OBJECT_EFFECT_LABELS, MIN_EFFECT_DURATION,
  resolveObjectEffects, drawObjectEffects, trackedRegionAt
} from '../../../shared/objects/effects.js';
import { isTrackValidFor } from '../../../shared/objects/tracking.js';
import { getCacheKey } from './objectDetection.js';
import { getSelectedTrack, getSelectedTrackKey } from './objectTracking.js';
import { currentPlacement } from './objectOverlay.js';
import { getPlayheadTime } from './textElements.js';
import { getCanvasContentRect } from '../utils/canvasGeometry.js';

function videoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

function clampToTimeline(time) {
  const d = videoDuration();
  return Math.max(0, d > 0 ? Math.min(d, time) : time);
}

export function getObjectEffects() {
  return appState.objectEffects || [];
}

export function getObjectEffect(id) {
  return getObjectEffects().find((e) => e.id === id) || null;
}

export function getSelectedObjectEffect() {
  return getObjectEffect(appState.selectedObjectEffectId);
}

/** The track an effect follows — or null when it is missing or no longer applies to this video. */
export function getEffectTrack(effect) {
  const track = effect ? appState.objectTracks?.[effect.trackKey] : null;
  if (!track || !isTrackValidFor(track, effect.trackKey)) return null;
  return track.source?.detectionCacheKey === getCacheKey() ? track : null;
}

export function isEffectLinked(effect) {
  return !!getEffectTrack(effect);
}

/** The effects on the selected object's track. */
export function getSelectedObjectEffects() {
  const key = getSelectedTrackKey();
  return key ? getObjectEffects().filter((e) => e.trackKey === key) : [];
}

// --- Editing -------------------------------------------------------------------------

/**
 * A new effect on the SELECTED object's track: from the playhead (or the
 * track's start, if the playhead is outside it) to the track's end — its own
 * span, trimmed like any clip, never forced to cover the whole track.
 */
export function addObjectEffect(type, { start = getPlayheadTime() } = {}) {
  if (!OBJECT_EFFECT_TYPES.includes(type)) return null;
  const track = getSelectedTrack();
  const trackKey = getSelectedTrackKey();
  if (!track || !trackKey) return null;
  const inside = start >= track.startTime && start < track.endTime - MIN_EFFECT_DURATION;
  const from = inside ? start : track.startTime;
  const effect = createObjectEffect({ type, trackKey, label: track.label || 'Object', start: from, end: Math.max(from + 0.5, track.endTime) });
  updateState({ objectEffects: [...getObjectEffects(), effect] }, { recordHistory: true });
  selectObjectEffect(effect.id);
  return effect;
}

/** Replaces top-level fields (start, end, enabled, fade, type...). */
export function updateObjectEffect(id, patch, { recordHistory = true } = {}) {
  const list = getObjectEffects();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const merged = { ...list[idx], ...patch };
  // A change of type starts from that type's look.
  if (patch.type && patch.type !== list[idx].type && !patch.appearance) delete merged.appearance;
  const next = list.slice();
  next[idx] = normalizeObjectEffect(merged) || list[idx];
  updateState({ objectEffects: next }, { recordHistory });
  return next[idx];
}

/** Merges into the effect's appearance. */
export function patchObjectEffectAppearance(id, fields, options) {
  const effect = getObjectEffect(id);
  if (!effect) return null;
  return updateObjectEffect(id, { appearance: { ...effect.appearance, ...fields } }, options);
}

export function moveObjectEffect(id, start, options) {
  const effect = getObjectEffect(id);
  if (!effect) return null;
  const length = effect.end - effect.start;
  const d = videoDuration();
  const maxStart = d > 0 ? Math.max(0, d - length) : Number.MAX_SAFE_INTEGER;
  const nextStart = Math.max(0, Math.min(maxStart, start));
  return updateObjectEffect(id, { start: nextStart, end: nextStart + length }, options);
}

export function trimObjectEffect(id, edge, time, options) {
  const effect = getObjectEffect(id);
  if (!effect) return null;
  const t = clampToTimeline(time);
  if (edge === 'start') return updateObjectEffect(id, { start: Math.min(t, effect.end - MIN_EFFECT_DURATION) }, options);
  return updateObjectEffect(id, { end: Math.max(t, effect.start + MIN_EFFECT_DURATION) }, options);
}

export function removeObjectEffect(id) {
  const list = getObjectEffects();
  if (!list.some((e) => e.id === id)) return;
  updateState({
    objectEffects: list.filter((e) => e.id !== id),
    ...(appState.selectedObjectEffectId === id ? { selectedObjectEffectId: null } : {})
  }, { recordHistory: true });
}

export function removeSelectedObjectEffect() {
  const id = appState.selectedObjectEffectId;
  if (!id || !getObjectEffect(id)) return false;
  removeObjectEffect(id);
  return true;
}

/** Makes an effect THE selection — every other selection is released in the same write. */
export function selectObjectEffect(id) {
  if (!id) {
    if (appState.selectedObjectEffectId) updateState({ selectedObjectEffectId: null }, { recordHistory: false });
    return;
  }
  updateState({
    selectedObjectEffectId: id,
    selectedShapeLayerId: null,
    selectedImageLayerId: null,
    selectedTextElementId: null,
    selectedCaptionEventId: null,
    selectedAudioClipId: null
  }, { recordHistory: false });
}

export function describeObjectEffect(effect) {
  return `${OBJECT_EFFECT_LABELS[effect.type] || effect.type} · ${effect.label || 'Object'}`;
}

// --- Export ----------------------------------------------------------------------------

/**
 * The effects for the export, and ONLY the tracks they follow — none of the
 * detections, none of the other tracks. Nothing at all for a project without
 * effects, so its payload is what it was before effects existed.
 */
export function objectEffectsPayload() {
  const effects = getObjectEffects().filter((e) => e.enabled !== false && isEffectLinked(e));
  if (!effects.length) return {};
  const objectEffectTracks = {};
  effects.forEach((e) => { objectEffectTracks[e.trackKey] = appState.objectTracks[e.trackKey]; });
  return { objectEffects: effects, objectEffectTracks };
}
registerStyleParamsExtra(objectEffectsPayload);

// --- The preview ------------------------------------------------------------------------

/** The linked, enabled effects and their tracks, as resolveObjectEffects takes them. */
function linkedEffects() {
  const tracks = new Map();
  const effects = [];
  getObjectEffects().forEach((e) => {
    if (e.enabled === false) return;
    const track = getEffectTrack(e);
    if (!track) return;
    tracks.set(e.trackKey, track);
    effects.push(e);
  });
  return { effects, tracks };
}

let blurScratch = null;

/**
 * The preview's blur: the VIDEO, placed as the composition places it, through
 * a Gaussian filter — the same sigma the export's gblur gets — then cut to
 * the region. Filtered on a scratch copy at most 720px on its long side (a
 * blur loses nothing at lower resolution, and a full-size filter every
 * frame of playback is what makes a preview stutter).
 */
function makePreviewBlur(video, placement, canvasWidth, canvasHeight) {
  return (ctx, traceClip, sigma, alpha) => {
    if (!(video?.videoWidth > 0) || video.readyState < 2) return;
    const k = canvasWidth / placement.canvasWidth;
    const t = placement.transform;
    const bw = placement.boxWidth * k;
    const bh = placement.boxHeight * k;
    const cx = canvasWidth / 2 + (t.offsetXPct / 100) * canvasWidth;
    const cy = canvasHeight / 2 + (t.offsetYPct / 100) * canvasHeight;
    if (!blurScratch) blurScratch = document.createElement('canvas');
    const scale = Math.min(1, 720 / Math.max(canvasWidth, canvasHeight));
    const sw = Math.max(1, Math.round(canvasWidth * scale));
    const sh = Math.max(1, Math.round(canvasHeight * scale));
    if (blurScratch.width !== sw) blurScratch.width = sw;
    if (blurScratch.height !== sh) blurScratch.height = sh;
    const sc = blurScratch.getContext('2d');
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, sw, sh);
    sc.filter = `blur(${(sigma * scale).toFixed(2)}px)`;
    sc.setTransform(scale, 0, 0, scale, 0, 0);
    sc.translate(cx, cy);
    sc.rotate((t.rotation * Math.PI) / 180);
    sc.scale(t.scale, t.scale);
    sc.globalAlpha = Math.max(0, Math.min(1, (t.opacity ?? 100) / 100));
    sc.drawImage(video, -bw / 2, -bh / 2, bw, bh);
    sc.filter = 'none';
    ctx.save();
    traceClip();
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.drawImage(blurScratch, 0, 0, sw, sh, 0, 0, canvasWidth, canvasHeight);
    ctx.restore();
  };
}

let lastDrawn = false;

/**
 * Draws every effect on screen at `time` on the preview's effects canvas —
 * directly above the video, beneath every other layer, where the export
 * composites them. Called with every preview redraw (preview.js).
 */
export function syncObjectEffectsCanvas(time) {
  const canvas = document.getElementById('object-effects-canvas');
  if (!canvas) return;
  try {
    const { effects, tracks } = linkedEffects();
    const rect = getCanvasContentRect();
    if (!effects.length || !rect || rect.width <= 0) {
      if (lastDrawn) {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        lastDrawn = false;
      }
      canvas.classList.remove('active');
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(rect.width * dpr);
    const H = Math.round(rect.height * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    canvas.classList.add('active');
    const resolved = resolveObjectEffects(effects, tracks, time, currentPlacement, W, H);
    lastDrawn = resolved.length > 0;
    if (!resolved.length) return;
    const placement = currentPlacement(time);
    drawObjectEffects(ctx, resolved, {
      canvasWidth: W,
      canvasHeight: H,
      createOffscreenCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
      drawBlurred: makePreviewBlur(document.getElementById('preview-video'), placement, W, H)
    });
  } catch (err) {
    // An effect that cannot be drawn costs the effects, never the editor.
    console.warn('[Objects] Effects could not be drawn:', err);
    try { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); } catch { /* nothing more to do */ }
  }
}

/** Debug/test aid: what the preview draws at `time` — each effect's region in canvas px. */
export function debugEffectRegions(time) {
  const canvas = document.getElementById('object-effects-canvas');
  const { effects, tracks } = linkedEffects();
  if (!canvas) return [];
  return resolveObjectEffects(effects, tracks, time, currentPlacement, canvas.width, canvas.height)
    .map(({ effect, state, geometry }) => ({ id: effect.id, type: effect.type, presence: state.presence, state: state.state, geometry }));
}

/** Debug/test aid: the tracked box (video space) every effect on `trackKey` reads at `time`. */
export function debugTrackedBox(trackKey, time) {
  const track = getEffectTrack({ trackKey });
  return track ? trackedRegionAt(track, time)?.box || null : null; // (the box is the same for every type)
}
