import { test, expect } from '@playwright/test';

// Regression test for per-word caption styling (the Word panel —
// src/components/WordInspector.jsx), covering the two bugs that made the
// feature look completely dead on first release:
//
//  1. A per-word FONT was written to state correctly but never rendered: the
//     canvas paints synchronously with ctx.font, and a webfont the browser
//     hasn't finished loading silently falls back instead of erroring. Nothing
//     re-drew once the face landed, so on a paused video the fallback stayed
//     forever. Fixed by ensureWordStyleFontsReady in preview.js (load, then
//     syncVideoSubtitles on first load) — the same treatment the caption's own
//     base font already got.
//  2. A per-word COLOUR silently reverted: ColorPickerField restores its
//     open-time snapshot on any close that isn't the Apply button, and for a
//     word with no colour of its own that snapshot is just the swatch's
//     display fallback — so picking a colour and clicking away wrote the
//     fallback back. Fixed by WordColorField, which commits on close.
//
// NOTE: this test hits http://localhost:5173 explicitly rather than the suite's
// own baseURL. Caption fonts are served by the BACKEND, whose CORS allowlist
// covers :5173 but not the e2e server's port — a webfont blocked by CORS
// cannot render, which would make assertion 1 fail for a reason that has
// nothing to do with the code under test. Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setupTwoWordCaption(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration && !Number.isNaN(v.duration) && v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'ONE', start: 0, end: 1, wordIndex: 0 },
      { word: 'TWO', start: 1, end: 2, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 2, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);
}

/** Pixel census of the caption canvas: how much is drawn, and how much is red. */
function canvasStats(page) {
  return page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let drawn = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) { drawn++; if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++; }
    }
    return { drawn, red };
  });
}

/** Two-step CapCut-style drill-in: first click selects the caption, second the word. */
async function selectWordZero(page) {
  const frameBox = await page.locator('#preview-video').boundingBox();
  const rect = await page.evaluate(() => window.__debugWordScreenRect(0));
  const pt = { x: frameBox.x + rect.centerX, y: frameBox.y + rect.centerY };
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  expect((await page.evaluate(() => window.__debugGroupState())).selectedWordIndex).toBe(0);
  await page.getByRole('button', { name: 'Word', exact: true }).click();
  await page.waitForTimeout(300);
}

test('a per-word colour survives dismissing the picker without Apply', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  const before = await canvasStats(page);
  expect(before.red).toBe(0);

  await page.locator('#word-color-0').click();
  await page.waitForTimeout(250);
  const hexInput = page.locator('input[value*="#"], input[placeholder*="#"]').first();
  await hexInput.fill('#FF0000');
  await hexInput.press('Enter');
  await page.waitForTimeout(200);
  // Dismiss by clicking elsewhere — NOT the Apply button.
  await page.getByText('TYPEFACE').click({ force: true });
  await page.waitForTimeout(600);

  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.color)).toBe('#FF0000');
  const after = await canvasStats(page);
  expect(after.red).toBeGreaterThan(10);
});

test('a per-word font actually renders once its face loads', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  const before = await canvasStats(page);
  await page.locator('#word-font-select').selectOption('Pacifico');
  // Deliberately does NOT touch the video: the point of the fix is that the
  // canvas redraws itself when the face finishes loading, with no playback.
  await page.waitForTimeout(1500);
  const after = await canvasStats(page);

  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.fontFamily)).toBe('Pacifico');
  // Pacifico is a script face — swapping into it must visibly change how many
  // pixels the caption covers. An unloaded font silently falls back instead,
  // which is what this guards against.
  expect(Math.abs(after.drawn - before.drawn)).toBeGreaterThan(8);
});

test('per-word italic and underline render, and only on that word', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  const before = await canvasStats(page);

  await page.getByTitle('Italic').click();
  await page.waitForTimeout(500);
  const afterItalic = await canvasStats(page);
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.italic)).toBe(true);

  await page.getByTitle('Underline').click();
  await page.waitForTimeout(500);
  const afterUnderline = await canvasStats(page);
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.underline)).toBe(true);

  // An underline is extra drawn pixels on top of whatever italic did.
  expect(afterUnderline.drawn).toBeGreaterThan(afterItalic.drawn);
  // The second word must be untouched throughout.
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w1)).toBeUndefined();
  expect(before.drawn).toBeGreaterThan(0);
});

test('Reset to caption style clears the override', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  await page.getByTitle('Underline').click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.underline)).toBe(true);

  await page.getByRole('button', { name: 'Reset to caption style' }).click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style)).toBeUndefined();
});
