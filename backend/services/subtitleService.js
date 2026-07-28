import fs from 'fs';
import path from 'path';
import { groupWordsToPhrases, sanitizePhraseTimings } from '../utils/phraseGrouper.js';
import { generateASSHeader, generateASSDialogueLine, resolveASSStyle } from '../utils/assWriter.js';

/**
 * Service to orchestrate advanced subtitle (.ass) creation from raw Whisper transcript inputs.
 * Loads json or custom edited word arrays, groups phrases, resolves styling, and writes target output.
 * 
 * @param {string} transcriptPath - Absolute path to the saved Whisper JSON transcript.
 * @param {string} subtitlePath - Absolute path where the generated .ass file will be exported.
 * @param {object} options - Optional styling parameters and custom edited word list.
 * @returns {Promise<string>} Resolves with the subtitlePath if successful.
 */
export async function generateSubtitleFromTranscript(transcriptPath, subtitlePath, options = {}) {
  let whisperData;

  if (options.words && Array.isArray(options.words)) {
    console.log(`[SubtitleService] Generating subtitles from edited word list (${options.words.length} words)`);
    whisperData = { words: options.words };
  } else {
    if (!fs.existsSync(transcriptPath)) {
      throw new Error(`Transcript file not found at: ${transcriptPath}`);
    }

    console.log(`[SubtitleService] Generating subtitle file at ${subtitlePath} from transcript ${transcriptPath}`);

    try {
      const rawContent = fs.readFileSync(transcriptPath, 'utf8');
      whisperData = JSON.parse(rawContent);
    } catch (err) {
      throw new Error(`Corrupt JSON transcript: Failed to parse file content. Details: ${err.message}`);
    }
  }

  // 1. Group individual word timings to cohesive, balanced phrases
  const rawPhrases = groupWordsToPhrases(whisperData);

  if (rawPhrases.length === 0) {
    throw new Error('Incomplete transcription: The transcript contains no words or segments to subtitle.');
  }

  // Sanitize phrases for fault-tolerant timeline safety
  const phrases = sanitizePhraseTimings(rawPhrases);

  // 2. Resolve the ASS style settings and generate header
  const resolvedStyle = resolveASSStyle(options.styles || {});
  const assHeader = generateASSHeader(resolvedStyle);

  // 3. Translate phrase objects into formatted Dialogue entries
  const dialogueLines = [];
  const styleOptions = {
    textCase: options.styles?.textCase || 'uppercase',
    animationMode: resolvedStyle.animationMode || 'karaoke',
    popScale: resolvedStyle.popScale || 118
  };
  
  phrases.forEach((phrase) => {
    // Generate dialogue line using phrase model and resolved animation mode
    const dialogueLine = generateASSDialogueLine(phrase, styleOptions);
    dialogueLines.push(dialogueLine);
  });

  // Combine header and dialogue lines
  const assOutputContent = [
    assHeader,
    dialogueLines.join('\n')
  ].join('\n');

  // Verify parent folder exists
  const parentFolder = path.dirname(subtitlePath);
  if (!fs.existsSync(parentFolder)) {
    fs.mkdirSync(parentFolder, { recursive: true });
  }

  // 4. Save file to disk
  fs.writeFileSync(subtitlePath, assOutputContent, 'utf8');
  console.log(`[SubtitleService] Successfully wrote subtitle structure to ${subtitlePath}`);

  return subtitlePath;
}
