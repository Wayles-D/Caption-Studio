/**
 * The DETECTION OVERLAY — an editing aid, nothing more. Boxes and labels for
 * the objects found in the frame on screen, drawn over the preview while the
 * Objects tool is open; click one to make it the selected object, click
 * empty space to let it go — or DRAG a box round anything (the detector
 * missed it, or it isn't a thing it knows) to select that.
 *
 * Editor-only DOM over the frame: the renderer, the canvases and the export
 * never see it. Every box goes through shared/objects/coordinates.js — video
 * space → the canvas (the video's resting box, scale, rotation, offset) —
 * and the clicks come back the same way, so what is drawn and what is hit
 * can never disagree, however the video is placed.
 */
import { appState, subscribe } from '../state.js';
import { videoBoxToComposition, videoToComposition, compositionToVideo, screenToComposition, detectionAtScreenPoint } from '../../../shared/objects/coordinates.js';
import { smoothSamples, trackSegments } from '../../../shared/objects/tracking.js';
import { getSelectedTrack, getTrackedStateAt } from './objectTracking.js';
import { getSelectedMaskAt, getSelectedSegmentation } from './objectSegmentation.js';
import { resolveVideoTransformAtTime } from '../../../shared/videoTransform.js';
import { getVideoBoxFraction } from './compositionView.js';
import { getDetectionsAt, getSelectedObject, selectObject, selectManualObject, clearSelectedObject, displayNames } from './objectDetection.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let root = null;
let svg = null;
// The selected object's SEGMENTATION mask (objectSegmentation.js), drawn
// under the boxes — an editing aid like everything here, never exported.
let maskCanvas = null;
let lastMaskSig = '';
let labels = null;
// The rectangle being dragged out to select anything (a manual object).
let drawBox = null;
const DRAG_START_PX = 6;
let lastSig = '';
let rafId = null;

/** Where the video sits in the canvas right now, for shared/objects/coordinates.js. */
export function currentPlacement(time) {
  const { width: fw, height: fh, comp } = getVideoBoxFraction();
  return {
    canvasWidth: comp.width,
    canvasHeight: comp.height,
    boxWidth: fw * comp.width,
    boxHeight: fh * comp.height,
    transform: resolveVideoTransformAtTime(appState.videoTransform, time)
  };
}

function build() {
  const surface = document.getElementById('state-video');
  if (!surface) return false;
  root = document.createElement('div');
  root.id = 'object-overlay';
  root.className = 'object-overlay';
  root.hidden = true;
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('object-overlay-boxes');
  labels = document.createElement('div');
  labels.className = 'object-overlay-labels';
  maskCanvas = document.createElement('canvas');
  maskCanvas.id = 'object-mask-canvas';
  maskCanvas.className = 'object-mask-canvas';
  root.appendChild(maskCanvas);
  root.appendChild(svg);
  root.appendChild(labels);
  surface.appendChild(root);
  drawBox = document.createElement('div');
  drawBox.id = 'object-draw-box';
  drawBox.className = 'object-draw-box';
  drawBox.hidden = true;
  root.appendChild(drawBox);
  // A CLICK picks a detected box (or lets go); a DRAG draws a box round
  // anything at all — what the detector missed included.
  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const video = document.getElementById('preview-video');
    if (video && !video.paused) video.pause();
    try { root.setPointerCapture(e.pointerId); } catch { /* not capturable: fine */ }
    drag = { x: e.clientX, y: e.clientY, moved: false, t: video?.currentTime ?? 0 };
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START_PX) return;
    drag.moved = true;
    const rect = root.getBoundingClientRect();
    const x0 = Math.min(drag.x, e.clientX) - rect.left;
    const y0 = Math.min(drag.y, e.clientY) - rect.top;
    drawBox.style.left = `${(x0 / rect.width) * 100}%`;
    drawBox.style.top = `${(y0 / rect.height) * 100}%`;
    drawBox.style.width = `${(Math.abs(e.clientX - drag.x) / rect.width) * 100}%`;
    drawBox.style.height = `${(Math.abs(e.clientY - drag.y) / rect.height) * 100}%`;
    drawBox.hidden = false;
  });
  const end = (e, cancelled) => {
    const d = drag;
    drag = null;
    drawBox.hidden = true;
    if (!d || cancelled) return;
    const rect = surface.getBoundingClientRect();
    const placement = currentPlacement(d.t);
    if (d.moved) {
      // The screen rectangle, taken back to VIDEO space (a rotated video makes
      // it a rotated quad there — its bounding box is what was meant).
      const corners = [[d.x, d.y], [e.clientX, d.y], [e.clientX, e.clientY], [d.x, e.clientY]]
        .map(([x, y]) => compositionToVideo(screenToComposition({ x, y }, rect), placement));
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
      selectManualObject(box, d.t);
      return;
    }
    const found = getDetectionsAt(d.t);
    if (!found) { clearSelectedObject(); return; }
    const hit = detectionAtScreenPoint(found.detections, { x: e.clientX, y: e.clientY }, rect, placement);
    if (hit) selectObject(hit);
    else clearSelectedObject();
  };
  root.addEventListener('pointerup', (e) => end(e, false));
  root.addEventListener('pointercancel', (e) => end(e, true));
  return true;
}

function render() {
  if (!root && !build()) return;
  const on = !!appState.objectsMode;
  if (root.hidden === on) root.hidden = !on;
  if (!on) return;
  const video = document.getElementById('preview-video');
  const t = video?.currentTime ?? 0;
  const found = video?.paused ? getDetectionsAt(t) : null;
  const sel = getSelectedObject();
  const placement = currentPlacement(t);
  // The selected object's TRACK, at any time — scrubbing or playing.
  const track = getSelectedTrack();
  const tracked = track ? getTrackedStateAt(t) : null;
  drawMask(t, placement);
  const sig = JSON.stringify([found?.time, found?.detections.map((d) => d.id), sel?.detectionId, sel?.manual && Math.abs(t - sel.timestamp) < 1 / 30, placement, track?.samples.length, track?.gaps?.length, tracked]);
  if (sig === lastSig) return;
  lastSig = sig;
  svg.replaceChildren();
  labels.replaceChildren();
  root.dataset.frameTime = found ? String(found.time) : '';
  root.dataset.trackedState = tracked ? tracked.state : '';
  if (track) drawTrack(track, tracked, placement, sel);
  // A drawn selection, not tracked yet: its box, on the frame it was drawn on.
  if (sel?.manual && !tracked && Math.abs(t - sel.timestamp) < 1 / 30) drawManual(sel, placement);
  if (!found) return;
  const names = displayNames(found.detections);
  // Largest first, so smaller boxes (a phone in a hand) draw on top.
  [...found.detections].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height).forEach((d) => {
    const corners = videoBoxToComposition(d.box, placement);
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', corners.map((c) => `${c.x},${c.y}`).join(' '));
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    poly.classList.add('object-box');
    if (sel?.detectionId === d.id) poly.classList.add('is-selected');
    poly.dataset.detectionId = d.id;
    svg.appendChild(poly);
    const tag = document.createElement('div');
    tag.className = `object-label${sel?.detectionId === d.id ? ' is-selected' : ''}`;
    tag.dataset.detectionId = d.id;
    tag.style.left = `${corners[0].x * 100}%`;
    tag.style.top = `${corners[0].y * 100}%`;
    tag.textContent = `${names.get(d.id)} ${Math.round(d.confidence * 100)}%`;
    labels.appendChild(tag);
  });
}

const MASK_RGB = [16, 233, 160];
let gridCanvas = null;

/**
 * The mask at `t`, in one of three views (appState.maskView): 'overlay' (the
 * object tinted), 'silhouette' (everything else dimmed — the object alone),
 * 'boundary' (its outline). The mask is in VIDEO space; it is placed exactly
 * as the boxes are (coordinates.js's videoToComposition — the video's box,
 * offset, scale, rotation), as one affine transform.
 */
function drawMask(t, placement) {
  const view = appState.maskView || 'overlay';
  const mask = view === 'off' ? null : getSelectedMaskAt(t);
  const rec = getSelectedSegmentation();
  const rect = root.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(rect.width * dpr));
  const ch = Math.max(1, Math.round(rect.height * dpr));
  const sig = JSON.stringify([view, rec?.key, mask && [mask.time, mask.frame, mask.confidence], placement, cw, ch]);
  if (sig === lastMaskSig) return;
  lastMaskSig = sig;
  root.dataset.maskView = view;
  root.dataset.maskLevel = mask ? mask.level : '';
  if (maskCanvas.width !== cw) maskCanvas.width = cw;
  if (maskCanvas.height !== ch) maskCanvas.height = ch;
  const ctx = maskCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, cw, ch);
  if (!mask) return;
  const { grid, alpha, frame } = mask;
  if (!gridCanvas) gridCanvas = document.createElement('canvas');
  gridCanvas.width = grid.width;
  gridCanvas.height = grid.height;
  const gc = gridCanvas.getContext('2d');
  const img = gc.createImageData(grid.width, grid.height);
  for (let i = 0; i < alpha.length; i++) {
    let a = alpha[i];
    if (view === 'boundary') {
      const x = i % grid.width;
      const inside = a >= 128;
      const edge = inside && ((x > 0 && alpha[i - 1] < 128) || (x < grid.width - 1 && alpha[i + 1] < 128) || (i >= grid.width && alpha[i - grid.width] < 128) || (i < alpha.length - grid.width && alpha[i + grid.width] < 128));
      a = edge ? 255 : 0;
    } else if (view === 'overlay') a = Math.round(a * 0.55);
    img.data[i * 4] = MASK_RGB[0]; img.data[i * 4 + 1] = MASK_RGB[1]; img.data[i * 4 + 2] = MASK_RGB[2]; img.data[i * 4 + 3] = a;
  }
  gc.putImageData(img, 0, 0);
  // Video space → this canvas: the placement is affine, so three points fix it.
  const o = videoToComposition({ x: 0, y: 0 }, placement);
  const ux = videoToComposition({ x: 1, y: 0 }, placement);
  const vy = videoToComposition({ x: 0, y: 1 }, placement);
  if (view === 'silhouette') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'destination-out';
  }
  ctx.setTransform((ux.x - o.x) * cw, (ux.y - o.y) * ch, (vy.x - o.x) * cw, (vy.y - o.y) * ch, o.x * cw, o.y * ch);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(gridCanvas, frame.x, frame.y, frame.width, frame.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

/** A box the user drew (objectDetection.js's selectManualObject), selected. */
function drawManual(sel, placement) {
  const corners = videoBoxToComposition(sel.box, placement);
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', corners.map((c) => `${c.x},${c.y}`).join(' '));
  poly.setAttribute('vector-effect', 'non-scaling-stroke');
  poly.classList.add('object-box', 'is-selected', 'is-manual');
  poly.id = 'object-manual-box';
  svg.appendChild(poly);
  const tag = document.createElement('div');
  tag.className = 'object-label is-selected';
  tag.id = 'object-manual-label';
  tag.style.left = `${corners[0].x * 100}%`;
  tag.style.top = `${corners[0].y * 100}%`;
  tag.textContent = `${sel.label} · drawn`;
  labels.appendChild(tag);
}

/** The track's path (faint, broken where it was lost and found again), and where the object is now (box + label). */
function drawTrack(track, tracked, placement, sel) {
  const smoothed = smoothSamples(track.samples, track.gaps);
  const at = new Map(track.samples.map((smp, i) => [smp, smoothed[i]]));
  const d = trackSegments(track).map((seg) => seg
    .map((smp) => at.get(smp).box)
    .map((b) => videoToComposition({ x: b.x + b.width / 2, y: b.y + b.height / 2 }, placement))
    .map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join(' ')).join(' ');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', d);
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  line.classList.add('object-trajectory');
  svg.appendChild(line);
  if (!tracked) return;
  const corners = videoBoxToComposition(tracked.box, placement);
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', corners.map((c) => `${c.x},${c.y}`).join(' '));
  poly.setAttribute('vector-effect', 'non-scaling-stroke');
  poly.classList.add('object-track-box');
  if (tracked.state === 'uncertain') poly.classList.add('is-uncertain');
  poly.id = 'object-track-box';
  svg.appendChild(poly);
  const tag = document.createElement('div');
  tag.className = `object-label object-track-label${tracked.state === 'uncertain' ? ' is-uncertain' : ''}`;
  tag.id = 'object-track-label';
  tag.style.left = `${corners[0].x * 100}%`;
  tag.style.top = `${corners[0].y * 100}%`;
  tag.textContent = `${sel?.label || track.label} · ${tracked.state === 'uncertain' ? 'uncertain' : `tracked ${Math.round(tracked.confidence * 100)}%`}`;
  labels.appendChild(tag);
}

export function initObjectOverlay() {
  const loop = () => {
    render();
    rafId = requestAnimationFrame(loop);
  };
  // Re-checked every frame only while the Objects tool is open — rebuilt
  // only when what it shows actually changes.
  const start = () => {
    if (appState.objectsMode && !rafId) loop();
    if (!appState.objectsMode && rafId) { cancelAnimationFrame(rafId); rafId = null; render(); }
  };
  subscribe('objectsMode', start);
  start();
}
