import { test, expect } from '@playwright/test';

// "Blend Applies To: Keywords only" — the keywords sit on a canvas of their own
// that carries the blend mode; the other words stay on the unblended captions
// canvas. Requires `npm run dev:all`.
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
      currentPreset: 'bold-yellow', enableKeywordHighlighting: true, animationMode: 'karaoke', textBlendMode: 'difference'
    }, { recordHistory: false });
  }, WORDS);
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(1);
  await page.evaluate(() => new Promise((res) => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.addEventListener('seeked', () => requestAnimationFrame(() => requestAnimationFrame(res)), { once: true });
    v.currentTime = 3.2;
  }));
}

const info = (page) => page.evaluate(() => {
  const px = (c) => {
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
  const main = document.getElementById('captions-canvas');
  const kw = document.getElementById('captions-keyword-canvas');
  return {
    mainBlend: main.style.mixBlendMode, kwBlend: kw.style.mixBlendMode,
    kwActive: kw.classList.contains('active'), mainPx: px(main), kwPx: px(kw)
  };
});

test('keywords only: keywords on their own blended canvas, other words unblended', async ({ page }) => {
  await setup(page);
  let i = await info(page);
  expect(i.mainBlend).toBe('difference'); // All text: one blended canvas
  expect(i.kwActive).toBe(false);

  await page.evaluate(() => window.__updateState({ blendScope: 'keywords' }, { recordHistory: false }));
  await expect.poll(async () => (await info(page)).kwActive).toBe(true);
  i = await info(page);
  expect(i.mainBlend).toBe('');
  expect(i.kwBlend).toBe('difference');
  expect(i.kwPx).toBeGreaterThan(0);
  expect(i.mainPx).toBeGreaterThan(0);

  await page.evaluate(() => window.__updateState({ blendScope: 'all' }, { recordHistory: false }));
  await expect.poll(async () => (await info(page)).kwActive).toBe(false);
  expect((await info(page)).mainBlend).toBe('difference');
});
