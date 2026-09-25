/**
 * THE one module that mutates appState.captionEvents — the transcript's own
 * captions, once they became editable objects rather than a derived grouping
 * (see shared/captionEvent.js for why that had to change).
 *
 * Every write here ALSO rewrites appState.phrases, because `phrases` is now a
 * projection of these events rather than a separate source of truth. That
 * single rule is what let captions become editable without touching a single
 * renderer: the preview, the canvas transform overlay and the export frame
 * generator all still consume phrases in exactly the shape they always have.
 *
 * Same conventions as textElements.js / audioTimeline.js, for the same
 * reasons: one write function, a NEW array reference every time (updateState
 * compares by identity), `recordHistory: false` during a live drag and `true`
 * on the commit so a gesture is one undo step.
 */
import { appState, updateState } from '../state.js';
import {
  captionEventsFromPhrases,
  resolveCaptionPhrases,
  normalizeCaptionEvent,
  moveCaptionEvent as moveEvent,
  trimCaptionEvent as trimEvent,
  splitCaptionEvent,
  mergeCaptionEvents,
  MIN_CAPTION_EVENT_DURATION
} from '../../../shared/captionEvent.js';

export function getCaptionEvents() {
  return appState.captionEvents || [];
}

export function getCaptionEvent(id) {
  return getCaptionEvents().find((e) => e.id === id) || null;
}

/**
 * The one write path. `wordPatches` lets a move carry its words along in the
 * SAME state update — two updateState calls would be two undo steps and would
 * leave a frame rendered from half-moved data in between.
 */
function writeCaptionEvents(next, { recordHistory = true, wordPatches = null } = {}) {
  const sorted = next.slice().sort((a, b) => a.start - b.start);
  const updates = { captionEvents: sorted };

  if (wordPatches && wordPatches.length) {
    const words = (appState.words || []).slice();
    wordPatches.forEach(({ index, start, end }) => {
      if (words[index]) words[index] = { ...words[index], start, end };
    });
    updates.words = words;
    updates.phrases = resolveCaptionPhrases(words, sorted);
  } else {
    updates.phrases = resolveCaptionPhrases(appState.words || [], sorted);
  }

  updateState(updates, { recordHistory });
}

/**
 * Captures the grouper's output as editable events — the one-time handoff
 * when a transcript lands.
 *
 * Deliberately refuses to run when events already exist: re-capturing would
 * throw away every retime, split and merge the user has made, which is
 * precisely what this model exists to preserve. A regenerate that returns
 * freshly grouped phrases therefore does NOT clobber an edited caption list;
 * `force` is for genuinely starting over (a new upload).
 */
export function captureCaptionEventsFromPhrases(phrases, { force = false } = {}) {
  if (!force && getCaptionEvents().length) return getCaptionEvents();
  const events = captionEventsFromPhrases(phrases);
  // recordHistory:false — this is the transcript arriving, not an edit the
  // user made, and it must not become an undo step they can step back into
  // (which would leave them with no captions at all).
  writeCaptionEvents(events, { recordHistory: false });
  return events;
}

/** Re-projects phrases from the current words — after a transcript text edit. */
export function refreshPhrasesFromCaptionEvents() {
  const events = getCaptionEvents();
  if (!events.length) return;
  updateState(
    { phrases: resolveCaptionPhrases(appState.words || [], events) },
    { recordHistory: false }
  );
}

function replaceEvent(id, nextEvent, options) {
  const events = getCaptionEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const next = events.slice();
  next[idx] = nextEvent;
  writeCaptionEvents(next, options);
  return nextEvent;
}

/** Moves a caption, carrying its words so the karaoke highlight follows it. */
export function moveCaptionEventTo(id, nextStart, { recordHistory = true } = {}) {
  const event = getCaptionEvent(id);
  if (!event) return null;
  const duration = event.end - event.start;
  const videoDuration = appState.videoDuration || 0;
  const maxStart = videoDuration > 0 ? Math.max(0, videoDuration - duration) : Number.MAX_SAFE_INTEGER;
  const clamped = Math.min(maxStart, Math.max(0, nextStart));

  const { event: moved, wordPatches } = moveEvent(event, clamped, appState.words || []);
  const events = getCaptionEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const next = events.slice();
  next[idx] = moved;
  writeCaptionEvents(next, { recordHistory, wordPatches });
  return moved;
}

/** Retimes one edge. The words stay put — see trimCaptionEvent. */
export function trimCaptionEventEdge(id, edge, time, options) {
  const event = getCaptionEvent(id);
  if (!event) return null;
  return replaceEvent(id, trimEvent(event, edge, Math.max(0, time)), options);
}

/**
 * Splits a caption after its `afterPosition`-th word — the operation that was
 * impossible while phrases were derived.
 */
export function splitCaptionEventAt(id, afterPosition) {
  const event = getCaptionEvent(id);
  if (!event) return null;
  const halves = splitCaptionEvent(event, afterPosition, appState.words || []);
  if (!halves) return null;
  const events = getCaptionEvents();
  const idx = events.findIndex((e) => e.id === id);
  const next = events.slice();
  next.splice(idx, 1, ...halves);
  writeCaptionEvents(next);
  return halves;
}

/** Splits at whichever word boundary is nearest `time` — what a playhead split means. */
export function splitCaptionEventAtTime(id, time) {
  const event = getCaptionEvent(id);
  if (!event) return null;
  const words = appState.words || [];
  // The break goes after the last word that has already started by `time`.
  let position = -1;
  event.wordIndices.forEach((wordIndex, i) => {
    const w = words[wordIndex];
    if (w && Number(w.start) <= time) position = i;
  });
  if (position < 0 || position >= event.wordIndices.length - 1) return null;
  return splitCaptionEventAt(id, position);
}

/** Joins a caption with the one after it. */
export function mergeCaptionEventWithNext(id) {
  const events = getCaptionEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1 || idx === events.length - 1) return null;
  const merged = mergeCaptionEvents(events[idx], events[idx + 1]);
  if (!merged) return null;
  const next = events.slice();
  next.splice(idx, 2, merged);
  writeCaptionEvents(next);
  return merged;
}

export function removeCaptionEvent(id) {
  const events = getCaptionEvents();
  const next = events.filter((e) => e.id !== id);
  if (next.length === events.length) return;
  writeCaptionEvents(next);
  if (appState.selectedCaptionEventId === id) selectCaptionEvent(null);
}

export function updateCaptionEvent(id, patch, options) {
  const event = getCaptionEvent(id);
  if (!event) return null;
  return replaceEvent(id, normalizeCaptionEvent({ ...event, ...patch }), options);
}

// --- Selection (editor UI only — never undo-tracked, never exported) --------

export function selectCaptionEvent(id) {
  if (appState.selectedCaptionEventId === id) return;
  updateState({ selectedCaptionEventId: id }, { recordHistory: false });
}

export function getSelectedCaptionEvent() {
  const id = appState.selectedCaptionEventId;
  return id ? getCaptionEvent(id) : null;
}

export function removeSelectedCaptionEvent() {
  const id = appState.selectedCaptionEventId;
  if (id) removeCaptionEvent(id);
}

export { MIN_CAPTION_EVENT_DURATION };
