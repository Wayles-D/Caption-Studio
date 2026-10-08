/**
 * FRAMES for tracking (shared/objects/tracking.js) — pure pixel helpers the
 * editor and the Node tests both use, so a track is made the same way in
 * each:
 *
 *   regionFor / zoomRect   where to LOOK for the object next: a square
 *                          around its predicted position, cropped from the
 *                          video at full resolution and given to the
 *                          detector whole — a small or distant object fills
 *                          far more of the detector's 416px input than it
 *                          does in the whole frame (a car 300px wide in a 4K
 *                          frame is 32px to the detector; in a zoomed crop,
 *                          90px). Never zooms past ~1.5× the video's own
 *                          pixels: upscaling invents nothing to detect.
 *   cropFrame / fromRegion the crop as pixels (when the caller has the
 *                          frame, not the video), and its detections back
 *                          in whole-frame coordinates.
 *   thumbnail / cameraShift  how the whole picture moved between two
 *                          analysed frames (a pan, a handheld drift) — and
 *                          whether it is the same shot at all (a cut).
 */

/** The detector's input side, and the most a crop is ever enlarged. */
const MODEL_SIDE = 416;
const MAX_UPSCALE = 1.5;
/** A crop this close to the whole frame isn't worth it: look at the whole frame. */
const WHOLE_FRAME = 0.75;

/**
 * The square (in pixels) to look in, around `box` (0-1), wide enough to hold
 * anything within `reach` box-sizes of it — or null for the whole frame.
 * @returns {{x:number, y:number, width:number, height:number}|null} 0-1 of the frame
 */
export function regionFor(box, reach, frameWidth, frameHeight) {
  if (!box || !(frameWidth > 0) || !(frameHeight > 0)) return null;
  const size = Math.max(box.width * frameWidth, box.height * frameHeight);
  const side = Math.max(size * 2 * reach, MODEL_SIDE / MAX_UPSCALE);
  if (side >= WHOLE_FRAME * Math.max(frameWidth, frameHeight)) return null;
  const w = Math.min(side, frameWidth);
  const h = Math.min(side, frameHeight);
  const cx = (box.x + box.width / 2) * frameWidth;
  const cy = (box.y + box.height / 2) * frameHeight;
  const x = Math.min(Math.max(0, cx - w / 2), frameWidth - w);
  const y = Math.min(Math.max(0, cy - h / 2), frameHeight - h);
  return { x: x / frameWidth, y: y / frameHeight, width: w / frameWidth, height: h / frameHeight };
}

/** A region (0-1) as the pixel rectangle to crop, and the size to crop it to (the detector's input). */
export function zoomRect(region, frameWidth, frameHeight) {
  const sx = region.x * frameWidth;
  const sy = region.y * frameHeight;
  const sw = region.width * frameWidth;
  const sh = region.height * frameHeight;
  const scale = MODEL_SIDE / Math.max(sw, sh);
  return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}

/**
 * A region of an RGBA frame, resampled to the detector's input size:
 * averaged when shrinking, bilinear when enlarging.
 */
export function cropFrame(frame, region) {
  const r = zoomRect(region, frame.width, frame.height);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  const fx = r.sw / r.width;
  const fy = r.sh / r.height;
  const { data, width, height } = frame;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const o = (y * r.width + x) * 4;
      if (fx > 1 || fy > 1) {
        // Shrinking: the mean of the source pixels this one covers.
        const x0 = Math.floor(r.sx + x * fx);
        const x1 = Math.max(x0 + 1, Math.min(width, Math.floor(r.sx + (x + 1) * fx)));
        const y0 = Math.floor(r.sy + y * fy);
        const y1 = Math.max(y0 + 1, Math.min(height, Math.floor(r.sy + (y + 1) * fy)));
        const step = Math.max(1, Math.floor((x1 - x0) / 3));
        let rr = 0; let gg = 0; let bb = 0; let n = 0;
        for (let sy = y0; sy < y1; sy += step) {
          for (let sx = x0; sx < x1; sx += step) {
            const i = (Math.min(height - 1, sy) * width + Math.min(width - 1, sx)) * 4;
            rr += data[i]; gg += data[i + 1]; bb += data[i + 2]; n++;
          }
        }
        out[o] = rr / n; out[o + 1] = gg / n; out[o + 2] = bb / n; out[o + 3] = 255;
      } else {
        const sx = Math.min(width - 1, Math.max(0, r.sx + (x + 0.5) * fx - 0.5));
        const sy = Math.min(height - 1, Math.max(0, r.sy + (y + 0.5) * fy - 0.5));
        const ix = Math.min(width - 2, Math.floor(sx));
        const iy = Math.min(height - 2, Math.floor(sy));
        const ax = sx - ix;
        const ay = sy - iy;
        for (let c = 0; c < 3; c++) {
          const p = (iy * width + ix) * 4 + c;
          const q = p + width * 4;
          out[o + c] = (data[p] * (1 - ax) + data[p + 4] * ax) * (1 - ay) + (data[q] * (1 - ax) + data[q + 4] * ax) * ay;
        }
        out[o + 3] = 255;
      }
    }
  }
  return { data: out, width: r.width, height: r.height };
}

/**
 * Detections made on a crop (boxes 0-1 of the CROP) → boxes 0-1 of the
 * frame. A box cut off by the crop's edge (where that edge is not the
 * frame's) is a fragment of something only partly in view of the crop — it
 * is dropped rather than mistaken for a whole object.
 */
export function fromRegion(detections, region) {
  if (!region) return detections;
  const E = 0.004;
  const cut = (b) => (b.x <= E && region.x > E) || (b.y <= E && region.y > E)
    || (b.x + b.width >= 1 - E && region.x + region.width < 1 - E) || (b.y + b.height >= 1 - E && region.y + region.height < 1 - E);
  return detections.filter((d) => !cut(d.box)).map((d) => ({
    ...d,
    box: { x: region.x + d.box.x * region.width, y: region.y + d.box.y * region.height, width: d.box.width * region.width, height: d.box.height * region.height }
  }));
}

// --- Camera motion and cuts ---------------------------------------------------------

const THUMB_WIDTH = 128;

/** A small greyscale copy of a frame (area-averaged), for measuring how the picture moved. */
export function thumbnail(frame, width = THUMB_WIDTH) {
  const w = Math.min(width, frame.width);
  const h = Math.max(1, Math.round((frame.height * w) / frame.width));
  const out = new Uint8Array(w * h);
  const fx = frame.width / w;
  const fy = frame.height / h;
  const { data } = frame;
  const step = Math.max(1, Math.floor(fx / 3));
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let s = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += step) {
        for (let sx = x0; sx < x1; sx += step) {
          const i = (sy * frame.width + sx) * 4;
          s += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return { data: out, width: w, height: h };
}

function halve(t) {
  const w = t.width >> 1;
  const h = t.height >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = 2 * y * t.width + 2 * x;
      out[y * w + x] = (t.data[i] + t.data[i + 1] + t.data[i + t.width] + t.data[i + t.width + 1]) >> 2;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * How different `b` shifted by (dx, dy) is from `a`: the mean of each
 * pixel's difference, CAPPED — so a person walking through the picture
 * counts a little, not a lot, and the background decides. `skip` marks
 * pixels not to count (the tracked object itself).
 */
function cost(a, b, dx, dy, skip) {
  let s = 0;
  let n = 0;
  const step = a.width > 80 ? 2 : 1;
  for (let y = Math.max(0, -dy); y < Math.min(a.height, a.height - dy); y += step) {
    for (let x = Math.max(0, -dx); x < Math.min(a.width, a.width - dx); x += step) {
      if (skip && skip[y * a.width + x]) continue;
      s += Math.min(40, Math.abs(a.data[y * a.width + x] - b.data[(y + dy) * b.width + x + dx]));
      n++;
    }
  }
  return n > 50 ? s / n : Infinity;
}

function maskOf(t, boxes) {
  if (!boxes?.length) return null;
  const m = new Uint8Array(t.width * t.height);
  for (const bx of boxes) {
    const x0 = Math.max(0, Math.floor(bx.x * t.width));
    const x1 = Math.min(t.width, Math.ceil((bx.x + bx.width) * t.width));
    const y0 = Math.max(0, Math.floor(bx.y * t.height));
    const y1 = Math.min(t.height, Math.ceil((bx.y + bx.height) * t.height));
    for (let y = y0; y < y1; y++) m.fill(1, y * t.width + x0, y * t.width + x1);
  }
  return m;
}

/** How alike two pictures' brightness distributions are (1 = the same). */
function histogramSimilarity(a, b) {
  const ha = new Float32Array(16);
  const hb = new Float32Array(16);
  for (let i = 0; i < a.data.length; i++) ha[a.data[i] >> 4]++;
  for (let i = 0; i < b.data.length; i++) hb[b.data[i] >> 4]++;
  let s = 0;
  for (let i = 0; i < 16; i++) s += Math.sqrt((ha[i] / a.data.length) * (hb[i] / b.data.length));
  return s;
}

/**
 * How the picture moved from thumbnail `a` to thumbnail `b` (a pan moves
 * everything one way), ignoring `exclude` (boxes 0-1 in `a`: the object
 * itself, which moves its own way).
 * @returns {{dx:number, dy:number, cut:boolean}} dx/dy 0-1 of the frame (0
 *   when the background is too plain to tell); cut: not the same shot.
 */
export function cameraShift(a, b, exclude = []) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return { dx: 0, dy: 0, cut: false };
  // Coarse to fine: search the half-size picture widely, then refine.
  const ha = halve(a);
  const hb = halve(b);
  const hskip = maskOf(ha, exclude);
  const R = Math.round(ha.width * 0.2);
  const still = cost(ha, hb, 0, 0, hskip);
  let best = { dx: 0, dy: 0, c: still };
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const c = cost(ha, hb, dx, dy, hskip);
      if (c < best.c) best = { dx, dy, c };
    }
  }
  const skip = maskOf(a, exclude);
  let fine = { dx: best.dx * 2, dy: best.dy * 2, c: Infinity };
  for (let dy = best.dy * 2 - 1; dy <= best.dy * 2 + 1; dy++) {
    for (let dx = best.dx * 2 - 1; dx <= best.dx * 2 + 1; dx++) {
      const c = cost(a, b, dx, dy, skip);
      if (c < fine.c) fine = { dx, dy, c };
    }
  }
  // Not the same shot: nothing lines up however it is shifted (measured:
  // a cut ~23, the fastest real pan ~11), and the light itself changed.
  const cut = fine.c > 18 && histogramSimilarity(a, b) < 0.98;
  if (cut) return { dx: 0, dy: 0, cut: true };
  // A shift only counts when it explains the picture clearly better than
  // standing still — a plain wall "matches" anywhere.
  const stillFine = cost(a, b, 0, 0, skip);
  // A one-pixel shift is noise from whatever moves in the picture, not a pan.
  if (!(fine.c < stillFine * 0.8) || (Math.abs(fine.dx) <= 1 && Math.abs(fine.dy) <= 1)) return { dx: 0, dy: 0, cut: false };
  // b's content sits at (x+dx) where a's was at x: the picture moved by +dx.
  return { dx: fine.dx / a.width, dy: fine.dy / a.height, cut: false };
}
