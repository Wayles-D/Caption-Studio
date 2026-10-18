import { test, expect } from '@playwright/test';

// A word inside a CINEMATIC / overlay text element — reported as "still
// doesn't work" with the panel cheerfully listing keyframe times.
//
// A text element's word overrides live on the ELEMENT (wordTransforms), keyed
// by its position within that element. The keyframe writers only ever knew
// about appState.captionTransforms, so the keyframe landed on whichever
// TRANSCRIPT word shared that index: a different word, on a different clip, at
// a different time. Hence a card sitting at 9.6s showing a pinned keyframe at
// 1.66s — the transcript word's start — and a font that never changed.
const APP_URL = 'http://localhost:5173/?splash=0';

async function pickOption(page, selector, value) {
  await page.locator(selector).click();
  await page.locator(`[data-hover-option="${value}"]`).click();
}

async function seekTo(page, t) {
  await page.evaluate((time) => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = time;
  }, t);
  await page.waitForTimeout(350);
}

// A transcript underneath, deliberately offset in time from the card, so a
// keyframe written to the wrong store shows up as an obviously wrong time.
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
      { word: 'EARLY', start: 1.6, end: 2.2, wordIndex: 0 },
      { word: 'WORDS', start: 2.2, end: 3, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 1.6, end: 3, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  const id = await page.evaluate(() => {
    const el = window.__textElements.addInterlude({ start: 8 });
    window.__textElements.updateTextElement(el.id, { text: 'A PROBLEM', end: 11 });
    window.__textElements.selectTextElement(el.id);
    return el.id;
  });
  await page.waitForTimeout(600);
  return id;
}

/** Clicks the element's second word on the video — the real route in. */
async function selectSecondWord(page, id) {
  const frame = await page.locator('#preview-video').boundingBox();
  const rects = await page.evaluate((i) => window.__debugTextWordRects(i), id);
  expect(rects.length).toBeGreaterThan(1);
  const w = rects[1];
  const pt = { x: frame.x + w.x + w.width / 2, y: frame.y + w.y + w.height / 2 };
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__debugSelectedTextWordIndex())).toBe(1);
}

test("a cinematic word's font keyframes on the element, at the element's own times", async ({ page }) => {
  const id = await setup(page);
  await seekTo(page, 8);
  await selectSecondWord(page, id);

  await page.locator('#word-fontFamily-kf-add').waitFor();
  await seekTo(page, 9.5);
  await page.locator('#word-fontFamily-kf-add').click();
  await page.waitForTimeout(300);

  // On the ELEMENT, not the transcript — and nowhere near the transcript's 1.6s.
  expect(await page.evaluate(() => window.__appState.captionTransforms)).toEqual({});
  const onElement = () => page.evaluate((i) =>
    (window.__textElements.getTextElement(i).wordTransforms?.w1?.keyframes || [])
      .map((k) => [k.t, k.values.fontFamily]).filter((e) => e[1]), id);
  const pinned = await onElement();
  expect(pinned.map((e) => e[0])).toEqual([8, 9.5]);
  await expect(page.locator('#word-fontFamily-kf-times')).toHaveText('8.00s, 9.50s');

  // The new font lands on the playhead keyframe only.
  await pickOption(page, '#word-font-select', 'Anton');
  await page.waitForTimeout(400);
  const after = await onElement();
  expect(after[0][1]).toBe(pinned[0][1]);
  expect(after[1]).toEqual([9.5, 'Anton']);
});

test('the cinematic word actually paints the keyframed font', async ({ page }) => {
  const id = await setup(page);
  await seekTo(page, 8);
  await selectSecondWord(page, id);
  await seekTo(page, 9.5);
  await page.locator('#word-fontFamily-kf-add').click();
  await page.waitForTimeout(250);
  await pickOption(page, '#word-font-select', 'Anton');
  await page.waitForFunction(() => document.fonts.check('40px Anton'));
  await page.waitForTimeout(900);

  // Text elements paint to their own layer.
  // An interlude paints an opaque white CARD, so counting drawn pixels just
  // counts the card. The letters are the dark pixels on it.
  const ink = () => page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 140) n++;
    }
    return n;
  });

  // Everything at ONE instant, so only the font differs.
  await seekTo(page, 10.2);
  const keyframed = await ink();

  const setWord = (style) => page.evaluate(([i, s]) =>
    window.__textElements.updateTextElement(i, { wordTransforms: s ? { w1: { style: s } } : {} }, { recordHistory: false }),
    [id, style]);

  await setWord(null);
  await page.waitForTimeout(600); await seekTo(page, 10.2);
  const inherited = await ink();

  await setWord({ fontFamily: 'Anton' });
  await page.waitForFunction(() => document.fonts.check('40px Anton'));
  await page.waitForTimeout(900); await seekTo(page, 10.2);
  const staticAnton = await ink();

  console.log('INK keyframed/inherited/staticAnton:', keyframed, inherited, staticAnton);
  expect(inherited).toBeGreaterThan(50);
  expect(Math.abs(staticAnton - inherited)).toBeGreaterThan(5);
  expect(keyframed).toBe(staticAnton);
});
