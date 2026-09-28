import { retryWithBackoff } from '../utils/retry.js';
import { SEMANTIC_EVENT_TYPES, isKnownSemanticEventType } from '../../shared/soundProfiles.js';
import { describeSoundLibraryForPrompt, isKnownSoundId } from '../../shared/soundRegistry.js';

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
 *   - It never sees the video. Everything here is derived from the spoken
 *     content, deliberately.
 */
/**
 * Built per call rather than once at module load, so the sound enumeration
 * reflects the registry as it is NOW. A module-level constant would freeze
 * the list at import time and quietly stop offering anything added later —
 * the exact drift this generation exists to prevent.
 */
function buildSystemPrompt() {
  return `You are a content analyst for short-form video subtitles.
You will receive a JSON transcript as a list of {"wordIndex": number, "word": string} entries, in speaking order.

You have three jobs:

(1) KEYWORDS — identify which words deserve visual emphasis when displayed as captions.
- Favor concrete nouns, numbers, strong verbs, and emotionally/thematically significant words. Avoid common filler words (the, a, is, and, etc.).

(2) EVENTS — identify structural/semantic moments in what is being SAID.
- Allowed "type" values, and nothing else: ${SEMANTIC_EVENT_TYPES.join(', ')}.
- "list_start": the moment the speaker announces a list ("here are five things you need to know").
- "list_item": the beginning of each individual item ("number one", "number two", "first", "second"). Give each one a 1-based "index".
- "emphasis": a word the speaker is clearly stressing.
- "reveal": the moment something new is presented or shown.
- "transition": a shift between topics or sections.
- "question" / "answer": a question being posed, and where it gets answered.
- "important_statement": a standout claim or takeaway.
- Point at the FIRST word of the moment using "wordIndex". Never output a timestamp — you are not given any and must not infer one.
- Be conservative. Only report a moment you would actually mark up. An empty list is a valid, good answer.
- You MAY also suggest a sound effect for a moment, as "soundId". It must be copied EXACTLY from the library below — never invent one, never translate it, never use the display name in brackets. Omit "soundId" entirely when no sound in the library genuinely fits; a moment with no sound is better than a wrong one.
- Pick for MEANING, not novelty. A meme or music sting is right only when the speech is actually doing that thing; most moments want something small or nothing at all.
- Never put the same loud sting on more than a couple of moments in one video.

AVAILABLE SOUNDS (id, then its display name in brackets — return the id):
${describeSoundLibraryForPrompt()}

(3) VISUAL SUGGESTIONS — moments where a supporting image/graphic would help.
- Same "wordIndex" rule. Include an "index" when it corresponds to a numbered list item.
- These are suggestions for a human to fill in. Do not describe what the image should be.
- Never include "soundId" here — these are pictures, not sounds.

Strict rules:
- NEVER rewrite, summarize, reorder, correct, punctuate, or otherwise modify any word.
- NEVER invent words or timestamps.
- Match every reference strictly by "wordIndex" from the input — never by matching text.
- Respond with ONLY a JSON object of the exact shape:
  {"keywords":[{"wordIndex":<int>,"confidence":<0-1 number>}],
   "events":[{"type":"<allowed type>","wordIndex":<int>,"index":<optional 1-based int>,"soundId":"<optional id from the library>"}],
   "visualSuggestions":[{"type":"<allowed type>","wordIndex":<int>,"index":<optional 1-based int>}]}
- No prose, no markdown, no explanation — JSON only.`;
}

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
 */
function resolveEventTimestamps(rawList, words, { allowSoundId = false } = {}) {
  if (!Array.isArray(rawList)) return [];

  const resolved = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isKnownSemanticEventType(entry.type)) continue;

    const wordIndex = Number(entry.wordIndex);
    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= words.length) continue;

    const word = words[wordIndex];
    const start = Number(word?.start);
    if (!Number.isFinite(start) || start < 0) continue;

    const index = Number(entry.index);
    // A named sound is OPTIONAL and independently validated: an ID the
    // registry does not know is dropped while the event itself survives, so a
    // model that misremembers a name costs the moment its sound rather than
    // costing the moment. Visual suggestions never carry one — they are
    // pictures — so they do not even look.
    const soundId = allowSoundId && isKnownSoundId(entry.soundId) ? entry.soundId : null;

    resolved.push({
      type: entry.type,
      wordIndex,
      // The word the moment was anchored to, carried through purely so the
      // editor's UI can show WHY an effect is where it is ("list item 2 —
      // \"two\""). Nothing downstream depends on it for timing.
      word: (word.word || word.text || '').trim(),
      timestamp: start,
      ...(Number.isInteger(index) && index > 0 ? { index } : {}),
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
export async function analyzeTranscript(words) {
  const empty = { words, contentEvents: [], visualSuggestions: [] };
  if (!Array.isArray(words) || words.length === 0) {
    return empty;
  }

  const apiKey = process.env.WHISPER_API_KEY;
  const modelName = process.env.CAPTION_ANALYSIS_MODEL;

  if (!apiKey || !modelName) {
    console.warn('[ContentAnalysis] Skipping: WHISPER_API_KEY or CAPTION_ANALYSIS_MODEL not configured.');
    return empty;
  }

  const indexedTranscript = words.map((w, i) => ({ wordIndex: i, word: (w.word || w.text || '').trim() }));

  try {
    const parsed = await retryWithBackoff(
      () => performAnalysisRequest(apiKey, modelName, indexedTranscript),
      1,
      1000,
      2
    );

    const validTags = extractValidKeywordTags(parsed, words.length);
    const tagsByIndex = new Map(validTags.map((t) => [t.wordIndex, t]));

    const contentEvents = resolveEventTimestamps(parsed.events, words, { allowSoundId: true });
    const visualSuggestions = resolveEventTimestamps(parsed.visualSuggestions, words);

    const named = contentEvents.filter((e) => e.soundId).length;
    console.log(`[ContentAnalysis] Tagged ${validTags.length}/${words.length} words as keywords; ${contentEvents.length} semantic event(s) (${named} with a suggested sound), ${visualSuggestions.length} visual suggestion(s).`);

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
      visualSuggestions
    };
  } catch (err) {
    console.warn(`[ContentAnalysis] Analysis failed, rendering captions without keyword tags or semantic events: ${err.message}`);
    return empty;
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
async function performAnalysisRequest(apiKey, modelName, indexedTranscript) {
  const timeoutMs = 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: JSON.stringify({ transcript: indexedTranscript }) }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errBodyText = await response.text().catch(() => '');
      throw new Error(`Groq API returned status ${response.status}: ${errBodyText.slice(0, 300)}`);
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
export { resolveEventTimestamps, buildSystemPrompt };
