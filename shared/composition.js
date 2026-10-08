/**
 * THE COMPOSITION — the canvas every visual layer lives inside, and the
 * video's place in it. Shared by the preview (src/js/components/
 * compositionView.js) and the exporter (backend/utils/videoTransformFilter.js,
 * backend/utils/videoDecoration.js), so both size the canvas, place the video
 * and measure its decoration from the same numbers.
 *
 *   Composition
 *   ├── background         solid colour (the first background type)
 *   ├── the layer stack    video (always the bottom), images, shapes, text,
 *   │                      captions — see shared/visualLayers.js
 *   └── (audio)            untouched by any of this
 *
 * COORDINATES. Three spaces, never mixed:
 *   - COMPOSITION space: what the project stores. Positions are % of the
 *     canvas (videoTransform's offsetXPct/offsetYPct, every overlay's x/y),
 *     lengths are authored px against a 330px-wide canvas (AUTHORED_FRAME_WIDTH
 *     — the same convention shapes and images already use), so a value means
 *     the same thing at every resolution and in every aspect ratio.
 *   - SOURCE space: the uploaded video's own pixels. Only used to fit it.
 *   - SCREEN / EXPORT space: pixels. Derived from composition space by
 *     multiplying through `width` — the editor's frame width on screen, or the
 *     export's — and never stored.
 *
 * STORED vs RESOLVED. The project stores only `{ aspectRatio, background }`
 * (null for "never touched", which is every project made before V1.5). The
 * pixel size is RESOLVED from that and the source video's size — the logical
 * shape of the canvas and the resolution it is rendered at stay separate.
 * 'original' is the canvas the video itself defines — exactly what every
 * earlier version rendered — so an untouched project's export is unchanged.
 */

/** The width every authored length (border, shadow) is measured against — see shared/shapeLayer.js. */
export const AUTHORED_FRAME_WIDTH = 330;

/** The canvas shapes on offer. null = the source video's own shape. Add a ratio here and it is supported everywhere. */
export const ASPECT_RATIOS = {
  original: null,
  '9:16': [9, 16],
  '16:9': [16, 9],
  '1:1': [1, 1],
  '4:5': [4, 5],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '2:1': [2, 1],
  '2.35:1': [2.35, 1],
  '1.85:1': [1.85, 1]
};

export const ASPECT_RATIO_LABELS = Object.fromEntries(Object.keys(ASPECT_RATIOS).map((k) => [k, k === 'original' ? 'Original' : k]));

/** What each shape is for — the panel's tooltip. */
export const ASPECT_RATIO_HINTS = {
  original: 'The video’s own shape',
  '9:16': 'TikTok, Reels, Shorts',
  '16:9': 'YouTube, landscape',
  '1:1': 'Square — feed posts',
  '4:5': 'Instagram feed, portrait',
  '3:4': 'Portrait photo, Pinterest',
  '4:3': 'Classic landscape',
  '2:1': 'Wide — social and web',
  '2.35:1': 'Cinematic widescreen',
  '1.85:1': 'Film widescreen'
};

/** The background types that exist. Only 'solid' — gradient/image/blurred video would be added here, with their own fields. */
export const BACKGROUND_TYPES = ['solid'];

export const COMPOSITION_DEFAULTS = {
  aspectRatio: 'original',
  // Black: what the frame has always shown wherever the video doesn't reach.
  background: { type: 'solid', color: '#000000' }
};

export const VIDEO_STYLE_DEFAULTS = {
  /** % of the video's shorter side, like a shape's (0 = square corners, 50 = fully round). */
  cornerRadius: 0,
  /** Outside the video's edge, so it never covers the picture. Width in authored px. */
  border: { enabled: false, width: 4, color: '#FFFFFF', opacity: 100 },
  /** Cast by the video (and its border). Lengths in authored px. */
  shadow: { enabled: false, blur: 24, offsetX: 0, offsetY: 8, color: '#000000', opacity: 50 }
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback);

/** A JSON string (the FormData transport) or an object. */
function parsed(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export function normalizeComposition(raw) {
  const p = parsed(raw);
  const r = p && typeof p === 'object' ? p : {};
  const aspectRatio = Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, r.aspectRatio) ? r.aspectRatio : COMPOSITION_DEFAULTS.aspectRatio;
  const bg = r.background && typeof r.background === 'object' ? r.background : {};
  return {
    aspectRatio,
    background: {
      type: BACKGROUND_TYPES.includes(bg.type) ? bg.type : 'solid',
      color: color(bg.color, COMPOSITION_DEFAULTS.background.color)
    }
  };
}

export function normalizeVideoStyle(raw) {
  const p = parsed(raw);
  const r = p && typeof p === 'object' ? p : {};
  const b = { ...VIDEO_STYLE_DEFAULTS.border, ...(r.border || {}) };
  const s = { ...VIDEO_STYLE_DEFAULTS.shadow, ...(r.shadow || {}) };
  return {
    cornerRadius: clamp(finite(r.cornerRadius, 0), 0, 50),
    border: {
      enabled: !!b.enabled,
      width: clamp(finite(b.width, 4), 0, 60),
      color: color(b.color, VIDEO_STYLE_DEFAULTS.border.color),
      opacity: clamp(finite(b.opacity, 100), 0, 100)
    },
    shadow: {
      enabled: !!s.enabled,
      blur: clamp(finite(s.blur, 24), 0, 100),
      offsetX: clamp(finite(s.offsetX, 0), -200, 200),
      offsetY: clamp(finite(s.offsetY, 8), -200, 200),
      color: color(s.color, VIDEO_STYLE_DEFAULTS.shadow.color),
      opacity: clamp(finite(s.opacity, 50), 0, 100)
    }
  };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The composition in pixels, for a source video of `sourceWidth`×`sourceHeight`.
 * 'original' is the source's own size, untouched. A ratio keeps the source's
 * SHORTER side and extends the other — a 1080×1920 source gives 1080×1920 at
 * 9:16, 1920×1080 at 16:9 and 1080×1080 at 1:1 — so changing the shape never
 * upscales the footage's own detail away, and the sizes stay even (yuv420p).
 */
export function resolveComposition(raw, sourceWidth, sourceHeight) {
  const c = normalizeComposition(raw);
  const sw = sourceWidth > 0 ? sourceWidth : 1080;
  const sh = sourceHeight > 0 ? sourceHeight : 1920;
  const ratio = ASPECT_RATIOS[c.aspectRatio];
  let width = sw;
  let height = sh;
  if (ratio) {
    const short = Math.min(sw, sh);
    const [a, b] = ratio;
    if (a <= b) { width = even(short); height = even(short * b / a); }
    else { height = even(short); width = even(short * a / b); }
  }
  return { ...c, width, height };
}

/**
 * The video's RESTING box in the composition, before its own transform:
 * fitted whole (contain) and centred. Scale, position and rotation
 * (shared/videoTransform.js) apply on top of this, about its centre — a scale
 * of 1 is "the whole video, as large as fits".
 * @returns {{width:number, height:number}} in the composition's pixels
 */
export function videoBaseBox(composition, sourceWidth, sourceHeight) {
  const sw = sourceWidth > 0 ? sourceWidth : composition.width;
  const sh = sourceHeight > 0 ? sourceHeight : composition.height;
  const fit = Math.min(composition.width / sw, composition.height / sh);
  return { width: sw * fit, height: sh * fit };
}

/** True when the canvas is exactly the source frame and the video fills it — the composition then adds nothing to render. */
export function isPassthroughComposition(composition, sourceWidth, sourceHeight) {
  return composition.width === sourceWidth && composition.height === sourceHeight;
}

/** Whether the video carries any decoration at all (rounded corners, border, shadow). */
export function hasVideoDecoration(style) {
  const s = normalizeVideoStyle(style);
  return s.cornerRadius > 0
    || (s.border.enabled && s.border.width > 0 && s.border.opacity > 0)
    || (s.shadow.enabled && s.shadow.opacity > 0);
}

/**
 * The decoration in pixels, for a video box of `boxWidth`×`boxHeight` on a
 * canvas `canvasWidth` pixels wide. Used by the preview's CSS and the
 * exporter's drawing alike.
 *
 * Geometry follows CSS box-shadow, which is what the preview uses: the border
 * is a ring OUTSIDE the edge whose outer corners are rounded by radius +
 * width (square stays square); the shadow is cast by that outer shape, and is
 * never drawn inside it.
 */
export function videoDecorationMetrics(style, boxWidth, boxHeight, canvasWidth) {
  const s = normalizeVideoStyle(style);
  const px = canvasWidth / AUTHORED_FRAME_WIDTH;
  const radius = (Math.min(boxWidth, boxHeight) * s.cornerRadius) / 100;
  const borderWidth = s.border.enabled && s.border.opacity > 0 ? s.border.width * px : 0;
  const shadow = s.shadow.enabled && s.shadow.opacity > 0
    ? { blur: s.shadow.blur * px, offsetX: s.shadow.offsetX * px, offsetY: s.shadow.offsetY * px, color: s.shadow.color, opacity: s.shadow.opacity }
    : null;
  // Room around the box for everything drawn outside it: the ring, and the
  // shadow's offset plus its blur's reach (a Gaussian with sigma = blur / 2
  // is invisible past 3 sigma).
  const reach = shadow ? 1.5 * shadow.blur + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) : 0;
  const pad = borderWidth > 0 || shadow ? Math.ceil(borderWidth + reach) + 2 : 0;
  return {
    radius,
    borderWidth,
    border: { color: s.border.color, opacity: s.border.opacity },
    outerRadius: radius > 0 ? radius + borderWidth : 0,
    shadow,
    pad
  };
}

export function hexToRgba(hex, alpha) {
  const h = color(hex, '#000000');
  return `rgba(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}, ${alpha})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Draws the video's decoration for export, onto canvases the size of the
 * box plus `m.pad` on every side (the box sits at (pad, pad)):
 *   - 'under': the shadow, cleared where the bordered video will sit
 *   - 'mask':  the box's own size — white where the video shows, the
 *              rounded corners transparent
 *   - 'over':  the border ring
 */
export function drawVideoDecoration(ctx, part, m, boxWidth, boxHeight) {
  const x = m.pad;
  const y = m.pad;
  const b = m.borderWidth;
  if (part === 'mask') {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    roundRectPath(ctx, 0, 0, boxWidth, boxHeight, m.radius);
    ctx.fill();
    return;
  }
  if (part === 'under') {
    if (!m.shadow) return;
    ctx.save();
    ctx.shadowColor = hexToRgba(m.shadow.color, m.shadow.opacity / 100);
    ctx.shadowBlur = m.shadow.blur;
    ctx.shadowOffsetX = m.shadow.offsetX;
    ctx.shadowOffsetY = m.shadow.offsetY;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    roundRectPath(ctx, x - b, y - b, boxWidth + 2 * b, boxHeight + 2 * b, m.outerRadius);
    ctx.fill();
    ctx.restore();
    // A box-shadow is never drawn inside the box that casts it.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    roundRectPath(ctx, x - b, y - b, boxWidth + 2 * b, boxHeight + 2 * b, m.outerRadius);
    ctx.fill();
    ctx.restore();
    return;
  }
  if (part === 'over') {
    if (!(b > 0)) return;
    ctx.fillStyle = hexToRgba(m.border.color, m.border.opacity / 100);
    ctx.beginPath();
    roundRectPath(ctx, x - b, y - b, boxWidth + 2 * b, boxHeight + 2 * b, m.outerRadius);
    roundRectPath(ctx, x, y, boxWidth, boxHeight, m.radius);
    ctx.fill('evenodd');
  }
}
