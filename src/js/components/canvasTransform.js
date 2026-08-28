/**
 * On-canvas caption transform controls (CapCut-style move/resize/rotate).
 *
 * Editor-only UI, layered above the graphics-renderer <canvas> (see
 * shared/captionGraphics.js) — it never draws into the exported video.
 * Position is expressed as customPosX/customPosY percentages (the SAME
 * fields initManualDragPositioning in preview.js already writes for manual
 * drag positioning), "resize" is expressed as the existing `fontSize` style
 * property (uniform scale, not per-axis stretch — matches the architecture's
 * existing single size knob rather than inventing a parallel scale field),
 * and "rotate" is the new `rotation` degrees field (see shared/
 * captionGraphics.js's resolveGeometry). Reusing these three existing fields
 * is what lets the SAME graphics renderer draw the transformed result in
 * both preview and export with zero extra plumbing beyond what
 * shared/captionTransform.js's resolvePhraseParams already does.
 *
 * Every frame, preview.js calls updateCanvasTransformOverlay(box, phrase,
 * mode) with the just-measured bounding box (shared/captionGraphics.js's
 * measureSentenceFrame/measureRollingStackFrame) — the box IS the coordinate
 * conversion: it's reported in the canvas's own backing-store pixel space,
 * and box.pxScale (== canvasWidth/cssPixelWidth, the same ratio
 * resolveGeometry computes) converts it to the phone-frame's on-screen CSS
 * px this module positions its DOM handles in. No separate coordinate system
 * is invented here.
 */
import { appState, updateState } from '../state.js';
import { getPhraseTransformKey } from '../../../shared/captionTransform.js';

let overlayEl, hitAreaEl, boxEl, rotateHandleEl, scopeThisBtn, scopeAllBtn, resetBtn, rotationLabelEl;
let selected = false;
let currentBox = null; // { x, y, width, height, centerX, centerY, rotationDeg, pxScale, phrase, mode } in canvas backing-store px

let drag = null; // { kind: 'move'|'resize'|'rotate', pointerId, ... }

function effectiveValue(phrase, field, globalValue) {
  if (!phrase) return globalValue;
  const key = getPhraseTransformKey(phrase);
  const override = appState.captionTransforms[key];
  return override && override[field] != null ? override[field] : globalValue;
}

/**
 * Writes one or more transform fields, honoring the current This/All scope.
 * "This Caption" writes into appState.captionTransforms[phraseKey] (an
 * immutable copy — appState objects are never mutated in place, so undo/
 * redo snapshots taken by reference stay correct); "All Captions" writes
 * the same field names directly onto global style state — the exact fields
 * every phrase already falls back to when it has no override, so no
 * special-casing is needed anywhere else.
 */
function applyTransformFields(fields, { recordHistory, phrase }) {
  const targetPhrase = phrase || currentBox?.phrase;
  if (!currentBox && !targetPhrase) return;
  if (appState.transformApplyScope === 'this' && targetPhrase) {
    const key = getPhraseTransformKey(targetPhrase);
    const existing = appState.captionTransforms[key] || {};
    const nextMap = { ...appState.captionTransforms, [key]: { ...existing, ...fields } };
    updateState({ captionTransforms: nextMap }, { recordHistory });
  } else {
    // customPosX/Y only take effect when position === 'manual' (see
    // getCSSPreviewFromConfig/getASSStyleFromConfig) — a global move-drag
    // switches it on automatically, the same way "This Caption" scope's
    // resolvePhraseParams forces it for a per-phrase override, so a move
    // gesture always visibly moves the caption regardless of the position
    // dropdown's current setting.
    const globalFields = 'customPosX' in fields || 'customPosY' in fields
      ? { ...fields, position: 'manual' }
      : fields;
    updateState(globalFields, { recordHistory });
  }
}

function resetCurrentTransform() {
  if (!currentBox) return;
  if (appState.transformApplyScope === 'this' && currentBox.phrase) {
    const key = getPhraseTransformKey(currentBox.phrase);
    if (!(key in appState.captionTransforms)) return;
    const nextMap = { ...appState.captionTransforms };
    delete nextMap[key];
    updateState({ captionTransforms: nextMap }, { recordHistory: true });
  } else {
    updateState({ customPosX: 50, customPosY: 85, rotation: 0, fontSize: 14 }, { recordHistory: true });
  }
}

function pointInRotatedBox(px, py, box) {
  const rad = (-(box.rotationDeg || 0) * Math.PI) / 180;
  const dx = px - box.centerX;
  const dy = py - box.centerY;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(localX) <= box.width / 2 + 4 && Math.abs(localY) <= box.height / 2 + 4;
}

function getPhoneFrame() {
  return document.querySelector('.phone-frame');
}

function positionBoxElement() {
  if (!boxEl || !currentBox) return;
  const scale = currentBox.pxScale || 1;
  const cssX = currentBox.x / scale;
  const cssY = currentBox.y / scale;
  const cssW = currentBox.width / scale;
  const cssH = currentBox.height / scale;

  boxEl.style.left = `${cssX}px`;
  boxEl.style.top = `${cssY}px`;
  boxEl.style.width = `${cssW}px`;
  boxEl.style.height = `${cssH}px`;
  boxEl.style.transform = currentBox.rotationDeg ? `rotate(${currentBox.rotationDeg}deg)` : '';
  boxEl.style.transformOrigin = 'center center';
  if (rotationLabelEl) rotationLabelEl.textContent = `${Math.round(currentBox.rotationDeg || 0)}°`;
}

function updateScopeButtons() {
  if (scopeThisBtn) scopeThisBtn.classList.toggle('active', appState.transformApplyScope === 'this');
  if (scopeAllBtn) scopeAllBtn.classList.toggle('active', appState.transformApplyScope !== 'this');
}

/**
 * Called once per rendered frame from preview.js's syncVideoSubtitles, right
 * after the graphics renderer draws (or skips) a frame.
 *
 * @param {object|null} box - measureSentenceFrame/measureRollingStackFrame's result, or null if nothing is on screen right now.
 * @param {object} phrase - The active phrase this box belongs to.
 * @param {'sentence'|'rolling-stack'} mode
 */
export function updateCanvasTransformOverlay(box, phrase, mode) {
  if (!overlayEl) return;

  if (!box) {
    hideCanvasTransformOverlay();
    return;
  }

  currentBox = { ...box, phrase, mode };
  overlayEl.classList.add('active');

  if (selected && !drag) {
    boxEl.hidden = false;
    positionBoxElement();
    updateScopeButtons();
  } else if (!drag) {
    boxEl.hidden = true;
  }
}

/**
 * Hides the overlay entirely — called whenever the current frame has no
 * graphics-rendered caption on screen (nothing to select/transform), so
 * stale handles never linger over a demo caption, Word Mode, or a
 * still-CSS-rendered preset/mode.
 */
export function hideCanvasTransformOverlay() {
  currentBox = null;
  if (overlayEl) overlayEl.classList.remove('active');
  if (boxEl) boxEl.hidden = true;
}

function clientToCssPoint(clientX, clientY) {
  const rect = getPhoneFrame().getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top, rect };
}

function beginMove(e) {
  if (!currentBox) return;
  // Pin the phrase this gesture targets at drag-start — currentBox.phrase is
  // reassigned every render tick (see updateCanvasTransformOverlay) to
  // whatever phrase is on screen AT THE CURRENT PLAYBACK TIME, so without
  // pinning it, a drag that happens to straddle a phrase boundary (video
  // still playing) could silently retarget mid-gesture onto the NEXT
  // caption's override instead of the one the user actually grabbed.
  drag = { kind: 'move', pointerId: e.pointerId, phrase: currentBox.phrase };
  hitAreaEl.setPointerCapture(e.pointerId);
}

function beginResize(e, corner) {
  if (!currentBox) return;
  const { x, y, rect } = clientToCssPoint(e.clientX, e.clientY);
  const scale = currentBox.pxScale || 1;
  const centerX = currentBox.centerX / scale;
  const centerY = currentBox.centerY / scale;
  const startDist = Math.hypot(x - centerX, y - centerY) || 1;
  const startFontSize = effectiveValue(currentBox.phrase, 'fontSize', appState.fontSize);
  drag = { kind: 'resize', pointerId: e.pointerId, startDist, startFontSize, corner, phrase: currentBox.phrase };
  e.target.setPointerCapture(e.pointerId);
}

function beginRotate(e) {
  if (!currentBox) return;
  drag = { kind: 'rotate', pointerId: e.pointerId, phrase: currentBox.phrase };
  e.target.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!drag || !currentBox) return;
  const { x, y } = clientToCssPoint(e.clientX, e.clientY);
  const scale = currentBox.pxScale || 1;
  const centerX = currentBox.centerX / scale;
  const centerY = currentBox.centerY / scale;

  if (drag.kind === 'move') {
    const { rect } = clientToCssPoint(e.clientX, e.clientY);
    const xPct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const yPct = Math.max(0, Math.min(100, (y / rect.height) * 100));
    applyTransformFields({ customPosX: xPct, customPosY: yPct }, { recordHistory: false, phrase: drag.phrase });
  } else if (drag.kind === 'resize') {
    const dist = Math.hypot(x - centerX, y - centerY) || 1;
    const ratio = dist / drag.startDist;
    const nextFontSize = Math.max(6, Math.min(150, Math.round(drag.startFontSize * ratio)));
    applyTransformFields({ fontSize: nextFontSize }, { recordHistory: false, phrase: drag.phrase });
  } else if (drag.kind === 'rotate') {
    const angleDeg = (Math.atan2(y - centerY, x - centerX) * 180) / Math.PI;
    const rotationDeg = Math.round(angleDeg + 90);
    applyTransformFields({ rotation: rotationDeg }, { recordHistory: false, phrase: drag.phrase });
  }
}

function endDrag() {
  if (!drag) return;
  const kind = drag.kind;
  const phrase = drag.phrase;
  drag = null;
  // Commit the whole gesture as one undo step, mirroring
  // initManualDragPositioning's own drag-then-commit pattern. Re-reads the
  // value through effectiveValue (scope-aware: captionTransforms override
  // for "This Caption", global appState field for "All Captions") rather
  // than always appState.customPosX/Y — reading the raw global unconditionally
  // was a real bug: for "This Caption" the actual just-set value lives in
  // captionTransforms[key], not the (untouched) global field, so this commit
  // step was silently overwriting the drag's own result with a stale global
  // value the instant the pointer was released.
  if (kind === 'move') {
    applyTransformFields({
      customPosX: effectiveValue(phrase, 'customPosX', appState.customPosX),
      customPosY: effectiveValue(phrase, 'customPosY', appState.customPosY)
    }, { recordHistory: true, phrase });
  } else if (kind === 'resize') {
    applyTransformFields({ fontSize: effectiveValue(phrase, 'fontSize', appState.fontSize) }, { recordHistory: true, phrase });
  } else if (kind === 'rotate') {
    applyTransformFields({ rotation: effectiveValue(phrase, 'rotation', appState.rotation) }, { recordHistory: true, phrase });
  }
}

export function initCanvasTransform() {
  overlayEl = document.getElementById('caption-transform-overlay');
  hitAreaEl = document.getElementById('caption-transform-hit-area');
  boxEl = document.getElementById('caption-transform-box');
  rotateHandleEl = document.getElementById('caption-transform-handle-rotate');
  scopeThisBtn = document.getElementById('btn-transform-scope-this');
  scopeAllBtn = document.getElementById('btn-transform-scope-all');
  resetBtn = document.getElementById('btn-transform-reset');
  rotationLabelEl = document.getElementById('caption-transform-rotation-label');
  if (!overlayEl || !hitAreaEl || !boxEl) return;

  updateScopeButtons();

  hitAreaEl.addEventListener('pointerdown', (e) => {
    if (!currentBox) return;
    const { x, y } = clientToCssPoint(e.clientX, e.clientY);
    const scale = currentBox.pxScale || 1;
    const boxCss = {
      centerX: currentBox.centerX / scale,
      centerY: currentBox.centerY / scale,
      width: currentBox.width / scale,
      height: currentBox.height / scale,
      rotationDeg: currentBox.rotationDeg
    };
    if (pointInRotatedBox(x, y, boxCss)) {
      selected = true;
      boxEl.hidden = false;
      positionBoxElement();
      updateScopeButtons();
      // Start moving on THIS SAME press instead of only selecting — a real
      // press-hold-drag-release gesture on a not-yet-selected caption used to
      // just select it and go nowhere (the user would have had to release
      // and press a second time, now landing on the newly-visible box, to
      // actually move it). This is what made drag-to-move look broken.
      beginMove(e);
    } else {
      selected = false;
      boxEl.hidden = true;
    }
  });

  boxEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.caption-transform-handle') || e.target.closest('.caption-transform-toolbar')) return;
    beginMove(e);
  });

  boxEl.querySelectorAll('.caption-transform-handle[data-handle]').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginResize(e, handle.dataset.handle);
    });
  });

  if (rotateHandleEl) {
    rotateHandleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginRotate(e);
    });
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selected) {
      selected = false;
      boxEl.hidden = true;
    }
  });

  if (scopeThisBtn) {
    scopeThisBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeThisBtn.addEventListener('click', () => {
      updateState({ transformApplyScope: 'this' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (scopeAllBtn) {
    scopeAllBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    scopeAllBtn.addEventListener('click', () => {
      updateState({ transformApplyScope: 'all' }, { recordHistory: false });
      updateScopeButtons();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', resetCurrentTransform);
  }
}
