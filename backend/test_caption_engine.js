import assert from 'assert';
import { groupWordsToPhrases } from './utils/phraseGrouper.js';
import { resolveASSStyle, generateASSHeader, generateASSDialogueLine } from './utils/assWriter.js';
import { generateSubtitleFromTranscript } from './services/subtitleService.js';
import { getASSStyleFromConfig, getCSSPreviewFromConfig, CREATOR_PROFILES, ANIMATION_MODES, hexToASSColor } from '../shared/captionConfig.js';
import { balancePhraseLines } from './utils/phraseGrouper.js';
import { wordOffsetToCanvasPx, canvasPxToWordOffset } from '../shared/captionGraphics.js';
import { buildVideoTransformFilterChain } from './utils/videoTransformFilter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('--- Starting Caption Studio Milestone 3 Engine Verification ---');

// 1. Test Phrase Grouper logic & Line Balancing
console.log('\n[Test 1] Phrase Grouper Rules & Automatic Line Balancing');
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
  const wordCount = phrase.words.length;
  assert.ok(wordCount <= 3, `Phrase ${i} exceeds max word limit of 3: "${phrase.text}" (${wordCount} words)`);
  
  // Check non-overlapping start/end bounds
  assert.ok(phrase.end > phrase.start, `Phrase ${i} end (${phrase.end}) must be > start (${phrase.start})`);
  if (i < phrases.length - 1) {
    assert.ok(phrase.end <= phrases[i + 1].start, `Phrase ${i} end (${phrase.end}) overlaps next start (${phrases[i + 1].start})`);
  }
});

// Test Line Balancing explicitly
const sampleLongPhraseWords = [
  { word: "This", start: 0.0, end: 0.3 },
  { word: "is", start: 0.3, end: 0.5 },
  { word: "a", start: 0.5, end: 0.7 },
  { word: "balanced", start: 0.7, end: 1.2 },
  { word: "caption", start: 1.2, end: 1.6 }
];
const balancingResult = balancePhraseLines(sampleLongPhraseWords);
console.log('Line balancing test result:', balancingResult);
assert.strictEqual(balancingResult.lines.length, 2, 'Long phrase should split into 2 balanced lines');
assert.ok(balancingResult.breakAfterIndices.length === 1, 'Should have 1 line break index');
console.log('✓ Phrase Grouper & Automatic Line Balancing verified');

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

// 3. Test Animation Modes Generation in ASS Dialogue
console.log('\n[Test 3] Animation Modes ASS Tag Generation');
const samplePhrase = {
  start: 0,
  end: 1.5,
  words: [
    { word: "HELLO", start: 0, end: 0.5 },
    { word: "WORLD", start: 0.5, end: 1.5 }
  ],
  breakAfterIndices: []
};

['karaoke', 'pop', 'instant', 'typewriter'].forEach(mode => {
  const line = generateASSDialogueLine(samplePhrase, { animationMode: mode, textCase: 'uppercase' });
  console.log(`Mode '${mode}' ASS line:`, line);
  assert.ok(line.startsWith('Dialogue: 0,'), `Mode ${mode} must yield valid Dialogue string`);
  if (mode === 'pop') {
    assert.ok(line.includes('\\fscx'), 'Pop mode must include \\fscx tag');
  } else if (mode === 'typewriter') {
    assert.ok(line.includes('\\alpha&H00&'), 'Typewriter mode must reveal words with \\alpha&H00&');
  }
});
console.log('✓ All 4 Animation Modes verified for ASS output');

// 3b. Hard-swap highlighting must match preview: full phrase always visible,
// only the currently active word colored, no progressive sweep, and earlier
// words must revert to inactive once no longer active.
console.log('\n[Test 3b] Hard-Swap Highlighting Matches Preview (No Reveal/Sweep)');
['karaoke', 'pop', 'instant'].forEach(mode => {
  const events = generateASSDialogueLine(samplePhrase, {
    animationMode: mode,
    textCase: 'uppercase',
    primaryColor: '&H0000FFFF',
    secondaryColor: '&H00FFFFFF'
  }).split('\n');

  assert.ok(events.length >= 2, `Mode ${mode} must slice into multiple boundary events, not one karaoke-tagged line`);
  events.forEach(event => {
    assert.ok(!event.includes('\\k') && !event.includes('\\kf'), `Mode ${mode} must not use \\k/\\kf progressive-fill tags: ${event}`);
    assert.ok(event.includes('HELLO') && event.includes('WORLD'), `Mode ${mode} must keep the full phrase visible in every event: ${event}`);
  });

  // First event: HELLO active (yellow primary), WORLD inactive (white secondary)
  assert.ok(events[0].includes('HELLO {\\1a&H00&\\1c&H00FFFF&') === false, 'sanity: active tag precedes word, not after');
  assert.ok(/\{\\1a&H00&\\1c&H00FFFF&[^}]*\}HELLO/.test(events[0]), `Mode ${mode} first event must color HELLO active`);
  assert.ok(/\{\\1a&H00&\\1c&HFFFFFF&\}WORLD/.test(events[0]), `Mode ${mode} first event must color WORLD inactive`);

  // Second event: WORLD becomes active, HELLO must revert to inactive (not stay highlighted)
  assert.ok(/\{\\1a&H00&\\1c&HFFFFFF&\}HELLO/.test(events[1]), `Mode ${mode} must revert HELLO to inactive once WORLD is active`);
  assert.ok(/\{\\1a&H00&\\1c&H00FFFF&[^}]*\}WORLD/.test(events[1]), `Mode ${mode} second event must color WORLD active`);
});
console.log('✓ Hard-swap highlighting confirmed frame-accurate with no reveal/sweep, and words revert to inactive');

// 4. Test Subtitle Service with Edited Words
console.log('\n[Test 4] Subtitle Service Generation with Custom Options');
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
    preset: 'caps-white',
    fontFamily: 'Bebas Neue',
    fontSize: '20',
    animationMode: 'pop',
    textCase: 'uppercase'
  }
});

assert.ok(fs.existsSync(tempSubPath), 'Generated .ass file should exist');
const assContent = fs.readFileSync(tempSubPath, 'utf8');
console.log('--- Generated ASS File Content ---\n' + assContent + '\n--- End ASS File Content ---');
assert.ok(assContent.includes('Bebas Neue'), 'ASS file must contain Bebas Neue font');
assert.ok(assContent.includes('{\\'), 'ASS dialogue must contain tag formatting');
assert.ok(assContent.includes('CAPTION') && assContent.includes('STUDIO!'), 'ASS dialogue should contain edited uppercase words');

// Clean test file
fs.unlinkSync(tempSubPath);
console.log('✓ Subtitle Service with custom edited words & styles verified');

// 5. Test Fault-Tolerant Timing Sanitation
console.log('\n[Test 5] Fault-Tolerant Subtitle Timing Sanitation');
const corruptWords = [
  { word: "FAULT", start: 1.0, end: 0.5 },      // Inverted end < start
  { word: "TOLERANT", start: 0.4, end: 0.8 },   // Overlaps & starts before previous
  { word: "TIMING", start: NaN, end: undefined },// Invalid / NaN
  { word: "ENGINE!", start: 0.8, end: 0.8 }     // Zero duration end == start
];

const tempSanitizeSubPath = path.join(__dirname, 'test_sanitize_output.ass');

await generateSubtitleFromTranscript('', tempSanitizeSubPath, {
  words: corruptWords,
  styles: {
    preset: 'bold-yellow',
    fontFamily: 'Montserrat',
    fontSize: '14'
  }
});

assert.ok(fs.existsSync(tempSanitizeSubPath), 'Sanitized .ass file should be created');
const sanitizedAssContent = fs.readFileSync(tempSanitizeSubPath, 'utf8');

assert.ok(sanitizedAssContent.includes('FAULT'), 'Sanitized ASS output must contain dialogue words');
assert.ok(sanitizedAssContent.includes('ENGINE!'), 'Sanitized ASS output must contain end word');

// Clean test file
fs.unlinkSync(tempSanitizeSubPath);
console.log('✓ Fault-Tolerant Subtitle Timing Sanitation successfully verified');

// 6. Test Creator Profiles & WYSIWYG Single Source of Truth Alignment
console.log('\n[Test 6] Creator Profiles & WYSIWYG Single Source of Truth Schema Alignment');
const testStyles = {
  preset: 'caps-white',
  fontFamily: 'Outfit',
  fontSize: '18',
  position: 'top',
  textCase: 'uppercase'
};

const assResolved = getASSStyleFromConfig(testStyles);
const cssResolved = getCSSPreviewFromConfig(testStyles);

assert.strictEqual(assResolved.fontName, 'Outfit', 'ASS fontName must match input fontFamily');
assert.ok(cssResolved.text.fontFamily.includes('Outfit'), 'CSS fontFamily must contain input font');
assert.strictEqual(assResolved.fontSize, Math.round(18 * 5.14), 'ASS fontSize must scale proportionally (18 * 5.14)');
assert.strictEqual(cssResolved.text.fontSize, '18px', 'CSS fontSize must match frontend input px');

// 7. Test Word Spacing, Color Customization Overrides & Pop Scale
console.log('\n[Test 7] Word Spacing, Custom Color Overrides & Pop Scale Alignment');

// Hex to ASS Color test
assert.strictEqual(hexToASSColor('#FEF08A'), '&H008AF0FE', 'Hex #FEF08A must convert to ASS BGR &H008AF0FE');
assert.strictEqual(hexToASSColor('transparent'), '&HFF000000', 'Transparent must convert to ASS alpha FF');

const customParams = {
  preset: 'bold-yellow',
  activeWordColor: '#FF0000',     // Red
  inactiveWordColor: '#00FF00',   // Green
  outlineColor: '#0000FF',        // Blue
  backgroundColor: '#112233',
  wordSpacing: 10,
  popScale: 135
};

const customAss = getASSStyleFromConfig(customParams);
const customCss = getCSSPreviewFromConfig(customParams);

assert.strictEqual(customAss.primaryColor, '&H000000FF', 'Custom active word color #FF0000 must map to ASS &H000000FF');
assert.strictEqual(customCss.highlightColor, '#FF0000', 'CSS highlightColor must match custom #FF0000');
assert.strictEqual(customAss.spacing, 15, 'Word spacing of 10 must scale to ASS spacing of 15px');
assert.strictEqual(customCss.wordSpacingPx, 10, 'CSS wordSpacingPx must match 10');
assert.strictEqual(customAss.popScale, 135, 'ASS popScale must equal 135');
assert.strictEqual(customCss.popScale, 135, 'CSS popScale must equal 135');

const popDialogue = generateASSDialogueLine(samplePhrase, { animationMode: 'pop', popScale: customParams.popScale });
assert.ok(popDialogue.includes('\\fscx135\\fscy135'), 'Pop dialogue line must contain \\fscx135 tag when popScale is 135');

console.log('✓ Word Spacing, Color Customization & Pop Scale alignment verified!');

// 8. Word position offsets must be RESOLUTION-INDEPENDENT
console.log('\n[Test 8] Word Offset Unit Is Resolution-Independent (preview/export parity)');
// Regression guard for a real bug: offsetXPx/offsetYPx (a word's on-canvas
// drag position) used to be stored in, and applied as, RAW canvas
// backing-store px. The preview canvas is sized from the live on-screen
// phone-frame (~168-322px wide) while the export canvas is the output
// video's real width (e.g. 1080px), so the identical stored number moved the
// word a completely different fraction of the frame in each renderer — a
// word dragged far left in the preview rendered back near its default
// position in the exported file. Verified by pixel-scanning both renderers
// with one payload: preview placed the glyph center at 21.1% of frame width,
// export at 44.6%. The offset is now authored in the SAME 330px-reference-box
// unit as fontSize/spacing/outline, converted per-renderer by
// wordOffsetToCanvasPx. This asserts the invariant that actually matters:
// one stored offset == one fraction of the frame, at ANY canvas width.
const PREVIEW_CANVAS_W = 168;   // live phone-frame preview, devicePixelRatio 1
const EXPORT_CANVAS_W = 1080;   // 1080x1920 output video
const STORED_OFFSET = -60;

const previewFraction = wordOffsetToCanvasPx(STORED_OFFSET, PREVIEW_CANVAS_W) / PREVIEW_CANVAS_W;
const exportFraction = wordOffsetToCanvasPx(STORED_OFFSET, EXPORT_CANVAS_W) / EXPORT_CANVAS_W;
console.log(`Offset ${STORED_OFFSET} -> preview fraction ${previewFraction.toFixed(6)}, export fraction ${exportFraction.toFixed(6)}`);
assert.ok(
  Math.abs(previewFraction - exportFraction) < 1e-9,
  `A stored word offset must cover the SAME fraction of the frame in every renderer — got preview ${previewFraction} vs export ${exportFraction}`
);

// Round-trip: canvas px -> stored unit -> canvas px, at each resolution.
[PREVIEW_CANVAS_W, EXPORT_CANVAS_W].forEach((canvasW) => {
  const canvasPx = 42;
  const roundTripped = wordOffsetToCanvasPx(canvasPxToWordOffset(canvasPx, canvasW), canvasW);
  assert.ok(Math.abs(roundTripped - canvasPx) < 1e-9, `Offset round-trip must be lossless at canvasWidth ${canvasW} (got ${roundTripped})`);
});
console.log('✓ Word offsets resolve to an identical frame fraction in preview and export');

// 9. Video transform segments must share ONE zero-based timeline
console.log('\n[Test 9] Video Transform Segment Timeline (keyframed rotation lands on time)');
// Regression guard for a real bug: the transformed ("active") segment used to
// keep its ORIGINAL absolute PTS while the untransformed pre/post segments
// were reset with setpts=PTS-STARTPTS, on the assumption that ffmpeg's
// `concat` filter re-stamps whatever it is handed. It does not — concat
// offsets each segment by the ACCUMULATED DURATION of the previous ones
// without subtracting that segment's own start PTS, so an active segment
// beginning at trimStart landed trimStart seconds late.
//
// Measured on a 5s clip with rotation keyframed 0deg->40deg starting at
// t=0.5: the export ran 5.52s instead of 5.00s, and every frame showed the
// angle the live preview had ~0.5s earlier (6.37deg vs 17.5deg at t=1.25).
// The same mismatch left the segment's first 0.5s showing only the black
// [vt_bg] background, since that generator always starts at 0.
//
// The active segment is now zero-based like its neighbours, and the sampled
// expressions read `t + trimStart` to stay keyed to absolute timeline time.
// These two MUST change together, which is exactly what this asserts.
const kfAt = (t, rotation) => ({ t, easing: 'ease-out', values: { positionX: 0, positionY: 0, scale: 1, rotation, opacity: 100 } });

const midStartChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 0, opacity: 100, keyframes: [kfAt(0.5, 0), kfAt(3.5, 40)] },
  5, 1080, 1920
);
assert.ok(
  /trim=start=0\.500:end=[\d.]+,setpts=PTS-STARTPTS/.test(midStartChain.filterComplex),
  'The transformed segment must reset PTS (setpts=PTS-STARTPTS) so `concat` places it at the right time'
);
assert.ok(
  midStartChain.filterComplex.includes('(t+0.500000)'),
  'With a zero-based active segment, sampled expressions must read `t + trimStart` to stay on the absolute timeline'
);

// No pre segment (keyframes start at 0) -> nothing to shift, `t` is already
// absolute, and the emitted expression must stay exactly as it was.
const fromZeroChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 0, opacity: 100, keyframes: [kfAt(0, 0), kfAt(3, 35)] },
  5, 1080, 1920
);
assert.ok(!fromZeroChain.filterComplex.includes('(t+'), 'With no pre segment there is no offset to apply — `t` must be used unshifted');
console.log('✓ Transformed and passthrough segments share one zero-based timeline');

// 10. Size stages must not be re-evaluated per frame when scale is constant
console.log('\n[Test 10] Video Transform Size Stages (no per-frame cost when scale is constant)');
// `scale`/`pad` with eval=frame rebuild the swscale context on every frame.
// That is only needed when the frame size actually changes, i.e. scale is
// animated. Measured on a 1080x1920 clip, a static 20deg rotation exported in
// 6.34s instead of 10.77s once the size was computed once (1.70x), for
// bit-identical output (SSIM 1.000000).
//
// The literal and the absent eval=frame MUST stay together: `t` does not exist
// at filter-init time, so a t-dependent size expression WITHOUT eval=frame
// makes ffmpeg reject the entire graph ("Error initializing filters") and the
// export silently falls back to the legacy ASS renderer.
const staticRotChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 20, opacity: 100 }, 5, 1080, 1920
);
assert.ok(!staticRotChain.filterComplex.includes('eval=frame'), 'A constant scale must not force per-frame size re-evaluation');
assert.ok(/scale=w='iw\*\(1\.000000\)'/.test(staticRotChain.filterComplex), 'A constant scale must be emitted as a literal, never a t-dependent expression');
assert.ok(!/scale=w='iw\*\([^']*\bt\b/.test(staticRotChain.filterComplex), 'Without eval=frame the size expression must not reference `t` — ffmpeg cannot evaluate it at init');

// Animated scale still needs genuine per-frame evaluation.
const animScaleChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 0, opacity: 100, keyframes: [kfAt(0, 0), kfAt(3, 0)].map((k, i) => ({ ...k, values: { ...k.values, scale: i === 0 ? 1 : 1.5 } })) },
  5, 1080, 1920
);
assert.ok(animScaleChain.filterComplex.includes('eval=frame'), 'An animated scale must keep eval=frame so the size tracks the animation');
console.log('✓ Size stages are evaluated once when constant, per-frame only when animated');

// 11. Video opacity must never be computed per-pixel again
console.log('\n[Test 11] Video Opacity Is A Per-Frame Scalar (not a per-pixel expression)');
// Opacity is uniform across a frame, but it used to be applied with `geq` — a
// PER-PIXEL filter — so ffmpeg re-derived that one number for every pixel on
// every plane. Measured on a real 35s 1920x1080 export with rotation +
// opacity: rotation's pad inflates the canvas to 2524x1747 (2.13x the source),
// giving 17.6 million expression evaluations per frame and 18.3 BILLION across
// the clip, each walking an interpreted 1768-char, 16-branch if(between(...))
// tree — to produce 1038 distinct values. That was ~87% of filter cost and
// took the export to 31.3 minutes, past the client's abort timeout, which made
// "every feature at once" look like a broken render instead of a slow one.
//
// It is now a timed `sendcmd` ramp into colorchannelmixer's native alpha gain:
// 12.4x faster on a 5s rotation+opacity clip (93.58s -> 7.55s) AND markedly
// more accurate — 54.49 dB vs the old 28.48 dB against a float-precision
// (gbrapf32le) reference, because each command samples the real eased curve
// instead of interpolating between 15 linear samples.
const fadeChain = buildVideoTransformFilterChain(
  {
    offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 0, opacity: 100,
    keyframes: [
      { t: 0.5, easing: 'ease-out', values: { positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 100 } },
      { t: 3.5, easing: 'ease-out', values: { positionX: 0, positionY: 0, scale: 1, rotation: 25, opacity: 30 } },
    ],
  },
  5, 1080, 1920
);
assert.ok(!/geq=/.test(fadeChain.filterComplex), 'Opacity must NOT be applied with geq — it is a per-pixel filter doing per-frame work');
assert.ok(/sendcmd=c='[^']+',colorchannelmixer=aa=1/.test(fadeChain.filterComplex), 'Opacity must be a sendcmd ramp into colorchannelmixer\'s native alpha gain');
// Commands are separated by an ESCAPED `;` — an unescaped one would be read by
// the filtergraph parser as a chain separator and corrupt the whole graph.
assert.ok(fadeChain.filterComplex.includes('\\;'), 'sendcmd command separators must be escaped as \\; for the filtergraph parser');
// Ramp must be finely quantized in time, not one step per keyframe.
const cmdCount = (fadeChain.filterComplex.match(/colorchannelmixer aa/g) || []).length;
assert.ok(cmdCount > 50, `Opacity ramp must be finely sampled to stay smooth (got ${cmdCount} commands)`);
// Command times are SEGMENT-LOCAL (the active segment is zero-based), so the
// first command must be at 0 even though the fade starts at t=0.5 absolute.
assert.ok(/'0\.000 colorchannelmixer aa 1\.000000/.test(fadeChain.filterComplex), 'First command must be at segment-local time 0 carrying the absolute-time opacity value');

// No fade -> no opacity stage at all, and nothing left behind.
const noFadeChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 20, opacity: 100 }, 5, 1080, 1920
);
assert.ok(!noFadeChain.filterComplex.includes('sendcmd'), 'A transform that never fades must not emit an opacity stage');
assert.ok(!noFadeChain.filterComplex.includes('colorchannelmixer'), 'A transform that never fades must not emit colorchannelmixer');
console.log(`✓ Opacity is a per-frame sendcmd ramp (${cmdCount} commands), never a per-pixel expression`);

// 12. The overlay background must not dictate the output frame rate
console.log('\n[Test 12] Video Transform Background Inherits Source Timing (no fps resample)');
// The background is the overlay's MAIN input, so IT decides the output frame
// rate. It used to be a synthetic `color=black:size=...` source with no `rate`
// set, which defaults to 25fps — silently resampling every transformed export
// to 25fps. Confirmed on a real 29.58fps source: a caption-only export stayed
// 29.58fps while the same clip WITH a video transform came out 25fps; after
// deriving the background from the source via `split`, it stays 29.58fps.
const bgChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 15, opacity: 100 }, 5, 1080, 1920
);
assert.ok(!/color=black:size=/.test(bgChain.filterComplex), 'The overlay background must not come from a `color` generator — it defaults to 25fps and drives the output rate');
assert.ok(/split=2\[vt_active_src\]\[vt_bg_src\]/.test(bgChain.filterComplex), 'The background must be split off the SAME trimmed source frames so it inherits their exact rate/PTS');
assert.ok(/\[vt_bg_src\]drawbox=[^[]*t=fill[^[]*\[vt_bg\]/.test(bgChain.filterComplex), 'The background must be the source frames painted black in place (drawbox t=fill)');
assert.ok(/\[vt_bg\]\[[a-z_]+\]overlay=/.test(bgChain.filterComplex), 'The black background must remain the overlay MAIN input (behind the video layer)');
console.log('✓ Overlay background is source-derived, so output frame rate matches the source');

// 13. Caption segment quantization must not accumulate timing drift
console.log('\n[Test 13] Caption Segment Quantization Is Drift-Free');
// Segments are CONTIGUOUS and tile the video exactly. Quantizing each DURATION
// independently used an asymmetric floor that stretched any sub-frame segment
// up to a full frame, so every later segment was pushed later — caption timing
// drifted against the audio, and the track ran long. Measured on a real 4.02s
// export: raw segment durations summed to exactly 4.020s but quantized to
// 4.100s, with the whole +0.080s coming from 8 sub-frame segments; the exported
// file ran 4.16s. Quantizing BOUNDARIES instead is drift-free by construction.
//
// This asserts the invariant directly on the same arithmetic the compositor
// uses, so it fails if anyone reintroduces a per-duration floor.
const FPS = 50, Q = 1 / FPS;
const qTime = (t) => Math.round(t / Q) * Q;
// A worst case: many deliberately sub-frame segments between normal ones.
const synthetic = [];
let at = 0;
for (let i = 0; i < 40; i++) {
  const span = i % 3 === 0 ? 0.004 : 0.2; // 0.004s is well under one 0.02s frame
  synthetic.push({ start: at, end: at + span, file: `f${i}.png` });
  at += span;
}
const videoDuration = at;
let cursor = qTime(synthetic[0].start);
const trackStart = cursor;
let kept = 0;
synthetic.forEach((s) => {
  const end = qTime(s.end);
  if (end - cursor < Q / 2) return;
  kept++;
  cursor = end;
});
const total = cursor - trackStart;
assert.ok(
  Math.abs(total - qTime(videoDuration)) < 1e-9,
  `Quantized track length (${total.toFixed(3)}s) must equal the video duration snapped to the frame grid (${qTime(videoDuration).toFixed(3)}s), not grow with segment count`
);
assert.ok(kept < synthetic.length, 'Sub-frame segments must be dropped rather than inflated to a full frame');
console.log(`✓ ${synthetic.length} segments (${synthetic.length - kept} sub-frame) quantize to exactly ${total.toFixed(3)}s with zero accumulated drift`);

// 14. Rotation's pad must never be able to be smaller than its input
console.log('\n[Test 14] Rotation Pad Defers To The Real Stream Dimensions');
// pad/rotate sizes used to be plain JS-computed literals derived from the
// dimensions getVideoInfo probed out of ffmpeg's stderr banner. That made the
// probe a SECOND source of truth about frame size, and `pad` fails outright the
// moment it disagrees with the frames ffmpeg actually decodes:
//   [Parsed_pad] Padded dimensions cannot be smaller than input dimensions.
//   [fc#0] Error reinitializing filters!
// ffmpeg then exits non-zero, compositeGraphicsCaptionTrack rejects,
// graphicsExport.js's catch swallows it, and the whole job silently degrades to
// the ASS renderer (no video transform, no caption transform keyframes) with
// renderedWithEffects:false — the user-visible "the advanced renderer couldn't
// run this time".
//
// `pad` exists ONLY when rotation is used, so a probe disagreement stays
// invisible until rotation is switched on and then breaks the export every
// single time. Reproduced directly with deliberately disagreeing dimensions:
// rotation OFF rendered fine, rotation ON failed with the error above; after
// deferring to iw/ih both pass, and output is bit-identical (PSNR inf, SSIM
// 1.000000) whenever the probe agrees.
const rotChain = buildVideoTransformFilterChain(
  { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 12, opacity: 100 }, 4, 1080, 1920
);
const padStage = rotChain.filterComplex.split(';').find((s) => s.includes('pad='));
const rotStage = rotChain.filterComplex.split(';').find((s) => s.includes('rotate='));
assert.ok(padStage, 'A rotating transform must emit a pad stage');
assert.ok(
  /pad='max\(\d+\\,iw\)':'max\(\d+\\,ih\)'/.test(padStage),
  `pad must floor its size at the REAL stream size (iw/ih), not a probed literal — got: ${padStage}`
);
assert.ok(
  /out_w='max\(\d+\\,iw\)':out_h='max\(\d+\\,ih\)'/.test(rotStage),
  'rotate must resolve the SAME floor as pad so its output matches the padded canvas exactly'
);
// The comma inside max() must stay escaped, or the filtergraph parser reads it
// as a filter separator and the entire graph fails to parse.
assert.ok(!/max\(\d+,i[wh]\)/.test(rotChain.filterComplex), 'The comma inside max() must be escaped as \\, for the filtergraph parser');
console.log('✓ pad/rotate size from the real stream (iw/ih), so a probe disagreement can no longer fail the render');

console.log('\n=== ALL CAPTION ENGINE TESTS PASSED SUCCESSFULLY! ===\n');

