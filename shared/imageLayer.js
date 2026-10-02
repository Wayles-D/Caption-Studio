/**
 * IMAGE LAYERS — a picture placed over the video for a span of the timeline.
 * The model, its timing, its geometry, and the ONE function that draws it —
 * shared by the live preview (src/js/components/preview.js) and the exporter
 * (backend/utils/graphicsFrameGenerator.js), so the two cannot draw an image
 * differently.
 *
 * A layer keeps its concerns apart:
 *
 *   SOURCE      assetId (the uploaded file — never modified), name, the
 *               picture's natural size
 *   TIMELINE    start, end, enabled
 *   LAYOUT      transform: where it rests (x, y — its centre, % of the
 *               frame), how wide it is at scale 1 (width, % of the frame's
 *               width — its height follows from the picture's own aspect
 *               ratio), scale, rotation, opacity
 *   APPEARANCE  crop (fractions trimmed from each edge, applied when
 *               drawing), cornerRadius (% of the shorter side), border,
 *               shadow
 *   STACKING    layer: 'under-captions' | 'under-text' | 'over-text', and
 *               its place in the list (later = on top, within a layer)
 *   MOTION      motions: a motion list (shared/motion — at most one per
 *               kind), evaluated over the image's OWN [start, end)
 *
 * Every visual property describes the image AT REST. Motion is evaluated at
 * draw time and applied on top; nothing it does is ever written back.
 */
import { createClipId } from './audioTimeline.js';
import { normalizeMotionList, evaluateMotions, motionActiveSpans } from './motion/motion.js';

export const IMAGE_LAYER_PLACEMENTS = ['under-captions', 'under-text', 'over-text'];
export const DEFAULT_IMAGE_LAYER_PLACEMENT = 'under-captions';
export const DEFAULT_IMAGE_DURATION = 3;
const MIN_IMAGE_DURATION = 0.1;

/** What the import pickers accept; kept in sync with the server's own filter (backend/utils/multerConfig.js's uploadImage). */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

// Authored px (border width, shadow blur/offset) are in the same unit as a
// caption's: px of the 330-wide editor frame, scaled to whatever canvas is
// being drawn — so a 4px border is the same fraction of the frame in the
// preview and in a 1080px export.
const AUTHORED_FRAME_WIDTH = 330;

// Motion offsets are in object units (shared/motion/presets.js). For text
// that unit is the font size; for an image it is this fraction of its own
// shorter side — so a Slide Up rises by about a fifth of the picture, at any
// size, the same proportion of the object a text slide travels.
const IMAGE_MOTION_UNIT = 0.2;

const DEFAULT_TRANSFORM = { x: 50, y: 50, width: 60, scale: 1, rotation: 0, opacity: 100 };
const DEFAULT_CROP = { left: 0, top: 0, right: 0, bottom: 0 };
const DEFAULT_BORDER = { enabled: false, width: 4, color: '#FFFFFF' };
const DEFAULT_SHADOW = { enabled: false, blur: 12, offsetX: 0, offsetY: 6, color: '#000000', opacity: 50 };
const HEX = /^#[0-9a-fA-F]{6}$/;

const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback);

function normalizeCrop(raw) {
  const c = { ...DEFAULT_CROP, ...(raw || {}) };
  const out = {
    left: clamp(finite(c.left, 0), 0, 0.9),
    top: clamp(finite(c.top, 0), 0, 0.9),
    right: clamp(finite(c.right, 0), 0, 0.9),
    bottom: clamp(finite(c.bottom, 0), 0, 0.9)
  };
  // At least 10% of the picture always survives on each axis.
  if (out.left + out.right > 0.9) out.right = 0.9 - out.left;
  if (out.top + out.bottom > 0.9) out.bottom = 0.9 - out.top;
  return out;
}

/** A complete, safe image layer — or null if it has no source. */
export function normalizeImageLayer(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.assetId !== 'string' || !raw.assetId) return null;
  const start = Math.max(0, finite(raw.start, 0));
  const end = Math.max(start + MIN_IMAGE_DURATION, finite(raw.end, start + DEFAULT_IMAGE_DURATION));
  const t = { ...DEFAULT_TRANSFORM, ...(raw.transform || {}) };
  const a = raw.appearance || {};
  const border = { ...DEFAULT_BORDER, ...(a.border || {}) };
  const shadow = { ...DEFAULT_SHADOW, ...(a.shadow || {}) };
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId('img'),
    assetId: raw.assetId,
    name: typeof raw.name === 'string' ? raw.name : '',
    naturalWidth: Math.max(1, finite(raw.naturalWidth, 1)),
    naturalHeight: Math.max(1, finite(raw.naturalHeight, 1)),
    start,
    end,
    enabled: raw.enabled !== false,
    layer: IMAGE_LAYER_PLACEMENTS.includes(raw.layer) ? raw.layer : DEFAULT_IMAGE_LAYER_PLACEMENT,
    transform: {
      x: finite(t.x, 50),
      y: finite(t.y, 50),
      width: clamp(finite(t.width, 60), 1, 400),
      scale: clamp(finite(t.scale, 1), 0.05, 20),
      rotation: finite(t.rotation, 0),
      opacity: clamp(finite(t.opacity, 100), 0, 100)
    },
    crop: normalizeCrop(raw.crop),
    appearance: {
      cornerRadius: clamp(finite(a.cornerRadius, 0), 0, 50),
      border: { enabled: !!border.enabled, width: clamp(finite(border.width, 4), 0, 60), color: color(border.color, DEFAULT_BORDER.color) },
      shadow: {
        enabled: !!shadow.enabled,
        blur: clamp(finite(shadow.blur, 12), 0, 100),
        offsetX: clamp(finite(shadow.offsetX, 0), -200, 200),
        offsetY: clamp(finite(shadow.offsetY, 6), -200, 200),
        color: color(shadow.color, DEFAULT_SHADOW.color),
        opacity: clamp(finite(shadow.opacity, 50), 0, 100)
      }
    },
    motions: normalizeMotionList(raw.motions)
  };
}

/** A list of layers — from the array itself or its JSON string form (the export request carries either). */
export function normalizeImageLayerList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  return (Array.isArray(list) ? list : []).map(normalizeImageLayer).filter(Boolean);
}

/** A new layer: a fresh id, sized so the picture sits comfortably inside a frame of `frameAspect` (width / height). */
export function createImageLayer({ assetId, name = '', naturalWidth, naturalHeight, start = 0, duration = DEFAULT_IMAGE_DURATION, frameAspect = 9 / 16, ...rest }) {
  const imageAspect = Math.max(1, naturalWidth || 1) / Math.max(1, naturalHeight || 1);
  // 60% of the frame's width — or less, for a tall picture, so it is never
  // taller than 60% of the frame either. Never stretched: the height always
  // follows from the picture's own aspect ratio.
  const widthFraction = Math.min(0.6, (0.6 * imageAspect) / frameAspect);
  return normalizeImageLayer({
    ...rest,
    id: createClipId('img'),
    assetId,
    name,
    naturalWidth,
    naturalHeight,
    start,
    end: start + duration,
    transform: { ...DEFAULT_TRANSFORM, width: Math.round(widthFraction * 1000) / 10, ...(rest.transform || {}) }
  });
}

// --- Timing ------------------------------------------------------------------

/** Whether a layer is on screen at `time`: its own half-open [start, end). */
export function isImageLayerActive(layer, time) {
  return !!layer && layer.enabled !== false && time >= layer.start && time < layer.end;
}

export function getActiveImageLayers(layers, time) {
  return (layers || []).filter((layer) => isImageLayerActive(layer, time));
}

/** The active layers that sit at one stacking placement, bottom first. */
export function imageLayersAt(layers, placement, time) {
  return (layers || []).filter((layer) => layer.layer === placement && isImageLayerActive(layer, time));
}

/** Every instant the set of visible images can change. */
export function getImageLayerBoundaryTimes(layers) {
  const times = [];
  (layers || []).forEach((layer) => { if (layer.enabled !== false) times.push(layer.start, layer.end); });
  return times;
}

/** Where the layer's motions move it — what the exporter samples densely. */
export function imageLayerMotionSpans(layer) {
  return motionActiveSpans(layer.motions, layer);
}

// --- Geometry ----------------------------------------------------------------

/**
 * The layer AT REST on a canvas of this size, in canvas px: centre, drawn
 * size (after crop and scale), rotation, and the authored-px scale. Also the
 * box the editor's selection handles wrap.
 */
export function resolveImageGeometry(layer, canvasWidth, canvasHeight) {
  const { transform, crop } = layer;
  const visibleW = layer.naturalWidth * (1 - crop.left - crop.right);
  const visibleH = layer.naturalHeight * (1 - crop.top - crop.bottom);
  const width = canvasWidth * (transform.width / 100) * transform.scale;
  const height = width * (visibleH / visibleW);
  return {
    centerX: canvasWidth * (transform.x / 100),
    centerY: canvasHeight * (transform.y / 100),
    width,
    height,
    rotationDeg: transform.rotation,
    pxScale: canvasWidth / AUTHORED_FRAME_WIDTH
  };
}

/** The rounded-rectangle path every part of the image is clipped and stroked to. */
function roundedRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (!radius) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Draws one image layer at `time` onto `ctx` (a browser canvas or the
 * exporter's @napi-rs/canvas — only the shared 2D API is used).
 *
 * The picture is first composed on its own (crop → rounded clip → border),
 * then placed: its resting transform, with the motion delta applied on top,
 * and its shadow cast from the composed image itself — so a transparent PNG
 * casts the shadow of its own shape, and corners, border and shadow all
 * scale and rotate with the picture exactly as the picture does.
 *
 * @param {object} source - The decoded picture (HTMLImageElement / ImageBitmap / napi Image).
 * @param {{canvasWidth:number, canvasHeight:number, time:number, createOffscreenCanvas:(w:number,h:number)=>object}} opts
 * @returns {object} The layer's resting geometry (see resolveImageGeometry).
 */
export function drawImageLayer(ctx, layer, source, { canvasWidth, canvasHeight, time, createOffscreenCanvas }) {
  const g = resolveImageGeometry(layer, canvasWidth, canvasHeight);
  if (!source || !createOffscreenCanvas || g.width < 0.5 || g.height < 0.5) return g;

  const motion = evaluateMotions(layer.motions, time, layer);
  const alpha = (layer.transform.opacity / 100) * motion.opacity;
  if (alpha <= 0) return g;

  const { crop, appearance } = layer;
  const srcW = source.width || source.naturalWidth || layer.naturalWidth;
  const srcH = source.height || source.naturalHeight || layer.naturalHeight;
  const sx = srcW * crop.left;
  const sy = srcH * crop.top;
  const sw = srcW * (1 - crop.left - crop.right);
  const sh = srcH * (1 - crop.top - crop.bottom);

  // 1. The picture on its own, at its drawn size.
  const offW = Math.max(1, Math.ceil(g.width));
  const offH = Math.max(1, Math.ceil(g.height));
  const off = createOffscreenCanvas(offW, offH);
  const o = off.getContext('2d');
  const radius = (Math.min(g.width, g.height) * appearance.cornerRadius) / 100;
  o.save();
  roundedRectPath(o, 0, 0, g.width, g.height, radius);
  o.clip();
  o.drawImage(source, sx, sy, sw, sh, 0, 0, g.width, g.height);
  // The border sits INSIDE the edge (a stroke centred on the clipped path,
  // whose outer half is clipped away), so it never changes the image's size.
  if (appearance.border.enabled && appearance.border.width > 0) {
    o.lineWidth = appearance.border.width * g.pxScale * layer.transform.scale * 2;
    o.strokeStyle = appearance.border.color;
    roundedRectPath(o, 0, 0, g.width, g.height, radius);
    o.stroke();
  }
  o.restore();

  // 2. Placed: resting transform, motion on top, shadow from the composed picture.
  const unit = Math.min(g.width, g.height) * IMAGE_MOTION_UNIT;
  ctx.save();
  ctx.translate(g.centerX + motion.offsetX * unit, g.centerY + motion.offsetY * unit);
  const rotation = g.rotationDeg + motion.rotation;
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  if (motion.scale !== 1) ctx.scale(motion.scale, motion.scale);
  ctx.globalAlpha *= alpha;
  const { shadow } = appearance;
  if (shadow.enabled && shadow.opacity > 0) {
    // Canvas shadows are applied in device space — not rotated or scaled by
    // the transform — which is the same in both canvases, so they agree.
    ctx.shadowColor = hexToRgba(shadow.color, shadow.opacity / 100);
    ctx.shadowBlur = shadow.blur * g.pxScale;
    ctx.shadowOffsetX = shadow.offsetX * g.pxScale;
    ctx.shadowOffsetY = shadow.offsetY * g.pxScale;
  }
  // At its own size: the composed picture fills [0, width] of a canvas
  // rounded up to whole px, so resizing it to `width` would squash it a hair.
  ctx.drawImage(off, -g.width / 2, -g.height / 2);
  ctx.restore();
  return g;
}

// --- Stacking ------------------------------------------------------------------

/**
 * The draw order of the TEXT layer for one frame, bottom first — shared by
 * the preview's text canvas and the exporter's text-layer PNGs, so the two
 * stack identically:
 *
 *   manual captions          (kind 'caption' — in the preview only; the
 *                             exporter composites them as their own layer
 *                             beneath this one, which is the same order)
 *   images 'under-text'      above every caption, beneath every text element
 *   the cinematic interlude  which covers the frame, so it hides the above
 *   overlays
 *   images 'over-text'       on top of everything
 *
 * Images 'under-captions' are not here: they are their own layer beneath
 * the transcript's captions (the preview's images-under canvas; the
 * exporter's imagesUnder stream).
 *
 * @param {object[]} orderedText - The frame's text elements, already in
 *   shared/textElement.js's orderForCompositing order.
 * @param {object[]} images - The frame's active image layers, in list order.
 * @returns {{type:'text'|'image', item:object}[]}
 */
export function textLayerStack(orderedText, images) {
  const captions = orderedText.filter((el) => el.kind === 'caption');
  const rest = orderedText.filter((el) => el.kind !== 'caption');
  const at = (placement) => images.filter((img) => img.layer === placement).map((item) => ({ type: 'image', item }));
  return [
    ...captions.map((item) => ({ type: 'text', item })),
    ...at('under-text'),
    ...rest.map((item) => ({ type: 'text', item })),
    ...at('over-text')
  ];
}
