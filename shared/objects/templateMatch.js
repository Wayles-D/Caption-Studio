/**
 * MANUAL OBJECTS — anything the user draws a box around, whether or not the
 * detector (YOLOX, 80 everyday classes) found it: a logo, a ball the
 * detector missed, a sign, part of something.
 *
 * Such an object has no class for the detector to look for, so it is
 * followed by its OWN PIXELS: normalized cross-correlation (NCC) of a small
 * greyscale template of the drawn box, searched where the object should be.
 * The matches are handed to the SAME tracker as detections are
 * (shared/objects/tracking.js — prediction, gating, camera motion, the
 * uncertain/lost/exited/cut rules, finding it again, smoothing), as the
 * frame's "candidates": the tracker cannot tell, and needs no second set of
 * rules.
 *
 *   createTemplateObserver({ time, box, frameSize, grab })
 *     .prime()                    → the start frame's fingerprint and thumbnail
 *     .observe(time, {region, direction}) → { time, thumb, candidates }   (tracking.js's observe)
 *
 * `grab(time, region, outWidth, outHeight, direction)` is the caller's: the
 * region (0-1 of the frame) of the frame at `time`, resampled to
 * outWidth×outHeight RGBA — and the frame's greyscale thumbnail
 * (frames.js's thumbnail). The editor draws it from the video
 * (objectDetection.js's grabRegion), the tests from ffmpeg.
 *
 * NCC: brightness and contrast changes cancel out; the template is matched at
 * three sizes (the object coming closer or going away), coarse then fine.
 * The template LEARNS slowly (a quarter of each clean, clearly-best match),
 * so it follows an object that turns or changes in the light — but never
 * from a match that no longer resembles the box the user drew (the anchor),
 * which is what keeps it from drifting onto the background.
 * One template per direction: forward and backward run side by side.
 */
import { appearanceOf } from './appearance.js';

export const MATCHER = { id: 'bhynd-ncc', version: '1.0.0' };
/** The class a manual object has: no detection is ever of it. */
export const MANUAL_CLASS = 'custom';
export const MANUAL_LABEL = 'Object';

/** The template's long side (px) — detail enough to tell an object from its background, small enough to search fast. */
const TEMPLATE_SIDE = 32;
const TEMPLATE_MIN_SIDE = 8;
/** The searched image's long side at most (px): bounds the cost of a whole-frame search. */
const MAX_SEARCH = 256;
const SCALES = [0.9, 0.95, 1, 1.05, 1.1];
/**
 * A change of size must win by this much. A drawn box holds some background;
 * a slightly smaller box fits the object's inside a little better at every
 * step, and without this the box shrinks frame by frame (measured: a walking
 * person's box lost 20% of its height in 3s).
 */
const SCALE_PENALTY = 0.02;
/** Below this a peak is not a candidate at all. */
const MIN_NCC = 0.4;
/** The template learns only from a match at least this good... */
const LEARN_NCC = 0.7;
/** ...clearly better than the next peak... */
const LEARN_LEAD = 0.08;
/** ...that still looks like what the user drew. */
const ANCHOR_NCC = 0.35;
const LEARN_RATE = 0.25;
/** Below this likeness to the drawn box, a match is not the object at all. */
const CANDIDATE_ANCHOR_NCC = 0.25;
/**
 * Searching the WHOLE frame (a big object; looking for it again), a match
 * must also score near what the object itself has been scoring: this share
 * of its running typical match. (Near where it should be, the tracker's
 * motion gate already rules out the far-off spots, and a fast pan blurs
 * the object itself down to ~0.65 — measured on a shop sign.) The object scores ~0.85-0.95; on
 * a dark, plain background random spots score 0.5-0.6 (measured: a car that
 * had left a night street was "found" on a facade at 0.59) — a sudden fall
 * to that level is the object gone, not the object.
 */
const TYPICAL_SHARE = 0.72;
/** The smallest box worth drawing, in video pixels. */
export const MIN_MANUAL_SIDE = 8;

/** A manual object's id: where and when it was drawn, and by which matcher (a new matcher, a new track). */
export function manualObjectId(time, box) {
  const n = [time, box.x, box.y, box.width, box.height].map((v) => Math.round(v * 1e4).toString(36)).join('.');
  return `manual-${MATCHER.version}-${n}`;
}

export function isManualObject(obj) {
  return !!obj && (obj.manual === true || obj.class === MANUAL_CLASS);
}

/** A drawn box (0-1 of the frame), clipped to the frame — or null when too small to follow. */
export function normalizeManualBox(box, frameWidth, frameHeight) {
  if (!box) return null;
  const x0 = Math.max(0, Math.min(1, Math.min(box.x, box.x + box.width)));
  const y0 = Math.max(0, Math.min(1, Math.min(box.y, box.y + box.height)));
  const x1 = Math.max(0, Math.min(1, Math.max(box.x, box.x + box.width)));
  const y1 = Math.max(0, Math.min(1, Math.max(box.y, box.y + box.height)));
  if ((x1 - x0) * frameWidth < MIN_MANUAL_SIDE || (y1 - y0) * frameHeight < MIN_MANUAL_SIDE) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// --- Pixels ---------------------------------------------------------------------

/** RGBA → greyscale floats. */
export function toGray(img) {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  return { data: out, width: img.width, height: img.height };
}

/** Bilinear resample of a greyscale region (px, may be fractional) to w×h. */
function resample(g, sx, sy, sw, sh, w, h) {
  const out = new Float32Array(w * h);
  const fx = sw / w;
  const fy = sh / h;
  for (let y = 0; y < h; y++) {
    const py = Math.min(g.height - 1, Math.max(0, sy + (y + 0.5) * fy - 0.5));
    const iy = Math.min(g.height - 2, Math.floor(py));
    const ay = Math.max(0, py - Math.max(0, iy));
    for (let x = 0; x < w; x++) {
      const px = Math.min(g.width - 1, Math.max(0, sx + (x + 0.5) * fx - 0.5));
      const ix = Math.min(g.width - 2, Math.floor(px));
      const ax = Math.max(0, px - Math.max(0, ix));
      const i0 = Math.max(0, iy) * g.width + Math.max(0, ix);
      const i1 = g.height > 1 ? i0 + g.width : i0;
      const r = g.width > 1 ? 1 : 0;
      out[y * w + x] = (g.data[i0] * (1 - ax) + g.data[i0 + r] * ax) * (1 - ay) + (g.data[i1] * (1 - ax) + g.data[i1 + r] * ax) * ay;
    }
  }
  return { data: out, width: w, height: h };
}

/** Zero-mean copy, and its norm — NCC's template side. */
function prepare(p) {
  let mean = 0;
  for (let i = 0; i < p.data.length; i++) mean += p.data[i];
  mean /= p.data.length;
  const data = new Float32Array(p.data.length);
  let ss = 0;
  for (let i = 0; i < data.length; i++) { data[i] = p.data[i] - mean; ss += data[i] * data[i]; }
  return { data, width: p.width, height: p.height, norm: Math.sqrt(ss) };
}

/** NCC of two same-size patches (-1..1). */
export function patchNCC(a, b) {
  const pa = prepare(a);
  const pb = prepare(b);
  if (pa.norm < 1e-3 || pb.norm < 1e-3) return 0;
  let s = 0;
  for (let i = 0; i < pa.data.length; i++) s += pa.data[i] * pb.data[i];
  return s / (pa.norm * pb.norm);
}

function integrals(g) {
  const W = g.width + 1;
  const sum = new Float64Array(W * (g.height + 1));
  const sq = new Float64Array(W * (g.height + 1));
  for (let y = 0; y < g.height; y++) {
    let rs = 0; let rq = 0;
    for (let x = 0; x < g.width; x++) {
      const v = g.data[y * g.width + x];
      rs += v; rq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
    }
  }
  return { sum, sq, W };
}

function nccAt(s, ii, t, x, y) {
  const n = t.width * t.height;
  const { sum, sq, W } = ii;
  const a = y * W + x;
  const b = y * W + x + t.width;
  const c = (y + t.height) * W + x;
  const d = (y + t.height) * W + x + t.width;
  const S = sum[d] - sum[b] - sum[c] + sum[a];
  const Q = sq[d] - sq[b] - sq[c] + sq[a];
  const v = Q - (S * S) / n;
  if (v < 1e-3 * n) return 0; // a flat patch matches nothing
  let dot = 0;
  for (let j = 0; j < t.height; j++) {
    const row = (y + j) * s.width + x;
    const trow = j * t.width;
    for (let i = 0; i < t.width; i++) dot += t.data[trow + i] * s.data[row + i];
  }
  return dot / (t.norm * Math.sqrt(v));
}

/**
 * Every place `templ` (greyscale, any size) matches in `search` (greyscale),
 * at SCALES of its size: coarse (every other position), then refined around
 * the best. Peaks ≥ MIN_NCC, best first, one per object-sized neighbourhood.
 * @returns {{x:number, y:number, width:number, height:number, score:number}[]} px of `search`
 */
export function matchTemplate(search, templ, scales = SCALES) {
  const ii = integrals(search);
  const peaks = [];
  for (const k of scales) {
    const tw = Math.max(TEMPLATE_MIN_SIDE >> 1, Math.round(templ.width * k));
    const th = Math.max(TEMPLATE_MIN_SIDE >> 1, Math.round(templ.height * k));
    if (tw > search.width || th > search.height) continue;
    const t = prepare(resample(templ, 0, 0, templ.width, templ.height, tw, th));
    if (t.norm < 1e-3) continue;
    const mx = search.width - tw;
    const my = search.height - th;
    const coarse = [];
    for (let y = 0; y <= my; y += 2) {
      for (let x = 0; x <= mx; x += 2) {
        const v = nccAt(search, ii, t, x, y);
        if (v >= MIN_NCC - 0.1) coarse.push({ x, y, v });
      }
    }
    coarse.sort((a, b) => b.v - a.v);
    // Refine the best few local maxima to the exact position.
    const taken = [];
    for (const c of coarse) {
      if (taken.length >= 4) break;
      if (taken.some((p) => Math.abs(p.x - c.x) < tw / 2 && Math.abs(p.y - c.y) < th / 2)) continue;
      let best = c;
      for (let y = Math.max(0, c.y - 1); y <= Math.min(my, c.y + 1); y++) {
        for (let x = Math.max(0, c.x - 1); x <= Math.min(mx, c.x + 1); x++) {
          const v = nccAt(search, ii, t, x, y);
          if (v > best.v) best = { x, y, v };
        }
      }
      taken.push(best);
    }
    taken.forEach((p) => peaks.push({ x: p.x, y: p.y, width: tw, height: th, score: p.v, rank: p.v - SCALE_PENALTY * Math.round(Math.abs(Math.log(k)) / Math.log(1.05)) }));
  }
  peaks.sort((a, b) => b.rank - a.rank);
  // One per neighbourhood, across the scales.
  const out = [];
  for (const p of peaks) {
    if (p.score < MIN_NCC) break;
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    if (out.some((q) => Math.abs(q.x + q.width / 2 - cx) < q.width / 2 && Math.abs(q.y + q.height / 2 - cy) < q.height / 2)) continue;
    out.push({ x: p.x, y: p.y, width: p.width, height: p.height, score: p.score });
    if (out.length >= 3) break;
  }
  return out;
}

/** The template's size (px) for an object of bw×bh video px: TEMPLATE_SIDE on its long side, the object's shape. */
function templateSize(bw, bh) {
  const k = TEMPLATE_SIDE / Math.max(bw, bh);
  return { width: Math.max(TEMPLATE_MIN_SIDE, Math.round(bw * k)), height: Math.max(TEMPLATE_MIN_SIDE, Math.round(bh * k)) };
}

// --- The observer ------------------------------------------------------------------

/**
 * Follows a drawn box by its pixels, as tracking.js's `observe`.
 * @param {object} o
 * @param {number} o.time            when it was drawn
 * @param {object} o.box             the drawn box, 0-1 of the frame
 * @param {{width:number, height:number}} o.frameSize the video's pixels
 * @param {(time:number, region:object, w:number, h:number, direction:number) => Promise<{image:{data, width, height}, thumb:object}>} o.grab
 */
export function createTemplateObserver({ time, box, frameSize, grab }) {
  const FW = frameSize.width;
  const FH = frameSize.height;
  const size = templateSize(box.width * FW, box.height * FH);
  let anchor = null;
  // Per direction: the learned template and the object's size (video px) it was taken at.
  const states = new Map();
  const stateFor = (direction) => {
    const key = Math.sign(direction || 0);
    if (!states.has(key)) states.set(key, { templ: anchor, bw: box.width * FW, bh: box.height * FH, typical: 0.9 });
    return states.get(key);
  };

  async function prime() {
    const { image, thumb } = await grab(time, box, size.width, size.height, 0);
    anchor = toGray(image);
    return { appearance: appearanceOf(image, { x: 0, y: 0, width: 1, height: 1 }), thumb, template: anchor };
  }

  async function observe(t, { region = null, direction = 0 } = {}) {
    if (!anchor) await prime();
    const st = stateFor(direction);
    const r = region || { x: 0, y: 0, width: 1, height: 1 };
    // Search at the template's scale (template px per video px)...
    let s = st.templ.width / st.bw;
    let templ = st.templ;
    const longest = Math.max(r.width * FW, r.height * FH) * s;
    // ...unless that makes the search too big: then smaller, template and all.
    if (longest > MAX_SEARCH) {
      const k = MAX_SEARCH / longest;
      s *= k;
      const tw = Math.max(TEMPLATE_MIN_SIDE >> 1, Math.round(templ.width * k));
      const th = Math.max(TEMPLATE_MIN_SIDE >> 1, Math.round(templ.height * k));
      templ = resample(templ, 0, 0, templ.width, templ.height, tw, th);
    }
    const sw = Math.max(templ.width, Math.round(r.width * FW * s));
    const sh = Math.max(templ.height, Math.round(r.height * FH * s));
    const { image, thumb } = await grab(t, r, sw, sh, direction);
    const gray = toGray(image);
    // A match must still look like what the user DREW, not only like the
    // learned template: once the object has gone (left the frame, say), the
    // learned template is what would otherwise settle on the background.
    const raw = matchTemplate(gray, templ);
    const peaks = raw.filter((pk) => region || pk.score >= TYPICAL_SHARE * st.typical)
      .filter((pk) => patchNCC(resample(gray, pk.x, pk.y, pk.width, pk.height, anchor.width, anchor.height), anchor) >= CANDIDATE_ANCHOR_NCC);
    const kx = (r.width) / sw;
    const ky = (r.height) / sh;
    const candidates = peaks.map((p, i) => {
      const inCrop = { x: p.x / sw, y: p.y / sh, width: p.width / sw, height: p.height / sh };
      return {
        id: `m-${Math.round(t * 1000)}-${i}`,
        class: MANUAL_CLASS,
        label: MANUAL_LABEL,
        confidence: Math.max(0, Math.min(1, p.score)),
        box: { x: r.x + p.x * kx, y: r.y + p.y * ky, width: p.width * kx, height: p.height * ky },
        appearance: appearanceOf(image, inCrop),
        time: t
      };
    });
    // Its typical score follows it (lighting, blur, turning) — slowly.
    if (peaks[0]) st.typical = 0.7 * st.typical + 0.3 * peaks[0].score;
    // Learn — slowly, and only from a clean, clearly-best match that still looks like the drawn box.
    const best = peaks[0];
    if (best && best.score >= LEARN_NCC && (!peaks[1] || best.score - peaks[1].score >= LEARN_LEAD)) {
      const fresh = resample(gray, best.x, best.y, best.width, best.height, st.templ.width, st.templ.height);
      if (patchNCC(fresh, anchor) >= ANCHOR_NCC) {
        const blended = new Float32Array(fresh.data.length);
        for (let i = 0; i < blended.length; i++) blended[i] = st.templ.data[i] * (1 - LEARN_RATE) + fresh.data[i] * LEARN_RATE;
        st.templ = { data: blended, width: st.templ.width, height: st.templ.height };
        // The size it was found at (video px): the object came closer or went away.
        st.bw = best.width / s;
        st.bh = best.height / s;
      }
    }
    return { time: t, thumb, candidates };
  }

  return { prime, observe, templateSize: size };
}
