import { test, expect } from '@playwright/test';

// Keyframed animation for text overlays — the third target family plugged
// into src/js/components/keyframeEngine.js's dispatcher, beside captions/
// words (canvasTransform.js) and the video (videoTransform.js).
//
// Everything reused rather than rebuilt: the same shared/keyframes.js engine,
// the same five properties, the same PHRASE_FIELD_TO_PROPERTY mapping (an
// element is positioned in frame percentages exactly like a caption), the
// same timeline UI and ranges. The only new code on the read side is
// shared/textElement.js's resolveTextElementParams, which both the preview
// and the exporter call — so an animated overlay cannot resolve differently
// in the exported file than it does on screen.
//
// Assertions are about RENDERED PIXELS wherever an assertion about motion is
// possible: a keyframe list that state holds but the renderer never consults
// would pass a state-only test while animating nothing.
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
    const words = [
      { word: 'I', start: 0, end: 4, wordIndex: 0 },
      { word: 'AM', start: 4, end: 9, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 9, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await seek(page, 3);
  await page.locator('#timeline-add-text-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    // A long window, so keyframes at 3s and 6s both fall inside it.
    window.__textElements.updateTextElement(el.id, { text: 'MOVE', end: 8 });
  });
  await page.waitForTimeout(500);
  // The precision fields live in the desktop Advanced side panel (or behind
  // the inline Advanced toggle on smaller viewports) — the same button a
  // user clicks to reach them. relocatePrecisionFields reparents the exact
  // same inputs either way, so this reaches the real controls, not a copy.
  const advanced = page.locator('#timeline-advanced-toggle');
  if (await advanced.isVisible()) {
    await advanced.click();
    await page.waitForTimeout(400);
  }
}

/**
 * Seeks and waits for the seek to actually COMPLETE, rather than for a fixed
 * delay. A fixed wait raced the browser under parallel workers: the canvas
 * still held the previous frame, so every "did it move?" assertion compared a
 * stale render against itself and reported no motion — a test failure that
 * looked exactly like a broken feature.
 */
async function seek(page, t) {
  await page.evaluate((time) => { document.getElementById('preview-video').currentTime = time; }, t);
  await page.waitForFunction((time) => {
    const v = document.getElementById('preview-video');
    return !v.seeking && Math.abs(v.currentTime - time) < 0.06;
  }, t, { timeout: 20000 });
  // One more frame for the 'seeked'-driven redraw to paint.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(120);
}

/** Centroid + coverage of the overlay layer alone. */
function textStats(page) {
  return page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) { const p = i / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
    }
    return n ? { drawn: n, cx: sx / n, cy: sy / n } : { drawn: 0, cx: 0, cy: 0 };
  });
}

/** Writes one property through the timeline's own precision field for that lane. */
async function setProperty(page, property, value) {
  const input = page.locator(`.timeline-precision-field[data-property="${property}"]`).first();
  await input.fill(String(value));
  await input.dispatchEvent('change');
  await page.waitForTimeout(400);
}

const keyframes = (page) => page.evaluate(() => window.__appState.textElements[0].keyframes);

test('a selected overlay becomes the keyframe target, with caption-style ranges', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  // Creating selects it, so the timeline should already be pointed at it.
  await expect(page.locator('#timeline-target-label')).toHaveText(/Text/);

  // Position is a frame PERCENTAGE for a text element, exactly as for a
  // caption — so the lane must carry the caption family's 0–100 range, not
  // the word family's ±400px one.
  const posInput = page.locator('.timeline-precision-field[data-property="positionX"]').first();
  expect(await posInput.getAttribute('min')).toBe('0');
  expect(await posInput.getAttribute('max')).toBe('100');

  expect(errs).toEqual([]);
});

test('two keyframes make the overlay actually move between them', async ({ page }) => {
  await setup(page);

  // --- keyframe 1 at 3s, left of centre ---
  await seek(page, 3);
  await setProperty(page, 'positionX', 20);
  await page.locator('#timeline-add-keyframe-btn').click();
  await page.waitForTimeout(400);

  // --- keyframe 2 at 6s, right of centre ---
  await seek(page, 6);
  await setProperty(page, 'positionX', 80);
  await page.waitForTimeout(400);

  const kf = await keyframes(page);
  console.log('keyframes:', JSON.stringify(kf.map((k) => ({ t: k.t, x: k.values.positionX }))));
  expect(kf.length).toBe(2);
  // Editing a property at a NEW playhead time auto-keys there rather than
  // overwriting the first keyframe — the same auto-keying captions and the
  // video already get from routeFieldsThroughKeyframes.
  expect(kf[0].values.positionX).toBeCloseTo(20, 0);
  expect(kf[1].values.positionX).toBeCloseTo(80, 0);

  // --- the PIXELS follow, and interpolate in between ---
  await seek(page, 3);
  const at3 = await textStats(page);
  await seek(page, 4.5);
  const at45 = await textStats(page);
  await seek(page, 6);
  const at6 = await textStats(page);
  console.log('centroid x at 3 / 4.5 / 6:', at3.cx.toFixed(1), at45.cx.toFixed(1), at6.cx.toFixed(1));

  expect(at3.drawn).toBeGreaterThan(0);
  expect(at45.cx).toBeGreaterThan(at3.cx + 3);
  expect(at6.cx).toBeGreaterThan(at45.cx + 3);
  // Nothing was written onto the caption's own transforms.
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms || {}).length)).toBe(0);
});

test('opacity keyframes fade the overlay without touching the caption', async ({ page }) => {
  await setup(page);

  await seek(page, 3);
  await setProperty(page, 'opacity', 100);
  await page.locator('#timeline-add-keyframe-btn').click();
  await page.waitForTimeout(300);
  await seek(page, 6);
  await setProperty(page, 'opacity', 0);

  const captionAt45 = await page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) n++; return n;
  });

  await seek(page, 3);
  const full = await textStats(page);
  await seek(page, 5.9);
  const faded = await textStats(page);
  console.log('drawn at full opacity / near zero:', full.drawn, faded.drawn);
  expect(full.drawn).toBeGreaterThan(0);
  expect(faded.drawn).toBeLessThan(full.drawn * 0.5);

  await seek(page, 4.5);
  const captionAfter = await page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) n++; return n;
  });
  expect(captionAfter).toBe(captionAt45);
});

test('dragging a keyframed overlay updates the keyframe, not a dead static value', async ({ page }) => {
  await setup(page);

  await seek(page, 3);
  await setProperty(page, 'positionX', 20);
  await page.locator('#timeline-add-keyframe-btn').click();
  await page.waitForTimeout(300);
  await seek(page, 6);
  await setProperty(page, 'positionX', 80);
  await page.waitForTimeout(300);

  // Drag it at 6s. Because positionX is keyframed, this has to land in the
  // keyframe AT 6s — a raw style write would be silently overruled by the
  // keyframe track on the next render, so the overlay would snap straight
  // back and the drag would look broken.
  await seek(page, 6);
  const before = await textStats(page);
  const frame = await page.locator('#preview-video').boundingBox();
  const rects = await page.evaluate(() => window.__debugTextElementRects());
  const pt = { x: frame.x + rects[0].centerX, y: frame.y + rects[0].centerY };

  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x - Math.round(frame.width * 0.3), pt.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const kf = await keyframes(page);
  console.log('after drag at 6s:', JSON.stringify(kf.map((k) => ({ t: k.t, x: Math.round(k.values.positionX) }))));
  expect(kf.length).toBe(2);
  // The 6s keyframe moved left; the 3s one is exactly where it was.
  expect(kf[1].values.positionX).toBeLessThan(75);
  expect(kf[0].values.positionX).toBeCloseTo(20, 0);

  const after = await textStats(page);
  expect(after.cx).toBeLessThan(before.cx - 3);
});
