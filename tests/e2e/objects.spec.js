import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { sampleTimes } from '../../shared/objects/detections.js';
import { serveVideo } from './serveVideo.js';

// OBJECT DETECTION & SELECTION in the real editor (src/js/components/
// objectDetection.js, objectOverlay.js), on real footage — a CC BY 4.0
// crowd clip (tests/fixtures/objects/README.md) served in place of the demo
// video. The detector really runs: YOLOX-Tiny in the browser's worker.

const here = path.dirname(fileURLToPath(import.meta.url));
const CROWD = path.join(here, '..', 'fixtures', 'objects', 'crowd-3s.mp4');
const CROWD_ROTATED = path.join(here, '..', 'fixtures', 'objects', 'crowd-3s-rotated.mp4');

// Every test is a fresh browser: it downloads the detector's runtime (14MB)
// and model (20MB) and compiles them before the first box — and the
// detector runs flat out. One at a time (this file runs beside the rest of
// the suite, and beside tracking.spec.js), with room for a slow start.
test.describe.configure({ mode: 'default', timeout: 120000 });

async function openWith(page, clip, { fresh = true } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  // Served with byte ranges, or the browser can't seek it (see serveVideo.js).
  if (clip) await serveVideo(page, clip);
  await page.goto('/?splash=0');
  if (fresh) {
    await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.reload();
    await page.getByText('Try Demo Video').click();
  }
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    if (Math.abs(v.currentTime - time) < 1e-6) return resolve();
    v.addEventListener('seeked', () => requestAnimationFrame(resolve), { once: true });
    v.currentTime = time;
  }), t);
}

async function openObjects(page) {
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await expect(page.locator('#objects-editor')).toBeVisible();
}

const waitDetected = (page) => page.waitForFunction(() => ['ready', 'failed'].includes(window.__appState.objectStatus?.state) && !window.__objects.isDetecting(), null, { timeout: 60000 });
const here_ = (page) => page.evaluate(() => window.__objects.getDetectionsAt(document.getElementById('preview-video').currentTime));

/** Where a detection's centre is on screen — computed in the test from the shared maths, not read off the overlay. */
async function screenCentreOf(page, det) {
  const env = await page.evaluate(() => {
    const r = document.getElementById('state-video').getBoundingClientRect();
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const t = document.getElementById('preview-video').currentTime;
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      p: { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height, transform: window.__composition.getCurrentVideoValue && {
        offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
        scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation') } },
      t
    };
  });
  const c = videoToComposition({ x: det.box.x + det.box.width / 2, y: det.box.y + det.box.height / 2 }, env.p);
  return compositionToScreen(c, env.rect);
}

test('opening Objects detects the paused frame; boxes, numbered labels, and a click selects exactly that object', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openWith(page, CROWD);
  await seek(page, 1);
  await openObjects(page);
  await waitDetected(page);
  const found = await here_(page);
  expect(found.detections.filter((d) => d.class === 'person').length).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#object-overlay polygon')).toHaveCount(found.detections.length);
  // Same-class objects are told apart.
  const labels = await page.locator('.object-label').allTextContents();
  expect(labels.some((l) => /^Person 1 \d+%$/.test(l)) && labels.some((l) => /^Person 2 \d+%$/.test(l))).toBe(true);
  await expect(page.locator('#objects-status')).toContainText('Objects detected');

  // Click each person's centre: that one, and no other, becomes the target.
  const people = found.detections.filter((d) => d.class === 'person').slice(0, 2);
  for (const d of people) {
    // A box can contain a smaller one; click a centre no smaller box covers.
    const smaller = found.detections.filter((o) => o.id !== d.id && o.box.width * o.box.height < d.box.width * d.box.height);
    const cx = d.box.x + d.box.width / 2;
    const cy = d.box.y + d.box.height / 2;
    if (smaller.some((o) => cx >= o.box.x && cx <= o.box.x + o.box.width && cy >= o.box.y && cy <= o.box.y + o.box.height)) continue;
    const pt = await screenCentreOf(page, d);
    await page.mouse.click(pt.x, pt.y);
    const sel = await page.evaluate(() => window.__objects.getSelectedObject());
    expect(sel.detectionId).toBe(d.id);
    expect(sel).toMatchObject({ class: 'person', label: 'Person', timestamp: found.time });
    expect(sel.source.model).toMatch(/^yolox-tiny@/);
  }
  await expect(page.locator('#objects-selected-label')).toHaveText('Person');

  // Empty space deselects; undo brings it back; Deselect clears it.
  const fr = await page.locator('#state-video').boundingBox();
  await page.mouse.click(fr.x + fr.width * 0.5, fr.y + 6);
  expect(await page.evaluate(() => window.__objects.getSelectedObject())).toBeNull();
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect(await page.evaluate(() => window.__objects.getSelectedObject()?.class)).toBe('person');
  await page.locator('#objects-deselect').click();
  expect(await page.evaluate(() => window.__objects.getSelectedObject())).toBeNull();
  expect(errs).toEqual([]);
});

test('boxes and clicks stay on the object when the video is moved, scaled and rotated in a square canvas', async ({ page }) => {
  await openWith(page, CROWD);
  await seek(page, 1);
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 10, offsetYPct: -6, scale: 0.8, rotation: 25 }
  }, { recordHistory: false }));
  await page.waitForTimeout(400);
  await openObjects(page);
  await waitDetected(page);
  const found = await here_(page);
  const target = [...found.detections].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  const pt = await screenCentreOf(page, target);
  // The drawn polygon for it surrounds that point.
  const poly = await page.locator(`#object-overlay polygon[data-detection-id="${target.id}"]`).boundingBox();
  expect(pt.x > poly.x && pt.x < poly.x + poly.width && pt.y > poly.y && pt.y < poly.y + poly.height).toBe(true);
  await page.mouse.click(pt.x, pt.y);
  expect((await page.evaluate(() => window.__objects.getSelectedObject())).detectionId).toBe(target.id);
});

test('a video with rotation metadata: detections are of the picture as displayed', async ({ page }) => {
  await openWith(page, CROWD);
  await seek(page, 1);
  await openObjects(page);
  await waitDetected(page);
  // The confident ones here, against everything the detector kept there — a
  // detection right at the display threshold can fall either side of it.
  const upright = (await here_(page)).detections.filter((d) => d.confidence >= 0.6);
  await page.unroute('**/demo-video.mp4');
  const page2 = await page.context().newPage();
  await openWith(page2, CROWD_ROTATED);
  expect(await page2.evaluate(() => { const v = document.getElementById('preview-video'); return [v.videoWidth, v.videoHeight]; })).toEqual([270, 480]);
  await seek(page2, 1);
  await openObjects(page2);
  await waitDetected(page2);
  const rotated = await page2.evaluate(() => window.__objects.getDetectionSet().frames[0].detections);
  for (const d of upright) {
    expect(rotated.some((r) => r.class === d.class && Math.abs(r.box.x - d.box.x) < 0.04 && Math.abs(r.box.y - d.box.y) < 0.04), `${d.class} at ${d.box.x.toFixed(2)},${d.box.y.toFixed(2)}`).toBe(true);
  }
});

test('scanning: real progress, the sampled frames, nothing redone, nothing during playback', async ({ page }) => {
  test.setTimeout(120000);
  await openWith(page, CROWD);
  await openObjects(page);
  await waitDetected(page);
  const duration = await page.evaluate(() => document.getElementById('preview-video').duration);
  const progress = [];
  await page.exposeFunction('reportProgress', (s) => progress.push(s));
  await page.evaluate(() => {
    const seen = new Set();
    const id = setInterval(() => {
      const s = window.__appState.objectStatus;
      const k = `${s.done}/${s.total}`;
      if (s.state === 'detecting' && !seen.has(k)) { seen.add(k); window.reportProgress(k); }
    }, 20);
    window.__stopProgress = () => clearInterval(id);
  });
  const tScan = Date.now();
  await page.locator('#objects-scan').click();
  await waitDetected(page);
  console.log(`scan of ${duration.toFixed(1)}s took ${Date.now() - tScan}ms; progress seen: ${progress.join(' ')}`);
  await page.evaluate(() => window.__stopProgress());
  const expected = sampleTimes(duration);
  const frames = await page.evaluate(() => window.__objects.getDetectionSet().frames.map((f) => f.time));
  for (const t of expected) expect(frames.some((f) => Math.abs(f - t) < 0.02), `sampled ${t}`).toBe(true);
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.every((p) => /^\d+\/\d+$/.test(p))).toBe(true);
  // Again: everything is cached — nothing to do.
  const before = await page.evaluate(() => JSON.stringify(window.__objects.getDetectionSet()));
  await page.locator('#objects-scan').click();
  await waitDetected(page);
  expect(await page.evaluate(() => window.__appState.objectStatus.total)).toBe(0);
  expect(await page.evaluate(() => JSON.stringify(window.__objects.getDetectionSet()))).toBe(before);
  // Playing never detects.
  const count = frames.length;
  // Sampled WHILE playing (pausing in Objects mode is meant to look at the frame paused on).
  const during = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    const states = new Set();
    v.play();
    const id = setInterval(() => states.add(window.__appState.objectStatus.state), 30);
    setTimeout(() => { clearInterval(id); v.pause(); resolve([...states]); }, 1200);
  }));
  expect(during).not.toContain('detecting');
  expect(await page.evaluate(() => window.__objects.getDetectionSet().frames.length)).toBe(count);
});

test('reload restores detections and the selection without re-detecting; another video makes them stale', async ({ page }) => {
  await openWith(page, CROWD);
  await seek(page, 1);
  await openObjects(page);
  await waitDetected(page);
  const found = await here_(page);
  await page.evaluate((d) => window.__objects.selectObject(d), found.detections[0]);
  const saved = await page.evaluate(() => ({ set: window.__objects.getDetectionSet(), sel: window.__objects.getSelectedObject() }));
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.objectStatus.state)).toBe('idle');
  expect(await page.evaluate(() => window.__objects.getDetectionSet())).toEqual(saved.set);
  expect(await page.evaluate(() => window.__objects.getSelectedObject())).toEqual(saved.sel);

  // A different video (the real demo clip): nothing carries over.
  await page.unroute('**/demo-video.mp4');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__objects.getDetectionSet())).toBeNull();
  expect(await page.evaluate(() => window.__objects.getSelectedObject())).toBeNull();
});

test('the export carries nothing of it; a model that fails to load leaves editing working', async ({ page }) => {
  await page.route('**/models/yolox_tiny.onnx', (r) => r.fulfill({ status: 404, body: 'missing' }));
  await openWith(page, CROWD);
  await openObjects(page);
  await waitDetected(page);
  expect(await page.evaluate(() => window.__appState.objectStatus.state)).toBe('failed');
  await expect(page.locator('#objects-status')).toContainText('Couldn’t detect objects');
  // Editing carries on.
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0.5, text: 'STILL WORKS' }));
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);
  // Nothing about objects reaches the renderer.
  const keys = await page.evaluate(() => Object.keys(window.__getStyleParams()));
  expect(keys.filter((k) => /object|detect/i.test(k))).toEqual([]);
  // The overlay is editor DOM beside the canvases, never drawn into one.
  expect(await page.evaluate(() => document.getElementById('object-overlay')?.closest('canvas'))).toBeNull();
});
