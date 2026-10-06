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
import { undo, redo, getHistoryState, appState, updateState, getStyleParams } from '../state.js';
import { resolveTextElementParams } from '../../../shared/textElement.js';
import { entranceFromParams, normalizeMotion } from '../../../shared/motion/motion.js';
import {
  getFilmstripWindow,
  chooseSecondsPerTile,
  tileTimesForWindow,
  filmstripTileWidth,
  FILMSTRIP_TILE_HEIGHT_PX
} from './filmstrip.js';
import * as audioTimeline from './audioTimeline.js';
import { previewSound } from './audioEngine.js';
import { promptForAudioFile } from './audioImport.js';
import { getSoundDefinition } from '../../../shared/soundRegistry.js';
import { getAudioTrackDuration } from '../../../shared/audioTimeline.js';
import * as textElements from './textElements.js';
import * as imageLayers from './imageLayers.js';
import * as shapeLayers from './shapeLayers.js';
import { SHAPE_KINDS, SHAPE_LABELS } from '../../../shared/shapeLayer.js';
import * as captionEvents from './captionEvents.js';
import * as rhythm from './rhythm.js';
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
let lastTargetHostKey = null;
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
  lastImageSignature = null;
  lastShapeSignature = null;
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
  // CapCut's toggle: on a keyframe it removes it, anywhere else it adds one.
  addBtn.addEventListener('click', () => {
    keyframeEngine.toggleKeyframeAtPlayhead();
    selectedMarkerTime = null;
  });
  controlsRow.appendChild(addBtn);

  // "+ Cinematic": a cinematic text interlude starting exactly at the
  // playhead (see textElements.js's addInterlude). In the header rather than
  // only in a lane gutter, so it is always in reach — the Cinematic lane
  // itself only takes up room once a project has an interlude (see
  // refreshTextLane), which keeps every other lane where it always was.
  const addInterludeBtn = document.createElement('button');
  addInterludeBtn.type = 'button';
  addInterludeBtn.className = 'timeline-add-keyframe-btn timeline-add-interlude-btn';
  addInterludeBtn.id = 'timeline-add-interlude-btn';
  addInterludeBtn.textContent = '+ Cinematic';
  addInterludeBtn.title = 'Cinematic text at the playhead — a full-frame text card replaces the picture; the audio keeps playing';
  addInterludeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textElements.addInterlude();
  });
  controlsRow.appendChild(addInterludeBtn);

  // "+ Image" — a picture at the playhead (shared/imageLayer.js). Its lane
  // only takes room once the project has one, like the Cinematic lane.
  const addImageBtn = document.createElement('button');
  addImageBtn.type = 'button';
  addImageBtn.className = 'timeline-add-keyframe-btn timeline-add-image-btn';
  addImageBtn.id = 'timeline-add-image-btn';
  addImageBtn.textContent = '+ Image';
  addImageBtn.title = 'Add a picture at the playhead (PNG, JPEG or WebP)';
  addImageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    imageLayers.promptForImageFile();
  });
  controlsRow.appendChild(addImageBtn);

  // "+ Shape" — a generated shape at the playhead (shared/shapeLayer.js),
  // picked from a short menu of the kinds there are.
  const addShapeBtn = document.createElement('button');
  addShapeBtn.type = 'button';
  addShapeBtn.className = 'timeline-add-keyframe-btn timeline-add-shape-btn';
  addShapeBtn.id = 'timeline-add-shape-btn';
  addShapeBtn.textContent = '+ Shape';
  addShapeBtn.title = 'Add a shape at the playhead';
  addShapeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleShapeMenu(addShapeBtn);
  });
  controlsRow.appendChild(addShapeBtn);

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

  // RHYTHM (src/js/components/rhythm.js): jump the playhead to the previous /
  // next beat, and snap dragged clips to beats. Shown only once the audio
  // has a usable rhythm — see refreshRhythmControls.
  const rhythmControls = document.createElement('div');
  rhythmControls.className = 'timeline-zoom-controls timeline-rhythm-controls';
  rhythmControls.id = 'timeline-rhythm-controls';
  rhythmControls.hidden = true;
  const prevBeatBtn = makeZoomBtn('timeline-prev-beat', '‹♩', 'Playhead to the previous beat');
  const nextBeatBtn = makeZoomBtn('timeline-next-beat', '♩›', 'Playhead to the next beat');
  const snapBtn = makeZoomBtn('timeline-snap-beats', 'Snap', 'Snap clips to beats while dragging');
  snapBtn.classList.add('timeline-snap-btn');
  const jump = (dir) => {
    const video = getVideo();
    if (!video) return;
    const beat = dir < 0 ? rhythm.previousBeatBefore(video.currentTime) : rhythm.nextBeatAfter(video.currentTime);
    if (beat) video.currentTime = beat.time;
  };
  prevBeatBtn.addEventListener('click', () => jump(-1));
  nextBeatBtn.addEventListener('click', () => jump(1));
  snapBtn.addEventListener('click', () => rhythm.setSnapToBeats(!appState.snapToBeats));
  rhythmControls.appendChild(prevBeatBtn);
  rhythmControls.appendChild(nextBeatBtn);
  rhythmControls.appendChild(snapBtn);
  controlsRow.appendChild(rhythmControls);
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
  // The beats, as small ticks along the ruler's foot (see refreshBeatMarkers).
  const beatLayer = document.createElement('div');
  beatLayer.className = 'timeline-beat-layer';
  beatLayer.id = 'timeline-beat-layer';
  ruler.appendChild(beatLayer);
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
  // The video row gets the same gutter-mounted "+" as every other lane, so
  // "add content to this track" is one consistent gesture — and, like the
  // others, stays put while the strip pans beneath it.
  const addVideoBtn = buildAddButton('timeline-add-video-btn', 'Upload a video');
  filmstripGutter.appendChild(addVideoBtn);
  filmstripRow.dataset.lane = 'video';
  addCollapseToggle(filmstripRow, filmstripGutter, 'video', 'Video');
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

  // CINEMATIC TEXT INTERLUDES get the top lane, directly under the picture:
  // for their span they REPLACE the picture (see shared/textElement.js), so
  // they belong next to it. Same record type and same gestures as the two
  // text lanes below — this lane is presentation only.
  const interludeLane = buildAudioLane('interlude', 'Cinematic', 'Add cinematic text at the playhead — the picture is replaced by a full-frame text card, the audio keeps playing');
  interludeLane.addBtn.id = 'timeline-add-interlude-lane-btn';
  // Hidden until the project has an interlude (see refreshTextLane).
  interludeLane.row.hidden = true;
  // IMAGE LAYERS get the lane directly under the picture they sit on — and,
  // like the Cinematic lane, only take room once there is one.
  const imagesLane = buildAudioLane('images', 'Images', 'Add a picture at the playhead');
  imagesLane.row.hidden = true;
  lanesEl.appendChild(imagesLane.row);
  // SHAPE LAYERS: their own lane, like images — and only once there is one.
  const shapesLane = buildAudioLane('shapes', 'Shapes', 'Add a shape at the playhead');
  shapesLane.row.hidden = true;
  lanesEl.appendChild(shapesLane.row);
  lanesEl.appendChild(interludeLane.row);
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
    addBtn, advancedBtn, timeReadout, ruler, beatLayer, rhythmControls, snapBtn, scroll, playhead, keyframeTrack, filmstripTrack,
    sfxTrack: sfxLane.track, audioTrack: audioLane.track, textTrack: textLane.track,
    captionsTrack: captionsLane.track, interludeTrack: interludeLane.track, interludeRow: interludeLane.row, addInterludeBtn: interludeLane.addBtn,
    imagesTrack: imagesLane.track, imagesRow: imagesLane.row, addImagesLaneBtn: imagesLane.addBtn,
    shapesTrack: shapesLane.track, shapesRow: shapesLane.row, addShapesLaneBtn: shapesLane.addBtn,
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
// --- Collapsing a lane -------------------------------------------------------
//
// Any lane — the video strip included — folds down to a slim strip that still
// shows WHERE its clips are, so a busy lane (a project's SFX can run to dozens
// of clips) can be put out of the way to work on another. Which lanes are
// folded is an editor preference, remembered per browser, not project data.
const COLLAPSED_STORAGE_KEY = 'bhynd.timeline.collapsed';

function readCollapsedLanes() {
  try {
    const list = JSON.parse(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedLanes(set) {
  try { window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...set])); } catch { /* preference only */ }
}

function setLaneCollapsed(row, button, key, label, collapsed) {
  row.classList.toggle('is-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label}`);
  button.title = collapsed ? `Expand ${label}` : `Collapse ${label}`;
}

/** Puts the fold toggle at the front of a lane's label column, restoring how the user last left it. */
function addCollapseToggle(row, gutter, key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'timeline-lane-collapse';
  button.dataset.collapseLane = key;
  button.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  // Never a scrub or a clip gesture underneath.
  button.addEventListener('pointerdown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = readCollapsedLanes();
    const next = !row.classList.contains('is-collapsed');
    if (next) collapsed.add(key); else collapsed.delete(key);
    writeCollapsedLanes(collapsed);
    setLaneCollapsed(row, button, key, label, next);
  });
  setLaneCollapsed(row, button, key, label, readCollapsedLanes().has(key));
  gutter.insertBefore(button, gutter.firstChild);
  return button;
}

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

  // The add control lives in the GUTTER, beside the lane's name.
  //
  // It used to sit inside the strip, on the reasoning that the strip is where
  // content goes so that is where the control to add content belongs. That
  // held while the timeline always fitted its panel. It stopped holding the
  // moment the timeline could pan: the strip scrolls, so an in-strip control
  // scrolls away with it — it drifted left across the labels and then off
  // screen entirely, leaving no way to add anything at the playhead, which is
  // exactly when you want to.
  //
  // The gutter is already sticky (it is the label column), so a control
  // mounted here is always reachable at any zoom or scroll position, and
  // unlike a sticky in-strip button it can never sit on top of a clip.
  gutter.appendChild(buildAddButton(`timeline-add-${key}-btn`, addTitle));
  addCollapseToggle(row, gutter, key, label);

  row.appendChild(gutter);
  row.appendChild(track);
  return { row, track, addBtn: gutter.querySelector('.timeline-add-clip-btn'), gutter };
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

// --- Beat markers -------------------------------------------------------------
//
// The rhythm (src/js/components/rhythm.js) as ticks along the ruler's foot:
// a short faint tick per beat, a taller brighter one per downbeat — enough to
// see the pulse without competing with the clips. Positioned in % of the
// clip, like everything else on the timeline, so zooming needs no redraw;
// rebuilt only when the beats themselves change.
let lastBeatsRef = null;
let lastBeatsDuration = -1;

function refreshBeatMarkers(duration) {
  const beats = rhythm.getTimelineBeats();
  if (beats === lastBeatsRef && duration === lastBeatsDuration) return;
  lastBeatsRef = beats;
  lastBeatsDuration = duration;
  els.beatLayer.replaceChildren();
  if (!(duration > 0)) return;
  const frag = document.createDocumentFragment();
  beats.forEach((b) => {
    const m = document.createElement('div');
    m.className = b.type === 'downbeat' ? 'timeline-beat is-downbeat' : 'timeline-beat';
    m.style.left = `${(b.time / duration) * 100}%`;
    // Stronger beats read a little brighter.
    m.style.opacity = String(0.35 + 0.65 * (b.strength ?? 1));
    frag.appendChild(m);
  });
  els.beatLayer.appendChild(frag);
}

function refreshRhythmControls() {
  const usable = rhythm.getTimelineBeats().length > 0;
  if (els.rhythmControls.hidden === usable) els.rhythmControls.hidden = !usable;
  els.snapBtn.classList.toggle('active', !!appState.snapToBeats);
  els.snapBtn.setAttribute('aria-pressed', String(!!appState.snapToBeats));
}

function refreshPlayhead(currentTime, duration) {
  const rulerRect = els.ruler.getBoundingClientRect();
  const scrollRect = els.scroll.getBoundingClientRect();
  if (!rulerRect.width) return;
  const x = timeToX(currentTime, rulerRect.width, duration);
  const left = (rulerRect.left - scrollRect.left) + els.scroll.scrollLeft + x;
  els.playhead.style.left = `${left}px`;
  // Full height of the CONTENT, not of the visible box. The line is absolute
  // inside the scroll container, where `bottom: 0` resolves against the
  // visible area — so once stacked clips made the lanes taller than the
  // panel, it stopped one screen-height down and scrolled away with the
  // content. Measured off the lanes block (the last content child), never off
  // scrollHeight, which would include the line itself and could never shrink.
  const lanes = document.getElementById('timeline-lanes');
  if (lanes) {
    const height = Math.max(els.scroll.clientHeight, lanes.offsetTop + lanes.offsetHeight);
    const value = `${height}px`;
    if (els.playhead.style.height !== value) {
      els.playhead.style.height = value;
      els.playhead.style.bottom = 'auto';
    }
  }
  // Driven from the SAME position the playhead was just drawn at, once per
  // frame, so the viewport can never disagree with where the playhead is —
  // and no extra layout is measured to do it.
  followPlayhead(left);
}

function clearMarkers(track) {
  track.querySelectorAll('.timeline-marker').forEach((el) => el.remove());
}

/**
 * Where a time sits across a host's span, as a CSS left: a clamp keeps a
 * diamond exactly on a clip's start or end edge whole instead of half-hidden
 * by the clip's own clipping.
 */
function markerLeft(t, span) {
  const pct = ((t - span.start) / Math.max(1e-6, span.end - span.start)) * 100;
  return span.clamp ? `clamp(5px, ${pct}%, calc(100% - 5px))` : `${pct}%`;
}

/**
 * A keyframe of something that is NOT selected, on its own clip: a small dim
 * diamond that only says "this has a keyframe here". Selecting the object
 * turns its diamonds into the editable ones (buildMarker).
 */
function buildPassiveMarker(t, span) {
  const marker = document.createElement('div');
  marker.className = 'timeline-marker filled is-passive';
  marker.style.left = markerLeft(t, span);
  marker.title = `Keyframe @ ${t.toFixed(2)}s — select this to edit it`;
  return marker;
}

/**
 * One editable keyframe of the ACTIVE target, on that target's own clip (or
 * on the video strip, for the video). `span` is the time range the host
 * element covers — the whole clip for the video strip, the clip's own
 * [start, end] for a caption or text clip — so position and drag both map
 * through it.
 */
function buildMarker(entry, span, role) {
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
  marker.style.left = markerLeft(entry.t, span);
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
    marker.style.left = markerLeft(span.start + (x / rect.width) * (span.end - span.start), span);
  });
  marker.addEventListener('pointerup', (e) => {
    if (!dragMarker) return;
    if (dragMarker.moved) {
      const rect = marker.parentElement.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const newTime = span.start + (x / rect.width) * (span.end - span.start);
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
      // Handled HERE, and only here: left to bubble, the same key reached the
      // document's Delete handler next — which, the keyframe now gone, deleted
      // whatever object was selected (a cinematic card, with its keyframe).
      e.stopPropagation();
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

  // A SELECTED KEYFRAME comes first. Its diamonds only show on the object
  // that is selected, so that object is always selected too — and checking
  // the object first made Backspace on a cinematic card's keyframe delete the
  // whole card. The keyframe selection can't go stale: it is cleared the
  // moment the user moves on (a clip pressed, empty lane pressed, a
  // different target selected, the keyframe button pressed).
  if (selectedMarkerTime != null) {
    e.preventDefault();
    keyframeEngine.deleteKeyframeAt(selectedMarkerTime);
    selectedMarkerTime = null;
    return;
  }

  // A selected AUDIO clip next: selecting a clip is a more specific intent
  // than the object a stale selection might still point at.
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

  if (imageLayers.removeSelectedImageLayer()) return;
  shapeLayers.removeSelectedShapeLayer();
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
// --- Which clip a keyframe belongs to ----------------------------------------
//
// Keyframes are drawn ON THE CLIP THEY ANIMATE (CapCut-style): the video's on
// the video strip, a caption's on its caption clip, a text overlay's or
// cinematic card's on its own clip. Before, every target's diamonds went on
// the video strip, so a caption's keyframes looked like the video's.

/** The caption clip (shared/captionEvent.js) a transcript caption, word or group is in. */
function captionEventFor({ phraseStart = null, wordIndex = null }) {
  const events = appState.captionEvents || [];
  if (wordIndex != null) {
    const byWord = events.find((e) => (e.wordIndices || []).includes(wordIndex));
    if (byWord) return byWord;
  }
  if (phraseStart == null) return null;
  // A phrase's transform key is its start in hundredths (shared/captionTransform.js).
  return events.find((e) => Math.round(e.start * 100) === Math.round(phraseStart * 100))
    || events.find((e) => phraseStart >= e.start && phraseStart < e.end)
    || null;
}

function clipElement(id) {
  return id ? els.scroll.querySelector(`[data-clip-id="${CSS.escape(id)}"]`) : null;
}

const VIDEO_HOST_KEY = 'video';

/** The active target's host: the element its diamonds go on, and the time span that element covers. */
function activeKeyframeHost(duration) {
  const host = keyframeEngine.getActiveTargetHost();
  const videoHost = { key: VIDEO_HOST_KEY, el: els.keyframeTrack, span: { start: 0, end: duration } };
  if (!host || host.kind === 'video') return videoHost;
  if (host.kind === 'text') {
    const element = (appState.textElements || []).find((e) => e.id === host.id);
    const el = clipElement(host.id);
    return element && el ? { key: host.id, el, span: { start: element.start, end: element.end, clamp: true } } : videoHost;
  }
  const event = captionEventFor({ phraseStart: host.phrase?.start ?? null, wordIndex: host.wordIndexes?.[0] ?? null });
  const el = event && clipElement(event.id);
  // A caption with no clip of its own on the timeline (no caption events
  // yet) keeps the old home rather than losing its diamonds.
  return event && el ? { key: event.id, el, span: { start: event.start, end: event.end, clamp: true } } : videoHost;
}

/**
 * Everything ELSE that has keyframes, grouped by the clip it is on — shown
 * as passive diamonds so a keyframed caption or overlay is recognisable at a
 * glance without selecting it. `activeEntries` is skipped (it is drawn as the
 * editable set).
 */
function passiveKeyframeHosts(duration, activeEntries) {
  const byKey = new Map();
  const add = (key, el, span, entries) => {
    if (!el || !entries?.length || entries === activeEntries) return;
    const host = byKey.get(key) || { key, el, span, times: new Set() };
    entries.forEach((k) => host.times.add(k.t));
    byKey.set(key, host);
  };
  add(VIDEO_HOST_KEY, els.keyframeTrack, { start: 0, end: duration }, appState.videoTransform?.keyframes);
  (appState.textElements || []).forEach((element) => {
    add(element.id, clipElement(element.id), { start: element.start, end: element.end, clamp: true }, element.keyframes);
  });
  Object.entries(appState.captionTransforms || {}).forEach(([key, override]) => {
    if (!override?.keyframes?.length) return;
    const event = /^w\d+$/.test(key)
      ? captionEventFor({ wordIndex: Number(key.slice(1)) })
      : captionEventFor({ phraseStart: Number(key) / 100 });
    if (event) add(event.id, clipElement(event.id), { start: event.start, end: event.end, clamp: true }, override.keyframes);
  });
  return [...byKey.values()];
}

/** The marker layer inside a host element (the video strip's overlay IS its layer). */
function markerLayer(hostEl) {
  if (hostEl === els.keyframeTrack) return hostEl;
  let layer = hostEl.querySelector(':scope > .timeline-kf-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'timeline-kf-layer';
    hostEl.appendChild(layer);
  }
  return layer;
}

function refreshLanes(duration) {
  // Never while a diamond is being dragged: rebuilding would destroy it
  // mid-gesture. Otherwise each layer is rebuilt only when what it should
  // show changes — and a clip that was itself rebuilt (losing its layer)
  // simply gets a new one. Scrubbing alone changes nothing here.
  if (!dragMarker) {
    const entries = keyframeEngine.getKeyframeEntries();
    const active = activeKeyframeHost(duration);
    const passive = passiveKeyframeHosts(duration, entries);
    const wanted = new Map();
    const want = (host, build, sig) => {
      const layer = markerLayer(host.el);
      const prev = wanted.get(layer);
      wanted.set(layer, { sig: (prev?.sig || '') + sig, builds: [...(prev?.builds || []), build] });
    };
    if (entries.length) {
      want(active, (layer) => {
        // `entries` is time-sorted (shared/keyframes.js keeps it so), so the
        // first and last really are the earliest and latest.
        const lastIdx = entries.length - 1;
        entries.forEach((entry, idx) => {
          const role = entries.length < 2 ? null : idx === 0 ? 'start' : idx === lastIdx ? 'end' : null;
          layer.appendChild(buildMarker(entry, active.span, role));
        });
      }, JSON.stringify({ a: entries, s: selectedMarkerTime, span: active.span }));
    }
    passive.forEach((host) => {
      const times = [...host.times].sort((a, b) => a - b);
      want(host, (layer) => times.forEach((t) => layer.appendChild(buildPassiveMarker(t, host.span))), JSON.stringify({ p: times, span: host.span }));
    });
    // Rebuild what changed; empty the layers nothing wants any more.
    wanted.forEach(({ sig, builds }, layer) => {
      if (layer.dataset.sig === sig) return;
      clearMarkers(layer);
      builds.forEach((b) => b(layer));
      layer.dataset.sig = sig;
    });
    [els.keyframeTrack, ...els.scroll.querySelectorAll('.timeline-kf-layer')].forEach((layer) => {
      if (wanted.has(layer) || !layer.dataset.sig) return;
      clearMarkers(layer);
      layer.dataset.sig = '';
    });
  }

  // The value fields show the SELECTED target's values — nothing to show without one.
  if (!keyframeEngine.getActiveTarget()) return;
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
    // Pressing a clip moves on from any selected keyframe: Delete now means the clip.
    selectedMarkerTime = null;
    // Each clip family owns its own selection key, so selecting a text clip
    // never leaves a stale audio selection behind that Delete would hit
    // first (and vice versa).
    if (kind === 'image') {
      // Releases every other selection in the same write.
      imageLayers.selectImageLayer(clip.id);
    } else if (kind === 'shape') {
      shapeLayers.selectShapeLayer(clip.id);
    } else if (kind === 'text') {
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
      grabOffsetSeconds: mode === 'move' ? pointerTime - (clip.startTime ?? clip.start ?? 0) : 0,
      // The text list as it was BEFORE the gesture — see endDrag.
      textBefore: kind === 'text' ? appState.textElements : null,
      // ...and the sounds, which a text move carries along if they are linked.
      soundsBefore: kind === 'text' ? appState.soundEvents : null,
      // The image list, for the same rewind-then-commit.
      imagesBefore: kind === 'image' ? appState.imageLayers : null,
      shapesBefore: kind === 'shape' ? appState.shapeLayers : null
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
    if (dragClip.moved) {
      // A text clip's live drag has already written its result with history
      // off, so a history snapshot taken now would equal the outcome and Undo
      // would do nothing (measured: the first Undo after a trim changed
      // nothing, the second deleted the element). Rewind to the pre-gesture
      // list first (history off), then commit the result (history on) — the
      // same fix the canvas gestures use (see canvasTransform.js).
      if (dragClip.kind === 'text' && dragClip.textBefore) {
        updateState({ textElements: dragClip.textBefore, soundEvents: dragClip.soundsBefore }, { recordHistory: false });
      }
      if (dragClip.kind === 'image' && dragClip.imagesBefore) {
        updateState({ imageLayers: dragClip.imagesBefore }, { recordHistory: false });
      }
      if (dragClip.kind === 'shape' && dragClip.shapesBefore) {
        updateState({ shapeLayers: dragClip.shapesBefore }, { recordHistory: false });
      }
      applyClipDrag(e.clientX, el, { recordHistory: true });
    }
    dragClip = null;
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    // A plain click (no drag) selects and moves the playhead to the clip, so
    // what you clicked is on the canvas, ready to edit. Matches what
    // clicking a keyframe marker already does.
    if (dragClip?.moved) return;
    const video = getVideo();
    if (!video || mode !== 'move') return;
    const start = clip.startTime ?? clip.start ?? 0;
    const shown = clipShownTime(kind, clip, start);
    // Already on the visible part of it: leave the playhead where it is.
    const end = clip.end ?? null;
    if (shown > start && video.currentTime >= shown && end != null && video.currentTime < end) return;
    video.currentTime = shown;
  });
}

/**
 * Where a click on a clip puts the playhead: its first frame, or — for
 * anything that ENTERS (fades, pops, slides in) — the first frame its entrance
 * has finished. An entrance starts fully transparent, so its first frame
 * shows nothing: a cinematic interlude clicked on the timeline showed only
 * its background, the text invisible until the playhead was nudged forward.
 * Capped at the clip's middle so a short clip with a long entrance still
 * lands inside itself. Sounds and audio keep their start — there, the start
 * is what you want to hear.
 */
function clipShownTime(kind, clip, start) {
  let entrance = null;
  if (kind === 'text') {
    entrance = entranceFromParams(resolveTextElementParams(getStyleParams(), clip, start));
  } else if (kind === 'caption') {
    entrance = entranceFromParams(getStyleParams());
  } else if (kind === 'image' || kind === 'shape') {
    entrance = (clip.motions || []).map(normalizeMotion).find((m) => m?.kind === 'entrance') || null;
  }
  if (!entrance || !(entrance.duration > 0)) return start;
  const end = Number.isFinite(clip.end) ? clip.end : start + entrance.duration;
  return Math.min(start + entrance.duration, start + (end - start) / 2);
}

/** The clip kinds a beat snap applies to — the visual objects. */
const SNAP_KINDS = new Set(['text', 'image', 'shape']);
/** How close, on screen, a beat must be to catch an edge. */
const SNAP_PX = 8;

function clipLength(kind, id) {
  const list = kind === 'text' ? appState.textElements : kind === 'image' ? appState.imageLayers : kind === 'shape' ? appState.shapeLayers : null;
  const item = (list || []).find((x) => x.id === id);
  return item ? item.end - item.start : null;
}

/** Translates the pointer's X into the timeline edit this drag represents. */
function applyClipDrag(clientX, el, options) {
  const track = el.closest('.timeline-lane-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const duration = getVideo()?.duration || 0;
  if (!rect.width || duration <= 0) return;
  const rawPointerTime = xToTime(Math.max(0, Math.min(rect.width, clientX - rect.left)), rect.width, duration);

  // BEAT SNAP (src/js/components/rhythm.js) — only when the user has turned
  // it on, only for visual objects (images, shapes, text and cinematic
  // cards; never sounds, audio or the transcript's captions), and only when
  // a beat is within SNAP_PX on screen at the current zoom.
  const snaps = SNAP_KINDS.has(dragClip.kind);
  const threshold = (SNAP_PX / rect.width) * duration;
  const pointerTime = snaps && dragClip.mode !== 'move' ? rhythm.maybeSnapToBeat(rawPointerTime, threshold) : rawPointerTime;

  if (dragClip.mode === 'move') {
    let nextStart = rawPointerTime - dragClip.grabOffsetSeconds;
    if (snaps && appState.snapToBeats) {
      // Whichever edge is nearer a beat lands on it.
      const length = clipLength(dragClip.kind, dragClip.id);
      const byStart = rhythm.maybeSnapToBeat(nextStart, threshold) - nextStart;
      const byEnd = length != null ? rhythm.maybeSnapToBeat(nextStart + length, threshold) - (nextStart + length) : 0;
      const moves = [byStart, byEnd].filter((d) => d !== 0);
      if (moves.length) nextStart += moves.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    }
    if (dragClip.kind === 'sound') audioTimeline.moveSoundEvent(dragClip.id, nextStart, options);
    else if (dragClip.kind === 'text') textElements.moveTextElement(dragClip.id, nextStart, options);
    else if (dragClip.kind === 'image') imageLayers.moveImageLayer(dragClip.id, nextStart, options);
    else if (dragClip.kind === 'shape') shapeLayers.moveShapeLayer(dragClip.id, nextStart, options);
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
  // A picture has no media timing either: trimming an edge is a plain retime.
  if (dragClip.kind === 'image') {
    imageLayers.trimImageLayer(dragClip.id, dragClip.mode === 'trim-start' ? 'start' : 'end', pointerTime, options);
    return;
  }
  if (dragClip.kind === 'shape') {
    shapeLayers.trimShapeLayer(dragClip.id, dragClip.mode === 'trim-start' ? 'start' : 'end', pointerTime, options);
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

  // Replace, on the capsule itself. The same action already existed in the
  // Audio inspector's list, but that is not where you are looking when you
  // hear the wrong sound — you are looking at the clip that made it. Opens
  // the library panel in replace mode (see SoundLibraryPanel), so it is the
  // same picker and the same list, not a second workflow.
  //
  // pointerdown is stopped, not just click: attachClipPointerHandlers starts a
  // drag on pointerdown, so without this, pressing the button would begin
  // retiming the clip under the cursor.
  const replaceBtn = document.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'timeline-sfx-clip-replace';
  replaceBtn.title = `Replace ${definition.label}`;
  replaceBtn.setAttribute('aria-label', `Replace ${definition.label}`);
  replaceBtn.dataset.replaceClip = event.id;
  replaceBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>';
  replaceBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  replaceBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    audioTimeline.selectClip(event.id);
    activeOptions?.onSoundReplace?.(event.id);
  });
  el.appendChild(replaceBtn);

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
  if (element.kind === 'interlude') {
    el.classList.add('is-interlude');
    // Its own background colour is the clip's swatch, so two interludes read
    // apart on the lane at a glance.
    el.style.setProperty('--interlude-swatch', element.background?.color || '#FFFFFF');
  }

  el.style.left = `${timeToPercent(element.start, duration)}%`;
  el.style.width = `${Math.max(1, timeToPercent(element.end, duration) - timeToPercent(element.start, duration))}%`;
  el.dataset.clipId = element.id;
  el.tabIndex = 0;
  el.title = `${element.text || '(empty)'} · ${element.start.toFixed(2)}s → ${element.end.toFixed(2)}s`
    + ' — drag to move, drag an edge to retime, Delete to remove';

  const label = document.createElement('span');
  label.className = 'timeline-text-clip-label';
  // An interlude's text can be several lines; the lane shows it as one.
  label.textContent = String(element.text || '').replace(/\s+/g, ' ').trim()
    || (element.kind === 'caption' ? 'Caption' : element.kind === 'interlude' ? 'Cinematic' : 'Text');
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
 * One clip for one image layer — the same `.timeline-text-clip` element
 * (and so the same gestures, trim handles, selection and stacking) as a text
 * clip, routed as kind 'image'; the picture itself is its thumbnail.
 */
function buildImageClip(layer, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-text-clip is-image';
  if (isSelected) el.classList.add('selected');
  if (!layer.enabled) el.classList.add('disabled');
  el.style.left = `${timeToPercent(layer.start, duration)}%`;
  el.style.width = `${Math.max(1, timeToPercent(layer.end, duration) - timeToPercent(layer.start, duration))}%`;
  el.dataset.clipId = layer.id;
  el.tabIndex = 0;
  el.title = `${layer.name || 'Image'} · ${layer.start.toFixed(2)}s → ${layer.end.toFixed(2)}s — drag to move, drag an edge to retime, Delete to remove`;
  const thumbUrl = imageLayers.getImagePictureUrl(layer.assetId);
  if (thumbUrl) {
    const thumb = document.createElement('span');
    thumb.className = 'timeline-image-clip-thumb';
    thumb.style.backgroundImage = `url("${thumbUrl}")`;
    el.appendChild(thumb);
  }
  const label = document.createElement('span');
  label.className = 'timeline-text-clip-label';
  label.textContent = layer.name || 'Image';
  el.appendChild(label);
  attachClipPointerHandlers(el, layer, 'image', 'move');
  ['start', 'end'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `timeline-text-clip-handle ${edge}`;
    handle.title = edge === 'start' ? 'Change when it appears' : 'Change when it disappears';
    attachClipPointerHandlers(handle, layer, 'image', edge === 'start' ? 'trim-start' : 'trim-end');
    el.appendChild(handle);
  });
  return el;
}

/** One clip for one shape layer — the same clip element and gestures, kind 'shape'. Its fill colour is its swatch. */
function buildShapeClip(shape, duration, isSelected) {
  const el = document.createElement('div');
  el.className = 'timeline-text-clip is-shape';
  if (isSelected) el.classList.add('selected');
  if (!shape.enabled) el.classList.add('disabled');
  el.style.left = `${timeToPercent(shape.start, duration)}%`;
  el.style.width = `${Math.max(1, timeToPercent(shape.end, duration) - timeToPercent(shape.start, duration))}%`;
  el.style.setProperty('--shape-swatch', shape.appearance.fill.enabled ? shape.appearance.fill.color : 'transparent');
  el.dataset.clipId = shape.id;
  el.tabIndex = 0;
  el.title = `${SHAPE_LABELS[shape.kind]} · ${shape.start.toFixed(2)}s → ${shape.end.toFixed(2)}s — drag to move, drag an edge to retime, Delete to remove`;
  const swatch = document.createElement('span');
  swatch.className = `timeline-shape-clip-swatch kind-${shape.kind}`;
  el.appendChild(swatch);
  const label = document.createElement('span');
  label.className = 'timeline-text-clip-label';
  label.textContent = SHAPE_LABELS[shape.kind];
  el.appendChild(label);
  attachClipPointerHandlers(el, shape, 'shape', 'move');
  ['start', 'end'].forEach((edge) => {
    const handle = document.createElement('div');
    handle.className = `timeline-text-clip-handle ${edge}`;
    handle.title = edge === 'start' ? 'Change when it appears' : 'Change when it disappears';
    attachClipPointerHandlers(handle, shape, 'shape', edge === 'start' ? 'trim-start' : 'trim-end');
    el.appendChild(handle);
  });
  return el;
}

let lastShapeSignature = null;
function refreshShapeLane(duration) {
  const shapes = appState.shapeLayers || [];
  const selectedId = appState.selectedShapeLayerId;
  const signature = JSON.stringify({ shapes, selectedId, duration });
  if (signature === lastShapeSignature || dragClip) return;
  lastShapeSignature = signature;
  clearClips(els.shapesTrack);
  els.shapesRow.hidden = shapes.length === 0;
  if (!(duration > 0) || !shapes.length) return;
  const clips = shapes.map((shape) => {
    const clip = buildShapeClip(shape, duration, shape.id === selectedId);
    els.shapesTrack.appendChild(clip);
    return clip;
  });
  sizeLaneForRows(els.shapesTrack, stackClips(els.shapesTrack, clips));
}

/** The "+ Shape" menu: one row per kind; picking one adds it at the playhead. */
function closeShapeMenu() {
  document.getElementById('timeline-shape-menu')?.remove();
}
function toggleShapeMenu(anchor) {
  if (document.getElementById('timeline-shape-menu')) { closeShapeMenu(); return; }
  const menu = document.createElement('div');
  menu.id = 'timeline-shape-menu';
  menu.className = 'timeline-convert-menu';
  SHAPE_KINDS.forEach((kind) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'timeline-convert-menu-item';
    item.dataset.shapeKind = kind;
    item.textContent = SHAPE_LABELS[kind];
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeShapeMenu();
      shapeLayers.addShapeLayer(kind);
    });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  setTimeout(() => document.addEventListener('pointerdown', function away(ev) {
    if (!menu.contains(ev.target)) { closeShapeMenu(); document.removeEventListener('pointerdown', away, true); }
  }, true), 0);
}

let lastImageSignature = null;
function refreshImageLane(duration) {
  const layers = appState.imageLayers || [];
  const selectedId = appState.selectedImageLayerId;
  // The thumbnails' readiness is part of it, so a picture finishing loading
  // after a reload shows up on its clip.
  const thumbs = layers.map((l) => !!imageLayers.getImagePictureUrl(l.assetId));
  const signature = JSON.stringify({ layers, selectedId, duration, thumbs });
  if (signature === lastImageSignature || dragClip) return;
  lastImageSignature = signature;
  clearClips(els.imagesTrack);
  els.imagesRow.hidden = layers.length === 0;
  if (!(duration > 0) || !layers.length) return;
  const clips = layers.map((layer) => {
    const clip = buildImageClip(layer, duration, layer.id === selectedId);
    els.imagesTrack.appendChild(clip);
    return clip;
  });
  sizeLaneForRows(els.imagesTrack, stackClips(els.imagesTrack, clips));
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

  // "Turn this caption into…" — cinematic text or a text overlay, taking the
  // caption's own span, words, timing and edits (see textElements.js's
  // convertCaptionToTextElement). On the capsule, for the same reason Replace
  // is on a sound clip: this is where you are looking when you decide a line
  // deserves more than a caption. pointerdown is stopped so pressing it can't
  // start a drag of the capsule underneath.
  const convertBtn = document.createElement('button');
  convertBtn.type = 'button';
  convertBtn.className = 'timeline-caption-convert';
  convertBtn.dataset.convertCaption = event.id;
  convertBtn.title = 'Turn this caption into cinematic text or a text overlay';
  convertBtn.setAttribute('aria-label', 'Turn this caption into cinematic text or a text overlay');
  convertBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>';
  convertBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  convertBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    captionEvents.selectCaptionEvent(event.id);
    openCaptionConvertMenu(convertBtn, event.id);
  });
  el.appendChild(convertBtn);

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

/**
 * The capsule's two-item menu: "Cinematic text" / "Text overlay". A small
 * popover on <body> — fixed-positioned, like the old sound picker was, so the
 * timeline's own scroll container can't clip it. Closes on a choice, an
 * outside press, Escape, or any scroll.
 */
let convertMenu = null;
function closeCaptionConvertMenu() {
  if (!convertMenu) return;
  convertMenu.cleanup();
  convertMenu.el.remove();
  convertMenu = null;
}
function openCaptionConvertMenu(anchor, captionEventId) {
  closeCaptionConvertMenu();
  const el = document.createElement('div');
  el.className = 'timeline-convert-menu';
  el.id = 'timeline-convert-menu';
  el.setAttribute('role', 'menu');
  const heading = document.createElement('div');
  heading.className = 'timeline-convert-menu-heading';
  heading.textContent = 'Turn caption into';
  el.appendChild(heading);
  [
    { kind: 'interlude', label: 'Cinematic text', hint: 'Full-frame card, audio keeps playing' },
    { kind: 'overlay', label: 'Text overlay', hint: 'Free text over the video' }
  ].forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'timeline-convert-menu-item';
    btn.dataset.convertTo = item.kind;
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = '<span class="timeline-convert-menu-label"></span><span class="timeline-convert-menu-hint"></span>';
    btn.querySelector('.timeline-convert-menu-label').textContent = item.label;
    btn.querySelector('.timeline-convert-menu-hint').textContent = item.hint;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCaptionConvertMenu();
      textElements.convertCaptionToTextElement(captionEventId, item.kind);
    });
    el.appendChild(btn);
  });
  document.body.appendChild(el);

  // Below the button, kept on screen.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
  const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  el.style.left = left + 'px';
  el.style.top = top + 'px';

  const onDown = (e) => { if (!el.contains(e.target)) closeCaptionConvertMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeCaptionConvertMenu(); };
  const onScroll = () => closeCaptionConvertMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
  convertMenu = {
    el,
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    }
  };
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
  clearClips(els.interludeTrack);
  if (!(duration > 0)) return;

  // Split by kind, not by type: both lanes hold the same records and build
  // the same clip element (see buildTextClip), so every drag/trim/select/
  // delete path stays shared — only which strip a clip is appended to
  // depends on its kind.
  const captionClips = [];
  const overlayClips = [];
  const interludeClips = [];

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
    } else if (element.kind === 'interlude') {
      interludeClips.push(clip);
      els.interludeTrack.appendChild(clip);
    } else {
      overlayClips.push(clip);
      els.textTrack.appendChild(clip);
    }
  });
  // Stacked AFTER appending — the packer measures the real laid-out boxes.
  sizeLaneForRows(els.textTrack, stackClips(els.textTrack, overlayClips));
  sizeLaneForRows(els.captionsTrack, stackClips(els.captionsTrack, captionClips));
  sizeLaneForRows(els.interludeTrack, stackClips(els.interludeTrack, interludeClips));
  els.interludeTrack.classList.toggle('is-empty', interludeClips.length === 0);
  // The lane only costs vertical space once there is something on it.
  els.interludeRow.hidden = interludeClips.length === 0;
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

// --- "+ Sound" -------------------------------------------------------------
//
// The list itself lives in a side panel now (src/components/SoundLibraryPanel.jsx)
// rather than in a popover this module builds and positions.
//
// It was a popover anchored to the button, appended to <body> and
// fixed-positioned because the lane gutter sits inside .timeline-scroll
// inside a short panel — a popover opening from there was clipped by that
// scroll container AND painted under the preview above it. That was fine for
// eleven sounds. At thirty-eight it has to group and scroll, which a panel
// does naturally and a popover pinned to a button does not.
//
// So this module no longer owns any picker DOM; it just reports the press.
// Whether a panel is open, and where it renders, is React's business.

function closeSoundPicker() {
  activeOptions?.onSoundLibraryClose?.();
}

function openSoundPicker() {
  activeOptions?.onSoundLibraryToggle?.();
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
let filmstripToken = 0;
// What the strip currently shows: the video, the grid interval, and which
// slots are mounted. Compared once per tick so a pan that changes nothing
// costs a string compare.
let filmstripSignature = '';
// slotIndex -> tile element, so panning reuses the elements already mounted
// instead of rebuilding the row (which would flash and drop loaded frames).
const filmstripTiles = new Map();

function currentVideoSrc() {
  const video = getVideo();
  // currentSrc is the resolved URL the element actually decoded; it is empty
  // until a source is attached, which is the "no video yet" case.
  return video?.currentSrc || video?.src || null;
}

function clearFilmstrip() {
  if (els?.filmstripTrack) els.filmstripTrack.replaceChildren();
  filmstripTiles.clear();
  filmstripSignature = '';
  filmstripSrc = null;
}

/**
 * Fills the mounted tiles of the current window, reusing any frame already
 * cached and extracting only the rest. Tiles are mounted by syncFilmstrip
 * before this runs, so the row never shifts layout as frames arrive.
 */
async function paintFilmstripWindow(src, slots, tileWidthPx, token) {
  const track = els.filmstripTrack;
  track.classList.add('is-loading');
  // Slot index by sample time, so a frame arriving (cached or fresh) can find
  // the tile it belongs to without the extractor knowing about the DOM.
  const byTime = new Map(slots.map((slot) => [Math.round(slot.t * 1000), slot.index]));

  try {
    await getFilmstripWindow(src, {
      slots,
      tileWidthPx,
      shouldAbort: () => token !== filmstripToken,
      onTile: (t, url) => {
        if (token !== filmstripToken) return;
        const tile = filmstripTiles.get(byTime.get(Math.round(t * 1000)));
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
 * Called from the existing tick loop. Cheap on every frame: it measures, builds
 * a signature, and does real work only when the visible window actually moved.
 *
 * The strip is VIRTUALIZED. Tiles sit on a fixed time grid at their natural
 * width however long the clip is or how far it is zoomed, and only the slots
 * inside the visible window (plus a margin) are mounted and extracted — so the
 * cost is bounded by how many tiles fit on screen rather than by the clip.
 *
 * The previous version sampled a fixed number of frames across the WHOLE clip
 * and stretched them to fill the row, which is why a zoomed timeline showed
 * enormous, soft frames: the count was capped at 40, so at 2.3x each portrait
 * frame was drawn about three times its natural width.
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
  const tileWidth = filmstripTileWidth(aspect);

  // The track is the whole clip, so this is the zoom expressed as a rate —
  // the same relationship every other part of the timeline uses, rather than
  // a second pixels-per-second notion.
  const pixelsPerSecond = trackWidth / duration;
  const step = chooseSecondsPerTile(tileWidth, pixelsPerSecond);

  // The visible window, measured from the track's own box against the scroll
  // viewport. Deriving it this way needs no knowledge of the gutter's width
  // or of the current scroll offset.
  const trackRect = track.getBoundingClientRect();
  const scrollRect = els.scroll.getBoundingClientRect();
  const visibleLeftPx = Math.max(0, scrollRect.left - trackRect.left);
  const visibleRightPx = Math.min(trackWidth, visibleLeftPx + scrollRect.width);
  const marginPx = scrollRect.width * 0.5;
  const windowStart = Math.max(0, (visibleLeftPx - marginPx) / pixelsPerSecond);
  const windowEnd = Math.min(duration, (visibleRightPx + marginPx) / pixelsPerSecond);

  const slots = tileTimesForWindow(windowStart, windowEnd, step, duration);
  if (!slots.length) return;

  const signature = `${src}|${step}|${slots[0].index}|${slots[slots.length - 1].index}|${Math.round(trackWidth)}`;
  if (signature === filmstripSignature) return;

  if (src !== filmstripSrc) {
    clearFilmstrip();
    filmstripSrc = src;
  }
  filmstripSignature = signature;

  const token = ++filmstripToken;
  const wanted = new Set(slots.map((slot) => slot.index));

  // Drop tiles that have panned out of the window, keeping the rest mounted —
  // rebuilding the row instead would flash and throw away loaded frames.
  filmstripTiles.forEach((el, index) => {
    if (!wanted.has(index)) {
      el.remove();
      filmstripTiles.delete(index);
    }
  });

  slots.forEach((slot) => {
    let tile = filmstripTiles.get(slot.index);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'timeline-filmstrip-tile';
      track.appendChild(tile);
      filmstripTiles.set(slot.index, tile);
    }
    // Positioned by TIME as a percentage, never in px: the row is a time axis,
    // so a tile must re-flow with zoom rather than carry baked-in coordinates.
    const span = slot.span ?? step;
    tile.style.left = `${(slot.slotStart / duration) * 100}%`;
    tile.style.width = `${(Math.min(span, duration - slot.slotStart) / duration) * 100}%`;
  });

  // The width a tile is actually DISPLAYED at — frames are rasterized to
  // exactly this (x devicePixelRatio) so the browser never upscales them.
  paintFilmstripWindow(src, slots, step * pixelsPerSecond, token);
}

function tick() {
  const video = getVideo();
  const duration = video?.duration || 0;
  const currentTime = video?.currentTime || 0;

  refreshRulerTicks(duration);
  refreshBeatMarkers(duration);
  refreshRhythmControls();
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
  refreshImageLane(duration);
  refreshShapeLane(duration);
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
  // A selected keyframe belongs to ONE object: selecting another — even of
  // the same kind (a second card, another caption) — lets it go, so Delete
  // can never remove a keyframe from something no longer selected.
  const host = keyframeEngine.getActiveTargetHost();
  const hostKey = host ? `${host.kind}|${host.id ?? ''}|${host.phrase?.start ?? ''}|${(host.wordIndexes || []).join(',')}` : '';
  if (hostKey !== lastTargetHostKey) {
    lastTargetHostKey = hostKey;
    selectedMarkerTime = null;
  }
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
    const onKeyframe = hasTarget && keyframeEngine.hasKeyframeAtPlayhead();
    els.addBtn.classList.toggle('active', onKeyframe);
    // Says what the press will do.
    const label = onKeyframe ? '◇ Remove keyframe' : '◆ Keyframe';
    if (els.addBtn.textContent !== label) {
      els.addBtn.textContent = label;
      els.addBtn.title = onKeyframe ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead';
    }
  }
  LANES.forEach((lane) => {
    const { inputs } = laneEls[lane.key];
    lane.properties.forEach(({ property }) => { inputs[property].disabled = !hasTarget; });
  });

  // Even with nothing selected: every keyframed clip still shows that it
  // has keyframes (passively) — see refreshLanes.
  if (duration > 0) {
    refreshLanes(duration);
  } else {
    [els.keyframeTrack, ...els.scroll.querySelectorAll('.timeline-kf-layer')].forEach((layer) => {
      clearMarkers(layer);
      layer.dataset.sig = '';
    });
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
  lastImageSignature = null;
  lastShapeSignature = null;
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

  // Empty space on ANY lane scrubs too, like the ruler and the video strip:
  // press anywhere along the timeline to put the playhead there, drag to
  // scrub. Every lane track shares the ruler's axis, so the track pressed is
  // its own reference. Clips, diamonds and buttons are not empty space —
  // they keep their own gestures.
  let laneScrubTrack = null;
  const scrubLane = (clientX) => {
    const video = getVideo();
    const duration = video?.duration || 0;
    if (!video || duration <= 0 || !laneScrubTrack) return;
    const rect = laneScrubTrack.getBoundingClientRect();
    if (!rect.width) return;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    video.currentTime = xToTime(x, rect.width, duration);
  };
  els.scroll.addEventListener('pointerdown', (e) => {
    // Clicking empty lane space (not a marker/clip) clears BOTH selections —
    // the "selected keyframe" and the selected audio clip — so the Delete key
    // has no stale target left over from an earlier selection.
    const onEmptyTrack = e.target.classList?.contains('timeline-lane-track');
    if (e.target === els.scroll || onEmptyTrack) {
      selectedMarkerTime = null;
      audioTimeline.selectClip(null);
    }
    if (onEmptyTrack && e.button === 0) {
      laneScrubTrack = e.target;
      laneScrubTrack.setPointerCapture(e.pointerId);
      scrubLane(e.clientX);
    }
  });
  els.scroll.addEventListener('pointermove', (e) => { if (laneScrubTrack) scrubLane(e.clientX); });
  const endLaneScrub = () => { laneScrubTrack = null; };
  els.scroll.addEventListener('pointerup', endLaneScrub);
  els.scroll.addEventListener('pointercancel', endLaneScrub);

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
  // The Cinematic lane's own "+" — the same action as the header button.
  els.addInterludeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textElements.addInterlude();
  });

  els.addShapesLaneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleShapeMenu(els.addShapesLaneBtn);
  });

  els.addImagesLaneBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    imageLayers.promptForImageFile();
  });

  els.addCaptionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    textElements.addTextElement({ kind: 'caption', text: 'New caption' });
  });

  els.addSoundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSoundPicker();
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
    // (The sound library panel handles its own outside-press dismissal —
    // see SoundLibraryPanel.jsx.)
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
