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
import { undo, redo, getHistoryState, appState } from '../state.js';
import { getFilmstrip, computeTileCount, FILMSTRIP_TILE_HEIGHT_PX, FILMSTRIP_COUNT_CHANGE_THRESHOLD } from './filmstrip.js';
import * as audioTimeline from './audioTimeline.js';
import { previewSound } from './audioEngine.js';
import { promptForAudioFile } from './audioImport.js';
import { listSounds, getSoundDefinition } from '../../../shared/soundRegistry.js';
import { getAudioTrackDuration } from '../../../shared/audioTimeline.js';
import * as textElements from './textElements.js';
import * as captionEvents from './captionEvents.js';
import { getWaveformPeaks, drawWaveform } from './audioWaveform.js';

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
  // A text element is positioned, scaled and rotated in exactly the same
  // units a caption is (frame percentage, multiplier, degrees — see
  // shared/textElement.js's resolveTextElementParams), so it shares the
  // caption ranges rather than needing a family of its own.
  if (kind === 'caption' || kind === 'text') return 'caption';
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

// TIMELINE ZOOM. 1 means "the whole clip fits the panel exactly", which is
// how the timeline has always behaved; above that the rows grow wider than
// the panel and it pans horizontally instead of squeezing everything into
// the available width.
//
// This is what makes a long video editable at all: at 1x a 40-second clip
// gives each caption a few dozen pixels, so its text wraps into an unreadable
// stack and its trim handles are a couple of pixels wide. Zooming in is the
// only way to see what you are actually editing.
//
// A pure VIEW setting — not undo-tracked, never exported, and deliberately
// not part of the document: how far you happen to be zoomed in is not an edit
// to the video.
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 16;
const TIMELINE_ZOOM_STEP = 1.5;
const TIMELINE_GUTTER_PX = 168;
let timelineZoom = 1;

/**
 * Sizes every row for the current zoom, anchored so the same instant stays
 * under the same point on screen.
 *
 * Only the ROW WIDTH is written. Everything inside a row is positioned as a
 * percentage of it (see timeToPercent), so the clips, ruler ticks, filmstrip
 * tiles and keyframe markers all stretch together for free — there is no
 * per-element zoom maths anywhere, and nothing else in this file had to learn
 * about zoom at all.
 *
 * @param {number} nextZoom
 * @param {number|null} anchorClientX - Viewport x to keep fixed (the pointer for a wheel-zoom, the panel's centre for a button).
 */
function applyTimelineZoom(nextZoom, anchorClientX = null) {
  const clamped = Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, nextZoom));
  if (!els?.scroll) return;

  const scrollRect = els.scroll.getBoundingClientRect();
  // clientWidth, NOT the border-box rect: the rect includes the vertical
  // scrollbar, so sizing rows from it made them a scrollbar-width too wide
  // and left the timeline horizontally scrollable even at 1x, where it is
  // supposed to fit the panel exactly.
  const viewportTrack = Math.max(1, els.scroll.clientWidth - TIMELINE_GUTTER_PX);
  const anchorX = anchorClientX == null ? scrollRect.left + scrollRect.width / 2 : anchorClientX;

  // The timeline position under the anchor, as a fraction of the track, BEFORE
  // the resize — so zooming feels like it happens around that point rather
  // than yanking the view back to wherever the scroll happened to be.
  const beforeTrackWidth = viewportTrack * timelineZoom;
  const beforeOffset = els.scroll.scrollLeft + (anchorX - scrollRect.left) - TIMELINE_GUTTER_PX;
  const anchorFraction = beforeTrackWidth > 0 ? beforeOffset / beforeTrackWidth : 0;

  timelineZoom = clamped;
  const rowWidth = TIMELINE_GUTTER_PX + viewportTrack * clamped;
  els.scroll.style.setProperty('--timeline-row-width', `${rowWidth}px`);

  const afterTrackWidth = viewportTrack * clamped;
  const desired = (anchorFraction * afterTrackWidth) - (anchorX - scrollRect.left) + TIMELINE_GUTTER_PX;
  els.scroll.scrollLeft = Math.max(0, desired);

  if (els.zoomLevel) els.zoomLevel.textContent = clamped <= 1 ? 'Fit' : `${clamped.toFixed(1)}x`;
  if (els.zoomOutBtn) els.zoomOutBtn.disabled = clamped <= TIMELINE_ZOOM_MIN;
  if (els.zoomInBtn) els.zoomInBtn.disabled = clamped >= TIMELINE_ZOOM_MAX;

  // Zooming re-anchors on the pointer/centre, which is a deliberate scroll
  // the follow must not mistake for the user taking over.
  programmaticScroll = true;
  requestAnimationFrame(() => { programmaticScroll = false; });

  // Clip geometry is percentage-based and therefore already correct, but the
  // STACKING packer measures laid-out boxes — two clips that overlapped at
  // 1x may not overlap once stretched, so the rows have to be repacked.
  lastTextSignature = null;
  lastAudioSignature = null;
}

/** Re-applies the current zoom after the panel itself changes size. */
function refreshTimelineZoom() {
  applyTimelineZoom(timelineZoom);
}

// --- PLAYHEAD AUTO-FOLLOW --------------------------------------------------
//
// Once the timeline can be wider than its panel (see applyTimelineZoom), the
// playhead walks off the right edge during playback and the user has to chase
// it by hand. From here on the viewport follows it instead.
//
// The anchor is a FRACTION of the visible track, never a pixel literal, so it
// adapts to the panel's width, the zoom level, a window resize and any screen
// size for free. And it is expressed against the same time -> pixel
// conversion the playhead itself is positioned by (timeToX over the ruler's
// own measured width), so there is no second notion of where a given instant
// lives — zoom is handled by construction rather than by a parallel
// pixels-per-second calculation.
//
// ANCHOR == THRESHOLD, deliberately. The obvious design ("start following at
// 75%, then centre the playhead") snaps the content sideways by the distance
// between the two the instant following begins. Making the point where
// following STARTS the same point the playhead then sits at means the
// transition is continuous: the playhead advances normally to the anchor,
// stops there, and the content begins sliding underneath it with no jump.
const FOLLOW_ANCHOR_FRACTION = 0.62;

// True while the viewport should chase the playhead. Manual scrolling during
// playback turns it off so the timeline doesn't fight a user trying to look
// somewhere else; pressing play or seeking turns it back on (see
// initTimelinePanel's listeners), which is the moment the user has asked to
// be looking at the playhead again.
let autoFollow = true;

// Our own scrollLeft writes fire 'scroll' exactly like a user's do, so they
// are flagged rather than guessed at — without this the follow would read its
// own movement as the user taking over and switch itself off on the first
// frame.
let programmaticScroll = false;

function setScrollLeft(value) {
  if (Math.abs(value - els.scroll.scrollLeft) < 0.5) return;
  programmaticScroll = true;
  els.scroll.scrollLeft = value;
  // Cleared on the next frame rather than synchronously: the scroll event is
  // dispatched asynchronously, so clearing it here would let our own event
  // arrive after the flag had already gone.
  requestAnimationFrame(() => { programmaticScroll = false; });
}

/**
 * Keeps the playhead visible while the video plays, and brings it back into
 * view after a seek.
 *
 * @param {number} contentX - The playhead's x within the scrolled content, already computed by refreshPlayhead from the video's real currentTime.
 * @param {boolean} force - Bring it into view regardless of playback/auto-follow state (a seek).
 */
function followPlayhead(contentX, force = false) {
  const scroll = els?.scroll;
  if (!scroll) return;
  const maxScroll = scroll.scrollWidth - scroll.clientWidth;
  // Fitted timeline — the whole clip is on screen, so there is nothing to
  // follow and no scrollbar to move.
  if (maxScroll <= 1) return;

  const video = getVideo();
  const playing = !!video && !video.paused && !video.ended;
  if (!force && (!playing || !autoFollow)) return;

  const trackWidth = Math.max(1, scroll.clientWidth - TIMELINE_GUTTER_PX);
  const anchor = TIMELINE_GUTTER_PX + trackWidth * FOLLOW_ANCHOR_FRACTION;
  const viewportX = contentX - scroll.scrollLeft;

  if (force) {
    // A seek can land anywhere, including behind the current view. If the
    // target is already comfortably on screen, leave the viewport alone —
    // re-centring on every scrub would yank the timeline around while the
    // user is dragging.
    if (viewportX >= TIMELINE_GUTTER_PX && viewportX <= scroll.clientWidth) return;
    setScrollLeft(Math.max(0, Math.min(maxScroll, contentX - anchor)));
    return;
  }

  // Before the anchor the playhead simply advances across a stationary
  // timeline, exactly as it always has. At and past it, the scroll position
  // is derived from the playhead's own position every frame, so the content
  // slides continuously instead of jumping in steps.
  if (viewportX < anchor) return;
  setScrollLeft(Math.max(0, Math.min(maxScroll, contentX - anchor)));
}

/** Re-arms following and pulls the playhead into view — after play or a seek. */
function resumeFollow() {
  autoFollow = true;
  const video = getVideo();
  const duration = video?.duration || 0;
  if (!els?.ruler || !(duration > 0)) return;
  const rulerRect = els.ruler.getBoundingClientRect();
  const scrollRect = els.scroll.getBoundingClientRect();
  if (!rulerRect.width) return;
  const x = timeToX(video.currentTime || 0, rulerRect.width, duration);
  followPlayhead((rulerRect.left - scrollRect.left) + els.scroll.scrollLeft + x, true);
}

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
  // Zoom controls sit with the other view controls, left of Advanced.
  const zoomControls = document.createElement('div');
  zoomControls.className = 'timeline-zoom-controls';
  const makeZoomBtn = (id, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'timeline-zoom-btn';
    b.id = id;
    b.textContent = label;
    b.title = title;
    return b;
  };
  const zoomOutBtn = makeZoomBtn('timeline-zoom-out', '\u2212', 'Zoom out (show more of the timeline)');
  const zoomInBtn = makeZoomBtn('timeline-zoom-in', '+', 'Zoom in (stretch the timeline so clips are readable)');
  const zoomLevel = document.createElement('span');
  zoomLevel.className = 'timeline-zoom-level';
  zoomLevel.id = 'timeline-zoom-level';
  zoomLevel.textContent = 'Fit';
  zoomOutBtn.addEventListener('click', () => applyTimelineZoom(timelineZoom / TIMELINE_ZOOM_STEP));
  zoomInBtn.addEventListener('click', () => applyTimelineZoom(timelineZoom * TIMELINE_ZOOM_STEP));
  // Double-clicking the level is the quick way back to "everything visible".
  zoomLevel.title = 'Double-click to fit the whole clip';
  zoomLevel.addEventListener('dblclick', () => applyTimelineZoom(1));
  zoomControls.appendChild(zoomOutBtn);
  zoomControls.appendChild(zoomLevel);
  zoomControls.appendChild(zoomInBtn);
  controlsRow.appendChild(zoomControls);

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

  // Video filmstrip — real frames sampled across the clip, rendered as a row
  // under the ruler so the timeline reads like a video editor's. Shares the
  // ruler's grid (168px gutter + 1fr track) so tiles line up exactly with the
  // ruler ticks and keyframe markers, and lives inside `scroll` so the single
  // existing playhead crosses it with no second indicator. Purely a VIEW of
  // #preview-video's timeline — see filmstrip.js on why it owns no time state.
  const filmstripRow = document.createElement('div');
  filmstripRow.className = 'timeline-filmstrip-row';
  const filmstripGutter = document.createElement('div');
  filmstripGutter.className = 'timeline-filmstrip-gutter';
  filmstripGutter.textContent = 'Video';
  // The filmstrip track itself clips its tiles (overflow:hidden gives the
  // strip its rounded outer edge), so keyframe markers can't live INSIDE it —
  // one at t=0 or t=duration would be sliced in half by that clip. This
  // positioned wrapper holds both the strip and the marker overlay as
  // siblings sharing one coordinate space, so markers sit ON the video row
  // (CapCut-style: keyframes belong to the clip they animate, not to a lane
  // of their own) without being subject to the strip's clipping.
  const filmstripStack = document.createElement('div');
  filmstripStack.className = 'timeline-filmstrip-stack';
  const filmstripTrack = document.createElement('div');
  filmstripTrack.className = 'timeline-filmstrip-track';
  filmstripTrack.id = 'timeline-filmstrip-track';
  // THE keyframe track — one ◆ per keyframe ENTRY (whatever properties it
  // holds), not four per-property tracks. The Position/Scale/Rotation/Opacity
  // rows below still exist for VALUE EDITING (the Advanced numeric fields —
  // see relocatePrecisionFields) but host no markers. `pointer-events` is off
  // on the overlay itself and back on for each marker (see style.css), so
  // clicking the empty space between markers still scrubs the filmstrip
  // underneath exactly as it did before the markers moved here.
  const keyframeTrack = document.createElement('div');
  keyframeTrack.className = 'timeline-keyframe-overlay';
  keyframeTrack.id = 'timeline-keyframe-overlay';
  filmstripStack.appendChild(filmstripTrack);
  filmstripStack.appendChild(keyframeTrack);
  // The video strip gets the same in-strip "+" as the audio lanes, so "add
  // content to this track" is one consistent gesture across every row. Added
  // to the STACK rather than inside the strip itself, which clips its own
  // children (that clipping is what gives the filmstrip its rounded edge).
  const addVideoBtn = buildAddButton('timeline-add-video-btn', 'Upload a video');
  filmstripStack.appendChild(addVideoBtn);
  filmstripRow.appendChild(filmstripGutter);
  filmstripRow.appendChild(filmstripStack);
  scroll.appendChild(filmstripRow);

  const lanesEl = document.createElement('div');
  lanesEl.id = 'timeline-lanes';
  laneEls = {};

  // The two AUDIO lanes, directly under the video row — see buildAudioLane.
  // Two separate lanes, never one: "+ Sound" places a short effect at an
  // instant, "+ Audio" lays a long imported track across a span. They are
  // different editing gestures and are kept visually and structurally
  // distinct for that reason.
  const sfxLane = buildAudioLane('sfx', 'SFX', 'Add a sound effect at the playhead');
  const audioLane = buildAudioLane('audio', 'Audio', 'Import a music, ambience or voiceover file');

  // Text overlays get their own lane, above the audio lanes: they're a
  // VISUAL element, so they belong next to the picture rather than under the
  // sound. Built with buildAudioLane because a span-shaped clip lane is a
  // span-shaped clip lane — only what the clips MEAN differs.
  const textLane = buildAudioLane('text', 'Text', 'Add a text overlay at the playhead');

  // Manually placed CAPTIONS get a lane of their own, above the overlays.
  // They are the same record type (shared/textElement.js — one model, two
  // kinds) and share every gesture, so this is presentation only: a caption
  // and an overlay differ in what they MEAN, and putting a caption you timed
  // yourself on its own row next to the transcript is what makes that
  // difference visible while editing.
  const captionsLane = buildAudioLane('captions', 'Captions', 'Add a caption at the playhead');
  lanesEl.appendChild(captionsLane.row);
  lanesEl.appendChild(textLane.row);
  lanesEl.appendChild(sfxLane.row);
  lanesEl.appendChild(audioLane.row);

  // Off-DOM parent for the property rows — see the appendChild below for why
  // they're built but never shown in the timeline. Keeping them in a real
  // container (rather than leaving them orphaned) is what lets
  // relocatePrecisionFields put them back when the Advanced panel closes.
  const detachedPropertyRows = document.createElement('div');

  LANES.forEach((lane) => {
    const row = document.createElement('div');
    // `timeline-property-lane` is what hides this row's (unused) track — the
    // markers live on the filmstrip now, and the audio lanes above are the
    // only other rows with a real, interactive track.
    row.className = 'timeline-lane timeline-property-lane';
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
    // NOT added to the timeline. These four rows (Position / Scale /
    // Rotation / Opacity) were only ever a label plus numeric fields — their
    // own track is CSS-hidden and hosts no markers, the keyframe diamonds
    // live on the filmstrip row instead — so as timeline rows they cost
    // vertical space and showed nothing. The fields themselves are still
    // built, still live, and still reachable: relocatePrecisionFields() moves
    // these exact elements into the Advanced side panel, which is now their
    // only home. Keyframing is completely untouched by this.
    detachedPropertyRows.appendChild(row);

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

  return {
    header, playbackRow, playBtn, undoBtn, redoBtn, videoChip, targetLabel, targetTooltip,
    addBtn, advancedBtn, timeReadout, ruler, scroll, playhead, keyframeTrack, filmstripTrack,
    sfxTrack: sfxLane.track, audioTrack: audioLane.track, textTrack: textLane.track,
    captionsTrack: captionsLane.track,
    addSoundBtn: sfxLane.addBtn, addAudioBtn: audioLane.addBtn, addTextBtn: textLane.addBtn,
    addCaptionBtn: captionsLane.addBtn, addVideoBtn,
    zoomInBtn, zoomOutBtn, zoomLevel
  };
}

/**
 * One audio lane row: a gutter with its name and its own "+" action, and a
 * full-width track the clips are drawn into. Identical structure for both
 * lanes so they read as one system; only the label, the button and what the
 * button does differ.
 */
function buildAudioLane(key, label, addTitle) {
  const row = document.createElement('div');
  row.className = 'timeline-lane timeline-audio-lane';
  row.dataset.lane = key;

  const gutter = document.createElement('div');
  gutter.className = 'timeline-lane-gutter';
  const labelEl = document.createElement('span');
  labelEl.className = 'timeline-lane-label';
  labelEl.textContent = label;
  gutter.appendChild(labelEl);

  const track = document.createElement('div');
  track.className = 'timeline-lane-track timeline-audio-track';
  track.id = `timeline-${key}-track`;

  // The add control lives INSIDE the strip, not out in the gutter — the strip
  // is the thing the content goes into, so that is where the affordance to
  // add content belongs (and it keeps the gutter to just a name, so every
  // lane's label column stays the same narrow, scannable width).
  track.appendChild(buildAddButton(`timeline-add-${key}-btn`, addTitle));

  row.appendChild(gutter);
  row.appendChild(track);
  return { row, track, addBtn: track.querySelector('.timeline-add-clip-btn'), gutter };
}

/**
 * The in-strip "+" control. Pinned to the strip's left edge and deliberately
 * subdued until hovered: it sits in the same space clips occupy, so it has to
 * read as an affordance rather than compete with the content. It is above the
 * clips in z-order and stops its own pointer events, so clicking it never
 * also scrubs the timeline or starts a clip drag underneath.
 */
function buildAddButton(id, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'timeline-add-clip-btn';
  btn.id = id;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>';
  // pointerdown (not just click) — the lane tracks and the filmstrip both
  // scrub on pointerdown, which would otherwise fire underneath this button.
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  return btn;
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
  // Driven from the SAME position the playhead was just drawn at, once per
  // frame, so the viewport can never disagree with where the playhead is —
  // and no extra layout is measured to do it.
  followPlayhead(left);
}

function clearMarkers(track) {
  track.querySelectorAll('.timeline-marker').forEach((el) => el.remove());
}

function buildMarker(entry, duration, role) {
  const marker = document.createElement('div');
  marker.className = 'timeline-marker';
  // Every entry on the unified lane always has at least one property value
  // by construction (see shared/keyframes.js's upsertKeyframeEntry) — no
  // per-lane "does THIS lane's property happen to be in this entry" filter
  // needed now that there's one shared track instead of four.
  marker.classList.add('filled');
  // `role` is 'start' | 'end' | null — null for every keyframe strictly
  // BETWEEN the first and last in a sequence of 3+, which are neither. Only
  // 'end' gets a second color (see style.css's --keyframe-end-color); the
  // sequence's first keyframe already reads as "the start" by being the
  // plain accent color every OTHER marker in the app already uses, so it
  // needs no marking of its own beyond the label below. A lone keyframe
  // gets role=null too (refreshLanes never marks it 'end' — nothing to
  // distinguish it FROM).
  if (role === 'end') marker.classList.add('marker-end');
  if (selectedMarkerTime != null && Math.abs(entry.t - selectedMarkerTime) <= 0.03) marker.classList.add('selected');
  marker.style.left = `${(entry.t / duration) * 100}%`;
  marker.dataset.time = String(entry.t);
  const roleLabel = role === 'start' ? 'Start ' : role === 'end' ? 'End ' : '';
  marker.title = `${roleLabel}keyframe @ ${entry.t.toFixed(2)}s — click to jump, drag to retime, Delete to remove`;
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
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // Never steal a keystroke aimed at a text field. This used to check only
  // INPUT, which missed the TEXTAREA the Overlay panel's Content field
  // actually is — so pressing Backspace to fix a typo while typing an
  // overlay's text deleted the whole element off the timeline instead. Any
  // editable surface counts, not a list of tag names that has to be kept up
  // to date with the UI.
  const focused = document.activeElement;
  if (focused && (
    focused.tagName === 'INPUT'
    || focused.tagName === 'TEXTAREA'
    || focused.tagName === 'SELECT'
    || focused.isContentEditable
  )) return;

  // A selected AUDIO clip takes precedence over a selected keyframe: selecting
  // a clip is the more recent, more specific intent, and the two selections
  // are independent (a keyframe can stay selected on a caption while the user
  // goes and clicks a sound effect). Without this ordering, Delete would
  // silently remove a keyframe the user had stopped thinking about.
  if (appState.selectedAudioClipId) {
    audioTimeline.removeSelectedClip();
    return;
  }

  // Same precedence rung, for the same reason: a selected text clip is what
  // the user is looking at, so Delete means that one — not a keyframe they
  // stopped thinking about. Removes no caption and no other clip.
  if (appState.selectedTextElementId) {
    textElements.removeSelectedTextElement();
    return;
  }

  if (selectedMarkerTime != null) {
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
    clearMarkers(els.keyframeTrack);
    // `entries` is time-sorted (shared/keyframes.js's upsertKeyframeEntry/
    // moveKeyframeEntry both keep it that way) — so index 0 and the last
    // index really are the earliest/latest keyframes, not just whichever
    // happen to be first/last in insertion order.
    const lastIdx = entries.length - 1;
    entries.forEach((entry, idx) => {
      const role = entries.length < 2 ? null : idx === 0 ? 'start' : idx === lastIdx ? 'end' : null;
      els.keyframeTrack.appendChild(buildMarker(entry, duration, role));
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

// --- Audio lanes (sound effects + audio tracks) ----------------------------
// Same rebuild discipline as the keyframe markers above, for the same reason:
// a clip element destroyed and recreated mid-gesture cannot be clicked,
// dragged or deleted reliably. Clips are rebuilt only when the underlying
// audio DATA (or the selection highlight) actually changes, and never while a
// clip is being dragged or trimmed — so scrubbing and playback never disturb
// an in-progress interaction.
let lastAudioSignature = null;
let lastTextSignature = null;
let dragClip = null; // { id, kind, mode: 'move'|'trim-start'|'trim-end', startClientX, moved, grabOffsetSeconds }

const CLIP_DRAG_THRESHOLD_PX = 3;

/** Removes every clip from a lane track, leaving its in-strip "+" button in place. */
function clearClips(track) {
  track.querySelectorAll('.timeline-sfx-clip, .timeline-audio-clip, .timeline-text-clip').forEach((el) => el.remove());
}

// One sub-row of a lane, in px. A lane holds as many of these as it needs to
// keep overlapping clips apart (see stackClips).
const CLIP_ROW_HEIGHT_PX = 30;
const CLIP_ROW_GAP_PX = 3;

/**
 * Lays a lane's clips out in as few sub-rows as possible so that none of them
 * visually covers another, and returns how many rows that took.
 *
 * Why this exists: clips are positioned by TIME, so two that overlap in time
 * land on top of each other and only the topmost can be clicked or dragged —
 * the one behind becomes uneditable with no way to get at it. Stacking them
 * is what CapCut does, and it needs no extra interaction: a lane with no
 * overlaps still renders as a single row and looks exactly as it did.
 *
 * Packing is done on each clip's ON-SCREEN span, not its time span. A sound
 * effect is a point in time but renders as a pill of real width, so two
 * effects a few hundredths of a second apart genuinely overlap on screen
 * while their times do not. Measuring the laid-out elements is what makes
 * "do these collide" mean the same thing the user sees.
 *
 * @param {HTMLElement} track - The lane strip the clips were just appended to.
 * @param {HTMLElement[]} clips - Those clips, any order.
 * @returns {number} Rows used (>= 1), for sizing the lane.
 */
function stackClips(track, clips) {
  if (!clips.length) return 1;

  const trackWidth = track.clientWidth || 1;
  const spans = clips.map((el) => {
    // offsetLeft/offsetWidth are the real laid-out box, so a pill's minimum
    // rendered width counts even when its clip has no duration at all.
    const left = el.offsetLeft;
    return { el, left, right: left + Math.max(el.offsetWidth, 1) };
  }).sort((a, b) => a.left - b.left);

  // Greedy first-fit: a clip joins the first row whose last clip already
  // ended before it starts, else it opens a new row. One pixel of slack so
  // two clips that merely touch don't get split onto separate rows.
  const rowEnds = [];
  spans.forEach((span) => {
    let row = rowEnds.findIndex((end) => span.left >= end - 1);
    if (row === -1) {
      rowEnds.push(span.right);
      row = rowEnds.length - 1;
    } else {
      rowEnds[row] = span.right;
    }
    const rowTop = row * (CLIP_ROW_HEIGHT_PX + CLIP_ROW_GAP_PX) + CLIP_ROW_GAP_PX;
    if (span.el.classList.contains('timeline-sfx-clip')) {
      // A sound-effect pill keeps its own small fixed height and is centred
      // on its anchor by `transform: translateY(-50%)`, so it gets the row's
      // CENTRE line rather than its top edge, and no height at all.
      span.el.style.top = `${rowTop + CLIP_ROW_HEIGHT_PX / 2}px`;
    } else {
      span.el.style.top = `${rowTop}px`;
      span.el.style.height = `${CLIP_ROW_HEIGHT_PX}px`;
    }
    span.el.dataset.stackRow = String(row);
  });
  void trackWidth;
  return Math.max(1, rowEnds.length);
}

/**
 * Grows a lane AND its strip to fit however many sub-rows its clips needed.
 *
 * Both, not just the lane: the strip is the clips' positioning container, so
 * a strip left at its old height lets a second-row clip render OUTSIDE it —
 * where it is drawn over whatever follows in the document and is no longer
 * hit-testable at all (measured: lane 69px, strip still 24px, and the
 * stacked pill's own centre resolved to the panel underneath the timeline).
 */
function sizeLaneForRows(track, rows) {
  const height = rows * (CLIP_ROW_HEIGHT_PX + CLIP_ROW_GAP_PX) + CLIP_ROW_GAP_PX;
  track.style.minHeight = `${height}px`;
  const lane = track.closest('.timeline-lane');
  if (lane) lane.style.minHeight = `${height}px`;
}

/** Seconds -> percentage across a lane track, clamped so a clip can't render outside its own lane. */
function timeToPercent(time, duration) {
  if (!duration || duration <= 0) return 0;
  return Math.max(0, Math.min(100, (time / duration) * 100));
}

/**
 * Shared pointer wiring for both clip kinds. `mode` decides what a drag
 * MEANS (move the whole clip, or pull one of its edges), but the
 * click-vs-drag discrimination, the live-preview-then-commit split, and the
 * select-and-seek click behavior are identical for all of them — and
 * identical to how the keyframe markers above already behave, so clips and
 * keyframes feel like the same timeline rather than two different ones.
 */
function attachClipPointerHandlers(el, clip, kind, mode) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    // Each clip family owns its own selection key, so selecting a text clip
    // never leaves a stale audio selection behind that Delete would hit
    // first (and vice versa).
    if (kind === 'text') {
      textElements.selectTextElement(clip.id);
      audioTimeline.selectClip(null);
      captionEvents.selectCaptionEvent(null);
    } else if (kind === 'caption') {
      captionEvents.selectCaptionEvent(clip.id);
      textElements.selectTextElement(null);
      audioTimeline.selectClip(null);
    } else {
      audioTimeline.selectClip(clip.id);
      textElements.selectTextElement(null);
      captionEvents.selectCaptionEvent(null);
    }
    const rect = el.parentElement.getBoundingClientRect();
    const duration = getVideo()?.duration || 0;
    const pointerTime = xToTime(e.clientX - rect.left, rect.width, duration);
    dragClip = {
      id: clip.id,
      kind,
      mode,
      startClientX: e.clientX,
      moved: false,
      // Where inside the clip the user grabbed it, so a move keeps that point
      // under the cursor instead of snapping the clip's head to the pointer.
      // Audio clips carry `startTime`; text elements carry `start` (they're
      // phrase-shaped, since the renderer consumes them as one). Read either
      // rather than forcing one vocabulary onto the other — getting this
      // wrong yields NaN, which silently collapses the clip to 0.
      grabOffsetSeconds: mode === 'move' ? pointerTime - (clip.startTime ?? clip.start ?? 0) : 0
    };
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragClip || dragClip.id !== clip.id) return;
    if (!dragClip.moved && Math.abs(e.clientX - dragClip.startClientX) < CLIP_DRAG_THRESHOLD_PX) return;
    dragClip.moved = true;
    applyClipDrag(e.clientX, el, { recordHistory: false });
  });

  const endDrag = (e) => {
    if (!dragClip || dragClip.id !== clip.id) return;
    // The final position is committed as ONE history entry; every intermediate
    // move during the drag was recorded with recordHistory:false, so undo
    // steps back over the whole gesture rather than one pointermove of it.
    if (dragClip.moved) applyClipDrag(e.clientX, el, { recordHistory: true });
    dragClip = null;
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    // A plain click (no drag) selects and moves the playhead to the clip, so
    // pressing play immediately auditions it in context. Matches what
    // clicking a keyframe marker already does.
    if (dragClip?.moved) return;
    const video = getVideo();
    if (video && mode === 'move') video.currentTime = clip.startTime ?? clip.start ?? 0;
  });
}

/** Translates the pointer's X into the timeline edit this drag represents. */
function applyClipDrag(clientX, el, options) {
  const track = el.closest('.timeline-lane-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const duration = getVideo()?.duration || 0;
  if (!rect.width || duration <= 0) return;
  const pointerTime = xToTime(Math.max(0, Math.min(rect.width, clientX - rect.left)), rect.width, duration);

  if (dragClip.mode === 'move') {
    const nextStart = pointerTime - dragClip.grabOffsetSeconds;
    if (dragClip.kind === 'sound') audioTimeline.moveSoundEvent(dragClip.id, nextStart, options);
    else if (dragClip.kind === 'text') textElements.moveTextElement(dragClip.id, nextStart, options);
    else if (dragClip.kind === 'caption') captionEvents.moveCaptionEventTo(dragClip.id, nextStart, options);
    else audioTimeline.moveAudioTrack(dragClip.id, nextStart, options);
    return;
  }

  // Text has no source media behind it, so trimming its head is a plain
  // retime — unlike an audio clip, where dragging the left edge also has to
  // move the source offset to keep the audio under the cursor still.
  if (dragClip.kind === 'text') {
    textElements.trimTextElement(dragClip.id, dragClip.mode === 'trim-start' ? 'start' : 'end', pointerTime, options);
    return;
  }

  // A caption's words stay where they are when its edges move — trimming
  // changes how long it is on screen, not when it was spoken (see
  // shared/captionEvent.js's trimCaptionEvent).
  if (dragClip.kind === 'caption') {
    captionEvents.trimCaptionEventEdge(dragClip.id, dragClip.mode === 'trim-start' ? 'start' : 'end', pointerTime, options);
    return;
  }

  audioTimeline.trimAudioTrack(dragClip.id, dragClip.mode === 'trim-start' ? 'start' : 'end', pointerTime, options);
}

function buildSoundClip(event, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-sfx-clip';
  if (isSelected) el.classList.add('selected');
  if (!event.enabled) el.classList.add('disabled');
  // An automatically-placed effect is marked so the user can tell at a glance
  // what came from the transcript analysis and what they placed themselves.
  if (event.source === 'ai') el.classList.add('auto');
  el.style.left = `${timeToPercent(event.startTime, duration)}%`;
  el.dataset.clipId = event.id;

  const definition = getSoundDefinition(event.soundId);
  el.title = `${definition.label} @ ${event.startTime.toFixed(2)}s${event.source === 'ai' ? ' (auto)' : ''} — drag to retime, click to jump, Delete to remove`;
  el.tabIndex = 0;

  const dot = document.createElement('span');
  dot.className = 'timeline-sfx-clip-dot';
  const label = document.createElement('span');
  label.className = 'timeline-sfx-clip-label';
  label.textContent = definition.label;
  el.appendChild(dot);
  el.appendChild(label);

  attachClipPointerHandlers(el, event, 'sound', 'move');
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    previewSound(event.soundId, event.volume);
  });
  return el;
}

/**
 * Loads (once, cached) and paints this clip's waveform, then keeps it correct
 * as the clip's on-screen width changes.
 *
 * A ResizeObserver rather than a one-off draw: the clip's pixel width changes
 * both from window resizes AND from trimming, and a canvas whose backing store
 * no longer matches its box gets stretched by the browser into a blurry,
 * misaligned trace. Observing the element itself covers every cause without
 * the timeline needing to know what they are.
 */
function paintClipWaveform(canvas, track) {
  if (!track.url) return;

  const sourceDuration = track.sourceDuration;
  const draw = (peaks) => {
    if (!peaks || !canvas.isConnected) return;
    // Fractions of the SOURCE file, so the drawn shape always corresponds to
    // the audio this clip actually plays (see drawWaveform's own note).
    const total = sourceDuration || 0;
    const startFraction = total > 0 ? Math.min(1, track.trimStart / total) : 0;
    const endFraction = total > 0 && track.trimEnd != null ? Math.min(1, track.trimEnd / total) : 1;
    drawWaveform(canvas, peaks, {
      startFraction,
      endFraction: Math.max(startFraction + 1e-6, endFraction),
      color: 'rgba(255, 255, 255, 0.55)'
    });
  };

  getWaveformPeaks(track.url).then((peaks) => {
    if (!peaks) return;
    draw(peaks);
    // The clip is rebuilt (and this observer replaced) whenever the underlying
    // data changes, so the observer only has to outlive resizes of THIS
    // element — it is disconnected automatically when the element is GC'd.
    const observer = new ResizeObserver(() => draw(peaks));
    observer.observe(canvas);
  });
}

function buildAudioClip(track, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-audio-clip';
  if (isSelected) el.classList.add('selected');
  if (!track.enabled) el.classList.add('disabled');
  el.style.left = `${timeToPercent(track.startTime, duration)}%`;

  // A clip whose source length isn't known yet (metadata still decoding) gets
  // a minimum visible width rather than a zero-width, unclickable sliver.
  const clipDuration = getAudioTrackDuration(track);
  const widthPct = clipDuration == null
    ? 8
    : Math.max(1, timeToPercent(track.startTime + clipDuration, duration) - timeToPercent(track.startTime, duration));
  el.style.width = `${widthPct}%`;
  el.dataset.clipId = track.id;
  el.title = `${track.name} @ ${track.startTime.toFixed(2)}s — drag to move, drag an edge to trim, Delete to remove`;
  el.tabIndex = 0;

  // The real waveform of whatever part of the file this clip actually plays.
  // Drawn behind the label so the name stays readable over it.
  const wave = document.createElement('canvas');
  wave.className = 'timeline-audio-clip-wave';
  el.appendChild(wave);
  paintClipWaveform(wave, track);

  const label = document.createElement('span');
  label.className = 'timeline-audio-clip-label';
  label.textContent = track.name;
  el.appendChild(label);

  attachClipPointerHandlers(el, track, 'audio', 'move');

  // Trim handles are their own elements with their own pointer wiring so a
  // grab on an edge never also registers as a move of the whole clip.
  ['start', 'end'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `timeline-audio-clip-handle ${edge}`;
    handle.title = edge === 'start' ? 'Trim the start' : 'Trim the end';
    attachClipPointerHandlers(handle, track, 'audio', edge === 'start' ? 'trim-start' : 'trim-end');
    el.appendChild(handle);
  });

  return el;
}

/**
 * One text-overlay / manual-caption clip. A span bar with trim handles,
 * exactly like an audio track's — the gestures expected on a timed clip
 * don't change just because the payload is text, so it reuses
 * attachClipPointerHandlers rather than growing its own.
 */
function buildTextClip(element, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-text-clip';
  if (isSelected) el.classList.add('selected');
  if (!element.enabled) el.classList.add('disabled');
  if (element.kind === 'caption') el.classList.add('is-caption');

  el.style.left = `${timeToPercent(element.start, duration)}%`;
  el.style.width = `${Math.max(1, timeToPercent(element.end, duration) - timeToPercent(element.start, duration))}%`;
  el.dataset.clipId = element.id;
  el.tabIndex = 0;
  el.title = `${element.text || '(empty)'} · ${element.start.toFixed(2)}s → ${element.end.toFixed(2)}s`
    + ' — drag to move, drag an edge to retime, Delete to remove';

  const label = document.createElement('span');
  label.className = 'timeline-text-clip-label';
  label.textContent = element.text || (element.kind === 'caption' ? 'Caption' : 'Text');
  el.appendChild(label);

  attachClipPointerHandlers(el, element, 'text', 'move');

  ['start', 'end'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `timeline-text-clip-handle ${edge}`;
    handle.title = edge === 'start' ? 'Change when it appears' : 'Change when it disappears';
    attachClipPointerHandlers(handle, element, 'text', edge === 'start' ? 'trim-start' : 'trim-end');
    el.appendChild(handle);
  });

  return el;
}

/**
 * One clip for one of the TRANSCRIPT's captions (shared/captionEvent.js) —
 * what is actually on screen at that moment, the way every other editor
 * shows it.
 *
 * Built as a `.timeline-text-clip` like a manual caption rather than as its
 * own thing: the two are the same object to the user (a caption, on the
 * captions lane, that can be dragged and trimmed), and sharing the element
 * means sharing every gesture, selection and stacking path already built for
 * it. Only the drag FAMILY differs ('caption' vs 'text'), which is what routes
 * the edit to the right module.
 */
function buildCaptionEventClip(event, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-text-clip is-caption is-transcript';
  if (isSelected) el.classList.add('selected');

  el.style.left = `${timeToPercent(event.start, duration)}%`;
  el.style.width = `${Math.max(1, timeToPercent(event.end, duration) - timeToPercent(event.start, duration))}%`;
  el.dataset.clipId = event.id;
  el.tabIndex = 0;

  const words = appState.words || [];
  const text = event.wordIndices.map((i) => (words[i]?.word ?? '').trim()).filter(Boolean).join(' ');
  el.title = `${text || '(caption)'} · ${event.start.toFixed(2)}s → ${event.end.toFixed(2)}s`
    + ' — drag to retime, drag an edge to change how long it shows, S to split at the playhead';

  const label = document.createElement('span');
  label.className = 'timeline-text-clip-label';
  label.textContent = text || 'Caption';
  el.appendChild(label);

  attachClipPointerHandlers(el, event, 'caption', 'move');

  ['start', 'end'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `timeline-text-clip-handle ${edge}`;
    handle.title = edge === 'start' ? 'Change when it appears' : 'Change when it disappears';
    attachClipPointerHandlers(handle, event, 'caption', edge === 'start' ? 'trim-start' : 'trim-end');
    el.appendChild(handle);
  });

  return el;
}

function refreshTextLane(duration) {
  // A project whose transcript arrived BEFORE caption events existed has
  // phrases but no events, so its captions would never appear on the lane.
  // Seeding here rather than only on upload/regenerate is what makes them
  // show up for a session that is already open. Idempotent and self-
  // disabling: it only ever fills an EMPTY list.
  captionEvents.ensureCaptionEventsSeeded();

  const elements = appState.textElements || [];
  const selectedId = appState.selectedTextElementId;
  const events = appState.captionEvents || [];
  const selectedCaptionId = appState.selectedCaptionEventId;
  const signature = JSON.stringify({ elements, selectedId, events, selectedCaptionId, duration });
  // Same two invariants refreshAudioLanes documents: never rebuild mid-drag
  // (a DOM swap under the pointer kills the gesture), and never
  // replaceChildren (the in-strip "+" is a child of the track).
  if (signature === lastTextSignature || dragClip) return;
  lastTextSignature = signature;

  clearClips(els.textTrack);
  clearClips(els.captionsTrack);
  if (!(duration > 0)) return;

  // Split by kind, not by type: both lanes hold the same records and build
  // the same clip element (see buildTextClip), so every drag/trim/select/
  // delete path stays shared — only which strip a clip is appended to
  // depends on its kind.
  const captionClips = [];
  const overlayClips = [];

  // The TRANSCRIPT's own captions share the Captions lane with manually
  // placed ones — to the user they are the same thing (a caption, on the
  // captions lane) and they stack against each other through the same
  // packer, so an overlap between the two is as reachable as any other.
  events.forEach((event) => {
    const clip = buildCaptionEventClip(event, duration, event.id === selectedCaptionId);
    captionClips.push(clip);
    els.captionsTrack.appendChild(clip);
  });

  elements.forEach((element) => {
    const clip = buildTextClip(element, duration, element.id === selectedId);
    if (element.kind === 'caption') {
      captionClips.push(clip);
      els.captionsTrack.appendChild(clip);
    } else {
      overlayClips.push(clip);
      els.textTrack.appendChild(clip);
    }
  });
  // Stacked AFTER appending — the packer measures the real laid-out boxes.
  sizeLaneForRows(els.textTrack, stackClips(els.textTrack, overlayClips));
  sizeLaneForRows(els.captionsTrack, stackClips(els.captionsTrack, captionClips));
  els.textTrack.classList.toggle('is-empty', overlayClips.length === 0);
  els.captionsTrack.classList.toggle('is-empty', captionClips.length === 0);
}

function refreshAudioLanes(duration) {
  const soundEvents = appState.soundEvents || [];
  const audioTracks = appState.audioTracks || [];
  const selectedId = appState.selectedAudioClipId;
  const signature = JSON.stringify({ soundEvents, audioTracks, selectedId, duration });
  if (signature === lastAudioSignature || dragClip) return;
  lastAudioSignature = signature;

  // Only the CLIPS are cleared, never the whole track: the in-strip "+" button
  // is a child of the track too (that is the point of it being in the strip),
  // and replaceChildren() would delete it on the first rebuild — leaving a
  // lane with no way to add anything to it.
  clearClips(els.sfxTrack);
  clearClips(els.audioTrack);
  if (!(duration > 0)) return;

  const sfxClips = [];
  const audioClips = [];
  soundEvents.forEach((event) => {
    const clip = buildSoundClip(event, duration, event.id === selectedId);
    sfxClips.push(clip);
    els.sfxTrack.appendChild(clip);
  });
  audioTracks.forEach((track) => {
    const clip = buildAudioClip(track, duration, track.id === selectedId);
    audioClips.push(clip);
    els.audioTrack.appendChild(clip);
  });

  // The in-strip "+" sits at the strip's left edge, which is exactly where a
  // clip starting at 0:00 also sits (a music bed almost always does). Rather
  // than let it cover that clip's own label permanently, an occupied lane
  // reveals its "+" on hover instead; an EMPTY lane keeps it plainly visible,
  // which is the case where discoverability actually matters.
  // Stacked AFTER appending — the packer measures the real laid-out boxes.
  sizeLaneForRows(els.sfxTrack, stackClips(els.sfxTrack, sfxClips));
  sizeLaneForRows(els.audioTrack, stackClips(els.audioTrack, audioClips));
  els.sfxTrack.classList.toggle('is-empty', soundEvents.length === 0);
  els.audioTrack.classList.toggle('is-empty', audioTracks.length === 0);
}

// --- "+ Sound" picker ------------------------------------------------------

let soundPickerEl = null;

function closeSoundPicker() {
  if (soundPickerEl) {
    soundPickerEl.remove();
    soundPickerEl = null;
  }
}

/**
 * Positions the picker just above its button, in VIEWPORT coordinates.
 *
 * It is appended to <body> and fixed-positioned rather than anchored inside
 * the lane gutter, because the gutter lives inside `.timeline-scroll`
 * (overflow-y:auto) inside a short, fixed-height panel: a popover opening
 * upward from there is both clipped by that scroll container and painted
 * underneath the preview `<main>` above it — visible in a screenshot,
 * completely unclickable in practice (confirmed by the e2e suite, whose click
 * on a picker row was intercepted by <main> until this was changed).
 */
function positionSoundPicker(picker, anchorBtn) {
  const rect = anchorBtn.getBoundingClientRect();
  picker.style.left = `${Math.max(8, rect.left)}px`;
  // Flip below the button if there genuinely isn't room above it.
  const height = picker.offsetHeight;
  const above = rect.top - height - 6;
  picker.style.top = above >= 8 ? `${above}px` : `${rect.bottom + 6}px`;
}

/**
 * A small popover listing every registered sound. Each row auditions on its
 * own ▶ button and places the effect at the playhead when the row is clicked
 * — so a user can hear a sound before committing to it, which is the whole
 * difference between picking a sound and guessing one.
 *
 * Built from shared/soundRegistry.js's listing rather than a hard-coded set,
 * so adding a sound to the registry adds it here with no change to this file.
 */
function openSoundPicker(anchorBtn) {
  if (soundPickerEl) {
    closeSoundPicker();
    return;
  }

  const picker = document.createElement('div');
  picker.className = 'timeline-sound-picker';

  const heading = document.createElement('div');
  heading.className = 'timeline-sound-picker-heading';
  heading.textContent = 'Add sound at playhead';
  picker.appendChild(heading);

  listSounds().forEach((sound) => {
    const row = document.createElement('div');
    row.className = 'timeline-sound-picker-row';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'timeline-sound-picker-play';
    play.setAttribute('aria-label', `Preview ${sound.label}`);
    play.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>';
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      previewSound(sound.id, sound.defaultVolume);
    });

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'timeline-sound-picker-name';
    name.textContent = sound.label;
    name.addEventListener('click', () => {
      audioTimeline.addSoundEvent(sound.id);
      closeSoundPicker();
    });

    row.appendChild(play);
    row.appendChild(name);
    picker.appendChild(row);
  });

  document.body.appendChild(picker);
  positionSoundPicker(picker, anchorBtn);
  soundPickerEl = picker;
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

// --- Video filmstrip -------------------------------------------------------
// Regenerated ONLY when the underlying video changes or the ideal tile count
// moves materially (a resize). Caption state — position, scale, opacity,
// rotation, style, Rolling Stack, keyframes — is deliberately not an input
// here: thumbnails depend on the VIDEO, so none of those cause a rebuild.
let filmstripSrc = null;
let filmstripCount = 0;
let filmstripToken = 0;

function currentVideoSrc() {
  const video = getVideo();
  // currentSrc is the resolved URL the element actually decoded; it is empty
  // until a source is attached, which is the "no video yet" case.
  return video?.currentSrc || video?.src || null;
}

function clearFilmstrip() {
  if (els?.filmstripTrack) els.filmstripTrack.replaceChildren();
  filmstripSrc = null;
  filmstripCount = 0;
}

/**
 * Paints `count` placeholder tiles immediately, then fills each one in as its
 * frame arrives. Placeholders are what keep the row from shifting layout when
 * extraction finishes, and give a lightweight loading state for free.
 */
async function rebuildFilmstrip(src, count, trackWidth) {
  // The width each tile actually occupies on screen. filmstrip.js rasterizes to
  // exactly this (x devicePixelRatio) so tiles are never upscaled by the browser.
  const renderedTileWidth = trackWidth / count;
  const token = ++filmstripToken;
  const track = els.filmstripTrack;
  track.replaceChildren();
  track.classList.add('is-loading');

  const tiles = [];
  for (let i = 0; i < count; i++) {
    const tile = document.createElement('div');
    tile.className = 'timeline-filmstrip-tile';
    // Width as a PERCENTAGE, never fixed px: the row is a time axis, so tiles
    // must re-flow with the editor rather than carry baked-in coordinates.
    tile.style.width = `${100 / count}%`;
    track.appendChild(tile);
    tiles.push(tile);
  }

  try {
    await getFilmstrip(src, {
      count,
      tileWidthPx: renderedTileWidth,
      shouldAbort: () => token !== filmstripToken,
      onTile: (index, url) => {
        if (token !== filmstripToken) return;
        const tile = tiles[index];
        if (!tile) return;
        tile.style.backgroundImage = `url("${url}")`;
        tile.classList.add('is-loaded');
      }
    });
  } catch (err) {
    // A video that cannot be sampled at all (unsupported codec, decode error)
    // leaves the placeholders in place rather than breaking the timeline.
    console.warn('[Filmstrip] Thumbnail extraction failed:', err?.message || err);
  } finally {
    if (token === filmstripToken) track.classList.remove('is-loading');
  }
}

/**
 * Called from the existing tick loop. Cheap on every frame: it only measures
 * and compares, and does real work when the video or the ideal count changed.
 */
function syncFilmstrip(duration) {
  const track = els?.filmstripTrack;
  if (!track) return;
  const src = currentVideoSrc();

  if (!src || !(duration > 0)) {
    if (filmstripSrc !== null) clearFilmstrip();
    return;
  }

  const trackWidth = track.clientWidth;
  if (!(trackWidth > 0)) return; // not laid out yet (hidden/zero-width)

  const video = getVideo();
  const aspect = (video?.videoWidth || 0) / (video?.videoHeight || 1);
  const tileWidth = aspect > 0 ? FILMSTRIP_TILE_HEIGHT_PX * aspect : 0;
  const count = computeTileCount(trackWidth, duration, tileWidth);
  if (!count) return;

  const srcChanged = src !== filmstripSrc;
  const countChanged = Math.abs(count - filmstripCount) > FILMSTRIP_COUNT_CHANGE_THRESHOLD;
  if (!srcChanged && !countChanged) return;

  filmstripSrc = src;
  filmstripCount = count;
  rebuildFilmstrip(src, count, trackWidth);
}

function tick() {
  const video = getVideo();
  const duration = video?.duration || 0;
  const currentTime = video?.currentTime || 0;

  refreshRulerTicks(duration);
  refreshPlayhead(currentTime, duration);
  // Same cadence as the ruler/playhead, and equally cheap: this only rebuilds
  // when the video or the ideal tile count actually changed.
  syncFilmstrip(duration);
  // Audio clips are independent of the keyframe TARGET (a sound effect exists
  // whether or not a caption happens to be selected), so this refreshes on
  // every tick rather than inside the `hasTarget` branch below — and, like
  // the filmstrip, it only does real work when the data actually changed.
  refreshAudioLanes(duration);
  // Outside the hasTarget branch below, like the audio lanes: a text overlay
  // exists independently of whatever keyframe target happens to be selected.
  refreshTextLane(duration);
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
    // Desktop-only now: the precision fields no longer have an inline home in
    // the timeline (their rows aren't mounted — see buildDom), so the
    // mobile/tablet inline toggle would have nothing to show. The side panel
    // is where they live.
    els.advancedBtn.hidden = !isDesktop;
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
    clearMarkers(els.keyframeTrack);
    lastLaneSignature = null;
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
  // buildDom() just replaced every clip element, so the cached signature would
  // otherwise match and the (now empty) lanes would never be repopulated.
  lastAudioSignature = null;
  lastTextSignature = null;
  dragClip = null;
  timelineZoom = 1;
  autoFollow = true;
  programmaticScroll = false;
  applyAdvancedState();
  applyTimelineZoom(1);

  // The row width is derived from the panel's own width, so it has to be
  // recomputed whenever that changes — a window resize, or the bottom sheet
  // being dragged to a new height.
  const onResize = () => refreshTimelineZoom();
  window.addEventListener('resize', onResize);
  const panelObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => refreshTimelineZoom())
    : null;
  panelObserver?.observe(els.scroll);

  // Ctrl/Cmd + wheel zooms around the pointer, the way every timeline does.
  // Without the modifier the wheel keeps its normal scrolling behaviour.
  // Manual horizontal scrolling during playback hands control back to the
  // user: chasing the playhead while they are trying to inspect another part
  // of the timeline is the failure mode this guards against. Pressing play
  // again, scrubbing or seeking re-arms it (see below).
  const onScroll = () => {
    if (programmaticScroll) return;
    const video = getVideo();
    if (video && !video.paused && !video.ended) autoFollow = false;
  };
  els.scroll.addEventListener('scroll', onScroll, { passive: true });

  // Playback and seeking both mean "show me where I am now".
  const video = getVideo();
  const onPlay = () => resumeFollow();
  const onSeeked = () => resumeFollow();
  video?.addEventListener('play', onPlay);
  video?.addEventListener('seeked', onSeeked);

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    applyTimelineZoom(timelineZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX);
  };
  els.scroll.addEventListener('wheel', onWheel, { passive: false });

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

  // The filmstrip is a second view of the SAME axis, so it scrubs through the
  // same helper against its own track rect — it never becomes the source of
  // truth, it just writes #preview-video.currentTime like the ruler does.
  const scrubFilmstrip = (clientX) => {
    const video = getVideo();
    const duration = video?.duration || 0;
    if (!video || duration <= 0) return;
    const rect = els.filmstripTrack.getBoundingClientRect();
    if (!rect.width) return;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    video.currentTime = xToTime(x, rect.width, duration);
  };
  let filmstripScrubbing = false;
  els.filmstripTrack.addEventListener('pointerdown', (e) => {
    filmstripScrubbing = true;
    els.filmstripTrack.setPointerCapture(e.pointerId);
    // Touching the video strip selects the video as the keyframe/properties
    // target — the strip IS the video clip, so clicking it should select it
    // the same way clicking a caption on the canvas selects that caption.
    // The "Video" chip in the header still works and stays in sync (both
    // route through the same keyframeEngine selection), it is just no longer
    // the only way in.
    keyframeEngine.selectVideoTarget();
    // Clicking the video row is also a different selection intent from having
    // an audio clip selected, so the audio selection is cleared — otherwise
    // the Delete key would still be aimed at a clip the user has moved on from.
    audioTimeline.selectClip(null);
    scrubFilmstrip(e.clientX);
  });
  els.filmstripTrack.addEventListener('pointermove', (e) => { if (filmstripScrubbing) scrubFilmstrip(e.clientX); });
  els.filmstripTrack.addEventListener('pointerup', () => { filmstripScrubbing = false; });

  els.scroll.addEventListener('pointerdown', (e) => {
    // Clicking empty lane space (not a marker/clip) clears BOTH selections —
    // the "selected keyframe" and the selected audio clip — so the Delete key
    // has no stale target left over from an earlier selection.
    if (e.target === els.scroll || e.target.classList?.contains('timeline-lane-track')) {
      selectedMarkerTime = null;
      audioTimeline.selectClip(null);
    }
  });

  // "+ Sound" opens the sound picker (audition, then place at the playhead);
  // "+ Audio" goes straight to the OS file picker, since choosing a file IS
  // the choice — there is nothing to preview first.
  // "+ Text" creates an overlay at the playhead and selects it, so the Text
  // panel is already pointed at what was just created — the next action is
  // always "type the words".
  els.addTextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textElements.addTextElement({ kind: 'overlay', text: 'New text' });
  });

  // "+ Caption" creates a manual caption at the playhead. Same call, same
  // record, different kind — which is what decides its lane, its label and
  // whether it inherits the caption's anchored position (see
  // textElements.js's addTextElement).
  els.addCaptionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textElements.addTextElement({ kind: 'caption', text: 'New caption' });
  });

  els.addSoundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSoundPicker(els.addSoundBtn);
  });
  els.addAudioBtn.addEventListener('click', () => {
    promptForAudioFile(
      undefined,
      (err) => { console.error('[Timeline] Audio import failed:', err.message); }
    );
  });

  // The video strip's "+" reuses App.jsx's own hidden file input rather than
  // opening a second one of its own, so uploading from here goes through the
  // exact same transcription/processing pipeline as the upload dropzone —
  // one upload path, not two that can drift.
  els.addVideoBtn.addEventListener('click', () => {
    document.getElementById('video-file-input')?.click();
  });

  // Same dismiss-on-outside-tap behavior as every other transient surface in
  // the app (see the target-info popover below).
  const dismissSoundPickerOnOutsideClick = (e) => {
    // `contains`, not identity: the button's own child SVG is what a click
    // actually lands on, so an identity check would dismiss the picker on
    // pointerdown and let the following click immediately reopen it — making
    // the button impossible to toggle closed.
    if (soundPickerEl && !soundPickerEl.contains(e.target) && !els.addSoundBtn.contains(e.target)) closeSoundPicker();
  };
  document.addEventListener('pointerdown', dismissSoundPickerOnOutsideClick);

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
    document.removeEventListener('pointerdown', dismissSoundPickerOnOutsideClick);
    // The zoom/follow listeners outlive a re-init otherwise: initTimelinePanel
    // rebuilds the DOM, so a stale observer would go on measuring a detached
    // element and a stale video listener would call into a dead panel.
    window.removeEventListener('resize', onResize);
    panelObserver?.disconnect();
    els.scroll.removeEventListener('wheel', onWheel);
    els.scroll.removeEventListener('scroll', onScroll);
    video?.removeEventListener('play', onPlay);
    video?.removeEventListener('seeked', onSeeked);
    closeSoundPicker();
  };
}
