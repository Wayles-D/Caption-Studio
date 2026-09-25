import { test, expect } from '@playwright/test';

// Phase 3 — manual captions: the `kind: 'caption'` half of
// shared/textElement.js.
//
// Same record, same renderer, same gestures as a text overlay — they differ
// in what they MEAN, not in what they can do. So this is about presentation
// and defaults: a caption you timed yourself belongs on its own lane next to
// the transcript, is labelled as a caption, and lands where your captions
// sit rather than mid-frame like an overlay.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
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
    const words = [{ word: 'TRANSCRIPT', start: 0, end: 9, wordIndex: 0 }];
    window.__updateState({ words, phrases: [{ start: 0, end: 9, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(600);
}

const elements = (page) => page.evaluate(() => window.__appState.textElements);

/** Centroid of the overlay layer's ink, in canvas pixels. */
const textLayerCentroid = (page) => page.evaluate(() => {
  const c = document.getElementById('text-elements-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 40) { const p = i / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
  }
  return n ? { drawn: n, cx: sx / n, cy: sy / n, h: c.height } : null;
});

/** Same for the transcript caption's own layer. */
const captionLayerCentroid = (page) => page.evaluate(() => {
  const c = document.getElementById('captions-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 40) { const p = i / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
  }
  return n ? { drawn: n, cx: sx / n, cy: sy / n } : null;
});

test('the Captions lane exists and its "+" creates a manual caption there', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const captionsTrack = page.locator('#timeline-captions-track');
  const textTrack = page.locator('#timeline-text-track');
  await expect(captionsTrack).toHaveCount(1);
  await expect(textTrack).toHaveCount(1);
  // Its own add control, inside the strip like every other lane's.
  await expect(page.locator('#timeline-add-captions-btn')).toHaveCount(1);

  await page.locator('#timeline-add-captions-btn').click();
  await page.waitForTimeout(500);

  const els = await elements(page);
  console.log('after + Caption:', JSON.stringify(els.map((e) => ({ kind: e.kind, start: +e.start.toFixed(2), style: e.style }))));
  expect(els.length).toBe(1);
  expect(els[0].kind).toBe('caption');
  expect(els[0].start).toBeCloseTo(3, 1);

  // It lives on the CAPTIONS strip, and the Text strip is still empty.
  await expect(captionsTrack.locator('.timeline-text-clip')).toHaveCount(1);
  await expect(textTrack.locator('.timeline-text-clip')).toHaveCount(0);
  // ...and reads as a caption rather than an overlay.
  await expect(captionsTrack.locator('.timeline-text-clip')).toHaveClass(/is-caption/);
  // Creating it selects it, so the panel is already pointed at it.
  await expect(captionsTrack.locator('.timeline-text-clip')).toHaveClass(/selected/);

  expect(errs).toEqual([]);
});

test('each kind goes to its own lane and neither takes the other', async ({ page }) => {
  await setup(page);

  await page.locator('#timeline-add-captions-btn').click();
  await page.waitForTimeout(400);
  await page.locator('#timeline-add-text-btn').click();
  await page.waitForTimeout(500);

  const els = await elements(page);
  expect(els.length).toBe(2);
  const kinds = els.map((e) => e.kind).sort();
  expect(kinds).toEqual(['caption', 'overlay']);

  await expect(page.locator('#timeline-captions-track .timeline-text-clip')).toHaveCount(1);
  await expect(page.locator('#timeline-text-track .timeline-text-clip')).toHaveCount(1);
  // The overlay clip is NOT marked as a caption.
  await expect(page.locator('#timeline-text-track .timeline-text-clip')).not.toHaveClass(/is-caption/);
});

test('a manual caption lands where your captions sit, an overlay lands mid-frame', async ({ page }) => {
  await setup(page);

  // Where does the TRANSCRIPT caption actually sit? That's the target.
  const transcript = await captionLayerCentroid(page);
  expect(transcript).not.toBeNull();

  // --- manual caption: seeds no placement at all, so it inherits ---
  await page.locator('#timeline-add-captions-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    window.__textElements.updateTextElement(el.id, { text: 'MANUAL' });
  });
  await page.waitForTimeout(700);

  const caption = await elements(page);
  // The whole point: nothing seeded, so it follows the caption style.
  expect(caption[0].style.position).toBeUndefined();
  expect(caption[0].style.customPosX).toBeUndefined();
  expect(caption[0].style.customPosY).toBeUndefined();

  const capInk = await textLayerCentroid(page);
  console.log('transcript caption cy', transcript.cy.toFixed(1), '| manual caption cy', capInk.cy.toFixed(1), '| canvas h', capInk.h);
  // It renders at the caption's own vertical band, not the middle of frame.
  expect(Math.abs(capInk.cy - transcript.cy)).toBeLessThan(capInk.h * 0.12);

  // --- overlay: seeded manual at centre ---
  await page.evaluate(() => window.__textElements.removeTextElement(window.__appState.textElements[0].id));
  await page.waitForTimeout(300);
  await page.locator('#timeline-add-text-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    window.__textElements.updateTextElement(el.id, { text: 'OVERLAY' });
  });
  await page.waitForTimeout(700);

  const overlay = await elements(page);
  expect(overlay[0].style.position).toBe('manual');
  expect(overlay[0].style.customPosY).toBe(50);

  const ovInk = await textLayerCentroid(page);
  console.log('overlay cy', ovInk.cy.toFixed(1), 'of', ovInk.h);
  // Mid-frame, and clearly above where the caption sits.
  expect(Math.abs(ovInk.cy - ovInk.h / 2)).toBeLessThan(ovInk.h * 0.12);
  expect(ovInk.cy).toBeLessThan(transcript.cy - 10);
});

test('a manual caption is still fully editable — drag, select, delete', async ({ page }) => {
  await setup(page);
  await page.locator('#timeline-add-captions-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    window.__textElements.updateTextElement(el.id, { text: 'MANUAL' });
  });
  await page.waitForTimeout(600);

  const before = await elements(page);

  // --- drag its timeline clip to a later time ---
  const clip = page.locator('#timeline-captions-track .timeline-text-clip').first();
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const moved = await elements(page);
  console.log('caption clip', before[0].start.toFixed(2), '->', moved[0].start.toFixed(2));
  expect(moved[0].start).toBeGreaterThan(before[0].start + 0.5);
  // A move preserves duration.
  expect(moved[0].end - moved[0].start).toBeCloseTo(before[0].end - before[0].start, 1);
  // ...and it's still a caption, still on its own lane.
  expect(moved[0].kind).toBe('caption');
  await expect(page.locator('#timeline-captions-track .timeline-text-clip')).toHaveCount(1);

  // --- delete it ---
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.__textElements.selectTextElement(window.__appState.textElements[0].id);
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  expect((await elements(page)).length).toBe(0);
});
