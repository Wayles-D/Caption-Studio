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

function getVideo() {
  return document.getElementById('preview-video');
}

function buildDom(container) {
  container.innerHTML = '';
  container.classList.add('timeline-panel');

  const header = document.createElement('div');
  header.className = 'timeline-header';

  const videoChip = document.createElement('button');
  videoChip.type = 'button';
  videoChip.className = 'timeline-target-chip';
  videoChip.id = 'timeline-video-chip';
  videoChip.textContent = '🎬 Video';
  videoChip.title = 'Select the video itself as a keyframe target';
  videoChip.addEventListener('click', () => keyframeEngine.selectVideoTarget());
  header.appendChild(videoChip);

  const targetLabel = document.createElement('span');
  targetLabel.className = 'timeline-target-label';
  targetLabel.id = 'timeline-target-label';
  header.appendChild(targetLabel);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'timeline-add-keyframe-btn';
  addBtn.id = 'timeline-add-keyframe-btn';
  addBtn.innerHTML = '◆ Keyframe';
  addBtn.addEventListener('click', () => keyframeEngine.addOrUpdateKeyframeAtPlayhead());
  header.appendChild(addBtn);

  // Precision (X/Y/scale%/rotation°) numeric fields are hidden by default —
  // the primary way to set these values is direct manipulation on the
  // canvas (drag/resize/rotate — see videoCanvasControls.js and the
  // existing canvasTransform.js gestures); this toggle reveals them for
  // advanced users who want to type an exact value. Purely a display
  // toggle — the underlying values/state are unaffected either way.
  const advancedBtn = document.createElement('button');
  advancedBtn.type = 'button';
  advancedBtn.className = 'timeline-advanced-toggle';
  advancedBtn.id = 'timeline-advanced-toggle';
  advancedBtn.textContent = 'Advanced';
  advancedBtn.title = 'Show precise numeric values (position/scale/rotation)';
  advancedBtn.addEventListener('click', () => {
    advancedExpanded = !advancedExpanded;
    applyAdvancedState();
  });
  header.appendChild(advancedBtn);

  const timeReadout = document.createElement('span');
  timeReadout.className = 'timeline-time-readout';
  timeReadout.id = 'timeline-time-readout';
  header.appendChild(timeReadout);

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

    const inputs = {};
    lane.properties.forEach(({ property, fieldLabel }) => {
      if (fieldLabel) {
        const miniLabel = document.createElement('span');
        miniLabel.className = 'timeline-precision-field';
        miniLabel.style.fontSize = '9px';
        miniLabel.style.color = 'var(--text-muted)';
        miniLabel.textContent = fieldLabel;
        gutter.appendChild(miniLabel);
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
      gutter.appendChild(input);
      inputs[property] = input;
    });

    const track = document.createElement('div');
    track.className = 'timeline-lane-track';

    row.appendChild(gutter);
    row.appendChild(track);
    lanesEl.appendChild(row);

    laneEls[lane.key] = { track, inputs };
  });

  scroll.appendChild(lanesEl);

  // Single playhead line, absolutely positioned within `scroll` (spans the
  // ruler + every lane below it — one shared coordinate space).
  const playhead = document.createElement('div');
  playhead.className = 'timeline-playhead';
  playhead.id = 'timeline-playhead';
  scroll.appendChild(playhead);

  container.appendChild(scroll);

  return { header, videoChip, targetLabel, addBtn, advancedBtn, timeReadout, ruler, scroll, playhead };
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

function tick() {
  const video = getVideo();
  const duration = video?.duration || 0;
  const currentTime = video?.currentTime || 0;

  refreshRulerTicks(duration);
  refreshPlayhead(currentTime, duration);
  if (els.timeReadout) els.timeReadout.textContent = formatTime(currentTime);

  const target = keyframeEngine.getActiveTarget();
  const targetKind = target?.kind ?? null;
  if (targetKind !== lastTargetKind) {
    lastTargetKind = targetKind;
    selectedMarkerTime = null;
    if (targetKind) refreshRangesForTarget(targetKind);
  }

  if (els.videoChip) els.videoChip.classList.toggle('active', keyframeEngine.isVideoTargetSelected());
  if (els.targetLabel) els.targetLabel.textContent = target ? target.label : 'Select a caption/word or the Video chip to begin';

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

export function initTimelinePanel(container) {
  if (!container) return () => {};
  els = buildDom(container);
  advancedExpanded = false;
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

  if (rafId) cancelAnimationFrame(rafId);
  tick();

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
  };
}
