import {
  SEMANTIC_EVENT_TYPES,
  SFX_SOUND_CATEGORIES,
  isKnownSemanticEventType,
  isKnownSfxCategory
} from '../../shared/soundProfiles.js';

/**
 * The most words one sound event may carry. A rhythmic run is a handful of
 * words ("five home office hacks" is four); past this it stops being an accent
 * and becomes a sound on every word of a sentence, which is the failure the
 * whole system is built to avoid. Words beyond it are dropped, not the event.
 */
export const MAX_WORDS_PER_EVENT = 6;
import { describeSoundLibraryForPrompt, isKnownSoundId, PROMPT_SOUND_IDS } from '../../shared/soundRegistry.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * ONE analysis pass over the transcript, producing three things at once:
 * emphasis keywords (the original job), semantic content events, and
 * suggested visual moments.
 *
 * WHY ONE CALL, not two. The model is already reading the whole transcript to
 * decide what to emphasize; asking it, in the same pass, what the speech is
 * structurally DOING costs one extra output field rather than a second
 * round-trip, a second failure mode, and a second set of latency/cost. This
 * is an extension of the existing analysis, not a parallel pipeline.
 *
 * WHAT THE MODEL IS AND ISN'T ASKED FOR:
 *
 *   - It reports SEMANTIC meaning ("this is the second item in a list"), and
 *     MAY additionally name a sound for that moment. The sound list it is
 *     given is generated from the registry at call time
 *     (describeSoundLibraryForPrompt), so adding an asset offers it to the
 *     model on the next call with no prompt edit — which is what makes
 *     naming sounds affordable here. Every ID it returns is checked back
 *     against the registry, so it cannot invent one.
 *
 *     The type still matters and is still required: it is what the editor
 *     falls back to when the model names nothing, and what sound profiles
 *     and per-type mappings act on (shared/soundProfiles.js). A named sound
 *     is a more specific suggestion layered on top of that, never a
 *     replacement for it — see applySemanticEvents for the precedence.
 *
 *   - It points at a WORD INDEX, never a timestamp. The transcription already
 *     provides word-level timings and those are the source of truth for when
 *     anything was said; a model asked to restate a time it was never given
 *     can only approximate one, producing a second, worse clock that drifts
 *     against the first. resolveEventTimestamps below turns each index back
 *     into that word's own real `start`, so an effect lands exactly on the
 *     word rather than near it.
 *
 *   - It rates each moment's INTENSITY but does not decide how many survive.
 *     A model told to "be selective" is being asked to hold a budget across a
 *     whole transcript, which it cannot check and nobody can test. It proposes
 *     candidates with confidences; shared/sfxDirection.js does the arithmetic
 *     that turns those into a handful. The prompt still argues for restraint,
 *     because a better-judged shortlist makes the director's job easier — but
 *     nothing depends on it complying.
 *
 *   - It never sees the video. Everything here is derived from the spoken
 *     content, deliberately. No frames are sent anywhere.
 */
/**
 * Built per call rather than once at module load, so the sound enumeration
 * reflects the registry as it is NOW. A module-level constant would freeze
 * the list at import time and quietly stop offering anything added later —
 * the exact drift this generation exists to prevent.
 */
function buildSystemPrompt() {
  const categories = SFX_SOUND_CATEGORIES.map((c) => `  ${c.id} — ${c.use}`).join('\n');
  return `You are a short-form video editor.
You will receive a transcript as "index:word" pairs separated by spaces, in speaking order. The number before each colon is that word's index. Refer to words ONLY by these indexes.

You have three jobs:

(1) KEYWORDS — which words deserve visual emphasis when displayed as captions.
- Favor concrete nouns, numbers, strong verbs, and emotionally/thematically significant words. Avoid filler (the, a, is, and, etc.).

(2) SOUND EVENTS — listen as an editor would, and mark the WORDS that should get a short sound accent at the instant they are spoken.

Think in WORDS, not sentences. A sound lands on a word. When a short phrase deserves the treatment, list EACH word that should get a sound, so the sounds follow the speech rhythmically:
  "Here are three budget travel tips" -> three, budget, travel, tips: four words, four sounds, the same sound.
  "I shoot everything on the Sony FX3" -> Sony and FX3, or just FX3 — your call.
  "This completely changed the way I work" -> perhaps just "changed".
Put the words of one idea in ONE event's "words" list. A single word is a one-item list.

What deserves a sound — judge by context, never by word type alone:
- THE TOPIC INTRODUCTION. The opening line that says what the video is about is the most important sound moment in most videos. Give EVERY content word of the topic its own sound, not just the number: "These are 4 easy meal prep ideas" -> 4, easy, meal, prep, ideas. Skip only filler like "here", "are", "these", "the". Stop where the topic phrase ends — in "These are 4 easy meal prep ideas to save you money every week", the sounds are on "4 easy meal prep ideas", not on "save" or "money"; the rest of the sentence is not the topic.
- list markers ("first", "next", "fourth", "last", "number two") — sound the marker word itself, and the item's name too when it is a product or thing worth hearing;
- products, companies, tools, people and places that matter to the point;
- numbers that carry the point;
- hooks, reveals, punchlines, strong claims, turns in thought, the payoff.
Put the sound on the word that CARRIES THE WEIGHT, not the first word of the phrase: in "you can finally sleep without the noise of the city", it belongs on "noise", never on "you", "the" or "of".
What does not get a sound: "I bought a chair yesterday" gets nothing; "this chair completely changed how I work" might accent "changed". Being a noun does not make a word sound-worthy — its role in the sentence does — and most sentences get no sound at all.

Fields for each sound event:
- "type": why — exactly one of: ${SEMANTIC_EVENT_TYPES.join(', ')}.
- "words": indexes of the words that each get a sound, in speaking order. At most ${MAX_WORDS_PER_EVENT}.
- "soundCategory": the style of sound — exactly one of the categories below.
- "soundId": OPTIONAL, only when the word literally IS something a specific sound depicts (a price -> cash, a camera -> camera-shutter, typing -> device-typing, drawing or underlining -> a writing- sound). Copy the id exactly from the list below, or omit it.
- "intensity": 0 to 1, how strongly an editor would want this sound. Use the whole range honestly; events are ranked against each other.
- "reason": two or three words in lower_snake_case, e.g. "topic_intro", "product_name", "strong_claim".
- "index": for list_item only, its 1-based position in the list.

What each type means:
  topic — the line introducing what the video is about ("These are 4 easy meal prep ideas").
  list_start — ONLY the announcement that a list is coming. There is at most one per list, and it is usually the topic line itself.
  list_item — each item of the list: its marker ("First", "Next", "Fourth", "Last") and/or the item's name. Every item after the first is a list_item, never another list_start.
  entity — a product, company, tool, person or place. Name the THING: in "this cable tray that clips under the shelf" the entity is "cable tray", not "tray that clips".
  number, keyword — a number or a word the sentence turns on.
  hook, reveal, transition, question, answer, important_statement, dramatic, punchline, conclusion, emphasis — what the sentence is doing at that word.

A 30-60 second video normally has several sound events: the topic introduction, the list markers, a name or two, a strong line. Propose the ones an editor would genuinely cut in. The editor thins these down further afterwards, so a video that introduces a topic or walks a list must not come back with an empty list.

SOUND CATEGORIES:
${categories}

SPECIFIC SOUNDS, for literal matches only (id — what it is):
${describeSoundLibraryForPrompt()}

(3) VISUAL SUGGESTIONS — moments where a supporting image/graphic would help.
- One "wordIndex" each. Include an "index" when it corresponds to a numbered list item.
- These are for a human to fill in. Do not describe the image, and never include a sound.

Strict rules:
- NEVER rewrite, summarize, reorder, correct, punctuate, or otherwise modify any word.
- NEVER output a timestamp. You are not given any; the editor already has exact timings for every index.
- Refer to words strictly by index — never by matching text.
- Respond with ONLY a JSON object of the exact shape:
  {"keywords":[{"wordIndex":<int>,"confidence":<0-1 number>}],
   "events":[{"type":"<type>","words":[<int>,...],"soundCategory":"<category>","soundId":"<optional id>","intensity":<0-1 number>,"reason":"<lower_snake_case>","index":<optional int>}],
   "visualSuggestions":[{"type":"<type>","wordIndex":<int>,"index":<optional int>}]}
- No prose, no markdown, no explanation — JSON only.`;
}

/**
 * The transcript as the model sees it: "0:Here 1:are 2:5 3:home ...".
 *
 * Compact on purpose, and it is not cosmetic. The account's model tier allows
 * 8,000 tokens a MINUTE, and the previous JSON form — {"wordIndex":0,"word":
 * "Here"} per word — spent ~9 tokens a word where this spends ~2.4. On the
 * 167-word test video that was ~1,480 tokens of transcript against ~410 now;
 * on a five-minute video it was the difference between a request that fits
 * the limit and one that is rejected on its own before anything else runs.
 *
 * The index is still the only thing the model uses to refer back, so the
 * contract that timings come from the transcript and never from the model is
 * unchanged.
 */
function encodeTranscriptForModel(words) {
  return words.map((w, i) => `${i}:${String(w?.word ?? w?.text ?? '').trim()}`).join(' ');
}

/**
 * The response shape as a STRICT JSON schema, enforced by the provider during
 * generation rather than filtered here afterwards.
 *
 * This is the single biggest reliability fix in the analysis. With plain JSON
 * mode the reasoning model this runs on would, on the same transcript, return
 * eleven events one run, zero the next, and sometimes nothing at all — a 400
 * `json_validate_failed` with an empty generation. Plain JSON mode only asks
 * for *some* JSON; it does not say which, so an answer using a type or a
 * category outside the allowed set was simply discarded by the validator
 * below, and the run looked like a video with no moments in it. The schema
 * makes the enums part of the grammar: the model cannot produce a type,
 * category or sound id that does not exist.
 *
 * Every field is required and nullable-where-optional because strict mode
 * demands it. The validator below still runs on the result — a schema can
 * guarantee a value is an integer, not that it is an index into THIS
 * transcript.
 */
function buildResponseSchema() {
  const obj = (properties) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties
  });
  const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  return obj({
    keywords: { type: 'array', items: obj({ wordIndex: { type: 'integer' }, confidence: { type: 'number' } }) },
    events: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: SEMANTIC_EVENT_TYPES },
        words: { type: 'array', items: { type: 'integer' } },
        soundCategory: { type: 'string', enum: SFX_SOUND_CATEGORIES.map((c) => c.id) },
        // The ids the prompt names (see PROMPT_SOUND_IDS for why that is not every sound).
        soundId: nullable({ type: 'string', enum: PROMPT_SOUND_IDS }),
        intensity: { type: 'number' },
        reason: { type: 'string' },
        index: nullable({ type: 'integer' })
      })
    },
    visualSuggestions: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: SEMANTIC_EVENT_TYPES },
        wordIndex: { type: 'integer' },
        index: nullable({ type: 'integer' })
      })
    }
  });
}

/**
 * Model families that take `reasoning_effort`. Sending it to one that does not
 * is a 400, and CAPTION_ANALYSIS_MODEL is the deployer's choice, not this
 * file's — so it is only sent where it is known to be understood.
 *
 * Low effort, measured on the 40-second test video: ~6s instead of ~20s, far
 * fewer tokens against the per-minute limit, and a BETTER answer (the full
 * topic run and all four list markers, where default effort had returned one
 * word). The task is judgement about a transcript, not multi-step reasoning;
 * longer deliberation mostly bought more chances to talk itself out of it.
 */
function supportsReasoningEffort(modelName) {
  return /gpt-oss|qwen3/i.test(String(modelName));
}

// Remembered per process, so a model that rejects strict schemas pays for the
// discovery once rather than on every upload.
const structuredOutputUnsupported = new Set();

/**
 * Validates and normalizes the raw parsed LLM response into a safe array of
 * { wordIndex, confidence } entries, dropping anything malformed.
 *
 * @param {any} parsed - The parsed JSON response body.
 * @param {number} wordCount - Total number of words, used to bounds-check wordIndex.
 * @returns {Array<{wordIndex:number, confidence:number}>}
 */
function extractValidKeywordTags(parsed, wordCount) {
  if (!parsed || !Array.isArray(parsed.keywords)) return [];

  const validTags = [];
  for (const entry of parsed.keywords) {
    if (!entry || typeof entry !== 'object') continue;

    const wordIndex = Number(entry.wordIndex);
    const confidence = Number(entry.confidence);

    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= wordCount) continue;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;

    validTags.push({ wordIndex, confidence });
  }

  return validTags;
}

/**
 * Validates one of the two semantic lists and resolves each entry's timestamp
 * from the TRANSCRIPT's own word timings.
 *
 * This is the step that keeps a single clock in the system. The model says
 * "the second list item starts at word 27"; this looks up word 27's real
 * `start` and that becomes the event's time. There is no second timing source
 * to reconcile, and an effect placed from an event is therefore sample-exact
 * against the spoken word rather than approximately near it.
 *
 * Anything malformed is dropped rather than repaired: an event with an
 * out-of-range index, an unrecognized type, or a word with no usable timing
 * would otherwise become a sound at an arbitrary moment, which is worse than
 * no sound at all.
 *
 * WORD-LEVEL. A sound event (`allowSoundId`) carries a list of WORDS, and every
 * one of them becomes its own sound at its own timestamp — "five home office
 * hacks" is one idea and four sounds. Each word is validated on its own, so
 * one bad index costs that word and not the run. An older single-`wordIndex`
 * answer is a one-word list, so it still places exactly as it did.
 *
 * A run is also bounded in TIME, not just length: words further than
 * MAX_EVENT_SPAN_SECONDS from the run's first word are dropped. Without that,
 * a model could file two words half a minute apart as one "event" and walk
 * past the per-video budget the director holds.
 */
const MAX_EVENT_SPAN_SECONDS = 4;

/**
 * Grammatical words that never carry a sound accent.
 *
 * This is a GUARD on the model's output, not a rule for deciding what gets a
 * sound — every inclusion decision is still the model's. It exists because
 * the model's index sometimes slips by a word around the one it meant: over
 * repeated runs on the test video it placed sounds on "of" (aiming at
 * "clutter" one word earlier), "the", "your", "this" and "that", in every run.
 * No editor puts a click on "of". A function word is removed from a run; a
 * run left with nothing is dropped, which is the conservative outcome — a
 * missing sound, never a wrong one.
 *
 * Deliberately a short, closed class. Anything that can carry meaning in
 * context — numbers ("just one cable"), "just", "never", "only" — is left out
 * of it, because those are exactly the words an editor DOES accent.
 */
const NEVER_SOUNDED = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'into', 'onto', 'as',
  'and', 'or', 'but', 'so', 'if', 'than', 'then',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'has', 'have', 'had', 'do', 'does', 'did',
  'it', 'its', "it's", 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'their', 'he', 'she', 'his', 'her',
  'here', 'there', 'which', 'who', 'what'
]);

function isFunctionWord(text) {
  return NEVER_SOUNDED.has(String(text).toLowerCase().replace(/[^a-z']/g, ''));
}

function resolveWordRun(entry, words) {
  const raw = Array.isArray(entry.words) ? entry.words
    : Array.isArray(entry.wordIndexes) ? entry.wordIndexes
    : [entry.wordIndex];

  const seen = new Set();
  const run = [];
  for (const value of raw) {
    const i = Number(value);
    if (!Number.isInteger(i) || i < 0 || i >= words.length || seen.has(i)) continue;
    const start = Number(words[i]?.start);
    if (!Number.isFinite(start) || start < 0) continue;
    const text = String(words[i].word ?? words[i].text ?? '').trim();
    if (isFunctionWord(text)) continue;
    seen.add(i);
    run.push({ wordIndex: i, word: text, timestamp: start });
  }
  // Speaking order, then the length cap, then the time window — in that order,
  // so the cap keeps the FIRST words of a run rather than an arbitrary few.
  run.sort((a, b) => a.wordIndex - b.wordIndex);
  const capped = run.slice(0, MAX_WORDS_PER_EVENT);
  if (!capped.length) return [];
  const first = capped[0].timestamp;
  return capped.filter((w) => w.timestamp - first <= MAX_EVENT_SPAN_SECONDS);
}

function resolveEventTimestamps(rawList, words, { allowSoundId = false } = {}) {
  if (!Array.isArray(rawList)) return [];

  const resolved = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isKnownSemanticEventType(entry.type)) continue;

    // Sound events are runs of words; visual suggestions stay single-word.
    const run = allowSoundId ? resolveWordRun(entry, words) : null;
    if (run && !run.length) continue;

    const wordIndex = run ? run[0].wordIndex : Number(entry.wordIndex);
    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= words.length) continue;

    const word = words[wordIndex];
    const start = Number(word?.start);
    if (!Number.isFinite(start) || start < 0) continue;

    // The style of sound the model wants. Validated like everything else: an
    // unknown category costs the event its category — BHYND then falls back
    // to what the event's TYPE maps to — never the event.
    const soundCategory = allowSoundId && isKnownSfxCategory(entry.soundCategory)
      ? entry.soundCategory
      : null;

    const index = Number(entry.index);
    // A named sound is OPTIONAL and independently validated: an ID the
    // registry does not know is dropped while the event itself survives, so a
    // model that misremembers a name costs the moment its sound rather than
    // costing the moment. Visual suggestions never carry one — they are
    // pictures — so they do not even look.
    const soundId = allowSoundId && isKnownSoundId(entry.soundId) ? entry.soundId : null;

    // How strongly the model rates this moment, which is what the director
    // ranks and thresholds on (shared/sfxDirection.js). Out-of-range is
    // clamped rather than dropped — a model answering 1.5 still means "very
    // confident", and discarding that reads as the moment not existing.
    // Absent means absent: the director treats a missing intensity as
    // middling, and writing a default in here would erase the difference
    // between "rated 0.5" and "not rated".
    const rawIntensity = Number(entry.intensity);
    const intensity = Number.isFinite(rawIntensity)
      ? Math.min(1, Math.max(0, rawIntensity))
      : null;

    // Why the model marked it, shown to the creator as provenance. Free text
    // from a model, so it is length-capped and stripped of anything that is
    // not a word — it is a label, never markup and never a sound id.
    const reason = typeof entry.reason === 'string'
      ? entry.reason.trim().toLowerCase().replace(/[^a-z0-9_ -]/g, '').slice(0, 40) || null
      : null;

    // The phrase the moment covers. Only kept when it is a real range inside
    // the transcript; a backwards or out-of-range end is dropped and the
    // moment stays anchored to its single start word.
    const rawEnd = Number(entry.endWordIndex);
    const endWordIndex = Number.isInteger(rawEnd) && rawEnd >= wordIndex && rawEnd < words.length
      ? rawEnd
      : null;
    const endTimestamp = endWordIndex != null
      ? Number(words[endWordIndex]?.end ?? words[endWordIndex]?.start)
      : null;

    resolved.push({
      type: entry.type,
      wordIndex,
      // The word the moment was anchored to, carried through purely so the
      // editor's UI can show WHY an effect is where it is ("list item 2 —
      // \"two\""). Nothing downstream depends on it for timing.
      word: (word.word || word.text || '').trim(),
      timestamp: start,
      // Every word that gets its own sound, each on its own transcript
      // timestamp. The event-level `timestamp` above is just the first of
      // these, kept so ordering and the director's spacing still work on the
      // event as a whole.
      ...(run ? { words: run } : {}),
      ...(run && run.length > 1 ? { endTimestamp: run[run.length - 1].timestamp } : {}),
      ...(Number.isInteger(index) && index > 0 ? { index } : {}),
      ...(intensity != null ? { intensity } : {}),
      ...(reason ? { reason } : {}),
      ...(endWordIndex != null ? { endWordIndex } : {}),
      ...(!run?.length || run.length === 1
        ? (Number.isFinite(endTimestamp) && endTimestamp > start ? { endTimestamp } : {})
        : {}),
      ...(soundCategory ? { soundCategory } : {}),
      ...(soundId ? { soundId } : {})
    });
  }

  // Time-sorted, and de-duplicated on (type, timestamp) so a model that
  // reports the same moment twice can't stack two identical effects on top of
  // each other at the same instant (audibly just a louder one).
  resolved.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set();
  return resolved.filter((e) => {
    const key = `${e.type}@${e.timestamp.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Runs the transcript through Groq's Llama chat model, returning emphasis
 * keywords merged into the words plus the semantic events and visual
 * suggestions resolved onto the transcript's own timeline.
 *
 * On any failure (missing config, network error, timeout, invalid JSON), logs
 * a warning and returns the original words with empty event lists — callers do
 * not need to wrap this in their own try/catch for pipeline safety, and a
 * failed analysis degrades to "no automatic sound effects", never to a failed
 * render.
 *
 * @param {Array<{word:string, start:number, end:number}>} words - Flat Whisper word list.
 * @returns {Promise<{words:Array<object>, contentEvents:Array<object>, visualSuggestions:Array<object>}>}
 */
/**
 * The longest a rate-limited request will wait for its window to reopen. The
 * provider says exactly how long in its 429 ("try again in 18.5s"), and on the
 * current tier a single analysis uses most of a minute's allowance — so the
 * second analysis inside a minute (upload, then pressing Analyze) is rejected
 * as a matter of course. Waiting the stated time recovers it. Past this cap
 * the wait is reported instead, because a minute of silent spinning during an
 * upload is worse than an honest "try again shortly".
 */
const MAX_RATE_LIMIT_WAIT_MS = 30000;

/**
 * One analysis request, retried the way each failure actually needs:
 * a rate limit waits out the window the provider named; anything else gets
 * one quick retry, which is what the previous retryWithBackoff(…, 1, 1000)
 * did for every error — and why a 429 always failed, since one second is not
 * eighteen.
 */
async function requestWithRecovery(apiKey, modelName, transcript) {
  try {
    return await performAnalysisRequest(apiKey, modelName, transcript);
  } catch (err) {
    if (err.code === 'rate_limited' && err.retryAfterMs != null && err.retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS) {
      console.warn(`[ContentAnalysis] Rate limited; waiting ${Math.ceil(err.retryAfterMs / 1000)}s for the window to reopen.`);
      await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs + 500));
      return performAnalysisRequest(apiKey, modelName, transcript);
    }
    if (err.code === 'rate_limited') throw err;
    console.warn(`[ContentAnalysis] Attempt failed (${err.message}); retrying once.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return performAnalysisRequest(apiKey, modelName, transcript);
  }
}

export async function analyzeTranscript(words) {
  // `analysisError` is the difference between "the analysis found nothing"
  // and "the analysis never ran". Both used to come back as the same empty
  // lists, and the upload then reported "Subtitles generated successfully!" —
  // so a rate limit or a timeout looked exactly like a video with no moments
  // in it. The caller now gets told which one happened.
  const empty = (analysisError = null) => ({ words, contentEvents: [], visualSuggestions: [], analysisError });
  if (!Array.isArray(words) || words.length === 0) {
    return empty();
  }

  const apiKey = process.env.WHISPER_API_KEY;
  const modelName = process.env.CAPTION_ANALYSIS_MODEL;

  if (!apiKey || !modelName) {
    console.warn('[ContentAnalysis] Skipping: WHISPER_API_KEY or CAPTION_ANALYSIS_MODEL not configured.');
    return empty({ code: 'not_configured', message: 'Transcript analysis is not configured on the server.' });
  }

  const transcript = encodeTranscriptForModel(words);

  try {
    const parsed = await requestWithRecovery(apiKey, modelName, transcript);

    const validTags = extractValidKeywordTags(parsed, words.length);
    const tagsByIndex = new Map(validTags.map((t) => [t.wordIndex, t]));

    const contentEvents = resolveEventTimestamps(parsed.events, words, { allowSoundId: true });
    const visualSuggestions = resolveEventTimestamps(parsed.visualSuggestions, words);

    const soundCount = contentEvents.reduce((n, e) => n + (e.words?.length || 1), 0);
    console.log(`[ContentAnalysis] Tagged ${validTags.length}/${words.length} words as keywords; ${contentEvents.length} sound event(s) covering ${soundCount} word(s), ${visualSuggestions.length} visual suggestion(s).`);

    return {
      words: words.map((w, i) => {
        const tag = tagsByIndex.get(i);
        return {
          ...w,
          isKeyword: !!tag,
          confidence: tag ? tag.confidence : null,
          source: 'auto'
        };
      }),
      contentEvents,
      visualSuggestions,
      analysisError: null
    };
  } catch (err) {
    console.warn(`[ContentAnalysis] Analysis failed, rendering captions without keyword tags or semantic events: ${err.message}`);
    // Still never fails the pipeline — captions render regardless — but the
    // failure now travels back with its cause instead of being flattened into
    // an empty result the UI would report as success.
    return empty({
      code: err.code || 'failed',
      message: err.code === 'rate_limited'
        ? `The analysis service is rate-limited. Try Analyze again in ${Math.max(1, Math.ceil((err.retryAfterMs || 60000) / 1000))}s.`
        : `Transcript analysis failed: ${err.message}`
    });
  }
}

/**
 * Backwards-compatible wrapper for callers that only want the keyword
 * enrichment (the original signature: words in, words out).
 */
export async function analyzeKeywords(words) {
  const { words: enriched } = await analyzeTranscript(words);
  return enriched;
}

/**
 * Performs a single Groq chat completion request requesting strict JSON output.
 *
 * @param {string} apiKey - Groq bearer token (shared with the Whisper transcription service).
 * @param {string} modelName - Groq model id (e.g. llama-3.3-70b-versatile).
 * @param {Array<{wordIndex:number, word:string}>} indexedTranscript - Indexed word list sent as context.
 * @returns {Promise<object>} The parsed JSON body from the model's response content.
 */
/**
 * How long the provider asked us to wait, from a 429. It says so in two
 * places — the standard `retry-after` header, and the message body ("Please
 * try again in 18.5475s") — and either is enough. Null when neither parses,
 * which the caller treats as "don't wait, report it".
 */
function parseRetryAfterMs(response, bodyText) {
  // A MISSING header comes back as null, and Number(null) is 0 — not NaN — so
  // testing the parsed number alone reads "no header" as "retry immediately",
  // which walks straight back into the rate limit it is meant to wait out.
  const rawHeader = response.headers?.get?.('retry-after');
  const header = rawHeader != null && String(rawHeader).trim() !== '' ? Number(rawHeader) : NaN;
  if (Number.isFinite(header) && header >= 0) return Math.ceil(header * 1000);
  const m = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec(bodyText || '');
  if (!m) return null;
  return Math.ceil(((Number(m[1]) || 0) * 60 + Number(m[2])) * 1000);
}

async function performAnalysisRequest(apiKey, modelName, transcript) {
  // ~6s per call at low reasoning effort on the 40-second test video, ~20s at
  // default. The ceiling is set by the slow path, so a model without
  // reasoning_effort still gets room to finish.
  const timeoutMs = 40000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const structured = !structuredOutputUnsupported.has(modelName);

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        response_format: structured
          ? { type: 'json_schema', json_schema: { name: 'editorial_sfx', strict: true, schema: buildResponseSchema() } }
          : { type: 'json_object' },
        ...(supportsReasoningEffort(modelName) ? { reasoning_effort: 'low' } : {}),
        temperature: 0,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: transcript }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errBodyText = await response.text().catch(() => '');
      // A model that does not do strict schemas says so with a 400 about
      // response_format. Fall back to plain JSON mode for it — once, and then
      // for the rest of the process — instead of failing every analysis on a
      // deployment that set CAPTION_ANALYSIS_MODEL to something else.
      if (structured && response.status === 400 && /response_format|json_schema|structured/i.test(errBodyText)) {
        console.warn(`[ContentAnalysis] ${modelName} rejected a strict schema; falling back to plain JSON mode.`);
        structuredOutputUnsupported.add(modelName);
        clearTimeout(timeoutId);
        return performAnalysisRequest(apiKey, modelName, transcript);
      }
      const err = new Error(`Groq API returned status ${response.status}: ${errBodyText.slice(0, 300)}`);
      if (response.status === 429) {
        err.code = 'rate_limited';
        err.retryAfterMs = parseRetryAfterMs(response, errBodyText);
      }
      throw err;
    }

    const responseData = await response.json();
    const content = responseData?.choices?.[0]?.message?.content;

    if (!content || typeof content !== 'string') {
      throw new Error('Groq API response missing message content.');
    }

    return JSON.parse(content);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Groq keyword analysis request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Exported for tests — the timestamp resolution is the piece with real logic in it, and the prompt is now generated rather than fixed. */
export { resolveEventTimestamps, buildSystemPrompt, buildResponseSchema, encodeTranscriptForModel, parseRetryAfterMs };
