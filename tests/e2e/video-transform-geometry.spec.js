import { test, expect } from '@playwright/test';

// The VIDEO's own transform (shared/videoTransform.js) is applied as a CSS
// transform on #preview-video. getBoundingClientRect() on a rotated or scaled
// element returns the axis-aligned box of the TRANSFORMED shape, not the
// element's layout box — and src/js/utils/canvasGeometry.js's
// getCanvasContentRect() is the origin every pointer/canvas coordinate
// conversion in the app derives from.
//
// Nothing that rect feeds is transformed with the video: the caption canvas,
// the text-overlay canvas and the selection overlay are siblings laid out
// against the video's LAYOUT box, and the exporter composites them on top of
// the already-transformed frame rather than rotating them too. So the
// inflated box made the preview disagree with the export the moment a video
// rotation was applied — the selection overlay sprawled outside the phone
// frame and hit testing was scaled and offset. Export was never affected (it
// measures no DOM), which is why this only ever showed up on screen.
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
    const words = [{ word: 'HELLO', start: 0, end: 5, wordIndex: 0 }];
    window.__updateState({ words, phrases: [{ start: 0, end: 5, words, breakAfterIndices: [] }] }, { recordHistory: false });
    document.getElementById('preview-video').currentTime = 2;
  });
  await page.waitForTimeout(700);
}

const geometry = (page) => page.evaluate(async () => {
  const geo = await import('/src/js/utils/canvasGeometry.js');
  const v = document.getElementById('preview-video');
  const content = geo.getCanvasContentRect();
  const raw = v.getBoundingClientRect();
  return {
    content: [Math.round(content.width), Math.round(content.height)],
    contentPos: [Math.round(content.left), Math.round(content.top)],
    raw: [Math.round(raw.width), Math.round(raw.height)],
    layout: [v.offsetWidth, v.offsetHeight],
    transform: v.style.transform || ''
  };
});

const setVideoTransform = (page, t) => page.evaluate((vt) => {
  window.__updateState({ videoTransform: vt }, { recordHistory: false });
}, t);

test('the content rect ignores the video transform and keeps the layout box', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const before = await geometry(page);
  expect(before.content).toEqual(before.layout);
  expect(before.raw).toEqual(before.layout);

  // Rotation AND scale together — each one alone inflates the bounding box,
  // and the two compose.
  await setVideoTransform(page, { rotation: 17, scale: 1.3, offsetXPct: 0, offsetYPct: 0, opacity: 100 });
  await page.waitForTimeout(800);

  const after = await geometry(page);
  console.log('content', after.content, 'raw bounding', after.raw, 'layout', after.layout);

  // The raw box really did inflate — otherwise this test proves nothing.
  expect(after.raw[0]).toBeGreaterThan(after.layout[0] + 10);
  expect(after.raw[1]).toBeGreaterThan(after.layout[1] + 10);
  // ...and the content rect ignored it.
  expect(after.content).toEqual(before.content);
  expect(after.contentPos).toEqual(before.contentPos);

  // Measuring must not disturb the transform actually being displayed.
  expect(after.transform).toContain('rotate(17deg)');
  expect(after.transform).toContain('scale(1.3)');
  expect(errs).toEqual([]);
});

test('the caption stays put on screen while the video rotates under it', async ({ page }) => {
  await setup(page);

  const inkCentroid = () => page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) { const p = i / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
    }
    return n ? { drawn: n, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), w: c.width, h: c.height } : null;
  });

  const before = await inkCentroid();
  expect(before).not.toBeNull();

  await setVideoTransform(page, { rotation: 25, scale: 1, offsetXPct: 0, offsetYPct: 0, opacity: 100 });
  await page.waitForTimeout(800);
  const after = await inkCentroid();
  console.log('caption before', JSON.stringify(before), 'after', JSON.stringify(after));

  // The caption layer is composited ON TOP of the transformed video, upright
  // and in place — exactly what the exporter does. Its backing store must not
  // be resized by the video's transform either, or the caption would be drawn
  // at a different scale than the export uses.
  expect([after.w, after.h]).toEqual([before.w, before.h]);
  expect(Math.abs(after.cx - before.cx)).toBeLessThan(1.5);
  expect(Math.abs(after.cy - before.cy)).toBeLessThan(1.5);
  expect(Math.abs(after.drawn - before.drawn)).toBeLessThan(before.drawn * 0.05);
});
