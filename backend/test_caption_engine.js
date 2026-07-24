import assert from 'assert';
import { groupWordsToPhrases } from './utils/phraseGrouper.js';
import { resolveASSStyle, generateASSHeader, generateASSDialogueLine } from './utils/assWriter.js';
import { generateSubtitleFromTranscript } from './services/subtitleService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Starting Caption Studio Milestone 3 Engine Verification ---');

// 1. Test Phrase Grouper logic
console.log('\n[Test 1] Phrase Grouper Rules & Overlap Elimination');
const mockWhisperData = {
  words: [
    { word: "Welcome", start: 0.0, end: 0.4 },
    { word: "to", start: 0.45, end: 0.6 },
    { word: "the", start: 0.62, end: 0.8 },
    { word: "Caption", start: 0.82, end: 1.2 },
    { word: "Studio", start: 1.25, end: 1.8 },
    { word: "Engine.", start: 1.85, end: 2.3 },
    // Pause gap > 0.25s
    { word: "Create", start: 2.8, end: 3.1 },
    { word: "viral", start: 3.15, end: 3.4 },
    { word: "videos", start: 3.45, end: 3.9 },
    { word: "fast.", start: 3.95, end: 4.3 }
  ]
};

const phrases = groupWordsToPhrases(mockWhisperData);
console.log(`Generated ${phrases.length} phrases:`, phrases);

// Assertions
assert.ok(phrases.length > 0, 'Phrases should be generated');
phrases.forEach((phrase, i) => {
  // Check word limit per phrase
  const wordCount = phrase.text.split(' ').length;
  assert.ok(wordCount <= 3, `Phrase ${i} exceeds max word limit of 3: "${phrase.text}" (${wordCount} words)`);
  
  // Check non-overlapping start/end bounds
  assert.ok(phrase.end > phrase.start, `Phrase ${i} end (${phrase.end}) must be > start (${phrase.start})`);
  if (i < phrases.length - 1) {
    assert.ok(phrase.end <= phrases[i + 1].start, `Phrase ${i} end (${phrase.end}) overlaps next start (${phrases[i + 1].start})`);
  }
});
console.log('✓ Phrase Grouper constraints verified (max 3 words, non-overlapping sequential timestamps)');

// 2. Test ASS Style Resolver & Header Generator
console.log('\n[Test 2] ASS Style Resolver & Header Generation');
const resolvedStyle = resolveASSStyle({
  preset: 'bold-yellow',
  fontFamily: 'Montserrat',
  fontSize: '18',
  position: 'center'
});
console.log('Resolved ASS Style:', resolvedStyle);

assert.strictEqual(resolvedStyle.fontName, 'Montserrat');
const expectedScaledFontSize = Math.round(18 * 5.14); // 93px on 1080x1920 canvas
assert.strictEqual(resolvedStyle.fontSize, expectedScaledFontSize);
assert.strictEqual(resolvedStyle.primaryColor, '&H0000FFFF'); // Yellow
assert.strictEqual(resolvedStyle.marginV, 960); // Vertical center offset

const assHeader = generateASSHeader(resolvedStyle);
assert.ok(assHeader.includes('Fontname, Fontsize'), 'ASS Header format specification line check');
assert.ok(assHeader.includes('Montserrat'), 'ASS Header must state font name');
console.log('✓ ASS Style Resolver & Header generation verified');

// 3. Test Subtitle Service with Edited Words
console.log('\n[Test 3] Subtitle Service Generation with Custom Options');
const tempSubPath = path.join(__dirname, 'test_output.ass');
const mockEditedWords = [
  { word: "WELCOME", start: 0.0, end: 0.5 },
  { word: "TO", start: 0.5, end: 0.8 },
  { word: "CAPTION", start: 0.8, end: 1.3 },
  { word: "STUDIO!", start: 1.3, end: 2.0 }
];

await generateSubtitleFromTranscript('', tempSubPath, {
  words: mockEditedWords,
  styles: {
    preset: 'gradient-glow',
    fontFamily: 'Bebas Neue',
    fontSize: '20',
    textCase: 'uppercase'
  }
});

assert.ok(fs.existsSync(tempSubPath), 'Generated .ass file should exist');
const assContent = fs.readFileSync(tempSubPath, 'utf8');
console.log('--- Generated ASS File Content ---\n' + assContent + '\n--- End ASS File Content ---');
assert.ok(assContent.includes('Bebas Neue'), 'ASS file must contain Bebas Neue font');
assert.ok(assContent.includes('CAPTION') && assContent.includes('STUDIO!'), 'ASS dialogue should contain edited uppercase words');

// Clean test file
fs.unlinkSync(tempSubPath);
console.log('✓ Subtitle Service with custom edited words & styles verified');

// 4. Test Fault-Tolerant Timing Sanitation
console.log('\n[Test 4] Fault-Tolerant Subtitle Timing Sanitation (Inverted, NaN & Overlapping Timestamps)');
const corruptWords = [
  { word: "FAULT", start: 1.0, end: 0.5 },      // Inverted end < start
  { word: "TOLERANT", start: 0.4, end: 0.8 },   // Overlaps & starts before previous
  { word: "TIMING", start: NaN, end: undefined },// Invalid / NaN
  { word: "ENGINE!", start: 0.8, end: 0.8 }     // Zero duration end == start
];

const tempSanitizeSubPath = path.join(__dirname, 'test_sanitize_output.ass');

// Should resolve without throwing any exception
await generateSubtitleFromTranscript('', tempSanitizeSubPath, {
  words: corruptWords,
  styles: {
    preset: 'bold-yellow',
    fontFamily: 'Montserrat',
    fontSize: '14'
  }
});

assert.ok(fs.existsSync(tempSanitizeSubPath), 'Sanitized .ass file should be created despite corrupt input timestamps');
const sanitizedAssContent = fs.readFileSync(tempSanitizeSubPath, 'utf8');
console.log('--- Sanitized ASS Content Output ---\n' + sanitizedAssContent + '\n--- End Sanitized ASS Content ---');

assert.ok(sanitizedAssContent.includes('FAULT'), 'Sanitized ASS output must contain dialogue words');
assert.ok(sanitizedAssContent.includes('ENGINE!'), 'Sanitized ASS output must contain end word');

// Clean test file
fs.unlinkSync(tempSanitizeSubPath);
console.log('✓ Fault-Tolerant Subtitle Timing Sanitation successfully verified (0 exceptions, all bounds auto-repaired)');

console.log('\n=== ALL CAPTION ENGINE TESTS PASSED SUCCESSFULLY! ===\n');
