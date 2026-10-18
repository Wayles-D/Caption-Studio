import { test, expect } from '@playwright/test';
import { countSyllables, syllableTimes } from '../../shared/syllables.js';

// ONE SOUND PER SYLLABLE (shared/syllables.js): press a transcript word's ♪,
// tick "One per syllable", pick a short dry sound, and a copy lands on each
// syllable across that word's own stretch of time.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(400);
}

test('the syllable counter matches what people would say', () => {
  const expected = { syllabic: 3, wahala: 3, time: 1, table: 2, walked: 1, wanted: 2, wishes: 2, makes: 1, beautiful: 3, everything: 4, I: 1 };
  Object.entries(expected).forEach(([word, n]) => expect(countSyllables(word), word).toBe(n));
  // Spread across the word, the last one kept inside it.
  const times = syllableTimes({ start: 1, end: 1.8 }, 3);
  expect(times.length).toBe(3);
  expect(times[0]).toBeCloseTo(1, 3);
  expect(times[2]).toBeLessThan(1.8);
  expect(times[1]).toBeGreaterThan(times[0]);
  // A one-syllable word is simply its start.
  expect(syllableTimes({ start: 2, end: 2.4 }, 1)).toEqual([2]);
});

test('placing one sound per syllable of a word lands one clip per syllable, inside the word', async ({ page }) => {
  await openDemo(page);
  const word = { text: 'syllabic', start: 2, end: 2.9 };
  const made = await page.evaluate((w) => window.__audioTimeline.addSyllableSounds('micro-tick-soft', w).map((e) => e.startTime), word);
  expect(made.length).toBe(3);
  expect(made[0]).toBeCloseTo(2, 2);
  made.forEach((t) => { expect(t).toBeGreaterThanOrEqual(2); expect(t).toBeLessThan(2.9); });
  // Strictly in order, and spread out.
  expect(made[1]).toBeGreaterThan(made[0]);
  expect(made[2]).toBeGreaterThan(made[1]);

  // They are ordinary sound effects: trimmable, and all removed by one Undo.
  const all = await page.evaluate(() => window.__audioTimeline.getSoundEvents().length);
  expect(all).toBe(3);
  await page.locator('#timeline-undo-btn').click();
  await expect.poll(() => page.evaluate(() => window.__audioTimeline.getSoundEvents().length)).toBe(0);

  // An explicit count overrides the guess — the counter can't always be right.
  const five = await page.evaluate((w) => window.__audioTimeline.addSyllableSounds('micro-tick-soft', w, 5).length, word);
  expect(five).toBe(5);
});

test('a transcript word offers the per-syllable option in the sound library', async ({ page }) => {
  await openDemo(page);
  // The demo has a transcript; open it and use a word's ♪.
  await page.evaluate(() => {
    const w = (window.__appState.words || [])[0];
    if (w) window.dispatchEvent(new CustomEvent('bhynd:add-sound-at', { detail: { word: w } }));
  });
  await page.waitForTimeout(600);
  const hasWords = await page.evaluate(() => (window.__appState.words || []).length > 0);
  test.skip(!hasWords, 'the demo project has no transcript words in this run');
  await expect(page.locator('#sfx-syllable-mode')).toHaveCount(1);
  await page.locator('#sfx-syllable-toggle').check();
  await expect(page.locator('#sfx-syllable-count')).toBeVisible();
  const shown = Number(await page.locator('#sfx-syllable-count').innerText());
  await page.locator('#sfx-syllable-more').click();
  expect(Number(await page.locator('#sfx-syllable-count').innerText())).toBe(shown + 1);
});
