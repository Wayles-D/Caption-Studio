import { test, expect } from '@playwright/test';

// On-canvas selection + transform for text overlays
// (src/js/components/canvasTransform.js's text-element branch).
//
// The bug this exists for: clicking an overlay selected the CAPTION
// underneath instead, so a newly-added overlay could never be moved off the
// spot it was created at. The fix hit-tests text-element boxes first (they
// render on a layer above the caption canvas) and routes the gesture to
// updateTextElementStyle instead of applyTransformFields.
//
// Asserts rendered PIXELS, not just state: a stored customPosX that the
// renderer ignores would be a silent no-op, which is exactly the failure
// mode this feature had before.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only, and a
// CORS-blocked webfont renders as a silent fallback. Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  // A real caption sitting underneath the overlay for the whole window —
  // without one there'd be nothing for a click to be stolen by, and the
  // test couldn't fail the way the original bug did.
  await page.evaluate(() => {
    const words = [
      { word: 'I', start: 0, end: 2, wordIndex: 0 },
      { word: 'AM', start: 2, end: 5, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 5, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(500);
  await page.locator('#timeline-add-text-btn').click();
  await page.evaluate(() => {
    const el = window.__appState.textElements[0];
    window.__textElements.updateTextElement(el.id, { text: 'OVERLAY' });
  });
  await page.waitForTimeout(500);
}

/** Centroid + coverage of the text-overlay layer only (captions are a separate canvas). */
function textLayerStats(page) {
  return page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) {
        const p = i / 4;
        const px = p % c.width, py = Math.floor(p / c.width);
        n++; sx += px; sy += py;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
      }
    }
    return n ? { drawn: n, cx: sx / n, cy: sy / n, w: c.width, bw: maxX - minX + 1, bh: maxY - minY + 1 }
             : { drawn: 0, cx: 0, cy: 0, w: c.width, bw: 0, bh: 0 };
  });
}

/** Same census for the CAPTION layer — used to prove the caption never moved. */
function captionLayerStats(page) {
  return page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) {
        const p = i / 4;
        n++; sx += p % c.width; sy += Math.floor(p / c.width);
      }
    }
    return n ? { drawn: n, cx: sx / n, cy: sy / n } : { drawn: 0, cx: 0, cy: 0 };
  });
}

/** Viewport point at the center of the overlay's own measured box. */
async function overlayCenterPoint(page) {
  const frame = await page.locator('#preview-video').boundingBox();
  const rects = await page.evaluate(() => window.__debugTextElementRects());
  expect(rects.length).toBe(1);
  return { x: frame.x + rects[0].centerX, y: frame.y + rects[0].centerY, frame };
}

test('clicking a text overlay selects the overlay, not the caption underneath', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const id = await page.evaluate(() => window.__appState.textElements[0].id);
  // Deselect first, so the assertion can't pass merely because creating the
  // element had already selected it.
  await page.evaluate(() => window.__textElements.selectTextElement(null));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.selectedTextElementId)).toBeNull();

  const pt = await overlayCenterPoint(page);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => window.__appState.selectedTextElementId)).toBe(id);
  // The caption-side selection must have been released, not merely shadowed
  // — the two share one overlay and one property panel.
  const group = await page.evaluate(() => window.__debugGroupState());
  expect(group.selectedWordIndex).toBeNull();
  expect(errs).toEqual([]);
});

test('dragging a text overlay moves its rendered pixels and leaves the caption put', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const beforeText = await textLayerStats(page);
  const beforeCaption = await captionLayerStats(page);
  expect(beforeText.drawn).toBeGreaterThan(0);
  expect(beforeCaption.drawn).toBeGreaterThan(0);

  const pt = await overlayCenterPoint(page);
  // Up and to the right, well inside the frame so nothing clamps.
  const dx = Math.round(pt.frame.width * 0.2);
  const dy = -Math.round(pt.frame.height * 0.2);

  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + dx, pt.y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const style = await page.evaluate(() => window.__appState.textElements[0].style);
  console.log('style after drag:', JSON.stringify(style));
  expect(style.position).toBe('manual');
  expect(style.customPosX).toBeGreaterThan(55);
  expect(style.customPosY).toBeLessThan(45);

  const afterText = await textLayerStats(page);
  const afterCaption = await captionLayerStats(page);
  console.log('text centroid', beforeText.cx.toFixed(1), beforeText.cy.toFixed(1),
    '->', afterText.cx.toFixed(1), afterText.cy.toFixed(1));

  // The pixels actually moved, in the direction dragged.
  expect(afterText.cx).toBeGreaterThan(beforeText.cx + 5);
  expect(afterText.cy).toBeLessThan(beforeText.cy - 5);
  // ...and the same amount of text is still drawn (a move, not a reflow).
  expect(Math.abs(afterText.drawn - beforeText.drawn)).toBeLessThan(beforeText.drawn * 0.25);

  // The caption underneath is untouched — the gesture must not have written
  // into captionTransforms, which is precisely what the bug did.
  expect(Math.abs(afterCaption.cx - beforeCaption.cx)).toBeLessThan(2);
  expect(Math.abs(afterCaption.cy - beforeCaption.cy)).toBeLessThan(2);
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms || {}).length)).toBe(0);
  expect(errs).toEqual([]);
});

test('a drag is one undo step, and undo restores the overlay position', async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => window.__appState.textElements[0].style.customPosX);

  const pt = await overlayCenterPoint(page);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + Math.round(pt.frame.width * 0.2), pt.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const moved = await page.evaluate(() => window.__appState.textElements[0].style.customPosX);
  expect(moved).toBeGreaterThan(before + 5);

  // The timeline's real Undo button — the app has no Ctrl+Z key handler
  // despite that button's own tooltip claiming one.
  await page.locator('#timeline-undo-btn').click();
  await page.waitForTimeout(400);
  const undone = await page.evaluate(() => window.__appState.textElements[0].style.customPosX);
  console.log('customPosX before/moved/undone:', before, moved, undone);
  // ONE undo is enough: the sixty recordHistory:false writes made during the
  // gesture must not each be their own step.
  expect(undone).toBeLessThan(moved - 5);
});

test('the corner handle resizes the overlay without touching the caption', async ({ page }) => {
  await setup(page);
  // Select it first so the handles exist.
  const pt = await overlayCenterPoint(page);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(300);

  const beforeText = await textLayerStats(page);
  const beforeSize = await page.evaluate(() => window.__appState.textElements[0].style.fontSize ?? window.__appState.fontSize);

  const handle = page.locator('#caption-transform-box .caption-transform-handle[data-handle]').first();
  await expect(handle).toBeVisible();
  const hb = await handle.boundingBox();
  const cx = hb.x + hb.width / 2;
  const cy = hb.y + hb.height / 2;
  // Drag the corner AWAY from the box center to grow it.
  const dirX = cx < pt.x ? -1 : 1;
  const dirY = cy < pt.y ? -1 : 1;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dirX * 40, cy + dirY * 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const afterSize = await page.evaluate(() => window.__appState.textElements[0].style.fontSize);
  const afterText = await textLayerStats(page);
  console.log('fontSize', beforeSize, '->', afterSize, 'drawn', beforeText.drawn, '->', afterText.drawn);
  expect(afterSize).toBeGreaterThan(beforeSize);
  expect(afterText.drawn).toBeGreaterThan(beforeText.drawn);
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms || {}).length)).toBe(0);
});

test('the rotate handle rotates the overlay, and the timeline clip selects it on canvas', async ({ page }) => {
  await setup(page);

  // --- selection originating from the TIMELINE, not the canvas: the canvas
  // overlay follows appState rather than owning the selection. ---
  await page.evaluate(() => window.__textElements.selectTextElement(null));
  await page.waitForTimeout(300);
  await page.locator('#timeline-text-track .timeline-text-clip').first().click();
  await page.waitForTimeout(400);
  const id = await page.evaluate(() => window.__appState.textElements[0].id);
  expect(await page.evaluate(() => window.__debugSelectedTextElementId())).toBe(id);
  await expect(page.locator('#caption-transform-box')).toBeVisible();

  // --- rotate ---
  const pt = await overlayCenterPoint(page);
  const before = await textLayerStats(page);
  const handle = page.locator('#caption-transform-handle-rotate');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  // Swing a quarter turn: from above the center round to its right.
  await page.mouse.move(pt.x + 90, pt.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const rotation = await page.evaluate(() => window.__appState.textElements[0].style.rotation);
  const after = await textLayerStats(page);
  console.log('rotation:', rotation, 'drawn', before.drawn, '->', after.drawn);
  expect(Math.abs(rotation)).toBeGreaterThan(45);
  // The PIXELS turned, not just the stored number: a word is wider than it
  // is tall, so a quarter turn must invert its drawn bounding box.
  console.log('footprint', before.bw + 'x' + before.bh, '->', after.bw + 'x' + after.bh);
  expect(before.bw).toBeGreaterThan(before.bh);
  expect(after.bh).toBeGreaterThan(after.bw);
  expect(await page.evaluate(() => Object.keys(window.__appState.captionTransforms || {}).length)).toBe(0);
});
