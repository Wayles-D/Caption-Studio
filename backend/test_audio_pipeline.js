/**
 * Audio timeline verification — the sound-effect/audio-track feature's own
 * engine tests, in the same style as test_caption_engine.js.
 *
 * Focused on the parts where a bug would be silent rather than loud: the
 * transcript-driven event timing (an effect landing NEAR a word instead of ON
 * it), the semantic-event -> sound mapping the editor owns, and the FFmpeg
 * filter graph that decides whether any of it reaches the exported file at
 * all. The end-to-end "does the MP4 actually contain this" check lives in the
 * rendered-output verification (see this feature's own validation run) — what
 * is asserted here is everything that determines what that render is asked to
 * produce.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeAudioTimeline,
  createSoundEvent,
  createAudioTrack,
  getAudioTrackDuration,
  hasAnyAudio,
  isDefaultVideoAudio
} from '../shared/audioTimeline.js';
import { SOUND_REGISTRY, SOUND_IDS, resolveSoundUrl, getSoundDefinition, describeSoundLibraryForPrompt } from '../shared/soundRegistry.js';
import {
  resolveSoundMapping, SEMANTIC_EVENT_TYPES, isKnownSemanticEventType,
  SFX_SOUND_CATEGORIES, resolveCategorySound, getWordSoundKey
} from '../shared/soundProfiles.js';
import { resolveEventTimestamps, buildSystemPrompt, buildResponseSchema, encodeTranscriptForModel, parseRetryAfterMs } from './services/keywordAnalysisService.js';
import { selectDirectedMoments, resolveDirectedPlacement, resolveRunDurations, isStructuralMomentType, MICRO_MAX_DURATION } from '../shared/sfxDirection.js';
import { buildAudioMixGraph, SOUNDS_DIR, resolveAudioAssetPath } from './utils/audioMixFilter.js';

console.log('--- Starting Caption Studio Audio Timeline Verification ---');

// 1. Every registered sound has a real asset on disk.
console.log('\n[Test 1] Sound Registry Resolves To Real, Bundled Assets');
const missing = Object.values(SOUND_REGISTRY).filter((s) => !fs.existsSync(path.join(SOUNDS_DIR, s.file)));
assert.strictEqual(missing.length, 0, `Missing sound assets: ${missing.map((s) => s.file).join(', ')} — run: node backend/scripts/generate-sounds.js`);
// The registry is the only place a path is constructed, on either side.
assert.strictEqual(resolveSoundUrl('tick'), '/sounds/tick.mp3', 'Browser URLs resolve through the registry');
assert.strictEqual(resolveSoundUrl('tick', 'https://cdn.example.com/fx'), 'https://cdn.example.com/fx/tick.mp3', 'A CDN base is the whole migration — no code change');
assert.strictEqual(getSoundDefinition('not-a-real-sound').id, 'tick', 'An unknown sound id falls back rather than rendering silence');
console.log(`✓ All ${Object.keys(SOUND_REGISTRY).length} registered sounds present; paths only ever resolve through the registry`);

// 2. The AI never supplies a time — the transcript does.
console.log('\n[Test 2] Event Timestamps Come From The Transcript, Never The Model');
const words = [
  { word: 'Here', start: 0.10, end: 0.35 }, { word: 'are', start: 0.36, end: 0.52 },
  { word: 'five', start: 0.53, end: 0.90 }, { word: 'things', start: 0.91, end: 1.30 },
  { word: 'you', start: 1.31, end: 1.45 }, { word: 'need', start: 1.46, end: 1.70 },
  { word: 'to', start: 1.71, end: 1.80 }, { word: 'know.', start: 1.81, end: 2.20 },
  { word: 'Number', start: 2.60, end: 2.91 }, { word: 'one,', start: 2.92, end: 3.42 },
  { word: 'learn', start: 3.50, end: 3.80 }, { word: 'JavaScript.', start: 3.81, end: 4.60 },
  { word: 'Number', start: 6.80, end: 7.10 }, { word: 'two,', start: 7.11, end: 7.18 },
  { word: 'learn', start: 7.30, end: 7.60 }, { word: 'React.', start: 7.61, end: 8.20 },
  { word: 'Number', start: 11.20, end: 11.55 }, { word: 'three,', start: 11.56, end: 11.64 },
  { word: 'learn', start: 11.80, end: 12.10 }, { word: 'backend', start: 12.11, end: 12.60 },
  { word: 'development.', start: 12.61, end: 13.40 }
];

// Exactly the shape the model is asked to return: a TYPE and a WORD INDEX.
const modelResponse = [
  { type: 'list_start', wordIndex: 8 },
  { type: 'list_item', index: 1, wordIndex: 9 },
  { type: 'list_item', index: 2, wordIndex: 13 },
  { type: 'list_item', index: 3, wordIndex: 17 },
  // Everything below must be discarded, not repaired.
  { type: 'list_item', index: 4, wordIndex: 999 },       // out of range
  { type: 'sound_effect', wordIndex: 2 },                 // not an allowed type
  { type: 'list_item', wordIndex: 'three' },              // malformed index
  null
];

const events = resolveEventTimestamps(modelResponse, words);
assert.strictEqual(events.length, 4, 'Malformed/out-of-range/unknown-type entries are dropped, not repaired');
assert.deepStrictEqual(
  events.map((e) => e.timestamp),
  [2.60, 2.92, 7.11, 11.56],
  'Each event takes its anchor word\'s OWN start time from the transcript'
);
assert.strictEqual(events[1].word, 'one,', 'The anchor word is carried through for the UI to explain the placement');
events.forEach((e) => assert.ok(isKnownSemanticEventType(e.type), 'Only allowed semantic types survive validation'));

// A model that reports the same moment twice must not stack two identical
// effects on the same instant (which is just an unexplained louder one).
const duplicated = resolveEventTimestamps(
  [{ type: 'list_item', wordIndex: 9 }, { type: 'list_item', wordIndex: 9 }],
  words
);
assert.strictEqual(duplicated.length, 1, 'Duplicate (type, timestamp) events collapse to one');
console.log(`✓ 4 semantic events resolved to exact transcript times (${events.map((e) => e.timestamp).join('s, ')}s); junk dropped`);


// 2b. The model may name a sound — from a list it is GIVEN, and never one it
// invented.
console.log('\n[Test 2b] The Model Picks From The Registry, And Cannot Invent An ID');

// The enumeration is generated, so every registered sound reaches the model
// on the next call with no prompt edit. This is the assertion that fails if
// someone ever pastes a fixed list into the prompt.
const prompt = buildSystemPrompt();
const absent = SOUND_IDS.filter((id) => !prompt.includes(id));
assert.deepStrictEqual(absent, [], `Every registered sound must be offered to the model; missing: ${absent.join(', ')}`);
assert.ok(describeSoundLibraryForPrompt().includes('Memes & Voices'), 'Sounds reach the model grouped, so the category carries meaning an opaque id does not');
// Every sound describes ITSELF. A name is not a description: "faaah" and
// "core-hit" tell a model nothing it can act on, and a sound it cannot tell
// apart from its label is functionally missing from the library however
// carefully it is registered. This is the assertion that fails when someone
// adds an asset without saying what it is for.
const undescribed = Object.values(SOUND_REGISTRY).filter((s) => !s.use || s.use.length < 10);
assert.deepStrictEqual(undescribed.map((s) => s.id), [], 'Every registered sound says what it is and when to use it');
Object.values(SOUND_REGISTRY).forEach((s) => {
  assert.ok(prompt.includes(s.use), `"${s.id}" reaches the model with its description, not just its id`);
});

// A named sound survives validation and rides along with the event.
const named = resolveEventTimestamps(
  [
    { type: 'reveal', wordIndex: 9, soundId: 'netflix-intro' },
    { type: 'transition', wordIndex: 13, soundId: 'not-a-real-sound' },
    { type: 'emphasis', wordIndex: 17 }
  ],
  words,
  { allowSoundId: true }
);
assert.strictEqual(named.length, 3, 'A bad sound id costs the moment its SOUND, never the moment itself');
assert.strictEqual(named[0].soundId, 'netflix-intro', 'A real id from the library is carried through');
assert.strictEqual(named[1].soundId, undefined, 'An invented id is dropped rather than placed, mapped or repaired');
assert.strictEqual(named[2].soundId, undefined, 'An event with no suggestion simply has none');

// Visual suggestions are pictures. They never carry a sound, even if the
// model volunteers one.
const visual = resolveEventTimestamps([{ type: 'reveal', wordIndex: 9, soundId: 'netflix-intro' }], words);
assert.strictEqual(visual[0].soundId, undefined, 'Visual suggestions never carry a sound id');
// Intensity, reason and the phrase range. Each is validated INDEPENDENTLY: a
// malformed one costs its own field, never the moment, because a moment the
// model correctly spotted should not vanish over a stray confidence value.
const rated = resolveEventTimestamps(
  [
    { type: 'hook', wordIndex: 8, intensity: 0.92, reason: 'Opening_Hook!!', endWordIndex: 11 },
    { type: 'emphasis', wordIndex: 13, intensity: 1.8 },           // out of range
    { type: 'reveal', wordIndex: 17, intensity: 'very', reason: 42 }, // wrong types
    { type: 'dramatic', wordIndex: 9, endWordIndex: 2 }             // backwards range
  ],
  words,
  { allowSoundId: true }
);
const byType = Object.fromEntries(rated.map((e) => [e.type, e]));
assert.strictEqual(rated.length, 4, 'A bad intensity or range costs the FIELD, not the moment');
assert.strictEqual(byType.hook.intensity, 0.92, 'A stated confidence is carried through');
assert.strictEqual(byType.hook.reason, 'opening_hook', 'The reason is normalized to a plain lower-case label');
assert.strictEqual(byType.hook.endWordIndex, 11, 'A valid phrase range is kept');
assert.ok(byType.hook.endTimestamp > byType.hook.timestamp, 'The range resolves to real transcript times, same as the start');
assert.strictEqual(byType.emphasis.intensity, 1, 'An out-of-range confidence is clamped, not discarded');
assert.strictEqual(byType.reveal.intensity, undefined, 'A non-numeric confidence is absent, not defaulted — "unrated" and "rated 0.5" differ');
assert.strictEqual(byType.reveal.reason, undefined, 'A non-string reason is dropped');
assert.strictEqual(byType.dramatic.endWordIndex, undefined, 'A backwards range is dropped; the moment stays anchored to its start word');
// Every timestamp still comes from the transcript — the new fields change
// nothing about the single clock.
rated.forEach((e) => assert.ok(words.some((w) => Math.abs(w.start - e.timestamp) < 1e-9), 'Every moment still lands on a real word start'));

// The expressive vocabulary the director ranks must actually be sayable by the
// model, or the whole category is unreachable.
['hook', 'dramatic', 'punchline', 'conclusion'].forEach((type) => {
  assert.ok(prompt.includes(type), `The prompt enumerates "${type}"`);
  assert.ok(isKnownSemanticEventType(type), `"${type}" is a known semantic type`);
});
console.log(`✓ All ${SOUND_IDS.length} sounds offered to the model; invented ids dropped, events kept; intensity/reason/range validated per-field`);


// 2c. The director — which proposed moments become sounds. This is the
// arithmetic that keeps an edit sparse, and it is the reason the model is not
// asked to hold a budget it cannot check.
console.log('\n[Test 2c] The Director Keeps The Edit Sparse');

// A 60-second video: one three-item list, plus eight expressive moments the
// analysis rated differently.
const proposed = [
  { type: 'list_start', timestamp: 2.6 },
  { type: 'list_item', timestamp: 3.4, index: 1 },
  { type: 'list_item', timestamp: 7.1, index: 2 },
  { type: 'list_item', timestamp: 11.5, index: 3 },
  { type: 'hook', timestamp: 0.8, intensity: 0.92, reason: 'opening_hook' },
  { type: 'emphasis', timestamp: 3.9, intensity: 0.70 },   // lands on a list beat
  { type: 'emphasis', timestamp: 18.0, intensity: 0.60 },
  { type: 'important_statement', timestamp: 24.0, intensity: 0.85 },
  { type: 'emphasis', timestamp: 30.0, intensity: 0.40 },  // weak
  { type: 'dramatic', timestamp: 36.0, intensity: 0.80 },
  { type: 'punchline', timestamp: 42.0, intensity: 0.50 }, // weak
  { type: 'conclusion', timestamp: 55.0, intensity: 0.90 }
];

const directed = selectDirectedMoments(proposed, { duration: 60, sensitivity: 0.5 });

// THE LIST IS UNTOUCHED. This is the behaviour that existed before the
// director and the one thing it must never thin out: a creator who says "here
// are five things" expects five beats, not the two strongest.
assert.deepStrictEqual(
  directed.structural.map((e) => e.timestamp),
  [2.6, 3.4, 7.1, 11.5],
  'Every list moment survives, in order, regardless of budget'
);
directed.structural.forEach((e) => assert.ok(isStructuralMomentType(e.type), 'Only list moments are exempt'));

// Sparse: a 60s video does not get eight accents just because eight were
// proposed.
assert.ok(directed.directed.length < 8, 'Not every proposed moment is placed');
assert.strictEqual(directed.directed.length, 5, 'A 60s video takes five accents at the default budget');
assert.deepStrictEqual(
  directed.directed.map((e) => e.timestamp),
  [0.8, 18.0, 24.0, 36.0, 55.0],
  'Placed in time order, whatever order they were ranked in'
);

// ...and it dropped the RIGHT ones, for stated reasons.
const why = Object.fromEntries(directed.rejected.map((r) => [r.event.timestamp, r.reason]));
assert.strictEqual(why[30.0], 'below-threshold', 'A weakly-rated moment is not placed');
assert.strictEqual(why[42.0], 'below-threshold', 'Nor is a middling one');
// The one that matters most: an accent must never stack on a list beat.
assert.strictEqual(why[3.9], 'too-close', 'A moment landing on a list beat is dropped, not layered');

// No two sounds closer than the minimum gap — across BOTH kinds, which is what
// makes the check above general rather than a special case for lists.
const allTimes = [...directed.structural, ...directed.directed].map((e) => e.timestamp).sort((a, b) => a - b);
for (let i = 1; i < allTimes.length; i++) {
  const gap = allTimes[i] - allTimes[i - 1];
  assert.ok(gap >= 0.7, `Placed sounds stay apart (${allTimes[i - 1]} -> ${allTimes[i]} = ${gap.toFixed(2)}s)`);
}

// Sensitivity moves the threshold, never the structure — and "more" is still
// not "everything".
const rare = selectDirectedMoments(proposed, { duration: 60, sensitivity: 0 });
const more = selectDirectedMoments(proposed, { duration: 60, sensitivity: 1 });
assert.ok(rare.directed.length <= directed.directed.length, 'Rare places no more than the default');
assert.ok(more.directed.length >= directed.directed.length, 'More places no fewer');
assert.ok(more.directed.length < 8, 'Even at maximum sensitivity it does not place everything proposed');
assert.strictEqual(more.structural.length, 4, 'Sensitivity never touches the list beats');

// A long video does not get a proportional flood; a short one still gets
// something. Both are the per-minute rate hitting its cap and its floor.
const many = Array.from({ length: 200 }, (_, i) => ({ type: 'emphasis', timestamp: i * 3, intensity: 0.95 }));
assert.ok(selectDirectedMoments(many, { duration: 600 }).directed.length <= 12, 'A 10-minute video is capped, not scaled');
assert.ok(selectDirectedMoments(many.slice(0, 4), { duration: 8 }).directed.length >= 1, 'A very short clip still gets an accent');

// Unknown duration must not mean unlimited.
assert.ok(selectDirectedMoments(many, {}).directed.length <= 12, 'An unmeasured video still gets a cap');

// An analysis from before intensity existed is treated as middling, not
// dropped — otherwise upgrading would look like the feature breaking.
const legacy = [{ type: 'emphasis', timestamp: 5 }, { type: 'reveal', timestamp: 20 }];
assert.strictEqual(selectDirectedMoments(legacy, { duration: 60, sensitivity: 1 }).directed.length, 2, 'Moments with no intensity still place');
// ...including at the STRICTEST setting, which is the real regression guard:
// the threshold judges a confidence the model stated, and an analysis stored
// before intensity existed never had the chance to state one.
assert.strictEqual(selectDirectedMoments(legacy, { duration: 60, sensitivity: 0 }).directed.length, 2, 'An unrated moment is never thresholded out, however strict the setting');
// But it is still governed by the budget and the spacing, which is where
// sparseness comes from for old and new analyses alike.
const legacyFlood = Array.from({ length: 40 }, (_, i) => ({ type: 'emphasis', timestamp: i * 4 }));
assert.ok(selectDirectedMoments(legacyFlood, { duration: 160 }).directed.length <= 12, 'An unrated flood is still capped');

// Level follows confidence; length is capped so an accent stays an accent.
const loud = resolveDirectedPlacement(0.7, 0.9);
const soft = resolveDirectedPlacement(0.7, 0.2);
assert.ok(loud.volume > soft.volume, 'A more confident moment is louder');
assert.ok(loud.volume <= 0.7 * 1.1 + 1e-9, 'Intensity scales around the sound\'s own default rather than replacing it');
assert.strictEqual(loud.duration, MICRO_MAX_DURATION, 'A micro-SFX is capped to a beat');
assert.ok(loud.fadeOut > 0, 'The cap comes with a fade, or truncation clicks');
assert.ok(resolveDirectedPlacement(0.7, 5).volume <= 2, 'An out-of-range intensity cannot exceed the volume ceiling');
console.log(`✓ ${directed.structural.length} list beats kept; ${directed.directed.length} of 8 accents placed (${directed.rejected.map((r) => r.reason).join(', ')})`);


// 2d. WORD-LEVEL. A sound lands on a word, not a sentence. "Five home office
// hacks" is one idea and four sounds, each on its own word's timestamp.
console.log('\n[Test 2d] Sounds Are Placed Per Word, And A Run Is One Decision');

// Real timings from the home-office test video's opening, including its one
// genuinely backwards pair (word 8 starts before word 7), which Whisper does
// produce and which the pipeline must survive rather than trust blindly.
const intro = [
  { word: 'Here', start: 0.00 }, { word: 'are', start: 0.24 }, { word: '5', start: 0.38 },
  { word: 'home', start: 0.62 }, { word: 'office', start: 0.76 }, { word: 'hacks', start: 1.06 },
  { word: 'to', start: 1.32 }, { word: 'your', start: 7.24 }, { word: 'monitor', start: 6.96 },
  { word: 'the', start: 7.90 }, { word: 'of', start: 8.00 }, { word: 'desk', start: 8.10 }
];

const run = resolveEventTimestamps(
  [{ type: 'topic', words: [2, 3, 4, 5], soundCategory: 'ui', intensity: 0.8, reason: 'topic_intro' }],
  intro, { allowSoundId: true }
);
assert.strictEqual(run.length, 1, 'One idea is one event...');
assert.deepStrictEqual(
  run[0].words.map((w) => [w.word, w.timestamp]),
  [['5', 0.38], ['home', 0.62], ['office', 0.76], ['hacks', 1.06]],
  '...carrying four words, each on ITS OWN transcript timestamp'
);
assert.strictEqual(run[0].timestamp, 0.38, 'The event-level time is its first word');
assert.strictEqual(run[0].endTimestamp, 1.06, 'and its end is its last word');
assert.strictEqual(run[0].soundCategory, 'ui', 'The category rides along for BHYND to resolve');

// Speaking order and per-word validation: out-of-range, duplicate and
// non-integer indexes each cost only themselves.
const messy = resolveEventTimestamps(
  [{ type: 'entity', words: [5, 3, 999, 3, 'x', 4], soundCategory: 'ui' }],
  intro, { allowSoundId: true }
);
assert.deepStrictEqual(messy[0].words.map((w) => w.wordIndex), [3, 4, 5], 'Bad indexes are dropped one by one; the run is sorted into speaking order');

// The guard on function words. The model's index slips by a word — on the
// test video it placed sounds on "of", "the", "your" — and no editor puts a
// click on "of". Removed from a run; a run of nothing but them is dropped.
const slipped = resolveEventTimestamps(
  [
    { type: 'emphasis', words: [9, 10, 11], soundCategory: 'emphasis' },
    { type: 'emphasis', words: [10], soundCategory: 'emphasis' }
  ],
  intro, { allowSoundId: true }
);
assert.strictEqual(slipped.length, 1, 'A run of only function words is dropped outright');
assert.deepStrictEqual(slipped[0].words.map((w) => w.word), ['desk'], 'Function words are stripped from a run; the content word keeps its sound');

// A run is bounded in length AND time, so it cannot be used to walk a
// sentence's worth of sounds past the director's budget.
const long = Array.from({ length: 20 }, (_, i) => ({ word: `w${i}`, start: i * 0.3 }));
const capped = resolveEventTimestamps([{ type: 'topic', words: long.map((_, i) => i), soundCategory: 'ui' }], long, { allowSoundId: true });
assert.ok(capped[0].words.length <= 6, 'A run carries at most six words');
const spread = [{ word: 'alpha', start: 0 }, { word: 'beta', start: 2 }, { word: 'gamma', start: 30 }];
const windowed = resolveEventTimestamps([{ type: 'entity', words: [0, 1, 2], soundCategory: 'ui' }], spread, { allowSoundId: true });
assert.deepStrictEqual(windowed[0].words.map((w) => w.word), ['alpha', 'beta'], 'A word far outside the time window of its run is dropped');

// A category the model invented costs the category, not the event.
const badCategory = resolveEventTimestamps([{ type: 'topic', words: [3], soundCategory: 'explosion' }], intro, { allowSoundId: true });
assert.strictEqual(badCategory.length, 1, 'An unknown category keeps the event');
assert.strictEqual(badCategory[0].soundCategory, undefined, '...without the category');

// The old one-word answer shape still places, as a one-word run.
const legacyShape = resolveEventTimestamps([{ type: 'list_item', wordIndex: 3, index: 1 }], intro, { allowSoundId: true });
assert.deepStrictEqual(legacyShape[0].words.map((w) => w.word), ['home'], 'A single wordIndex is a one-word run');

// BHYND picks the sound for a category, and every category resolves.
SFX_SOUND_CATEGORIES.forEach((c) => {
  const id = resolveCategorySound(c.id);
  assert.ok(id && SOUND_REGISTRY[id], `Category "${c.id}" resolves to a registered sound (${id})`);
});

// The model is sent the compact form, and it still carries every index.
const encoded = encodeTranscriptForModel(intro);
assert.ok(encoded.startsWith('0:Here 1:are 2:5 3:home'), 'The transcript goes to the model as index:word pairs');
assert.strictEqual(encoded.split(' ').length, intro.length, 'One pair per word, so every index still lines up');

// The schema the provider enforces names exactly the vocabulary this app knows.
const schema = buildResponseSchema();
const ev = schema.properties.events.items.properties;
assert.deepStrictEqual(ev.type.enum, SEMANTIC_EVENT_TYPES, 'Event types are enforced by the schema');
assert.deepStrictEqual(ev.soundCategory.enum, SFX_SOUND_CATEGORIES.map((c) => c.id), 'Categories are enforced by the schema');
assert.deepStrictEqual(ev.soundId.anyOf[0].enum, SOUND_IDS, 'Sound ids are enforced by the schema');
assert.ok(schema.properties.events.items.required.includes('words'), 'Every event must say which words');

// Rate limits: the wait the provider names is the wait we honour.
const fakeResponse = (retryAfter) => ({ headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) } });
assert.strictEqual(parseRetryAfterMs(fakeResponse('7'), ''), 7000, 'The retry-after header is read in seconds');
assert.strictEqual(parseRetryAfterMs(fakeResponse(null), 'Please try again in 18.5475s. Need more'), 18548, 'The wait is read from the message body');
assert.strictEqual(parseRetryAfterMs(fakeResponse(null), 'try again in 1m2.5s'), 62500, 'Minutes are understood');
assert.strictEqual(parseRetryAfterMs(fakeResponse(null), 'no hint here'), null, 'No hint means no wait');

// A RUN is one editorial decision to the director — it counts once against
// the budget, and the gap rule measures between runs, never inside one.
const directedRuns = selectDirectedMoments([
  { type: 'topic', timestamp: 0.38, intensity: 0.8, words: run[0].words },
  { type: 'emphasis', timestamp: 20, intensity: 0.7, words: [{ timestamp: 20 }] }
], { duration: 30, sensitivity: 0.5 });
assert.strictEqual(directedRuns.directed.length, 2, 'A four-word run and a one-word accent both place');
assert.strictEqual(directedRuns.directed[0].words.length, 4, 'The run is not split by the spacing rule: its words sit 0.14-0.30s apart on purpose');

// THE REAL FAILURE, verbatim from the test video. The model marked the intro
// correctly and ran on into "productive … great"; "great" lands 0.74s before
// the first list beat, and the director used to reject the ENTIRE run over
// that one tail word — so the single most important moment in the video got
// no sound at all. A run now loses only the words that collide.
const realIntro = selectDirectedMoments([
  { type: 'list_item', timestamp: 3.64, words: [{ word: 'First,', timestamp: 3.64 }, { word: 'monitor', timestamp: 4.34 }] },
  {
    type: 'topic', timestamp: 0.38, intensity: 0.9,
    words: [
      { word: '5', timestamp: 0.38 }, { word: 'home', timestamp: 0.62 }, { word: 'office', timestamp: 0.76 },
      { word: 'hacks', timestamp: 1.06 }, { word: 'productive', timestamp: 1.8 }, { word: 'great', timestamp: 2.9 }
    ]
  }
], { duration: 39.28, sensitivity: 0.5 });
const introPlaced = realIntro.directed.find((e) => e.type === 'topic');
assert.ok(introPlaced, 'The intro run is placed, not rejected over one colliding word');
assert.ok(['5', 'home', 'office', 'hacks'].every((w) => introPlaced.words.some((x) => x.word === w)), 'All four topic words keep their sound');
assert.ok(!introPlaced.words.some((x) => x.word === 'great'), 'Only the colliding word is given up');
assert.deepStrictEqual(introPlaced.trimmedWords.map((w) => w.word), ['great'], 'And the trim is reported, not silent');

// ...but a run that lands on a list beat is still rejected as a whole.
const collides = selectDirectedMoments([
  { type: 'list_item', timestamp: 3.6, words: [{ timestamp: 3.6 }, { timestamp: 3.9 }] },
  { type: 'entity', timestamp: 3.9, intensity: 0.9, words: [{ timestamp: 3.9 }, { timestamp: 4.2 }] }
], { duration: 30, sensitivity: 0.5 });
assert.strictEqual(collides.directed.length, 0, 'An accent overlapping a list beat is dropped rather than layered');

// Sounds in a run follow each other rather than piling up.
const lengths = resolveRunDurations(run[0].words);
run[0].words.forEach((w, i) => {
  if (i === run[0].words.length - 1) return;
  const next = run[0].words[i + 1].timestamp;
  assert.ok(w.timestamp + lengths[i].duration <= next + 1e-9, `A sound in a run ends before the next word begins (${w.word})`);
});
assert.strictEqual(resolveRunDurations([{ timestamp: 3 }]), null, 'A single word keeps its natural length, as list beats always have');
// The backwards pair from the real transcript must not produce silence.
const backwards = resolveRunDurations([{ timestamp: 7.24 }, { timestamp: 6.96 }]);
assert.ok(backwards[0].duration > 0, 'Out-of-order transcript timings still give an audible sound');

// DE-DUPLICATION is by WORD. Adjacent words sharing a sound id are separate
// sounds; the same word reported twice is one.
assert.notStrictEqual(getWordSoundKey(0.62), getWordSoundKey(0.76), 'Two adjacent words are two sounds, even with the same sound id');
assert.strictEqual(getWordSoundKey(0.62), getWordSoundKey(0.620), 'The same word is the same sound, however it was reported');
console.log(`✓ "5 home office hacks" -> ${run[0].words.length} per-word sounds at ${run[0].words.map((w) => w.timestamp + 's').join(', ')}; run counts once; function-word slips stripped; runs never stack`);

// 3. The editor — not the model — decides what a moment sounds like.
console.log('\n[Test 3] Semantic Event -> Sound Mapping Is Owned By The Editor');
const defaultMapping = resolveSoundMapping('default', {});
assert.strictEqual(defaultMapping.list_item, 'tick', 'A list item currently means a tick');
// The model's own vocabulary contains no sound names at all, by construction.
SEMANTIC_EVENT_TYPES.forEach((type) => {
  assert.ok(!Object.keys(SOUND_REGISTRY).includes(type), `Semantic type "${type}" must not also be a sound id — the two vocabularies stay separate`);
});
// Switching profile re-points every event type without touching the analysis.
assert.strictEqual(resolveSoundMapping('punchy', {}).list_item, 'pop', 'A different profile changes the sound, not the analysis');
// A user override wins over the profile, INCLUDING an explicit "no sound".
assert.strictEqual(resolveSoundMapping('default', { list_item: 'whoosh' }).list_item, 'whoosh', 'A user override wins over the profile');
assert.strictEqual(resolveSoundMapping('default', { list_item: null }).list_item, null, 'null is a real override meaning "silence this event type"');
assert.strictEqual(resolveSoundMapping('default', { list_item: 'not-a-sound' }).list_item, 'tick', 'An unknown sound id falls back to the profile rather than going silent');
console.log('✓ Mapping lives in the editor; profiles and per-type overrides both apply without re-running the analysis');

// 4. The data model is normalized and bounded.
console.log('\n[Test 4] Clip Normalization Bounds Every Field');
const event = createSoundEvent('tick', 3.42);
assert.strictEqual(event.type, 'sound');
assert.strictEqual(event.startTime, 3.42);
assert.strictEqual(event.volume, SOUND_REGISTRY.tick.defaultVolume, 'A new effect takes its own sound\'s default level');

const wild = normalizeAudioTimeline({
  soundEvents: [
    { soundId: 'tick', startTime: -5, volume: 99, playbackRate: 50 },
    { soundId: 'pop', startTime: 8 },
    'not an object'
  ],
  audioTracks: [
    // A trim window that has collapsed — must not reach ffmpeg as end <= start
    // (an empty stream, i.e. a silently missing clip).
    { name: 'bed', assetId: 'x.mp3', startTime: 1, trimStart: 5, trimEnd: 3, sourceDuration: 20 }
  ]
});
assert.strictEqual(wild.soundEvents.length, 2, 'Non-object entries are dropped');
assert.strictEqual(wild.soundEvents[0].startTime, 0, 'A negative start clamps to the timeline origin');
assert.ok(wild.soundEvents[0].volume <= 2, 'Volume is bounded');
assert.ok(wild.soundEvents[0].playbackRate <= 2, 'Playback rate is bounded to what a single atempo stage accepts');
assert.deepStrictEqual(wild.soundEvents.map((e) => e.startTime), [0, 8], 'Clips come back time-sorted');
assert.strictEqual(wild.audioTracks[0].trimEnd, null, 'An inverted trim window is discarded rather than producing an empty stream');
assert.strictEqual(getAudioTrackDuration(wild.audioTracks[0]), 15, 'Duration falls back to source length minus the trim-in');

// The wire format has to survive multipart form transport, where every field
// arrives as a string.
const fromString = normalizeAudioTimeline(JSON.stringify({ soundEvents: [{ soundId: 'tick', startTime: 2 }], audioTracks: [] }));
assert.strictEqual(fromString.soundEvents.length, 1, 'A JSON string payload normalizes identically to an object');
assert.strictEqual(hasAnyAudio(normalizeAudioTimeline({})), false, 'An empty timeline reports nothing to mix');
console.log('✓ Out-of-range, malformed and string-transported input all normalize safely');

// 5. Path traversal cannot reach the mixer.
console.log('\n[Test 5] Imported Asset Paths Are Not Attacker-Controlled');
['../../server.js', '/etc/passwd', 'a/b.mp3', '..\\..\\.env', ''].forEach((bad) => {
  assert.strictEqual(resolveAudioAssetPath(bad), null, `"${bad}" must never resolve to a path`);
});
console.log('✓ Only bare filenames inside the audio uploads directory resolve');

// 6. The filter graph — the thing that decides whether any of this is in the MP4.
console.log('\n[Test 6] Export Filter Graph Places Every Clip On The Video\'s Own Clock');
assert.strictEqual(
  buildAudioMixGraph({ soundEvents: [], audioTracks: [] }, { duration: 10, hasSourceAudio: true, firstInputIndex: 2 }),
  null,
  'With nothing to mix the caller keeps its existing stream-copy path completely untouched'
);

const graph = buildAudioMixGraph(
  normalizeAudioTimeline({
    soundEvents: [
      { soundId: 'tick', startTime: 3, volume: 1 },
      { soundId: 'tick', startTime: 7, volume: 1 },
      { soundId: 'whoosh', startTime: 10, volume: 0.4 }
    ],
    audioTracks: []
  }),
  { duration: 12, hasSourceAudio: true, firstInputIndex: 2 }
);
assert.strictEqual(graph.inputArgs.length, 6, 'One -i per effect');
assert.strictEqual(graph.clipCount, 3);
const joined = graph.filterStages.join('\n');

// Placement: whole-millisecond adelay against the video's own timeline. Audio
// is deliberately NOT quantized to the video frame grid — doing so is exactly
// how an effect ends up a frame away from the word it punctuates.
[3000, 7000, 10000].forEach((ms) => {
  assert.ok(joined.includes(`adelay=${ms}|${ms}:all=1`), `Effect delayed to exactly ${ms}ms`);
});
assert.ok(joined.includes('volume=0.4000'), 'Per-clip gain is the user\'s own value');

// amix's own normalization would silently duck the speech every time another
// effect was added — a mix that changes with the clip count is unusable.
assert.ok(joined.includes('normalize=0'), 'amix normalization is off so adding an effect never re-levels the speech');
assert.ok(joined.includes('dropout_transition=0'), 'No 2s duck each time a short effect ends');
assert.ok(joined.includes('duration=first'), 'The mix is pinned to the silent bed, i.e. exactly the video length');
assert.ok(joined.includes('atrim=duration=12.000'), 'The bed is exactly the video duration');
assert.ok(joined.includes('alimiter'), 'Coincident loud clips are limited rather than pre-emptively attenuated');
assert.ok(joined.includes('[0:a]'), 'The source audio is mixed in when it exists');

// A silent source must not produce a [0:a] reference — that is a hard ffmpeg
// error, not a no-op, so it cannot be left to optional mapping.
const silentSource = buildAudioMixGraph(
  normalizeAudioTimeline({ soundEvents: [{ soundId: 'tick', startTime: 1 }], audioTracks: [] }),
  { duration: 5, hasSourceAudio: false, firstInputIndex: 2 }
);
assert.ok(!silentSource.filterStages.join('\n').includes('[0:a]'), 'A video with no audio stream is never referenced as [0:a]');
console.log('✓ 3 effects place at exact millisecond offsets; mix is video-length-pinned, un-normalized and limiter-protected');

// 7. Trimming maps timeline placement onto source offsets correctly.
console.log('\n[Test 7] A Trimmed Audio Track Lands Where It Was Placed, Not Where It Was Cut');
const bed = createAudioTrack({ name: 'music', assetId: 'abc.mp3', url: 'blob:x', duration: 30 }, {
  startTime: 2, trimStart: 10, trimEnd: 18, volume: 0.3
});
assert.strictEqual(getAudioTrackDuration(bed), 8, 'The clip occupies its trim window\'s length');

// Exercised through a fake asset so resolveAudioAssetPath's existence check passes.
const audioDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'audio');
fs.mkdirSync(audioDir, { recursive: true });
const fakeAsset = path.join(audioDir, 'abc.mp3');
const created = !fs.existsSync(fakeAsset);
if (created) fs.writeFileSync(fakeAsset, '');

const bedGraph = buildAudioMixGraph({ soundEvents: [], audioTracks: [bed] }, { duration: 20, hasSourceAudio: true, firstInputIndex: 2 });
const bedStage = bedGraph.filterStages.find((s) => s.includes('[aud0]'));
assert.ok(bedStage.includes('atrim=start=10.000:end=18.000'), 'The trim window is expressed in SOURCE coordinates');
assert.ok(
  bedStage.indexOf('asetpts=PTS-STARTPTS') < bedStage.indexOf('adelay='),
  'Timestamps reset BEFORE the delay — otherwise a clip trimmed 10s in lands 10s late'
);
assert.ok(bedStage.includes('adelay=2000|2000'), 'The clip lands at its TIMELINE start, independent of where it was trimmed');
assert.ok(bedStage.includes('volume=0.3000'));
if (created) fs.unlinkSync(fakeAsset);
console.log('✓ Trim window (source coords) and placement (timeline coords) stay independent');

// 8. The video's own soundtrack is a mixable level, not a fixed constant.
console.log('\n[Test 8] The Video\'s Own Volume Is Part Of The Same Mix');
assert.strictEqual(isDefaultVideoAudio(undefined), true, 'Absent video-audio settings mean "play it exactly as it is"');
assert.strictEqual(isDefaultVideoAudio({ volume: 1, muted: false }), true);
assert.strictEqual(isDefaultVideoAudio({ volume: 0.5 }), false);
assert.strictEqual(isDefaultVideoAudio({ muted: true }), false);

// A changed video level with NO clips must still build a graph — the mix is
// the only place that level can be applied, so bailing out early would export
// the original soundtrack at full volume while the preview played it quiet.
assert.strictEqual(
  buildAudioMixGraph({ soundEvents: [], audioTracks: [], video: { volume: 1 } }, { duration: 10, hasSourceAudio: true, firstInputIndex: 2 }),
  null,
  'An untouched video level with no clips leaves the audio path alone (stream copy)'
);
const quieter = buildAudioMixGraph(
  { soundEvents: [], audioTracks: [], video: { volume: 0.4 } },
  { duration: 10, hasSourceAudio: true, firstInputIndex: 2 }
);
assert.ok(quieter, 'A changed video level alone is enough to require the mix');
assert.ok(quieter.filterStages.join('\n').includes('[0:a]volume=0.4000'), 'The video level is applied to the source audio');

// Muting drops the input entirely rather than mixing a stream scaled to zero.
const mutedGraph = buildAudioMixGraph(
  { soundEvents: [{ soundId: 'tick', startTime: 1 }], audioTracks: [], video: { muted: true } },
  { duration: 10, hasSourceAudio: true, firstInputIndex: 2 }
);
const mutedStages = mutedGraph.filterStages.join('\n');
assert.ok(!mutedStages.includes('[0:a]'), 'A muted video is not referenced at all');
assert.ok(mutedStages.includes('[sfx0]'), '...but the sound effects still play');
assert.ok(mutedStages.includes('amix=inputs=2'), 'The mix accounts for the dropped source stream');

// Boost above unity is allowed and reaches ffmpeg as a real gain.
const boosted = buildAudioMixGraph(
  { soundEvents: [], audioTracks: [], video: { volume: 1.5 } },
  { duration: 10, hasSourceAudio: true, firstInputIndex: 2 }
);
assert.ok(boosted.filterStages.join('\n').includes('volume=1.5000'), 'The video\'s audio can be boosted past unity');

// And the timeline-level check agrees, so the controllers' fallback path
// (which gates on hasAnyAudio) doesn't skip a video-only volume change.
assert.strictEqual(hasAnyAudio(normalizeAudioTimeline({ soundEvents: [], audioTracks: [], video: { volume: 0.5 } })), true);
assert.strictEqual(hasAnyAudio(normalizeAudioTimeline({ soundEvents: [], audioTracks: [] })), false);
console.log('✓ Video volume/mute participate in the mix, including with no clips present');

console.log('\n=== ALL AUDIO TIMELINE TESTS PASSED SUCCESSFULLY! ===\n');
