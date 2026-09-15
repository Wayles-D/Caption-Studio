import { test, expect } from '@playwright/test';

// Regression test for the "visual caption vs interaction container desync"
// bug in src/js/components/canvasTransform.js's findWordAtPoint: dragging a
// word wrote its new position (offsetXPx/offsetYPx, applied at paint time by
// shared/captionGraphics.js's paintSentenceComposite) but hit-testing kept
// comparing clicks against the word's ORIGINAL, un-offset layout rect — so
// clicking the word's new, visible position missed, while its old, now-empty
// position still selected it. Fixed by routing findWordAtPoint's candidates
// through wordBoxFor (the same resolved geometry the selection box already
// follows) before testing.
//
// Uses the DEV-only window.__appState/__updateState/__debug* hooks (see
// App.jsx and canvasTransform.js) to set up a deterministic two-word phrase
// and read exact screen coordinates instead of guessing layout.

test('dragging a word moves its clickable hit area, not just its pixels', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Try Demo Video').click();

  const duration = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration && !Number.isNaN(v.duration) && v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
  expect(duration).toBeGreaterThan(2);

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

  // #preview-video, not .phone-frame — the app's coordinate math is relative
  // to the actual rendering surface, inset inside .phone-frame's 4px border.
  const frameBox = await page.locator('#preview-video').boundingBox();
  const toPage = (rect) => ({ x: frameBox.x + rect.centerX, y: frameBox.y + rect.centerY });

  // Two-step selection (see canvasTransform.js's hitAreaEl pointerdown
  // handler doc comment): a first click on a word whose group isn't already
  // on screen selects the whole caption/group; a second click on the SAME
  // word drills into word-level selection.
  const word0Raw = await page.evaluate(() => window.__debugWordScreenRect(0));
  const word0RawPage = toPage(word0Raw);
  await page.mouse.click(word0RawPage.x, word0RawPage.y);
  await page.mouse.click(word0RawPage.x, word0RawPage.y);

  let groupState = await page.evaluate(() => window.__debugGroupState());
  expect(groupState.selectedWordIndex).toBe(0);

  // Drag word 0 to the right by 80 CSS px in several steps (a real gesture,
  // not a single teleport) — writes offsetXPx via canvasTransform.js's
  // onPointerMove 'move' branch.
  await page.mouse.move(word0RawPage.x, word0RawPage.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(word0RawPage.x + i * 20, word0RawPage.y, { steps: 2 });
  }
  await page.mouse.up();

  const word0Moved = await page.evaluate(() => window.__debugWordScreenRect(0));
  expect(word0Moved.centerX).toBeGreaterThan(word0Raw.centerX + 60);

  const captionRect = await page.evaluate(() => window.__debugCaptionBoxRect());
  const deselectPoint = { x: frameBox.x + captionRect.centerX, y: frameBox.y + Math.max(20, captionRect.centerY - captionRect.height) };

  // Deselect by clicking clearly outside the caption's bounding box (well
  // above it, same horizontal center so it's still inside hitAreaEl/the
  // phone-frame).
  await page.mouse.click(deselectPoint.x, deselectPoint.y);
  groupState = await page.evaluate(() => window.__debugGroupState());
  expect(groupState.selectedWordIndex).toBeNull();

  // Clicking the word's OLD (pre-drag) position must NOT select it anymore —
  // it's no longer where the word actually is.
  await page.mouse.click(word0RawPage.x, word0RawPage.y);
  groupState = await page.evaluate(() => window.__debugGroupState());
  expect(groupState.selectedWordIndex).not.toBe(0);

  // Deselect again, then click the word's NEW (post-drag) position — this
  // must select it (two-step: group, then the word itself).
  await page.mouse.click(deselectPoint.x, deselectPoint.y);
  const word0MovedPage = toPage(word0Moved);
  await page.mouse.click(word0MovedPage.x, word0MovedPage.y);
  await page.mouse.click(word0MovedPage.x, word0MovedPage.y);
  groupState = await page.evaluate(() => window.__debugGroupState());
  expect(groupState.selectedWordIndex).toBe(0);
});
