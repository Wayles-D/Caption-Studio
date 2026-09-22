/**
 * THE audio timeline's read/write API — the one module that mutates
 * appState.soundEvents / appState.audioTracks.
 *
 * Deliberately the same shape as src/js/components/videoTransform.js is for
 * the video target: a small set of named operations, each writing through
 * src/js/state.js's updateState so every audio edit lands in the SAME undo
 * history, fires the SAME subscribe('*') notification, and reaches the
 * export payload through the SAME getStyleParams() snapshot as any other
 * edit. Nothing here knows about the DOM, Web Audio, or FFmpeg — the timeline
 * UI (timelinePanel.js), the preview engine (audioEngine.js) and the exporter
 * are all downstream consumers of this state, never peers writing it.
 *
 * The AI seam lives here too (applySemanticEvents): semantic events arrive
 * describing what the SPEECH is doing, and this module — not the model —
 * decides which sound that currently means, using shared/soundProfiles.js.
 */
import { appState, updateState } from '../state.js';
import {
  createSoundEvent,
  createAudioTrack,
  normalizeSoundEvent,
  normalizeAudioTrack,
  getAudioTrackDuration
} from '../../../shared/audioTimeline.js';
import { resolveSoundMapping, isKnownSemanticEventType } from '../../../shared/soundProfiles.js';
import { getSoundDefinition } from '../../../shared/soundRegistry.js';

/** The playhead — the same `#preview-video` element every other part of the editor treats as the single source of time. */
export function getPlayheadTime() {
  return document.getElementById('preview-video')?.currentTime ?? 0;
}

function getVideoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

/** Keeps a clip from being dragged off either end of the clip's own timeline. */
function clampToTimeline(time) {
  const duration = getVideoDuration();
  const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(0, time));
}

function writeSoundEvents(next, recordHistory = true) {
  updateState({ soundEvents: next.slice().sort((a, b) => a.startTime - b.startTime) }, { recordHistory });
}

function writeAudioTracks(next, recordHistory = true) {
  updateState({ audioTracks: next.slice().sort((a, b) => a.startTime - b.startTime) }, { recordHistory });
}

// --- Sound effects ---------------------------------------------------------

export function getSoundEvents() {
  return appState.soundEvents || [];
}

export function getSoundEvent(id) {
  return getSoundEvents().find((e) => e.id === id) || null;
}

/** Adds one effect, defaulting to the playhead — the "+ Sound" button's action. */
export function addSoundEvent(soundId, startTime = getPlayheadTime(), overrides = {}) {
  const event = createSoundEvent(soundId, clampToTimeline(startTime), overrides);
  writeSoundEvents([...getSoundEvents(), event]);
  selectClip(event.id);
  return event;
}

/**
 * Patches one effect. `recordHistory` is false during a live drag (so a drag
 * doesn't push 60 history entries) and true on the commit — the same
 * drag/commit split preview.js's manual caption drag already uses.
 */
export function updateSoundEvent(id, patch, { recordHistory = true } = {}) {
  const events = getSoundEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const next = events.slice();
  next[idx] = normalizeSoundEvent({ ...events[idx], ...patch });
  writeSoundEvents(next, recordHistory);
  return next[idx];
}

export function moveSoundEvent(id, startTime, options) {
  return updateSoundEvent(id, { startTime: clampToTimeline(startTime) }, options);
}

export function removeSoundEvent(id) {
  const next = getSoundEvents().filter((e) => e.id !== id);
  if (next.length === getSoundEvents().length) return;
  writeSoundEvents(next);
  if (appState.selectedAudioClipId === id) selectClip(null);
}

export function setSoundEventEnabled(id, enabled) {
  return updateSoundEvent(id, { enabled: !!enabled });
}

/**
 * Swaps which sound an effect plays. The per-sound default volume is carried
 * over ONLY when the current volume is still the previous sound's default —
 * i.e. the user never touched it. A hand-set level is the user's decision and
 * survives the swap.
 */
export function setSoundEventSound(id, soundId) {
  const event = getSoundEvent(id);
  if (!event) return null;
  const wasDefaultVolume = Math.abs(event.volume - getSoundDefinition(event.soundId).defaultVolume) < 1e-6;
  return updateSoundEvent(id, {
    soundId,
    ...(wasDefaultVolume ? { volume: getSoundDefinition(soundId).defaultVolume } : {})
  });
}

// --- Audio tracks ----------------------------------------------------------

export function getAudioTracks() {
  return appState.audioTracks || [];
}

export function getAudioTrack(id) {
  return getAudioTracks().find((t) => t.id === id) || null;
}

/** Adds an imported audio file as a track, defaulting to starting at the playhead. */
export function addAudioTrack(asset, overrides = {}) {
  const track = createAudioTrack(asset, { startTime: clampToTimeline(getPlayheadTime()), ...overrides });
  writeAudioTracks([...getAudioTracks(), track]);
  selectClip(track.id);
  return track;
}

export function updateAudioTrack(id, patch, { recordHistory = true } = {}) {
  const tracks = getAudioTracks();
  const idx = tracks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next = tracks.slice();
  next[idx] = normalizeAudioTrack({ ...tracks[idx], ...patch });
  writeAudioTracks(next, recordHistory);
  return next[idx];
}

export function moveAudioTrack(id, startTime, options) {
  return updateAudioTrack(id, { startTime: clampToTimeline(startTime) }, options);
}

/**
 * Trims from one edge, in TIMELINE coordinates (where the user's pointer
 * actually is), translating that into the clip's own source offsets.
 *
 * Dragging the LEFT edge moves both the timeline start and the source's
 * trimStart by the same delta, so the audio under the cursor stays put
 * instead of sliding — the behavior every NLE has and the reason this can't
 * be expressed as a plain `startTime` write.
 */
export function trimAudioTrack(id, edge, timelineTime, options) {
  const track = getAudioTrack(id);
  if (!track) return null;
  const duration = getAudioTrackDuration(track);

  if (edge === 'start') {
    const trackEnd = duration == null ? null : track.startTime + duration;
    // Never past the clip's own tail, and never before the point where
    // trimStart would go negative (there is no media before offset 0).
    const minStart = track.startTime - track.trimStart;
    const maxStart = trackEnd == null ? Number.MAX_SAFE_INTEGER : trackEnd - 0.05;
    const nextStart = Math.min(maxStart, Math.max(minStart, clampToTimeline(timelineTime)));
    const delta = nextStart - track.startTime;
    return updateAudioTrack(id, {
      startTime: nextStart,
      trimStart: track.trimStart + delta,
      // trimEnd is an offset into the SOURCE, so it is unaffected by moving
      // the head — only the window's start moved.
      trimEnd: track.trimEnd
    }, options);
  }

  // 'end': the clip's tail in timeline time maps straight onto a source offset.
  const nextEnd = Math.max(track.startTime + 0.05, clampToTimeline(timelineTime));
  const sourceEnd = track.trimStart + (nextEnd - track.startTime);
  const bounded = track.sourceDuration != null ? Math.min(track.sourceDuration, sourceEnd) : sourceEnd;
  return updateAudioTrack(id, { trimEnd: bounded }, options);
}

export function removeAudioTrack(id) {
  const next = getAudioTracks().filter((t) => t.id !== id);
  if (next.length === getAudioTracks().length) return;
  writeAudioTracks(next);
  if (appState.selectedAudioClipId === id) selectClip(null);
}

export function setAudioTrackEnabled(id, enabled) {
  return updateAudioTrack(id, { enabled: !!enabled });
}

// --- The video's own audio -------------------------------------------------

export function getVideoAudio() {
  return { volume: appState.videoVolume ?? 1, muted: appState.videoMuted === true };
}

/**
 * Sets the source video's own soundtrack level. Same 0-200% range as every
 * other clip, so "turn the music up and the speech down" is one consistent
 * gesture rather than two different kinds of control.
 */
export function setVideoVolume(volume, { recordHistory = true } = {}) {
  const next = Math.min(2, Math.max(0, Number(volume)));
  if (!Number.isFinite(next)) return;
  updateState({ videoVolume: next }, { recordHistory });
}

export function setVideoMuted(muted) {
  updateState({ videoMuted: !!muted }, { recordHistory: true });
}

// --- Selection (editor UI only, never exported, never undo-tracked) --------

export function selectClip(id) {
  if (appState.selectedAudioClipId === id) return;
  updateState({ selectedAudioClipId: id }, { recordHistory: false });
}

export function getSelectedClip() {
  const id = appState.selectedAudioClipId;
  if (!id) return null;
  return getSoundEvent(id) || getAudioTrack(id);
}

/** Deletes whichever clip is selected — the timeline's Delete-key handler. */
export function removeSelectedClip() {
  const id = appState.selectedAudioClipId;
  if (!id) return;
  if (getSoundEvent(id)) removeSoundEvent(id);
  else if (getAudioTrack(id)) removeAudioTrack(id);
}

// --- Semantic events -> sound effects --------------------------------------

/**
 * THE mapping step. Takes the semantic events the transcript analysis
 * produced (each already carrying a timestamp resolved from the transcript's
 * own word timings — the model never invents a time) and places one sound
 * effect per event, using whichever sound the current profile says that event
 * type means.
 *
 * Only AUTOMATIC effects are replaced: every existing event with
 * `source === 'ai'` is cleared first, while anything the user placed or
 * adjusted by hand is left exactly where it is. That is what makes this safe
 * to re-run after switching sound profile, re-enabling Auto Sound Effects, or
 * re-analyzing — it can never quietly undo the user's own work.
 *
 * A no-op when Auto Sound Effects is off: the semantic events are still
 * stored (the suggestions stay browsable, and the user can place any of them
 * by hand), only the automatic placement is suppressed.
 */
export function applySemanticEvents(semanticEvents, { force = false } = {}) {
  const events = Array.isArray(semanticEvents) ? semanticEvents : [];
  const stored = events.filter((e) => e && isKnownSemanticEventType(e.type) && Number.isFinite(e.timestamp));

  if (!force && !appState.autoSoundEffects) {
    // Store the analysis but place nothing.
    updateState({ semanticEvents: stored }, { recordHistory: false });
    return [];
  }

  const mapping = resolveSoundMapping(appState.soundProfileId, appState.soundEventMapping);
  const manual = getSoundEvents().filter((e) => e.source !== 'ai');

  const generated = stored
    .map((event) => {
      const soundId = mapping[event.type];
      if (!soundId) return null; // this event type is mapped to silence
      return createSoundEvent(soundId, event.timestamp, {
        source: 'ai',
        eventType: event.type
      });
    })
    .filter(Boolean);

  updateState({ semanticEvents: stored }, { recordHistory: false });
  writeSoundEvents([...manual, ...generated]);
  return generated;
}

/** Re-derives the automatic effects from the already-stored analysis — no model call. Used when the profile or a per-event-type mapping changes. */
export function regenerateAutoSoundEffects() {
  return applySemanticEvents(appState.semanticEvents, { force: true });
}

/** Removes every automatically-placed effect, leaving hand-placed ones untouched — what turning Auto Sound Effects off means for already-placed sounds. */
export function clearAutoSoundEffects() {
  writeSoundEvents(getSoundEvents().filter((e) => e.source !== 'ai'));
}

export function setAutoSoundEffects(enabled) {
  updateState({ autoSoundEffects: !!enabled }, { recordHistory: true });
  if (enabled) regenerateAutoSoundEffects();
  else clearAutoSoundEffects();
}

export function setSoundProfile(profileId) {
  updateState({ soundProfileId: profileId }, { recordHistory: true });
  if (appState.autoSoundEffects) regenerateAutoSoundEffects();
}

/**
 * Re-points ONE semantic event type at a different sound (or at `null` for
 * "no sound"), then re-derives the automatic effects so the change is
 * immediately audible. This is the user-facing "change the default sound for
 * this kind of moment" control.
 */
export function setEventTypeSound(eventType, soundId) {
  if (!isKnownSemanticEventType(eventType)) return;
  updateState({
    soundEventMapping: { ...(appState.soundEventMapping || {}), [eventType]: soundId }
  }, { recordHistory: true });
  if (appState.autoSoundEffects) regenerateAutoSoundEffects();
}

/** The analysis's suggested visual moments. Read-only here — nothing is ever auto-filled into one (see this feature's "the creator must remain in control" rule). */
export function getVisualSuggestions() {
  return appState.visualSuggestions || [];
}
