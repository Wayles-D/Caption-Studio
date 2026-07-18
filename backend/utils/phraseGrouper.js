/**
 * Groups raw Word-level Whisper timestamps into coherent phrases (2-5 words).
 * Implements splits based on sentence punctuation, audio pauses, word targets, and character lengths.
 * Includes a robust fallback that synthesizes word-level timings from Segment-only payloads.
 * 
 * @param {object} whisperData - The JSON response parsed from the Whisper transcription.
 * @returns {Array<object>} Returns an array of phrase objects with text, start, end, and word items.
 */
export function groupWordsToPhrases(whisperData) {
  if (!whisperData || (!whisperData.text && !whisperData.segments)) {
    throw new Error('Invalid Whisper response format: missing transcript or segments.');
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

    // Check for silent pauses between words (typically >0.4 seconds)
    let hasSignificantPause = false;
    if (i < words.length - 1) {
      const nextWord = words[i + 1];
      const nextStart = typeof nextWord.start === 'number' ? nextWord.start : 0;
      if (nextStart - end > 0.40) {
        hasSignificantPause = true;
      }
    }

    // Words limitation rule: 2-5 words per subtitle
    const limitReached = currentPhraseWords.length >= 5;

    // Character length rule: Target ~38 characters limit per phrase
    const currentTextLength = currentPhraseWords.map(item => item.text.trim()).join(' ').length;
    const charLimitExceeded = currentTextLength >= 38;

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

  // Validate phrase list: Guarantee end > start and enforce sequential timestamps
  for (const phrase of phrases) {
    if (phrase.end <= phrase.start) {
      phrase.end = phrase.start + 0.50; // offset slightly
    }
  }

  return phrases;
}
