import { test, expect } from '@playwright/test';
import { openTool } from './helpers/dock.js';

// THE TRANSCRIPT READS LIKE TEXT, AND IS SEARCHABLE.
//  - No buttons beside every word: just the words. A word's options (keyword,
//    sound, case, hide) appear in ONE bar above the word that is clicked.
//  - The search is focused the moment the transcript opens — just type.
//    Matches are marked; the current one is put on the video with its
//    options open; Enter goes to the next, Shift+Enter back, Esc clears.
const APP_URL = 'http://localhost:5173/?splash=0';
const TEXT = 'so this is how we edit and this is where we search for this word';

async function load(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* fine */ } return new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.evaluate((text) => {
    const words = text.split(' ').map((w, i) => ({ word: w, start: i * 0.6, end: i * 0.6 + 0.5, wordIndex: i }));
    const phrases = [];
    for (let i = 0; i < words.length; i += 4) phrases.push({ start: words[i].start, end: words[Math.min(i + 3, words.length - 1)].end, words: words.slice(i, i + 4), breakAfterIndices: [] });
    window.__updateState({ words, phrases, soundEvents: [] }, { recordHistory: false });
  }, TEXT);
  await openTool(page, 'Transcript');
  await expect(page.locator('.word-chip')).toHaveCount(TEXT.split(' ').length);
}

test('just the words — no per-word buttons; a click opens that word\'s options above it', async ({ page }) => {
  await load(page);
  // Nothing but words in the text.
  await expect(page.locator('#transcript-words-container button')).toHaveCount(0);
  await expect(page.locator('#word-actions')).toBeHidden();

  const word = page.locator('#transcript-words-container .word-chip[data-index="3"]');
  await word.click();
  const bar = page.locator('#word-actions');
  await expect(bar).toBeVisible();
  for (const a of ['keyword', 'sound', 'case', 'hide']) await expect(bar.locator(`[data-word-action="${a}"]`)).toBeVisible();
  // Above the word it belongs to.
  const w = await word.boundingBox();
  const b = await bar.boundingBox();
  expect(b.y + b.height).toBeLessThanOrEqual(w.y + 1);

  // An option works from the bar, and the word shows it quietly.
  await bar.locator('[data-word-action="keyword"]').click();
  await expect(page.locator('#transcript-words-container .word-chip[data-index="3"]')).toHaveClass(/word-chip-keyword/);
  expect(await page.evaluate(() => window.__appState.words[3].isKeyword)).toBe(true);
  // The bar survives the rebuild a keyword causes, still on its word.
  await expect(bar).toBeVisible();
  await expect(bar.locator('[data-word-action="keyword"]')).toHaveClass(/active/);

  // Clicking away puts it away.
  await page.locator('#preview-video').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
  await page.mouse.click(700, 30);
  await expect(bar).toBeHidden();
});

test('the search is ready the moment the transcript opens: type, and Enter walks the matches', async ({ page }) => {
  await load(page);
  const search = page.locator('#transcript-search');
  await expect(search).toBeFocused();

  await page.keyboard.type('this');
  // "this" appears three times.
  await expect(page.locator('#transcript-search-count')).toHaveText('1 of 3');
  await expect(page.locator('.word-chip.is-match')).toHaveCount(3);
  const current = () => page.evaluate(() => Number(document.querySelector('.word-chip.is-current')?.dataset.index));
  expect(await current()).toBe(1);
  // Its options are open, the video is on it, and typing still goes to the search.
  await expect(page.locator('#word-actions')).toBeVisible();
  const t = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  expect(t).toBeGreaterThan(0.6);
  expect(t).toBeLessThan(1.1);
  await expect(search).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('#transcript-search-count')).toHaveText('2 of 3');
  expect(await current()).toBe(7);
  await page.keyboard.press('Enter');
  expect(await current()).toBe(13);
  await page.keyboard.press('Enter');
  expect(await current()).toBe(1); // round again
  await page.keyboard.press('Shift+Enter');
  expect(await current()).toBe(13);

  // The current match's Sound option places a sound on THAT word.
  await page.locator('#word-actions [data-word-action="sound"]').click();
  await expect(page.locator('#sound-library-panel')).toBeVisible();

  // A phrase is found too; Esc clears.
  await search.fill('we search');
  await expect(page.locator('#transcript-search-count')).toHaveText('1 of 1');
  await expect(page.locator('.word-chip.is-match')).toHaveCount(2);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.locator('.word-chip.is-match')).toHaveCount(0);

  await search.fill('zebra');
  await expect(page.locator('#transcript-search-count')).toHaveText('No matches');
});
