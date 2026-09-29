/**
 * THE semantic-event -> sound-effect mapping: what a KIND of moment sounds
 * like by default, and the editor's answer whenever the model has not named
 * something better for one particular moment.
 *
 * The layers, weakest to strongest:
 *   profile -> list_item generally means `tick`               (this file)
 *   model   -> "...but THIS moment wants `netflix-intro`"     (per moment)
 *   user    -> "...no, list items are `pop` to me"            (soundEventMapping)
 *   mute    -> "...list items make no sound at all"           (null, either source)
 *
 * applySemanticEvents resolves that order. Note the direction: a per-moment
 * pick beats a per-type default because it was chosen with more information,
 * but anything the USER said beats both, because they are the only party who
 * is not guessing.
 *
 * This file originally existed to keep sound names out of the prompt
 * entirely — hard-coding them there would have meant re-prompting and
 * re-validating the model on every sound-design change. That cost is gone
 * now that the model's list is GENERATED from the registry
 * (describeSoundLibraryForPrompt), but the mapping layer is not: it is still
 * what a profile is, what a user override acts on, and what every moment the
 * model declines to name falls back to.
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
  // STRUCTURE — the speech announcing and walking a list. These are the
  // original feature and are still placed unconditionally; see
  // shared/sfxDirection.js's STRUCTURAL_MOMENT_TYPES for why they sit outside
  // the budget that governs everything below them.
  'list_start',
  'list_item',
  // EXPRESSION — moments worth an accent. Every one of these competes for a
  // small per-video budget, so adding a type here widens what the analysis can
  // NOTICE without widening how much ends up in the edit.
  'hook',
  'emphasis',
  'reveal',
  'transition',
  'question',
  'answer',
  'important_statement',
  'dramatic',
  'punchline',
  'conclusion',
  // NAMED THINGS — the words a short-form editor accents because of WHAT
  // they are rather than what the sentence is doing: the topic being
  // introduced, a product or person or tool, a number that carries the point,
  // a keyword the sentence turns on.
  'topic',
  'entity',
  'number',
  'keyword'
];

/** Human-facing labels for the event types above — used wherever an event is shown in the UI. */
export const SEMANTIC_EVENT_LABELS = {
  list_start: 'List starts',
  list_item: 'List item',
  hook: 'Hook',
  emphasis: 'Emphasis',
  reveal: 'Reveal',
  transition: 'Transition',
  question: 'Question',
  answer: 'Answer',
  important_statement: 'Key statement',
  dramatic: 'Dramatic beat',
  punchline: 'Punchline',
  conclusion: 'Payoff',
  topic: 'Topic',
  entity: 'Name / product',
  number: 'Number',
  keyword: 'Keyword'
};

export function isKnownSemanticEventType(type) {
  return SEMANTIC_EVENT_TYPES.includes(type);
}

/**
 * THE SOUND CATEGORIES the analysis chooses between — a style of accent, not a
 * file. The model says "this word wants a `ui` sound"; BHYND decides that
 * means `click`.
 *
 * Why a category rather than a sound id as the contract: the model is good at
 * telling a punchline from a product name and bad at remembering which of
 * forty filenames is the short one, so asking it for the judgement it is good
 * at and keeping the lookup here is both more reliable and cheaper — the
 * category list is a few lines of prompt, and the library can change without
 * the model hearing about it. It may still name a specific sound id when the
 * word literally IS that thing ("cash register" for a price); that is an
 * optional refinement layered on top, validated like everything else.
 *
 * `sounds` is an ORDER, not a set: the first is the default and every word in
 * a rhythmic run gets the same one, which is what makes "five / home / office
 * / hacks" read as a pattern rather than four unrelated noises. Later entries
 * are the fallback if an earlier id is ever removed from the registry.
 */
export const SFX_SOUND_CATEGORIES = [
  {
    id: 'ui',
    label: 'UI',
    use: 'clean digital click/tick — list markers, names, and rhythmic word-by-word runs',
    sounds: ['click', 'tick', 'pop']
  },
  {
    id: 'emphasis',
    label: 'Emphasis',
    use: 'bright pop — a single word landing with weight',
    sounds: ['pop', 'click', 'ding']
  },
  {
    id: 'impact',
    label: 'Impact',
    use: 'blunt hit — a hard statement, a claim that should land heavy',
    sounds: ['hit', 'core-hit']
  },
  {
    id: 'transition',
    label: 'Transition',
    use: 'short whoosh — a change of topic or a cut in thought',
    sounds: ['whoosh', 'swipe']
  },
  {
    id: 'reveal',
    label: 'Reveal',
    use: 'shimmer or sting — something being revealed or a satisfying payoff',
    sounds: ['sparkle', 'ding', 'pop']
  },
  {
    id: 'tension',
    label: 'Tension',
    use: 'low drone or ticking — suspense, a warning, stakes, a mistake',
    sounds: ['tension', 'riser-metallic', 'clock-ticking']
  },
  {
    id: 'comedy',
    label: 'Comedy',
    use: 'meme sting — a punchline or an absurd beat',
    sounds: ['dexter', 'faaah', 'awww']
  }
];

const SFX_CATEGORY_BY_ID = new Map(SFX_SOUND_CATEGORIES.map((c) => [c.id, c]));

export function isKnownSfxCategory(id) {
  return SFX_CATEGORY_BY_ID.has(id);
}

/**
 * The sound a category means right now: its first entry that the registry
 * still knows. Null only if every candidate has been removed, in which case
 * the caller falls back to the event type's own mapping rather than guessing.
 */
export function resolveCategorySound(categoryId) {
  const category = SFX_CATEGORY_BY_ID.get(categoryId);
  if (!category) return null;
  return category.sounds.find((id) => isKnownSoundId(id)) ?? null;
}

/**
 * A placed sound's identity: THE WORD it sits on, by that word's start time.
 *
 * Deliberately neither the moment's type nor its grouping. The analysis is not
 * perfectly repeatable — the same sentence can come back as a `list_start` one
 * run and a `topic` the next, or grouped [2..5] one run and [3..5] the next — and
 * a key that included either would treat those as different sounds. Then a
 * sound the creator deleted from "home" would reappear the moment the model
 * re-grouped the phrase. "Don't put a sound on this word again" is what a
 * deletion means, so the word is the key.
 *
 * This is also the whole de-duplication rule: two proposals for the same word
 * are one sound, and two different words are two sounds even when they are
 * adjacent and share the same sound id. Matching sound ids is never grounds to
 * merge — that is exactly the rhythmic case this system exists to produce.
 *
 * Timestamp rather than word index, because an edit to the transcript's text
 * shifts every later index while leaving the spoken timing where it was.
 */
export function getWordSoundKey(timestamp) {
  return Number.isFinite(timestamp) ? `word@${timestamp.toFixed(3)}` : null;
}

/** The analysed moment a placed sound came from, for provenance in the UI. */
export function findMomentForSoundKey(moments, key) {
  if (!key || !Array.isArray(moments)) return null;
  return moments.find((m) => momentWords(m).some((w) => getWordSoundKey(w.timestamp) === key)) || null;
}

/**
 * The words a moment covers, each with its own timestamp. A moment from an
 * analysis that predates word-level output carries only a single `timestamp`;
 * it is treated as a one-word moment on that instant rather than being
 * dropped, so older results still place.
 */
export function momentWords(moment) {
  if (Array.isArray(moment?.words) && moment.words.length) return moment.words;
  if (Number.isFinite(moment?.timestamp)) {
    return [{ wordIndex: moment.wordIndex ?? null, timestamp: moment.timestamp }];
  }
  return [];
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
      hook: 'hit',
      emphasis: 'pop',
      reveal: 'pop',
      transition: 'whoosh',
      question: null,
      answer: 'click',
      important_statement: 'hit',
      dramatic: 'tension',
      // Comedy is the one category where the RIGHT sound is usually a specific
      // reference rather than a generic accent, and this profile is the clean
      // UI one — so the default is a neutral beat and the analysis is left to
      // name a meme by id when the content actually earns one.
      punchline: 'pop',
      conclusion: 'sparkle',
      topic: 'click',
      entity: 'click',
      number: 'tick',
      keyword: 'pop'
    }
  },
  minimal: {
    id: 'minimal',
    label: 'Minimal',
    description: 'Only the list beats — nothing else makes a sound.',
    mapping: {
      list_start: null,
      list_item: 'tick',
      hook: null,
      emphasis: null,
      reveal: null,
      transition: null,
      question: null,
      answer: null,
      important_statement: null,
      dramatic: null,
      punchline: null,
      conclusion: null,
      topic: null,
      entity: null,
      number: null,
      keyword: null
    }
  },
  punchy: {
    id: 'punchy',
    label: 'Punchy',
    description: 'Heavier impacts and motion — for fast, high-energy edits.',
    mapping: {
      list_start: 'whoosh',
      list_item: 'pop',
      hook: 'core-hit',
      emphasis: 'hit',
      reveal: 'pop',
      transition: 'swipe',
      question: 'click',
      answer: 'notification',
      important_statement: 'hit',
      dramatic: 'tension',
      punchline: 'pop',
      conclusion: 'cash',
      topic: 'pop',
      entity: 'click',
      number: 'hit',
      keyword: 'pop'
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
