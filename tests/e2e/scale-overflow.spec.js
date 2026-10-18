import { test, expect } from '@playwright/test';

// "When text reaches the edge": scaling a keyword or a whole caption up used to
// push it past the edge of the frame, because the line-breaker never knew
// about the scale (it was applied at paint time, after the lines were broken).
// Stack (the default) tells the layout, so the text wraps onto another line;
// Keep leaves it on one line to run off the edge.
//
// Asserts the LAYOUT rects the renderer publishes (where each word is drawn),
// not just state — a setting that stored a value the renderer ignored would
// pass a state-only test and do nothing on screen.
//
// Hits :5173 explicitly: caption fonts come from the backend, whose CORS
// allowlist covers :5173 only. Requires `npm run dev:all`.
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

const set = async (page, patch) => {
  await page.evaluate((p) => window.__updateState(p, { recordHistory: false }), patch);
  await page.waitForTimeout(400);
};

/** Where the five words are DRAWN, as fractions of the frame width. Polls: the layout is published once the font has loaded. */
async function layout(page) {
  await expect.poll(() => page.evaluate(() => window.__debugWordScreenRect(0) != null), { timeout: 10000 }).toBe(true);
  return page.evaluate(() => {
    const frameW = document.getElementById('preview-video').getBoundingClientRect().width;
    const rects = [0, 1, 2, 3, 4].map((i) => window.__debugWordScreenRect(i)).filter(Boolean);
    return {
      lines: new Set(rects.map((r) => Math.round(r.y))).size,
      left: Math.min(...rects.map((r) => r.x)) / frameW,
      right: Math.max(...rects.map((r) => r.x + r.width)) / frameW
    };
  });
}

test('a scaled keyword stacks instead of running off the edge, unless you keep it on one line', async ({ page }) => {
  await setup(page);
  expect(await page.evaluate(() => window.__appState.scaleOverflow)).toBe('stack'); // the default

  // Nothing is different until you scale something.
  await set(page, { captionTransforms: {}, scaleOverflow: 'stack' });
  const plainStack = await layout(page);
  await set(page, { scaleOverflow: 'keep' });
  const plainKeep = await layout(page);
  expect(plainStack).toEqual(plainKeep);

  // Both keywords at 3x.
  const big = { w1: { fontScale: 3 }, w4: { fontScale: 3 } };
  await set(page, { captionTransforms: big, scaleOverflow: 'stack' });
  const stacked = await layout(page);
  expect(stacked.left).toBeGreaterThanOrEqual(-0.005);
  expect(stacked.right).toBeLessThanOrEqual(1.005);
  expect(stacked.lines).toBeGreaterThan(plainStack.lines); // it wrapped onto another line

  // 4x: the original report. Kept on a line, it reaches both edges.
  await set(page, { captionTransforms: { w1: { fontScale: 4 }, w4: { fontScale: 4 } }, scaleOverflow: 'keep' });
  const ink = await page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, x1 = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 40) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    return { touchesLeft: x0 <= 1, touchesRight: x1 >= c.width - 2 };
  });
  expect(ink.touchesLeft || ink.touchesRight).toBe(true);
});

test('a scaled-up phrase wraps to fit the frame, unless you keep it on one line', async ({ page }) => {
  await setup(page);
  // Phrase transform key is the phrase's start time in centiseconds.
  await set(page, { captionTransforms: { '100': { captionScaleMultiplier: 3 } }, scaleOverflow: 'keep' });
  const kept = await layout(page);
  await set(page, { scaleOverflow: 'stack' });
  const stacked = await layout(page);

  // The layout is then scaled as a whole, so the width that matters is layout x scale.
  const drawn = (l) => (l.right - l.left) * 3;
  expect(drawn(kept)).toBeGreaterThan(1.05);            // kept: wider than the frame
  expect(drawn(stacked)).toBeLessThanOrEqual(1.02);     // stacked: fits it
  expect(stacked.lines).toBeGreaterThan(kept.lines);
});

test('the selection box on a scaled keyword matches what is drawn, in both modes', async ({ page }) => {
  await setup(page);
  await set(page, { captionTransforms: { w1: { fontScale: 2 } }, scaleOverflow: 'keep' });
  await expect.poll(() => page.evaluate(() => window.__debugWordScreenRect(1) != null), { timeout: 10000 }).toBe(true);
  const kept = await page.evaluate(() => window.__debugWordScreenRect(1));
  await set(page, { scaleOverflow: 'stack' });
  const stacked = await page.evaluate(() => window.__debugWordScreenRect(1));
  // Stack widens the layout slot instead of scaling the glyphs afterwards; the
  // box must not count that scale twice (too wide) or leave out the height.
  expect(Math.abs(kept.width - stacked.width)).toBeLessThan(1.5);
  expect(Math.abs(kept.height - stacked.height)).toBeLessThan(1.5);
});

test('the choice is in the sidebar and changes the setting', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Position', exact: true }).click();
  const keep = page.locator('input[name="scale-overflow"][value="keep"]');
  await expect(keep).toBeAttached();
  await keep.check({ force: true });
  expect(await page.evaluate(() => window.__appState.scaleOverflow)).toBe('keep');
  await page.locator('input[name="scale-overflow"][value="stack"]').check({ force: true });
  expect(await page.evaluate(() => window.__appState.scaleOverflow)).toBe('stack');
});
