import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// OBJECT TRACKING in the real editor (src/js/components/objectTracking.js):
// select a detected person, track them, scrub — on crossing.mp4, two real
// people with KNOWN paths (tests/fixtures/objects/make-crossing.mjs), so the
// tracked box is checked against where the person actually is.

// One at a time: a track runs two detectors (forward and backward) flat
// out — several at once oversubscribe the machine and starve each other.
test.describe.configure({ mode: 'default' });

const here = path.dirname(fileURLToPath(import.meta.url));
const CROSSING = path.join(here, '..', 'fixtures', 'objects', 'crossing.mp4');
const REENTRY = path.join(here, '..', 'fixtures', 'objects', 'reentry.mp4');
const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
};

async function open(page, { fresh = true } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, CROSSING);
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
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

/** Detect at 0.5s, select the person nearest `name`'s true position. */
async function selectPerson(page, name) {
  await seek(page, 0.5);
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => [b.x + b.width / 2, b.y + b.height / 2];
    const g = c(gt);
    dets.sort((a, b) => Math.hypot(c(a.box)[0] - g[0], c(a.box)[1] - g[1]) - Math.hypot(c(b.box)[0] - g[0], c(b.box)[1] - g[1]));
    window.__objects.selectObject(dets[0]);
  }, truth(name, 0.5));
}

async function trackAndWait(page) {
  await page.locator('#objects-track-start').click();
  await expect(page.locator('#objects-track')).toHaveAttribute('data-state', 'tracking');
  await page.waitForFunction(() => !window.__tracking.isTracking(), null, { timeout: 120000 });
  return page.evaluate(() => window.__tracking.getSelectedTrack());
}

/** The tracked box's centre on screen, from the shared maths — and the drawn polygon's. */
async function boxCentres(page) {
  return page.evaluate(() => {
    const t = document.getElementById('preview-video').currentTime;
    const st = window.__tracking.getTrackedStateAt(t);
    const poly = document.getElementById('object-track-box');
    const r = document.getElementById('state-video').getBoundingClientRect();
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const p = { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height,
      transform: { offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
        scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation') } };
    const pb = poly?.getBoundingClientRect();
    return { st, p, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, drawn: pb ? { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 } : null };
  });
}
const expectedScreen = ({ st, p, rect }) => compositionToScreen(videoToComposition({ x: st.box.x + st.box.width / 2, y: st.box.y + st.box.height / 2 }, p), rect);

test('select a person, track them: the box follows them as you scrub, and nothing is claimed after they leave', async ({ page }) => {
  test.setTimeout(180000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  await selectPerson(page, 'white');
  const track = await trackAndWait(page);
  expect(track.sourceObjectId).toBe(await page.evaluate(() => window.__objects.getSelectedObject().detectionId));
  expect(track.ends.backward.reason).toBe('video-start');
  expect(track.ends.forward.reason).toBe('exited');
  await expect(page.locator('#objects-track-status')).toContainText('Tracked');
  await expect(page.locator('#objects-track-status')).toContainText('it left the frame');

  // Scrub: the tracked box is on WHITE — not GREEN — through the crossing.
  for (const t of [0.2, 1.0, 1.8, 2.2, 3.0]) {
    await seek(page, t);
    const g = await boxCentres(page);
    expect(g.st, `a tracked state at ${t}s`).not.toBeNull();
    expect(iou(g.st.box, truth('white', t)), `on white at ${t}s`).toBeGreaterThan(0.5);
    expect(iou(g.st.box, truth('white', t))).toBeGreaterThan(iou(g.st.box, truth('green', t)));
    const want = expectedScreen(g);
    expect(Math.hypot(g.drawn.x - want.x, g.drawn.y - want.y), `drawn where the maths says at ${t}s`).toBeLessThan(3);
  }
  // He has left: no box, no claim.
  await seek(page, 3.8);
  expect(await page.evaluate(() => window.__tracking.getTrackedStateAt(3.8))).toBeNull();
  await expect(page.locator('#object-track-box')).toHaveCount(0);
  await expect(page.locator('.object-trajectory')).toHaveCount(1);
  expect(errs).toEqual([]);
});

test('the tracked box stays on the person when the window is resized and the video is moved, scaled and rotated', async ({ page }) => {
  test.setTimeout(180000);
  await open(page);
  await selectPerson(page, 'green');
  await trackAndWait(page);
  await seek(page, 1.2);
  for (const size of [{ width: 1400, height: 900 }, { width: 1100, height: 760 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(500);
    await seek(page, 1.2);
    const g = await boxCentres(page);
    const want = expectedScreen(g);
    expect(Math.hypot(g.drawn.x - want.x, g.drawn.y - want.y), `${size.width}px window`).toBeLessThan(3);
  }
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 8, offsetYPct: -5, scale: 0.75, rotation: 18 }
  }, { recordHistory: false }));
  await page.waitForTimeout(500);
  await seek(page, 2.6);
  const g = await boxCentres(page);
  expect(iou(g.st.box, truth('green', 2.6))).toBeGreaterThan(0.5);
  const want = expectedScreen(g);
  expect(Math.hypot(g.drawn.x - want.x, g.drawn.y - want.y), 'rotated, scaled, moved').toBeLessThan(3);
});

test('a track survives a reload untouched, is reused rather than redone, and is stale for another video', async ({ page }) => {
  test.setTimeout(180000);
  await open(page);
  await selectPerson(page, 'white');
  const track = await trackAndWait(page);
  // Reused, not redone.
  const t0 = Date.now();
  const again = await page.evaluate(() => window.__tracking.trackSelectedObject());
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(again).toEqual(track);
  await expect(page.locator('#objects-track-start')).toHaveText('Re-track');

  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.trackingStatus.state)).toBe('idle');
  expect(await page.evaluate(() => window.__tracking.getSelectedTrack())).toEqual(track);

  // Another video: the track no longer applies.
  await page.unroute('**/demo-video.mp4');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__tracking.getSelectedTrack())).toBeNull();
});

test('stopping keeps what was followed, marked partial; a failure leaves editing working; the export carries none of it', async ({ page }) => {
  test.setTimeout(180000);
  await open(page);
  await selectPerson(page, 'green');
  await page.locator('#objects-track-start').click();
  await page.waitForFunction(() => window.__appState.trackingStatus.done >= 2, null, { timeout: 60000 });
  await page.locator('#objects-track-stop').click();
  await page.waitForFunction(() => !window.__tracking.isTracking(), null, { timeout: 60000 });
  const t = await page.evaluate(() => window.__tracking.getSelectedTrack());
  expect(t.status).toBe('partial');
  await expect(page.locator('#objects-track-status')).toContainText('stopped early');

  // The detector disappears: tracking fails, cleanly.
  await page.route('**/models/yolox_tiny.onnx', (r) => r.fulfill({ status: 404, body: 'missing' }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => {
    window.__objects.selectObject({ id: 'det-0000500-9', class: 'person', label: 'Person', confidence: 0.9, time: 0.5, box: { x: 0.1, y: 0.4, width: 0.1, height: 0.5 } });
  });
  const result = await page.evaluate(() => window.__tracking.trackSelectedObject({ force: true }));
  expect(result).toBeNull();
  expect(await page.evaluate(() => window.__appState.trackingStatus.state)).toBe('failed');
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0.5, text: 'STILL WORKS' }));
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);
  const keys = await page.evaluate(() => Object.keys(window.__getStyleParams()));
  expect(keys.filter((k) => /track|object|detect/i.test(k))).toEqual([]);
});

test('hidden behind a wall for longer than it can coast, the person is found again — and nothing is drawn while hidden', async ({ page }) => {
  test.setTimeout(180000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, REENTRY);
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await seek(page, 0.5);
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, truth('white', 0.5, 'reentry'));
  const track = await trackAndWait(page);
  expect(track.gaps.length).toBe(1);
  expect(track.ends.forward.reason).toBe('exited');
  await expect(page.locator('#objects-track-status')).toContainText('then found again');

  // Behind the wall: no claim, no box.
  await seek(page, 1.8);
  expect(await page.evaluate(() => window.__tracking.getTrackedStateAt(1.8))).toBeNull();
  await expect(page.locator('#object-track-box')).toHaveCount(0);
  // The drawn path is two pieces — it does not run through the wall.
  expect(await page.locator('.object-trajectory').getAttribute('d')).toMatch(/^M[^M]+M[^M]+$/);
  // Out the other side: on him again, drawn where the maths says.
  await seek(page, 3.2);
  const g = await boxCentres(page);
  expect(iou(g.st.box, truth('white', 3.2, 'reentry'))).toBeGreaterThan(0.5);
  const want = expectedScreen(g);
  expect(Math.hypot(g.drawn.x - want.x, g.drawn.y - want.y)).toBeLessThan(3);
  expect(errs).toEqual([]);
});
