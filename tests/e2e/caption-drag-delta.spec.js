import { test, expect } from '@playwright/test';

test('dragging the whole caption is delta-based, not a snap to the cursor', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Try Demo Video').click();

  await page.evaluate(() => {
    const words = [
      { word: 'ONE', start: 0, end: 1, wordIndex: 0 },
      { word: 'TWO', start: 1, end: 2, wordIndex: 1 },
    ];
    const phrases = [{ start: 0, end: 2, words, breakAfterIndices: [] }];
    window.__updateState({ words, phrases }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);

  // #preview-video, not .phone-frame — the app's own coordinate math
  // (src/js/utils/canvasGeometry.js's getCanvasContentRect) is relative to
  // the actual rendering surface, which sits inset inside .phone-frame's 4px
  // CSS border; .phone-frame's own boundingBox would be off by that border.
  const frameBox = await page.locator('#preview-video').boundingBox();
  const captionRect = await page.evaluate(() => window.__debugCaptionBoxRect());
  const word0 = await page.evaluate(() => window.__debugWordScreenRect(0));
  const word1 = await page.evaluate(() => window.__debugWordScreenRect(1));

  // Click in the gap BETWEEN the two words (the caption's own dead zone for
  // "select the whole caption, not a word" — see findWordAtPoint's doc
  // comment) so this grabs the caption as a whole, not either word, while
  // still landing away from the anchor point and clear of any corner
  // resize/rotate handle — the scenario that exposes an absolute-snap bug:
  // grabbing an object away from its own anchor point.
  const grabX = frameBox.x + (word0.centerX + word0.width / 2 + word1.centerX - word1.width / 2) / 2;
  const grabY = frameBox.y + captionRect.centerY;

  await page.mouse.click(grabX, grabY);
  const pin = await page.evaluate(() => window.__debugKeyframePin());
  expect(pin.resolvedTarget?.kind).toBe('caption');

  const beforeDrag = await page.evaluate(() => window.__debugCaptionBoxRect());

  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  // A small, deliberate 15px move — the bug this checks for is an absolute
  // snap-to-cursor, which would jump the caption by roughly the
  // grab-point-to-anchor distance (tens of px here) on the very FIRST move
  // event, not by the actual 15px dragged.
  await page.mouse.move(grabX + 15, grabY, { steps: 3 });
  await page.mouse.up();

  const afterDrag = await page.evaluate(() => window.__debugCaptionBoxRect());
  const movedBy = afterDrag.centerX - beforeDrag.centerX;
  console.log('grabX-anchorX distance:', grabX - (frameBox.x + beforeDrag.centerX), 'movedBy:', movedBy);
  expect(movedBy).toBeGreaterThan(5);
  expect(movedBy).toBeLessThan(30);
});
