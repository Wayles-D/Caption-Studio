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
 * describing what the SPEECH is doing, optionally naming a sound the model
 * thought fitted that particular moment, and this module decides what
 * actually gets placed. The precedence is written out at the point it is
 * applied, but the shape of it is that a mute always wins, a user's own
 * per-type choice beats the model's, and the model's per-moment pick beats a
 * profile's per-type default (shared/soundProfiles.js).
 */
import { appState, updateState } from '../state.js';
import {
  createSoundEvent,
  createAudioTrack,
  normalizeSoundEvent,
  normalizeAudioTrack,
  getAudioTrackDuration
} from '../../../shared/audioTimeline.js';
import {
  resolveSoundMapping,
  isKnownSemanticEventType,
  resolveCategorySound,
  getWordSoundKey,
  momentWords
} from '../../../shared/soundProfiles.js';
import { selectDirectedMoments, resolveDirectedPlacement, resolveRunDurations } from '../../../shared/sfxDirection.js';
import { getSoundDefinition, isKnownSoundId } from '../../../shared/soundRegistry.js';

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
 *
 * Editing an AI-placed effect PROMOTES it: it keeps its `source: 'ai'` origin
 * (so the UI can still say where it came from) but is flagged `userModified`,
 * which takes it out of the regenerable pool for good — see
 * applySemanticEvents. Without this, moving an automatic tick and then
 * re-analyzing would silently snap it back to where the model put it.
 *
 * Only real edits promote. `enabled` is included deliberately — muting a
 * suggestion is a decision about it — but a patch that changes nothing (or
 * only internal bookkeeping) leaves the flag alone, so merely re-writing a
 * clip doesn't make it un-regenerable.
 */
const PROMOTING_FIELDS = ['startTime', 'soundId', 'volume', 'fadeIn', 'fadeOut', 'playbackRate', 'duration', 'enabled'];

export function updateSoundEvent(id, patch, { recordHistory = true } = {}) {
  const events = getSoundEvents();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const current = events[idx];
  const touchesValue = PROMOTING_FIELDS.some(
    (field) => Object.hasOwn(patch || {}, field) && patch[field] !== current[field]
  );
  const next = events.slice();
  next[idx] = normalizeSoundEvent({
    ...current,
    ...patch,
    userModified: current.userModified || (current.source === 'ai' && touchesValue)
  });
  writeSoundEvents(next, recordHistory);
  return next[idx];
}

/**
 * Copies ONE sound effect's current volume onto every OTHER sound effect —
 * "Apply to All" for SFX. One write, one history entry, regardless of how
 * many effects exist (not a loop of individual updateSoundEvent calls, which
 * would push one history entry per effect). Only `volume` changes; every
 * other field (which sound, timing, enabled state, provenance) is untouched
 * on every effect, including the source one. A single (or already-uniform)
 * effect list is a harmless no-op — nothing to copy onto.
 *
 * @param {string} sourceId - The effect whose CURRENT volume should become every other effect's volume.
 */
export function applySoundEventVolumeToAll(sourceId, targetIds = null) {
  const events = getSoundEvents();
  const source = events.find((e) => e.id === sourceId);
  if (!source) return events;
  const volume = source.volume;
  // `targetIds` narrows the copy to a chosen few; null keeps the original
  // "every other effect" behaviour, which is still the common case. One
  // function rather than two, because "which effects does this apply to" is a
  // parameter of the gesture, not a different gesture — and because a second
  // entry point would be a second place for the history/promotion rules below
  // to drift out of step.
  const scope = Array.isArray(targetIds) ? new Set(targetIds) : null;
  let changed = false;
  const next = events.map((e) => {
    if (e.id === sourceId || e.volume === volume) return e;
    if (scope && !scope.has(e.id)) return e;
    changed = true;
    return normalizeSoundEvent({
      ...e,
      volume,
      userModified: e.userModified || e.source === 'ai'
    });
  });
  // A single (or already-uniform) effect list has nothing to copy onto —
  // skip the write entirely rather than pushing a no-op history entry.
  if (changed) writeSoundEvents(next);
  return next;
}

export function moveSoundEvent(id, startTime, options) {
  return updateSoundEvent(id, { startTime: clampToTimeline(startTime) }, options);
}

/**
 * Deleting an AI-placed effect TOMBSTONES the moment it came from, so a later
 * re-analysis does not hand it back. "I don't want a sound here" has to be a
 * decision the system remembers; without it, every re-run would quietly undo
 * the deletion.
 *
 * The underlying semantic event is deliberately NOT removed — the moment is
 * still a real thing that happened in the speech, so it stays listed and the
 * creator can place something there by hand later. This is "remove the SFX
 * while keeping the event", not "pretend the moment never existed".
 */
export function removeSoundEvent(id) {
  const events = getSoundEvents();
  const target = events.find((e) => e.id === id);
  if (!target) return;

  if (target.source === 'ai' && target.eventKey) {
    const dismissed = new Set(appState.dismissedEventKeys || []);
    dismissed.add(target.eventKey);
    updateState({ dismissedEventKeys: [...dismissed] }, { recordHistory: false });
  }

  writeSoundEvents(events.filter((e) => e.id !== id));
  if (appState.selectedAudioClipId === id) selectClip(null);
}

/**
 * Forgets every "I deleted this suggestion" tombstone, so the next run may
 * place those moments again — the undo for a deletion the creator has changed
 * their mind about.
 */
export function restoreDismissedEvents() {
  updateState({ dismissedEventKeys: [] }, { recordHistory: true });
  if (appState.autoSoundEffects) regenerateAutoSoundEffects();
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

/**
 * Nudges `desiredStart` forward just far enough to clear every EXISTING
 * track's own [start, end) window — the default "start at the playhead"
 * placement otherwise stacks every import that happens without moving the
 * playhead in between on top of the same span, since nothing previously
 * checked for a collision at all. Only pushes forward (never back/never
 * touches an existing track), and re-checks from the top after each push
 * since clearing one track's end can land inside the NEXT one.
 *
 * `newDuration` unknown (still decoding) degrades to a minimal check — the
 * new clip's START point must not fall inside an existing track's span —
 * rather than skipping the check entirely.
 */
function findNonOverlappingAudioStart(desiredStart, newDuration) {
  const tracks = getAudioTracks();
  if (!tracks.length) return desiredStart;
  const dur = newDuration != null ? Math.max(0, newDuration) : 0;
  let start = desiredStart;
  let moved = true;
  while (moved) {
    moved = false;
    for (const t of tracks) {
      const tEnd = t.startTime + (getAudioTrackDuration(t) ?? 0);
      const overlaps = start < tEnd && start + dur > t.startTime;
      if (overlaps && tEnd > start) {
        start = tEnd;
        moved = true;
      }
    }
  }
  return start;
}

/**
 * Adds an imported audio file as a track. Defaults to starting at the
 * playhead, same as before — but now only when that position is actually
 * clear; if it would overlap an already-placed track, the new one is pushed
 * to start right after the last conflicting track ends instead of landing
 * on top of it (see findNonOverlappingAudioStart). An explicit
 * `overrides.startTime` (a deliberate drop position, once a caller passes
 * one) is trusted as-is and skips this check entirely — auto-avoidance is
 * only for the "didn't say where" default.
 */
export function addAudioTrack(asset, overrides = {}) {
  const startTime = overrides.startTime != null
    ? clampToTimeline(overrides.startTime)
    : clampToTimeline(findNonOverlappingAudioStart(getPlayheadTime(), asset?.duration ?? null));
  const track = createAudioTrack(asset, { ...overrides, startTime });
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
 * Copies ONE audio/music track's current volume onto every OTHER track —
 * "Apply to All" for Audio, mirroring applySoundEventVolumeToAll above (SFX
 * and audio tracks are separate arrays/media types — this never touches
 * soundEvents, and applySoundEventVolumeToAll never touches audioTracks).
 * One write, one history entry. Only `volume` changes — position, trim,
 * fades, source, enabled state are untouched on every track, including the
 * source one.
 *
 * @param {string} sourceId - The track whose CURRENT volume should become every other track's volume.
 */
export function applyAudioTrackVolumeToAll(sourceId) {
  const tracks = getAudioTracks();
  const source = tracks.find((t) => t.id === sourceId);
  if (!source) return tracks;
  const volume = source.volume;
  let changed = false;
  const next = tracks.map((t) => {
    if (t.id === sourceId || t.volume === volume) return t;
    changed = true;
    return normalizeAudioTrack({ ...t, volume });
  });
  // A single (or already-uniform) track list has nothing to copy onto —
  // skip the write entirely rather than pushing a no-op history entry.
  if (changed) writeAudioTracks(next);
  return next;
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
 * RECONCILED, not replaced. The AI's output is a suggestion; the timeline
 * belongs to the creator. So a re-run may only ever replace effects that are
 * still untouched suggestions, and three things survive it verbatim:
 *
 *   - anything hand-placed (`source === 'manual'`)
 *   - a suggestion the creator has since MOVED, re-sounded, re-levelled or
 *     disabled (`userModified`) — it keeps its own timestamp/sound/volume and
 *     is not regenerated from the analysis
 *   - a suggestion the creator DELETED, which stays deleted: its key is
 *     tombstoned in `dismissedEventKeys` so re-analysis cannot resurrect it
 *
 * Identity is THE WORD a sound sits on (its start time — see
 * getWordSoundKey), never the clip id and never the moment's type or grouping,
 * because the analysis is not perfectly repeatable: the same phrase can come
 * back as a list_start one run and a topic the next. Keying on the word is
 * what makes a deletion stick ("no sound on this word") and what makes this
 * idempotent: re-running derives the same word keys, finds them already
 * handled, and places nothing new.
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
  const existing = getSoundEvents();

  // Everything the creator owns: their own placements, plus any suggestion
  // they have since edited. Kept exactly as-is.
  const kept = existing.filter((e) => e.source !== 'ai' || e.userModified);

  // A moment is already handled if the creator is holding a clip for it, or
  // if they deleted that clip and do not want it back.
  const dismissed = new Set(appState.dismissedEventKeys || []);
  const claimed = new Set(kept.map((e) => e.eventKey).filter(Boolean));

  // THE DIRECTOR (shared/sfxDirection.js). The analysis reports every moment
  // it noticed; this is where a shortlist becomes an edit. List beats come
  // back untouched — they are the original behaviour and their repetition is
  // the point — while expressive moments compete for a per-video budget and
  // are held apart from each other and from the list beats.
  //
  // Deliberately re-run on every call rather than cached: switching profile,
  // toggling auto effects and moving the sensitivity slider all route through
  // here, and all three must re-decide from the stored analysis without
  // another model call.
  const { structural, directed } = selectDirectedMoments(stored, {
    duration: getVideoDuration(),
    sensitivity: appState.sfxSensitivity
  });
  // PRIORITY order, not time order, because it decides who keeps a word two
  // moments both claimed: list beats first (they are structure), then accents
  // strongest-first. The placed clips are time-sorted by writeSoundEvents
  // regardless of the order they are built in.
  const plan = [
    ...structural.map((moment) => ({ moment, directed: false })),
    ...directed
      .slice()
      .sort((a, b) => (Number(b.intensity) || 0.5) - (Number(a.intensity) || 0.5))
      .map((moment) => ({ moment, directed: true }))
  ];

  // Words already given a sound on THIS pass. See getWordSoundKey: the word is
  // the de-duplication unit, so a product the model reported as both a
  // list_item and an entity gets one sound, while four adjacent words sharing
  // the same sound id stay four sounds.
  const sounded = new Set();
  const generated = [];

  for (const { moment, directed: isDirected } of plan) {
    const mapped = mapping[moment.type];
    // Silence wins outright. A null mapping is somebody saying "this kind of
    // moment makes no sound" — either the profile (Minimal exists to say
    // exactly that) or the user muting a type — and a sound the model
    // suggested is not grounds to overrule either of them.
    if (!mapped) continue;

    // ONE sound for the whole run, chosen once. That is what makes "five /
    // home / office / hacks" a pattern: every word in it gets the same sound,
    // rather than four independent choices that could each land somewhere
    // different.
    //
    // Precedence, strongest first:
    //   a type the user re-pointed   — a standing instruction; beats any guess
    //   LIST BEATS: the profile      — see below
    //   a sound id the model named   — chosen for THIS moment (literal matches)
    //   the model's sound category   — BHYND's pick for that style of accent
    //   the profile's type default   — what this kind of moment usually means
    //
    // List beats take their sound from the PROFILE, never from the model's
    // category or sound id. They are structure: every item of a list should
    // sound alike, which is the whole rhythm of "first / next / last". They
    // are also the original feature, with a documented sound (`tick`) and a
    // profile switcher that changes it — and letting the category win here
    // silently broke both on the real test video, turning every list beat
    // into `click` and making Punchy indistinguishable from Default. The
    // category drives the EXPRESSIVE moments, which is where it is for.
    const userPinned = Object.prototype.hasOwnProperty.call(appState.soundEventMapping || {}, moment.type);
    const words = momentWords(moment);
    const soundId = (userPinned || !isDirected)
      ? mapped
      : (isKnownSoundId(moment.soundId) ? moment.soundId
        // A run of several words takes the category's dry, repeatable sound
        // (see SFX_SOUND_CATEGORIES' wordSounds).
        : (resolveCategorySound(moment.soundCategory, { run: words.length > 1 }) || mapped));

    // Level and length. Only DIRECTED moments get re-levelled: a list beat keeps
    // the sound's own default volume, because changing how the original
    // behaviour sounds is not what widening the analysis was for. For an
    // accent the level follows the model's confidence and the length is capped
    // to a beat. Both are ordinary starting values on an ordinary clip.
    const base = isDirected
      ? resolveDirectedPlacement(getSoundDefinition(soundId).defaultVolume, moment.intensity)
      : null;

    // A run's sounds are cut where the next word's begins, so a longer sound
    // chosen for a run cannot stack four copies on top of each other. Null for
    // a single word, which leaves a lone list beat exactly as it always was.
    const runLengths = resolveRunDurations(words);

    words.forEach((word, i) => {
      const key = getWordSoundKey(word.timestamp);
      // Already handled: the creator holds an edited clip on this word, or
      // deleted one here and does not want it back, or a higher-priority
      // moment on this same pass already sounded it.
      if (!key || dismissed.has(key) || claimed.has(key) || sounded.has(key)) return;
      sounded.add(key);
      generated.push(createSoundEvent(soundId, word.timestamp, {
        source: 'ai',
        eventType: moment.type,
        eventKey: key,
        ...(base || {}),
        ...(runLengths ? runLengths[i] : {})
      }));
    });
  }

  updateState({ semanticEvents: stored }, { recordHistory: false });
  writeSoundEvents([...kept, ...generated]);
  return generated.sort((a, b) => a.startTime - b.startTime);
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

/**
 * How freely the director places accents. Re-derives immediately from the
 * STORED analysis — no model call, same as switching profile.
 *
 * `recordHistory` is false while the slider is being dragged and true on
 * release, the same drag/commit split every other continuous control here
 * uses; without it a single drag would push a history entry per pixel.
 */
export function setSfxSensitivity(value, { recordHistory = true } = {}) {
  const next = Math.min(1, Math.max(0, Number(value)));
  if (!Number.isFinite(next)) return;
  updateState({ sfxSensitivity: next }, { recordHistory });
  if (appState.autoSoundEffects) regenerateAutoSoundEffects();
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

/**
 * Un-pins an event type, handing it back to the profile default and to the
 * model's per-moment picks.
 *
 * Deliberately a REMOVAL rather than setting the mapping back to whatever the
 * profile currently says. The two are not the same thing: an entry present in
 * soundEventMapping means "the user has an opinion about this type", which is
 * what outranks the model in applySemanticEvents and what survives a profile
 * switch. Writing the profile's own value back would silently pin it.
 */
export function clearEventTypeSound(eventType) {
  const current = appState.soundEventMapping || {};
  if (!Object.prototype.hasOwnProperty.call(current, eventType)) return;
  const next = { ...current };
  delete next[eventType];
  updateState({ soundEventMapping: next }, { recordHistory: true });
  if (appState.autoSoundEffects) regenerateAutoSoundEffects();
}

/** The analysis's suggested visual moments. Read-only here — nothing is ever auto-filled into one (see this feature's "the creator must remain in control" rule). */
export function getVisualSuggestions() {
  return appState.visualSuggestions || [];
}
