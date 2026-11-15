import { test, expect } from '@playwright/test';
import { breakWordOutOfCaptionEvent } from '../../shared/captionEvent.js';
import { openTool } from './helpers/dock.js';

// BREAKING A WORD OUT OF ITS CAPTION — "Here's my new" where `new` should
// stand on its own rather than be shown with the rest of the phrase.
//
// The split engine (shared/captionEvent.js) and the store action both existed
// for caption events; nothing in the UI ever called them. A word in the MIDDLE
// needs two cuts, and doing those as two writes would cost two presses of
// Ctrl+Z — a half-undone edit — so the replacement set is written once.
//
// Hits :5173 explicitly: caption fonts come from the backend, whose CORS
// allowlist covers that port only. Requires the backend running.
const APP_URL = 'http://localhost:5173/?splash=0';

async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: "HERE'S", start: 0.0, end: 0.4 },
      { word: 'MY', start: 0.4, end: 0.8 },
      { word: 'NEW', start: 0.8, end: 1.3 }
    ].map((w, i) => ({ ...w, wordIndex: i }));
    const phrases = [{ start: 0, end: 1.3, breakAfterIndices: [], words }];
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);
  await page.waitForTimeout(300);
}

const captions = (page) => page.evaluate(() =>
  (window.__appState.captionEvents || []).map((e) => ({
    words: e.wordIndices.map((i) => window.__appState.words[i].word),
    start: Number(e.start.toFixed(2)),
    end: Number(e.end.toFixed(2))
  })));

/** Two-step drill-in: first click selects the caption, second the word. */
async function selectWord(page, wordIndex) {
  const frame = await page.locator('#preview-video').boundingBox();
  const rect = await page.evaluate((i) => window.__debugWordScreenRect(i), wordIndex);
  const pt = { x: frame.x + rect.centerX, y: frame.y + rect.centerY };
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(
    (i) => window.__debugGroupState().selectedWordIndex === i, wordIndex, { timeout: 10000 });
  await openTool(page, 'Word');
  await page.waitForTimeout(300);
}

test('the engine leaves the word alone, with the caption split around it', () => {
  const words = [
    { start: 0.0, end: 0.4 }, { start: 0.4, end: 0.8 }, { start: 0.8, end: 1.3 }
  ];
  const event = { id: 'c1', start: 0, end: 1.3, wordIndices: [0, 1, 2], breakAfterIndices: [] };

  // Last word: two captions, and the outer edges are untouched.
  const tail = breakWordOutOfCaptionEvent(event, 2, words);
  expect(tail.map((e) => e.wordIndices)).toEqual([[0, 1], [2]]);
  expect(tail[0].start).toBe(0);
  expect(tail[1].end).toBe(1.3);

  // Middle word: three, in order, still spanning the original.
  const middle = breakWordOutOfCaptionEvent(event, 1, words);
  expect(middle.map((e) => e.wordIndices)).toEqual([[0], [1], [2]]);
  expect(middle[0].start).toBe(0);
  expect(middle[2].end).toBe(1.3);

  // First word, and the no-op cases.
  expect(breakWordOutOfCaptionEvent(event, 0, words).map((e) => e.wordIndices)).toEqual([[0], [1, 2]]);
  expect(breakWordOutOfCaptionEvent(event, 7, words)).toBe(null);
  expect(breakWordOutOfCaptionEvent({ ...event, wordIndices: [2] }, 2, words)).toBe(null);
});

test("a caption's own line breaks survive being split around a word", () => {
  const words = [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }];
  // A manual line break after word 0 — inside the group that stays together.
  const event = { id: 'c1', start: 0, end: 4, wordIndices: [0, 1, 2, 3], breakAfterIndices: [0] };
  const parts = breakWordOutOfCaptionEvent(event, 3, words);
  expect(parts.map((e) => e.wordIndices)).toEqual([[0, 1, 2], [3]]);
  // Re-expressed against the shorter list, and still after the first word.
  expect(parts[0].breakAfterIndices).toEqual([0]);
});

test('breaking a word out through the real panel, and one Ctrl+Z puts it back', async ({ page }) => {
  await setup(page);
  expect(await captions(page)).toEqual([
    { words: ["HERE'S", 'MY', 'NEW'], start: 0, end: 1.3 }
  ]);

  await selectWord(page, 2);
  await page.locator('#word-break-out').click();
  await page.waitForTimeout(400);

  expect(await captions(page)).toEqual([
    { words: ["HERE'S", 'MY'], start: 0, end: 0.8 },
    { words: ['NEW'], start: 0.8, end: 1.3 }
  ]);

  // ONE undo, not two.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  expect(await captions(page)).toEqual([
    { words: ["HERE'S", 'MY', 'NEW'], start: 0, end: 1.3 }
  ]);
});

test('a middle word costs exactly one undo even though it takes two cuts', async ({ page }) => {
  await setup(page);
  await selectWord(page, 1);
  await page.locator('#word-break-out').click();
  await page.waitForTimeout(400);

  expect((await captions(page)).map((c) => c.words)).toEqual([["HERE'S"], ['MY'], ['NEW']]);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  expect((await captions(page)).map((c) => c.words)).toEqual([["HERE'S", 'MY', 'NEW']]);
});

test('a word that is already its own caption offers no break', async ({ page }) => {
  await setup(page);
  await selectWord(page, 2);
  await page.locator('#word-break-out').click();
  await page.waitForTimeout(400);

  // NEW now has a caption of its own, spanning 0.8-1.3s — so it is no longer
  // on screen at 0s at all. Having to move the playhead to find it IS the
  // feature working: it left the phrase.
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 1.0; });
  await page.waitForTimeout(400);
  await selectWord(page, 2);
  // Alone already — nothing left to break it out of.
  await expect(page.locator('#word-break-out')).toHaveCount(0);
});
