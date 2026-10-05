import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// SHAPE LAYERS (shared/shapeLayer.js) and THE LAYER STACK
// (shared/visualLayers.js), through the real UI, checked on the pixels the
// preview draws.
//
// Hits :5173 explicitly (caption fonts come from the backend, whose CORS
// allowlist covers :5173 only). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const PICTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'test-image.png');

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

/** A shape of a kind, through the timeline's "+ Shape" menu, at the playhead. */
async function addShape(page, kind, at = 1) {
  await seek(page, at);
  const n = await page.evaluate(() => (window.__appState.shapeLayers || []).length);
  await page.locator('#timeline-add-shape-btn').click();
  await page.locator(`#timeline-shape-menu [data-shape-kind="${kind}"]`).click();
  await page.waitForFunction((k) => window.__appState.shapeLayers.length === k + 1, n);
  await seek(page, at + 0.5);
  return page.evaluate(() => window.__appState.shapeLayers.at(-1));
}

async function addImage(page, at = 1) {
  await seek(page, at);
  const n = await page.evaluate(() => (window.__appState.imageLayers || []).length);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#timeline-add-image-btn').click();
  await (await chooser).setFiles(PICTURE);
  await page.waitForFunction((k) => window.__appState.imageLayers.length === k + 1, n);
  await page.waitForTimeout(400);
  await seek(page, at + 0.5);
  return page.evaluate(() => window.__appState.imageLayers.at(-1));
}

const shape = (page, id) => page.evaluate((i) => window.__appState.shapeLayers.find((s) => s.id === i), id);
const stackIds = (page) => page.evaluate(() => window.__layerStack.getLayerStack().map((e) => e.id));
const shapeRect = async (page, id) => (await page.evaluate(() => window.__debugShapeRects())).find((r) => r.id === id);

/** The topmost opaque pixel the preview shows at a frame point: which canvas, what colour. */
const topAt = (page, x, y) => page.evaluate(([px, py]) => {
  const frame = document.getElementById('preview-video').getBoundingClientRect();
  const canvases = Array.from(document.querySelectorAll('#state-video canvas')).filter((c) => c.classList.contains('active'));
  // Topmost first: by z-index, then DOM order.
  canvases.sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0)
    || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1));
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const s = c.width / r.width;
    const d = c.getContext('2d').getImageData(Math.round((frame.x + px - r.left) * s), Math.round((frame.y + py - r.top) * s), 1, 1).data;
    if (d[3] > 200) return { canvas: c.id, rgb: [d[0], d[1], d[2]] };
  }
  return null;
}, [x, y]);

test('every kind is created from the "+ Shape" menu, drawn at the playhead, on its lane, selected', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openDemo(page);
  for (const kind of ['rectangle', 'rounded', 'ellipse', 'line', 'arrow', 'pill']) {
    const s = await addShape(page, kind, 1);
    expect(s.kind).toBe(kind);
    expect(await page.evaluate(() => window.__appState.selectedShapeLayerId)).toBe(s.id);
    const r = await shapeRect(page, s.id);
    // White by default: its centre is white on screen.
    const c = await topAt(page, r.centerX, r.centerY);
    expect(c.rgb.every((v) => v > 230)).toBe(true);
  }
  await expect(page.locator('#timeline-shapes-track .timeline-text-clip.is-shape')).toHaveCount(6);
  await expect(page.locator('#shape-editor')).toBeVisible();
  expect(errs).toEqual([]);
});

test('on the video: drag, resize, rotate — one undo each; a click changes nothing', async ({ page }) => {
  await openDemo(page);
  const s = await addShape(page, 'rectangle');
  const frame = await page.locator('#preview-video').boundingBox();
  let r = await shapeRect(page, s.id);
  await page.mouse.click(frame.x + r.centerX, frame.y + r.centerY);
  expect((await shape(page, s.id)).transform).toEqual(s.transform);
  await page.mouse.move(frame.x + r.centerX, frame.y + r.centerY);
  await page.mouse.down();
  await page.mouse.move(frame.x + r.centerX - 30, frame.y + r.centerY + 40, { steps: 6 });
  await page.mouse.up();
  let t = (await shape(page, s.id)).transform;
  expect(t.x).toBeLessThan(s.transform.x - 5);
  expect(t.y).toBeGreaterThan(s.transform.y + 3);
  const corner = page.locator('#caption-transform-box .caption-transform-handle[data-handle="br"]');
  const cb = await corner.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 40, cb.y + cb.height / 2 + 25, { steps: 6 });
  await page.mouse.up();
  expect((await shape(page, s.id)).transform.scale).toBeGreaterThan(1.15);
  const rot = await page.locator('#caption-transform-handle-rotate').boundingBox();
  await page.mouse.move(rot.x + rot.width / 2, rot.y + rot.height / 2);
  await page.mouse.down();
  await page.mouse.move(rot.x + rot.width / 2 + 70, rot.y + rot.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await shape(page, s.id)).transform.rotation)).toBeGreaterThan(10);
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect((await shape(page, s.id)).transform.rotation).toBe(0);
  await undo.click();
  expect((await shape(page, s.id)).transform.scale).toBe(1);
  await undo.click();
  expect((await shape(page, s.id)).transform).toEqual(s.transform);
  r = await shapeRect(page, s.id);
  expect(r.width).toBeGreaterThan(0);
});

test('the Shape panel: fill, opacity, border, corners, shadow, timing — each reaches the shape and undoes', async ({ page }) => {
  await openDemo(page);
  const s = await addShape(page, 'rounded');
  const set = async (sel, v) => { await page.locator(sel).focus(); await page.locator(sel).fill(String(v)); };
  await set('#shape-opacity', 50);
  await set('#shape-radius', 40);
  await page.locator('#shape-border-on').click();
  await page.locator('#shape-shadow-on').click();
  await page.locator('#shape-fill-off').click();
  await page.locator('#shape-end').fill('2.5');
  await page.locator('#shape-end').press('Enter');
  const l = await shape(page, s.id);
  expect(l.transform.opacity).toBe(50);
  expect(l.appearance.cornerRadius).toBe(40);
  expect(l.appearance.border.enabled).toBe(true);
  expect(l.appearance.shadow.enabled).toBe(true);
  expect(l.appearance.fill.enabled).toBe(false);
  expect(l.end).toBeCloseTo(2.5, 6);
  // No fill: the shape's middle shows what is beneath it, not white.
  await seek(page, 1.6);
  const r = await shapeRect(page, s.id);
  const c = await topAt(page, r.centerX, r.centerY);
  expect(c?.canvas === 'text-elements-canvas' && c.rgb.every((v) => v > 230)).toBe(false);
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect((await shape(page, s.id)).end).toBeCloseTo(4, 6);
  await undo.click();
  expect((await shape(page, s.id)).appearance.fill.enabled).toBe(true);
});

test('one stack across types: a shape goes beneath the captions and back above them; a picture and a shape swap', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  const s = await addShape(page, 'ellipse', 1);
  // Default: the newest shape on top, the picture beneath the captions.
  let ids = await stackIds(page);
  expect(ids.at(-1)).toBe(s.id);
  expect(ids.indexOf(img.id)).toBeLessThan(ids.indexOf('captions'));
  // The ellipse sits on the picture's centre: the topmost pixel there is the white ellipse.
  const r = await shapeRect(page, s.id);
  let c = await topAt(page, r.centerX, r.centerY);
  expect(c.rgb.every((v) => v > 230)).toBe(true);

  // Send the shape to the back: now beneath the picture too — the picture shows, not the white shape.
  await page.locator('#shape-to-back').click();
  ids = await stackIds(page);
  expect(ids[0]).toBe(s.id);
  await seek(page, 1.51);
  c = await topAt(page, r.centerX, r.centerY);
  expect(c.rgb.every((v) => v > 230)).toBe(false);

  // In the Layers panel: bring the shape back up, one place at a time, past the picture.
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.locator(`[data-layer-up="${s.id}"]`).click();
  ids = await stackIds(page);
  expect(ids.indexOf(s.id)).toBeGreaterThan(ids.indexOf(img.id));
  expect(ids.indexOf(s.id)).toBeLessThan(ids.indexOf('captions'));
  await seek(page, 1.52);
  c = await topAt(page, r.centerX, r.centerY);
  expect(c.rgb.every((v) => v > 230)).toBe(true);
  // Captions can be moved like anything else.
  await page.locator('[data-layer-down="captions"]').click();
  ids = await stackIds(page);
  expect(ids.indexOf('captions')).toBeLessThan(ids.indexOf(s.id));
  // Each restack is one undo step.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  ids = await stackIds(page);
  expect(ids.indexOf('captions')).toBeGreaterThan(ids.indexOf(s.id));
});

test('a shape and a text overlay: either can be on top', async ({ page }) => {
  await openDemo(page);
  const el = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0.5, text: 'ON TOP', style: { position: 'manual', customPosX: 50, customPosY: 50, fontSize: 40, inactiveWordColor: '#000000', activeWordColor: '#000000' } }));
  const s = await addShape(page, 'rectangle', 1);
  await page.evaluate((id) => window.__shapeLayers.patchShapeLayer(id, 'transform', { width: 90, height: 40 }), s.id);
  await seek(page, 1.6);
  const textRect = (await page.evaluate(() => window.__debugTextElementRects()))[0];
  // Count dark text pixels over the white rectangle — none while the shape is on top.
  const dark = () => page.evaluate((r) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const c = document.getElementById('text-elements-canvas');
    const cr = c.getBoundingClientRect();
    const k = c.width / cr.width;
    const d = c.getContext('2d').getImageData(Math.round((frame.x + r.centerX - r.width / 2 - cr.left) * k), Math.round((frame.y + r.centerY - r.height / 2 - cr.top) * k), Math.round(r.width * k), Math.round(r.height * k)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60 && d[i + 3] > 200) n++;
    return n;
  }, textRect);
  expect(await dark()).toBe(0);
  await page.evaluate((id) => window.__layerStack.moveLayer(id, 'front'), el.id);
  await seek(page, 1.61);
  expect(await dark()).toBeGreaterThan(50);
});

test('an entrance runs from the shape\'s own start, through the shared motion engine; its resting place is untouched', async ({ page }) => {
  await openDemo(page);
  const s = await addShape(page, 'rectangle', 3);
  await page.locator('#shape-entrance').selectOption('slide-up');
  const l = await shape(page, s.id);
  expect(l.motions).toEqual([{ kind: 'entrance', preset: 'slide-up', duration: 0.4, easing: 'ease-out', intensity: 1, anchor: 'self' }]);
  expect(l.transform).toEqual(s.transform);
  const ink = async (t) => {
    await seek(page, t);
    return page.evaluate(() => {
      const c = document.getElementById('text-elements-canvas');
      if (!c.classList.contains('active')) return { n: 0 };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; let sy = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) { n++; sy += Math.floor((i >> 2) / c.width); }
      return { n, cy: n ? sy / n : null };
    });
  };
  const atStart = await ink(3.0);
  const moving = await ink(3.08);
  const rest = await ink(3.6);
  expect(atStart.n).toBe(0);
  expect(moving.cy - rest.cy).toBeGreaterThan(1);
});

test('duplicate is independent; Delete removes it; Undo brings it back', async ({ page }) => {
  await openDemo(page);
  const s = await addShape(page, 'pill');
  await page.locator('#shape-duplicate').click();
  const copyId = await page.evaluate(() => window.__appState.selectedShapeLayerId);
  expect(copyId).not.toBe(s.id);
  await page.evaluate((id) => window.__shapeLayers.patchShapeLayer(id, 'fill', { color: '#FF0000' }), copyId);
  expect((await shape(page, s.id)).appearance.fill.color).toBe('#FFFFFF');
  await page.locator(`#timeline-shapes-track [data-clip-id="${copyId}"]`).click();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.__appState.shapeLayers.map((x) => x.id))).toEqual([s.id]);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect(await page.evaluate(() => window.__appState.shapeLayers.length)).toBe(2);
});

test('shapes and the layer order survive a reload', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  const s = await addShape(page, 'arrow', 1);
  await page.evaluate(([sid, iid]) => {
    window.__shapeLayers.patchShapeLayer(sid, 'fill', { color: '#22D3EE' });
    window.__shapeLayers.setShapeLayerEntrance(sid, { preset: 'pop', duration: 0.3 });
    window.__layerStack.moveLayer(sid, 'back');
    window.__layerStack.moveLayer(iid, 'front');
  }, [s.id, img.id]);
  const before = { shapes: await page.evaluate(() => window.__appState.shapeLayers), order: await stackIds(page) };
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('#state-video.active')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => window.__appState.shapeLayers)).toEqual(before.shapes);
  expect(await stackIds(page)).toEqual(before.order);
  await expect(page.locator('#timeline-shapes-track .timeline-text-clip.is-shape')).toHaveCount(1);
});
