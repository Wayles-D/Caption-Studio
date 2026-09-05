/**
 * Direct on-canvas manipulation for the VIDEO target — drag to move, corner
 * handles to scale, the rotate handle to rotate — the video-target
 * counterpart to canvasTransform.js's existing caption/word/keyword/group
 * gestures. A separate, self-contained overlay (own hit-area/box/handles —
 * see src/components/PreviewStage.jsx's `video-transform-*` elements, which
 * reuse the SAME `.caption-transform-*` CSS classes for a consistent look)
 * rather than retrofitting canvasTransform.js's own drag machinery, which is
 * deeply tied to phrase/word/group semantics the video doesn't have — one
 * object, no fan-out, no scope.
 *
 * Every gesture here writes through videoTransform.js's setVideoValue(s) —
 * the SAME canonical appState.videoTransform + auto-keying path the timeline
 * panel's numeric inputs already use, so direct manipulation and precision
 * editing are just two different ways to write the one canonical transform
 * state (never a separate visual-only/CSS-only transform).
 */
import {
  isVideoTargetSelected,
  deselectVideoTarget,
  getCurrentVideoValue,
  setVideoValue,
  setVideoValues,
  applyVideoTransformToElement
} from './videoTransform.js';
import { resolveVideoTransformAtTime } from '../../../shared/videoTransform.js';
import { appState } from '../state.js';

let overlayEl, boxEl, hitAreaEl, rotateHandleEl;
let drag = null; // { kind: 'move'|'resize'|'rotate', startClientX, startClientY, start*, moved }
let rafId = null;

const MOVE_CLICK_THRESHOLD_PX = 4;

function getPhoneFrameRect() {
  const frame = document.querySelector('.phone-frame');
  return frame ? frame.getBoundingClientRect() : null;
}

/** Called once per render tick (see preview.js) — shows/hides the overlay and keeps the box's CSS transform in sync with the video's own, so the selection box always visually wraps the video exactly, at whatever time the playhead is at. */
export function updateVideoTransformOverlay(currentTime) {
  if (!overlayEl) return;
  const active = isVideoTargetSelected();
  overlayEl.classList.toggle('active', active);
  if (!active) return;

  const resolved = resolveVideoTransformAtTime(appState.videoTransform, currentTime);
  if (boxEl) {
    boxEl.hidden = false;
    boxEl.style.transform = `translate(${resolved.offsetXPct}%, ${resolved.offsetYPct}%) scale(${resolved.scale}) rotate(${resolved.rotation}deg)`;
  }
}

export function hideVideoTransformOverlay() {
  if (overlayEl) overlayEl.classList.remove('active');
  if (boxEl) boxEl.hidden = true;
}

function beginMove(e) {
  drag = {
    kind: 'move',
    startClientX: e.clientX,
    startClientY: e.clientY,
    startX: getCurrentVideoValue('positionX'),
    startY: getCurrentVideoValue('positionY'),
    moved: false
  };
  boxEl.setPointerCapture(e.pointerId);
}

function beginResize(e) {
  const rect = getPhoneFrameRect();
  if (!rect) return;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  drag = {
    kind: 'resize',
    startDist: Math.hypot(e.clientX - centerX, e.clientY - centerY) || 1,
    startScale: getCurrentVideoValue('scale'),
    moved: false
  };
  e.target.setPointerCapture(e.pointerId);
}

function beginRotate(e) {
  const rect = getPhoneFrameRect();
  if (!rect) return;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  drag = {
    kind: 'rotate',
    startAngle: (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI,
    startRotation: getCurrentVideoValue('rotation'),
    moved: false
  };
  e.target.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!drag) return;
  const rect = getPhoneFrameRect();
  if (!rect) return;

  if (drag.kind === 'move') {
    const deltaX = e.clientX - drag.startClientX;
    const deltaY = e.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < MOVE_CLICK_THRESHOLD_PX) return;
    drag.moved = true;
    // Plain pointer-delta-as-percentage-of-frame — deliberately not
    // de-rotated (matches canvasTransform.js's own caption move gesture,
    // which is equally simplified — see its onPointerMove doc comment).
    const xPct = drag.startX + (deltaX / rect.width) * 100;
    const yPct = drag.startY + (deltaY / rect.height) * 100;
    setVideoValues({ positionX: xPct, positionY: yPct }, { recordHistory: false });
  } else if (drag.kind === 'resize') {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dist = Math.hypot(e.clientX - centerX, e.clientY - centerY) || 1;
    if (!drag.moved && Math.abs(dist - drag.startDist) < MOVE_CLICK_THRESHOLD_PX) return;
    drag.moved = true;
    const ratio = dist / drag.startDist;
    const nextScale = Math.max(0.3, Math.min(3, drag.startScale * ratio));
    setVideoValue('scale', nextScale, { recordHistory: false });
  } else if (drag.kind === 'rotate') {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angleDeg = (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;
    drag.moved = true;
    const nextRotation = Math.round(drag.startRotation + (angleDeg - drag.startAngle));
    setVideoValue('rotation', nextRotation, { recordHistory: false });
  }
}

function endDrag() {
  if (!drag) return;
  const { kind, moved } = drag;
  drag = null;

  // A plain click (no real movement) on the move hit-area deselects the
  // video — matches "click empty space to deselect" convention, and is the
  // only way back to selecting a caption while the video overlay covers the
  // whole frame (see this module's own doc comment on why it's a SEPARATE
  // overlay from the caption one rather than sharing the same hit-area).
  if (kind === 'move' && !moved) {
    deselectVideoTarget();
    return;
  }
  if (!moved) return;

  // Re-commit the final value as one undo step (mirrors canvasTransform.js's
  // own begin/move/end-drag commit pattern) — the live values during the
  // drag were written with recordHistory:false.
  if (kind === 'move') {
    setVideoValues({ positionX: getCurrentVideoValue('positionX'), positionY: getCurrentVideoValue('positionY') }, { recordHistory: true });
  } else if (kind === 'resize') {
    setVideoValue('scale', getCurrentVideoValue('scale'), { recordHistory: true });
  } else if (kind === 'rotate') {
    setVideoValue('rotation', getCurrentVideoValue('rotation'), { recordHistory: true });
  }
}

export function initVideoCanvasControls() {
  overlayEl = document.getElementById('video-transform-overlay');
  boxEl = document.getElementById('video-transform-box');
  hitAreaEl = document.getElementById('video-transform-hit-area');
  rotateHandleEl = document.getElementById('video-transform-handle-rotate');
  if (!overlayEl || !boxEl || !hitAreaEl) return;

  // The move gesture is wired to boxEl, NOT hitAreaEl — once the box is
  // shown (always true whenever the video target is active) it visually
  // sits on top of and fully covers the hit-area beneath it, so a
  // hitAreaEl-only listener would never actually fire (confirmed: this was
  // a real bug during testing — drags silently did nothing). hitAreaEl
  // still exists for layout/CSS-class parity with the caption overlay this
  // one is modeled on, but has no listener of its own here since video
  // selection happens via the timeline's "Video" chip, not a canvas click.
  boxEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    beginMove(e);
  });

  boxEl.querySelectorAll('.caption-transform-handle[data-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginResize(e);
    });
  });

  if (rotateHandleEl) {
    rotateHandleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginRotate(e);
    });
  }

  const resetBtn = document.getElementById('btn-video-transform-reset');
  if (resetBtn) {
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', () => {
      setVideoValues({ positionX: 0, positionY: 0, scale: 1, rotation: 0 }, { recordHistory: true });
    });
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // A self-contained refresh loop (same pattern as timelinePanel.js's own
  // rAF loop), rather than relying solely on preview.js's syncVideoSubtitles
  // — that function's own re-render cadence is driven by caption playback
  // (timeupdate/the "while playing" rAF loop in preview.js), so it can go
  // silent for long stretches while the video is paused. Selecting the Video
  // target (or dragging it) while paused still needs the overlay box/the
  // video's own CSS transform to update immediately, not only on the next
  // caption-driven tick.
  const tick = () => {
    const video = document.getElementById('preview-video');
    const currentTime = video?.currentTime || 0;
    applyVideoTransformToElement(currentTime);
    updateVideoTransformOverlay(currentTime);
    rafId = requestAnimationFrame(tick);
  };
  if (rafId) cancelAnimationFrame(rafId);
  tick();

  return () => { if (rafId) cancelAnimationFrame(rafId); };
}
