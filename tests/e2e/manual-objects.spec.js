import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// MANUAL SELECTION in the real editor: DRAG a box round anything on the
// frame — here a patterned badge the detector has no class for
// (custom.mp4, tests/fixtures/objects/make-crossing.mjs, known path) — and
// it is tracked by its own pixels, given effects and segmented like any
// detected object.

test.describe.configure({ mode: 'default' });

const here = path.dirname(fileURLToPath(import.meta.url));
const CUSTOM = path.join(here, '..', 'fixtures', 'objects', 'custom.mp4');
const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
};
const badge = (t) => truth('badge', t, 'custom');

async function open(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, CUSTOM);
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

/** Where the video is placed, and the frame's on-screen rect — for the shared maths. */
async function placement(page) {
  return page.evaluate(() => {
    const r = document.getElementById('state-video').getBoundingClientRect();
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const p = { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height,
      transform: { offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
        scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation') } };
    return { p, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  });
}

/** The screen rectangle round a video-space box (its on-screen bounding box). */
async function screenRect(page, box) {
  const { p, rect } = await placement(page);
  const pts = [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]]
    .map(([x, y]) => compositionToScreen(videoToComposition({ x, y }, p), rect));
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** A real mouse drag across the frame, in steps. */
async function drag(page, { x0, y0, x1, y1 }) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
  await page.mouse.up();
}

async function openObjects(page) {
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await expect(page.locator('#object-overlay')).toBeVisible();
}

async function drawRoundBadge(page, t) {
  await seek(page, t);
  await drag(page, await screenRect(page, badge(t)));
  await page.waitForFunction(() => window.__objects.getSelectedObject()?.manual === true);
  return page.evaluate(() => window.__objects.getSelectedObject());
}

async function trackAndWait(page) {
  await page.locator('#objects-track-start').click();
  await expect(page.locator('#objects-track')).toHaveAttribute('data-state', 'tracking');
  await page.waitForFunction(() => !window.__tracking.isTracking() && window.__appState.trackingStatus?.state === 'done', null, { timeout: 120000 });
  return page.evaluate(() => window.__tracking.getSelectedTrack());
}

test('drag a box round something the detector missed: it is selected, tracked by its pixels, and followed as you scrub', async ({ page }) => {
  test.setTimeout(180000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  await openObjects(page);
  await seek(page, 1.0);
  // The detector looks at the paused frame — and finds nothing where the badge is.
  await page.waitForFunction(() => window.__objects.getDetectionsAt(1.0) !== null, null, { timeout: 60000 });
  const found = await page.evaluate(() => window.__objects.getDetectionsAt(1.0).detections.map((d) => d.box));
  expect(found.some((b) => iou(b, badge(1.0)) > 0.3), 'the detector found no badge').toBe(false);

  // The dragged rectangle shows while dragging.
  const r = await screenRect(page, badge(1.0));
  await page.mouse.move(r.x0, r.y0);
  await page.mouse.down();
  await page.mouse.move((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, { steps: 4 });
  await expect(page.locator('#object-draw-box')).toBeVisible();
  await page.mouse.move(r.x1, r.y1, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#object-draw-box')).toBeHidden();

  const sel = await page.evaluate(() => window.__objects.getSelectedObject());
  expect(sel.manual).toBe(true);
  expect(sel.class).toBe('custom');
  expect(sel.timestamp).toBeCloseTo(1.0, 2);
  expect(iou(sel.box, badge(1.0)), 'the selected box is what was drawn round').toBeGreaterThan(0.9);
  await expect(page.locator('#object-manual-box')).toHaveCount(1);
  await expect(page.locator('#object-manual-label')).toContainText('drawn');
  await expect(page.locator('#objects-selected-meta')).toContainText('Drawn');

  // Undo (Ctrl+Z) takes the selection back; redo restores it.
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__objects.getSelectedObject()?.manual ?? null)).toBe(null);
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => window.__objects.getSelectedObject()?.detectionId)).toBe(sel.detectionId);

  // Tracked by its own pixels.
  const track = await trackAndWait(page);
  expect(track.class).toBe('custom');
  expect(track.sourceObjectId).toBe(sel.detectionId);
  expect(track.startTime).toBeLessThan(0.05);
  expect(track.endTime).toBeGreaterThan(3.9);
  await expect(page.locator('#objects-track-status')).toContainText('Tracked');
  for (const t of [0.3, 1.6, 2.6, 3.6]) {
    await seek(page, t);
    const st = await page.evaluate((time) => window.__tracking.getTrackedStateAt(time), t);
    expect(iou(st.box, badge(t)), `on the badge at ${t}s`).toBeGreaterThan(0.7);
    expect(iou(st.box, truth('decoy', t, 'custom')), `never on the decoy at ${t}s`).toBe(0);
    const want = await screenRect(page, st.box);
    const drawn = await page.locator('#object-track-box').boundingBox();
    expect(Math.hypot(drawn.x + drawn.width / 2 - (want.x0 + want.x1) / 2, drawn.y + drawn.height / 2 - (want.y0 + want.y1) / 2), `drawn where the maths says at ${t}s`).toBeLessThan(3);
  }

  // A click on empty space (no drag) still lets go; a drag too small to follow selects nothing.
  await seek(page, 1.0);
  const empty = await screenRect(page, { x: 0.45, y: 0.8, width: 0.01, height: 0.01 });
  await page.mouse.click(empty.x0, empty.y0);
  await expect.poll(() => page.evaluate(() => window.__objects.getSelectedObject())).toBe(null);
  await drag(page, { x0: empty.x0, y0: empty.y0, x1: empty.x0 + 7, y1: empty.y0 + 7 });
  expect(await page.evaluate(() => window.__objects.getSelectedObject())).toBe(null);
  expect(errs).toEqual([]);
});

test('drawn on a moved, scaled and rotated video, the box is taken back to the video exactly', async ({ page }) => {
  test.setTimeout(120000);
  await open(page);
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 6, offsetYPct: -4, scale: 0.8, rotation: 0 }
  }, { recordHistory: false }));
  await page.waitForTimeout(400);
  await openObjects(page);
  const sel = await drawRoundBadge(page, 2.0);
  expect(iou(sel.box, badge(2.0)), 'moved and scaled').toBeGreaterThan(0.9);

  // Rotated: what is dragged is an upright rectangle on screen round the
  // tilted badge — taken back to the video it is a tilted rectangle whose
  // bounding box holds the badge.
  await page.evaluate(() => window.__updateState({ videoTransform: { offsetXPct: 6, offsetYPct: -4, scale: 0.8, rotation: 18 } }, { recordHistory: false }));
  await page.waitForTimeout(400);
  const rot = await drawRoundBadge(page, 2.5);
  const b = badge(2.5);
  const E = 0.004;
  expect(rot.box.x).toBeLessThanOrEqual(b.x + E);
  expect(rot.box.y).toBeLessThanOrEqual(b.y + E);
  expect(rot.box.x + rot.box.width).toBeGreaterThanOrEqual(b.x + b.width - E);
  expect(rot.box.y + rot.box.height).toBeGreaterThanOrEqual(b.y + b.height - E);
  // (An upright rectangle round a square tilted 18°, taken back through the
  // tilt, has ~2.5× its area: an IoU of ~0.4 is that geometry, not slack.)
  expect(iou(rot.box, b)).toBeGreaterThan(0.33);
});

test('a drawn object takes effects and a segmentation, and all of it survives a reload', async ({ page }) => {
  test.setTimeout(300000);
  await open(page);
  await openObjects(page);
  const sel = await drawRoundBadge(page, 1.0);
  const track = await trackAndWait(page);
  expect(track).not.toBeNull();

  // An outline follows it — on screen where the badge is.
  await page.locator('#objects-effect-add-outline').click();
  await seek(page, 2.0);
  const regions = await page.evaluate(() => window.__objectEffects.debugEffectRegions(2.0));
  expect(regions.length).toBe(1);
  const payload = await page.evaluate(() => window.__objectEffects.objectEffectsPayload());
  expect(Object.keys(payload.objectEffectTracks)).toEqual([await page.evaluate(() => window.__tracking.getSelectedTrackKey())]);
  const outlineCentre = await page.evaluate(() => {
    const g = window.__objectEffects.debugEffectRegions(2.0)[0].geometry;
    const c = document.getElementById('object-effects-canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left + (g.cx / c.width) * r.width, y: r.top + (g.cy / c.height) * r.height };
  });
  const want = await screenRect(page, badge(2.0));
  expect(Math.hypot(outlineCentre.x - (want.x0 + want.x1) / 2, outlineCentre.y - (want.y0 + want.y1) / 2), 'the outline is on the badge').toBeLessThan(8);

  // Segmented: its pixels, nobody else's (it has no class to share, so no detector runs for "others").
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
  await page.locator('#objects-segment-start').click();
  await page.waitForFunction(() => !window.__segmentation.isSegmenting() && window.__appState.segmentationStatus?.state !== 'segmenting', null, { timeout: 240000 });
  const rec = await page.evaluate(() => window.__segmentation.getSelectedSegmentation());
  expect(rec, 'a segmentation').not.toBeNull();
  expect(rec.keyframes.filter((k) => !k.hidden).length).toBeGreaterThan(2);
  await seek(page, 2.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(2.0) !== null, null, { timeout: 15000 });
  const mask = await page.evaluate(() => {
    const m = window.__segmentation.getSelectedMaskAt(2.0);
    let n = 0; let cx = 0; let cy = 0;
    for (let i = 0; i < m.alpha.length; i++) if (m.alpha[i] >= 128) { n++; cx += i % m.grid.width; cy += Math.floor(i / m.grid.width); }
    return { n, total: m.alpha.length, cx: m.frame.x + ((cx / n + 0.5) / m.grid.width) * m.frame.width, cy: m.frame.y + ((cy / n + 0.5) / m.grid.height) * m.frame.height };
  });
  const b2 = badge(2.0);
  expect(mask.n / mask.total, 'the mask holds a good part of its frame').toBeGreaterThan(0.2);
  expect(Math.abs(mask.cx - (b2.x + b2.width / 2)), 'mask centred on the badge (x)').toBeLessThan(b2.width * 0.2);
  expect(Math.abs(mask.cy - (b2.y + b2.height / 2)), 'mask centred on the badge (y)').toBeLessThan(b2.height * 0.2);

  // Reload: the drawn selection, its track, its effect and its segmentation are all still there.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__objects.getSelectedObject()?.detectionId)).toBe(sel.detectionId);
  expect(await page.evaluate(() => window.__tracking.getSelectedTrack()?.sourceObjectId)).toBe(sel.detectionId);
  expect(await page.evaluate(() => window.__objectEffects.getObjectEffects().map((e) => window.__objectEffects.isEffectLinked(e)))).toEqual([true]);
  // (The test's faster keyframe setting is session-only, and part of the key.)
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
  expect(await page.evaluate(() => window.__segmentation.getSelectedSegmentation()?.key)).toBe(rec.key);
});
