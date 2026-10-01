import { test, expect } from '@playwright/test';

// Turning a transcript caption into cinematic text or a text overlay, from
// the caption's own capsule on the Captions lane (textElements.js's
// convertCaptionToTextElement) — and the Cinematic clip's behaviour when the
// timeline is tight. Driven through the real UI, checked on real pixels.
//
// Hits :5173 explicitly (caption fonts come from the backend, whose CORS
// allowlist covers :5173 only). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

const WORDS = 'this one completely changed everything so here are five'.split(' ');

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  // Three captions of three words each, with real per-word timing.
  await page.evaluate((list) => {
    const words = list.map((w, i) => ({ word: w, start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.45, wordIndex: i }));
    const phrases = [0, 3, 6].map((i) => ({ start: words[i].start, end: words[i + 2].end, words: words.slice(i, i + 3), breakAfterIndices: [] }));
    window.__updateState({ words, phrases, captionEvents: [], animationMode: 'karaoke' }, { recordHistory: false });
  }, WORDS);
  // The timeline seeds caption events from the phrases.
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(3);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-9) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

const captionEvents = (page) => page.evaluate(() => window.__appState.captionEvents.map((e) => ({ id: e.id, start: e.start, end: e.end, words: e.wordIndices })));
const textElements = (page) => page.evaluate(() => window.__appState.textElements);

/** Ink box of a canvas layer: where its opaque pixels are, as fractions of the frame. */
function inkBox(page, canvasId) {
  return page.evaluate((id) => {
    const c = document.getElementById(id);
    if (!c.classList.contains('active')) return null;
    const { width: w, height: h } = c;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 128) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return n ? { x0: x0 / w, x1: x1 / w, y0: y0 / h, y1: y1 / h, n } : null;
  }, canvasId);
}

async function convert(page, captionIndex, kind) {
  const capsule = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').nth(captionIndex);
  await capsule.hover();
  await capsule.locator('.timeline-caption-convert').click();
  await expect(page.locator('#timeline-convert-menu')).toBeVisible();
  await page.locator(`#timeline-convert-menu [data-convert-to="${kind}"]`).click();
  await expect(page.locator('#timeline-convert-menu')).toHaveCount(0);
}

test('a caption becomes cinematic text: same span and words, off the Captions lane, one Undo back', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);
  const before = await captionEvents(page);
  const target = before[0]; // "this one completely", 1.00 → 2.45

  await convert(page, 0, 'interlude');

  const [el] = await textElements(page);
  console.log('interlude:', JSON.stringify({ kind: el.kind, start: el.start, end: el.end, text: el.text, timing: el.timing.map((t) => [t.word, t.offset]) }));
  expect(el.kind).toBe('interlude');
  expect(el.start).toBe(target.start);
  expect(el.end).toBe(target.end);
  expect(el.text.replace(/\s+/g, ' ')).toBe('this one completely');
  // Each word keeps its real spoken timing, relative to the element's start.
  expect(el.timing.map((t) => +t.offset.toFixed(3))).toEqual([0, 0.5, 1]);
  expect(el.source.event.id).toBe(target.id);

  // The caption became it: gone from the lane, the other two untouched.
  const after = await captionEvents(page);
  expect(after.map((e) => e.id)).toEqual(before.slice(1).map((e) => e.id));
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(2);
  await expect(page.locator('#timeline-interlude-track .timeline-text-clip.is-interlude')).toHaveCount(1);

  // On screen: the interlude's card for the caption's span.
  await seek(page, 2.0);
  const card = await page.evaluate(() => Array.from(document.getElementById('text-elements-canvas').getContext('2d').getImageData(2, 2, 1, 1).data));
  expect(card).toEqual([255, 255, 255, 255]);

  // ONE Undo puts the caption back — on the lane AND on screen.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await page.waitForTimeout(300);
  expect((await captionEvents(page)).map((e) => e.id)).toEqual(before.map((e) => e.id));
  expect(await textElements(page)).toEqual([]);
  await seek(page, 2.01);
  const captionBox = await inkBox(page, 'captions-canvas');
  expect(captionBox).not.toBeNull();
  const phrases = await page.evaluate(() => window.__appState.phrases.map((p) => p.captionEventId));
  expect(phrases).toContain(target.id);

  // Redo converts it again.
  await page.getByRole('button', { name: 'Redo (Ctrl+Y)' }).click();
  await page.waitForTimeout(300);
  expect((await textElements(page)).length).toBe(1);
  expect((await captionEvents(page)).length).toBe(2);
  expect(errs).toEqual([]);
});

test('a caption becomes a text overlay that looks and behaves exactly like the caption did', async ({ page }) => {
  await setup(page);
  const [, second] = await captionEvents(page);
  // Give the caption its own "This Caption" edits first: moved up and tilted.
  await page.evaluate((start) => {
    const key = String(Math.round(start * 100));
    window.__updateState({ captionTransforms: { ...window.__appState.captionTransforms, [key]: { customPosX: 50, customPosY: 35, rotation: 8 } } }, { recordHistory: true });
  }, second.start);

  // Where the caption draws, with its edits, in the middle of its second word.
  const mid = second.start + 0.6;
  await seek(page, mid);
  const captionBox = await inkBox(page, 'captions-canvas');
  expect(captionBox).not.toBeNull();

  await convert(page, 1, 'overlay');
  const [el] = await textElements(page);
  console.log('overlay:', JSON.stringify({ kind: el.kind, style: el.style, text: el.text }));
  expect(el.kind).toBe('overlay');
  expect(el.style).toMatchObject({ position: 'manual', customPosX: 50, customPosY: 35, rotation: 8 });
  // The caption's own edits moved with it (none left behind on the caption list).
  const transforms = await page.evaluate(() => window.__appState.captionTransforms);
  expect(transforms[String(Math.round(second.start * 100))]).toBeUndefined();

  // Same place, same size, same instant: the overlay is where the caption was.
  await seek(page, mid + 0.001);
  const overlayBox = await inkBox(page, 'text-elements-canvas');
  console.log('caption ink', JSON.stringify(captionBox), '\noverlay ink', JSON.stringify(overlayBox));
  for (const k of ['x0', 'x1', 'y0', 'y1']) expect(Math.abs(overlayBox[k] - captionBox[k])).toBeLessThan(0.02);
  // And the caption layer no longer draws those words.
  expect(await inkBox(page, 'captions-canvas')).toBeNull();

  // Karaoke still follows the SPOKEN words: the highlight moves between the
  // first and third word, exactly as on the caption.
  const colours = async (t) => { await seek(page, t); return page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let yellow = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] < 120) yellow++; else if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++; }
    return { yellow, white };
  }); };
  const w1 = await colours(second.start + 0.1);
  const w3 = await colours(second.start + 1.1);
  console.log('karaoke highlight px — first word:', JSON.stringify(w1), ' third word:', JSON.stringify(w3));
  expect(w1.yellow + w1.white).toBeGreaterThan(0);
  expect(w1).not.toEqual(w3);
});

test('its length is set freely, and Back to caption restores the caption as it was', async ({ page }) => {
  await setup(page);
  const before = await captionEvents(page);
  await convert(page, 2, 'interlude');
  // On desktop the Text & Cinematic panel opens itself for new cinematic
  // text; the toolbar button toggles, so press it only if it didn't.
  if (!(await page.locator('#textel-back-to-caption').isVisible())) {
    await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  }
  await expect(page.locator('#textel-back-to-caption')).toBeVisible();

  // Longer than the caption was…
  await page.locator('#textel-duration').fill('3');
  let [el] = await textElements(page);
  expect(el.end - el.start).toBeCloseTo(3, 6);
  // …and shorter.
  await page.locator('#textel-duration').fill('0.8');
  [el] = await textElements(page);
  expect(el.end - el.start).toBeCloseTo(0.8, 6);

  await page.locator('#textel-back-to-caption').click();
  await page.waitForTimeout(300);
  expect(await textElements(page)).toEqual([]);
  const restored = await captionEvents(page);
  expect(restored).toEqual(before);
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(3);
});

test('the playhead "+ Cinematic" still works alongside it', async ({ page }) => {
  await setup(page);
  await seek(page, 7.3);
  await page.locator('#timeline-add-interlude-btn').click();
  const [el] = await textElements(page);
  expect(el.kind).toBe('interlude');
  expect(el.start).toBe(7.3);
  expect(el.source).toBeUndefined();
  expect((await captionEvents(page)).length).toBe(3);
});

test('a Cinematic clip shrinks with the timeline like a caption clip, and never draws wider than its span', async ({ page }) => {
  await setup(page);
  // A long one and a very short one (0.2 s).
  await page.evaluate(() => {
    window.__textElements.addInterlude({ start: 5, text: 'THIS CHANGED\nEVERYTHING.' });
    const short = window.__textElements.addInterlude({ start: 8, text: 'SHORT' });
    window.__textElements.trimTextElement(short.id, 'end', 8.2);
  });
  await page.waitForTimeout(300);

  const measure = () => page.evaluate(() => {
    const track = document.getElementById('timeline-interlude-track');
    const duration = document.getElementById('preview-video').duration;
    const pxPerSec = track.getBoundingClientRect().width / duration;
    return window.__appState.textElements.filter((e) => e.kind === 'interlude').map((e) => {
      const el = track.querySelector(`[data-clip-id="${e.id}"]`);
      const label = el.querySelector('.timeline-text-clip-label');
      return { expected: (e.end - e.start) * pxPerSec, actual: el.getBoundingClientRect().width, labelTruncated: label.scrollWidth > label.clientWidth };
    });
  });

  let [long, short] = await measure();
  console.log('fit:', JSON.stringify({ long, short }));
  // Drawn at its real length — not inflated by padding to fit a swatch.
  expect(Math.abs(short.actual - Math.max(short.expected, 6))).toBeLessThan(2);
  expect(Math.abs(long.actual - long.expected)).toBeLessThan(2);
  // The label gives way (ellipsis) rather than forcing the clip wider.
  expect(short.labelTruncated).toBe(true);

  // Zoomed in, both widen with the timeline.
  for (let i = 0; i < 3; i++) await page.locator('#timeline-zoom-in').click();
  await page.waitForTimeout(300);
  [long, short] = await measure();
  console.log('zoomed:', JSON.stringify({ long, short }));
  expect(Math.abs(short.actual - short.expected)).toBeLessThan(2);
  expect(Math.abs(long.actual - long.expected)).toBeLessThan(2);
});
