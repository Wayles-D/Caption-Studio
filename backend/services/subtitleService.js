import fs from 'fs';
import path from 'path';
import { groupWordsToPhrases } from '../utils/phraseGrouper.js';
import { generateASSHeader, generateASSDialogueLine } from '../utils/assWriter.js';

/**
 * Service to orchestrate advanced subtitle (.ass) creation from raw Whisper transcript inputs.
 * Loads json, groups phrases, converts timings to ASS format, validates boundaries, and writes target output.
 * 
 * @param {string} transcriptPath - Absolute path to the saved Whisper JSON transcript.
 * @param {string} subtitlePath - Absolute path where the generated .ass file will be exported.
 * @returns {Promise<string>} Resolves with the subtitlePath if successful.
 */
export async function generateSubtitleFromTranscript(transcriptPath, subtitlePath) {
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found at: ${transcriptPath}`);
  }

  console.log(`[SubtitleService] Generating subtitle file at ${subtitlePath} from transcript ${transcriptPath}`);

  let whisperData;
  try {
    const rawContent = fs.readFileSync(transcriptPath, 'utf8');
    whisperData = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Corrupt JSON transcript: Failed to parse file content. Details: ${err.message}`);
  }

  // 1. Group individual word timings to cohesive, balanced phrases
  const phrases = groupWordsToPhrases(whisperData);

  if (phrases.length === 0) {
    throw new Error('Incomplete transcription: The transcript contains no words or segments to subtitle.');
  }

  // 2. Generate the ASS header containing resolution scaling and vertical styling directives
  const assHeader = generateASSHeader();

  // 3. Translate phrase objects into formatted Dialogue entries
  const dialogueLines = [];
  
  phrases.forEach((phrase, idx) => {
    // Structural validations: sequential validation
    if (typeof phrase.start !== 'number' || typeof phrase.end !== 'number') {
      throw new Error(`Malformed timestamps in phrased item index ${idx}.`);
    }

    if (phrase.end <= phrase.start) {
      throw new Error(`Invalid timeline bounds: Event ends before starting (Start: ${phrase.start}s, End: ${phrase.end}s) at phrase: "${phrase.text}"`);
    }

    // Generate standard dialogue string
    const dialogueLine = generateASSDialogueLine(phrase);
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
