/**
 * OBJECT SEGMENTATION — WHICH PIXELS belong to a TRACKED object
 * (shared/objects/tracking.js), over time. A track tells BHYND where an
 * object is; a segmentation tells it which pixels are the object.
 *
 * Pure: the frames and the model (MobileSAM, via onnxruntime) are supplied by
 * the caller — the editor's worker, or the Node test harness — so what is
 * tested is exactly what runs. Nothing here renders, and no renderer runs it.
 *
 *   ObjectSegmentation (the record — small, saved with the project)
 *   ├── analysisType      'objectSegmentation'
 *   ├── analysisVersion   this file's data format
 *   ├── segmenter         { id, version } — the model that made it
 *   ├── config            keyframe step, grid size, margins
 *   ├── trackKey          the track it belongs to (tracking.js's trackCacheKey)
 *   ├── trackSignature    a fingerprint of THAT track's samples — re-tracking
 *   │                     changes it, and the segmentation is stale
 *   ├── grid              { width, height } — every keyframe mask's size
 *   ├── margin            how far the mask frame extends past the tracked box
 *   ├── keyframes[]       { time, confidence 0-1, level, state, hidden? } — no pixels
 *   ├── confidence, status ('completed' | 'low-confidence' | 'partial' | 'failed')
 *   └── artifact          { key, bytes } — where the PIXELS are (see below)
 *
 *   The pixels (the ARTIFACT — kept outside the project, in the browser's
 *   file store, deflated): one soft alpha grid per keyframe, 0-255,
 *   run-length encoded. A grid covers the MASK FRAME: the tracked box at that
 *   keyframe, widened by `margin` on every side — in SOURCE VIDEO space
 *   (0-1 of the displayed frame), never screen space.
 *
 * WHY BOX-RELATIVE: between keyframes the object moves; its track says where
 * to, every frame. A mask stored relative to its box is laid on the box the
 * track gives at any time — so it moves and scales exactly with the track,
 * and only its SHAPE comes from the keyframes.
 *
 * READING A MASK (getMaskAtTime): the two keyframes around `t`, each laid on
 * the box at `t`, MORPHED through their signed distance fields — so a
 * swinging leg's edge slides between its two positions instead of showing
 * both, half-transparent (signedDistance). Too
 * far apart, or one of them hidden: the nearer one alone — and near a hidden
 * keyframe, no mask.
 * Outside the track, inside its gaps, or where the track has no claim: no
 * mask — nothing is claimed where the object can't be shown to be.
 *
 * IDENTITY: the tracked box is the prompt, and the other objects of its class
 * the detector sees there are "not this" points; and a mask that SPILLS onto
 * another of them (reaches into their box beyond its own) is not the object —
 * that keyframe is HIDDEN: no mask, rather than someone else's pixels
 * (measured: mid-crossing, the box around a half-hidden person held mostly
 * the person in front).
 *
 * CONFIDENCE, per keyframe: the model's own predicted IoU × how well the
 * mask agrees with the tracked box × how consistent it is with the previous
 * keyframe (weakly) × the track's own state there (uncertain → lower) × how
 * little it spills. Levels: high ≥ 0.75, medium ≥ 0.5, low.
 */

export const SEGMENTATION_ANALYSIS_TYPE = 'objectSegmentation';
export const SEGMENTATION_ANALYSIS_VERSION = 1;
export const SEGMENTER = { id: 'mobilesam', version: '1.0.0' };
export const SEGMENTATION_STATUSES = ['completed', 'low-confidence', 'partial', 'failed'];

export const DEFAULT_SEGMENTATION_CONFIG = {
  /**
   * Seconds between segmented keyframes. FIXED: adaptive spacing (wider where
   * the shape holds, closer where it changes) was built and measured, and
   * dropped — it saved ~30% only on near-still subjects, and moving the
   * keyframes around a crossing broke identity protection there (spill onto
   * the other person 20-83% vs 11%).
   */
  step: 0.4,
  /** The mask grid's long side (cells). */
  gridLongSide: 192,
  /** The mask frame: the tracked box widened by this much of its size on every side (limbs, hair, a raised arm). */
  margin: 0.2,
  /** The crop the model looks at: the box widened by this much of its size (context helps the model). */
  cropPad: 0.35,
  /** Whether the previous keyframe's mask prompts the next (temporal stability). */
  usePreviousMask: true
};

export const MASK_LEVELS = { high: 0.75, medium: 0.5 };
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export function maskLevel(confidence) {
  return confidence >= MASK_LEVELS.high ? 'high' : confidence >= MASK_LEVELS.medium ? 'medium' : 'low';
}

// --- Identity and staleness ------------------------------------------------------

/** A short fingerprint of a track's content — re-tracking (new samples) changes it. FNV-1a over times and boxes. */
export function trackSignature(track) {
  let h = 0x811c9dc5;
  const mix = (n) => {
    const v = Math.round(n * 1e4);
    for (let i = 0; i < 4; i++) { h ^= (v >>> (i * 8)) & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  };
  (track?.samples || []).forEach((s) => { mix(s.time); mix(s.box.x); mix(s.box.y); mix(s.box.width); mix(s.box.height); mix(s.state === 'tracked' ? 1 : 0); });
  (track?.gaps || []).forEach((g) => { mix(g.start); mix(g.end); });
  return h.toString(36);
}

/** Which cache a segmentation belongs in: the track (and its content), the model, this format, the settings. */
export function segmentationCacheKey(trackKey, track, config = DEFAULT_SEGMENTATION_CONFIG) {
  if (!trackKey || !track) return null;
  const c = { ...DEFAULT_SEGMENTATION_CONFIG, ...config };
  return `${trackKey}|seg:${SEGMENTER.id}@${SEGMENTER.version}|v${SEGMENTATION_ANALYSIS_VERSION}`
    + `|s${c.step}g${c.gridLongSide}m${c.margin}p${c.cropPad}${c.usePreviousMask ? 'M' : ''}|t${trackSignature(track)}`;
}

/** Whether a stored segmentation is authoritative for this track and settings. */
export function isSegmentationValidFor(seg, trackKey, track, config) {
  return !!seg && seg.key === segmentationCacheKey(trackKey, track, config ?? seg.config);
}

// --- Geometry: boxes, frames, crops --------------------------------------------------

/** The mask frame for a box: the box widened by `margin` of its size each side (may extend past the video). */
export function maskFrame(box, margin) {
  return { x: box.x - margin * box.width, y: box.y - margin * box.height, width: box.width * (1 + 2 * margin), height: box.height * (1 + 2 * margin) };
}

/** A segmentation's grid size, chosen once from the object's shape at its start. */
export function gridFor(box, frameWidth, frameHeight, longSide = DEFAULT_SEGMENTATION_CONFIG.gridLongSide) {
  const aspect = Math.min(4, Math.max(0.25, (box.width * frameWidth) / Math.max(1e-6, box.height * frameHeight)));
  return aspect >= 1
    ? { width: longSide, height: Math.max(16, Math.round(longSide / aspect)) }
    : { width: Math.max(16, Math.round(longSide * aspect)), height: longSide };
}

/**
 * The crop the model looks at (frame PIXELS, inside the frame), and the size
 * it is resized to for the encoder (long side 1024 — MobileSAM's input).
 */
export function cropFor(box, frameWidth, frameHeight, pad = DEFAULT_SEGMENTATION_CONFIG.cropPad) {
  const bw = box.width * frameWidth;
  const bh = box.height * frameHeight;
  const x0 = Math.max(0, Math.floor(box.x * frameWidth - pad * bw));
  const y0 = Math.max(0, Math.floor(box.y * frameHeight - pad * bh));
  const x1 = Math.min(frameWidth, Math.ceil((box.x + box.width) * frameWidth + pad * bw));
  const y1 = Math.min(frameHeight, Math.ceil((box.y + box.height) * frameHeight + pad * bh));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const scale = 1024 / Math.max(w, h);
  return { x: x0, y: y0, width: w, height: h, scale, inputWidth: Math.max(1, Math.round(w * scale)), inputHeight: Math.max(1, Math.round(h * scale)) };
}

/** The box prompt, in the encoder input's pixels: top-left and bottom-right corners (SAM labels 2 and 3). */
export function boxPrompt(box, crop, frameWidth, frameHeight) {
  const px = (fx, fy) => [(fx * frameWidth - crop.x) * crop.scale, (fy * frameHeight - crop.y) * crop.scale];
  return { coords: [...px(box.x, box.y), ...px(box.x + box.width, box.y + box.height)], labels: [2, 3] };
}

// --- The model's output → a mask -------------------------------------------------------

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/**
 * The model's mask logits (crop pixels, `crop.width`×`crop.height`) → a soft
 * alpha grid over the MASK FRAME of `box`. The edge is the model's decision
 * boundary (logit 0), anti-aliased over about a cell — not the model's whole
 * soft output, whose low-confidence regions come out as blocky ghosts.
 */
export function logitsToGrid(logits, crop, box, grid, margin, frameWidth, frameHeight) {
  const f = maskFrame(box, margin);
  const out = new Uint8Array(grid.width * grid.height);
  // How many crop pixels one grid cell spans: the edge is softened over about one cell.
  const cellPx = Math.max(1, (f.width * frameWidth) / grid.width);
  const k = 4 / cellPx;
  for (let gy = 0; gy < grid.height; gy++) {
    const fy = f.y + ((gy + 0.5) / grid.height) * f.height;
    const cy = fy * frameHeight - crop.y - 0.5;
    for (let gx = 0; gx < grid.width; gx++) {
      const fx = f.x + ((gx + 0.5) / grid.width) * f.width;
      const cx = fx * frameWidth - crop.x - 0.5;
      if (cx < 0 || cy < 0 || cx > crop.width - 1 || cy > crop.height - 1) continue;
      const x0 = Math.floor(cx); const y0 = Math.floor(cy);
      const x1 = Math.min(crop.width - 1, x0 + 1); const y1 = Math.min(crop.height - 1, y0 + 1);
      const ax = cx - x0; const ay = cy - y0;
      const v = (logits[y0 * crop.width + x0] * (1 - ax) + logits[y0 * crop.width + x1] * ax) * (1 - ay)
        + (logits[y1 * crop.width + x0] * (1 - ax) + logits[y1 * crop.width + x1] * ax) * ay;
      out[gy * grid.width + gx] = Math.round(255 * sigmoid(v * k));
    }
  }
  return out;
}

/**
 * Keeps the OBJECT: the connected region(s) of the mask that make up most of
 * it — the largest, and any other at least a fifth its size — dropping stray
 * blobs; and fills holes smaller than 1% of it (a speckle, not the gap
 * between two legs). In place; returns the grid.
 */
export function cleanMask(alpha, grid) {
  const { width: W, height: H } = grid;
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 128 || label[i] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const p = stack.pop();
      count++;
      const x = p % W;
      if (x > 0 && label[p - 1] < 0 && alpha[p - 1] >= 128) { label[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && label[p + 1] < 0 && alpha[p + 1] >= 128) { label[p + 1] = id; stack.push(p + 1); }
      if (p >= W && label[p - W] < 0 && alpha[p - W] >= 128) { label[p - W] = id; stack.push(p - W); }
      if (p < n - W && label[p + W] < 0 && alpha[p + W] >= 128) { label[p + W] = id; stack.push(p + W); }
    }
    sizes.push(count);
  }
  if (!sizes.length) return alpha;
  const biggest = Math.max(...sizes);
  const keep = sizes.map((s) => s >= biggest / 5);
  // Stray blobs (and their soft edges, within 2 cells) go.
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (label[i] >= 0 && keep[label[i]]) near[i] = 1;
  for (let pass = 0; pass < 2; pass++) {
    const grow = near.slice();
    for (let i = 0; i < n; i++) {
      if (near[i]) continue;
      const x = i % W;
      if ((x > 0 && near[i - 1]) || (x < W - 1 && near[i + 1]) || (i >= W && near[i - W]) || (i < n - W && near[i + W])) grow[i] = 1;
    }
    near.set(grow);
  }
  for (let i = 0; i < n; i++) if (!near[i]) alpha[i] = 0;
  // Small holes: background regions not reaching the grid's edge, under 1% of the object.
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i] >= 128 || seen[i]) continue;
    const region = [];
    let touches = false;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      region.push(p);
      const x = p % W;
      if (x === 0 || x === W - 1 || p < W || p >= n - W) touches = true;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p < n - W ? p + W : -1]) {
        if (q >= 0 && !seen[q] && alpha[q] < 128) { seen[q] = 1; stack.push(q); }
      }
    }
    if (!touches && region.length < biggest * 0.01) region.forEach((p) => { alpha[p] = 255; });
  }
  return alpha;
}

/** IoU of two grids' foregrounds (alpha ≥ 128). 1 when both are empty. */
export function gridIoU(a, b) {
  let inter = 0; let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] >= 128; const q = b[i] >= 128;
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
}

/** How well a mask agrees with its tracked box: most of it inside the box, and filling a fair part of it. */
export function boxAgreement(alpha, grid, margin) {
  const inner = 1 / (1 + 2 * margin);
  const x0 = Math.floor(grid.width * margin * inner); const x1 = Math.ceil(grid.width * (1 - margin * inner));
  const y0 = Math.floor(grid.height * margin * inner); const y1 = Math.ceil(grid.height * (1 - margin * inner));
  let total = 0; let inside = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (alpha[y * grid.width + x] < 128) continue;
      total++;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) inside++;
    }
  }
  const boxCells = Math.max(1, (x1 - x0) * (y1 - y0));
  const within = total ? inside / total : 0;
  const fill = inside / boxCells;
  // A person fills ~35-70% of their box; under 12% the model found a fragment.
  return clamp01(within * Math.min(1, fill / 0.12));
}

/**
 * How much of a mask SPILLS onto another object of its class: the share of
 * its pixels lying inside another detection's box and OUTSIDE the object's
 * own box. Mid-crossing, a mask taking the person in front reaches into that
 * person's box beyond its own; a mask of its own object stays (almost) in
 * its box. The detection that is the object itself (the best fit to its box)
 * does not count.
 *
 * (Colour was tried first, and rejected: on real footage the same man scored
 * 0.55-0.68 against his own fingerprint from 0.4s earlier — the light, motion
 * blur and how much of him the mask held all move it — while on synthetic
 * footage it looked perfect. Where the pixels are does not drift like that.)
 */
export function maskSpill(alpha, grid, box, margin, others) {
  return maskOnOthers(alpha, grid, box, margin, others).spill;
}

/**
 * Where a mask lies relative to the other objects of its class:
 *   spill   — the share of it inside another's box AND outside its own (maskSpill)
 *   overlap — the share of it inside another's box at all
 * An overlap means little on its own (two people side by side share box
 * corners) — but while the TRACK is unsure where the object is, a mask lying
 * mostly inside someone else's box may well be them (see judgeKeyframe).
 */
export function maskOnOthers(alpha, grid, box, margin, others) {
  if (!others?.length) return { spill: 0, overlap: 0 };
  const f = maskFrame(box, margin);
  const area = (b) => b.width * b.height;
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const iouOf = (a, b) => inter(a, b) / (area(a) + area(b) - inter(a, b) || 1);
  const self = others.reduce((m, o) => (iouOf(o, box) > iouOf(m, box) ? o : m), others[0]);
  const rects = others
    .filter((o) => !(o === self && iouOf(o, box) > 0.5))
    .map((o) => ({
      x0: ((o.x - f.x) / f.width) * grid.width, x1: ((o.x + o.width - f.x) / f.width) * grid.width,
      y0: ((o.y - f.y) / f.height) * grid.height, y1: ((o.y + o.height - f.y) / f.height) * grid.height
    }));
  if (!rects.length) return { spill: 0, overlap: 0 };
  const inner = 1 / (1 + 2 * margin);
  const bx0 = grid.width * margin * inner; const bx1 = grid.width * (1 - margin * inner);
  const by0 = grid.height * margin * inner; const by1 = grid.height * (1 - margin * inner);
  let total = 0; let spilled = 0; let onOther = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (alpha[y * grid.width + x] < 128) continue;
      total++;
      const cx = x + 0.5; const cy = y + 0.5;
      if (!rects.some((r) => cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1)) continue;
      onOther++;
      if (!(cx >= bx0 && cx < bx1 && cy >= by0 && cy < by1)) spilled++;
    }
  }
  return total ? { spill: spilled / total, overlap: onOther / total } : { spill: 0, overlap: 0 };
}

/** Above this share of its pixels on someone else, a mask is not the object. */
export const MAX_SPILL = 0.12;

/**
 * Judges a fresh keyframe mask.
 *   hidden: the mask is not the object — empty, or spilling onto another
 *   object of its class (the person in front of it, mid-crossing), or —
 *   while the track itself is unsure — lying mostly inside another's box. Such a
 *   keyframe has NO mask: nothing is claimed rather than the wrong pixels.
 *   Otherwise the confidence: the model's predicted IoU × its fit to the
 *   tracked box × (weakly) its consistency with the last mask × the track's
 *   state × how little it spills.
 * @returns {{hidden:boolean, confidence:number}}
 */
export function judgeKeyframe({ alpha, grid, margin, predictedIoU, previous, trackState, spill = 0, overlap = 0, afterHidden = false }) {
  const agree = boxAgreement(alpha, grid, margin);
  if (agree < 0.05 || spill > MAX_SPILL) return { hidden: true, confidence: 0 };
  // The track unsure where the object is, and the mask mostly inside someone
  // else's box: whose pixels these are cannot be told (measured: the object
  // almost wholly behind the person in front — a mask entirely within its
  // own box, and all of it the other person). No mask, rather than a guess.
  //
  // Coming back from a hidden keyframe with the track still unsure, there is
  // no last mask to agree with: the mask must be clear of everyone else to
  // be trusted again (measured: an adaptively placed keyframe just after a
  // crossing, 21% inside the other person's box, was 58% their pixels).
  const tolerated = afterHidden ? 0.15 : 0.5;
  if (trackState === 'uncertain' && overlap > tolerated) return { hidden: true, confidence: 0 };
  // Weakly: a walking, turning, approaching person changes shape between
  // keyframes for real (measured 0.3-0.75 on a street clip, 0.4s apart).
  const temporal = previous ? gridIoU(alpha, previous) : 1;
  const trackFactor = trackState === 'uncertain' ? 0.75 : 1;
  const confidence = clamp01(clamp01(predictedIoU) * agree * (0.7 + 0.3 * temporal) * trackFactor * (1 - (spill / MAX_SPILL) * 0.5));
  return { hidden: false, confidence };
}

/**
 * The prompt's NEGATIVE points — "not this one": on each OTHER object of its
 * class near it (the same frame's detections), placed on the part of that
 * object that sticks OUT of the tracked box. Mid-crossing, the box around a
 * half-hidden person also holds the person in front; told that person is not
 * it, the model leaves them out and segments what is left of the object.
 *
 * Never inside the tracked box: a detection lying wholly inside it is a
 * FRAGMENT of the object itself (half of a person either side of a pillar —
 * measured: a negative point there made the model segment the pillar), and
 * the part of another object inside the box may be the object's own pixels
 * if it is the one in front. Another object that overlaps always reaches
 * outside; a fragment of this one never does.
 */
export function negativePoints(box, others, crop, frameWidth, frameHeight) {
  const pts = [];
  (others || []).forEach((o) => {
    const ox0 = o.x; const ox1 = o.x + o.width; const oy0 = o.y; const oy1 = o.y + o.height;
    const bx0 = box.x; const bx1 = box.x + box.width; const by0 = box.y; const by1 = box.y + box.height;
    // How much of it lies outside the box, each side.
    const left = Math.max(0, Math.min(ox1, bx0) - ox0);
    const right = Math.max(0, ox1 - Math.max(ox0, bx1));
    const above = Math.max(0, Math.min(oy1, by0) - oy0);
    const below = Math.max(0, oy1 - Math.max(oy0, by1));
    const outside = Math.max(left * o.height, right * o.height, above * o.width, below * o.width);
    if (outside < 0.25 * o.width * o.height) return; // (mostly) inside the box: a fragment of it, or ambiguous
    let x; let ys;
    if (left * o.height === outside) { x = ox0 + left / 2; ys = [0.3, 0.5, 0.7].map((f) => oy0 + f * o.height); }
    else if (right * o.height === outside) { x = ox1 - right / 2; ys = [0.3, 0.5, 0.7].map((f) => oy0 + f * o.height); }
    else { x = ox0 + o.width / 2; ys = [above ? oy0 + above / 2 : oy1 - below / 2]; }
    ys.forEach((y) => {
      const px = (x * frameWidth - crop.x) * crop.scale;
      const py = (y * frameHeight - crop.y) * crop.scale;
      if (px >= 0 && py >= 0 && px < crop.inputWidth && py < crop.inputHeight) pts.push(px, py);
    });
  });
  return pts;
}

/**
 * The previous keyframe's low-resolution mask logits (256×256, over the
 * previous encoder input) warped onto THIS keyframe's input — box-relative,
 * so the old shape arrives where the object now is. MobileSAM's mask prompt.
 */
export function warpLowRes(prev, prevCrop, prevBox, crop, box, frameWidth, frameHeight) {
  const out = new Float32Array(256 * 256).fill(-20);
  for (let v = 0; v < 256; v++) {
    for (let u = 0; u < 256; u++) {
      // This cell, in this crop's frame pixels...
      const px = crop.x + ((u + 0.5) * 4) / crop.scale;
      const py = crop.y + ((v + 0.5) * 4) / crop.scale;
      // ...relative to this box...
      const rx = (px / frameWidth - box.x) / box.width;
      const ry = (py / frameHeight - box.y) / box.height;
      // ...is that point of the previous box, in the previous input's cells.
      const qx = ((prevBox.x + rx * prevBox.width) * frameWidth - prevCrop.x) * prevCrop.scale / 4 - 0.5;
      const qy = ((prevBox.y + ry * prevBox.height) * frameHeight - prevCrop.y) * prevCrop.scale / 4 - 0.5;
      if (qx < 0 || qy < 0 || qx > 255 || qy > 255) continue;
      const x0 = Math.floor(qx); const y0 = Math.floor(qy);
      const x1 = Math.min(255, x0 + 1); const y1 = Math.min(255, y0 + 1);
      const ax = qx - x0; const ay = qy - y0;
      out[v * 256 + u] = (prev[y0 * 256 + x0] * (1 - ax) + prev[y0 * 256 + x1] * ax) * (1 - ay) + (prev[y1 * 256 + x0] * (1 - ax) + prev[y1 * 256 + x1] * ax) * ay;
    }
  }
  return out;
}

// --- Running a segmentation -------------------------------------------------------------

/**
 * Segments one tracked object: a keyframe every `config.step` seconds where
 * the track has a claim (never inside its gaps), each prompted by the TRACKED
 * box there — so the mask is the object the track follows, not whatever else
 * of its class is near — and, if configured, by the previous keyframe's mask.
 *
 * @param {object} opts
 * @param {object} opts.track            a normalized ObjectTrack
 * @param {string} opts.trackKey
 * @param {{width:number, height:number}} opts.frameSize the video's pixels
 * @param {(time:number, crop:object) => Promise<{data:Float32Array}>} opts.grab
 *        the encoder input for `crop` at `time`: HWC RGB 0-255, crop.inputWidth×crop.inputHeight
 * @param {(input:{image:Float32Array, width:number, height:number, coords:number[], labels:number[], maskInput:Float32Array|null, origWidth:number, origHeight:number}) => Promise<{logits:Float32Array, lowRes:Float32Array, iou:number}>} opts.segment
 * @param {(time:number) => {box:object, state:string}|null} opts.boxAt  the track's (smoothed) box at a time — tracking.js's getTrackAtTime
 * @param {(time:number) => Promise<object[]>} [opts.others]  the frame's detected boxes of the object's class (0-1) — for "not this" points
 * @param {object} [opts.config]
 * @param {(done:number, total:number) => void} [opts.onProgress]
 * @param {(info:object) => void} [opts.onKeyframe]  each keyframe's evidence (debugging: box, negatives, scores, verdict)
 * @param {() => boolean} [opts.isCancelled]
 * @returns {Promise<{record:object, masks:Uint8Array[]}>}
 */
export async function segmentTrack(opts) {
  const config = { ...DEFAULT_SEGMENTATION_CONFIG, ...(opts.config || {}) };
  const { track, frameSize } = opts;
  const W = frameSize.width;
  const H = frameSize.height;
  const gaps = track.gaps || [];
  const firstBox = opts.boxAt(track.startTime);
  const grid = gridFor(firstBox?.box || track.samples[0].box, W, H, config.gridLongSide);
  const keyframes = [];
  const masks = [];
  let previous = null;
  let cancelled = false;
  let runs = 0;

  /** One keyframe: crop, prompt, model, mask, verdict. */
  const segmentAt = async (time) => {
    const at = opts.boxAt(time);
    if (!at) return null;
    const crop = cropFor(at.box, W, H, config.cropPad);
    const [input, others] = await Promise.all([opts.grab(time, crop), opts.others ? opts.others(time) : Promise.resolve([])]);
    const prompt = boxPrompt(at.box, crop, W, H);
    const negatives = negativePoints(at.box, others, crop, W, H);
    const maskInput = config.usePreviousMask && previous?.lowRes
      ? warpLowRes(previous.lowRes, previous.crop, previous.box, crop, at.box, W, H)
      : null;
    const out = await opts.segment({
      image: input.data, width: crop.inputWidth, height: crop.inputHeight,
      coords: [...prompt.coords, ...negatives], labels: [...prompt.labels, ...negatives.filter((_, k) => k % 2 === 0).map(() => 0)],
      maskInput, origWidth: crop.width, origHeight: crop.height
    });
    runs++;
    const alpha = cleanMask(logitsToGrid(out.logits, crop, at.box, grid, config.margin, W, H), grid);
    const { spill, overlap } = maskOnOthers(alpha, grid, at.box, config.margin, others);
    const afterHidden = !previous && keyframes.length > 0 && !!keyframes[keyframes.length - 1].hidden;
    const judged = judgeKeyframe({ alpha, grid, margin: config.margin, predictedIoU: out.iou, previous: previous?.alpha, trackState: at.state, spill, overlap, afterHidden });
    const consistency = previous && !judged.hidden ? gridIoU(alpha, previous.alpha) : null;
    return { time, at, crop, out, alpha, judged, spill, overlap, negatives: negatives.length / 2, consistency };
  };

  const accept = (r) => {
    const keyframe = { time: r.time, confidence: +r.judged.confidence.toFixed(3), level: maskLevel(r.judged.confidence), state: r.at.state, ...(r.judged.hidden ? { hidden: true } : {}) };
    const mask = r.judged.hidden ? new Uint8Array(grid.width * grid.height) : r.alpha;
    keyframes.push(keyframe);
    masks.push(mask);
    opts.onKeyframe?.({
      time: r.time, box: r.at.box, state: r.at.state, negatives: r.negatives, predictedIoU: r.out.iou, agreement: boxAgreement(r.alpha, grid, config.margin),
      spill: r.spill, overlap: r.overlap, temporal: r.consistency, hidden: r.judged.hidden, confidence: r.judged.confidence,
      keyframe, mask, grid, config
    });
    // Only a mask that IS the object prompts the next one.
    previous = r.judged.hidden ? null : { alpha: r.alpha, lowRes: r.out.lowRes, crop: r.crop, box: r.at.box };
  };

  // Times that must be keyframes: the track's ends and both edges of every gap.
  const anchors = [...new Set([track.startTime, ...gaps.flatMap((g) => [g.start, g.end]), track.endTime].map((x) => +x.toFixed(4)))]
    .filter((x) => x >= track.startTime - 1e-6 && x <= track.endTime + 1e-6).sort((a, b) => a - b);
  const inGap = (x) => gaps.find((g) => x > g.start + 1e-6 && x < g.end - 1e-6);
  // How many keyframes in all — for progress.
  const estimate = () => Math.max(keyframes.length + 1, keyframes.length + Math.ceil(Math.max(0, track.endTime - (keyframes[keyframes.length - 1]?.time ?? track.startTime)) / config.step));

  let t = track.startTime;
  const step = config.step;
  const startR = await segmentAt(t);
  if (startR) accept(startR);
  opts.onProgress?.(keyframes.length, estimate());
  while (t < track.endTime - 1e-6) {
    if (opts.isCancelled?.()) { cancelled = true; break; }
    // The next candidate: a step on — never past a required time.
    const nextAnchor = anchors.find((x) => x > t + 1e-6) ?? track.endTime;
    let cand = Math.min(t + step, nextAnchor);
    const gap = inGap(cand);
    if (gap) cand = t < gap.start - 1e-6 ? gap.start : gap.end;
    // Leaving a gap's start: the next keyframe is its end.
    const leavingGap = gaps.find((g) => Math.abs(t - g.start) < 1e-6);
    if (leavingGap && cand < leavingGap.end) cand = leavingGap.end;
    const r = await segmentAt(cand);
    if (!r) { t = cand; continue; }
    accept(r);
    t = cand;
    opts.onProgress?.(keyframes.length, estimate());
  }
  const record = buildSegmentation({ track, trackKey: opts.trackKey, config, grid, keyframes, cancelled });
  record.modelRuns = runs;
  return { record, masks };
}

/** Keyframe times over a track: every `step` from its start to its end, where it has a claim; its ends included. */
export function keyframeTimes(track, step) {
  const out = [];
  const gaps = track.gaps || [];
  const inGap = (t) => gaps.some((g) => t > g.start + 1e-6 && t < g.end - 1e-6);
  for (let t = track.startTime; t < track.endTime - 1e-6; t += step) if (!inGap(t)) out.push(+t.toFixed(4));
  out.push(+track.endTime.toFixed(4));
  // Each side of every gap: the last sighting before, the first after.
  gaps.forEach((g) => { out.push(+g.start.toFixed(4)); out.push(+g.end.toFixed(4)); });
  return [...new Set(out)].filter((t) => t >= track.startTime - 1e-6 && t <= track.endTime + 1e-6).sort((a, b) => a - b);
}

/** Assembles the record and judges it. */
export function buildSegmentation({ track, trackKey, config, grid, keyframes, cancelled = false }) {
  const c = { ...DEFAULT_SEGMENTATION_CONFIG, ...config };
  const confidence = keyframes.length ? keyframes.reduce((a, k) => a + k.confidence, 0) / keyframes.length : 0;
  const lowShare = keyframes.length ? keyframes.filter((k) => k.level === 'low').length / keyframes.length : 1;
  let status = 'completed';
  if (!keyframes.length) status = 'failed';
  else if (cancelled) status = 'partial';
  else if (confidence < 0.5 || lowShare > 0.3) status = 'low-confidence';
  return {
    analysisType: SEGMENTATION_ANALYSIS_TYPE,
    analysisVersion: SEGMENTATION_ANALYSIS_VERSION,
    segmenter: { ...SEGMENTER },
    config: c,
    key: segmentationCacheKey(trackKey, track, c),
    trackKey,
    trackSignature: trackSignature(track),
    grid: { ...grid },
    margin: c.margin,
    keyframes,
    confidence: +confidence.toFixed(3),
    status,
    artifact: null
  };
}

/** A stored record, normalized; null for anything else or one made by another version. */
export function normalizeSegmentation(raw) {
  if (!raw || raw.analysisType !== SEGMENTATION_ANALYSIS_TYPE || raw.analysisVersion !== SEGMENTATION_ANALYSIS_VERSION) return null;
  if (raw.segmenter?.id !== SEGMENTER.id || raw.segmenter?.version !== SEGMENTER.version) return null;
  if (!SEGMENTATION_STATUSES.includes(raw.status) || typeof raw.key !== 'string' || typeof raw.trackKey !== 'string') return null;
  const grid = raw.grid && raw.grid.width > 0 && raw.grid.height > 0 ? { width: raw.grid.width | 0, height: raw.grid.height | 0 } : null;
  if (!grid) return null;
  const keyframes = (raw.keyframes || [])
    .filter((k) => Number.isFinite(k?.time))
    .map((k) => ({ time: k.time, confidence: clamp01(+k.confidence || 0), level: maskLevel(clamp01(+k.confidence || 0)), state: k.state === 'uncertain' ? 'uncertain' : 'tracked', ...(k.hidden ? { hidden: true } : {}) }))
    .sort((a, b) => a.time - b.time);
  return { ...raw, grid, keyframes };
}

// --- The pixels: storage ------------------------------------------------------------------

/** Run-length encodes a grid: (value, run length as a varint) pairs. Masks are long runs of 0 and 255. */
export function encodeRLE(alpha) {
  const out = [];
  let i = 0;
  while (i < alpha.length) {
    const v = alpha[i];
    let run = 1;
    while (i + run < alpha.length && alpha[i + run] === v) run++;
    out.push(v);
    let r = run;
    while (r >= 0x80) { out.push((r & 0x7f) | 0x80); r >>>= 7; }
    out.push(r);
    i += run;
  }
  return Uint8Array.from(out);
}

export function decodeRLE(bytes, length) {
  const out = new Uint8Array(length);
  let i = 0;
  let o = 0;
  while (i < bytes.length && o < length) {
    const v = bytes[i++];
    let run = 0;
    let shift = 0;
    let b;
    do { b = bytes[i++]; run |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.fill(v, o, Math.min(length, o + run));
    o += run;
  }
  return out;
}

const MAGIC = [0x42, 0x53, 0x45, 0x47]; // "BSEG"

/**
 * The artifact's bytes BEFORE compression: "BSEG", a JSON header (the
 * segmentation's key and grid — so a file can never be read as another's),
 * then each keyframe's RLE grid with its length. The caller deflates it
 * (CompressionStream in the browser, zlib in Node — the same 'deflate-raw').
 */
export function packMasks(record, masks) {
  const header = new TextEncoder().encode(JSON.stringify({ key: record.key, grid: record.grid, count: masks.length }));
  const parts = masks.map(encodeRLE);
  const size = 4 + 4 + header.length + parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint32(4, header.length, true);
  out.set(header, 8);
  let o = 8 + header.length;
  parts.forEach((p) => { dv.setUint32(o, p.length, true); out.set(p, o + 4); o += 4 + p.length; });
  return out;
}

/** The artifact's bytes (inflated) → its RLE grids, checked against the record they belong to. Throws on a mismatch. */
export function unpackMasks(bytes, record) {
  if (!bytes || bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a segmentation artifact');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  if (header.key !== record.key) throw new Error('the artifact belongs to another segmentation');
  if (header.grid?.width !== record.grid.width || header.grid?.height !== record.grid.height || header.count !== record.keyframes.length) throw new Error('the artifact does not match its record');
  const parts = [];
  let o = 8 + hl;
  for (let i = 0; i < header.count; i++) {
    const n = dv.getUint32(o, true);
    parts.push(bytes.slice(o + 4, o + 4 + n));
    o += 4 + n;
  }
  return parts;
}

// --- Reading a mask ------------------------------------------------------------------------------

/**
 * A segmentation's masks, ready to read: the record plus its RLE grids,
 * decoding on demand (a few recent ones kept) — a long video's masks are
 * never all in memory at once.
 */
export function createMaskReader(record, rleParts) {
  const n = record.grid.width * record.grid.height;
  const cache = new Map();
  const sdfs = new Map();
  const keep = (map, i, make) => {
    if (!map.has(i)) {
      if (map.size >= 8) map.delete(map.keys().next().value);
      map.set(i, make());
    }
    return map.get(i);
  };
  const reader = {
    record,
    mask: (i) => keep(cache, i, () => decodeRLE(rleParts[i], n)),
    sdf: (i) => keep(sdfs, i, () => signedDistance(reader.mask(i), record.grid))
  };
  return reader;
}

/**
 * A mask's SIGNED DISTANCE field, in cells: negative inside, positive
 * outside, about zero on its edge — a two-pass chamfer (3-4) transform.
 * Interpolating two of these and cutting at zero MORPHS one shape into the
 * other (its edge slides), where blending the masks themselves only fades
 * one into the other — a half-transparent double image of a swinging leg.
 */
export function signedDistance(alpha, grid) {
  const { width: W, height: H } = grid;
  const BIG = 1e6;
  const pass = (inside) => {
    // Distance from each cell to the nearest cell on the OTHER side.
    const d = new Float32Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = (alpha[i] >= 128) === inside ? BIG : 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, d[i - W] + 3);
          if (x > 0) v = Math.min(v, d[i - W - 1] + 4);
          if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
        }
        d[i] = v;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (d[i] === 0) continue;
        let v = d[i];
        if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
        if (y < H - 1) {
          v = Math.min(v, d[i + W] + 3);
          if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
          if (x > 0) v = Math.min(v, d[i + W - 1] + 4);
        }
        d[i] = v;
      }
    }
    return d;
  };
  const toOutside = pass(true);
  const toInside = pass(false);
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) {
    // An empty or full mask: "far" everywhere — clamped to the grid's size.
    const dIn = Math.min(toOutside[i], 3 * (W + H)) / 3;
    const dOut = Math.min(toInside[i], 3 * (W + H)) / 3;
    out[i] = alpha[i] >= 128 ? -(dIn - 0.5) : dOut - 0.5;
  }
  return out;
}

/**
 * The object's mask at `time`.
 * @param {object} reader      createMaskReader's
 * @param {(time:number) => {box:object, state:string}|null} boxAt  the track's box at a time (getTrackAtTime)
 * @returns {{time:number, frame:object, grid:{width:number,height:number}, alpha:Uint8Array, confidence:number, level:string, state:string}|null}
 *   frame: where the grid lies, 0-1 of the video frame (the current box widened by the margin)
 */
export function getMaskAtTime(reader, boxAt, time) {
  const { record } = reader;
  const kfs = record.keyframes;
  if (!kfs.length) return null;
  const at = boxAt(time);
  if (!at) return null;
  if (time < kfs[0].time - 1e-6 || time > kfs[kfs.length - 1].time + 1e-6) return null;
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].time <= time) lo = mid; else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const span = b.time - a.time;
  const f = span > 1e-9 ? clamp01((time - a.time) / span) : 0;
  const maxSpan = (record.config?.step || DEFAULT_SEGMENTATION_CONFIG.step) * 1.6;
  const frame = maskFrame(at.box, record.margin);
  let alpha;
  let confidence;
  if (lo === hi || span < 1e-9 || span > maxSpan || a.hidden || b.hidden) {
    // Nearest only: too far apart to morph between, or one has no mask (the
    // object hidden, or not itself there) — and near THAT one, no mask at all.
    const near = f < 0.5 ? lo : hi;
    if (kfs[near].hidden) return null;
    // Beside a hidden keyframe, a mask only close to its own keyframe: half
    // way to the hidden one, the evidence for where its pixels are is gone.
    if ((a.hidden || b.hidden) && Math.abs(time - kfs[near].time) > Math.min(span, DEFAULT_SEGMENTATION_CONFIG.step) * 0.35) return null;
    alpha = reader.mask(near);
    confidence = kfs[near].confidence;
  } else {
    // Both laid on the box at `time` (they are box-relative), and MORPHED:
    // their signed distance fields interpolated, cut at zero, the edge
    // anti-aliased over a cell. At a keyframe itself, that keyframe exactly.
    if (f < 1e-6 || f > 1 - 1e-6) {
      alpha = reader.mask(f < 0.5 ? lo : hi);
    } else {
      const A = reader.sdf(lo);
      const B = reader.sdf(hi);
      alpha = new Uint8Array(A.length);
      for (let i = 0; i < A.length; i++) alpha[i] = Math.round(255 * clamp01(0.5 - (A[i] * (1 - f) + B[i] * f)));
    }
    confidence = a.confidence * (1 - f) + b.confidence * f;
  }
  if (at.state === 'uncertain') confidence *= 0.85;
  return { time, frame, grid: record.grid, alpha, confidence, level: maskLevel(confidence), state: at.state };
}

/**
 * A mask at `time` as 0-255 coverage of a W×H frame — for tests and anything
 * that needs it in frame pixels (renderers place the grid themselves).
 */
export function rasterizeMask(mask, frameWidth, frameHeight) {
  const out = new Uint8Array(frameWidth * frameHeight);
  if (!mask) return out;
  const { frame, grid, alpha } = mask;
  const x0 = Math.max(0, Math.floor(frame.x * frameWidth));
  const x1 = Math.min(frameWidth, Math.ceil((frame.x + frame.width) * frameWidth));
  const y0 = Math.max(0, Math.floor(frame.y * frameHeight));
  const y1 = Math.min(frameHeight, Math.ceil((frame.y + frame.height) * frameHeight));
  for (let y = y0; y < y1; y++) {
    const gy = (((y + 0.5) / frameHeight - frame.y) / frame.height) * grid.height - 0.5;
    for (let x = x0; x < x1; x++) {
      const gx = (((x + 0.5) / frameWidth - frame.x) / frame.width) * grid.width - 0.5;
      const ix = Math.min(grid.width - 1, Math.max(0, Math.floor(gx)));
      const iy = Math.min(grid.height - 1, Math.max(0, Math.floor(gy)));
      const jx = Math.min(grid.width - 1, ix + 1);
      const jy = Math.min(grid.height - 1, iy + 1);
      const ax = clamp01(gx - ix); const ay = clamp01(gy - iy);
      out[y * frameWidth + x] = Math.round((alpha[iy * grid.width + ix] * (1 - ax) + alpha[iy * grid.width + jx] * ax) * (1 - ay)
        + (alpha[jy * grid.width + ix] * (1 - ax) + alpha[jy * grid.width + jx] * ax) * ay);
    }
  }
  return out;
}

/** IoU of two frame-sized coverages (≥ 128 counts). */
export function coverageIoU(a, b) {
  let inter = 0; let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] >= 128; const q = b[i] >= 128;
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
}

export { centre as boxCentre };
