/**
 * "Rolling Stack" caption display behavior — a reusable layout engine, not a
 * font preset. It groups a phrase's already-analyzed words (word.isKeyword,
 * already produced by keywordAnalysisService/phraseGrouper) into alternating
 * normal/keyword "chunks", then derives a two-layer (previous/active) rolling
 * frame from those chunks and the current playback position.
 *
 * Both the CSS preview (preview.js) and the ASS exporter (assWriter.js) call
 * these same pure functions so the two renderers can never disagree about
 * which words are grouped together or which frame is active at a given time
 * — the single shared source of truth this display mode is built on, exactly
 * like resolveWordStyleMetadata already is for keyword-driven presets.
 *
 * Typography for each chunk is intentionally NOT decided here — callers pass
 * the chunk's `isKeyword` flag into the existing resolveWordStyleMetadata /
 * resolveWordTextCase resolvers, so Rolling Stack automatically inherits
 * whatever normal/keyword font, size, color, and casing the active preset
 * (and the user's own Keyword Style overrides) already resolve to.
 */

/**
 * Groups a phrase's words into maximal consecutive runs that share the same
 * isKeyword value. A run of N consecutive normal words becomes one 'normal'
 * chunk; a run of N consecutive keyword words becomes one 'keyword' chunk.
 * This is deliberately word-count-agnostic: chunk boundaries are wherever
 * isKeyword actually changes, never a fixed word count.
 *
 * @param {Array<{word?:string, text?:string, start:number, end:number, isKeyword?:boolean}>} words
 * @returns {Array<{type:'normal'|'keyword', start:number, end:number, words:Array}>}
 */
export function buildRollingStackChunks(words) {
  const chunks = [];
  for (const w of words || []) {
    const type = w && w.isKeyword ? 'keyword' : 'normal';
    const last = chunks[chunks.length - 1];
    if (last && last.type === type) {
      last.words.push(w);
      last.end = w.end;
    } else {
      chunks.push({ type, start: w.start, end: w.end, words: [w] });
    }
  }
  return chunks;
}

/**
 * Resolves which chunk index is "active" at a given time: the chunk whose
 * own [start, end] contains time, or — during a natural pause between two
 * chunks — the most recently completed chunk (hold-last-state), so the
 * display never blanks out during ordinary speech gaps. Falls back to the
 * first chunk before the phrase has started.
 *
 * @param {Array} chunks - Output of buildRollingStackChunks.
 * @param {number} time - Playback time (or, for export, a slice's start time).
 * @returns {number} Index into chunks.
 */
export function resolveRollingStackActiveChunkIndex(chunks, time) {
  for (let i = 0; i < chunks.length; i++) {
    if (time >= chunks[i].start && time <= chunks[i].end) return i;
  }
  let lastIdx = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].end <= time) lastIdx = i;
  }
  return lastIdx;
}

/**
 * Resolves the two-layer frame for a single moment in time — used by the
 * live CSS preview, which re-evaluates this every timeupdate tick.
 *
 * `top` is the chunk that has rolled up into the previous/context position
 * (null when the active chunk is the very first chunk in the phrase — this
 * is what naturally collapses a keyword-free phrase, or the phrase's opening
 * run before its first keyword, down to a single line with no forced empty
 * second line).
 *
 * @param {Array<object>} words - phrase.words (word-level timing + isKeyword).
 * @param {number} currentTime - Current video playback time.
 * @returns {{top: object|null, bottom: object, chunks: Array, activeIndex: number}}
 */
export function resolveRollingStackFrame(words, currentTime) {
  const chunks = buildRollingStackChunks(words);
  const activeIndex = resolveRollingStackActiveChunkIndex(chunks, currentTime);
  return {
    top: activeIndex > 0 ? chunks[activeIndex - 1] : null,
    bottom: chunks[activeIndex],
    chunks,
    activeIndex
  };
}

/**
 * Resolves the full sequence of rolling-stack frames covering a phrase's
 * entire on-screen duration, each with its own [start, end) time slice — the
 * ASS exporter's equivalent of resolveRollingStackFrame's per-tick lookup,
 * since a Dialogue event needs an explicit time range rather than a single
 * instant. Slice boundaries land exactly on chunk start times, so within any
 * one slice resolveRollingStackActiveChunkIndex(chunks, t) is constant and
 * equal to that slice's chunk index — the two are proven equivalent by
 * construction, which is what keeps preview and export frame-for-frame
 * identical without duplicating the timing logic.
 *
 * @param {object} phrase - Unified phrase (start, end, words[]).
 * @returns {Array<{start:number, end:number, top:object|null, bottom:object}>}
 */
export function buildRollingStackSlices(phrase) {
  const chunks = buildRollingStackChunks(phrase.words);
  if (chunks.length === 0) return [];

  return chunks.map((chunk, i) => ({
    start: i === 0 ? phrase.start : chunk.start,
    end: i + 1 < chunks.length ? chunks[i + 1].start : phrase.end,
    top: i > 0 ? chunks[i - 1] : null,
    bottom: chunk
  })).filter((slice) => slice.end - slice.start >= 0.001);
}

/**
 * Joins a chunk's word texts into a single display string — chunk-level
 * equivalent of a single word's raw text, ready for applyCaseTransform.
 *
 * @param {object} chunk - A chunk from buildRollingStackChunks.
 * @returns {string}
 */
export function chunkRawText(chunk) {
  return (chunk?.words || []).map((w) => (w.word || w.text || '').trim()).join(' ');
}
