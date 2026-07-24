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

    currentPhraseWords.push({ text, start, end });

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

    // Tight words limitation rule: Max 3 words per phrase for creator visual style
    const limitReached = currentPhraseWords.length >= 3;

    // Character length rule: Target ~24 characters limit per phrase for mobile screen width
    const currentTextLength = currentPhraseWords.map(item => item.text.trim()).join(' ').length;
    const charLimitExceeded = currentTextLength >= 24;

    // Trigger phrase split if boundary conditions are satisfied
    if (
      hasTerminalPunctuation ||
      hasSignificantPause ||
      limitReached ||
      charLimitExceeded ||
      i === words.length - 1
    ) {
      const phraseText = currentPhraseWords.map(item => item.text.trim()).join(' ');
      phrases.push({
        text: phraseText,
        start: currentPhraseWords[0].start,
        end: currentPhraseWords[currentPhraseWords.length - 1].end,
        words: [...currentPhraseWords]
      });
      currentPhraseWords = [];
    }
  }

  // Validate phrase list: Enforce sequential timestamps and eliminate any overlaps
  for (let i = 0; i < phrases.length; i++) {
    const current = phrases[i];

    if (current.end <= current.start) {
      current.end = current.start + 0.30; // Enforce minimum duration
    }

    // Force strict sequential ordering: preceding caption must end before or at the start of next caption
    if (i < phrases.length - 1) {
      const next = phrases[i + 1];
      if (current.end > next.start) {
        current.end = next.start;
      }
    }
  }

  return phrases;
}
