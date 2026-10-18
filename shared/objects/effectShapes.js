/**
 * EFFECTS THAT TAKE THE OBJECT'S OWN SHAPE (V2.3).
 *
 * V1.9's outline, glow, spotlight and blur follow the tracked BOX: a rounded
 * rectangle around the object. Once an object is SEGMENTED (V2.0) its exact
 * pixels are known, and an outline should trace the person, a glow should
 * come off their silhouette, a spotlight should cut them out and a blur
 * should blur THEM — not the rectangle they happen to sit in.
 *
 *   tracked box  ──► rounded rectangle   (no segmentation: still the fallback)
 *   subject mask ──► the object's shape  (segmented: what this file draws)
 *
 * EVERY EFFECT IS ONE ALPHA GRID. Each of the four reduces to "take the
 * mask's alpha, grow it, soften it, maybe subtract an inner copy", then lay
 * that on the canvas through the one affine transform everything else uses
 * (shared/objects/subject.js). So there is no contour tracing, no polygon
 * extraction, no second renderer — the same grid filters V2.1 already uses
 * for mask edges, with different radii:
 *
 *   outline    grow(pad + thickness) MINUS grow(pad)      a ring hugging the shape
 *   glow       blur(grow(pad + reach), reach)             a halo off the shape
 *   spotlight  blur(grow(pad), feather)                   the hole cut in the dimming
 *   blur       grow(pad)                                  the matte blurred through
 *
 * The outline's ring sits ENTIRELY OUTSIDE the subject (grow outwards, then
 * subtract the un-grown shape), so the stroke never eats into the face or the
 * hands it is meant to be drawing around.
 *
 * Lengths are the same reference pixels V1.9 uses (a canvas whose shorter
 * side is 1080), converted to mask cells by how big this mask's frame
 * actually is on the canvas — so an effect looks the same in a small preview
 * and a 4K export, on a near object and a far one.
 */
import { maskImage, videoTransformFor } from './subject.js';

/** A separable box pass over a grid: the max in the window (grow) or the mean (soften). */
function boxPass(src, width, height, radius, grow) {
  if (radius < 1) return src;
  const mid = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      if (grow) {
        let m = 0;
        for (let i = lo; i <= hi; i++) { const v = src[base + i]; if (v > m) m = v; }
        mid[base + x] = m;
      } else {
        let s = 0;
        for (let i = lo; i <= hi; i++) s += src[base + i];
        mid[base + x] = Math.round(s / (hi - lo + 1));
      }
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      if (grow) {
        let m = 0;
        for (let i = lo; i <= hi; i++) { const v = mid[i * width + x]; if (v > m) m = v; }
        out[y * width + x] = m;
      } else {
        let s = 0;
        for (let i = lo; i <= hi; i++) s += mid[i * width + x];
        out[y * width + x] = Math.round(s / (hi - lo + 1));
      }
    }
  }
  return out;
}

/**
 * A mask grid has a MARGIN of empty cells around the object (segmentation.js's
 * maskFrame widens the box), and growing can only reach into cells that
 * exist. This says how far, in cells, a grid can grow before it runs out of
 * room — so a huge padding silently stops at the frame's edge instead of
 * producing a cut-off halo.
 */
function roomToGrow(grid) {
  return Math.max(1, Math.floor(Math.min(grid.width, grid.height) * 0.18));
}

/** Reference pixels → mask cells for THIS mask. */
export function cellsPerReferencePixel(mask, unit, frameCanvasWidth) {
  return frameCanvasWidth > 0 ? (mask.grid.width / frameCanvasWidth) * unit : 0;
}

/**
 * The alpha grid for one effect, taking the object's own shape.
 *
 * @param {string} type  'outline' | 'glow' | 'spotlight' | 'blur'
 * @param {object} mask  getMaskAtTime's { alpha, grid, frame }
 * @param {object} appearance  the effect's
 * @param {number} cell  cells per reference pixel (cellsPerReferencePixel)
 * @returns {Uint8Array|null} alpha over the mask's own grid, or null if there is nothing to draw
 */
export function effectAlpha(type, mask, appearance, cell) {
  const { alpha, grid } = mask;
  const room = roomToGrow(grid);
  const at = (n) => Math.min(room, Math.max(0, Math.round(n * cell)));
  // PADDING keeps its V1.9 meaning — "a little clear of the object" — but as
  // a distance from the SHAPE rather than a bigger rectangle. It is a
  // fraction of the object's size there; here the object's size is the
  // grid's own short side, so the same number reads the same way.
  const pad = Math.min(room, Math.max(0, Math.round((appearance.padding || 0) * Math.min(grid.width, grid.height) * 0.5)));
  const grown = pad > 0 ? boxPass(alpha, grid.width, grid.height, pad, true) : alpha;

  if (type === 'outline') {
    const t = Math.max(1, at(appearance.thickness || 1));
    const outer = boxPass(grown, grid.width, grid.height, t, true);
    // The ring: everything the stroke reaches, less the shape it draws around.
    const ring = new Uint8Array(outer.length);
    let any = false;
    for (let i = 0; i < ring.length; i++) {
      const v = outer[i] - grown[i];
      if (v > 0) { ring[i] = v; any = true; }
    }
    return any ? ring : null;
  }
  if (type === 'glow') {
    const reach = Math.max(1, at(appearance.radius || 1));
    const spread = boxPass(grown, grid.width, grid.height, Math.max(1, Math.round(reach * 0.5)), true);
    const soft = boxPass(spread, grid.width, grid.height, reach, false);
    // The halo is what lies OUTSIDE the object — inside it the object's own
    // pixels show, exactly as the box glow never filled its own rectangle.
    const halo = new Uint8Array(soft.length);
    for (let i = 0; i < halo.length; i++) halo[i] = Math.max(0, soft[i] - alpha[i]);
    return halo;
  }
  if (type === 'spotlight') {
    const feather = at(appearance.feather || 0);
    return feather > 0 ? boxPass(grown, grid.width, grid.height, feather, false) : grown;
  }
  // blur: the matte is the shape itself, grown by the padding.
  return grown;
}

/**
 * Lays an effect's alpha on the canvas in one colour — the shape, placed
 * exactly where the mask says, through the video's own transform.
 * @returns {object} an offscreen canvas the caller composites
 */
export function colouredMaskLayer(mask, alpha, colour, placement, canvasWidth, canvasHeight, createCanvas) {
  const layer = createCanvas(canvasWidth, canvasHeight);
  const ctx = layer.getContext('2d');
  const img = maskImage(alpha, mask.grid, createCanvas);
  ctx.setTransform(...videoTransformFor(placement, canvasWidth, canvasHeight));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, mask.frame.x, mask.frame.y, mask.frame.width, mask.frame.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (colour) {
    // Paint the shape: keep the alpha, replace the colour.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.globalCompositeOperation = 'source-over';
  }
  return layer;
}

/** Whether this effect type draws differently when it has the object's shape. */
export const SHAPED_EFFECT_TYPES = ['outline', 'glow', 'spotlight', 'blur'];
