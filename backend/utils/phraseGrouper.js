/**
 * Groups raw Word-level Whisper timestamps into coherent phrases (2-5 words).
 * Implements splits based on sentence punctuation, audio pauses, word targets, and character lengths.
 * Includes a robust fallback that synthesizes word-level timings from Segment-only payloads.
 * 
 * @param {object} whisperData - The JSON response parsed from the Whisper transcription.
 * @returns {Array<object>} Returns an array of phrase objects with text, start, end, and word items.
 */
export function groupWordsToPhrases(whisperData) {
  if (!whisperData || (!whisperData.text && !whisperData.segments && !Array.isArray(whisperData.words))) {
    throw new Error('Invalid Whisper response format: missing transcript, segments, or words.');
  }

  let words = [];

  // 1. Gather all words with timestamps
  if (Array.isArray(whisperData.words) && whisperData.words.length > 0) {
    words = whisperData.words;
  } else if (Array.isArray(whisperData.segments)) {
    const hasWordTimestamps = whisperData.segments.some(s => Array.isArray(s.words) && s.words.length > 0);
    
    if (hasWordTimestamps) {
      // Flatten words inside segments
      words = whisperData.segments.flatMap(s => s.words || []);
    } else {
      // FALLBACK: Segment-level timestamps only
      console.warn('[PhraseGrouper] Word-level timestamps missing. Synthesizing timings from segment intervals.');
      words = whisperData.segments.flatMap((segment) => {
        const segText = segment.text ? segment.text.trim() : '';
        if (!segText) return [];

        // Split on whitespace to get individual words
        const segmentWords = segText.split(/\s+/);
        const segmentStart = typeof segment.start === 'number' ? segment.start : 0;
        const segmentEnd = typeof segment.end === 'number' ? segment.end : segmentStart;
        const segmentDuration = Math.max(0, segmentEnd - segmentStart);
        
        const count = segmentWords.length;
        const wordDuration = count > 0 ? segmentDuration / count : 0;

        return segmentWords.map((wordStr, index) => ({
          word: wordStr,
          start: segmentStart + index * wordDuration,
          end: segmentStart + (index + 1) * wordDuration
        }));
      });
    }
  }

  if (words.length === 0) {
    console.warn('[PhraseGrouper] No word entries could be parsed from transcription.');
    return [];
  }

  const phrases = [];
  let currentPhraseWords = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    
    const text = w.word || '';
    const start = typeof w.start === 'number' ? w.start : 0;
    // Ensure word duration sits above 0
    const end = typeof w.end === 'number' ? Math.max(w.end, start + 0.05) : start + 0.05;

    // Carry through AI keyword emphasis metadata (if present) so both the
    // frontend preview and the ASS writer can render it identically.
    currentPhraseWords.push({
      text,
      start,
      end,
      wordIndex: i,
      isKeyword: !!w.isKeyword,
      importance: w.importance || null,
      confidence: w.confidence ?? null,
      source: w.source || null
    });

    const trimmedText = text.trim();
    // Check for terminal punctuation at the end of the word: . , ! ? ; : -
    const hasTerminalPunctuation = /[.,!?;:\-–—]$/.test(trimmedText);

    // Check for silent pauses between words (typically >0.25 seconds for creator rhythm)
    let hasSignificantPause = false;
    if (i < words.length - 1) {
      const nextWord = words[i + 1];
      const nextStart = typeof nextWord.start === 'number' ? nextWord.start : 0;
      if (nextStart - end > 0.25) {
        hasSignificantPause = true;
      }
    }

    // Smart line balancing: Max 3 words per phrase, but avoid 1-word orphan phrases if possible
    const limitReached = currentPhraseWords.length >= 3;

    // Character length rule: Target ~22 characters limit per phrase for mobile screen width
    const currentTextLength = currentPhraseWords.map(item => item.text.trim()).join(' ').length;
    const charLimitExceeded = currentTextLength >= 22;

    // Look-ahead check: If adding 1 more word creates an awkward 1-word orphan before a major break, adjust break
    const remainingWords = words.length - (i + 1);
    const isOrphanImpending = remainingWords === 1;

    let shouldSplit = (
      hasTerminalPunctuation ||
      hasSignificantPause ||
      limitReached ||
      charLimitExceeded ||
      i === words.length - 1
    );

    // Prevent orphan single-word phrase if we can absorb it into current phrase (when <= 4 words total)
    if (shouldSplit && isOrphanImpending && currentPhraseWords.length === 2 && !hasTerminalPunctuation && !hasSignificantPause) {
      shouldSplit = false; // Hold split to absorb final 3rd word smoothly
    }

    // Trigger phrase split if boundary conditions are satisfied
    if (shouldSplit) {
      const phraseText = currentPhraseWords.map(item => item.text.trim()).join(' ');

      // Compute phrase start as minimum word start and end as maximum word end
      const wordStarts = currentPhraseWords.map(w => w.start).filter(s => typeof s === 'number' && !isNaN(s));
      const wordEnds = currentPhraseWords.map(w => w.end).filter(e => typeof e === 'number' && !isNaN(e));

      const calcStart = wordStarts.length > 0 ? Math.min(...wordStarts) : currentPhraseWords[0].start;
      const calcEnd = wordEnds.length > 0 ? Math.max(...wordEnds) : currentPhraseWords[currentPhraseWords.length - 1].end;

      // Apply automatic line balancing algorithm
      const lineBalancing = balancePhraseLines(currentPhraseWords);

      phrases.push({
        text: phraseText,
        start: calcStart,
        end: calcEnd,
        words: [...currentPhraseWords],
        lines: lineBalancing.lines,
        breakAfterIndices: lineBalancing.breakAfterIndices
      });
      currentPhraseWords = [];
    }
  }

  // Sanitize all phrases to guarantee strictly chronological, non-overlapping, and positive-duration events
  return sanitizePhraseTimings(phrases);
}

/**
 * Computes optimal line breaks for a phrase to balance line character lengths visually.
 * Prevents orphan short words on separate lines (e.g. balances "This is a very long sentence" to 2 balanced lines).
 * 
 * @param {Array<object>} words - Array of word objects in the phrase.
 * @returns {object} { lines: Array<string>, breakAfterIndices: Array<number> }
 */
export function balancePhraseLines(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return { lines: [''], breakAfterIndices: [] };
  }

  const wordTexts = words.map(w => (w.text || w.word || '').trim());
  
  // Single word or short phrase fits on 1 line
  if (words.length <= 3) {
    const fullText = wordTexts.join(' ');
    if (fullText.length < 24) {
      return { lines: [fullText], breakAfterIndices: [] };
    }
  }

  // Multi-word phrase requiring balanced line split
  let bestSplitIndex = -1;
  let minDiff = Infinity;

  // Try split points between index 0 and words.length - 2
  for (let i = 0; i < wordTexts.length - 1; i++) {
    const line1 = wordTexts.slice(0, i + 1).join(' ');
    const line2 = wordTexts.slice(i + 1).join(' ');
    const diff = Math.abs(line1.length - line2.length);

    if (diff < minDiff) {
      minDiff = diff;
      bestSplitIndex = i;
    }
  }

  if (bestSplitIndex !== -1 && wordTexts.length > 2 && minDiff < 15) {
    const line1 = wordTexts.slice(0, bestSplitIndex + 1).join(' ');
    const line2 = wordTexts.slice(bestSplitIndex + 1).join(' ');
    return {
      lines: [line1, line2],
      breakAfterIndices: [bestSplitIndex]
    };
  }

  return {
    lines: [wordTexts.join(' ')],
    breakAfterIndices: []
  };
}


/**
 * Sanitizes phrase and word timestamps to ensure fault tolerance.
 * Automatically repairs inverted, NaN, overlapping, or zero-duration phrase bounds without throwing errors.
 * 
 * @param {Array<object>} phrases - Array of phrase objects.
 * @param {number} minDuration - Minimum phrase duration in seconds (default: 0.15s = 150ms).
 * @returns {Array<object>} Sanitized phrase objects.
 */
export function sanitizePhraseTimings(phrases, minDuration = 0.15) {
  if (!Array.isArray(phrases) || phrases.length === 0) {
    return [];
  }

  let prevEnd = 0;

  phrases.forEach((phrase, idx) => {
    const origStart = phrase.start;
    const origEnd = phrase.end;
    let repaired = false;
    const reasons = [];

    // 1. Sanitize base start / end numerical validity
    let start = typeof phrase.start === 'number' && !isNaN(phrase.start) && phrase.start >= 0 ? phrase.start : prevEnd;
    let end = typeof phrase.end === 'number' && !isNaN(phrase.end) ? phrase.end : start + minDuration;

    if (start !== origStart || end !== origEnd) {
      repaired = true;
      reasons.push(`Non-numerical or negative bounds (${origStart}, ${origEnd})`);
    }

    // 2. Compute minimum start and maximum end from inner words array
    if (Array.isArray(phrase.words) && phrase.words.length > 0) {
      const validWordStarts = phrase.words.map(w => w.start).filter(s => typeof s === 'number' && !isNaN(s));
      const validWordEnds = phrase.words.map(w => w.end).filter(e => typeof e === 'number' && !isNaN(e));

      if (validWordStarts.length > 0) {
        const minWordStart = Math.min(...validWordStarts);
        if (minWordStart < start) {
          repaired = true;
          reasons.push(`Adjusted start to minimum word start (${minWordStart.toFixed(3)}s)`);
          start = minWordStart;
        }
      }
      if (validWordEnds.length > 0) {
        const maxWordEnd = Math.max(...validWordEnds);
        if (maxWordEnd > end) {
          repaired = true;
          reasons.push(`Adjusted end to maximum word end (${maxWordEnd.toFixed(3)}s)`);
          end = maxWordEnd;
        }
      }
    }

    // 3. Prevent overlapping with preceding phrase
    if (idx > 0 && start < prevEnd) {
      repaired = true;
      reasons.push(`Overlapped with previous phrase end (${prevEnd.toFixed(3)}s); start shifted forward`);
      start = prevEnd;
    }

    // 4. Auto-extend end if end <= start
    if (end <= start) {
      repaired = true;
      const calcNewEnd = start + minDuration;
      reasons.push(`End time (${end.toFixed(3)}s) <= start time (${start.toFixed(3)}s); auto-extended to ${calcNewEnd.toFixed(3)}s`);
      end = calcNewEnd;
    }

    // Assign sanitized bounds
    phrase.start = start;
    phrase.end = end;
    prevEnd = end;

    // 5. Sanitize internal word timestamps to stay within phrase bounds and prevent negative karaoke durations
    if (Array.isArray(phrase.words) && phrase.words.length > 0) {
      let wordCursor = start;
      const totalWords = phrase.words.length;
      const totalDur = Math.max(minDuration, end - start);
      const defaultWordDur = totalDur / totalWords;

      phrase.words.forEach((w) => {
        let wStart = typeof w.start === 'number' && !isNaN(w.start) ? w.start : wordCursor;
        let wEnd = typeof w.end === 'number' && !isNaN(w.end) ? w.end : wStart + defaultWordDur;

        // Clamp word to phrase bounds
        if (wStart < wordCursor) wStart = wordCursor;
        if (wStart >= end) wStart = Math.max(start, end - 0.05);

        if (wEnd <= wStart) wEnd = wStart + 0.05;
        if (wEnd > end) wEnd = end;

        w.start = wStart;
        w.end = wEnd;
        wordCursor = wEnd;
      });
    }

    // Log detailed warning whenever a timing repair is performed
    if (repaired) {
      console.warn(
        `[SubtitleSanitizer] WARNING: Repaired timeline bounds for phrase "${phrase.text}" (Index ${idx}): ` +
        `original [${typeof origStart === 'number' ? origStart.toFixed(3) : origStart}s, ${typeof origEnd === 'number' ? origEnd.toFixed(3) : origEnd}s] -> ` +
        `corrected [${start.toFixed(3)}s, ${end.toFixed(3)}s]. Repair Reasons: ${reasons.join('; ')}`
      );
    }
  });

  return phrases;
}

