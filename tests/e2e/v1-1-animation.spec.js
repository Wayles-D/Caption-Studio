import { test, expect } from '@playwright/test';

// BHYND V1.1.0 — entrance animations and cinematic-text parity, driven
// through the real UI and checked on the pixels the preview actually draws.
//
//  - A word with its own entrance is not drawn before its time (it used to
//    wait, fully visible, at its start offset), and the caption's layout is
//    fixed: no word moves because another is entering.
//  - The duration is the length of the movement (a word's entrance used to be
//    cut to the word's spoken length, so raising it did nothing).
//  - Slide Up/Down/Left/Right enter from about one line away, in the
//    direction they name, starting invisible.
//  - A word inside a cinematic card is selected with a second click and
//    animated with the same scopes as a caption word — on the card's own
//    words, never the captions'.
//
// Hits :5173 explicitly (caption fonts come from the backend, whose CORS
// allowlist covers :5173 only). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
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

/** "HERE ARE FIVE": one caption, 1.0–3.0s, its words spoken at 1.0 / 1.5 / 2.0. */
async function setupCaption(page, extra = {}) {
  await page.evaluate((extraState) => {
    const words = [
      { word: 'HERE', start: 1.0, end: 1.4, wordIndex: 0 },
      { word: 'ARE', start: 1.5, end: 1.9, wordIndex: 1 },
      { word: 'FIVE', start: 2.0, end: 2.5, wordIndex: 2 }
    ];
    window.__updateState({ words, phrases: [{ start: 1.0, end: 3.0, words, breakAfterIndices: [] }], captionEvents: [], captionAnimationType: 'none', ...extraState }, { recordHistory: false });
  }, extra);
  await seek(page, 2.8);
  await page.waitForTimeout(300);
  await seek(page, 2.79);
}

const restingRects = (page) => page.evaluate(() => [0, 1, 2].map((i) => window.__debugWordScreenRect(i)));

/**
 * Ink on `canvasId` inside a frame-relative CSS rect, grown by `pad` lines
 * above and below (a sliding word is caught on its way in): how much, and
 * its centroid in frame CSS px.
 */
function inkIn(page, canvasId, rect, pad = 0) {
  return page.evaluate(([id, r, padLines]) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const c = document.getElementById(id);
    const cr = c.getBoundingClientRect();
    const sx = c.width / cr.width;
    const sy = c.height / cr.height;
    const top = r.y - r.height * padLines;
    const x0 = Math.max(0, Math.round((frame.x + r.x - cr.left) * sx));
    const y0 = Math.max(0, Math.round((frame.y + top - cr.top) * sy));
    const w = Math.max(1, Math.round(r.width * sx));
    const h = Math.max(1, Math.round(r.height * (1 + 2 * padLines) * sy));
    const d = c.getContext('2d').getImageData(x0, y0, w, h).data;
    let n = 0; let sumX = 0; let sumY = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) {
        const p = i / 4;
        n++; sumX += p % w; sumY += Math.floor(p / w);
      }
    }
    return n ? { n, cx: r.x + sumX / n / sx, cy: top + sumY / n / sy } : { n: 0 };
  }, [canvasId, rect, pad]);
}

/** Whole-canvas ink: amount and centroid, in canvas px. */
function canvasInk(page, canvasId, darkOnly = false) {
  return page.evaluate(([id, dark]) => {
    const c = document.getElementById(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; let sx = 0; let sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      const hit = dark ? (d[i + 3] > 200 && d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) : d[i + 3] > 40;
      if (hit) { const p = i / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
    }
    return n ? { n, cx: sx / n, cy: sy / n } : { n: 0 };
  }, [canvasId, darkOnly]);
}

/** First click selects the caption, the second the word — the editor's drill-in. */
async function selectCaptionWord(page, index) {
  const frame = await page.locator('#preview-video').boundingBox();
  const r = (await restingRects(page))[index];
  await page.mouse.click(frame.x + r.centerX, frame.y + r.centerY);
  await page.mouse.click(frame.x + r.centerX, frame.y + r.centerY);
  expect((await page.evaluate(() => window.__debugGroupState())).selectedWordIndex).toBe(index);
}

test('a word waiting for its entrance is not drawn, it slides up into place, and the layout never moves', async ({ page }) => {
  await openDemo(page);
  await setupCaption(page);
  const rest = await restingRects(page);
  // Selecting by clicking moves nothing (a click used to commit a zero-length
  // move that re-anchored the caption — see canvasTransform.js's
  // DRAG_DEAD_ZONE_PX).
  await selectCaptionWord(page, 0);
  expect(await restingRects(page)).toEqual(rest);
  expect(await page.evaluate(() => window.__appState.position)).toBe('bottom');
  await page.locator('#btn-anim-scope-all-words').click();
  await page.locator('#select-canvas-animation-type').selectOption('slide-up');
  const entries = await page.evaluate(() => Object.values(window.__appState.captionTransforms).map((e) => e.animationType));
  expect(entries).toEqual(['slide-up', 'slide-up', 'slide-up']);

  // Where "ARE" lands: its ink once every entrance is over.
  await seek(page, 2.8);
  const landed = await inkIn(page, 'captions-canvas', rest[1], 1.5);
  const samples = [];
  for (const t of [1.2, 1.45, 1.53, 1.58, 1.62, 1.8, 2.3, 2.8]) {
    await seek(page, t);
    const ink = await inkIn(page, 'captions-canvas', rest[1], 1.5);
    samples.push([t, ink.n, ink.n ? +(ink.cy - landed.cy).toFixed(2) : null]);
    // The layout is the final one throughout.
    expect(await restingRects(page)).toEqual(rest);
  }
  console.log('"ARE" (spoken at 1.5): [t, ink, centroid below where it lands]', JSON.stringify(samples));

  // Before 1.5 "ARE" draws nothing at all — not at an offset, not anywhere.
  expect(samples[0][1]).toBe(0);
  expect(samples[1][1]).toBe(0);
  // On its way in it is BELOW where it lands, by no more than about a line…
  const moving = samples.filter(([t, n]) => t > 1.5 && t < 1.65 && n > 0);
  expect(moving.length).toBeGreaterThan(0);
  moving.forEach(([, , dy]) => {
    expect(dy).toBeGreaterThan(0.5);
    expect(dy).toBeLessThan(rest[1].height * 1.6);
  });
  // …and it has settled once the default (short) duration is over.
  expect(Math.abs(samples.find(([t]) => t === 1.8)[2])).toBeLessThan(0.25);
  // "FIVE" still waits — nothing — until 2.0.
  await seek(page, 1.9);
  expect((await inkIn(page, 'captions-canvas', rest[2], 1.5)).n).toBe(0);
});

test('the duration is the length of the movement, not cut short by the word', async ({ page }) => {
  await openDemo(page);
  await setupCaption(page, { captionAnimationDuration: 1 });
  await selectCaptionWord(page, 1);
  const rest = await restingRects(page);
  await page.locator('#select-canvas-animation-type').selectOption('slide-up');
  await seek(page, 2.8);
  const centre = (await inkIn(page, 'captions-canvas', rest[1], 1.5)).cy;
  const offsetAt = async (t) => {
    await seek(page, t);
    const ink = await inkIn(page, 'captions-canvas', rest[1], 1.5);
    return ink.n ? ink.cy - centre : null;
  };
  // "ARE" is spoken for 0.4s; a 1s entrance is still visibly travelling after it…
  const mid = await offsetAt(2.0);
  // …and lands when the second is up.
  const landed = await offsetAt(2.6);
  console.log('1s slide — offset at +0.5s:', mid?.toFixed(2), ' at +1.1s:', landed?.toFixed(2));
  expect(mid).toBeGreaterThan(0.25);
  expect(Math.abs(landed)).toBeLessThan(0.25);
});

test('Slide Up/Down/Left/Right enter from about a line away, in the direction they name, starting invisible', async ({ page }) => {
  await openDemo(page);
  await setupCaption(page);
  const rest = await restingRects(page);
  const lineHeight = rest[0].height;
  const settled = await canvasInk(page, 'captions-canvas');
  const scale = await page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    return c.width / c.getBoundingClientRect().width;
  });
  const results = {};
  for (const type of ['slide-up', 'slide-down', 'slide-left', 'slide-right']) {
    await page.evaluate((t) => window.__updateState({ captionAnimationType: t, captionAnimationDuration: 0.25 }, { recordHistory: false }), type);
    await seek(page, 1.0);
    const atStart = await canvasInk(page, 'captions-canvas');
    await seek(page, 1.05);
    const early = await canvasInk(page, 'captions-canvas');
    results[type] = { atStart: atStart.n, dx: +((early.cx - settled.cx) / scale).toFixed(2), dy: +((early.cy - settled.cy) / scale).toFixed(2) };
    // The very first frame of the entrance: nothing yet.
    expect(atStart.n).toBe(0);
    expect(early.n).toBeGreaterThan(0);
  }
  console.log('offset from the landed caption 0.05s in (CSS px; + is right/down):', JSON.stringify(results), 'line height', lineHeight.toFixed(1));
  expect(results['slide-up'].dy).toBeGreaterThan(1);
  expect(results['slide-down'].dy).toBeLessThan(-1);
  expect(results['slide-left'].dx).toBeGreaterThan(1);
  expect(results['slide-right'].dx).toBeLessThan(-1);
  // About a line away at most — never a tenth of the frame.
  Object.values(results).forEach(({ dx, dy }) => {
    expect(Math.abs(dx)).toBeLessThan(lineHeight * 1.5);
    expect(Math.abs(dy)).toBeLessThan(lineHeight * 1.5);
  });
});

test('typewriter keeps the final layout: the first word is already where it ends up', async ({ page }) => {
  await openDemo(page);
  await setupCaption(page, { animationMode: 'typewriter' });
  const final = await restingRects(page);
  await seek(page, 1.2);
  const early = await page.evaluate(() => window.__debugWordScreenRect(0));
  // Only "HERE" is showing, and it sits where it will sit in "HERE ARE FIVE"
  // — not centred on its own.
  expect(await page.evaluate(() => window.__debugWordScreenRect(2))).toBeNull();
  expect(early.x).toBeCloseTo(final[0].x, 3);
  expect(early.y).toBeCloseTo(final[0].y, 3);
});

/** A cinematic card at 2s reading `text`, selected; returns its id. */
async function addCard(page, text) {
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  return page.evaluate((t) => {
    const [el] = window.__appState.textElements;
    window.__textElements.updateTextElement(el.id, { text: t });
    return el.id;
  }, text);
}

/** Second click on a word of the selected card picks that word. */
async function selectCardWord(page, index) {
  const frame = await page.locator('#preview-video').boundingBox();
  const words = await page.evaluate(() => window.__debugTextWordRects());
  const w = words[index];
  const x = frame.x + w.x + w.width / 2;
  const y = frame.y + w.y + w.height / 2;
  // The first click on the video selects the card (even one already selected
  // by being created), the next picks the word — as on a caption.
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(x, y);
    if (await page.evaluate(() => window.__debugSelectedTextWordIndex()) === index) break;
  }
  expect(await page.evaluate(() => window.__debugSelectedTextWordIndex())).toBe(index);
}

test('cinematic text reads as one horizontal line while it fits, and wraps only when it must', async ({ page }) => {
  await openDemo(page);
  await addCard(page, 'HOME OFFICE HACKS');
  await seek(page, 3);
  const rows = new Set((await page.evaluate(() => window.__debugTextWordRects())).map((w) => Math.round(w.y)));
  expect(rows.size).toBe(1);
  // Much longer text does wrap — across the card's width, not a word a line.
  await page.evaluate(() => {
    const [el] = window.__appState.textElements;
    window.__textElements.updateTextElement(el.id, { text: 'FIVE HOME OFFICE HACKS FOR A PRODUCTIVE AND AESTHETIC SPACE' });
  });
  await seek(page, 3.01);
  const words = await page.evaluate(() => window.__debugTextWordRects());
  const lines = new Set(words.map((w) => Math.round(w.y)));
  console.log('long card:', words.length, 'words on', lines.size, 'lines');
  expect(lines.size).toBeGreaterThan(1);
  expect(lines.size).toBeLessThan(words.length);
});

test('a word in a cinematic card is selected with a second click and animated with the same scopes', async ({ page }) => {
  await openDemo(page);
  const id = await addCard(page, 'HOME OFFICE HACKS');
  await seek(page, 3);
  await selectCardWord(page, 1);
  // The same animation targets a caption word has — on the card's words; no
  // "All Captions" for a card.
  await expect(page.locator('#btn-anim-scope-this')).toHaveText('This Word');
  await expect(page.locator('#btn-anim-scope-same-type')).toBeVisible();
  await expect(page.locator('#btn-anim-scope-all-words')).toBeVisible();
  await expect(page.locator('#btn-anim-scope-this-caption')).toHaveText('Whole Text');
  await expect(page.locator('#btn-anim-scope-all-captions')).toBeHidden();

  await page.locator('#select-canvas-animation-type').selectOption('slide-up');
  let el = await page.evaluate((elId) => window.__appState.textElements.find((e) => e.id === elId), id);
  expect(Object.keys(el.wordTransforms)).toEqual(['w1']);
  expect(el.wordTransforms.w1.animationType).toBe('slide-up');
  // The captions' own map is untouched.
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms))).toEqual([]);

  await page.locator('#btn-anim-scope-all-words').click();
  await page.locator('#select-canvas-animation-type').selectOption('pop');
  el = await page.evaluate((elId) => window.__appState.textElements.find((e) => e.id === elId), id);
  expect(Object.values(el.wordTransforms).map((e) => e.animationType)).toEqual(['pop', 'pop', 'pop']);

  // "Whole Text" is the card's own entrance — the field its panel edits.
  await page.locator('#btn-anim-scope-this-caption').click();
  await page.locator('#select-canvas-animation-type').selectOption('slide-left');
  el = await page.evaluate((elId) => window.__appState.textElements.find((e) => e.id === elId), id);
  expect(el.style.captionAnimationType).toBe('slide-left');
});

test('a card\'s word entrance: not drawn before it starts, in motion, then at rest — and only that word', async ({ page }) => {
  await openDemo(page);
  await addCard(page, 'HOME OFFICE HACKS');
  // The card's own entrance off, so only the word moves.
  await page.evaluate(() => {
    const [el] = window.__appState.textElements;
    window.__textElements.updateTextElementStyle(el.id, { captionAnimationType: 'none' });
  });
  await seek(page, 3);
  const words = await page.evaluate(() => window.__debugTextWordRects());
  // Dark (text) pixels around a word's place — the card itself is white —
  // and their centroid, in frame CSS px.
  const darkIn = (rect) => page.evaluate((r) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const c = document.getElementById('text-elements-canvas');
    const cr = c.getBoundingClientRect();
    const s = c.width / cr.width;
    const top = r.y - r.height * 1.5;
    const w = Math.round(r.width * s);
    const d = c.getContext('2d').getImageData(Math.round((frame.x + r.x - cr.left) * s), Math.round((frame.y + top - cr.top) * s), w, Math.round(r.height * 4 * s)).data;
    let n = 0; let sy = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100 && d[i + 3] > 200) { n++; sy += Math.floor(i / 4 / w); }
    return n ? { n, cy: top + sy / n / s } : { n: 0 };
  }, rect);
  // Where "HACKS" sits with no entrance at all — the place it must land.
  const landed = await darkIn(words[2]);

  await selectCardWord(page, 2);
  await page.locator('#select-canvas-animation-type').selectOption('slide-up');
  await seek(page, 2.0);
  const start = await darkIn(words[2]);
  const other = await darkIn(words[0]);
  await seek(page, 2.04);
  const moving = await darkIn(words[2]);
  await seek(page, 2.6);
  const rest = await darkIn(words[2]);
  console.log('"HACKS" dark px — at start:', start.n, ' 0.04s in:', moving.n, (moving.cy - landed.cy).toFixed(2), ' at rest:', rest.n, (rest.cy - landed.cy).toFixed(2), ' "HOME" at start:', other.n);
  expect(start.n).toBe(0);
  expect(moving.n).toBeGreaterThan(0);
  expect(moving.cy - landed.cy).toBeGreaterThan(0.5);
  expect(Math.abs(rest.cy - landed.cy)).toBeLessThan(0.25);
  // A word without an entrance is simply there.
  expect(other.n).toBeGreaterThan(0);
});

test('a card made from a caption starts clean: one line, none of the caption\'s word animations, its words still timed', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const list = ['HOME', 'OFFICE', 'HACKS'];
    const words = list.map((w, i) => ({ word: w, start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.45, wordIndex: i }));
    // The caption breaks its line after "OFFICE", and one of its words slides.
    window.__updateState({
      words,
      phrases: [{ start: 1, end: 2.45, words, breakAfterIndices: [1] }],
      captionEvents: [],
      captionTransforms: { w1: { animationType: 'slide-up', animationDuration: 0.25 } }
    }, { recordHistory: false });
  });
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(1);
  const capsule = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').first();
  await capsule.hover();
  await capsule.locator('.timeline-caption-convert').click();
  await page.locator('#timeline-convert-menu [data-convert-to="interlude"]').click();
  const el = await page.evaluate(() => window.__appState.textElements[0]);
  expect(el.kind).toBe('interlude');
  expect(el.text).toBe('HOME OFFICE HACKS');
  expect(el.wordTransforms).toBeUndefined();
  expect(el.timing.map((t) => t.word)).toEqual(['HOME', 'OFFICE', 'HACKS']);
  await seek(page, 2.3);
  const rows = new Set((await page.evaluate(() => window.__debugTextWordRects())).map((w) => Math.round(w.y)));
  expect(rows.size).toBe(1);

  // One by one, on the card's own spoken timing: "HACKS" (said at 2.0) is
  // not drawn until then.
  await selectCardWord(page, 0);
  await page.locator('#btn-anim-scope-all-words').click();
  await page.locator('#select-canvas-animation-type').selectOption('slide-up');
  const words = await page.evaluate(() => window.__debugTextWordRects());
  const dark = (r) => page.evaluate((rect) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const c = document.getElementById('text-elements-canvas');
    const cr = c.getBoundingClientRect();
    const s = c.width / cr.width;
    const top = rect.y - rect.height * 1.5;
    const d = c.getContext('2d').getImageData(Math.round((frame.x + rect.x - cr.left) * s), Math.round((frame.y + top - cr.top) * s), Math.round(rect.width * s), Math.round(rect.height * 4 * s)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100 && d[i + 3] > 200) n++;
    return n;
  }, r);
  await seek(page, 1.9);
  expect(await dark(words[0])).toBeGreaterThan(0);
  expect(await dark(words[2])).toBe(0);
  await seek(page, 2.3);
  expect(await dark(words[2])).toBeGreaterThan(0);

  // Together: all three enter at the card's start instead.
  await page.locator('#btn-anim-timing-together').click();
  const timings = await page.evaluate(() => Object.values(window.__appState.textElements[0].wordTransforms).map((e) => e.animationTiming));
  expect(timings).toEqual(['together', 'together', 'together']);
  await seek(page, 1.6);
  expect(await dark(words[2])).toBeGreaterThan(0);
});

test('the Word panel styles one word of a card, and only that word', async ({ page }) => {
  await openDemo(page);
  const id = await addCard(page, 'HOME OFFICE HACKS');
  await seek(page, 3);
  const words = await page.evaluate(() => window.__debugTextWordRects());
  // The pixels of one word's place on the card, as a fingerprint.
  const pixels = (r) => page.evaluate((rect) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const c = document.getElementById('text-elements-canvas');
    const cr = c.getBoundingClientRect();
    const s = c.width / cr.width;
    return Array.from(c.getContext('2d').getImageData(Math.round((frame.x + rect.x - cr.left) * s), Math.round((frame.y + rect.y - cr.top) * s), Math.round(rect.width * s), Math.round(rect.height * s)).data).join(',');
  }, r);
  const before = [await pixels(words[0]), await pixels(words[1])];

  await selectCardWord(page, 0);
  await page.getByRole('button', { name: 'Word', exact: true }).click();
  await page.locator('#word-italic').click();
  const el = await page.evaluate((elId) => window.__appState.textElements.find((e) => e.id === elId), id);
  expect(el.wordTransforms?.w0?.style?.italic).toBe(true);
  expect(el.wordTransforms?.w1).toBeUndefined();
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms))).toEqual([]);

  await seek(page, 3.01);
  // "HOME" is drawn differently now; "OFFICE" is exactly as it was.
  expect(await pixels(words[0])).not.toBe(before[0]);
  expect(await pixels(words[1])).toBe(before[1]);
});
