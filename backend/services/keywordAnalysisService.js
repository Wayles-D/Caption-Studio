import { retryWithBackoff } from '../utils/retry.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a caption emphasis tagger for short-form video subtitles.
You will receive a JSON transcript as a list of {"wordIndex": number, "word": string} entries, in speaking order.
Your ONLY job is to identify which words deserve visual emphasis (keywords) when displayed as captions, and how important each one is.

Strict rules:
- NEVER rewrite, summarize, reorder, correct, punctuate, or otherwise modify any word.
- NEVER invent words or change timestamps (you are not given timestamps and must not need them).
- Match every tag strictly by "wordIndex" from the input — never by matching text.
- Only include words that ARE keywords in your output; omit everything else.
- Favor concrete nouns, numbers, strong verbs, and emotionally/thematically significant words. Avoid tagging common filler words (the, a, is, and, etc.).
- Respond with ONLY a JSON object of the exact shape: {"keywords":[{"wordIndex":<int>,"importance":"high"|"medium","confidence":<0-1 number>}]}
- No prose, no markdown, no explanation — JSON only.`;

/**
 * Validates and normalizes the raw parsed LLM response into a safe array of
 * { wordIndex, importance, confidence } entries, dropping anything malformed.
 *
 * @param {any} parsed - The parsed JSON response body.
 * @param {number} wordCount - Total number of words, used to bounds-check wordIndex.
 * @returns {Array<{wordIndex:number, importance:string, confidence:number}>}
 */
function extractValidKeywordTags(parsed, wordCount) {
  if (!parsed || !Array.isArray(parsed.keywords)) return [];

  const validTags = [];
  for (const entry of parsed.keywords) {
    if (!entry || typeof entry !== 'object') continue;

    const wordIndex = Number(entry.wordIndex);
    const importance = entry.importance;
    const confidence = Number(entry.confidence);

    if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= wordCount) continue;
    if (importance !== 'high' && importance !== 'medium') continue;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;

    validTags.push({ wordIndex, importance, confidence });
  }

  return validTags;
}

/**
 * Sends the transcript's words to Groq's Llama chat model to tag emphasis-worthy
 * keywords, matched strictly by wordIndex. Never rewrites or reorders any word.
 *
 * On any failure (missing config, network error, timeout, invalid JSON), logs a
 * warning and returns the original words unmodified — callers do not need to
 * wrap this in their own try/catch for pipeline safety.
 *
 * @param {Array<{word:string, start:number, end:number}>} words - Flat Whisper word list.
 * @returns {Promise<Array<object>>} Words enriched with isKeyword/importance/confidence/source,
 *   or the original words array if analysis could not be completed.
 */
export async function analyzeKeywords(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return words;
  }

  const apiKey = process.env.WHISPER_API_KEY;
  const modelName = process.env.CAPTION_ANALYSIS_MODEL;

  if (!apiKey || !modelName) {
    console.warn('[KeywordAnalysis] Skipping: WHISPER_API_KEY or CAPTION_ANALYSIS_MODEL not configured.');
    return words;
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

    console.log(`[KeywordAnalysis] Tagged ${validTags.length}/${words.length} words as keywords.`);

    return words.map((w, i) => {
      const tag = tagsByIndex.get(i);
      return {
        ...w,
        isKeyword: !!tag,
        importance: tag ? tag.importance : null,
        confidence: tag ? tag.confidence : null,
        source: 'auto'
      };
    });
  } catch (err) {
    console.warn(`[KeywordAnalysis] Analysis failed, rendering captions without keyword tags: ${err.message}`);
    return words;
  }
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
          { role: 'system', content: SYSTEM_PROMPT },
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
