import { test, expect } from '@playwright/test';

// Regression test for the caption-keyframe mis-targeting bug fixed in commit
// 9df9d32 (see private-notes/keyframe-and-export-parity-journey.md and
// canvasTransform.js's explicitCaptionSelectionKey doc comment): selecting a
// caption, adding a keyframe, scrubbing the playhead to where a DIFFERENT
// caption is on screen, and adding a second keyframe used to silently write
// the second point onto the new caption instead of the originally-selected
// one. This test reproduces that exact sequence and asserts the pin holds.
//
// Uses the DEV-only window.__appState/__updateState/__debug* hooks (see
// App.jsx and canvasTransform.js) to inject a deterministic two-caption
// transcript instead of depending on real Whisper transcription.

test('caption keyframe target stays pinned after scrubbing to a different caption', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Try Demo Video').click();

  const duration = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration && !Number.isNaN(v.duration) && v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
  expect(duration).toBeGreaterThan(4);

  const phraseAStart = 0;
  const phraseAEnd = Math.min(1.5, duration * 0.3);
  const phraseBStart = duration * 0.6;
  const phraseBEnd = phraseBStart + 1.5;

  await page.evaluate(({ phraseAStart, phraseAEnd, phraseBStart, phraseBEnd }) => {
    const words = [
      { word: 'HELLO', start: phraseAStart, end: phraseAStart + 0.4, wordIndex: 0 },
      { word: 'THERE', start: phraseAStart + 0.5, end: phraseAEnd, wordIndex: 1 },
      { word: 'GENERAL', start: phraseBStart, end: phraseBStart + 0.4, wordIndex: 2 },
      { word: 'KENOBI', start: phraseBStart + 0.5, end: phraseBEnd, wordIndex: 3 },
    ];
    const phrases = [
      { start: phraseAStart, end: phraseAEnd, words: words.slice(0, 2), breakAfterIndices: [] },
      { start: phraseBStart, end: phraseBEnd, words: words.slice(2, 4), breakAfterIndices: [] },
    ];
    window.__updateState({ words, phrases }, { recordHistory: false });
  }, { phraseAStart, phraseAEnd, phraseBStart, phraseBEnd });

  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);

  // Click the caption's padding (not a specific word) to select it as a
  // whole — the pinnable "caption" keyframe target kind.
  // #preview-video, not .phone-frame — the app's coordinate math is relative
  // to the actual rendering surface, inset inside .phone-frame's 4px border.
  const frameBox = await page.locator('#preview-video').boundingBox();
  const captionRect = await page.evaluate(() => window.__debugCaptionBoxRect());
  await page.mouse.click(frameBox.x + captionRect.centerX, frameBox.y + captionRect.centerY);

  const pinAfterSelect = await page.evaluate(() => window.__debugKeyframePin());
  expect(pinAfterSelect.explicitCaptionSelectionKey).not.toBeNull();
  expect(pinAfterSelect.resolvedTarget?.kind).toBe('caption');

  await page.click('#timeline-add-keyframe-btn');

  // Scrub to where caption B is on screen — currentBox genuinely follows
  // playback (that part is correct/intended), but the keyframe TARGET must not.
  await page.evaluate((t) => { document.getElementById('preview-video').currentTime = t; }, phraseBStart + 0.1);
  await page.waitForFunction(
    (key) => window.__debugKeyframePin().currentBoxPhraseKey !== key,
    pinAfterSelect.explicitCaptionSelectionKey
  );

  const pinAfterScrub = await page.evaluate(() => window.__debugKeyframePin());
  expect(pinAfterScrub.currentBoxPhraseKey).not.toBe(pinAfterScrub.explicitCaptionSelectionKey);
  expect(pinAfterScrub.explicitCaptionSelectionKey).toBe(pinAfterSelect.explicitCaptionSelectionKey);
  expect(pinAfterScrub.resolvedTarget?.phrase?.start).toBe(phraseAStart);

  await page.click('#timeline-add-keyframe-btn');

  const transforms = await page.evaluate(() => window.__appState.captionTransforms);
  const keyA = pinAfterSelect.explicitCaptionSelectionKey;
  const keyB = String(Math.round(phraseBStart * 100));

  expect(transforms[keyB]).toBeFalsy();
  expect(transforms[keyA]?.keyframes?.length).toBe(2);
});
