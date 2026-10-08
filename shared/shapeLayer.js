/**
 * SHAPE LAYERS — a generated shape (no file behind it) placed over the video
 * for a span of the timeline. The model, its geometry, and the ONE function
 * that draws it, shared by the live preview and the exporter — the same
 * arrangement as image layers (shared/imageLayer.js).
 *
 *   IDENTITY    id, kind: 'rectangle' | 'rounded' | 'ellipse' | 'line' | 'arrow' | 'pill'
 *   TIMELINE    start, end, enabled
 *   GEOMETRY    transform: centre (x, y — % of the frame), width and height
 *               (both % of the frame's WIDTH, so a square stays square at
 *               any frame size), scale, rotation, opacity
 *               — a line's length is its width and its thickness its height;
 *               an arrow's head is as tall as its height
 *   APPEARANCE  fill (colour, on/off), border (inside the edge), cornerRadius
 *               (% of the shorter side — a rounded rectangle's; a pill is
 *               always fully round), shadow (cast from the shape itself)
 *   STACKING    its place in the one layer stack (shared/visualLayers.js)
 *   MOTION      a motion list (shared/motion), over the shape's OWN [start, end)
 *
 * Every field describes the shape AT REST; motion is applied on top at draw
 * time and never written back.
 */
import { createClipId } from './audioTimeline.js';
import { normalizeMotionList, evaluateMotions, motionActiveSpans } from './motion/motion.js';

export const SHAPE_KINDS = ['rectangle', 'rounded', 'ellipse', 'line', 'arrow', 'pill'];
export const SHAPE_LABELS = { rectangle: 'Rectangle', rounded: 'Rounded rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', pill: 'Pill' };
export const DEFAULT_SHAPE_DURATION = 3;
const MIN_SHAPE_DURATION = 0.1;
const AUTHORED_FRAME_WIDTH = 330;

// Motion offsets are in object units: a fifth of the shape's shorter side, as
// for an image — but never less than a fortieth of the frame, so a thin line
// still slides a visible distance.
const SHAPE_MOTION_UNIT = 0.2;

/** A sensible starting size per kind (% of the frame width). */
const DEFAULT_SIZE = {
  rectangle: { width: 50, height: 30 },
  rounded: { width: 50, height: 30 },
  ellipse: { width: 40, height: 40 },
  line: { width: 50, height: 2 },
  arrow: { width: 45, height: 12 },
  pill: { width: 50, height: 14 }
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback);

/** A complete, safe shape layer — or null if it is not one of the kinds. */
export function normalizeShapeLayer(raw) {
  if (!raw || typeof raw !== 'object' || !SHAPE_KINDS.includes(raw.kind)) return null;
  const kind = raw.kind;
  const start = Math.max(0, finite(raw.start, 0));
  const end = Math.max(start + MIN_SHAPE_DURATION, finite(raw.end, start + DEFAULT_SHAPE_DURATION));
  const size = DEFAULT_SIZE[kind];
  const t = raw.transform || {};
  const a = raw.appearance || {};
  const fill = { enabled: true, color: '#FFFFFF', ...(a.fill || {}) };
  const border = { enabled: false, width: 4, color: '#000000', ...(a.border || {}) };
  const shadow = { enabled: false, blur: 12, offsetX: 0, offsetY: 6, color: '#000000', opacity: 50, ...(a.shadow || {}) };
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId('shp'),
    kind,
    start,
    end,
    enabled: raw.enabled !== false,
    transform: {
      x: finite(t.x, 50),
      y: finite(t.y, 50),
      width: clamp(finite(t.width, size.width), 0.5, 400),
      height: clamp(finite(t.height, size.height), 0.2, 400),
      scale: clamp(finite(t.scale, 1), 0.05, 20),
      rotation: finite(t.rotation, 0),
      opacity: clamp(finite(t.opacity, 100), 0, 100)
    },
    appearance: {
      fill: { enabled: fill.enabled !== false, color: color(fill.color, '#FFFFFF') },
      border: { enabled: !!border.enabled, width: clamp(finite(border.width, 4), 0, 60), color: color(border.color, '#000000') },
      cornerRadius: clamp(finite(a.cornerRadius, kind === 'rounded' ? 20 : 0), 0, 50),
      shadow: {
        enabled: !!shadow.enabled,
        blur: clamp(finite(shadow.blur, 12), 0, 100),
        offsetX: clamp(finite(shadow.offsetX, 0), -200, 200),
        offsetY: clamp(finite(shadow.offsetY, 6), -200, 200),
        color: color(shadow.color, '#000000'),
        opacity: clamp(finite(shadow.opacity, 50), 0, 100)
      }
    },
    motions: normalizeMotionList(raw.motions)
  };
}

/** A list of shapes — from the array itself or its JSON string form. */
export function normalizeShapeLayerList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  return (Array.isArray(list) ? list : []).map(normalizeShapeLayer).filter(Boolean);
}

/** A new shape of a kind: a fresh id, its kind's starting size, centred. */
export function createShapeLayer({ kind = 'rectangle', start = 0, duration = DEFAULT_SHAPE_DURATION, ...rest } = {}) {
  return normalizeShapeLayer({ ...rest, id: createClipId('shp'), kind, start, end: start + duration });
}

export function isShapeLayerActive(shape, time) {
  return !!shape && shape.enabled !== false && time >= shape.start && time < shape.end;
}

export function getShapeLayerBoundaryTimes(shapes) {
  const times = [];
  (shapes || []).forEach((s) => { if (s.enabled !== false) times.push(s.start, s.end); });
  return times;
}

/** Where the shape's motions move it — what the exporter samples densely. */
export function shapeLayerMotionSpans(shape) {
  return motionActiveSpans(shape.motions, shape);
}

/** The shape AT REST on a canvas of this size, in canvas px (also the box the selection handles wrap). */
export function resolveShapeGeometry(shape, canvasWidth, canvasHeight) {
  const { transform } = shape;
  return {
    centerX: canvasWidth * (transform.x / 100),
    centerY: canvasHeight * (transform.y / 100),
    width: canvasWidth * (transform.width / 100) * transform.scale,
    height: canvasWidth * (transform.height / 100) * transform.scale,
    rotationDeg: transform.rotation,
    pxScale: canvasWidth / AUTHORED_FRAME_WIDTH
  };
}

/** The outline of a shape of this kind, filling [0, w] × [0, h]. */
function shapePath(ctx, kind, w, h, cornerRadiusPct) {
  ctx.beginPath();
  if (kind === 'ellipse') {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (kind === 'arrow') {
    // A shaft and a triangular head, both inside the box: the head as tall as
    // the box and at most 40% of its length; the shaft a third as thick.
    const head = Math.min(w * 0.4, h * 1.1);
    const shaft = h / 3;
    ctx.moveTo(0, (h - shaft) / 2);
    ctx.lineTo(w - head, (h - shaft) / 2);
    ctx.lineTo(w - head, 0);
    ctx.lineTo(w, h / 2);
    ctx.lineTo(w - head, h);
    ctx.lineTo(w - head, (h + shaft) / 2);
    ctx.lineTo(0, (h + shaft) / 2);
    ctx.closePath();
    return;
  }
  const r = kind === 'pill' || kind === 'line'
    ? Math.min(w, h) / 2
    : kind === 'rounded' ? (Math.min(w, h) * cornerRadiusPct) / 100 : 0;
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!radius) {
    ctx.rect(0, 0, w, h);
    return;
  }
  ctx.moveTo(radius, 0);
  ctx.lineTo(w - radius, 0);
  ctx.arcTo(w, 0, w, radius, radius);
  ctx.lineTo(w, h - radius);
  ctx.arcTo(w, h, w - radius, h, radius);
  ctx.lineTo(radius, h);
  ctx.arcTo(0, h, 0, h - radius, radius);
  ctx.lineTo(0, radius);
  ctx.arcTo(0, 0, radius, 0, radius);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Draws one shape layer at `time` onto `ctx` (a browser canvas or the
 * exporter's @napi-rs/canvas — only the shared 2D API). The shape is
 * composed on its own (fill, then the border inside its edge), then placed:
 * its resting transform with the motion delta on top, its shadow cast from
 * the composed shape. The same steps image layers take.
 *
 * @returns {object} The shape's resting geometry (see resolveShapeGeometry).
 */
export function drawShapeLayer(ctx, shape, { canvasWidth, canvasHeight, time, createOffscreenCanvas }) {
  const g = resolveShapeGeometry(shape, canvasWidth, canvasHeight);
  if (!createOffscreenCanvas || g.width < 0.5 || g.height < 0.2) return g;
  const motion = evaluateMotions(shape.motions, time, shape);
  const alpha = (shape.transform.opacity / 100) * motion.opacity;
  if (alpha <= 0) return g;

  const { appearance, kind } = shape;
  const off = createOffscreenCanvas(Math.max(1, Math.ceil(g.width)), Math.max(1, Math.ceil(g.height)));
  const o = off.getContext('2d');
  o.save();
  shapePath(o, kind, g.width, g.height, appearance.cornerRadius);
  o.clip();
  if (appearance.fill.enabled) {
    o.fillStyle = appearance.fill.color;
    o.fillRect(0, 0, g.width, g.height);
  }
  // Inside the edge: a stroke centred on the clipped outline, outer half clipped away.
  if (appearance.border.enabled && appearance.border.width > 0) {
    o.lineWidth = appearance.border.width * g.pxScale * shape.transform.scale * 2;
    o.strokeStyle = appearance.border.color;
    o.lineJoin = 'round';
    shapePath(o, kind, g.width, g.height, appearance.cornerRadius);
    o.stroke();
  }
  o.restore();

  const unit = Math.max(Math.min(g.width, g.height), canvasWidth / 40) * SHAPE_MOTION_UNIT;
  ctx.save();
  ctx.translate(g.centerX + motion.offsetX * unit, g.centerY + motion.offsetY * unit);
  const rotation = g.rotationDeg + motion.rotation;
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  if (motion.scale !== 1) ctx.scale(motion.scale, motion.scale);
  ctx.globalAlpha *= alpha;
  const { shadow } = appearance;
  if (shadow.enabled && shadow.opacity > 0) {
    ctx.shadowColor = hexToRgba(shadow.color, shadow.opacity / 100);
    ctx.shadowBlur = shadow.blur * g.pxScale;
    ctx.shadowOffsetX = shadow.offsetX * g.pxScale;
    ctx.shadowOffsetY = shadow.offsetY * g.pxScale;
  }
  ctx.drawImage(off, -g.width / 2, -g.height / 2);
  ctx.restore();
  return g;
}
