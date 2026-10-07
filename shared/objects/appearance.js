/**
 * APPEARANCE — a small colour fingerprint of what is inside a box, so the
 * tracker (shared/objects/tracking.js) can tell two objects of the same class
 * apart when they come close: Person A in a red jacket stays Person A when
 * Person B in grey walks past, even where their boxes overlap.
 *
 * Two hue/saturation/value histograms of the box's CENTRE (the outer 20% on
 * each side is skipped — that is mostly background): its upper half and its
 * lower half, each normalized to sum 1. Two people in the same white shirt
 * but different trousers differ in the lower half; one histogram of the
 * whole box would blur that away. Compared half by half with the
 * Bhattacharyya coefficient: 1 = identical colours, 0 = nothing in common. Cheap: a few thousand pixels per box, on the main
 * thread, during analysis only.
 */

const H_BINS = 12;
const S_BINS = 3;
const V_BINS = 3;
/** One part's histogram; a fingerprint is APPEARANCE_PARTS of them. */
export const APPEARANCE_PART = H_BINS * S_BINS * V_BINS;
export const APPEARANCE_PARTS = 2;
export const APPEARANCE_SIZE = APPEARANCE_PART * APPEARANCE_PARTS;
const MAX_SAMPLES = 4000;

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

/**
 * The fingerprint of `box` (0-1 of the frame) in an RGBA frame.
 * @returns {Float32Array|null} null for a box too small to read.
 */
export function appearanceOf(frame, box) {
  const { data, width, height } = frame;
  const x0 = Math.floor((box.x + box.width * 0.2) * width);
  const x1 = Math.ceil((box.x + box.width * 0.8) * width);
  const y0 = Math.floor((box.y + box.height * 0.2) * height);
  const y1 = Math.ceil((box.y + box.height * 0.8) * height);
  const w = Math.min(width, x1) - Math.max(0, x0);
  const h = Math.min(height, y1) - Math.max(0, y0);
  if (w < 2 || h < 2) return null;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / MAX_SAMPLES)));
  const hist = new Float32Array(APPEARANCE_SIZE);
  const n = [0, 0];
  const mid = (Math.max(0, y0) + Math.min(height, y1)) / 2;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y += step) {
    const part = y < mid ? 0 : 1;
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x += step) {
      const i = (y * width + x) * 4;
      const [hh, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      // Dark and grey pixels carry no reliable hue: they all count as hue 0,
      // and are told apart by saturation and value.
      const hb = s < 0.15 || v < 0.15 ? 0 : Math.min(H_BINS - 1, Math.floor(hh * H_BINS));
      const sb = Math.min(S_BINS - 1, Math.floor(s * S_BINS));
      const vb = Math.min(V_BINS - 1, Math.floor(v * V_BINS));
      hist[part * APPEARANCE_PART + (hb * S_BINS + sb) * V_BINS + vb] += 1;
      n[part]++;
    }
  }
  if (!n[0] || !n[1]) return null;
  for (let i = 0; i < hist.length; i++) hist[i] /= n[i < APPEARANCE_PART ? 0 : 1];
  return hist;
}

/**
 * Bhattacharyya coefficient, part by part, averaged: 1 = the same colours,
 * 0 = none in common. (A fingerprint of any whole number of parts.)
 */
export function appearanceSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const parts = Math.max(1, Math.round(a.length / APPEARANCE_PART));
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return Math.min(1, s / parts);
}

/** A slow running average, so the fingerprint follows lighting changes without drifting onto something else. */
export function blendAppearance(template, next, rate = 0.1) {
  if (!template) return next;
  if (!next) return template;
  const out = new Float32Array(template.length);
  for (let i = 0; i < out.length; i++) out[i] = template[i] * (1 - rate) + next[i] * rate;
  return out;
}
