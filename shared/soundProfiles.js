/**
 * THE semantic-event -> sound-effect mapping — the editor's own decision
 * layer, deliberately kept out of the AI prompt.
 *
 * The content analysis (backend/services/keywordAnalysisService.js) reports
 * only what is happening in the speech: "this is a list item", "this is a
 * reveal". It has no idea that a list item currently sounds like a tick, and
 * it must not: baking sound names into the prompt would mean every future
 * sound-design change required re-prompting (and re-validating) the model,
 * and would let the model invent sound IDs that don't exist.
 *
 * So the contract is one-way and narrow:
 *   AI      -> "type": "list_item"     (semantic, from SEMANTIC_EVENT_TYPES)
 *   editor  -> list_item currently means the `tick` sound   (this file)
 *   user    -> ...unless they changed it (appState.soundEventMapping)
 *
 * That's what makes alternative sound profiles/presets possible later without
 * touching the analysis at all — a profile is just another mapping object.
 */
import { isKnownSoundId } from './soundRegistry.js';

/**
 * The closed set of semantic event types the analysis is allowed to emit.
 * Anything outside this list is dropped on arrival (see
 * keywordAnalysisService.js's validation) rather than silently flowing into
 * the timeline as an event nothing knows how to map.
 *
 * Deliberately small: only types that genuinely change what a creator would
 * do with a moment. More can be added here (and to the prompt's enumeration)
 * as real uses appear — see this feature's own "only add event types that are
 * actually useful" constraint.
 */
export const SEMANTIC_EVENT_TYPES = [
  'list_start',
  'list_item',
  'emphasis',
  'reveal',
  'transition',
  'question',
  'answer',
  'important_statement'
];

/** Human-facing labels for the event types above — used wherever an event is shown in the UI. */
export const SEMANTIC_EVENT_LABELS = {
  list_start: 'List starts',
  list_item: 'List item',
  emphasis: 'Emphasis',
  reveal: 'Reveal',
  transition: 'Transition',
  question: 'Question',
  answer: 'Answer',
  important_statement: 'Key statement'
};

export function isKnownSemanticEventType(type) {
  return SEMANTIC_EVENT_TYPES.includes(type);
}

/**
 * A semantic moment's STABLE identity: its type plus its resolved timestamp.
 *
 * Deliberately derived rather than random, because the analysis produces a
 * fresh object on every run and the placed effect gets a fresh clip id — so
 * neither can be used to recognise "this is the same moment I already saw".
 * The same moment in the same speech resolves to the same word and therefore
 * the same key, which is what lets a re-run tell an already-handled
 * suggestion from a genuinely new one.
 *
 * Matches the key keywordAnalysisService.js already de-duplicates on, so the
 * two cannot disagree about what counts as "the same event".
 */
export function getSemanticEventKey(event) {
  if (!event || !isKnownSemanticEventType(event.type) || !Number.isFinite(event.timestamp)) return null;
  return `${event.type}@${event.timestamp.toFixed(3)}`;
}

/**
 * Sound profiles. `mapping` maps a semantic event type to a sound ID, or to
 * `null` for "this event type produces no sound by default" — an event with a
 * null mapping still appears in the editor as a recognized moment (so the
 * user can add something there themselves), it just doesn't auto-place an
 * effect.
 */
export const SOUND_PROFILES = {
  default: {
    id: 'default',
    label: 'Default',
    description: 'Clean UI-style effects — ticks for list beats, pops for reveals.',
    mapping: {
      list_start: 'whoosh',
      list_item: 'tick',
      emphasis: 'pop',
      reveal: 'pop',
      transition: 'whoosh',
      question: null,
      answer: 'click',
      important_statement: 'hit'
    }
  },
  minimal: {
    id: 'minimal',
    label: 'Minimal',
    description: 'Only the list beats — nothing else makes a sound.',
    mapping: {
      list_start: null,
      list_item: 'tick',
      emphasis: null,
      reveal: null,
      transition: null,
      question: null,
      answer: null,
      important_statement: null
    }
  },
  punchy: {
    id: 'punchy',
    label: 'Punchy',
    description: 'Heavier impacts and motion — for fast, high-energy edits.',
    mapping: {
      list_start: 'whoosh',
      list_item: 'pop',
      emphasis: 'hit',
      reveal: 'pop',
      transition: 'swipe',
      question: 'click',
      answer: 'notification',
      important_statement: 'hit'
    }
  }
};

export const DEFAULT_SOUND_PROFILE_ID = 'default';

export function listSoundProfiles() {
  return Object.values(SOUND_PROFILES);
}

/**
 * The effective event-type -> sound-ID mapping: the named profile's own
 * mapping with the user's per-event-type overrides layered on top.
 *
 * `overrides` is appState.soundEventMapping — a sparse object holding ONLY
 * the event types the user has personally re-pointed (including to `null`,
 * meaning "I don't want a sound for this"), so switching profiles keeps those
 * deliberate choices instead of silently discarding them.
 */
export function resolveSoundMapping(profileId = DEFAULT_SOUND_PROFILE_ID, overrides = {}) {
  const profile = SOUND_PROFILES[profileId] || SOUND_PROFILES[DEFAULT_SOUND_PROFILE_ID];
  const mapping = { ...profile.mapping };
  Object.entries(overrides || {}).forEach(([type, soundId]) => {
    if (!isKnownSemanticEventType(type)) return;
    // `null` is a meaningful override ("silence this event type"), so it is
    // kept; an unknown/removed sound ID is not, and falls back to the
    // profile's own choice rather than producing a silent mystery.
    if (soundId === null || isKnownSoundId(soundId)) mapping[type] = soundId;
  });
  return mapping;
}

/** The sound ID one semantic event type currently resolves to, or null for "no sound". */
export function resolveSoundForEventType(eventType, profileId, overrides) {
  return resolveSoundMapping(profileId, overrides)[eventType] ?? null;
}
