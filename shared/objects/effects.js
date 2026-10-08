/**
 * OBJECT-AWARE EFFECTS — a visual treatment that follows a TRACKED object
 * (shared/objects/tracking.js): an outline, a glow, a spotlight, a blur.
 * The user tracks an object once; every effect on it reads that ONE track,
 * so nothing is keyframed by hand and nothing is tracked twice.
 *
 *   ObjectEffect
 *   ├── id          'ofx…'
 *   ├── type        'outline' | 'glow' | 'spotlight' | 'blur'
 *   ├── trackKey    the track it follows — a KEY into the project's tracks
 *   │               (tracking.js's trackCacheKey), never a copy of them
 *   ├── label       the object's name when the effect was made ("Person")
 *   ├── start, end  its own span on the timeline, within or across the track's
 *   ├── enabled
 *   ├── fade        seconds it fades in and out at its own edges
 *   └── appearance  per type (EFFECT_DEFAULTS) — colour, thickness, padding…
 *
 * THE CHAIN — each step its own function, so each can change alone:
 *
 *   track ──effectStateAt──▶ where the object is now, and how sure (presence)
 *         ──effectGeometry──▶ the effect's region on the canvas (padded,
 *                             rotated with the video, in canvas pixels)
 *         ──drawObjectEffects──▶ pixels (the same call in the preview and the export)
 *
 * Tracking says WHERE; the effect says WHAT; the renderer says HOW. Nothing
 * here tracks, nothing here writes to a track, and the drawing never asks a
 * track anything — it is handed a region.
 *
 * THE REGION is the tracked box today. A future segmentation mask slots in
 * at effectGeometry (a region with a mask instead of a rounded rectangle):
 * the outline would trace it, the blur and spotlight would be cut by it —
 * the policy, the timing and both renderers stay as they are.
 *
 * CONFIDENCE AND LOSS (effectStateAt, EFFECT_POLICY):
 *   tracked                   → full strength
 *   tracked, low confidence   → 75%
 *   uncertain (held, crossing, partly hidden) → per type: outline and glow
 *                               soften to 55%, a spotlight to 85% (it dims the
 *                               whole frame — softer would pump its
 *                               brightness), a blur stays full (privacy)
 *   no claim (lost, gone, hidden in a gap, past the track's end)
 *                             → holds the LAST REAL SIGHTING for holdSeconds
 *                               (fading; a blur at full), then nothing.
 *   The strength blends between neighbouring samples — it never jumps.
 *   Never extrapolated: an effect is never drawn somewhere the track does not
 *   put the object, and it does not fly off after a lost one.
 */
import { getTrackAtTime } from './tracking.js';
import { videoBoxToComposition } from './coordinates.js';

export const OBJECT_EFFECT_TYPES = ['outline', 'glow', 'spotlight', 'blur'];
export const OBJECT_EFFECT_LABELS = { outline: 'Outline', glow: 'Glow', spotlight: 'Spotlight', blur: 'Blur' };
export const MIN_EFFECT_DURATION = 0.1;

export const EFFECT_POLICY = {
  /** How long the last real sighting is held once the track has no claim. */
  holdSeconds: 0.3,
  /**
   * Strength while the tracker is uncertain (holding its prediction), per
   * type. An outline or glow says "this is the object", so it says it more
   * quietly when unsure. A spotlight dims the WHOLE frame, so softening it
   * pumps the brightness of everything (measured on the crowd clip) — it
   * barely softens. A blur is privacy: when unsure is exactly when it must
   * not let go.
   */
  uncertainPresence: { outline: 0.55, glow: 0.55, spotlight: 0.85, blur: 1 },
  /** Whether the held last sighting fades out (privacy blur holds at full, then stops). */
  holdFades: { outline: true, glow: true, spotlight: true, blur: false },
  /** Below this a tracked sample counts as low confidence. */
  lowConfidence: 0.5,
  lowConfidencePresence: 0.75
};

/**
 * Per-type appearance. Lengths are in "reference pixels": pixels on a canvas
 * whose shorter side is 1080 — scaled to the real canvas (effectUnit), so an
 * effect looks the same in a small preview and a 4K export. Padding and
 * corner radius are fractions of the object's size.
 */
export const EFFECT_DEFAULTS = {
  outline: { color: '#10E9A0', thickness: 6, opacity: 1, padding: 0.06, cornerRadius: 0.12 },
  glow: { color: '#10E9A0', intensity: 0.7, radius: 28, opacity: 1, padding: 0.04, cornerRadius: 0.2 },
  spotlight: { color: '#000000', strength: 0.6, feather: 40, padding: 0.12, cornerRadius: 0.35 },
  blur: { strength: 0.5, padding: 0.06, cornerRadius: 0.2 }
};

const RANGES = {
  thickness: [1, 40], opacity: [0, 1], padding: [0, 1], cornerRadius: [0, 0.5],
  intensity: [0, 1], radius: [2, 120], strength: [0, 1], feather: [0, 200]
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

let seq = 0;
function newId() {
  seq = (seq + 1) % 1e6;
  return `ofx${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A stored or new effect, made whole and in range — or null if it is not one. */
export function normalizeObjectEffect(raw) {
  if (!raw || typeof raw !== 'object' || !OBJECT_EFFECT_TYPES.includes(raw.type)) return null;
  if (typeof raw.trackKey !== 'string' || !raw.trackKey) return null;
  const start = Math.max(0, finite(raw.start, 0));
  const end = Math.max(start + MIN_EFFECT_DURATION, finite(raw.end, start + 3));
  const defaults = EFFECT_DEFAULTS[raw.type];
  const given = raw.appearance && typeof raw.appearance === 'object' ? raw.appearance : {};
  const appearance = {};
  Object.entries(defaults).forEach(([k, d]) => {
    if (k === 'color') appearance[k] = isColor(given[k]) ? given[k] : d;
    else appearance[k] = clamp(finite(given[k], d), ...(RANGES[k] || [-Infinity, Infinity]));
  });
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    type: raw.type,
    trackKey: raw.trackKey,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 60) : '',
    start,
    end,
    enabled: raw.enabled !== false,
    fade: clamp(finite(raw.fade, 0.2), 0, 2),
    appearance
  };
}

/** A list of effects — an array or its JSON string (the export's transport) — normalized; junk dropped. */
export function normalizeObjectEffectList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(list) ? list.map(normalizeObjectEffect).filter(Boolean) : [];
}

export function createObjectEffect({ type, trackKey, label = '', start, end, appearance = {} }) {
  return normalizeObjectEffect({ type, trackKey, label, start, end, appearance: { ...EFFECT_DEFAULTS[type], ...appearance } });
}

/** Half-open, like every other timed thing: [start, end). */
export function isObjectEffectActive(effect, time) {
  return !!effect && effect.enabled !== false && time >= effect.start && time < effect.end;
}

// --- Where, and how sure ----------------------------------------------------------

/** The last sample at or before `time` (index), or -1. */
function sampleAtOrBefore(samples, time) {
  if (!samples.length || samples[0].time > time) return -1;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].time <= time) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const typed = (v, type) => (v && typeof v === 'object' ? v[type] ?? v.outline : v);

/**
 * The tracked object at `time` as an effect of `type` should see it — the
 * policy above. The strength BLENDS between neighbouring samples (an outline
 * eases from full to softened across a step; it never jumps).
 * @returns {{box:object, presence:number, state:'tracked'|'uncertain'|'held'}|null}
 */
export function trackedRegionAt(track, time, policy = EFFECT_POLICY, type = 'outline') {
  if (!track?.samples?.length) return null;
  const samples = track.samples;
  const weight = (smp) => (smp.state === 'uncertain' ? typed(policy.uncertainPresence, type)
    : smp.confidence < policy.lowConfidence ? policy.lowConfidencePresence : 1);
  const s = getTrackAtTime(track, time);
  if (s) {
    const i = sampleAtOrBefore(samples, time);
    const a = samples[Math.max(0, i)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const f = b.time > a.time ? Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time))) : 0;
    const presence = weight(a) + (weight(b) - weight(a)) * f;
    return { box: s.box, presence, state: s.state };
  }
  // No claim here. Before the track starts: nothing (no one has seen it yet).
  if (time < track.startTime) return null;
  // After the last real sighting (the track's end, or the edge of a gap):
  // hold it briefly — fading, or (a privacy blur) at full — then let go.
  let i = sampleAtOrBefore(samples, time);
  while (i >= 0 && samples[i].state !== 'tracked') i--;
  if (i < 0) return null;
  const since = time - samples[i].time;
  if (since > policy.holdSeconds) return null;
  const at = getTrackAtTime(track, samples[i].time) || samples[i];
  const fades = typed(policy.holdFades, type) !== false;
  return { box: at.box, presence: fades ? Math.max(0, 1 - since / policy.holdSeconds) : 1, state: 'held' };
}

/**
 * The effect at `time`: null when it is not on (outside its own span,
 * disabled, or its object is not there); otherwise the object's box and the
 * effect's strength (0-1) — the track's presence times its own fade.
 */
export function effectStateAt(effect, track, time, policy = EFFECT_POLICY) {
  if (!isObjectEffectActive(effect, time)) return null;
  const region = trackedRegionAt(track, time, policy, effect.type);
  if (!region) return null;
  const fade = effect.fade || 0;
  const edge = fade > 0 ? Math.min(1, (time - effect.start) / fade, (effect.end - time) / fade) : 1;
  const presence = region.presence * Math.max(0, edge);
  return presence > 0.001 ? { ...region, presence } : null;
}

// --- The region on the canvas ------------------------------------------------------

/** Reference pixels → this canvas's pixels (see EFFECT_DEFAULTS). */
export function effectUnit(canvasWidth, canvasHeight) {
  return Math.min(canvasWidth, canvasHeight) / 1080;
}

/**
 * The effect's region on a canvas of `canvasWidth`×`canvasHeight` pixels: the
 * object's box carried through the video's placement (shared/objects/
 * coordinates.js — the video's box, offset, scale and rotation in the
 * composition), padded, as a rotated rounded rectangle.
 * @param {object} placement coordinates.js's Placement (composition units)
 * @returns {{cx:number, cy:number, width:number, height:number, angle:number, radius:number}} canvas pixels / radians
 */
export function effectGeometry(effect, box, placement, canvasWidth, canvasHeight) {
  const [tl, tr, , bl] = videoBoxToComposition(box, placement).map((p) => ({ x: p.x * canvasWidth, y: p.y * canvasHeight }));
  const ux = tr.x - tl.x;
  const uy = tr.y - tl.y;
  const vx = bl.x - tl.x;
  const vy = bl.y - tl.y;
  const w = Math.hypot(ux, uy);
  const h = Math.hypot(vx, vy);
  const a = effect.appearance || {};
  // Padding by the object's overall size, the same on every side.
  const pad = (a.padding || 0) * Math.sqrt(w * h);
  const width = w + 2 * pad;
  const height = h + 2 * pad;
  return {
    cx: tl.x + (ux + vx) / 2,
    cy: tl.y + (uy + vy) / 2,
    width,
    height,
    angle: Math.atan2(uy, ux),
    radius: Math.min(width, height) * (a.cornerRadius || 0)
  };
}

/**
 * Every effect on screen at `time`, resolved: its region and strength.
 * Effects whose track is missing are skipped (an effect never draws from a
 * track it cannot find — see the editor's unlinked state).
 * @param {object[]} effects  normalized ObjectEffects
 * @param {Map|object} tracks trackKey → track
 * @param {(time:number) => object} placementAt  the video's placement at a time
 */
export function resolveObjectEffects(effects, tracks, time, placementAt, canvasWidth, canvasHeight, policy = EFFECT_POLICY) {
  const get = (k) => (tracks instanceof Map ? tracks.get(k) : tracks?.[k]);
  const out = [];
  let placement = null;
  for (const effect of effects || []) {
    if (!isObjectEffectActive(effect, time)) continue;
    const track = get(effect.trackKey);
    if (!track) continue;
    const state = effectStateAt(effect, track, time, policy);
    if (!state) continue;
    placement = placement || placementAt(time);
    out.push({ effect, state, geometry: effectGeometry(effect, state.box, placement, canvasWidth, canvasHeight) });
  }
  return out;
}

/** The blur's Gaussian sigma, in this canvas's pixels — the same number the export's gblur gets. */
export function blurSigma(effect, canvasWidth, canvasHeight) {
  return Math.round((3 + 37 * (effect.appearance?.strength ?? 0.5)) * effectUnit(canvasWidth, canvasHeight) * 10) / 10;
}

// --- Pixels ------------------------------------------------------------------------

/**
 * Traces the region (a rotated rounded rectangle) in ABSOLUTE canvas
 * coordinates — no transform — moved `shiftX` to the right. Absolute because
 * a canvas shadow's offset ignores the transform: the shadow tricks below
 * draw the shape far off-canvas and keep only its shadow.
 */
function traceRegion(ctx, g, shiftX = 0) {
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  const at = (x, y) => [g.cx + x * c - y * s + shiftX, g.cy + x * s + y * c];
  const hw = g.width / 2;
  const hh = g.height / 2;
  const r = Math.max(0, Math.min(g.radius, hw, hh));
  ctx.beginPath();
  ctx.moveTo(...at(-hw + r, -hh));
  ctx.arcTo(...at(hw, -hh), ...at(hw, hh), r);
  ctx.arcTo(...at(hw, hh), ...at(-hw, hh), r);
  ctx.arcTo(...at(-hw, hh), ...at(-hw, -hh), r);
  ctx.arcTo(...at(-hw, -hh), ...at(hw, -hh), r);
  ctx.closePath();
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(alpha, 0, 1)})`;
}

function reset(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';
  if ('filter' in ctx) ctx.filter = 'none';
}

const FAR = 100000;

function drawOutline(ctx, { effect, state, geometry }, unit) {
  const a = effect.appearance;
  ctx.globalAlpha = a.opacity * state.presence;
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.thickness * unit;
  ctx.lineJoin = 'round';
  traceRegion(ctx, geometry);
  ctx.stroke();
}

function drawGlow(ctx, { effect, state, geometry }, unit) {
  const a = effect.appearance;
  // Only the SHADOW of a ring drawn far off-canvas lands here: a soft halo
  // with no hard line in it.
  ctx.shadowColor = rgba(a.color, a.opacity * state.presence * (0.35 + 0.65 * a.intensity));
  ctx.shadowBlur = a.radius * unit;
  ctx.shadowOffsetX = -FAR;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(2, a.radius * unit * 0.35);
  const passes = a.intensity > 0.66 ? 3 : a.intensity > 0.33 ? 2 : 1;
  for (let i = 0; i < passes; i++) {
    traceRegion(ctx, geometry, FAR);
    ctx.stroke();
  }
}

/** All spotlights at once: one dimming, a feathered hole per object — overlapping spotlights don't dim twice. */
function drawSpotlights(ctx, items, unit, canvasWidth, canvasHeight, createOffscreenCanvas) {
  if (!items.length) return;
  const layer = createOffscreenCanvas(canvasWidth, canvasHeight);
  const lc = layer.getContext('2d');
  reset(lc);
  const strongest = items.reduce((m, it) => (it.effect.appearance.strength * it.state.presence > m.effect.appearance.strength * m.state.presence ? it : m), items[0]);
  lc.fillStyle = rgba(strongest.effect.appearance.color, strongest.effect.appearance.strength * strongest.state.presence);
  lc.fillRect(0, 0, canvasWidth, canvasHeight);
  lc.globalCompositeOperation = 'destination-out';
  items.forEach(({ effect, state, geometry }) => {
    lc.globalAlpha = 1;
    lc.shadowColor = `rgba(0,0,0,${clamp(state.presence / Math.max(0.001, strongest.state.presence), 0, 1)})`;
    lc.shadowBlur = effect.appearance.feather * unit;
    lc.shadowOffsetX = -FAR;
    lc.fillStyle = '#000';
    traceRegion(lc, geometry, FAR);
    lc.fill();
  });
  reset(ctx);
  ctx.drawImage(layer, 0, 0);
}

/**
 * Draws the effects resolved by resolveObjectEffects onto `ctx` (a canvas of
 * canvasWidth×canvasHeight), bottom to top: blurs, spotlights, glows,
 * outlines. The ONE draw the preview and the export both make.
 *
 * Blur needs the VIDEO's pixels, which each side has differently, so it is
 * handed in: `drawBlurred(ctx, traceClip, sigma, alpha)` — the preview draws
 * the video frame there, clipped and filtered. The export gives none: its
 * blur is done on the video itself (the compositor's masked gblur, cut by
 * drawObjectEffectMasks below) before this layer goes on top.
 */
export function drawObjectEffects(ctx, resolved, { canvasWidth, canvasHeight, createOffscreenCanvas, drawBlurred = null }) {
  if (!resolved?.length) return;
  const unit = effectUnit(canvasWidth, canvasHeight);
  const of = (type) => resolved.filter((r) => r.effect.type === type);
  ctx.save();
  try {
    if (drawBlurred) {
      of('blur').forEach((r) => {
        reset(ctx);
        drawBlurred(ctx, () => traceRegion(ctx, r.geometry), blurSigma(r.effect, canvasWidth, canvasHeight), r.state.presence);
      });
    }
    drawSpotlights(ctx, of('spotlight'), unit, canvasWidth, canvasHeight, createOffscreenCanvas);
    of('glow').forEach((r) => { reset(ctx); drawGlow(ctx, r, unit); });
    of('outline').forEach((r) => { reset(ctx); drawOutline(ctx, r, unit); });
  } finally {
    reset(ctx);
    ctx.restore();
  }
}

/**
 * The export's blur MASK for one blur strength: each blur region in white,
 * as opaque as the effect is present. The compositor lays a Gaussian-blurred
 * copy of the video over the video through this mask.
 */
export function drawObjectEffectMasks(ctx, resolved, { canvasWidth, canvasHeight, sigma }) {
  reset(ctx);
  resolved
    .filter((r) => r.effect.type === 'blur' && blurSigma(r.effect, canvasWidth, canvasHeight) === sigma)
    .forEach((r) => {
      ctx.globalAlpha = r.state.presence;
      ctx.fillStyle = '#fff';
      traceRegion(ctx, r.geometry);
      ctx.fill();
    });
  reset(ctx);
}

/** The distinct blur strengths among `effects` on a canvas of this size — one masked blur pass each in the export. */
export function blurSigmas(effects, canvasWidth, canvasHeight) {
  return [...new Set((effects || []).filter((e) => e.type === 'blur' && e.enabled !== false).map((e) => blurSigma(e, canvasWidth, canvasHeight)))];
}

/** Every instant an effect switches on or off. */
export function objectEffectBoundaryTimes(effects) {
  const times = new Set();
  (effects || []).forEach((e) => { times.add(e.start); times.add(e.end); });
  return [...times].sort((a, b) => a - b);
}
