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
/**
 * Display order and human names for the picker's groupings. Kept here rather
 * than in the UI because the grouping is a property of the LIBRARY, not of
 * one view of it — the picker, and anything else that lists sounds later,
 * should not each invent their own idea of what "ui" means.
 */
export const SOUND_CATEGORIES = [
  { id: 'ui', label: 'UI & Alerts' },
  { id: 'typing', label: 'Typing & Messaging' },
  { id: 'motion', label: 'Transitions & Risers' },
  { id: 'impact', label: 'Impacts' },
  { id: 'tension', label: 'Tension & Drama' },
  { id: 'meme', label: 'Memes & Voices' },
  { id: 'sting', label: 'Stings' }
];

export const SOUND_REGISTRY = {
  // --- UI & Alerts ---------------------------------------------------------
  tick: { id: 'tick', label: 'Tick', file: 'tick.mp3', category: 'ui', defaultVolume: 0.7, use: 'tiny dry tick; beat under each item of a list' },
  pop: { id: 'pop', label: 'Pop', file: 'pop.mp3', category: 'ui', defaultVolume: 0.7, use: 'small bright pop; a word landing, a quick reveal' },
  click: { id: 'click', label: 'Click', file: 'click.mp3', category: 'ui', defaultVolume: 0.6, use: 'soft UI click; a choice being made, an answer arriving' },
  notification: { id: 'notification', label: 'Notification', file: 'notification.mp3', category: 'ui', defaultVolume: 0.55, use: 'phone notification chime; a message or alert being mentioned' },
  ding: { id: 'ding', label: 'Ding', file: 'ding-sound-effect.mp3', category: 'ui', defaultVolume: 0.55, use: 'single clear bell; a correct answer, a point made' },
  sparkle: { id: 'sparkle', label: 'Sparkle', file: 'sparkle.mp3', category: 'ui', defaultVolume: 0.5, use: 'light shimmer; something pleasing, a finishing touch' },
  'whatsapp-send': { id: 'whatsapp-send', label: 'WhatsApp Send', file: 'whatsapp-send.mp3', category: 'ui', defaultVolume: 0.6, use: 'WhatsApp sent blip; a message being sent' },

  // --- Typing & Messaging --------------------------------------------------
  // These are TEXTURES rather than one-shots — several run for seconds of
  // continuous keystrokes. An event places the whole file and shortens it
  // per-use via `event.duration` + `fadeOut` (see
  // backend/utils/audioMixFilter.js), and their defaults sit low because a
  // bed under speech has to duck out of the way.
  typing: { id: 'typing', label: 'Keyboard Typing', file: 'typing.mp3', category: 'typing', defaultVolume: 0.45, use: 'seconds of keyboard typing; someone writing or coding' },
  'typing-fast': { id: 'typing-fast', label: 'Typing (Fast)', file: 'typingssss.mp3', category: 'typing', defaultVolume: 0.45, use: 'fast frantic keystrokes; rushing, urgency at a keyboard' },
  'whatsapp-type': { id: 'whatsapp-type', label: 'WhatsApp Typing', file: 'whatsapp-type.mp3', category: 'typing', defaultVolume: 0.45, use: 'WhatsApp typing bubble; a reply being written' },
  'iphone-typing': { id: 'iphone-typing', label: 'iPhone Typing', file: 'iphone-typing-text.mp3', category: 'typing', defaultVolume: 0.5, use: 'iPhone keyboard taps; texting on a phone' },
  'iphone-delete': { id: 'iphone-delete', label: 'iPhone Delete', file: 'iphone-typing-text-deleting-letter.mp3', category: 'typing', defaultVolume: 0.5, use: 'iPhone delete key; deleting or correcting a message' },

  // --- Transitions & Risers ------------------------------------------------
  whoosh: { id: 'whoosh', label: 'Whoosh', file: 'whoosh.mp3', category: 'motion', defaultVolume: 0.5, use: 'short air whoosh; a cut, a scene change, a list opening' },
  swipe: { id: 'swipe', label: 'Swipe', file: 'swipe.mp3', category: 'motion', defaultVolume: 0.5, use: 'quick swipe; moving between items or screens' },
  rewind: { id: 'rewind', label: 'Rewind', file: 'rewind.mp3', category: 'motion', defaultVolume: 0.5, use: 'tape rewind; going back, replaying, a callback' },
  'riser-metallic': { id: 'riser-metallic', label: 'Metallic Riser', file: 'ES_Riser Metallic - SFX Producer.mp3', category: 'motion', defaultVolume: 0.45, use: 'metallic riser building tension; leads INTO a reveal' },
  'riser-reverse': { id: 'riser-reverse', label: 'Reverse Riser', file: 'Reverse riser 02 - ( Sound Effects Transition )_25032024.m4a', category: 'motion', defaultVolume: 0.45, use: 'reverse riser sucking inwards; leads into a cut or reveal' },
  // Two takes of the same effect, kept as separate entries rather than one
  // "Flicker" picking a winner — which take cuts better is a per-edit call,
  // and an unpicked variant sitting unreachable on disk is the exact problem
  // this registry exists to prevent.
  'flicker-1': { id: 'flicker-1', label: 'Flicker (1)', file: 'flicker v1.mp3', category: 'motion', defaultVolume: 0.5, use: 'glitchy flicker; a glitch, a switch, a jarring beat' },
  'flicker-2': { id: 'flicker-2', label: 'Flicker (2)', file: 'flicker v2.mp3', category: 'motion', defaultVolume: 0.5, use: 'glitchy flicker, second take; alternative to flicker-1' },

  // --- Impacts -------------------------------------------------------------
  hit: { id: 'hit', label: 'Hit', file: 'hit.mp3', category: 'impact', defaultVolume: 0.6, use: 'blunt impact; a hard statement landing' },
  shutter: { id: 'shutter', label: 'Camera Shutter', file: 'shutter.mp3', category: 'impact', defaultVolume: 0.6, use: 'camera shutter; a photo, a camera, capturing something' },
  cash: { id: 'cash', label: 'Cash Register', file: 'cash.mp3', category: 'impact', defaultVolume: 0.6, use: 'cash register ka-ching; money, price, profit, a sale' },
  'core-hit': { id: 'core-hit', label: 'Core Hit', file: 'core-sound-effect.mp3', category: 'impact', defaultVolume: 0.55, use: 'deep cinematic boom; the heaviest statement in the video' },

  // --- Tension & Drama -----------------------------------------------------
  tension: { id: 'tension', label: 'Tension', file: 'tension.mp3', category: 'tension', defaultVolume: 0.45, use: 'low tense drone; suspense, stakes, something worrying' },
  'clock-ticking': { id: 'clock-ticking', label: 'Clock Ticking', file: 'clock_ticking_edited-2.mp3', category: 'tension', defaultVolume: 0.45, use: 'steady clock tick; time passing, a deadline' },
  'clock-fast': { id: 'clock-fast', label: 'Clock Ticking (Fast)', file: 'clock-ticking-fast.mp3', category: 'tension', defaultVolume: 0.5, use: 'fast ticking clock; running out of time, urgency' },
  'sad-violin': { id: 'sad-violin', label: 'Sad Violin', file: 'sad-violin.mp3', category: 'tension', defaultVolume: 0.5, use: 'tiny sad violin; mock pity, a small misfortune' },
  'this-is-the-end': { id: 'this-is-the-end', label: 'This Is The End', file: 'this-is-the-end-adele.mp3', category: 'tension', defaultVolume: 0.5, use: 'Adele "this is the end"; something ending dramatically' },

  // --- Memes & Voices ------------------------------------------------------
  'a-few-moments-later': { id: 'a-few-moments-later', label: 'A Few Moments Later', file: 'a-few-moments-later-sponge-bob-meme.mp3', category: 'meme', defaultVolume: 0.6, use: 'SpongeBob "a few moments later"; a time skip' },
  dexter: { id: 'dexter', label: 'Dexter', file: 'dexter-meme.mp3', category: 'meme', defaultVolume: 0.6, use: 'Dexter meme sting; a comedic reveal or smug moment' },
  spiderman: { id: 'spiderman', label: 'Spider-Man Theme', file: 'spiderman-meme-song.mp3', category: 'meme', defaultVolume: 0.55, use: 'Spider-Man theme; heroic or comedic triumph' },
  'let-him-cook': { id: 'let-him-cook', label: 'Let Him Cook', file: 'let-him-cook-now.mp3', category: 'meme', defaultVolume: 0.6, use: '"let him cook"; someone doing something impressive' },
  'who-are-you': { id: 'who-are-you', label: 'Who Are You', file: 'who-r-u-1.mp3', category: 'meme', defaultVolume: 0.6, use: '"who are you?"; a surprising identity or reveal' },
  'yep-thats-me': { id: 'yep-thats-me', label: "Yep, That's Me", file: 'yep_-that_s-me-you_re-probably-wondering.mp3', category: 'meme', defaultVolume: 0.6, use: '"yep, that’s me, you’re probably wondering"; freeze-frame self-intro' },
  faaah: { id: 'faaah', label: 'Faaah', file: 'faaah.mp3', category: 'meme', defaultVolume: 0.6, use: 'loud comedic "faaah"; an absurd or shocking beat' },
  awww: { id: 'awww', label: 'Awww', file: 'awwwww.mp3', category: 'meme', defaultVolume: 0.6, use: 'crowd "awww"; something sweet or disappointing' },
  romance: { id: 'romance', label: 'Romance', file: 'romanceeeeeeeeeeeeee.mp3', category: 'meme', defaultVolume: 0.55, use: 'swooning romance sting; a romantic or fawning beat' },
  'indian-song': { id: 'indian-song', label: 'Indian Song', file: 'indian-song.mp3', category: 'meme', defaultVolume: 0.5, use: 'Indian song clip; comedic cultural punchline' },

  // --- Stings --------------------------------------------------------------
  'netflix-intro': { id: 'netflix-intro', label: 'Netflix Intro', file: 'netflix-intro.mp3', category: 'sting', defaultVolume: 0.55, use: 'Netflix "ta-dum"; a dramatic reveal or title moment' },
  'netflix-intro-long': { id: 'netflix-intro-long', label: 'Netflix Intro (Long)', file: 'netflix-original-long-intro.mp3', category: 'sting', defaultVolume: 0.55, use: 'full-length Netflix intro; a big title moment, used sparingly' }
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
 * The library grouped for display: `[{ id, label, sounds }]`, in
 * SOUND_CATEGORIES order, skipping any group that has nothing in it.
 *
 * A sound whose category is not in the list still appears, under "Other" —
 * adding an asset should never make it silently invisible in the picker just
 * because its category was not registered here first.
 */
export function listSoundsByCategory() {
  const byCategory = new Map(SOUND_CATEGORIES.map((c) => [c.id, []]));
  const extras = [];
  listSounds().forEach((sound) => {
    const bucket = byCategory.get(sound.category);
    if (bucket) bucket.push(sound);
    else extras.push(sound);
  });
  const groups = SOUND_CATEGORIES
    .map((c) => ({ id: c.id, label: c.label, sounds: byCategory.get(c.id) }))
    .filter((group) => group.sounds.length > 0);
  if (extras.length) groups.push({ id: 'other', label: 'Other', sounds: extras });
  return groups;
}

/**
 * The library written out for the content-analysis prompt, grouped by
 * category: the exact, closed set of sound IDs the model may name.
 *
 * GENERATED, never hand-written. That is the whole point. The original design
 * kept sound names out of the prompt because hard-coding them would mean
 * re-prompting and re-validating the model every time the sound design
 * changed — a real cost, and the reason the model was only ever told about
 * meaning. Deriving the list from the registry removes that cost: adding an
 * asset here offers it to the model on the very next call, with no prompt
 * edit and nothing to keep in sync. What remains true is that the model
 * cannot invent an ID, because everything it returns is checked back against
 * this same registry (see isKnownSoundId).
 *
 * Each entry carries its `use` — what the sound IS and when to reach for it —
 * because a name is not a description. "faaah (Faaah)" and "core-hit (Core
 * Hit)" tell a model nothing it can act on, so it was picking by whichever id
 * looked vaguely apt and defaulting to the three or four with self-evident
 * names. A sound nobody can tell apart from its label is functionally missing
 * from the library however carefully it is registered, which is the same
 * failure as not registering it at all.
 *
 * Still generated, so the cost of describing a sound is paid once, here, next
 * to the asset it describes — not in a prompt that would then have to be kept
 * in step with the registry by hand.
 */
export function describeSoundLibraryForPrompt() {
  return listSoundsByCategory()
    .map((group) => {
      const lines = group.sounds.map((s) => `  ${s.id} — ${s.use || s.label}`);
      return `${group.label}:\n${lines.join('\n')}`;
    })
    .join('\n');
}

/**
 * Browser-side URL for a sound. `baseUrl` defaults to the app's own static
 * root; pass a CDN/object-storage origin (or set VITE_SOUNDS_BASE_URL, which
 * src/js/components/audioEngine.js reads) to serve them from elsewhere with
 * no other code change.
 */
export function resolveSoundUrl(soundId, baseUrl = `/${SOUNDS_DIR_NAME}`) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  // Encoded, because asset filenames are whatever the sound came with —
  // several ship with spaces and parentheses ("ES_Riser Metallic - SFX
  // Producer.mp3"), which are not legal in a URL path as-is. The server-side
  // resolver needs no equivalent: it joins a real filesystem path.
  return `${trimmed}/${encodeURIComponent(getSoundDefinition(soundId).file)}`;
}

/** Just the file name — for the server-side path resolver, which owns its own directory root. */
export function resolveSoundFileName(soundId) {
  return getSoundDefinition(soundId).file;
}
