import { test, expect } from '@playwright/test';

// STRETCH AND CUT any clip with no source media of its own — text, a word put
// behind someone, an image, a shape — by dragging its ends, the way CapCut
// does. The handles used to be 7px, invisible and INSIDE the clip, so on a
// short clip (a word lifted out as an overlay lasts about half a second) both
// sat on top of each other and every grab moved the clip. Now a selected
// clip's handles sit just outside its edges.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* fine */ } return new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.waitForTimeout(400);
}

/** Drags a selected clip's end handle `dx` px to the right. */
async function dragHandle(page, clip, edge, dx) {
  await clip.click();
  const handle = clip.locator(`.timeline-text-clip-handle.${edge}`);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test('a half-second word overlay can be stretched from its end, and shortened from its start', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 2, text: 'BEHIND' }).id);
  // As short as a lifted word: 0.3s — a sliver on the lane.
  await page.evaluate((i) => window.__textElements.trimTextElement(i, 'end', 2.3), id);
  const clip = page.locator(`.timeline-text-clip[data-clip-id="${id}"]`);
  const width = (await clip.boundingBox()).width;
  console.log('clip width before:', width.toFixed(1), 'px');

  await dragHandle(page, clip, 'end', 220);
  let el = await page.evaluate((i) => window.__appState.textElements.find((e) => e.id === i), id);
  console.log('after stretching the end:', el.start, '→', el.end.toFixed(2));
  expect(el.start).toBeCloseTo(2, 2);   // the start did not move
  expect(el.end).toBeGreaterThan(3.5); // it lasts much longer now

  await dragHandle(page, clip, 'start', -60);
  el = await page.evaluate((i) => window.__appState.textElements.find((e) => e.id === i), id);
  expect(el.start).toBeLessThan(1.8);  // and it can start earlier too
});

test('a shape stretches the same way', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__shapeLayers.addShapeLayer('ellipse', { start: 4 }).id);
  await page.evaluate((i) => window.__shapeLayers.trimShapeLayer(i, 'end', 4.3), id);
  const clip = page.locator(`.timeline-text-clip[data-clip-id="${id}"]`);
  await dragHandle(page, clip, 'end', 200);
  const shape = await page.evaluate((i) => window.__appState.shapeLayers.find((s) => s.id === i), id);
  expect(shape.end).toBeGreaterThan(5.5);
});

test('S cuts a selected caption between its words', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const words = ['ONE', 'TWO', 'THREE', 'FOUR'].map((w, i) => ({ word: w, start: i * 0.6, end: i * 0.6 + 0.55, wordIndex: i }));
    const phrases = [{ start: 0, end: 2.35, words, breakAfterIndices: [] }];
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
  });
  const id = await page.evaluate(() => window.__appState.captionEvents[0].id);
  // Select it, THEN put the playhead where the cut goes (clicking a clip
  // moves the playhead to the click), then S.
  await page.locator(`.timeline-text-clip.is-transcript[data-clip-id="${id}"]`).click();
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 1.3; });
  await page.waitForTimeout(300);
  await page.keyboard.press('s');
  await expect.poll(() => page.evaluate(() => window.__appState.captionEvents.map((e) => e.wordIndices))).toEqual([[0, 1, 2], [3]]);
});
