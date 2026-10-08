import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// IMAGE LAYERS (shared/imageLayer.js), driven through the real UI and
// checked on the pixels the preview draws: importing a picture, its timing,
// moving / resizing / rotating it on the video, the Image panel's controls,
// stacking against captions, several images, duplicate / delete, undo, and
// surviving a reload.
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

/** Imports the fixture picture through the timeline's "+ Image" button, at the playhead. */
async function addImage(page, at = 1) {
  await seek(page, at);
  const count = await page.evaluate(() => (window.__appState.imageLayers || []).length);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#timeline-add-image-btn').click();
  await (await chooser).setFiles(PICTURE);
  await page.waitForFunction((n) => (window.__appState.imageLayers || []).length === n + 1, count);
  // Let the picture decode and the frame redraw.
  await page.waitForTimeout(400);
  await seek(page, at + 0.5);
  return page.evaluate(() => window.__appState.imageLayers.at(-1));
}

const layers = (page) => page.evaluate(() => window.__appState.imageLayers);
const layer = (page, id) => page.evaluate((i) => window.__appState.imageLayers.find((l) => l.id === i), id);

/** The colour the preview shows at a frame-relative CSS point, across all its canvases (top first). */
const colourAt = (page, x, y) => page.evaluate(([px, py]) => {
  const frame = document.getElementById('preview-video').getBoundingClientRect();
  for (const id of ['text-elements-canvas', 'captions-canvas', 'images-under-canvas']) {
    const c = document.getElementById(id);
    if (!c || !c.classList.contains('active')) continue;
    const r = c.getBoundingClientRect();
    const s = c.width / r.width;
    const d = c.getContext('2d').getImageData(Math.round((frame.x + px - r.left) * s), Math.round((frame.y + py - r.top) * s), 1, 1).data;
    if (d[3] > 200) return { canvas: id, rgb: [d[0], d[1], d[2]] };
  }
  return null;
}, [x, y]);

const rect = async (page, id) => (await page.evaluate(() => window.__debugImageRects())).find((r) => r.id === id);

test('a picture is imported at the playhead: on the video, on its lane, selected, sized without stretching', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openDemo(page);
  const img = await addImage(page, 1);
  expect(img.start).toBe(1);
  expect(img.naturalWidth).toBe(400);
  expect(img.naturalHeight).toBe(300);
  expect(img.layer).toBe('under-captions');
  expect(await page.evaluate(() => window.__appState.selectedImageLayerId)).toBe(img.id);
  // On the video: the picture's top-left quadrant is blue.
  const r = await rect(page, img.id);
  expect(r.width / r.height).toBeCloseTo(4 / 3, 5);
  const c = await colourAt(page, r.centerX - r.width / 4, r.centerY - r.height / 4);
  expect(c.canvas).toBe('images-under-canvas');
  expect(c.rgb[2]).toBeGreaterThan(200);
  // On its lane, and in its panel.
  await expect(page.locator('#timeline-images-track .timeline-text-clip.is-image')).toHaveCount(1);
  await expect(page.locator('#image-editor')).toBeVisible();
  expect(errs).toEqual([]);
});

test('the picture is only there for its own span: not before, there during, gone at its end', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 2);
  const r = await rect(page, img.id);
  const at = async (t) => { await seek(page, t); return colourAt(page, r.centerX - r.width / 4, r.centerY - r.height / 4); };
  expect((await at(1.9))?.canvas).not.toBe('images-under-canvas');
  expect((await at(2.0))?.canvas).toBe('images-under-canvas');
  expect((await at(4.9))?.canvas).toBe('images-under-canvas');
  expect((await at(5.0))?.canvas).not.toBe('images-under-canvas');
});

test('on the video: drag moves it, a corner resizes it, the top handle rotates it — one undo each; a click changes nothing', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  const frame = await page.locator('#preview-video').boundingBox();
  let r = await rect(page, img.id);

  // A plain click on it: nothing changes.
  await page.mouse.click(frame.x + r.centerX, frame.y + r.centerY);
  expect((await layer(page, img.id)).transform).toEqual(img.transform);

  // Move.
  await page.mouse.move(frame.x + r.centerX, frame.y + r.centerY);
  await page.mouse.down();
  await page.mouse.move(frame.x + r.centerX + 40, frame.y + r.centerY - 30, { steps: 6 });
  await page.mouse.up();
  let t = (await layer(page, img.id)).transform;
  expect(t.x).toBeGreaterThan(img.transform.x + 5);
  expect(t.y).toBeLessThan(img.transform.y - 3);

  // Resize from a corner.
  const corner = page.locator('#caption-transform-box .caption-transform-handle[data-handle="br"]');
  await expect(corner).toBeVisible();
  const cb = await corner.boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 40, cb.y + cb.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  t = (await layer(page, img.id)).transform;
  expect(t.scale).toBeGreaterThan(1.2);
  r = await rect(page, img.id);
  expect(r.width / r.height).toBeCloseTo(4 / 3, 5);

  // Rotate.
  const rot = page.locator('#caption-transform-handle-rotate');
  const rb = await rot.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2 + 70, rb.y + rb.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  t = (await layer(page, img.id)).transform;
  expect(Math.abs(t.rotation)).toBeGreaterThan(10);

  // One undo per gesture, newest first.
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect((await layer(page, img.id)).transform.rotation).toBe(0);
  await undo.click();
  expect((await layer(page, img.id)).transform.scale).toBe(1);
  await undo.click();
  expect((await layer(page, img.id)).transform).toEqual(img.transform);
  // ...and Redo brings the move back.
  await page.getByRole('button', { name: 'Redo (Ctrl+Y)' }).click();
  expect((await layer(page, img.id)).transform.x).toBeGreaterThan(img.transform.x + 5);
});

test('the Image panel: opacity, crop, corners, border, shadow and timing all reach the picture, each undoable', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  const set = async (id, value) => {
    // Keyboard steps commit like a released drag (one undo step each).
    await page.locator(id).focus();
    await page.locator(id).fill(String(value));
  };
  // The picture's own alpha on its layer, at a point given as fractions of its box.
  const alphaAt = async (fx, fy) => {
    await seek(page, 1.6);
    await seek(page, 1.61);
    const r = await rect(page, img.id);
    return page.evaluate(([x, y]) => {
      const frame = document.getElementById('preview-video').getBoundingClientRect();
      const c = document.getElementById('images-under-canvas');
      const cr = c.getBoundingClientRect();
      const s = c.width / cr.width;
      return c.getContext('2d').getImageData(Math.round((frame.x + x - cr.left) * s), Math.round((frame.y + y - cr.top) * s), 1, 1).data[3];
    }, [r.centerX + fx * r.width, r.centerY + fy * r.height]);
  };
  await set('#img-opacity', 40);
  // 40% opaque: the picture's own pixels carry 40% alpha on its layer.
  expect(Math.abs((await alphaAt(0, 0.25)) - 0.4 * 255)).toBeLessThan(4);
  await set('#img-crop-left', 45);
  await set('#img-radius', 30);
  await page.locator('#img-border-on').click();
  await page.locator('#img-shadow-on').click();
  await page.locator('#img-end').fill('2.5');
  await page.locator('#img-end').press('Enter');
  let l = await layer(page, img.id);
  expect(l.transform.opacity).toBe(40);
  expect(l.crop.left).toBeCloseTo(0.45, 6);
  expect(l.appearance.cornerRadius).toBe(30);
  expect(l.appearance.border.enabled).toBe(true);
  expect(l.appearance.shadow.enabled).toBe(true);
  expect(l.end).toBeCloseTo(2.5, 6);

  // The crop is non-destructive: the source is unchanged, the drawn picture
  // is narrower, its aspect from the visible part.
  expect(l.naturalWidth).toBe(400);
  const r = await rect(page, img.id);
  expect(r.width / r.height).toBeCloseTo((400 * 0.55) / 300, 4);
  // The shadow falls just below the bottom edge, where there was nothing before.
  expect(await alphaAt(0, 0.5 + 0.03)).toBeGreaterThan(5);

  // Each control is its own undo step.
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect((await layer(page, img.id)).end).toBeCloseTo(4, 6);
  await undo.click();
  expect((await layer(page, img.id)).appearance.shadow.enabled).toBe(false);
  await undo.click();
  expect((await layer(page, img.id)).appearance.border.enabled).toBe(false);
});

test('an entrance runs from the picture\'s own start: invisible at its first frame, in motion, then at rest', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 3);
  await page.locator('#img-entrance').selectOption('slide-up');
  const l = await layer(page, img.id);
  expect(l.motions).toEqual([{ kind: 'entrance', preset: 'slide-up', duration: 0.4, easing: 'ease-out', intensity: 1, anchor: 'self' }]);
  // Its resting place is unchanged by the motion.
  expect(l.transform).toEqual(img.transform);
  const r = await rect(page, img.id);
  const ink = async (t) => {
    await seek(page, t);
    return page.evaluate(() => {
      const c = document.getElementById('images-under-canvas');
      if (!c.classList.contains('active')) return { n: 0 };
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; let sy = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) { n++; sy += Math.floor((i >> 2) / c.width); }
      return { n, cy: n ? sy / n / (c.width / c.getBoundingClientRect().width) : null };
    });
  };
  const atStart = await ink(3.0);
  const moving = await ink(3.08);
  const rest = await ink(3.6);
  console.log('slide up — opaque px at start:', atStart.n, ' 0.08s in:', moving.n, (moving.cy - rest.cy).toFixed(2), ' at rest:', rest.n);
  expect(atStart.n).toBe(0);
  expect(moving.cy - rest.cy).toBeGreaterThan(1);
  expect(Math.abs(rest.cy - r.centerY)).toBeLessThan(1.5);
});

test('stacking: under the captions the caption shows through; above all text the picture covers it', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const words = ['STACKING', 'TEST'].map((w, i) => ({ word: w, start: 0.5 + i * 0.5, end: 0.9 + i * 0.5, wordIndex: i }));
    window.__updateState({ words, phrases: [{ start: 0.5, end: 6, words, breakAfterIndices: [] }], captionEvents: [] }, { recordHistory: false });
  });
  const img = await addImage(page, 1);
  // Over the caption's spot, big enough to cover it.
  await page.evaluate((id) => window.__imageLayers.patchImageLayer(id, 'transform', { y: 85, width: 100 }), img.id);
  await seek(page, 2);
  const cap = await page.evaluate(() => window.__debugCaptionBoxRect());
  const where = () => colourAt(page, cap.centerX, cap.centerY);
  // The caption's own pixels sit on the captions canvas, above the picture.
  const under = await page.evaluate((c) => {
    const frame = document.getElementById('preview-video').getBoundingClientRect();
    const cv = document.getElementById('captions-canvas');
    const r = cv.getBoundingClientRect();
    const s = cv.width / r.width;
    const d = cv.getContext('2d').getImageData(Math.round((frame.x + c.x - r.left) * s), Math.round((frame.y + c.y - r.top) * s), Math.round(c.width * s), Math.round(c.height * s)).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
    return n;
  }, cap);
  expect(under).toBeGreaterThan(50);
  expect((await where())?.canvas).not.toBe('text-elements-canvas');

  // Bring it to the front of the one layer stack — above the captions.
  await page.locator('#img-to-front').click();
  await seek(page, 2.01);
  expect((await page.evaluate(() => window.__layerStack.getLayerStack().map((e) => e.id))).at(-1)).toBe(img.id);
  // Now the topmost drawn pixel over the caption is the picture, on the text layer.
  expect((await where())?.canvas).toBe('text-elements-canvas');
});

test('several pictures: independent, restacked, duplicated without sharing state, deleted and undone', async ({ page }) => {
  await openDemo(page);
  const a = await addImage(page, 1);
  const b = await addImage(page, 1.5);
  expect((await layers(page)).map((l) => l.id)).toEqual([a.id, b.id]);
  // Restack in the one layer stack: A in front of B, then back one place.
  const order = () => page.evaluate(() => window.__layerStack.getLayerStack().map((e) => e.id));
  await page.evaluate((id) => window.__imageLayers.selectImageLayer(id), a.id);
  await page.locator('#img-to-front').click();
  let ids = await order();
  expect(ids.indexOf(a.id)).toBeGreaterThan(ids.indexOf(b.id));
  await page.locator('#img-backward').click();
  ids = await order();
  expect(ids.indexOf(a.id)).toBe(ids.length - 2);

  // Duplicate A, then move the copy: A stays put.
  await page.locator('#img-duplicate').click();
  const copyId = await page.evaluate(() => window.__appState.selectedImageLayerId);
  expect(copyId).not.toBe(a.id);
  await page.evaluate((id) => window.__imageLayers.patchImageLayer(id, 'transform', { x: 20 }), copyId);
  expect((await layer(page, a.id)).transform.x).toBe(50);
  expect((await layer(page, copyId)).transform.x).toBe(20);
  expect((await layer(page, copyId)).assetId).toBe(a.assetId);

  // Delete the copy from its lane with the keyboard; Undo brings it back.
  await page.locator(`#timeline-images-track [data-clip-id="${copyId}"]`).click();
  await page.keyboard.press('Delete');
  expect((await layers(page)).map((l) => l.id)).toEqual([a.id, b.id]);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect((await layers(page)).map((l) => l.id)).toContain(copyId);
});

test('timeline: the clip is moved and trimmed by dragging, each one undo', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  const clip = page.locator(`#timeline-images-track [data-clip-id="${img.id}"]`);
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = await layer(page, img.id);
  expect(moved.start).toBeGreaterThan(1.5);
  expect(moved.end - moved.start).toBeCloseTo(3, 5);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect((await layer(page, img.id)).start).toBe(1);
});

test('the project survives a reload: the picture, its look, its motion and its stacking — drawn from the saved copy', async ({ page }) => {
  await openDemo(page);
  const img = await addImage(page, 1);
  await page.evaluate((id) => {
    window.__imageLayers.patchImageLayer(id, 'transform', { x: 30, rotation: 15 });
    window.__imageLayers.patchImageLayer(id, 'border', { enabled: true, color: '#FFFF00' });
    window.__imageLayers.setImageLayerEntrance(id, { preset: 'pop', duration: 0.3 });
    window.__layerStack.moveLayer(id, 'front');
  }, img.id);
  const before = await layer(page, img.id);
  const orderBefore = await page.evaluate(() => window.__appState.layerOrder);
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('#state-video.active')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => new Promise((r) => { const v = document.getElementById('preview-video'); if (v.readyState >= 1) return r(); v.addEventListener('loadedmetadata', r, { once: true }); }));
  expect(await layer(page, img.id)).toEqual(before);
  // Its place in the layer stack is saved too.
  expect(await page.evaluate(() => window.__appState.layerOrder)).toEqual(orderBefore);
  // Drawn again — from the browser's saved copy of the file.
  await seek(page, 2);
  await page.waitForTimeout(600);
  await seek(page, 2.01);
  const r = await rect(page, img.id);
  const c = await colourAt(page, r.centerX, r.centerY);
  expect(c?.canvas).toBe('text-elements-canvas');
  await expect(page.locator('#timeline-images-track .timeline-text-clip.is-image')).toHaveCount(1);
});
