/**
 * Caption events — the transcript's captions as EDITABLE, persisted objects.
 *
 * Until this existed, a caption had no identity and no stored timing of its
 * own. `phrases` were re-derived from `words` by backend/utils/phraseGrouper.js
 * every single time — on regenerate, and again inside the export — by pause
 * gaps, terminal punctuation, a 3-word cap and a ~22-character limit. That
 * makes the grouping a pure function of the transcript, which is exactly what
 * you want for the FIRST pass and exactly what you don't want afterwards:
 *
 *   - Retiming a caption by shifting its words' timings appears to work and
 *     then silently regroups on export. Drag one caption close to its
 *     neighbour and the gap between them drops under the 0.25s pause
 *     threshold, so the two MERGE into one caption.
 *   - Splitting a caption in two is not expressible at all. There is nowhere
 *     to record "break here"; the only lever is faking a pause by moving word
 *     timings, which corrupts the karaoke highlight.
 *
 * So once a transcript has been grouped, the result is captured here as a
 * list the user owns. The grouper still produces the first version of it —
 * nothing about automatic captioning changes — but from then on these events
 * are authoritative, and the exporter renders THESE rather than regrouping
 * from scratch (see backend/utils/graphicsExport.js).
 *
 * An event addresses its words by INDEX into the flat transcript, not by
 * copying them. Word text and per-word styling stay owned by `words`, so
 * editing a word in the Transcript panel still flows through to the caption
 * without anything here needing to know.
 *
 * Pure: no DOM, no canvas, no FFmpeg. Shared by the preview and the export
 * for the same reason shared/textElement.js is — the two must never disagree
 * about which caption is on screen at a given instant.
 */

/** Never let a caption collapse to something unclickable on the timeline. */
export const MIN_CAPTION_EVENT_DURATION = 0.1;

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A stable identity for one caption, independent of where it sits in time.
 *
 * Deliberately NOT derived from its start time the way
 * shared/captionTransform.js's getPhraseTransformKey is. That key exists
 * precisely because a caption had no id to use — and it works only as long as
 * captions never move. The moment one can be dragged, a time-derived key
 * detaches every transform and keyframe attached to it. New captions get an
 * id that survives being retimed; see resolveCaptionPhrases for how the old
 * key is still honoured for projects that predate this.
 */
let idCounter = 0;
export function createCaptionEventId() {
  idCounter += 1;
  return `cap_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function normalizeCaptionEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wordIndices = Array.isArray(raw.wordIndices)
    ? raw.wordIndices.map((i) => Number(i)).filter((i) => Number.isInteger(i) && i >= 0)
    : [];
  if (!wordIndices.length) return null;

  const start = Math.max(0, finiteOr(raw.start, 0));
  const end = Math.max(start + MIN_CAPTION_EVENT_DURATION, finiteOr(raw.end, start + MIN_CAPTION_EVENT_DURATION));

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createCaptionEventId(),
    start,
    end,
    wordIndices,
    // Line breaks WITHIN the caption, as positions into wordIndices — the
    // same meaning phrases have always given breakAfterIndices.
    breakAfterIndices: Array.isArray(raw.breakAfterIndices)
      ? raw.breakAfterIndices.map((i) => Number(i)).filter((i) => Number.isInteger(i) && i >= 0)
      : [],
    enabled: raw.enabled !== false
  };
}

/**
 * Normalizes a whole list, tolerating a JSON STRING as well as an array.
 *
 * The string case is not defensive padding: the initial-upload path posts
 * state as FormData, where every value is stringified, while the regenerate
 * path posts real JSON — so the backend receives one or the other depending
 * on which path ran. Same reason normalizeTextElementList and
 * normalizeAudioTimeline both accept both.
 */
export function normalizeCaptionEventList(raw) {
  let source = raw;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return []; }
  }
  if (!Array.isArray(source)) return [];
  return source
    .map(normalizeCaptionEvent)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

/**
 * Captures the grouper's output as editable events — the one-time handoff
 * from "derived automatically" to "owned by the user".
 *
 * Called when a transcript first lands, NOT on every render: re-running it
 * would throw away exactly the edits this whole model exists to preserve.
 */
export function captionEventsFromPhrases(phrases) {
  if (!Array.isArray(phrases)) return [];
  return phrases.map((phrase) => normalizeCaptionEvent({
    start: phrase.start,
    end: phrase.end,
    wordIndices: (phrase.words || []).map((w) => w.wordIndex).filter((i) => Number.isInteger(i)),
    breakAfterIndices: phrase.breakAfterIndices || []
  })).filter(Boolean);
}

/**
 * Turns caption events back into the phrase shape every renderer already
 * consumes — `{ start, end, words:[{word, start, end, wordIndex, isKeyword}], breakAfterIndices }`.
 *
 * This is the single place the two representations meet. Everything
 * downstream (preview, canvas transforms, the export frame generator) keeps
 * working on phrases exactly as before, so making captions editable needed no
 * renderer changes at all.
 *
 * Words are read live out of `words` rather than copied at capture time, so a
 * transcript edit (text, keyword flag) reaches the caption with nothing here
 * needing to know about it.
 */
export function resolveCaptionPhrases(words, captionEvents) {
  if (!Array.isArray(words) || !words.length) return [];
  const events = Array.isArray(captionEvents) ? captionEvents : [];
  if (!events.length) return [];

  return events
    .filter((event) => event.enabled !== false)
    .map((event) => {
      const phraseWords = event.wordIndices
        .map((idx) => {
          const w = words[idx];
          if (!w) return null;
          return {
            word: w.word ?? w.text ?? '',
            text: w.word ?? w.text ?? '',
            start: finiteOr(w.start, event.start),
            end: finiteOr(w.end, event.end),
            wordIndex: idx,
            isKeyword: !!w.isKeyword
          };
        })
        .filter(Boolean);
      if (!phraseWords.length) return null;
      return {
        // Carried through so a caption keeps its transforms and keyframes
        // when it is retimed — see createCaptionEventId.
        captionEventId: event.id,
        start: event.start,
        end: event.end,
        words: phraseWords,
        breakAfterIndices: event.breakAfterIndices || []
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

/**
 * Moves a caption to `nextStart`, carrying its words with it.
 *
 * The words move too, by the same delta: their own timings drive the karaoke
 * highlight and the per-word reveal, so leaving them behind would light up
 * the wrong words (or none) while the caption sat somewhere else entirely.
 * Returns both halves for the caller to write in one go.
 */
export function moveCaptionEvent(event, nextStart, words) {
  const delta = nextStart - event.start;
  if (!delta) return { event, wordPatches: [] };
  const moved = { ...event, start: Math.max(0, event.start + delta), end: Math.max(MIN_CAPTION_EVENT_DURATION, event.end + delta) };
  const wordPatches = event.wordIndices
    .filter((idx) => words[idx])
    .map((idx) => ({
      index: idx,
      start: Math.max(0, finiteOr(words[idx].start, 0) + delta),
      end: Math.max(0, finiteOr(words[idx].end, 0) + delta)
    }));
  return { event: moved, wordPatches };
}

/**
 * Retimes ONE edge. Unlike a move, the words stay where they are — trimming a
 * caption changes how long it is on screen, not when its words are spoken.
 */
export function trimCaptionEvent(event, edge, time) {
  if (edge === 'start') {
    return { ...event, start: Math.max(0, Math.min(time, event.end - MIN_CAPTION_EVENT_DURATION)) };
  }
  return { ...event, end: Math.max(time, event.start + MIN_CAPTION_EVENT_DURATION) };
}

/**
 * Splits a caption in two after the `afterPosition`-th of its words.
 *
 * This is the operation that could not be expressed at all while phrases were
 * derived — there was nowhere to record the break. Each half keeps the words
 * it owns and takes its time span from them, so the result is exactly what
 * the two captions would have been had the grouper produced them.
 *
 * @returns {object[]|null} The two events, or null when the split point would leave a half empty.
 */
export function splitCaptionEvent(event, afterPosition, words) {
  const left = event.wordIndices.slice(0, afterPosition + 1);
  const right = event.wordIndices.slice(afterPosition + 1);
  if (!left.length || !right.length) return null;

  const spanOf = (indices, fallbackStart, fallbackEnd) => {
    const times = indices.map((i) => words[i]).filter(Boolean);
    if (!times.length) return [fallbackStart, fallbackEnd];
    return [
      Math.min(...times.map((w) => finiteOr(w.start, fallbackStart))),
      Math.max(...times.map((w) => finiteOr(w.end, fallbackEnd)))
    ];
  };

  const [leftStart, leftEnd] = spanOf(left, event.start, event.end);
  const [rightStart, rightEnd] = spanOf(right, event.start, event.end);

  return [
    normalizeCaptionEvent({ start: event.start, end: Math.max(leftEnd, event.start + MIN_CAPTION_EVENT_DURATION), wordIndices: left }),
    normalizeCaptionEvent({ start: rightStart, end: Math.max(event.end, rightStart + MIN_CAPTION_EVENT_DURATION), wordIndices: right })
  ].filter(Boolean);
}

/** Joins a caption with the one after it — the inverse of a split. */
export function mergeCaptionEvents(a, b) {
  return normalizeCaptionEvent({
    id: a.id,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    wordIndices: [...a.wordIndices, ...b.wordIndices],
    // The join itself becomes a line break, which is what the two captions
    // already looked like stacked on screen.
    breakAfterIndices: [...(a.breakAfterIndices || []), a.wordIndices.length - 1]
  });
}
