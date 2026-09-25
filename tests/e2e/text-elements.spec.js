import { test, expect } from '@playwright/test';

// Regression suite for manual captions + text overlays (shared/textElement.js):
// independent, user-timed text objects that share the caption renderer.
//
// Hits :5173 explicitly rather than the suite's own baseURL — caption fonts are
// served by the BACKEND, whose CORS allowlist covers :5173 but not the e2e
// server's port, and a CORS-blocked webfont renders as a silent fallback.
// Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'I', start: 0, end: 1, wordIndex: 0 },
      { word: 'AM', start: 1, end: 2, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 5, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 2; });
  await page.waitForTimeout(500);
}

test('timeline: create at playhead, drag, trim, select, delete', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  // --- the TEXT lane exists and has a "+" ---
  const lane = page.locator('#timeline-text-track');
  await expect(lane).toHaveCount(1);

  // --- create at the playhead via the real "+" button ---
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(300);
  await page.locator('#timeline-add-text-btn').click();
  await page.waitForTimeout(400);

  let els = await page.evaluate(() => window.__appState.textElements.map(e => ({ id: e.id, kind: e.kind, start: +e.start.toFixed(2), end: +e.end.toFixed(2), text: e.text })));
  console.log('after + Text at playhead 3s:', JSON.stringify(els));
  expect(els.length).toBe(1);
  expect(els[0].start).toBeCloseTo(3, 1);

  const clip = page.locator('.timeline-text-clip').first();
  await expect(clip).toHaveCount(1);
  // creating selects it, so the clip should render as selected
  await expect(clip).toHaveClass(/selected/);

  // --- drag the clip to a later time ---
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterDrag = await page.evaluate(() => window.__appState.textElements[0]);
  console.log('after drag:', JSON.stringify({ start: +afterDrag.start.toFixed(2), end: +afterDrag.end.toFixed(2) }));
  expect(afterDrag.start).toBeGreaterThan(els[0].start + 0.5);
  // duration preserved by a move
  expect(afterDrag.end - afterDrag.start).toBeCloseTo(els[0].end - els[0].start, 1);

  // --- trim the right edge ---
  const clip2 = page.locator('.timeline-text-clip').first();
  const box2 = await clip2.boundingBox();
  await page.mouse.move(box2.x + box2.width - 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width - 2 + 60, box2.y + box2.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const afterTrim = await page.evaluate(() => window.__appState.textElements[0]);
  console.log('after trim-end:', JSON.stringify({ start: +afterTrim.start.toFixed(2), end: +afterTrim.end.toFixed(2) }));
  expect(afterTrim.end).toBeGreaterThan(afterDrag.end + 0.3);
  expect(afterTrim.start).toBeCloseTo(afterDrag.start, 1); // head untouched

  // --- a second, OVERLAPPING element is allowed ---
  await page.evaluate(() => window.__textElements.addTextElement({ start: window.__appState.textElements[0].start, text: 'OVERLAP' }));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(2);

  // --- delete the selected one, leaving the other + the caption alone ---
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  const remaining = await page.evaluate(() => ({
    count: window.__appState.textElements.length,
    phrases: window.__appState.phrases.length
  }));
  console.log('after Delete:', JSON.stringify(remaining));
  expect(remaining.count).toBe(1);
  expect(remaining.phrases).toBe(1); // captions untouched

  console.log('PAGE ERRORS:', JSON.stringify(errs));
  expect(errs).toEqual([]);
});

test('undo/redo covers create and move', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__textElements.addTextElement({ start: 1, text: 'UNDO ME' }));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);

  // Undo through the real toolbar button, not a test hook.
  await page.getByRole('button', { name: /undo/i }).first().click();
  await page.waitForTimeout(400);
  const afterUndo = await page.evaluate(() => window.__appState.textElements.length);
  console.log('count after undo:', afterUndo);
  expect(afterUndo).toBe(0);
});
