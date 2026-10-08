import { test, expect } from '@playwright/test';

// THE COMPOSITION (shared/composition.js) in the real editor: the canvas's
// shape and background, the video placed and styled inside it — checked on
// the frame's own pixels — plus undo, reload, on-video dragging, and the
// unchanged look of a project that never touches any of it.
//
// Hits :5173 explicitly (caption fonts come from the backend, whose CORS
// allowlist covers :5173 only). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
}

async function openCanvasPanel(page) {
  if (await page.locator('#canvas-editor').count()) return;
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('#canvas-editor')).toBeVisible();
}

/** Lets the frame refit and the video's placement redraw. */
const settle = (page) => page.waitForTimeout(450);

const geometry = (page) => page.evaluate(() => {
  const f = document.getElementById('state-video').getBoundingClientRect();
  const v = document.getElementById('preview-video');
  const r = v.getBoundingClientRect();
  return {
    frame: { x: f.x, y: f.y, w: f.width, h: f.height },
    video: { x: r.x - f.x, y: r.y - f.y, w: r.width, h: r.height },
    source: v.videoWidth / v.videoHeight
  };
});

/** The colour the frame SHOWS at (fx, fy) — fractions of the frame — read from a real screenshot. */
async function colourAt(page, fx, fy) {
  const png = await page.locator('#state-video').screenshot();
  return page.evaluate(async ({ b64, fx: x, fy: y }) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    return Array.from(cx.getImageData(Math.round(x * (img.width - 1)), Math.round(y * (img.height - 1)), 1, 1).data.slice(0, 3));
  }, { b64: png.toString('base64'), fx, fy });
}
const near = (rgb, target, tol = 18) => rgb.every((v, i) => Math.abs(v - target[i]) <= tol);

test('an untouched project looks as it always did: the canvas is the video\'s own frame, filled by the video', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openDemo(page);
  const g = await geometry(page);
  expect(Math.abs(g.frame.w / g.frame.h - g.source)).toBeLessThan(0.01);
  expect(Math.abs(g.video.w - g.frame.w)).toBeLessThan(1);
  expect(Math.abs(g.video.h - g.frame.h)).toBeLessThan(1);
  // Nothing stored, nothing written onto the element.
  expect(await page.evaluate(() => [window.__appState.composition, window.__appState.videoStyle])).toEqual([null, null]);
  expect(await page.evaluate(() => document.getElementById('preview-video').getAttribute('style') || '')).not.toMatch(/position|border-radius|box-shadow/);
  const params = await page.evaluate(() => window.__getStyleParams());
  expect(params.composition).toBeNull();
  expect(errs).toEqual([]);
});

test('aspect ratio reshapes the canvas; the video stays whole inside it, and the background shows around it', async ({ page }) => {
  await openDemo(page);
  await openCanvasPanel(page);
  // Every shape on offer — the panel shows each one, and each reshapes the frame.
  await expect(page.locator('#canvas-ratios button')).toHaveCount(10);
  for (const [id, ratio] of [['1x1', 1], ['16x9', 16 / 9], ['9x16', 9 / 16], ['4x5', 4 / 5], ['3x4', 3 / 4], ['4x3', 4 / 3], ['2x1', 2], ['2x35x1', 2.35], ['1x85x1', 1.85]]) {
    await page.locator(`#canvas-ratio-${id}`).click();
    await settle(page);
    const g = await geometry(page);
    expect(Math.abs(g.frame.w / g.frame.h - ratio), id).toBeLessThan(0.01);
    expect(Math.abs(g.video.w / g.video.h - g.source), `${id}: the video keeps its own shape`).toBeLessThan(0.01);
    expect(g.video.w <= g.frame.w + 1 && g.video.h <= g.frame.h + 1, `${id}: fitted whole`).toBe(true);
  }
  // On a square canvas the background shows beside the video: black, white, custom.
  await page.locator('#canvas-ratio-1x1').click();
  await settle(page);
  expect(near(await colourAt(page, 0.06, 0.5), [0, 0, 0])).toBe(true);
  await page.locator('#canvas-bg-white').click();
  await settle(page);
  expect(near(await colourAt(page, 0.06, 0.5), [255, 255, 255])).toBe(true);
  await page.evaluate(() => window.__composition.setBackgroundColor('#1E3A8A'));
  await settle(page);
  expect(near(await colourAt(page, 0.06, 0.5), [0x1e, 0x3a, 0x8a])).toBe(true);
  // And the export is told the same.
  const params = await page.evaluate(() => window.__getStyleParams());
  expect(params.composition).toEqual({ aspectRatio: '1:1', background: { type: 'solid', color: '#1E3A8A' } });
});

test('the video moves, scales, rotates, rounds, borders and shadows inside the canvas — not the canvas', async ({ page }) => {
  await openDemo(page);
  await openCanvasPanel(page);
  await page.locator('#canvas-ratio-1x1').click();
  await page.locator('#canvas-bg-white').click();
  await settle(page);
  const before = await geometry(page);

  // Snap to the left edge, then the right.
  await page.locator('#video-pos-left').click();
  await settle(page);
  let g = await geometry(page);
  expect(Math.abs(g.video.x)).toBeLessThan(1.5);
  await page.locator('#video-pos-right').click();
  await settle(page);
  g = await geometry(page);
  expect(Math.abs(g.video.x + g.video.w - g.frame.w)).toBeLessThan(1.5);
  expect(g.frame).toEqual(before.frame); // the canvas never moves

  // Scale: the video shrinks about its centre; the background shows where it was.
  await page.locator('#video-pos-center').click();
  await page.evaluate(() => window.__composition.setVideoValue('scale', 0.5));
  await settle(page);
  g = await geometry(page);
  expect(g.video.h).toBeCloseTo(before.video.h * 0.5, 0);
  expect(near(await colourAt(page, 0.5, 0.1), [255, 255, 255])).toBe(true);

  // Corners, border, shadow.
  await page.evaluate(() => {
    window.__composition.patchVideoStyle('cornerRadius', { cornerRadius: 20 });
    window.__composition.patchVideoStyle('border', { enabled: true, width: 6, color: '#E11D48' });
  });
  await settle(page);
  g = await geometry(page);
  const edgeY = (g.video.y + g.video.h / 2) / g.frame.h;
  const justLeft = (g.video.x - 3) / g.frame.w;
  expect(near(await colourAt(page, justLeft, edgeY), [0xe1, 0x1d, 0x48], 30), 'the border, outside the video\'s left edge').toBe(true);
  expect(await page.evaluate(() => document.getElementById('preview-video').style.borderRadius)).not.toBe('');
  await page.evaluate(() => window.__composition.patchVideoStyle('shadow', { enabled: true, blur: 10, offsetY: 20, opacity: 80 }));
  await settle(page);
  const belowY = (g.video.y + g.video.h + 14) / g.frame.h;
  const shade = await colourAt(page, 0.5, belowY);
  expect(shade[0], `the shadow below the video (${shade})`).toBeLessThan(200);

  // Rotation turns the video, not the canvas.
  await page.evaluate(() => window.__composition.setVideoValue('rotation', 30));
  await settle(page);
  expect((await geometry(page)).frame).toEqual(before.frame);
  expect(await page.evaluate(() => document.getElementById('preview-video').style.transform)).toMatch(/rotate\(30deg\)/);
});

test('dragging the video on the canvas moves it in canvas space, as one undo step', async ({ page }) => {
  await openDemo(page);
  await openCanvasPanel(page);
  await page.locator('#canvas-ratio-1x1').click();
  await settle(page);
  await page.evaluate(() => window.__composition.selectVideoTarget());
  await settle(page);
  const box = await page.locator('#video-transform-box').boundingBox();
  const g = await geometry(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + g.frame.w * 0.2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const t = await page.evaluate(() => window.__appState.videoTransform);
  expect(t.offsetXPct).toBeCloseTo(20, 0);
  // The box follows the video.
  const moved = await page.locator('#video-transform-box').boundingBox();
  expect(moved.x - box.x).toBeCloseTo(g.frame.w * 0.2, -1);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect((await page.evaluate(() => window.__appState.videoTransform))?.offsetXPct || 0).toBe(0);
});

test('undo, redo and reload keep the canvas and the video\'s styling', async ({ page }) => {
  await openDemo(page);
  await openCanvasPanel(page);
  await page.locator('#canvas-ratio-16x9').click();
  await page.locator('#canvas-bg-white').click();
  await page.evaluate(() => window.__composition.patchVideoStyle('border', { enabled: true, width: 5, color: '#22D3EE' }));
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect(await page.evaluate(() => window.__appState.videoStyle?.border?.enabled || false)).toBe(false);
  await undo.click();
  expect(await page.evaluate(() => window.__appState.composition.background.color)).toBe('#000000');
  const redo = page.getByRole('button', { name: 'Redo (Ctrl+Y)' });
  await redo.click();
  expect(await page.evaluate(() => window.__appState.composition.background.color)).toBe('#FFFFFF');
  await redo.click();
  expect(await page.evaluate(() => window.__appState.videoStyle.border.color)).toBe('#22D3EE');
  const saved = await page.evaluate(() => [window.__appState.composition, window.__appState.videoStyle]);
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await settle(page);
  expect(await page.evaluate(() => [window.__appState.composition, window.__appState.videoStyle])).toEqual(saved);
  const g = await geometry(page);
  expect(Math.abs(g.frame.w / g.frame.h - 16 / 9)).toBeLessThan(0.01);
});

test('layers keep their places in canvas space: a shape on a square canvas sits where the canvas says', async ({ page }) => {
  await openDemo(page);
  await openCanvasPanel(page);
  await page.locator('#canvas-ratio-1x1').click();
  await page.locator('#canvas-bg-white').click();
  await settle(page);
  await page.evaluate(() => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0 });
    window.__shapeLayers.patchShapeLayer(s.id, 'transform', { x: 10, y: 10, width: 10, height: 10 });
    window.__shapeLayers.patchShapeLayer(s.id, 'fill', { color: '#16A34A' });
    window.__shapeLayers.selectShapeLayer(null);
  });
  await settle(page);
  // (10%, 10%) of the canvas — on the background, well outside the video.
  expect(near(await colourAt(page, 0.1, 0.1), [0x16, 0xa3, 0x4a], 30)).toBe(true);
});
