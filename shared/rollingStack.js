/**
 * "Rolling Stack" caption display behavior — a reusable layout engine, not a
 * font preset. It groups a phrase's already-analyzed words (word.isKeyword,
 * already produced by keywordAnalysisService/phraseGrouper) into alternating
 * normal/keyword "chunks", then derives a two-layer frame strictly from which
 * chunk(s) are genuinely active at the current playback position — a chunk is
 * only ever shown while `chunk.start <= time < chunk.end`, exactly mirroring
 * each word's own Whisper timestamps. Nothing is carried forward once its own
 * window ends; two chunks share the frame only when their timestamps
 * genuinely overlap.
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

// Matches the small float-safety epsilon generateStaticHighlightDialogueEvents
// already uses elsewhere in this codebase for the same kind of boundary check.
const TIMING_EPSILON = 0.001;

/**
 * Resolves EVERY chunk that is genuinely active at a given time — strictly
 * `chunk.start <= time < chunk.end`, mirroring each word's own Whisper
 * timestamps exactly. No hold-last-state fallback: a chunk that has finished
 * is never reported as active just because nothing new has started yet, and
 * a chunk that hasn't started yet is never reported as active early. This is
 * what a caller derives the current on-screen composition from — never a
 * cache of "whatever was shown last".
 *
 * Ordinarily returns exactly one index (sequential, non-overlapping speech).
 * Returns two only when two chunks' real timestamps genuinely overlap — the
 * one deliberate exception where two blocks may share the screen. Returns
 * an empty array during a genuine gap where nothing is currently being said.
 *
 * @param {Array} chunks - Output of buildRollingStackChunks.
 * @param {number} time - Playback time (or, for export, a slice's start time).
 * @returns {number[]} Indices into chunks, in chunk order.
 */
export function resolveRollingStackActiveChunkIndices(chunks, time) {
  const active = [];
  for (let i = 0; i < chunks.length; i++) {
    if (time >= chunks[i].start - TIMING_EPSILON && time < chunks[i].end - TIMING_EPSILON) {
      active.push(i);
    }
  }
  return active;
}

/**
 * Resolves the two-layer frame for a single moment in time — used by the
 * live CSS preview, which re-evaluates this every timeupdate tick.
 *
 * Both `top` and `bottom` are null/absent unless a chunk is genuinely active
 * right now — nothing is ever carried forward from a previous instant. With
 * exactly one active chunk it renders alone as `bottom` (matching the
 * existing single-line layout). With two genuinely overlapping active chunks,
 * the earlier one renders as `top` and the later as `bottom`, preserving the
 * existing stacked two-line layout/positioning for that case. With zero
 * active chunks (a genuine pause) both are null and nothing is shown.
 *
 * @param {Array<object>} words - phrase.words (word-level timing + isKeyword).
 * @param {number} currentTime - Current video playback time.
 * @returns {{top: object|null, bottom: object|null, chunks: Array, activeIndices: number[]}}
 */
export function resolveRollingStackFrame(words, currentTime) {
  const chunks = buildRollingStackChunks(words);
  const activeIndices = resolveRollingStackActiveChunkIndices(chunks, currentTime);

  if (activeIndices.length === 0) {
    return { top: null, bottom: null, chunks, activeIndices };
  }
  if (activeIndices.length === 1) {
    return { top: null, bottom: chunks[activeIndices[0]], chunks, activeIndices };
  }
  return {
    top: chunks[activeIndices[0]],
    bottom: chunks[activeIndices[activeIndices.length - 1]],
    chunks,
    activeIndices
  };
}

/**
 * Resolves the full sequence of rolling-stack frames covering a phrase's
 * entire on-screen duration, each with its own [start, end) time slice — the
 * ASS exporter's equivalent of resolveRollingStackFrame's per-tick lookup,
 * since a Dialogue event needs an explicit time range rather than a single
 * instant. Slice boundaries are every chunk's own start/end timestamp, so
 * within any one slice the active chunk set is constant — proven equivalent
 * to resolveRollingStackFrame by construction, which is what keeps preview
 * and export frame-for-frame identical without duplicating the timing logic.
 *
 * A gap where nothing is active produces no slice at all (no Dialogue event
 * covers it), rather than stretching the previous slice forward — this is
 * the export-side half of the same fix: a word/chunk must never render past
 * its own end timestamp just because the next one hasn't started yet.
 *
 * @param {object} phrase - Unified phrase (start, end, words[]).
 * @returns {Array<{start:number, end:number, top:object|null, bottom:object}>}
 */
export function buildRollingStackSlices(phrase) {
  const chunks = buildRollingStackChunks(phrase.words);
  if (chunks.length === 0) return [];

  const boundarySet = new Set([phrase.start, phrase.end]);
  chunks.forEach((c) => {
    boundarySet.add(c.start);
    boundarySet.add(c.end);
  });
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

  const slices = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const sliceStart = boundaries[i];
    const sliceEnd = boundaries[i + 1];
    if (sliceEnd - sliceStart < TIMING_EPSILON) continue;

    const activeIndices = resolveRollingStackActiveChunkIndices(chunks, sliceStart);
    if (activeIndices.length === 0) continue; // genuine gap — no event, nothing shown

    const top = activeIndices.length > 1 ? chunks[activeIndices[0]] : null;
    const bottom = chunks[activeIndices[activeIndices.length - 1]];

    slices.push({ start: sliceStart, end: sliceEnd, top, bottom });
  }
  return slices;
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
