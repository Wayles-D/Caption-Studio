/**
 * VIDEO ↔ COMPOSITION ↔ SCREEN — the only place a detection's position is
 * converted, so detection code never touches pixels and the overlay and
 * hit-testing can never disagree.
 *
 *   VIDEO        fractions of the upright video frame (where detections live)
 *   COMPOSITION  fractions of the canvas (shared/composition.js)
 *   SCREEN       CSS pixels, given the frame's on-screen rect
 *
 * The video sits in the canvas exactly as the renderer places it: fitted
 * into its resting box (videoBaseBox), scaled and rotated about its centre,
 * its centre moved by the transform's offsets (% of the canvas) — the same
 * maths the preview's CSS and the exporter's filter chain apply.
 */

/**
 * @typedef {object} Placement
 * @property {number} canvasWidth   composition px (any consistent unit)
 * @property {number} canvasHeight
 * @property {number} boxWidth      the video's resting box, same units
 * @property {number} boxHeight
 * @property {{offsetXPct:number, offsetYPct:number, scale:number, rotation:number}} transform
 */

export function videoToComposition(pt, p) {
  const t = p.transform || {};
  const s = t.scale ?? 1;
  const a = ((t.rotation ?? 0) * Math.PI) / 180;
  const dx = (pt.x - 0.5) * p.boxWidth * s;
  const dy = (pt.y - 0.5) * p.boxHeight * s;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  const cx = p.canvasWidth / 2 + ((t.offsetXPct ?? 0) / 100) * p.canvasWidth;
  const cy = p.canvasHeight / 2 + ((t.offsetYPct ?? 0) / 100) * p.canvasHeight;
  return { x: (cx + rx) / p.canvasWidth, y: (cy + ry) / p.canvasHeight };
}

export function compositionToVideo(pt, p) {
  const t = p.transform || {};
  const s = t.scale ?? 1;
  const a = ((t.rotation ?? 0) * Math.PI) / 180;
  const cx = p.canvasWidth / 2 + ((t.offsetXPct ?? 0) / 100) * p.canvasWidth;
  const cy = p.canvasHeight / 2 + ((t.offsetYPct ?? 0) / 100) * p.canvasHeight;
  const rx = pt.x * p.canvasWidth - cx;
  const ry = pt.y * p.canvasHeight - cy;
  const dx = rx * Math.cos(-a) - ry * Math.sin(-a);
  const dy = rx * Math.sin(-a) + ry * Math.cos(-a);
  return { x: dx / (p.boxWidth * s) + 0.5, y: dy / (p.boxHeight * s) + 0.5 };
}

/** A video-space box → its four corners on the canvas (a rotated video gives a rotated box), clockwise from top-left. */
export function videoBoxToComposition(box, p) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ].map((c) => videoToComposition(c, p));
}

export function compositionToScreen(pt, rect) {
  return { x: rect.left + pt.x * rect.width, y: rect.top + pt.y * rect.height };
}

export function screenToComposition(pt, rect) {
  return { x: (pt.x - rect.left) / rect.width, y: (pt.y - rect.top) / rect.height };
}

/** Whether a video-space point lies in a video-space box. */
export function boxContains(box, pt) {
  return pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height;
}

/**
 * The detection under a screen point: the screen point taken back to VIDEO
 * space, then the smallest containing box wins (a phone held in front of a
 * person is the phone). Off the video entirely: none.
 */
export function detectionAtScreenPoint(detections, screenPt, rect, p) {
  const v = compositionToVideo(screenToComposition(screenPt, rect), p);
  if (v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) return null;
  const hits = detections.filter((d) => boxContains(d.box, v));
  hits.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
  return hits[0] || null;
}
