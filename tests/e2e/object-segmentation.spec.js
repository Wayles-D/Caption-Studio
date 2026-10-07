import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { rasterizeMask, coverageIoU } from '../../shared/objects/segmentation.js';
import { truth, visibleMask, W, H } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// OBJECT SEGMENTATION in the real editor (src/js/components/objectSegmentation.js,
// shared/objects/segmentation.js): track a person on segment.mp4 — two real
// people drawn with their real silhouettes — segment them from the Objects
// panel, and check the mask against that person's EXACT pixels; that it is
// drawn where the person is on screen, however the video is placed; that it
// survives a reload without being recomputed; that it goes stale with its
// track; that a failure costs nothing else; and that none of it is exported.
//
// The segmenter runs on the CPU here (no GPU in the test browser) — slow, so
// the tests segment with keyframes 1s apart (a dev hook; its own cache key).

test.describe.configure({ mode: 'default', timeout: 420000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const SEGMENT = path.join(here, '..', 'fixtures', 'objects', 'segment.mp4');
const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
};

async function open(page, { fresh = true } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, SEGMENT);
  await page.goto('/?splash=0');
  if (fresh) {
    await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.reload();
    await page.getByText('Try Demo Video').click();
  }
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

async function trackPerson(page, name) {
  await seek(page, 0.5);
  if (!(await page.locator('#objects-editor').count())) await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, truth(name, 0.5, 'segment'));
  await page.locator('#objects-track-start').click();
  await page.waitForFunction(() => !window.__tracking.isTracking() && window.__tracking.getSelectedTrack(), null, { timeout: 120000 });
}

async function segment(page) {
  await page.locator('#objects-segment-start').click();
  await expect(page.locator('#objects-segment')).toHaveAttribute('data-state', 'segmenting');
  await expect(page.locator('#objects-segment-status')).toContainText('Segmenting');
  await page.waitForFunction(() => !window.__segmentation.isSegmenting(), null, { timeout: 380000 });
  return page.evaluate(() => window.__segmentation.getSelectedSegmentation());
}

/** The editor's mask at the playhead, scored against the person's exact visible pixels. */
async function maskScore(page, name, t) {
  const m = await page.evaluate((tt) => { const x = window.__segmentation.getSelectedMaskAt(tt); return x && { ...x, alpha: Array.from(x.alpha) }; }, t);
  if (!m) return null;
  return coverageIoU(rasterizeMask({ ...m, alpha: Uint8Array.from(m.alpha) }, W, H), await visibleMask(name, t, 'segment'));
}

/** Where a video-space point is on screen, by the shared maths — and the mask canvas's pixel there. */
async function maskPixelAt(page, pt) {
  return page.evaluate((p) => {
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const placement = { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height,
      transform: { offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
        scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation') } };
    const r = document.getElementById('state-video').getBoundingClientRect();
    return { placement, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  }, pt).then(async ({ placement, rect }) => {
    const s = compositionToScreen(videoToComposition(pt, placement), rect);
    return page.evaluate(([sx, sy]) => {
      const c = document.getElementById('object-mask-canvas');
      const r = c.getBoundingClientRect();
      const x = Math.round(((sx - r.left) * c.width) / r.width);
      const y = Math.round(((sy - r.top) * c.height) / r.height);
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
    }, [s.x, s.y]);
  });
}

/** A point on the person (their chest — the middle of the top half of their box) and one far from anyone. */
const onPerson = (name, t) => { const b = truth(name, t, 'segment'); return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.3 }; };
const nowhere = { x: 0.02, y: 0.05 };

test('segment a tracked person: progress, a result, and a mask on their exact pixels that follows them as you scrub', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  await trackPerson(page, 'shirt');
  // Before starting: what it will take, on this device.
  await expect(page.locator('#objects-segment-estimate')).toContainText(/About [0-9]+ keyframes — roughly/);
  await page.locator('#objects-segment-start').click();
  // While it runs: masks already there for the keyframes done, and the time left.
  await page.waitForFunction(() => (window.__appState.segmentationStatus?.done || 0) >= 2, null, { timeout: 300000 });
  expect(await page.evaluate(() => window.__segmentation.isSegmenting())).toBe(true);
  expect(await page.evaluate(() => !!window.__segmentation.getSelectedMaskAt(0.3)), 'a mask before the job ends').toBe(true);
  await expect(page.locator('#objects-segment-status')).toContainText('left');
  await page.waitForFunction(() => !window.__segmentation.isSegmenting(), null, { timeout: 380000 });
  const rec = await page.evaluate(() => window.__segmentation.getSelectedSegmentation());
  // Done: the model's memory is given back.
  expect(await page.evaluate(() => window.__segmentation.isSegmenterLoaded())).toBe(false);
  expect(rec.status).toBe('completed');
  expect(rec.keyframes.length).toBeGreaterThanOrEqual(4);
  await expect(page.locator('#objects-segment-status')).toContainText('Segmented');
  await expect(page.locator('#objects-segment-status')).toContainText('keyframes');
  for (const t of [0.5, 1.5, 3.0]) {
    await seek(page, t);
    const score = await maskScore(page, 'shirt', t);
    expect(score, `IoU with his true pixels at ${t}s`).toBeGreaterThan(0.8);
    // Drawn on him, nowhere else.
    expect((await maskPixelAt(page, onPerson('shirt', t)))[3], `the mask drawn on him at ${t}s`).toBeGreaterThan(60);
    expect((await maskPixelAt(page, nowhere))[3]).toBe(0);
    await expect(page.locator('#object-overlay')).toHaveAttribute('data-mask-level', /high|medium/);
  }
  expect(errs).toEqual([]);
});

test('the three views, a moved/scaled/rotated video on a square canvas, a resized window — the mask stays on him', async ({ page }) => {
  await open(page);
  await trackPerson(page, 'shirt');
  await segment(page);
  await seek(page, 1.0);
  const pt = onPerson('shirt', 1.0);
  // Mask: tinted, translucent.
  const tint = await maskPixelAt(page, pt);
  expect(tint[3]).toBeGreaterThan(60);
  expect(tint[3]).toBeLessThan(200);
  // Silhouette: the rest dimmed, he is clear.
  await page.locator('#objects-mask-view-silhouette').click();
  await seek(page, 1.0);
  expect((await maskPixelAt(page, pt))[3]).toBeLessThan(40);
  expect((await maskPixelAt(page, nowhere))[3]).toBeGreaterThan(150);
  // Outline: only the edge — not his middle.
  await page.locator('#objects-mask-view-boundary').click();
  await seek(page, 1.0);
  expect((await maskPixelAt(page, pt))[3]).toBe(0);
  const edgeInk = await page.evaluate(() => {
    const c = document.getElementById('object-mask-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
    return n;
  });
  expect(edgeInk).toBeGreaterThan(50);
  // Off: nothing.
  await page.locator('#objects-mask-view-off').click();
  await seek(page, 1.0);
  expect((await maskPixelAt(page, pt))[3]).toBe(0);
  await page.locator('#objects-mask-view-overlay').click();

  // A square canvas, the video moved, scaled and rotated; then a smaller window.
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 6, offsetYPct: -4, scale: 0.8, rotation: 15 }
  }, { recordHistory: false }));
  for (const size of [{ width: 1400, height: 900 }, { width: 1100, height: 760 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    await seek(page, 1.0);
    expect((await maskPixelAt(page, pt))[3], `on him, ${size.width}px window, rotated video`).toBeGreaterThan(60);
    expect((await maskPixelAt(page, nowhere))[3]).toBe(0);
  }
});

test('reload: the mask is back from the saved file, not recomputed; asking again reuses it; a changed track makes it stale and its file goes', async ({ page }) => {
  await open(page);
  await trackPerson(page, 'shirt');
  const rec = await segment(page);
  const before = await maskScore(page, 'shirt', 1.5);
  const analysisFiles = () => page.evaluate(() => new Promise((resolve) => {
    const q = indexedDB.open('bhynd');
    q.onsuccess = () => {
      const req = q.result.transaction('files').objectStore('files').getAllKeys();
      req.onsuccess = () => { q.result.close(); resolve(req.result.filter((k) => String(k).startsWith('analysis:'))); };
    };
  }));
  expect(await analysisFiles()).toEqual([`analysis:${rec.key}`]);
  // A project file stays small: the record has no pixels.
  const recordSize = await page.evaluate(() => JSON.stringify(window.__appState.objectSegmentations).length);
  expect(recordSize).toBeLessThan(5000);

  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await seek(page, 1.5);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.5), null, { timeout: 20000 });
  expect(await page.evaluate(() => window.__segmentation.isSegmenting())).toBe(false);
  expect(await maskScore(page, 'shirt', 1.5)).toBeCloseTo(before, 5);
  await expect(page.locator('#objects-segment-start')).toHaveText('Re-segment');
  // Asking again: the same record, at once.
  const t0 = Date.now();
  const again = await page.evaluate(() => window.__segmentation.segmentSelectedObject());
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(again.key).toBe(rec.key);

  // The track changes (as a re-track with different samples would): the segmentation no longer applies — dropped, file deleted.
  await page.evaluate(() => {
    const key = window.__tracking.getSelectedTrackKey();
    const t = window.__appState.objectTracks[key];
    const samples = t.samples.map((s, i) => (i === 3 ? { ...s, box: { ...s.box, x: s.box.x + 0.01 } } : s));
    window.__updateState({ objectTracks: { ...window.__appState.objectTracks, [key]: { ...t, samples } } }, { recordHistory: false });
  });
  await page.waitForFunction(() => !window.__segmentation.getSelectedSegmentation());
  await expect.poll(analysisFiles).toEqual([]);
  expect(await page.evaluate(() => window.__segmentation.getSelectedMaskAt(1.5))).toBeNull();
});

test('a segmenter that cannot load fails cleanly, editing carries on; nothing of segmentation reaches the export', async ({ page }) => {
  await open(page);
  await trackPerson(page, 'shirt');
  await page.route('**/models/mobilesam-encoder.onnx', (r) => r.fulfill({ status: 404, body: 'missing' }));
  await page.locator('#objects-segment-start').click();
  await page.waitForFunction(() => !window.__segmentation.isSegmenting(), null, { timeout: 120000 });
  await expect(page.locator('#objects-segment')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('#objects-segment-status')).toContainText('Segmentation failed');
  await expect(page.locator('#objects-segment-status')).toContainText('Editing works as normal');
  // Tracking and the rest of the editor are untouched.
  expect(await page.evaluate(() => !!window.__tracking.getSelectedTrack())).toBe(true);
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0.5, text: 'STILL WORKS' }));
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);
  // The export payload carries no segmentation, and the mask canvas is editor DOM, not a render layer.
  const keys = await page.evaluate(() => Object.keys(window.__getStyleParams()));
  expect(keys.filter((k) => /segment|mask/i.test(k))).toEqual([]);
  expect(await page.evaluate(() => !!document.getElementById('object-mask-canvas')?.closest('#object-overlay'))).toBe(true);
});

test('two people, two segmentations: each on its own person', async ({ page }) => {
  await open(page);
  await trackPerson(page, 'olive');
  const olive = await segment(page);
  await trackPerson(page, 'shirt');
  const shirt = await segment(page);
  expect(olive.key).not.toBe(shirt.key);
  expect(Object.keys(await page.evaluate(() => window.__appState.objectSegmentations)).sort()).toEqual([olive.key, shirt.key].sort());
  // The selected (shirt) mask is on shirt, not on olive.
  await seek(page, 0.6);
  expect(await maskScore(page, 'shirt', 0.6)).toBeGreaterThan(0.8);
  expect(iou(truth('shirt', 0.6, 'segment'), truth('olive', 0.6, 'segment'))).toBe(0);
  expect((await maskPixelAt(page, onPerson('olive', 0.6)))[3]).toBe(0);
});
