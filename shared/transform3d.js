/**
 * UNIVERSAL 3D TRANSFORMS (V2.4.0) — one model and one projection for every
 * visual object: text elements, image layers, shape layers and the video.
 *
 * An object is first drawn FLAT, exactly as it always was — its position,
 * size, scale and its ordinary rotation (which is the Z axis; "Spin" in the
 * panel) — and the 3D part is applied to that flat result: the object's plane
 * is tilted about a pivot on it, pushed back in depth, and seen through a
 * pinhole camera. An object without 3D settings never reaches any of this,
 * so it draws exactly as before.
 *
 *   flat drawing  →  tilt about the pivot (rotateY, then rotateX)  →  depth  →  perspective
 *
 * The maths is the same as CSS 3D transforms (`perspective(d) translateZ(-depth)
 * rotateX(a) rotateY(b)` about the pivot, y pointing down, z towards the
 * viewer): positive rotateX tips the TOP away from the viewer (a floor),
 * positive rotateY swings the RIGHT side away (a wall on the left).
 *
 * A flat plane seen through a camera is a HOMOGRAPHY — a 3×3 matrix on
 * (x, y, 1) — and that single matrix is what every renderer uses:
 *   - canvas objects (text, images, shapes): projectCanvasRegion, a per-pixel
 *     inverse mapping with bilinear sampling, the same JavaScript in the
 *     browser preview and in the exporter's @napi-rs/canvas, so the two
 *     produce the same pixels from the same flat drawing;
 *   - the video in the preview: cssMatrix3d (the browser draws it);
 *   - the video in the export: the four projected canvas corners, for
 *     ffmpeg's `perspective` filter (backend/utils/videoTransformFilter.js).
 *
 * Perspective strength is relative to the CANVAS WIDTH, so the same project
 * looks the same at the preview's size and at the export's.
 */

export const TRANSFORM_3D_DEFAULTS = Object.freeze({
  enabled: false,
  rotateX: 0, // degrees; + tips the top away (floor)
  rotateY: 0, // degrees; + swings the right side away (wall on the left)
  perspective: 50, // 0 (subtle, nearly flat) – 100 (strong, wide-angle)
  originX: 50, // the pivot, % across the object's own box
  originY: 50, // % down the object's own box
  depth: 0 // % of the canvas width; + pushes the object away (smaller)
});

/** How far either tilt can go: past ~80° the plane is edge-on and no longer readable. */
export const MAX_TILT = 80;

/** Keyframable 3D properties (shared/keyframes.js interpolates them like rotation). */
export const TRANSFORM_3D_KEYFRAME_PROPERTIES = ['rotateX', 'rotateY'];

/**
 * Starting points, not modes: applying one sets these values, and the user
 * can change any of them afterwards (the panel then reads "Custom").
 */
export const TRANSFORM_3D_PRESETS = [
  { id: 'flat', label: 'Flat', values: { rotateX: 0, rotateY: 0, originX: 50, originY: 50, depth: 0 } },
  { id: 'floor', label: 'Floor', values: { rotateX: 62, rotateY: 0, originX: 50, originY: 100, depth: 0 } },
  { id: 'wall-left', label: 'Left wall', values: { rotateX: 0, rotateY: 50, originX: 0, originY: 50, depth: 0 } },
  { id: 'wall-right', label: 'Right wall', values: { rotateX: 0, rotateY: -50, originX: 100, originY: 50, depth: 0 } },
  { id: 'tilted', label: 'Tilted', values: { rotateX: 24, rotateY: -18, originX: 50, originY: 50, depth: 0 } }
];

const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** A complete, safe 3D transform — the defaults (disabled) for anything missing or malformed. */
export function normalizeTransform3d(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: t.enabled === true,
    rotateX: clamp(finite(t.rotateX, 0), -MAX_TILT, MAX_TILT),
    rotateY: clamp(finite(t.rotateY, 0), -MAX_TILT, MAX_TILT),
    perspective: clamp(finite(t.perspective, TRANSFORM_3D_DEFAULTS.perspective), 0, 100),
    originX: clamp(finite(t.originX, 50), 0, 100),
    originY: clamp(finite(t.originY, 50), 0, 100),
    depth: clamp(finite(t.depth, 0), -50, 300)
  };
}

/**
 * The stored field, kept off objects that never used it: an object without
 * 3D settings serializes exactly as it did before V2.4.0.
 */
export function transform3dField(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return { transform3d: normalizeTransform3d(raw) };
}

/** The preset these values match, or 'custom'. */
export function matchTransform3dPreset(t) {
  const n = normalizeTransform3d(t);
  const hit = TRANSFORM_3D_PRESETS.find((p) => Object.entries(p.values).every(([k, v]) => Math.abs(n[k] - v) < 0.01));
  return hit ? hit.id : 'custom';
}

/**
 * The 3D state actually in force at one instant: the stored values, any
 * keyframed tilt (`keyframed` — already-resolved rotateX/rotateY, when the
 * object animates them) and a motion's tilt delta on top. The stored object
 * is never modified. Null when nothing is tilted, pushed back or animated in
 * 3D — the caller then draws flat, exactly as before.
 */
export function resolveTransform3d(stored, { keyframed = null, motion = null } = {}) {
  const base = stored ? normalizeTransform3d(stored) : null;
  const on = !!base?.enabled;
  const mx = motion?.rotateX || 0;
  const my = motion?.rotateY || 0;
  if (!on && !mx && !my) return null;
  const t = on ? { ...base } : { ...normalizeTransform3d(null) };
  if (on && keyframed) {
    if (Number.isFinite(keyframed.rotateX)) t.rotateX = keyframed.rotateX;
    if (Number.isFinite(keyframed.rotateY)) t.rotateY = keyframed.rotateY;
  }
  t.rotateX = clamp(t.rotateX + mx, -89, 89);
  t.rotateY = clamp(t.rotateY + my, -89, 89);
  if (!t.rotateX && !t.rotateY && !t.depth) return null;
  return t;
}

/** The camera distance, in canvas px, for a perspective strength. */
export function perspectiveDistance(strength, canvasWidth) {
  const s = clamp(finite(strength, 50), 0, 100) / 100;
  // 0 → 6 canvas widths (barely any convergence), 100 → 0.7 (wide-angle).
  return canvasWidth * (6 - 5.3 * Math.sqrt(s));
}

/**
 * The pivot in canvas px: the object's centre, moved to `origin` across its
 * own box — which is turned with the object's ordinary (Z) rotation.
 */
export function pivotFor(t, { centerX, centerY, width, height, rotationDeg = 0 }) {
  const dx = ((t.originX - 50) / 100) * width;
  const dy = ((t.originY - 50) / 100) * height;
  const r = (rotationDeg * Math.PI) / 180;
  return {
    x: centerX + dx * Math.cos(r) - dy * Math.sin(r),
    y: centerY + dx * Math.sin(r) + dy * Math.cos(r)
  };
}

/**
 * THE HOMOGRAPHY: flat canvas px → projected canvas px, as a row-major 3×3
 * (maps [x, y, 1]). Identity when nothing is tilted or pushed back.
 */
export function homographyFor(t, pivot, canvasWidth) {
  const d = perspectiveDistance(t.perspective, canvasWidth);
  const a = (t.rotateX * Math.PI) / 180;
  const b = (t.rotateY * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  // R = Rx(a) · Ry(b), applied to (x, y, 0); only its first two columns matter.
  //   Ry: x' = x cb + z sb,  z' = -x sb + z cb
  //   Rx: y' = y ca - z sa,  z' = y sa + z ca
  const r00 = cb, r01 = 0;
  const r10 = sa * sb, r11 = ca;
  const r20 = -ca * sb, r21 = sa;
  const depthPx = (t.depth / 100) * canvasWidth;
  // Relative to the pivot: X = r00 x + r01 y, Y = r10 x + r11 y, Z = r20 x + r21 y - depth,
  // and the camera at distance d: screen = (X, Y) · d / (d - Z).
  const m = [
    d * r00, d * r01, 0,
    d * r10, d * r11, 0,
    -r20, -r21, d + depthPx
  ];
  // T(pivot) · m · T(-pivot)
  const { x: px, y: py } = pivot;
  const h = mul([1, 0, px, 0, 1, py, 0, 0, 1], mul(m, [1, 0, -px, 0, 1, -py, 0, 0, 1]));
  // Scaled so the pivot keeps w = 1 (purely cosmetic: homographies are up to scale).
  const k = 1 / (d + depthPx);
  return h.map((v) => v * k);
}

/** 3×3 row-major product p · q. */
function mul(p, q) {
  return [
    p[0] * q[0] + p[1] * q[3] + p[2] * q[6], p[0] * q[1] + p[1] * q[4] + p[2] * q[7], p[0] * q[2] + p[1] * q[5] + p[2] * q[8],
    p[3] * q[0] + p[4] * q[3] + p[5] * q[6], p[3] * q[1] + p[4] * q[4] + p[5] * q[7], p[3] * q[2] + p[4] * q[5] + p[5] * q[8],
    p[6] * q[0] + p[7] * q[3] + p[8] * q[6], p[6] * q[1] + p[7] * q[4] + p[8] * q[7], p[6] * q[2] + p[7] * q[5] + p[8] * q[8]
  ];
}

/** One point through a homography; null behind the camera. */
export function projectPoint(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!(w > 1e-6)) return null;
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

export function invertHomography(h) {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  const inv = [
    A, -(b * j - c * i), b * f - c * e,
    B, a * j - c * g, -(a * f - c * d),
    C, -(a * i - b * g), a * e - b * d
  ];
  return inv.map((v) => v / det);
}

/** The four corners of a flat rectangle (centre, size, Z rotation) after projection — the outline the editor draws round a tilted object. */
export function projectedQuad(h, { centerX, centerY, width, height, rotationDeg = 0 }) {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const dx = (sx * width) / 2, dy = (sy * height) / 2;
    return projectPoint(h, centerX + dx * cos - dy * sin, centerY + dx * sin + dy * cos);
  });
}

/**
 * The CSS for an element whose box centre sits at (originX, originY) canvas px
 * and whose CSS px are `cssScale` canvas px: matrix3d(...) to put BEFORE its
 * own 2D transform (with transform-origin at its centre), so the browser
 * projects it through the same homography the export uses.
 */
export function cssMatrix3d(h, originX, originY, cssScale) {
  // H in the element's frame: S(1/k) · T(-O) · H · T(O) · S(k).
  const k = cssScale;
  const into = [k, 0, originX, 0, k, originY, 0, 0, 1]; // element px → canvas px
  const back = [1 / k, 0, -originX / k, 0, 1 / k, -originY / k, 0, 0, 1]; // canvas px → element px
  const e = mul(back, mul(h, into));
  const n = (v) => (Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(10)));
  // Column-major: x' = e0 x + e1 y + e2, y' = e3 x + e4 y + e5, w = e6 x + e7 y + e8.
  return `matrix3d(${[e[0], e[3], 0, e[6], e[1], e[4], 0, e[7], 0, 0, 1, 0, e[2], e[5], 0, e[8]].map(n).join(',')})`;
}

/**
 * Draws a FLAT drawing through a homography: `src` holds the flat pixels of
 * the region (srcX, srcY) of the canvas (canvas px); the projected result is
 * drawn onto `ctx` (normal source-over, so several objects stack as before).
 *
 * Per destination pixel the source point is found through the inverse
 * homography and sampled bilinearly — exact perspective, no seams, the same
 * arithmetic in the browser and in Node. Where the projection squeezes the
 * drawing hard (a floor seen at a steep angle), each pixel averages a 2×2
 * grid of samples so far-away text does not shimmer.
 */
export function projectCanvasRegion(ctx, src, srcX, srcY, h, { canvasWidth, canvasHeight, createOffscreenCanvas }) {
  const sw = src.width, sh = src.height;
  const corners = [[srcX, srcY], [srcX + sw, srcY], [srcX + sw, srcY + sh], [srcX, srcY + sh]].map(([x, y]) => projectPoint(h, x, y));
  // A plane folded past edge-on (any corner behind the camera) draws nothing
  // rather than something wrong; the tilt limits keep this from happening in use.
  if (corners.some((c) => !c)) return;
  const inv = invertHomography(h);
  if (!inv) return;

  const source = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  // Only where the flat drawing actually has pixels: the region handed in is
  // generous (shadows, slides), and every destination px costs a sample.
  let cx0 = sw, cy0 = sh, cx1 = -1, cy1 = -1;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < sw; x++) {
      if (source[row + x * 4 + 3]) {
        if (x < cx0) cx0 = x;
        if (x > cx1) cx1 = x;
        if (y < cy0) cy0 = y;
        cy1 = y;
      }
    }
  }
  if (cx1 < 0) return;
  const drawn = [[cx0, cy0], [cx1 + 1, cy0], [cx1 + 1, cy1 + 1], [cx0, cy1 + 1]].map(([x, y]) => projectPoint(h, srcX + x, srcY + y));
  if (drawn.some((c) => !c)) return;
  const minX = Math.max(0, Math.floor(Math.min(...drawn.map((c) => c.x)) - 1));
  const minY = Math.max(0, Math.floor(Math.min(...drawn.map((c) => c.y)) - 1));
  const maxX = Math.min(canvasWidth, Math.ceil(Math.max(...drawn.map((c) => c.x)) + 1));
  const maxY = Math.min(canvasHeight, Math.ceil(Math.max(...drawn.map((c) => c.y)) + 1));
  const dw = maxX - minX, dh = maxY - minY;
  if (dw <= 0 || dh <= 0) return;
  const out = createOffscreenCanvas(dw, dh);
  const octx = out.getContext('2d');
  const image = octx.createImageData(dw, dh);
  const dst = image.data;

  // How much the projection shrinks the drawing at its most squeezed corner:
  // the source-px footprint of one destination px, via the inverse's Jacobian.
  const footprint = (x, y) => {
    const p = projectPoint(inv, x, y), px = projectPoint(inv, x + 1, y), py = projectPoint(inv, x, y + 1);
    if (!p || !px || !py) return 1;
    return Math.max(Math.hypot(px.x - p.x, px.y - p.y), Math.hypot(py.x - p.x, py.y - p.y));
  };
  const squeeze = Math.max(...drawn.map((c) => footprint(c.x, c.y)));
  const offsets = squeeze > 1.5 ? [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] : [[0.5, 0.5]];
  const share = 1 / offsets.length;

  const [i0, i1, i2, i3, i4, i5, i6, i7, i8] = inv;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < offsets.length; s++) {
        const X = minX + x + offsets[s][0];
        const Y = minY + y + offsets[s][1];
        const w = i6 * X + i7 * Y + i8;
        if (!(w > 1e-9)) continue;
        // Source px within src (pixel centres at +0.5).
        const u = (i0 * X + i1 * Y + i2) / w - srcX - 0.5;
        const v = (i3 * X + i4 * Y + i5) / w - srcY - 0.5;
        if (u < -1 || v < -1 || u > sw || v > sh) continue;
        const ux = Math.floor(u), vy = Math.floor(v);
        const fx = u - ux, fy = v - vy;
        // Premultiplied bilinear: transparent neighbours contribute nothing,
        // so edges fade out cleanly instead of picking up dark fringes.
        for (let q = 0; q < 4; q++) {
          const sx = ux + (q & 1), sy = vy + (q >> 1);
          if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
          const wgt = ((q & 1) ? fx : 1 - fx) * ((q >> 1) ? fy : 1 - fy) * share;
          const o = (sy * sw + sx) * 4;
          const al = source[o + 3] * wgt;
          if (!al) continue;
          r += source[o] * al;
          g += source[o + 1] * al;
          b += source[o + 2] * al;
          a += al;
        }
      }
      if (a > 0) {
        const o = (y * dw + x) * 4;
        dst[o] = r / a;
        dst[o + 1] = g / a;
        dst[o + 2] = b / a;
        dst[o + 3] = a;
      }
    }
  }
  octx.putImageData(image, 0, 0);
  ctx.drawImage(out, minX, minY);
}

/**
 * The one entry point the object renderers call. `draw(ctx)` draws the object
 * flat, in canvas px, as it always has; `bounds` is where that flat drawing
 * can reach (canvas px, generous — shadows, strokes). With no 3D in force it
 * simply draws onto `ctx`. Otherwise it draws into a scratch canvas of that
 * region and projects it.
 */
export function drawWithTransform3d(ctx, t3d, { pivot, bounds, canvasWidth, canvasHeight, createOffscreenCanvas }, draw) {
  if (!t3d || !createOffscreenCanvas) {
    draw(ctx);
    return null;
  }
  const x0 = Math.floor(Math.max(-canvasWidth, bounds.x));
  const y0 = Math.floor(Math.max(-canvasHeight, bounds.y));
  const x1 = Math.ceil(Math.min(2 * canvasWidth, bounds.x + bounds.width));
  const y1 = Math.ceil(Math.min(2 * canvasHeight, bounds.y + bounds.height));
  if (x1 <= x0 || y1 <= y0) return null;
  const flat = createOffscreenCanvas(x1 - x0, y1 - y0);
  const fctx = flat.getContext('2d');
  fctx.translate(-x0, -y0);
  // The flat drawing carries the target's opacity, as drawing on ctx would.
  fctx.globalAlpha = ctx.globalAlpha;
  draw(fctx);
  const h = homographyFor(t3d, pivot, canvasWidth);
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = 1;
  projectCanvasRegion(ctx, flat, x0, y0, h, { canvasWidth, canvasHeight, createOffscreenCanvas });
  ctx.globalAlpha = alpha;
  return h;
}

/** A rotated box's axis-aligned bounds, grown by `margin` px on every side. */
export function rotatedBounds({ centerX, centerY, width, height, rotationDeg = 0 }, margin = 0) {
  const r = (rotationDeg * Math.PI) / 180;
  const hw = (Math.abs(width * Math.cos(r)) + Math.abs(height * Math.sin(r))) / 2 + margin;
  const hh = (Math.abs(width * Math.sin(r)) + Math.abs(height * Math.cos(r))) / 2 + margin;
  return { x: centerX - hw, y: centerY - hh, width: hw * 2, height: hh * 2 };
}
