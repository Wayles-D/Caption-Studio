/**
 * SYLLABLES — how many beats a spoken word has, and where they fall inside
 * the time the transcript says that word occupies.
 *
 * This exists for ONE job: a short, dry sound placed once per syllable of a
 * chosen word ("sy-lla-bic" → three ticks across the word). It is not a
 * pronunciation dictionary and does not try to be — English spelling is a
 * poor guide to speech, and a dictionary big enough to be right would be
 * larger than everything else in the app.
 *
 * So: a vowel-group count with the handful of corrections that matter most
 * in practice, and — crucially — the result is a STARTING POINT the user can
 * change. The count is shown before anything is placed, and the clips that
 * land are ordinary sound effects that can be moved, trimmed or deleted one
 * by one.
 */

const VOWELS = 'aeiouy';

/**
 * How many syllables a word has, by its spelling.
 *
 * The rules, in the order they matter:
 *   - count groups of vowels (one group = one nucleus = one syllable);
 *   - drop a silent final "e" ("time" is one, not two) — but not when the
 *     word would be left with no vowel at all ("the"), and not after a
 *     consonant+"le" ("table" really is two);
 *   - "-es"/"-ed" after a sibilant or a d/t still sounds ("wishes",
 *     "wanted"), otherwise it does not ("walked" is one);
 *   - never return less than one for a word with any letter in it.
 */
export function countSyllables(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return 0;
  // A word of digits or symbols has already been stripped; a bare "'" too.
  if (w.length <= 2 && !/[aeiouy]/.test(w)) return 1;

  let groups = (w.match(/[aeiouy]+/g) || []).length;

  // Silent final e: "time", "made", "stone".
  if (/e$/.test(w) && groups > 1) {
    const before = w[w.length - 2];
    const isConsonantLe = /[^aeiouy]l$/.test(w.slice(0, -1) + 'l') && /le$/.test(w) && !VOWELS.includes(w[w.length - 3] || '');
    if (!isConsonantLe && !VOWELS.includes(before)) groups -= 1;
  }

  // "-ed" that is not spoken as its own beat: "walked" (1), but "wanted" (2).
  if (/[^aeiouy]ed$/.test(w) && groups > 1 && !/[dt]ed$/.test(w)) groups -= 1;

  // "-es" likewise: "wishes" keeps it, "makes" does not.
  if (/[^aeiouy]es$/.test(w) && groups > 1 && !/(s|x|z|ch|sh|ge|ce)es$/.test(w)) groups -= 1;

  return Math.max(1, groups);
}

/**
 * WHEN each syllable lands inside a word's own stretch of time.
 *
 * The transcript gives a word one start and one end; it does not say where
 * the syllables are inside that. They are spread evenly, which is honest
 * (nothing here knows better) and sounds right for the short dry sounds this
 * is for.
 *
 * The LAST syllable is pulled slightly in from the word's end so a sound
 * never lands on the following word, and a one-syllable word simply gets its
 * start.
 *
 * @param {{start:number, end:number}} word
 * @param {number} count  how many syllables (countSyllables, or the user's)
 * @returns {number[]} one time per syllable
 */
export function syllableTimes(word, count) {
  const start = Number(word?.start);
  const n = Math.max(1, Math.round(count || 1));
  if (!Number.isFinite(start)) return [];
  const end = Number.isFinite(word?.end) && word.end > start ? word.end : start;
  const span = end - start;
  if (n === 1 || span <= 0) return [start];
  // Spread across the word, keeping the last one inside it.
  const usable = span * 0.88;
  return Array.from({ length: n }, (_, i) => start + (usable * i) / (n - 1));
}

/**
 * Whether a sound is suitable for this: short, dry and tail-free, so it can
 * land several times in a word without the previous one still ringing.
 *
 * The sound pack already marks exactly these (`usage: 'word'` — "safe on
 * consecutive words"), so this is that same judgement rather than a second
 * opinion about the same thing.
 */
export function isSyllableSound(definition) {
  return !!definition && (definition.usage === 'word' || (definition.duration != null && definition.duration <= 0.25));
}
