/**
 * The DETECTION OVERLAY — an editing aid, nothing more. Boxes and labels for
 * the objects found in the frame on screen, drawn over the preview while the
 * Objects tool is open; click one to make it the selected object, click
 * empty space to let it go.
 *
 * Editor-only DOM over the frame: the renderer, the canvases and the export
 * never see it. Every box goes through shared/objects/coordinates.js — video
 * space → the canvas (the video's resting box, scale, rotation, offset) —
 * and the clicks come back the same way, so what is drawn and what is hit
 * can never disagree, however the video is placed.
 */
import { appState, subscribe } from '../state.js';
import { videoBoxToComposition, videoToComposition, detectionAtScreenPoint } from '../../../shared/objects/coordinates.js';
import { smoothSamples, trackSegments } from '../../../shared/objects/tracking.js';
import { getSelectedTrack, getTrackedStateAt } from './objectTracking.js';
import { resolveVideoTransformAtTime } from '../../../shared/videoTransform.js';
import { getVideoBoxFraction } from './compositionView.js';
import { getDetectionsAt, getSelectedObject, selectObject, clearSelectedObject, displayNames } from './objectDetection.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let root = null;
let svg = null;
let labels = null;
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
  root.appendChild(svg);
  root.appendChild(labels);
  surface.appendChild(root);
  root.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const t = document.getElementById('preview-video')?.currentTime ?? 0;
    const found = getDetectionsAt(t);
    if (!found) return;
    const rect = surface.getBoundingClientRect();
    const hit = detectionAtScreenPoint(found.detections, { x: e.clientX, y: e.clientY }, rect, currentPlacement(t));
    if (hit) selectObject(hit);
    else clearSelectedObject();
  });
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
  const sig = JSON.stringify([found?.time, found?.detections.map((d) => d.id), sel?.detectionId, placement, track?.samples.length, track?.gaps?.length, tracked]);
  if (sig === lastSig) return;
  lastSig = sig;
  svg.replaceChildren();
  labels.replaceChildren();
  root.dataset.frameTime = found ? String(found.time) : '';
  root.dataset.trackedState = tracked ? tracked.state : '';
  if (track) drawTrack(track, tracked, placement, sel);
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
