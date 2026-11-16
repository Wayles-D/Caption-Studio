import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { openTool } from './helpers/dock.js';
import { buildFullTimelineSegments } from '../../backend/utils/graphicsFrameGenerator.js';
import { registerBackendCanvasFonts } from '../../backend/utils/graphicsFontLoader.js';
import { videoHomographyAt } from '../../shared/videoTransform.js';
import { projectedQuad } from '../../shared/transform3d.js';

// V2.4.0 — UNIVERSAL 3D TRANSFORMS, driven through the real editor:
//  - each object's panel has the same 3D card; switching it on and picking a
//    surface writes the object's transform3d (one undo step);
//  - the PREVIEW's pixels match the EXPORT's: the real frame generator
//    (buildFullTimelineSegments, the file's own code path) is run on the
//    exact style params the editor would send, at the preview canvas's size,
//    and the two masks compared;
//  - undo/redo and reopening the project keep it;
//  - the video tilts in the preview through the same homography the export
//    uses (its on-screen box is the projected quad).
const here = path.dirname(fileURLToPath(import.meta.url));
const requireBackend = createRequire(path.join(here, '..', '..', 'backend', 'package.json'));
const { createCanvas, loadImage } = requireBackend('@napi-rs/canvas');
registerBackendCanvasFonts();
const SP = process.env.BHYND_SHOTS || null;

async function openDemo(page, theme = 'dark') {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate((t) => new Promise((r) => {
    localStorage.clear();
    localStorage.setItem('bhynd-theme', JSON.stringify({ state: { theme: t }, version: 0 }));
    const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r();
  }), theme);
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(400);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((r) => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.addEventListener('seeked', () => r(), { once: true });
    v.currentTime = time;
  }), t);
  // A few painted frames after the seek: under load the preview's redraw can
  // trail it, and a mask read too early is the previous moment's.
  await page.waitForTimeout(400);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await page.waitForTimeout(200);
}

/** The preview layer canvas's alpha, its size, and the style params the export would be sent. */
async function previewLayer(page, canvasId) {
  return page.evaluate((id) => {
    const c = document.getElementById(id);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const alpha = new Uint8Array(c.width * c.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    return { w: c.width, h: c.height, alpha: Array.from(alpha), params: window.__getStyleParams() };
  }, canvasId);
}

/** The export's layer frame at `time`, drawn by the real frame generator at the preview's size. */
async function exportLayer(params, w, h, time) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-3d-e2e-'));
  try {
    const { runs } = await buildFullTimelineSegments([], params, w, h, 10, dir, { frameRate: '30' });
    const run = runs.find((r) => !r.beneathCaptions);
    const seg = run?.segments.find((s) => s.start <= time && s.end > time);
    if (!seg) return new Uint8Array(w * h);
    const img = await loadImage(fs.readFileSync(seg.file));
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0);
    const data = c.getContext('2d').getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    return alpha;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Intersection over union of two alpha masks (solid pixels). */
function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > 100, y = b[i] > 100;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 1;
}

test('a shape on the floor: the 3D card writes it, and the preview matches the export pixel for pixel', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }).id);
  await page.evaluate((i) => window.__shapeLayers.selectShapeLayer(i), id);
  await expect(page.locator('#shape-3d-card')).toBeVisible();
  // Off until switched on: the shape is still the plain 2D object it was.
  expect(await page.evaluate((i) => window.__shapeLayers.getShapeLayer(i).transform3d, id)).toBeUndefined();
  await seek(page, 1);
  const flat = await previewLayer(page, 'text-elements-canvas');

  await page.locator('#shape-3d-enabled-on').click();
  await page.locator('#shape-3d-preset-floor').click();
  await expect(page.locator('#shape-3d-preset-floor')).toHaveAttribute('aria-pressed', 'true');
  const t3d = await page.evaluate((i) => window.__shapeLayers.getShapeLayer(i).transform3d, id);
  expect(t3d).toMatchObject({ enabled: true, rotateX: 62, originY: 100 });
  await seek(page, 1);
  if (SP) await page.screenshot({ path: `${SP}/3d-shape-floor.png` });

  const tilted = await previewLayer(page, 'text-elements-canvas');
  const solid = (a) => a.reduce((n, v) => n + (v > 100 ? 1 : 0), 0);
  expect(solid(tilted.alpha)).toBeLessThan(solid(flat.alpha) * 0.75); // it really tipped back
  const exported = await exportLayer(tilted.params, tilted.w, tilted.h, 1);
  const match = iou(tilted.alpha, exported);
  const vsFlat = iou(flat.alpha, exported);
  console.log(`shape on a floor: preview vs export IoU ${match.toFixed(4)} (vs the flat shape: ${vsFlat.toFixed(3)})`);
  expect(match).toBeGreaterThan(0.98);
  expect(vsFlat).toBeLessThan(0.8);
});

test('text on a wall and an image tilted: preview matches export; the 3D entrance turns it in', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'ON THE WALL' }).id);
  await page.evaluate((i) => window.__textElements.selectTextElement(i), id);
  await expect(page.locator('#textel-3d-card')).toBeVisible();
  // The baseline: FLAT text, preview vs export. The browser and the exporter
  // rasterise glyph edges a little differently, so text never overlaps 100%;
  // 3D must not make that any worse.
  await seek(page, 1.5);
  const flatPreview = await previewLayer(page, 'text-elements-canvas');
  const flatMatch = iou(flatPreview.alpha, await exportLayer(flatPreview.params, flatPreview.w, flatPreview.h, 1.5));

  await page.locator('#textel-3d-enabled-on').click();
  await page.locator('#textel-3d-preset-wall-left').click();
  expect(await page.evaluate((i) => window.__textElements.getTextElement(i).transform3d, id)).toMatchObject({ enabled: true, rotateY: 50, originX: 0 });
  await seek(page, 1.5);
  if (SP) await page.screenshot({ path: `${SP}/3d-text-wall.png` });
  const preview = await previewLayer(page, 'text-elements-canvas');
  const exported = await exportLayer(preview.params, preview.w, preview.h, 1.5);
  const match = iou(preview.alpha, exported);
  console.log(`text: flat preview vs export IoU ${flatMatch.toFixed(4)}; on a wall ${match.toFixed(4)}; flat vs wall ${iou(flatPreview.alpha, exported).toFixed(3)}`);
  expect(match).toBeGreaterThan(flatMatch - 0.03);
  expect(iou(flatPreview.alpha, exported)).toBeLessThan(0.5);

  // A 3D entrance (the Universal Motion engine): mid-way it is turned away
  // further than at rest; at rest it is exactly the wall again.
  await page.evaluate((i) => window.__textElements.updateTextElementStyle(i, { captionAnimationType: 'swing-in', captionAnimationDuration: 1 }), id);
  await seek(page, 0.3);
  const midway = await previewLayer(page, 'text-elements-canvas');
  const midExport = await exportLayer(midway.params, midway.w, midway.h, 0.3);
  const midMatch = iou(midway.alpha, midExport);
  console.log(`swing-in at 0.3s: preview vs export IoU ${midMatch.toFixed(4)}`);
  expect(midMatch).toBeGreaterThan(0.85);
  await seek(page, 1.5);
  const after = await previewLayer(page, 'text-elements-canvas');
  expect(iou(after.alpha, preview.alpha)).toBeGreaterThan(0.99);
  // The entrance never wrote into the element's resting 3D settings.
  expect(await page.evaluate((i) => window.__textElements.getTextElement(i).transform3d, id)).toMatchObject({ rotateY: 50, rotateX: 0 });
});

test('the text 3D card stays while one of its words is being edited (it used to vanish)', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'HELLO THERE FRIEND' }));
  await page.waitForTimeout(500);
  await page.locator('.timeline-text-clip').first().click();
  await page.locator('#textel-3d-enabled-on').click();
  await expect(page.locator('#textel-3d-card')).toBeVisible();
  // Click the text on the video, then a word in it: the panel switches to
  // "Editing one word" — and the 3D card must still be there.
  await seek(page, 1);
  const box = await page.locator('#caption-transform-box').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await expect(page.locator('#textel-word-editing')).toBeVisible();
  await expect(page.locator('#textel-3d-card')).toBeVisible();
  await page.locator('#textel-3d-preset-floor').click();
  expect(await page.evaluate(() => window.__appState.textElements[0].transform3d)).toMatchObject({ enabled: true, rotateX: 62 });
  await page.locator('#textel-edit-whole').click();
  await expect(page.locator('#textel-3d-card')).toBeVisible();
});

test('undo, redo, duplicate and reopening the project keep the 3D settings', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__shapeLayers.addShapeLayer('ellipse', { start: 0 }).id);
  await page.evaluate((i) => window.__shapeLayers.selectShapeLayer(i), id);
  await page.locator('#shape-3d-enabled-on').click();
  await page.locator('#shape-3d-preset-tilted').click();
  const get = () => page.evaluate((i) => window.__shapeLayers.getShapeLayer(i)?.transform3d || null, id);
  expect(await get()).toMatchObject({ enabled: true, rotateX: 24, rotateY: -18 });

  await page.keyboard.press('Control+z');
  expect(await get()).toMatchObject({ enabled: true, rotateX: 0, rotateY: 0 });
  await page.keyboard.press('Control+z');
  expect((await get())?.enabled ?? false).toBe(false);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  expect(await get()).toMatchObject({ enabled: true, rotateX: 24, rotateY: -18 });

  // Duplicated: the copy stands at the same angle.
  const copyId = await page.evaluate((i) => window.__shapeLayers.duplicateShapeLayer?.(i)?.id || null, id);
  if (copyId) expect(await page.evaluate((i) => window.__shapeLayers.getShapeLayer(i).transform3d, copyId)).toMatchObject({ rotateX: 24, rotateY: -18 });

  // Reopened: the project autosaves; a reload brings it back tilted.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => (window.__appState?.shapeLayers || []).length > 0, null, { timeout: 15000 });
  expect(await get()).toMatchObject({ enabled: true, rotateX: 24, rotateY: -18 });
});

test('the video in 3D: the Canvas panel tilts it, and on screen it fills the projected quad', async ({ page }) => {
  await openDemo(page);
  await openTool(page, 'Canvas');
  await expect(page.locator('#video-3d-card')).toBeVisible();
  await page.locator('#video-3d-enabled-on').click();
  await page.locator('#video-3d-preset-floor').click();
  await page.waitForTimeout(400);
  if (SP) await page.screenshot({ path: `${SP}/3d-video-floor.png` });
  const shown = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    const s = document.getElementById('state-video');
    const r = v.getBoundingClientRect(), f = s.getBoundingClientRect();
    return { transform: v.style.transform, box: { x: r.x - f.x, y: r.y - f.y, w: r.width, h: r.height }, frame: { w: s.clientWidth, h: s.clientHeight }, vt: window.__appState.videoTransform };
  });
  expect(shown.transform).toContain('matrix3d');
  // What the export's homography says the video's outline is, at this frame size.
  const h = videoHomographyAt(shown.vt, 0, { canvasWidth: shown.frame.w, canvasHeight: shown.frame.h, boxWidth: shown.frame.w, boxHeight: shown.frame.h });
  const quad = projectedQuad(h, { centerX: shown.frame.w / 2, centerY: shown.frame.h / 2, width: shown.frame.w, height: shown.frame.h });
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const expected = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  console.log('video on a floor, on screen:', JSON.stringify(shown.box), 'projected:', JSON.stringify(expected));
  for (const k of ['x', 'y', 'w', 'h']) expect(Math.abs(shown.box[k] - expected[k])).toBeLessThan(1.5);
});

test('the 3D card reads in light mode', async ({ page }) => {
  await openDemo(page, 'light');
  const id = await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }).id);
  await page.evaluate((i) => window.__shapeLayers.selectShapeLayer(i), id);
  await page.locator('#shape-3d-enabled-on').click();
  await page.locator('#shape-3d-preset-wall-right').click();
  await page.locator('#shape-3d-card').scrollIntoViewIfNeeded();
  if (SP) await page.locator('#shape-3d-card').screenshot({ path: `${SP}/3d-card-light.png` });
  await expect(page.locator('#shape-3d-preset-wall-right')).toHaveAttribute('aria-pressed', 'true');
});
