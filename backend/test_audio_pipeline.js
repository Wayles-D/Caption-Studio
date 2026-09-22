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
import { SOUND_REGISTRY, resolveSoundUrl, getSoundDefinition } from '../shared/soundRegistry.js';
import { resolveSoundMapping, SEMANTIC_EVENT_TYPES, isKnownSemanticEventType } from '../shared/soundProfiles.js';
import { resolveEventTimestamps } from './services/keywordAnalysisService.js';
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
