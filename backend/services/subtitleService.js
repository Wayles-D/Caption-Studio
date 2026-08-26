import fs from 'fs';
import path from 'path';
import { groupWordsToPhrases, sanitizePhraseTimings } from '../utils/phraseGrouper.js';
import {
  generateASSHeader, generateASSDialogueLine, resolveASSStyle,
  generateUnifiedShadowASSHeader, generateUnifiedShadowDialogueLine, generateUnifiedShadowWordDialogueEvents,
  generateUnifiedShadowRollingStackDialogueEvents
} from '../utils/assWriter.js';

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
    popScale: resolvedStyle.popScale || 118,
    primaryColor: resolvedStyle.primaryColor,
    secondaryColor: resolvedStyle.secondaryColor,
    primaryColorHex: resolvedStyle.primaryColorHex,
    secondaryColorHex: resolvedStyle.secondaryColorHex,
    posOverrideTag: resolvedStyle.posOverrideTag || null,
    enableKeywordHighlighting: resolvedStyle.enableKeywordHighlighting !== false,
    keywordColor: resolvedStyle.keywordColor,
    shadowColor: resolvedStyle.shadowColor,
    shadowOffsetX: resolvedStyle.shadowOffsetX,
    shadowOffsetY: resolvedStyle.shadowOffsetY,
    outlineSize: resolvedStyle.outlineSize,
    shadowSize: resolvedStyle.shadowSize,
    keywordDriven: resolvedStyle.keywordDriven,
    keywordStyleConfig: resolvedStyle.keywordStyleConfig,
    keywordTextCase: resolvedStyle.keywordTextCase,
    activeHighlightEnabled: resolvedStyle.activeHighlightEnabled,
    textOpacity: resolvedStyle.textOpacity,
    baseFontFamily: resolvedStyle.fontName,
    baseFontWeight: resolvedStyle.profile?.fontWeight,
    captionMode: resolvedStyle.captionMode
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

/**
 * Generates the Unified Caption Shadow's own silhouette .ass track — a
 * separate flat-colored, no-outline/no-native-shadow rendering of the same
 * phrases, positioned identically to the real captions. burnSubtitles then
 * composites this track onto an offscreen transparent layer, blurs and
 * offsets THAT layer as a single image, and overlays it beneath the real
 * caption burn — which is what makes it read as one continuous shadow shape
 * instead of a shadow behind every individual character.
 *
 * Only ever called when resolveShadowMode(...) === 'unified' (see
 * uploadController.js); returns null otherwise so callers can skip the
 * extra compositing pass entirely for the 'individual'/'none' modes.
 *
 * @param {string} transcriptPath - Absolute path to the saved Whisper JSON transcript.
 * @param {string} shadowSubtitlePath - Absolute path where the shadow .ass file will be written.
 * @param {object} options - Same shape as generateSubtitleFromTranscript's options ({ words, styles }).
 * @returns {Promise<string|null>} Resolves with shadowSubtitlePath, or null if shadow mode isn't 'unified'.
 */
export async function generateUnifiedShadowSubtitle(transcriptPath, shadowSubtitlePath, options = {}) {
  const resolvedStyle = resolveASSStyle(options.styles || {});
  if (resolvedStyle.shadowMode !== 'unified') {
    return null;
  }

  let whisperData;
  if (options.words && Array.isArray(options.words)) {
    whisperData = { words: options.words };
  } else {
    if (!fs.existsSync(transcriptPath)) {
      throw new Error(`Transcript file not found at: ${transcriptPath}`);
    }
    whisperData = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  }

  const rawPhrases = groupWordsToPhrases(whisperData);
  if (rawPhrases.length === 0) {
    return null;
  }
  const phrases = sanitizePhraseTimings(rawPhrases);

  const shadowHeader = generateUnifiedShadowASSHeader(resolvedStyle);
  const dialogueOptions = {
    textCase: options.styles?.textCase || 'uppercase',
    posOverrideTag: resolvedStyle.posOverrideTag || null,
    enableKeywordHighlighting: resolvedStyle.enableKeywordHighlighting !== false,
    keywordTextCase: resolvedStyle.keywordTextCase
  };
  // Word Mode's unified shadow silhouettes one word at a time, and Rolling
  // Stack's silhouettes one two-line slice at a time (matching each mode's
  // own real caption track), instead of the whole phrase for its whole
  // duration.
  const dialogueLines = resolvedStyle.captionMode === 'word'
    ? phrases.map((phrase) => generateUnifiedShadowWordDialogueEvents(phrase, dialogueOptions))
    : resolvedStyle.captionMode === 'rolling-stack'
      ? phrases.map((phrase) => generateUnifiedShadowRollingStackDialogueEvents(phrase, dialogueOptions))
      : phrases.map((phrase) => generateUnifiedShadowDialogueLine(phrase, dialogueOptions));

  const assOutputContent = [shadowHeader, dialogueLines.join('\n')].join('\n');

  const parentFolder = path.dirname(shadowSubtitlePath);
  if (!fs.existsSync(parentFolder)) {
    fs.mkdirSync(parentFolder, { recursive: true });
  }
  fs.writeFileSync(shadowSubtitlePath, assOutputContent, 'utf8');
  console.log(`[SubtitleService] Successfully wrote Unified Shadow subtitle track to ${shadowSubtitlePath}`);

  return shadowSubtitlePath;
}
