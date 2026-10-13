/**
 * SUBJECT ISOLATION & BACKGROUND REPLACEMENT — keeping the pixels a
 * SEGMENTATION says are the object (shared/objects/segmentation.js) and
 * putting something else behind them.
 *
 *   track (V1.8) ─► segmentation (V2.0) ─► MASK at t ─► subject | background
 *
 * It is an OBJECT EFFECT of type 'background' (shared/objects/effects.js), so
 * it inherits everything an effect already has: it follows its track by key,
 * has its own span on the Effects lane with fades, is undoable, is saved with
 * the project, and is left UNLINKED (kept, listed, drawn nowhere) when its
 * track no longer applies. What it adds is the one thing the others don't
 * need: the object's exact pixels.
 *
 * WHAT IS DRAWN, in both the preview and the export, by the same functions:
 *
 *   1. the BACKGROUND over the video's placed rectangle — a solid colour, an
 *      image, or (transparent) the composition's own canvas background;
 *   2. the SUBJECT over that — the video's own pixels through the mask.
 *
 * Only the video's rectangle is covered, never the whole canvas: the video is
 * a placed object in the composition and stays one, so a video scaled down on
 * a coloured canvas keeps its edges where the user put them. (An untransformed
 * video fills the canvas, which is the ordinary case.)
 *
 * A "transparent" background is the CANVAS background showing through, which
 * is what the preview shows and what an mp4 can carry — the format has no
 * alpha channel. Nothing here ever produces a transparent video file.
 *
 * NO MASK, NO CLAIM: wherever the segmentation has no mask — before it
 * starts, inside a gap, while the object is hidden behind someone — nothing
 * is drawn and the video is left exactly as it is. A background that blinked
 * on over a frame whose subject could not be found would cut the subject out
 * of its own film.
 */
import { videoToComposition } from './coordinates.js';

export const BACKGROUND_MODES = ['transparent', 'color', 'image'];
export const BACKGROUND_MODE_LABELS = { transparent: 'Transparent', color: 'Colour', image: 'Image' };

/**
 * Edge work, in REFERENCE PIXELS (the canvas's shorter side = 1080, as every
 * other effect length is — see effects.js's effectUnit), converted to mask
 * cells where it is applied.
 */
export const MAX_EXPAND = 40;
export const MAX_FEATHER = 40;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A separable box pass over a grid — `reduce` is Math.max (dilate) or a sum (blur). */
function boxPass(src, width, height, radius, dilate) {
  if (radius < 1) return src;
  const mid = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const run = (input, output, w, h, stride, step) => {
    for (let a = 0; a < h; a++) {
      const base = a * stride;
      for (let b = 0; b < w; b++) {
        const lo = Math.max(0, b - radius);
        const hi = Math.min(w - 1, b + radius);
        if (dilate) {
          let m = 0;
          for (let c = lo; c <= hi; c++) { const v = input[base + c * step]; if (v > m) m = v; }
          output[base + b * step] = m;
        } else {
          let s = 0;
          for (let c = lo; c <= hi; c++) s += input[base + c * step];
          output[base + b * step] = Math.round(s / (hi - lo + 1));
        }
      }
    }
  };
  run(src, mid, width, height, width, 1);
  // Down the columns: the same pass with the roles of the two axes swapped.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      if (dilate) {
        let m = 0;
        for (let c = lo; c <= hi; c++) { const v = mid[c * width + x]; if (v > m) m = v; }
        out[y * width + x] = m;
      } else {
        let s = 0;
        for (let c = lo; c <= hi; c++) s += mid[c * width + x];
        out[y * width + x] = Math.round(s / (hi - lo + 1));
      }
    }
  }
  return out;
}

/**
 * The mask's alpha with the effect's edge settings applied: EXPAND grows it
 * (a mask a shade tight round a shoulder leaves a halo of the old background;
 * growing it a little takes the halo with the subject), FEATHER softens the
 * edge so the subject doesn't look cut out with scissors.
 *
 * Both are in reference pixels and converted to mask cells by how big this
 * mask's frame actually is on the canvas — so the same setting looks the same
 * on a small preview and a 4K export, and on a near object and a far one.
 *
 * @param {{alpha:Uint8Array, grid:{width:number,height:number}, frame:object}} mask  getMaskAtTime's
 * @param {{expand:number, feather:number}} appearance
 * @param {number} unit  effects.js's effectUnit(canvasWidth, canvasHeight)
 * @param {number} frameCanvasWidth  the mask frame's width in canvas px
 */
export function maskWithEdges(mask, appearance, unit, frameCanvasWidth) {
  const { alpha, grid } = mask;
  const px = frameCanvasWidth > 0 ? grid.width / frameCanvasWidth : 0; // cells per canvas px
  const expand = Math.round((appearance?.expand || 0) * unit * px);
  const feather = Math.round((appearance?.feather || 0) * unit * px);
  let out = alpha;
  if (expand > 0) out = boxPass(out, grid.width, grid.height, expand, true);
  if (feather > 0) out = boxPass(out === alpha ? Uint8Array.from(alpha) : out, grid.width, grid.height, feather, false);
  return out;
}

// --- Placing things on the canvas ---------------------------------------------------

/**
 * Video space → canvas pixels as ONE affine transform (the placement is
 * affine, so three points fix it) — the same transform the editor's mask
 * overlay uses, so what the preview shows and what the export draws cannot
 * drift apart.
 */
export function videoTransformFor(placement, canvasWidth, canvasHeight) {
  const o = videoToComposition({ x: 0, y: 0 }, placement);
  const ux = videoToComposition({ x: 1, y: 0 }, placement);
  const vy = videoToComposition({ x: 0, y: 1 }, placement);
  return [
    (ux.x - o.x) * canvasWidth, (ux.y - o.y) * canvasHeight,
    (vy.x - o.x) * canvasWidth, (vy.y - o.y) * canvasHeight,
    o.x * canvasWidth, o.y * canvasHeight
  ];
}

/**
 * Traces the video's placed rectangle (rotated with it) in canvas pixels —
 * with its ROUNDED CORNERS where the video has them (shared/composition.js's
 * videoStyle.cornerRadius, a percentage of the video box's shorter side).
 *
 * The corners matter: a replaced background that filled the sharp rectangle
 * would paint into the corners the video itself has rounded away, putting a
 * square of colour inside a rounded frame. The BORDER and SHADOW are drawn
 * OUTSIDE the box, so the background never reaches them — it replaces what is
 * inside the video, and the frame around it stays the frame around it.
 *
 * @param {number} [cornerRadiusPct] videoStyle.cornerRadius (0-50), 0 for square
 */
export function traceVideoQuad(ctx, placement, canvasWidth, canvasHeight, cornerRadiusPct = 0) {
  const to = (x, y) => {
    const p = videoToComposition({ x, y }, placement);
    return { x: p.x * canvasWidth, y: p.y * canvasHeight };
  };
  // The radius in VIDEO space, as a fraction of each side: the shorter side's
  // percentage, which is how videoDecorationMetrics measures it.
  const bw = placement.boxWidth || 1;
  const bh = placement.boxHeight || 1;
  const rPx = (Math.min(bw, bh) * Math.max(0, Math.min(50, cornerRadiusPct))) / 100;
  const rx = Math.min(0.5, rPx / bw);
  const ry = Math.min(0.5, rPx / bh);
  if (rx <= 0 || ry <= 0) {
    const pts = [to(0, 0), to(1, 0), to(1, 1), to(0, 1)];
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    return;
  }
  // Each corner as a short run of points: the placement may rotate the video,
  // so the arc is drawn in video space and carried through like everything else.
  const STEPS = 6;
  const corners = [
    { cx: rx, cy: ry, from: Math.PI, to: 1.5 * Math.PI },
    { cx: 1 - rx, cy: ry, from: 1.5 * Math.PI, to: 2 * Math.PI },
    { cx: 1 - rx, cy: 1 - ry, from: 0, to: 0.5 * Math.PI },
    { cx: rx, cy: 1 - ry, from: 0.5 * Math.PI, to: Math.PI }
  ];
  ctx.beginPath();
  corners.forEach((c, ci) => {
    for (let i = 0; i <= STEPS; i++) {
      const a = c.from + ((c.to - c.from) * i) / STEPS;
      const p = to(c.cx + rx * Math.cos(a), c.cy + ry * Math.sin(a));
      if (!ci && !i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
  });
  ctx.closePath();
}

/** A mask's alpha as an image the size of its grid — white, the alpha carried. */
export function maskImage(alpha, grid, createCanvas) {
  const c = createCanvas(grid.width, grid.height);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(grid.width, grid.height);
  for (let i = 0; i < alpha.length; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Lays one mask on the canvas, in place, as white-on-nothing: the alpha
 * matte of the subject. The EXPORT writes exactly this as its mask stream,
 * and the preview cuts the video's pixels out with it.
 */
export function drawMaskAlpha(ctx, mask, alpha, placement, canvasWidth, canvasHeight, createCanvas) {
  const img = maskImage(alpha, mask.grid, createCanvas);
  const t = videoTransformFor(placement, canvasWidth, canvasHeight);
  ctx.save();
  ctx.setTransform(...t);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, mask.frame.x, mask.frame.y, mask.frame.width, mask.frame.height);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The BACKGROUND, over the video's placed rectangle: a solid colour, an
 * image (covering the rectangle, its own aspect kept — the same "cover" fit
 * an image layer uses), or the composition's own canvas background
 * (transparent: the video's pixels go, and what the canvas already shows
 * behind it comes through).
 *
 * @param {object} appearance  the effect's: { mode, color, opacity, ... }
 * @param {number} presence    the effect's strength at this instant (its fade)
 * @param {object} [image]     a drawable for mode 'image' (the asset's picture)
 * @param {string|null} [canvasBackground]  the composition's background colour, for 'transparent'
 * @param {number} [cornerRadiusPct]  the video's own rounded corners (videoStyle.cornerRadius)
 */
export function drawSubjectBackground(ctx, { appearance, presence, placement, canvasWidth, canvasHeight, image = null, canvasBackground = null, cornerRadiusPct = 0 }) {
  const mode = BACKGROUND_MODES.includes(appearance?.mode) ? appearance.mode : 'transparent';
  const alpha = clamp01((appearance?.opacity ?? 1) * presence);
  if (alpha <= 0.001) return false;
  if (mode === 'image' && !image) return false;
  ctx.save();
  ctx.globalAlpha = alpha;
  traceVideoQuad(ctx, placement, canvasWidth, canvasHeight, cornerRadiusPct);
  ctx.clip();
  if (mode === 'image') {
    // Cover the rectangle: the image is drawn in VIDEO space, so the clip and
    // the transform place it exactly as the video itself is placed.
    const t = videoTransformFor(placement, canvasWidth, canvasHeight);
    ctx.setTransform(...t);
    const iw = image.width || 1;
    const ih = image.height || 1;
    // The video's rectangle is 1×1 in this space, but its real shape is the
    // video's: cover means the image's aspect against the video's.
    const videoAspect = (placement.boxWidth || 1) / (placement.boxHeight || 1);
    const imageAspect = iw / ih;
    const w = imageAspect > videoAspect ? imageAspect / videoAspect : 1;
    const h = imageAspect > videoAspect ? 1 : videoAspect / imageAspect;
    ctx.drawImage(image, (1 - w) / 2, (1 - h) / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.fillStyle = mode === 'color' ? (appearance.color || '#000000') : (canvasBackground || '#000000');
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return true;
}

/**
 * Every 'background' effect on screen at `time` that actually HAS a mask
 * there, with the mask already edge-processed. The caller supplies
 * `maskAt(effect, time)` — the editor reads it from its loaded segmentation,
 * the export from the masks in its payload.
 *
 * @returns {{effect:object, state:object, mask:object, alpha:Uint8Array}[]}
 */
export function resolveSubjects(resolvedEffects, maskAt, time, placement, canvasWidth, canvasHeight, unit) {
  const out = [];
  for (const r of resolvedEffects) {
    if (r.effect.type !== 'background') continue;
    const mask = maskAt(r.effect, time);
    if (!mask) continue;
    // How wide this mask's frame is on the canvas, for the edge settings.
    const a = videoToComposition({ x: mask.frame.x, y: mask.frame.y }, placement);
    const b = videoToComposition({ x: mask.frame.x + mask.frame.width, y: mask.frame.y }, placement);
    const frameCanvasWidth = Math.hypot((b.x - a.x) * canvasWidth, (b.y - a.y) * canvasHeight);
    out.push({ ...r, mask, alpha: maskWithEdges(mask, r.effect.appearance, unit, frameCanvasWidth) });
  }
  return out;
}

/** Whether any of these effects replaces a background (so the export needs its two streams). */
export function hasBackgroundEffect(effects) {
  return (effects || []).some((e) => e.type === 'background' && e.enabled !== false);
}
