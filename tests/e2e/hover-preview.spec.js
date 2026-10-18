import { test, expect } from '@playwright/test';

// Hovering an option previews it on the video; leaving reverts; clicking
// commits as ONE undo step. Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const WORDS = 'build public series reducing workloads'.split(' ');

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate((list) => {
    const words = list.map((w, i) => ({ word: w, start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.45, wordIndex: i, isKeyword: i === 1 || i === 4 }));
    window.__updateState({
      words, phrases: [{ start: 1, end: 3.5, words, breakAfterIndices: [] }], captionEvents: [],
      currentPreset: 'bold-yellow', enableKeywordHighlighting: true, animationMode: 'karaoke'
    }, { recordHistory: false });
  }, WORDS);
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(1);
  await page.evaluate(() => new Promise((res) => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(res)), { once: true });
    v.currentTime = 1.8;
  }));
}

const state = (page, key) => page.evaluate((k) => window.__appState[k], key);

test('hovering a casing previews it, leaving reverts, click commits with one undo', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Text', exact: true }).first().click();
  const before = await state(page, 'textCase');
  const target = before === 'lowercase' ? 'uppercase' : 'lowercase';
  const label = page.locator(`label:has(input[name="text-case"][value="${target}"])`);
  await label.scrollIntoViewIfNeeded();
  await label.hover();
  await expect.poll(() => state(page, 'textCase')).toBe(target);
  await page.mouse.move(5, 5);
  await expect.poll(() => state(page, 'textCase')).toBe(before);
  await label.click();
  await expect.poll(() => state(page, 'textCase')).toBe(target);
  await page.evaluate(() => document.querySelector('[title^="Undo"]')?.click());
  await expect.poll(() => state(page, 'textCase')).toBe(before);
});

test('hovering a font previews it; Escape reverts', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Text', exact: true }).first().click();
  const before = await state(page, 'fontFamily');
  await page.locator('#font-family-select-trigger').scrollIntoViewIfNeeded();
  await page.locator('#font-family-select-trigger').click();
  await page.locator('[data-hover-option="Anton"]').hover();
  await expect.poll(() => state(page, 'fontFamily')).toBe('Anton');
  await page.keyboard.press('Escape');
  await expect.poll(() => state(page, 'fontFamily')).toBe(before);
});
