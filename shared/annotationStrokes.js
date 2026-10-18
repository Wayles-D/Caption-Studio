/**
 * HAND-DRAWN ANNOTATIONS — a circle looped round something, a line underneath
 * it, an arrow pointing at it, each DRAWN ON over time as if by a marker.
 *
 *   ○ circle     a loop round the important part, ends crossing past each other
 *   ___ underline a stroke under a word, slightly uneven as a hand is
 *   ↗ arrow      a shaft that arrives, then its head
 *
 * These are SHAPE KINDS (shared/shapeLayer.js), so they inherit everything a
 * shape already has: a place in the layer stack, a span on the timeline,
 * motions, a transform, undo, saving, and one drawing function used by both
 * the preview and the export.
 *
 * WHY A POLYLINE, not a dashed path: the draw-on is "how much of the stroke
 * exists yet", and stroking the first N points of a polyline means exactly
 * that, identically in a browser canvas and in the exporter's. Canvas line
 * dashing is supported differently across the two and is not worth the risk
 * for something every frame depends on.
 *
 * WHY IT WOBBLES: a perfect ellipse reads as a computer drawing it. A real
 * marker overshoots, is never quite round, and does not close exactly where
 * it began. The wobble is pseudo-random but DETERMINISTIC from the shape's
 * own id, so the same annotation is the same shape every time it is drawn —
 * the preview and the export cannot disagree, and it does not shimmer from
 * frame to frame.
 */

export const ANNOTATION_KINDS = ['circle-annotation', 'underline-annotation', 'arrow-annotation'];
export const ANNOTATION_LABELS = {
  'circle-annotation': 'Circle (drawn)',
  'underline-annotation': 'Underline (drawn)',
  'arrow-annotation': 'Arrow (drawn)'
};
export const isAnnotationKind = (kind) => ANNOTATION_KINDS.includes(kind);

/** The default time a stroke takes to draw itself, in seconds. */
export const DEFAULT_DRAW_SECONDS = 0.45;

/**
 * WHICH WAY THE STROKE IS DRAWN. 'forward' is the natural hand: a circle
 * goes clockwise, a line and an arrow run left to right. 'reverse' is the
 * other way round — anticlockwise, or right to left.
 *
 * It changes the feel more than it sounds: a circle closing anticlockwise
 * reads as deliberate, and an underline struck right-to-left reads as a
 * correction. Which way the ends cross moves with it, because the overshoot
 * happens at the END of the stroke wherever that now is.
 */
export const DRAW_DIRECTIONS = ['forward', 'reverse'];
export const DRAW_DIRECTION_LABELS = {
  'circle-annotation': { forward: 'Clockwise', reverse: 'Anticlockwise' },
  'underline-annotation': { forward: 'Left to right', reverse: 'Right to left' },
  'arrow-annotation': { forward: 'Left to right', reverse: 'Right to left' }
};

/** A small deterministic generator — the same id always gives the same hand. */
function seeded(seed) {
  let s = 0;
  const text = String(seed || 'annotation');
  for (let i = 0; i < text.length; i++) s = (s * 31 + text.charCodeAt(i)) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The stroke as a list of points in the shape's own box (0,0 to w,h).
 *
 * @param {string} kind one of ANNOTATION_KINDS
 * @param {number} w box width in px
 * @param {number} h box height in px
 * @param {string} seed the shape's id
 * @returns {{points: {x:number, y:number}[], head: {x:number, y:number}[]|null}}
 *   `head` is drawn only once the shaft is complete (the arrow's tip).
 */
export function annotationStroke(kind, w, h, seed, direction = 'forward') {
  const rand = seeded(seed);
  const reverse = direction === 'reverse';
  const jitter = (amount) => (rand() - 0.5) * 2 * amount;

  if (kind === 'underline-annotation') {
    // A single sweep, sagging a little in the middle and not quite level.
    const points = [];
    const steps = 24;
    const sag = h * (0.18 + rand() * 0.14);
    const tilt = jitter(h * 0.12);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const arch = Math.sin(t * Math.PI) * sag;
      points.push({
        x: w * (0.02 + 0.96 * t) + jitter(w * 0.004),
        y: h * 0.5 + arch + tilt * (t - 0.5) * 2 + jitter(h * 0.05)
      });
    }
    return { points: reverse ? points.reverse() : points, head: null };
  }

  if (kind === 'arrow-annotation') {
    // A shaft that bows slightly, then a two-stroke head at its tip.
    const points = [];
    const steps = 20;
    const bow = jitter(h * 0.3);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      points.push({
        x: w * (0.03 + 0.9 * t) + jitter(w * 0.005),
        y: h * (0.85 - 0.7 * t) + Math.sin(t * Math.PI) * bow + jitter(h * 0.02)
      });
    }
    // Drawn backwards, the arrow still POINTS where it pointed — only the
    // order the ink lands in changes — so the head is built from the
    // geometric tip, then the shaft is reversed around it.
    const tip = points[points.length - 1];
    const back = points[Math.max(0, points.length - 4)];
    const angle = Math.atan2(tip.y - back.y, tip.x - back.x);
    const len = Math.min(w, h) * 0.3;
    const head = [
      { x: tip.x - len * Math.cos(angle - 0.5), y: tip.y - len * Math.sin(angle - 0.5) },
      { x: tip.x, y: tip.y },
      { x: tip.x - len * Math.cos(angle + 0.5), y: tip.y - len * Math.sin(angle + 0.5) }
    ];
    return { points: reverse ? points.reverse() : points, head };
  }

  // The circle: a little over one full turn, so the ends cross as a real
  // marker's do, with the radius breathing as a hand's does.
  const points = [];
  const steps = 72;
  const turns = 1.06 + rand() * 0.1;
  const from = -2.2 + jitter(0.4);
  const rx = (w / 2) * 0.96;
  const ry = (h / 2) * 0.96;
  const wobbleA = jitter(0.06);
  const wobbleB = jitter(0.05);
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = from + (reverse ? -1 : 1) * t * Math.PI * 2 * turns;
    // Two slow waves: the loop is never the same distance from its centre.
    const breathe = 1 + wobbleA * Math.sin(a * 2 + phase) + wobbleB * Math.sin(a * 3 - phase);
    points.push({
      x: w / 2 + Math.cos(a) * rx * breathe,
      y: h / 2 + Math.sin(a) * ry * breathe
    });
  }
  return { points, head: null };
}

/** How much of the stroke exists at `time`, 0 to 1. */
export function drawProgress(shape, time, drawSeconds = DEFAULT_DRAW_SECONDS) {
  const seconds = Math.max(0, drawSeconds);
  if (seconds <= 0) return 1;
  const since = time - shape.start;
  if (since <= 0) return 0;
  return Math.min(1, since / seconds);
}

/**
 * Strokes the first `progress` of a polyline, ending part way along the last
 * segment so the line GROWS smoothly rather than jumping point to point.
 */
export function strokePartialPolyline(ctx, points, progress) {
  if (points.length < 2 || progress <= 0) return;
  const total = points.length - 1;
  const exact = total * Math.min(1, progress);
  const whole = Math.floor(exact);
  const part = exact - whole;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i <= Math.min(whole, total); i++) ctx.lineTo(points[i].x, points[i].y);
  if (whole < total && part > 0) {
    const a = points[whole];
    const b = points[whole + 1];
    ctx.lineTo(a.x + (b.x - a.x) * part, a.y + (b.y - a.y) * part);
  }
  ctx.stroke();
}

/**
 * Draws a whole annotation: its stroke so far, and the arrow's head once the
 * shaft has arrived.
 */
export function drawAnnotation(ctx, { kind, width, height, seed, progress, colour, lineWidth, direction = 'forward' }) {
  const { points, head } = annotationStroke(kind, width, height, seed, direction);
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, lineWidth);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokePartialPolyline(ctx, points, progress);
  // The head is the last thing drawn, in its own short burst at the end.
  if (head && progress > 0.82) {
    strokePartialPolyline(ctx, head, Math.min(1, (progress - 0.82) / 0.18));
  }
  ctx.restore();
}
