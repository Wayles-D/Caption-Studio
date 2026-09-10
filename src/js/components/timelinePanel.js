/**
 * THE timeline — the primary keyframe editing surface (see this app's
 * keyframe architecture: shared/keyframes.js for the engine,
 * src/js/components/keyframeEngine.js for the generic target dispatcher
 * this module is the sole UI consumer of). A real editor timeline: a
 * persistent "Video" target chip, the current canvas selection's label, a
 * ruler + playhead synced to the SAME #preview-video element every other
 * part of the app already treats as the source of time, and four property
 * lanes (Position/Scale/Rotation/Opacity) showing real, manipulable ◆
 * markers — click to seek, drag to retime, Delete to remove.
 *
 * DOM-driven (not React) for the same reason preview.js/canvasTransform.js
 * already are: a live drag/scrub loop fights React reconciliation for no
 * benefit. Mounted once from src/components/TimelinePanel.jsx into a fixed
 * container; rebuilds its own children imperatively.
 */
import * as keyframeEngine from './keyframeEngine.js';
import { undo, redo, getHistoryState } from '../state.js';

const LANES = [
  { key: 'position', label: 'Position', properties: [
    { property: 'positionX', fieldLabel: 'X' },
    { property: 'positionY', fieldLabel: 'Y' }
  ] },
  { key: 'scale', label: 'Scale', properties: [{ property: 'scale', fieldLabel: '' }] },
  { key: 'rotation', label: 'Rotation', properties: [{ property: 'rotation', fieldLabel: '' }] },
  { key: 'opacity', label: 'Opacity', properties: [{ property: 'opacity', fieldLabel: '' }] }
];

// Numeric range/unit per property, by target-kind FAMILY — position is the
// only axis whose real-world unit differs (word: relative px offset; caption
// and video: percentage of the frame) — see shared/keyframes.js's own
// field-name mapping table for why.
const RANGE_BY_FAMILY = {
  word: {
    positionX: { min: -400, max: 400, step: 1, unit: 'px' }, positionY: { min: -400, max: 400, step: 1, unit: 'px' },
    scale: { min: 0.3, max: 3, step: 0.05, unit: 'x' }, rotation: { min: -180, max: 180, step: 1, unit: '°' },
    opacity: { min: 0, max: 100, step: 1, unit: '%' }
  },
  caption: {
    positionX: { min: 0, max: 100, step: 0.5, unit: '%' }, positionY: { min: 0, max: 100, step: 0.5, unit: '%' },
    scale: { min: 0.3, max: 3, step: 0.05, unit: 'x' }, rotation: { min: -180, max: 180, step: 1, unit: '°' },
    opacity: { min: 0, max: 100, step: 1, unit: '%' }
  },
  video: {
    positionX: { min: -100, max: 100, step: 0.5, unit: '%' }, positionY: { min: -100, max: 100, step: 0.5, unit: '%' },
    scale: { min: 0.3, max: 3, step: 0.05, unit: 'x' }, rotation: { min: -180, max: 180, step: 1, unit: '°' },
    opacity: { min: 0, max: 100, step: 1, unit: '%' }
  }
};

function familyFor(kind) {
  if (kind === 'video') return 'video';
  if (kind === 'caption') return 'caption';
  return 'word'; // word | keyword | group
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

function formatValue(value, property) {
  if (property === 'scale') return (Math.round(value * 100) / 100).toFixed(2);
  return String(Math.round(value * 10) / 10);
}

let els = null;
let laneEls = {}; // key -> { track, inputs: { property: inputEl } }
let activeOptions = null; // see initTimelinePanel's options param
let rafId = null;
let dragMarker = null; // { fromTime }
let selectedMarkerTime = null;
let advancedExpanded = false;

/** Shows/hides every precision numeric field per the current advancedExpanded state — a pure display toggle, never touches appState. */
function applyAdvancedState() {
  if (els?.advancedBtn) els.advancedBtn.classList.toggle('active', advancedExpanded);
  document.querySelectorAll('.timeline-precision-field').forEach((el) => {
    el.style.display = advancedExpanded ? '' : 'none';
  });
}

let lastPrecisionTarget = undefined; // the external container currently holding the precision groups, or null when they live inline
let lastPlaybackTarget = undefined; // the external container currently holding playbackRow, or null when it lives in the timeline's own header

/**
 * Moves the WHOLE playback row (Play/Undo/Redo — see buildDom's
 * playbackRow) either into `target` (a React-owned bar rendered directly
 * above the timeline, mobile/tablet only — see App.jsx) or back into this
 * timeline's own header (`target` is null/undefined, desktop's single-row
 * layout). Reparents the exact same buttons/listeners rather than building
 * a second copy, same pattern as relocatePrecisionFields above.
 */
function relocatePlaybackRow(target) {
  if (target === lastPlaybackTarget) return;
  lastPlaybackTarget = target;

  if (target) {
    target.appendChild(els.playbackRow);
  } else if (els.header) {
    els.header.insertBefore(els.playbackRow, els.header.firstChild);
  }
}

/**
 * Moves every lane's precision-field group either into `target` (a React-
 * owned container element, grouped under a small per-lane heading so the
 * fields still make sense out of context) or back into their own lane's
 * inline gutter (`target` is null/undefined) — the desktop Advanced side
 * panel and mobile/tablet's inline Advanced toggle are two DISPLAY
 * LOCATIONS for the exact same input elements, not two separate UIs kept
 * in sync, so there's nothing to duplicate or drift.
 */
function relocatePrecisionFields(target) {
  if (target === lastPrecisionTarget) return;
  lastPrecisionTarget = target;

  LANES.forEach((lane) => {
    const { gutter, precisionGroup, label } = laneEls[lane.key];
    const existingHeader = precisionGroup.querySelector(':scope > .timeline-advanced-group-header');

    if (target) {
      if (!existingHeader) {
        const header = document.createElement('div');
        header.className = 'timeline-advanced-group-header';
        header.textContent = label;
        precisionGroup.insertBefore(header, precisionGroup.firstChild);
      }
      precisionGroup.classList.add('timeline-precision-group--panel');
      target.appendChild(precisionGroup);
      // Independent of advancedExpanded (which stays false — mobile's own
      // toggle — the whole time the panel owns these fields) since the
      // panel's own open/closed state is what gates whether this function
      // is even called with a non-null target at all.
      precisionGroup.querySelectorAll('.timeline-precision-field').forEach((el) => { el.style.display = ''; });
    } else {
      if (existingHeader) existingHeader.remove();
      precisionGroup.classList.remove('timeline-precision-group--panel');
      gutter.appendChild(precisionGroup);
      applyAdvancedState(); // restore mobile/tablet's own inline hidden/shown state
    }
  });
}

function getVideo() {
  return document.getElementById('preview-video');
}

function buildDom(container, options) {
  container.innerHTML = '';
  container.classList.add('timeline-panel');

  const header = document.createElement('div');
  header.className = 'timeline-header';

  // Split into two row groups — on desktop these sit side by side (one
  // visual row, exactly like before); on mobile/tablet they stack, with
  // playback controls in their own compact row directly above the busier
  // controls row instead of everything overflowing/wrapping in one packed
  // line. The stacking itself isn't CSS — relocatePlaybackRow() physically
  // moves `playbackRow`'s DOM node out of this header into App.jsx's
  // mobilePlaybackRowRef container on mobile/tablet (see its own doc
  // comment and the isDesktop check in tick() below).
  const playbackRow = document.createElement('div');
  playbackRow.className = 'timeline-header-row timeline-header-row--playback';

  const controlsRow = document.createElement('div');
  controlsRow.className = 'timeline-header-row timeline-header-row--controls';

  // Play/Pause — the only playback trigger left in the app since the
  // floating preview-bar (play/seek/download) was removed in favor of this
  // timeline handling both scrubbing (the ruler/playhead below) and now
  // play/pause too. Toggles the SAME #preview-video element the ruler
  // scrubs and canvasTransform/preview.js already treat as the single
  // source of playback truth.
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'timeline-play-btn';
  playBtn.id = 'timeline-play-btn';
  playBtn.setAttribute('aria-label', 'Play/Pause');
  playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon id="timeline-play-icon-poly" points="5,3 19,12 5,21" /></svg>';
  playBtn.addEventListener('click', () => {
    const video = getVideo();
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  playbackRow.appendChild(playBtn);

  // Undo/Redo — moved here (off the top nav) since they're history controls
  // for the same keyframe/style edits this timeline is the primary editing
  // surface for. canUndo/canRedo have no reactive event of their own to
  // subscribe to beyond the 'history' pub/sub React used to use
  // (see Toolbar.jsx's history) — polling getHistoryState() once per tick()
  // is simpler here and matches every other piece of live state (playhead,
  // target label, disabled inputs) this file already refreshes that way.
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'timeline-history-btn';
  undoBtn.id = 'timeline-undo-btn';
  undoBtn.title = 'Undo (Ctrl+Z)';
  undoBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6" /><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" /></svg>';
  undoBtn.addEventListener('click', () => undo());
  playbackRow.appendChild(undoBtn);

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'timeline-history-btn';
  redoBtn.id = 'timeline-redo-btn';
  redoBtn.title = 'Redo (Ctrl+Y)';
  redoBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" /></svg>';
  redoBtn.addEventListener('click', () => redo());
  playbackRow.appendChild(redoBtn);

  header.appendChild(playbackRow);

  // Only meaningful on desktop where both rows sit inline (separates the
  // playback cluster from the target/keyframe cluster) — hidden by the same
  // mobile media query that stacks the two rows, since a vertical divider
  // between two stacked rows has nothing to visually separate.
  const historyDivider = document.createElement('div');
  historyDivider.className = 'timeline-header-divider';
  header.appendChild(historyDivider);

  const videoChip = document.createElement('button');
  videoChip.type = 'button';
  videoChip.className = 'timeline-target-chip';
  videoChip.id = 'timeline-video-chip';
  videoChip.textContent = '🎬 Video';
  videoChip.title = 'Select the video itself as a keyframe target';
  videoChip.addEventListener('click', () => keyframeEngine.selectVideoTarget());
  controlsRow.appendChild(videoChip);

  const targetLabel = document.createElement('span');
  targetLabel.className = 'timeline-target-label';
  targetLabel.id = 'timeline-target-label';
  controlsRow.appendChild(targetLabel);

  // Mobile/tablet-only stand-in for targetLabel above (see style.css: one or
  // the other is display:none depending on viewport) — the full sentence
  // ("Select a caption/word or the Video chip to begin", or a long target
  // label) doesn't fit next to Keyframe/Advanced/time on a phone width, so
  // it collapses into this small info icon; click or hover reveals the same
  // text in a popover instead of it just being cut off or forcing wrap.
  const targetInfo = document.createElement('div');
  targetInfo.className = 'timeline-target-info';
  const targetInfoBtn = document.createElement('button');
  targetInfoBtn.type = 'button';
  targetInfoBtn.className = 'timeline-target-info-btn';
  targetInfoBtn.setAttribute('aria-label', 'Current selection');
  targetInfoBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="7.5" r="1.3" fill="currentColor" stroke="none" /></svg>';
  const targetTooltip = document.createElement('div');
  targetTooltip.className = 'timeline-target-tooltip';
  targetTooltip.id = 'timeline-target-tooltip';
  targetInfoBtn.addEventListener('click', () => targetInfo.classList.toggle('open'));
  targetInfo.appendChild(targetInfoBtn);
  targetInfo.appendChild(targetTooltip);
  controlsRow.appendChild(targetInfo);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'timeline-add-keyframe-btn';
  addBtn.id = 'timeline-add-keyframe-btn';
  addBtn.innerHTML = '◆ Keyframe';
  addBtn.addEventListener('click', () => keyframeEngine.addOrUpdateKeyframeAtPlayhead());
  controlsRow.appendChild(addBtn);

  // Precision (X/Y/scale%/rotation°) numeric fields: shown inline (hidden by
  // default) on mobile/tablet, the same as always — the primary way to set
  // these values is direct manipulation on the canvas (drag/resize/rotate —
  // see videoCanvasControls.js and the existing canvasTransform.js
  // gestures), this toggle just reveals them for anyone who wants to type
  // an exact value. On desktop (per options.isDesktopGetter), there's room
  // for a real side panel instead, so the click routes to React's
  // onAdvancedToggle and relocatePrecisionFields (driven from tick(), see
  // below) moves these exact fields there instead of toggling them inline.
  const advancedBtn = document.createElement('button');
  advancedBtn.type = 'button';
  advancedBtn.className = 'timeline-advanced-toggle';
  advancedBtn.id = 'timeline-advanced-toggle';
  advancedBtn.textContent = 'Advanced';
  advancedBtn.title = 'Show precise numeric values (position/scale/rotation)';
  advancedBtn.addEventListener('click', () => {
    if (options?.isDesktopGetter?.()) {
      options.onAdvancedToggle?.();
      return;
    }
    advancedExpanded = !advancedExpanded;
    applyAdvancedState();
  });
  controlsRow.appendChild(advancedBtn);

  const timeReadout = document.createElement('span');
  timeReadout.className = 'timeline-time-readout';
  timeReadout.id = 'timeline-time-readout';
  controlsRow.appendChild(timeReadout);

  header.appendChild(controlsRow);

  container.appendChild(header);

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  scroll.id = 'timeline-scroll';

  const rulerRow = document.createElement('div');
  rulerRow.className = 'timeline-ruler-row';
  const rulerGutter = document.createElement('div');
  rulerGutter.className = 'timeline-ruler-gutter';
  const ruler = document.createElement('div');
  ruler.className = 'timeline-ruler';
  ruler.id = 'timeline-ruler';
  rulerRow.appendChild(rulerGutter);
  rulerRow.appendChild(ruler);
  scroll.appendChild(rulerRow);

  const lanesEl = document.createElement('div');
  lanesEl.id = 'timeline-lanes';
  laneEls = {};

  LANES.forEach((lane) => {
    const row = document.createElement('div');
    row.className = 'timeline-lane';
    row.dataset.lane = lane.key;

    const gutter = document.createElement('div');
    gutter.className = 'timeline-lane-gutter';
    const label = document.createElement('span');
    label.className = 'timeline-lane-label';
    label.textContent = lane.label;
    gutter.appendChild(label);

    // Precision fields live in this dedicated group (not appended directly
    // into `gutter`) so relocatePrecisionFields() can move the WHOLE group
    // — same input elements, same listeners, same `inputs` map entries —
    // between here (inline, mobile/tablet's Advanced toggle) and the
    // desktop Advanced side panel, rather than needing two separate sets of
    // inputs kept in sync with each other.
    const precisionGroup = document.createElement('div');
    precisionGroup.className = 'timeline-precision-group';

    const inputs = {};
    lane.properties.forEach(({ property, fieldLabel }) => {
      if (fieldLabel) {
        const miniLabel = document.createElement('span');
        miniLabel.className = 'timeline-precision-field';
        miniLabel.style.fontSize = '9px';
        miniLabel.style.color = 'var(--text-muted)';
        miniLabel.textContent = fieldLabel;
        precisionGroup.appendChild(miniLabel);
      }
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'timeline-lane-input timeline-precision-field';
      input.dataset.property = property;
      // A number input can fire a spurious extra 'change' on blur (e.g. the
      // browser re-committing the same value when focus moves to a marker
      // being clicked elsewhere on the timeline) — without this guard that
      // re-fire would call setValue() a second time, but now at WHATEVER
      // the playhead happens to be at that later moment (often no longer
      // the time the user actually intended), silently corrupting an
      // unrelated keyframe. Only real value changes reach setValue().
      input.dataset.lastCommitted = '';
      input.addEventListener('change', () => {
        const raw = input.value;
        if (raw === input.dataset.lastCommitted) return;
        const value = parseFloat(raw);
        if (!Number.isFinite(value)) return;
        input.dataset.lastCommitted = raw;
        keyframeEngine.setValue(property, value);
      });
      precisionGroup.appendChild(input);
      inputs[property] = input;
    });
    gutter.appendChild(precisionGroup);

    const track = document.createElement('div');
    track.className = 'timeline-lane-track';

    row.appendChild(gutter);
    row.appendChild(track);
    lanesEl.appendChild(row);

    laneEls[lane.key] = { track, inputs, gutter, precisionGroup, label: lane.label };
  });

  scroll.appendChild(lanesEl);

  // Single playhead line, absolutely positioned within `scroll` (spans the
  // ruler + every lane below it — one shared coordinate space).
  const playhead = document.createElement('div');
  playhead.className = 'timeline-playhead';
  playhead.id = 'timeline-playhead';
  scroll.appendChild(playhead);

  container.appendChild(scroll);

  return { header, playbackRow, playBtn, undoBtn, redoBtn, videoChip, targetLabel, targetTooltip, addBtn, advancedBtn, timeReadout, ruler, scroll, playhead };
}

function timeToX(time, trackWidth, duration) {
  if (!duration || duration <= 0) return 0;
  return Math.max(0, Math.min(trackWidth, (time / duration) * trackWidth));
}

function xToTime(x, trackWidth, duration) {
  if (!duration || trackWidth <= 0) return 0;
  return Math.max(0, Math.min(duration, (x / trackWidth) * duration));
}

let lastTickDuration = -1;

function refreshRulerTicks(duration) {
  if (duration === lastTickDuration) return;
  lastTickDuration = duration;
  els.ruler.querySelectorAll('.timeline-ruler-tick').forEach((el) => el.remove());
  if (!duration || duration <= 0) return;

  // Aim for roughly 6-10 visible ticks regardless of clip length.
  const rawStep = duration / 8;
  const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = niceSteps.find((s) => s >= rawStep) || niceSteps[niceSteps.length - 1];

  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement('div');
    tick.className = 'timeline-ruler-tick';
    tick.style.left = `${(t / duration) * 100}%`;
    tick.textContent = formatTime(t);
    els.ruler.appendChild(tick);
  }
}

function refreshPlayhead(currentTime, duration) {
  const rulerRect = els.ruler.getBoundingClientRect();
  const scrollRect = els.scroll.getBoundingClientRect();
  if (!rulerRect.width) return;
  const x = timeToX(currentTime, rulerRect.width, duration);
  const left = (rulerRect.left - scrollRect.left) + els.scroll.scrollLeft + x;
  els.playhead.style.left = `${left}px`;
}

function clearMarkers(track) {
  track.querySelectorAll('.timeline-marker').forEach((el) => el.remove());
}

function buildMarker(entry, laneProperties, trackWidth, duration) {
  const marker = document.createElement('div');
  marker.className = 'timeline-marker';
  const hasAnyValue = laneProperties.some(({ property }) => entry.values && entry.values[property] != null);
  if (hasAnyValue) marker.classList.add('filled');
  if (selectedMarkerTime != null && Math.abs(entry.t - selectedMarkerTime) <= 0.03) marker.classList.add('selected');
  marker.style.left = `${(entry.t / duration) * 100}%`;
  marker.dataset.time = String(entry.t);
  marker.title = `Keyframe @ ${entry.t.toFixed(2)}s — click to jump, drag to retime, Delete to remove`;
  marker.tabIndex = 0;

  // A plain click and the start of a drag both begin with the same
  // pointerdown — they're only distinguished by whether the pointer has
  // moved past a small pixel threshold before release. Getting this wrong
  // (treating every click as a micro-drag) used to silently nudge a
  // keyframe's time by a few hundredths of a second on every single click,
  // and — combined with rebuilding markers every animation frame — made
  // clicking/selecting/deleting a marker unreliable. `moved` tracks real
  // pixel movement; `moveKeyframeAt` only fires when it crosses the
  // threshold, so a plain click is a pure no-op on the DATA (selection +
  // seek only, via the `click` listener below).
  const DRAG_THRESHOLD_PX = 3;
  marker.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    marker.setPointerCapture(e.pointerId);
    dragMarker = { fromTime: entry.t, trackEl: marker.parentElement, startClientX: e.clientX, moved: false };
  });
  marker.addEventListener('pointermove', (e) => {
    if (!dragMarker || dragMarker.trackEl !== marker.parentElement) return;
    if (!dragMarker.moved && Math.abs(e.clientX - dragMarker.startClientX) < DRAG_THRESHOLD_PX) return;
    dragMarker.moved = true;
    const rect = marker.parentElement.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    marker.style.left = `${(x / rect.width) * 100}%`;
  });
  marker.addEventListener('pointerup', (e) => {
    if (!dragMarker) return;
    if (dragMarker.moved) {
      const rect = marker.parentElement.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const newTime = xToTime(x, rect.width, getVideo()?.duration || 0);
      keyframeEngine.moveKeyframeAt(dragMarker.fromTime, newTime);
      selectedMarkerTime = newTime;
    }
    dragMarker = null;
  });
  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    const video = getVideo();
    if (video) video.currentTime = entry.t;
    selectedMarkerTime = entry.t;
  });
  marker.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      keyframeEngine.deleteKeyframeAt(entry.t);
      selectedMarkerTime = null;
    }
  });

  return marker;
}

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedMarkerTime != null && document.activeElement?.tagName !== 'INPUT') {
    keyframeEngine.deleteKeyframeAt(selectedMarkerTime);
    selectedMarkerTime = null;
  }
});

// Signature of "what markers should exist right now" (entry times + values +
// which marker is selected) — rebuilding the marker DOM on EVERY animation
// frame (this function used to) meant a marker element could be destroyed
// and replaced mid-click/mid-focus, making it impossible to reliably click,
// focus, drag, or Delete one (confirmed: it made Playwright's own click
// retry forever with "element was detached from the DOM"). Markers are now
// only rebuilt when the underlying keyframe DATA (or the selection
// highlight) actually changes, and never while a marker is being dragged —
// scrubbing the playhead alone never touches this signature, so it doesn't
// disturb an in-progress interaction either.
let lastLaneSignature = null;

function refreshLanes(duration) {
  const entries = keyframeEngine.getKeyframeEntries();
  const signature = JSON.stringify({ entries, selected: selectedMarkerTime, duration });

  if (signature !== lastLaneSignature && !dragMarker) {
    lastLaneSignature = signature;
    LANES.forEach((lane) => {
      const { track } = laneEls[lane.key];
      clearMarkers(track);
      const rect = track.getBoundingClientRect();
      entries.forEach((entry) => {
        const relevant = lane.properties.some(({ property }) => entry.values && entry.values[property] != null);
        if (!relevant) return;
        track.appendChild(buildMarker(entry, lane.properties, rect.width, duration));
      });
    });
  }

  LANES.forEach((lane) => {
    const { inputs } = laneEls[lane.key];
    lane.properties.forEach(({ property }) => {
      const input = inputs[property];
      if (document.activeElement === input) return;
      const value = keyframeEngine.getCurrentValue(property);
      const formatted = formatValue(value, property);
      input.value = formatted;
      // Keep in sync with whatever's actually displayed — see this input's
      // 'change' listener for why (guards against a spurious re-fired
      // 'change' on blur writing a stale value back into the wrong keyframe).
      input.dataset.lastCommitted = formatted;
    });
  });
}

function refreshRangesForTarget(kind) {
  const family = RANGE_BY_FAMILY[familyFor(kind)];
  LANES.forEach((lane) => {
    const { inputs } = laneEls[lane.key];
    lane.properties.forEach(({ property }) => {
      const range = family[property];
      const input = inputs[property];
      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(range.step);
      input.title = `${property} (${range.unit})`;
    });
  });
}

let lastTargetKind = undefined;
let lastPaused = undefined;

function tick() {
  const video = getVideo();
  const duration = video?.duration || 0;
  const currentTime = video?.currentTime || 0;

  refreshRulerTicks(duration);
  refreshPlayhead(currentTime, duration);
  if (els.timeReadout) els.timeReadout.textContent = formatTime(currentTime);

  const paused = video?.paused ?? true;
  if (paused !== lastPaused) {
    lastPaused = paused;
    const poly = els.playBtn?.querySelector('#timeline-play-icon-poly');
    if (poly) {
      poly.setAttribute(
        'points',
        paused ? '5,3 19,12 5,21' : '5,3 9,3 9,21 5,21 15,3 19,3 19,21 15,21'
      );
    }
  }

  const { canUndo, canRedo } = getHistoryState();
  if (els.undoBtn) els.undoBtn.disabled = !canUndo;
  if (els.redoBtn) els.redoBtn.disabled = !canRedo;

  // Desktop Advanced side panel vs. mobile/tablet's inline toggle — see
  // relocatePrecisionFields()'s own doc comment. Re-evaluated every tick
  // (cheap: relocatePrecisionFields no-ops unless the target actually
  // changed) so this also self-corrects if the viewport crosses the
  // desktop breakpoint while the panel happens to be open.
  const isDesktop = activeOptions?.isDesktopGetter?.() ?? false;
  const advancedContainer = isDesktop ? activeOptions?.getAdvancedContainer?.() : null;
  const advancedOpen = isDesktop ? (activeOptions?.isAdvancedOpenGetter?.() ?? false) : false;
  relocatePrecisionFields(advancedOpen ? advancedContainer : null);
  if (els.advancedBtn) {
    els.advancedBtn.classList.toggle('active', isDesktop ? advancedOpen : advancedExpanded);
  }

  // Play/Undo/Redo sit in a separate bar directly above the timeline on
  // mobile/tablet instead of inside this header (too many controls to fit
  // in one row at that width) — see relocatePlaybackRow()'s own doc
  // comment. Desktop keeps them inline in the header, unchanged.
  const playbackContainer = isDesktop ? null : (activeOptions?.getPlaybackRowContainer?.() ?? null);
  relocatePlaybackRow(playbackContainer);

  const target = keyframeEngine.getActiveTarget();
  const targetKind = target?.kind ?? null;
  if (targetKind !== lastTargetKind) {
    lastTargetKind = targetKind;
    selectedMarkerTime = null;
    if (targetKind) refreshRangesForTarget(targetKind);
  }

  if (els.videoChip) els.videoChip.classList.toggle('active', keyframeEngine.isVideoTargetSelected());
  const targetText = target ? target.label : 'Select a caption/word or the Video chip to begin';
  if (els.targetLabel) els.targetLabel.textContent = targetText;
  if (els.targetTooltip) els.targetTooltip.textContent = targetText;

  const hasTarget = !!target;
  if (els.addBtn) {
    els.addBtn.disabled = !hasTarget;
    els.addBtn.classList.toggle('active', hasTarget && keyframeEngine.hasKeyframeAtPlayhead());
  }
  LANES.forEach((lane) => {
    const { inputs } = laneEls[lane.key];
    lane.properties.forEach(({ property }) => { inputs[property].disabled = !hasTarget; });
  });

  if (hasTarget && duration > 0) {
    refreshLanes(duration);
  } else {
    LANES.forEach((lane) => clearMarkers(laneEls[lane.key].track));
  }

  rafId = requestAnimationFrame(tick);
}

export function initTimelinePanel(container, options = {}) {
  if (!container) return () => {};
  activeOptions = options;
  els = buildDom(container, options);
  advancedExpanded = false;
  lastPrecisionTarget = undefined;
  lastPlaybackTarget = undefined;
  applyAdvancedState();

  const scrub = (clientX) => {
    const video = getVideo();
    const duration = video?.duration || 0;
    if (!video || duration <= 0) return;
    const rect = els.ruler.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    video.currentTime = xToTime(x, rect.width, duration);
  };

  let scrubbing = false;
  els.ruler.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    els.ruler.setPointerCapture(e.pointerId);
    scrub(e.clientX);
  });
  els.ruler.addEventListener('pointermove', (e) => { if (scrubbing) scrub(e.clientX); });
  els.ruler.addEventListener('pointerup', () => { scrubbing = false; });

  els.scroll.addEventListener('pointerdown', (e) => {
    // Clicking empty lane space (not a marker) clears the "selected keyframe" (Delete-key target).
    if (e.target === els.scroll || e.target.classList?.contains('timeline-lane-track')) selectedMarkerTime = null;
  });

  // Dismiss the mobile/tablet target-info popover (see buildDom's
  // targetInfo/targetInfoBtn) on any tap outside it, matching every other
  // dismissible surface in the app — without this it only closed via a
  // second tap on its own icon.
  const targetInfoEl = container.querySelector('.timeline-target-info');
  const dismissTargetInfoOnOutsideClick = (e) => {
    if (targetInfoEl && !targetInfoEl.contains(e.target)) targetInfoEl.classList.remove('open');
  };
  document.addEventListener('pointerdown', dismissTargetInfoOnOutsideClick);

  if (rafId) cancelAnimationFrame(rafId);
  tick();

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    document.removeEventListener('pointerdown', dismissTargetInfoOnOutsideClick);
  };
}
