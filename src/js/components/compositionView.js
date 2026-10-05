/**
 * THE COMPOSITION in the editor (shared/composition.js): sizes the frame to
 * the canvas's shape, paints its background, and places the <video> inside it
 * — its resting box, its transform (shared/videoTransform.js), its rounded
 * corners, border and shadow.
 *
 * The frame (.phone-frame's content box) IS the composition on screen: every
 * overlay canvas and every pointer conversion already measures it (see
 * src/js/utils/canvasGeometry.js), and every stored position is a fraction
 * of it. So nothing here is stored — the project holds composition-space
 * values, and this turns them into CSS pixels for the frame's current size.
 */
import { appState, subscribe } from '../state.js';
import {
  resolveComposition,
  videoBaseBox,
  videoDecorationMetrics,
  hasVideoDecoration,
  hexToRgba
} from '../../../shared/composition.js';
import { resolveVideoTransformAtTime } from '../../../shared/videoTransform.js';

function getVideo() {
  return document.getElementById('preview-video');
}

/** The source video's own size, or null before its metadata has loaded. */
export function getSourceSize() {
  const v = getVideo();
  return v?.videoWidth > 0 && v?.videoHeight > 0 ? { width: v.videoWidth, height: v.videoHeight } : null;
}

/** The composition in pixels — the source's own size until there is a source to measure. */
export function getComposition() {
  const src = getSourceSize();
  return resolveComposition(appState.composition, src?.width, src?.height);
}

/** The video's resting box, as fractions of the composition (0-1). */
export function getVideoBoxFraction() {
  const comp = getComposition();
  const src = getSourceSize();
  const box = videoBaseBox(comp, src?.width, src?.height);
  return { width: box.width / comp.width, height: box.height / comp.height, comp };
}

// --- The frame --------------------------------------------------------------

/** The largest the frame is drawn when there is room: 586px tall for a portrait canvas, as it always was. */
const NATURAL_LONG_SIDE = 586;
let lastFrameKey = '';

/**
 * Sizes .phone-frame so its CONTENT box has exactly the composition's shape,
 * as large as fits the workspace (never past the natural 586px height of a
 * vertical canvas). Its border is added outside, so the drawing surface is
 * the true shape — not one 4px off it.
 */
export function fitFrame() {
  const frame = document.querySelector('.phone-frame');
  const area = frame?.parentElement?.parentElement; // <main>, the workspace
  if (!frame || !area) return;
  const comp = getComposition();
  const cs = getComputedStyle(area);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const availH = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  // The workspace runs UNDER the side panels (fixed, on top of it), and the
  // frame is centred in the whole workspace — so its width is what fits
  // between its centre and the nearer panel, on both sides. A portrait frame
  // never reached them; a wide one does.
  const ar = area.getBoundingClientRect();
  const centre = ar.left + ar.width / 2;
  let visibleLeft = ar.left;
  let visibleRight = ar.right;
  for (const id of ['desktop-side-panel', 'sound-library-panel']) {
    const r = document.getElementById(id)?.getBoundingClientRect();
    if (!r || r.width === 0 || r.bottom <= ar.top || r.top >= ar.bottom) continue;
    if (r.left > centre) visibleRight = Math.min(visibleRight, r.left);
    else if (r.right < centre) visibleLeft = Math.max(visibleLeft, r.right);
  }
  const availW = 2 * Math.min(centre - visibleLeft, visibleRight - centre) - padX;
  const border = parseFloat(getComputedStyle(frame).borderTopWidth) || 0;
  const maxW = Math.max(40, availW - 2 * border);
  const maxH = Math.max(40, Math.min(availH, NATURAL_LONG_SIDE) - 2 * border);
  const aspect = comp.width / comp.height;
  let h = maxH;
  let w = h * aspect;
  if (w > maxW) { w = maxW; h = w / aspect; }
  // Whole CSS pixels: a fractional frame makes every overlay canvas's
  // backing store resample by a hair, softening text. The shape stays true
  // to within half a pixel.
  w = Math.round(w);
  h = Math.round(h);
  const key = `${w.toFixed(2)}x${h.toFixed(2)}+${border}`;
  if (key === lastFrameKey) return;
  lastFrameKey = key;
  frame.style.width = `${w + 2 * border}px`;
  frame.style.height = `${h + 2 * border}px`;
  frame.style.aspectRatio = 'auto';
  frame.style.maxWidth = 'none';
  frame.style.maxHeight = 'none';
  // Everything sized off the frame (the overlay canvases, the selection
  // boxes) re-measures on resize; this listener's own refit is then a no-op.
  window.dispatchEvent(new Event('resize'));
}

// --- The video inside it ----------------------------------------------------

let lastVideoCss = '';

/**
 * Places the video for `currentTime`: its resting box (fitted whole, centred),
 * its transform on top (position as a fraction of the CANVAS, as the exporter
 * reads it), and its decoration. Called every render tick; writes to the DOM
 * only when something actually changed.
 */
let lastFitAt = 0;

export function applyVideoPlacement(currentTime) {
  // Panels open and close without resizing the workspace, so the frame is
  // re-fitted on a slow beat as well as on resize (a no-op when nothing moved).
  const now = performance.now();
  if (now - lastFitAt > 250) { lastFitAt = now; fitFrame(); }
  const video = getVideo();
  const surface = document.getElementById('state-video');
  if (!video || !surface) return;
  const { width: fw, height: fh, comp } = getVideoBoxFraction();
  const t = resolveVideoTransformAtTime(appState.videoTransform, currentTime);
  const identity = t.offsetXPct === 0 && t.offsetYPct === 0 && t.scale === 1 && t.rotation === 0 && t.opacity === 100;
  const fills = Math.abs(fw - 1) < 1e-6 && Math.abs(fh - 1) < 1e-6;
  const decorated = hasVideoDecoration(appState.videoStyle);

  // CSS translate percentages are of the element's OWN box; the stored
  // offsets are of the canvas — converted by the box's share of the canvas.
  const transform = identity ? '' : `translate(${(t.offsetXPct / fw).toFixed(4)}%, ${(t.offsetYPct / fh).toFixed(4)}%) scale(${t.scale}) rotate(${t.rotation}deg)`;
  let radius = '';
  let shadow = '';
  if (decorated) {
    const frameW = surface.clientWidth || 1;
    const boxW = fw * frameW;
    const boxH = fh * (surface.clientHeight || 1);
    const m = videoDecorationMetrics(appState.videoStyle, boxW, boxH, frameW);
    radius = m.radius > 0 ? `${m.radius.toFixed(2)}px` : '';
    const layers = [];
    if (m.borderWidth > 0) layers.push(`0 0 0 ${m.borderWidth.toFixed(2)}px ${hexToRgba(m.border.color, m.border.opacity / 100)}`);
    if (m.shadow) layers.push(`${m.shadow.offsetX.toFixed(2)}px ${m.shadow.offsetY.toFixed(2)}px ${m.shadow.blur.toFixed(2)}px ${m.borderWidth.toFixed(2)}px ${hexToRgba(m.shadow.color, m.shadow.opacity / 100)}`);
    shadow = layers.join(', ');
  }
  const bg = comp.background.color;
  const key = [fw, fh, transform, t.opacity, radius, shadow, bg, fills].join('|');
  if (key === lastVideoCss) return;
  lastVideoCss = key;

  // The common case — a canvas the video fills, nothing on it: the element is
  // left exactly as it always was (CSS-sized to the frame, no inline style).
  if (fills) {
    video.style.position = '';
    video.style.left = '';
    video.style.top = '';
    video.style.width = '';
    video.style.height = '';
    video.style.objectFit = '';
  } else {
    video.style.position = 'absolute';
    video.style.left = `${((1 - fw) / 2) * 100}%`;
    video.style.top = `${((1 - fh) / 2) * 100}%`;
    video.style.width = `${fw * 100}%`;
    video.style.height = `${fh * 100}%`;
    // The box already has the video's own shape, so nothing is cropped.
    video.style.objectFit = 'fill';
  }
  video.style.transform = transform;
  video.style.opacity = t.opacity === 100 ? '' : String(t.opacity / 100);
  video.style.borderRadius = radius;
  video.style.boxShadow = shadow;
  surface.style.background = bg === '#000000' ? '' : bg;
}

let started = false;

export function initCompositionView() {
  if (started) return;
  started = true;
  const refit = () => { fitFrame(); lastVideoCss = ''; };
  const area = document.querySelector('.phone-frame')?.parentElement?.parentElement;
  if (area && typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(area);
  window.addEventListener('resize', refit);
  subscribe('composition', () => { refit(); window.dispatchEvent(new Event('resize')); });
  // A new source can change the canvas ('original' is the source's shape).
  document.addEventListener('loadedmetadata', (e) => {
    if (e.target?.id === 'preview-video') { refit(); window.dispatchEvent(new Event('resize')); }
  }, true);
  refit();
}
