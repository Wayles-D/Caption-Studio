/**
 * THE sound-effect registry — the single place the application learns that a
 * semantic sound ID like `tick` corresponds to an actual audio asset.
 *
 * Nothing else in the codebase may reference a sound file path directly:
 * every consumer (the timeline UI, the Web Audio preview engine, the FFmpeg
 * export pipeline, the AI semantic-event mapper) refers to a sound by its ID
 * and resolves it through this module. Swapping in better-sounding assets,
 * adding a new effect, or moving the whole set behind a CDN is therefore a
 * change to this file plus the asset location — never a codebase-wide edit.
 *
 * ASSET LOCATION. Files live in `public/sounds/` at the repo root. That one
 * directory serves BOTH sides with no duplication:
 *   - the browser fetches them from Vite's static root (`/sounds/tick.mp3`),
 *   - the export pipeline reads the same files off disk (see
 *     resolveSoundFilePath), so preview and export are guaranteed to be
 *     mixing the identical waveform rather than two copies that can drift.
 * The bundled files are synthesized locally by
 * `backend/scripts/generate-sounds.js` (FFmpeg only, no network) so a fresh
 * clone is immediately functional offline; replacing any of them with a real
 * recording of the same name is a drop-in with no code change.
 *
 * MOVING TO OBJECT STORAGE/CDN LATER. Both resolvers below take an explicit
 * base, defaulting to the local one. Pointing `VITE_SOUNDS_BASE_URL` (client)
 * or `SOUNDS_DIR` (server) elsewhere is the entire migration — no editor code
 * knows or cares where the bytes come from.
 */

/**
 * Every sound effect the editor ships with, keyed by its semantic ID.
 *
 * `category` is purely for grouping in the picker UI. `defaultVolume` is the
 * volume a newly-created event gets, per-sound rather than one global number,
 * because these assets are deliberately not loudness-matched to each other (a
 * whoosh wants to sit lower in the mix than a tick).
 */
export const SOUND_REGISTRY = {
  tick: { id: 'tick', label: 'Tick', file: 'tick.mp3', category: 'ui', defaultVolume: 0.7 },
  pop: { id: 'pop', label: 'Pop', file: 'pop.mp3', category: 'ui', defaultVolume: 0.7 },
  click: { id: 'click', label: 'Click', file: 'click.mp3', category: 'ui', defaultVolume: 0.6 },
  notification: { id: 'notification', label: 'Notification', file: 'notification.mp3', category: 'ui', defaultVolume: 0.55 },
  whoosh: { id: 'whoosh', label: 'Whoosh', file: 'whoosh.mp3', category: 'motion', defaultVolume: 0.5 },
  swipe: { id: 'swipe', label: 'Swipe', file: 'swipe.mp3', category: 'motion', defaultVolume: 0.5 },
  rewind: { id: 'rewind', label: 'Rewind', file: 'rewind.mp3', category: 'motion', defaultVolume: 0.5 },
  hit: { id: 'hit', label: 'Hit', file: 'hit.mp3', category: 'impact', defaultVolume: 0.6 },
  shutter: { id: 'shutter', label: 'Camera Shutter', file: 'shutter.mp3', category: 'impact', defaultVolume: 0.6 },
  cash: { id: 'cash', label: 'Cash Register', file: 'cash.mp3', category: 'impact', defaultVolume: 0.6 },
  // The only SUSTAINED effect in the set (~9.8s of continuous keystrokes,
  // against 0.07-2.6s for everything else) — it is a texture, not a one-shot,
  // so it is deliberately not cut to a token burst. An event places the whole
  // thing and shortens it per-use via `event.duration` + `fadeOut`, which
  // buildAudioMixGraph already applies before positioning the event (see
  // backend/utils/audioMixFilter.js). Its default volume sits below the
  // one-shots because a bed under speech has to duck out of the way.
  typing: { id: 'typing', label: 'Keyboard Typing', file: 'typing.mp3', category: 'ui', defaultVolume: 0.45 }
};

export const SOUND_IDS = Object.keys(SOUND_REGISTRY);

/** Fallback for an unknown/removed sound ID, so a stale project never renders silence with no explanation. */
export const FALLBACK_SOUND_ID = 'tick';

/** Where the assets live relative to the repo root — shared by both resolvers below. */
export const SOUNDS_DIR_NAME = 'sounds';

export function isKnownSoundId(soundId) {
  return typeof soundId === 'string' && Object.hasOwn(SOUND_REGISTRY, soundId);
}

/**
 * The registry entry for `soundId`, falling back to FALLBACK_SOUND_ID rather
 * than returning undefined — callers are render/mix paths where "no entry"
 * would mean a silent, unexplained gap in the exported video.
 */
export function getSoundDefinition(soundId) {
  return SOUND_REGISTRY[soundId] || SOUND_REGISTRY[FALLBACK_SOUND_ID];
}

/** Every registry entry as a flat array — backs the sound picker UI. */
export function listSounds() {
  return SOUND_IDS.map((id) => SOUND_REGISTRY[id]);
}

/**
 * Browser-side URL for a sound. `baseUrl` defaults to the app's own static
 * root; pass a CDN/object-storage origin (or set VITE_SOUNDS_BASE_URL, which
 * src/js/components/audioEngine.js reads) to serve them from elsewhere with
 * no other code change.
 */
export function resolveSoundUrl(soundId, baseUrl = `/${SOUNDS_DIR_NAME}`) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  return `${trimmed}/${getSoundDefinition(soundId).file}`;
}

/** Just the file name — for the server-side path resolver, which owns its own directory root. */
export function resolveSoundFileName(soundId) {
  return getSoundDefinition(soundId).file;
}
