/**
 * The audio timeline's data model — storage + normalization ONLY, no DOM, no
 * Web Audio, no FFmpeg. Pure functions in/out, exactly like
 * shared/keyframes.js, so the live preview engine
 * (src/js/components/audioEngine.js) and the export pipeline
 * (backend/utils/audioMixFilter.js) resolve every clip's timing and gain from
 * the SAME code rather than from two implementations that can disagree.
 * That shared resolution is what makes "preview timing == export timing" a
 * structural property here instead of something to keep manually in sync.
 *
 * TWO DISTINCT CONCEPTS, never merged:
 *
 *   Sound effect (SFX) — a short, punctuating sound at ONE instant: tick,
 *   pop, whoosh. It refers to a semantic sound ID from
 *   shared/soundRegistry.js (never a file path), it has no source media of
 *   its own to trim, and it is placed by a time. Several may overlap freely.
 *
 *   Audio track — a long piece of media the user imported: music, ambience,
 *   a voiceover. It owns an uploaded file, occupies a SPAN of the timeline,
 *   and can be trimmed into that span.
 *
 * They live in two separate lists and get two separate timeline lanes,
 * because they are two different editing gestures — "place a beat" vs.
 * "lay a bed under the whole video".
 *
 * TIME IS ALWAYS IN SECONDS on the same axis as #preview-video.currentTime
 * and the keyframe engine's `t`. There is deliberately no second clock.
 */
import { getSoundDefinition, isKnownSoundId, FALLBACK_SOUND_ID } from './soundRegistry.js';

/** Sensible bounds — playbackRate's range matches what FFmpeg's `atempo` accepts in a single stage. */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 2;
export const MAX_VOLUME = 2; // allows a quiet asset to be boosted past unity

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Stable-enough unique id. Not cryptographic — it only has to be unique
 * within one project's own two clip lists, which it is by construction
 * (monotonic counter + time + randomness).
 */
let idCounter = 0;
export function createClipId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// --- Sound effects ---------------------------------------------------------

/**
 * A new sound event at `startTime`.
 *
 * Kept deliberately small — sound ID, when, how loud, fades, rate, on/off —
 * rather than modelling everything a DAW clip could have. The one hard
 * requirement is that `startTime` means exactly the same instant to the
 * preview and to the exporter.
 *
 * `source` records whether the user placed this or the transcript analysis
 * did ('manual' | 'ai'), and `eventType` records which semantic moment an
 * AI-placed one came from — together they let the UI show provenance and let
 * "regenerate automatic effects" replace only the automatic ones, never
 * something the user placed or hand-adjusted.
 */
export function createSoundEvent(soundId, startTime, overrides = {}) {
  const safeId = isKnownSoundId(soundId) ? soundId : FALLBACK_SOUND_ID;
  return normalizeSoundEvent({
    id: createClipId('sfx'),
    type: 'sound',
    soundId: safeId,
    startTime,
    volume: getSoundDefinition(safeId).defaultVolume,
    fadeIn: 0,
    fadeOut: 0,
    playbackRate: 1,
    duration: null, // null = play the asset's own natural length
    enabled: true,
    source: 'manual',
    eventType: null,
    // Set when this effect exists BECAUSE of another timeline object (an
    // image's entrance, a caption reveal). Purely a back-reference for the
    // UI and for cascade-delete — timing still comes from `startTime` on this
    // one shared timeline, so an attached effect is not a special case
    // anywhere in the preview or export path.
    attachedTo: null,
    ...overrides
  });
}

export function normalizeSoundEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const soundId = isKnownSoundId(raw.soundId) ? raw.soundId : FALLBACK_SOUND_ID;
  const duration = raw.duration == null ? null : Math.max(0, finiteOr(raw.duration, 0)) || null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId('sfx'),
    type: 'sound',
    soundId,
    startTime: Math.max(0, finiteOr(raw.startTime, 0)),
    volume: clamp(finiteOr(raw.volume, getSoundDefinition(soundId).defaultVolume), 0, MAX_VOLUME),
    fadeIn: Math.max(0, finiteOr(raw.fadeIn, 0)),
    fadeOut: Math.max(0, finiteOr(raw.fadeOut, 0)),
    playbackRate: clamp(finiteOr(raw.playbackRate, 1), MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE),
    duration,
    enabled: raw.enabled !== false,
    source: raw.source === 'ai' ? 'ai' : 'manual',
    eventType: typeof raw.eventType === 'string' ? raw.eventType : null,
    attachedTo: raw.attachedTo && typeof raw.attachedTo === 'object' ? raw.attachedTo : null
  };
}

// --- Audio tracks ----------------------------------------------------------

/**
 * A new audio track clip.
 *
 * `assetId` is the server-side file this clip plays (see the /api/upload/audio
 * endpoint) and is what the exporter resolves to a real path; `url` is the
 * browser-side URL the preview decodes. Both refer to the SAME uploaded file
 * — the two fields exist only because the two runtimes address it differently.
 *
 * `trimStart`/`trimEnd` are offsets INTO the source media (not timeline
 * times), which is what makes "move the clip" and "trim the clip" independent
 * operations rather than one gesture that silently changes the other.
 */
export function createAudioTrack(asset, overrides = {}) {
  return normalizeAudioTrack({
    id: createClipId('aud'),
    type: 'audio',
    name: asset?.name || 'Audio',
    assetId: asset?.assetId || null,
    url: asset?.url || null,
    sourceDuration: asset?.duration ?? null,
    startTime: 0,
    trimStart: 0,
    trimEnd: null, // null = to the end of the source media
    volume: 0.5, // a bed sits under speech by default, not level with it
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    enabled: true,
    ...overrides
  });
}

export function normalizeAudioTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceDuration = raw.sourceDuration == null ? null : Math.max(0, finiteOr(raw.sourceDuration, 0));
  const trimStart = Math.max(0, finiteOr(raw.trimStart, 0));
  let trimEnd = raw.trimEnd == null ? null : Math.max(0, finiteOr(raw.trimEnd, 0));
  // A trim window that has collapsed or inverted (possible after dragging a
  // handle past its partner, or after editing the stored JSON by hand) would
  // otherwise reach FFmpeg as an `atrim` with end <= start, which produces an
  // empty stream and a silent clip with no error anywhere.
  if (trimEnd != null && trimEnd <= trimStart) trimEnd = null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createClipId('aud'),
    type: 'audio',
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Audio',
    assetId: typeof raw.assetId === 'string' ? raw.assetId : null,
    url: typeof raw.url === 'string' ? raw.url : null,
    sourceDuration,
    startTime: Math.max(0, finiteOr(raw.startTime, 0)),
    trimStart,
    trimEnd,
    volume: clamp(finiteOr(raw.volume, 0.5), 0, MAX_VOLUME),
    fadeIn: Math.max(0, finiteOr(raw.fadeIn, 0)),
    fadeOut: Math.max(0, finiteOr(raw.fadeOut, 0)),
    loop: raw.loop === true,
    enabled: raw.enabled !== false
  };
}

/**
 * How long an audio-track clip occupies the timeline, given its trim window.
 * Returns null when the source's own length isn't known yet AND no trim end
 * bounds it — the caller (timeline UI) draws nothing rather than guessing a
 * width, and the exporter simply doesn't trim the tail.
 */
export function getAudioTrackDuration(track) {
  if (!track) return null;
  if (track.trimEnd != null) return Math.max(0, track.trimEnd - track.trimStart);
  if (track.sourceDuration != null) return Math.max(0, track.sourceDuration - track.trimStart);
  return null;
}

/** The clip's [start, end) on the timeline, or null when its length isn't yet known. */
export function getAudioTrackRange(track) {
  const duration = getAudioTrackDuration(track);
  if (duration == null) return null;
  return { start: track.startTime, end: track.startTime + duration };
}

// --- The video's own audio -------------------------------------------------

/**
 * The source video's own soundtrack is the THIRD volume in the mix, alongside
 * sound effects and imported tracks — and it is the one everything else is
 * balanced against, so it needs the same controls rather than being an
 * untouchable constant at unity.
 *
 * It is modelled here (not as a caption style) because it belongs to the
 * audio mix: the preview applies it to the <video> element and the exporter
 * applies it to `[0:a]`, both reading THIS resolved value, so what the user
 * hears while editing is what the exported file contains.
 */
export const VIDEO_AUDIO_DEFAULTS = { volume: 1, muted: false };

export function normalizeVideoAudio(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    volume: clamp(finiteOr(value.volume, VIDEO_AUDIO_DEFAULTS.volume), 0, MAX_VOLUME),
    muted: value.muted === true
  };
}

/** Whether the video's audio is anything other than "play it exactly as it is". */
export function isDefaultVideoAudio(videoAudio) {
  const v = normalizeVideoAudio(videoAudio);
  return !v.muted && Math.abs(v.volume - 1) < 1e-6;
}

// --- Whole-timeline helpers ------------------------------------------------

/**
 * The canonical shape passed across the wire and into both renderers:
 * `{ soundEvents, audioTracks }`, each normalized and time-sorted.
 *
 * Accepts a JSON STRING as well as an object — the initial-upload request
 * sends style params as multipart form fields, where every value arrives
 * stringified, while /regenerate sends real JSON. Handling both here means
 * neither caller needs to know which transport it happens to be on.
 */
export function normalizeAudioTimeline(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const soundEvents = (Array.isArray(value?.soundEvents) ? value.soundEvents : [])
    .map(normalizeSoundEvent)
    .filter(Boolean)
    .sort((a, b) => a.startTime - b.startTime);
  const audioTracks = (Array.isArray(value?.audioTracks) ? value.audioTracks : [])
    .map(normalizeAudioTrack)
    .filter(Boolean)
    .sort((a, b) => a.startTime - b.startTime);
  return { soundEvents, audioTracks, video: normalizeVideoAudio(value?.video) };
}

/**
 * Whether anything at all would be mixed — the exporter's "leave the audio
 * path completely untouched" check.
 *
 * Turning the video's own volume down (or muting it) counts, even with no
 * clips: the mix is the only place that change can be applied, so skipping it
 * would silently export the original soundtrack at full level while the
 * preview played it quiet.
 */
export function hasAnyAudio(timeline) {
  if (!timeline) return false;
  return (timeline.soundEvents || []).some((e) => e.enabled)
    || (timeline.audioTracks || []).some((t) => t.enabled && (t.assetId || t.url))
    || !isDefaultVideoAudio(timeline.video);
}

/** Only the clips that should actually be heard — the one definition of "enabled" both runtimes use. */
export function getActiveAudio(timeline) {
  const normalized = timeline && timeline.soundEvents ? timeline : normalizeAudioTimeline(timeline);
  return {
    soundEvents: normalized.soundEvents.filter((e) => e.enabled),
    audioTracks: normalized.audioTracks.filter((t) => t.enabled && (t.assetId || t.url)),
    video: normalizeVideoAudio(normalized.video)
  };
}
