import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// OBJECT-AWARE EFFECTS in the real editor (src/js/components/objectEffects.js,
// shared/objects/effects.js): track a person on crossing.mp4 — two real people
// on KNOWN paths — put effects on them, and check the effects follow the right
// person, in the right place on screen, as you scrub; that settings, timing,
// the timeline lane, undo, reload and the export payload all hold.

// One at a time: each test tracks with the real detector, flat out.
test.describe.configure({ mode: 'default', timeout: 180000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const CROSSING = path.join(here, '..', 'fixtures', 'objects', 'crossing.mp4');
const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + b.width * b.height - inter);
};

async function open(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, CROSSING);
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

/** Detect at 0.5s (opening Objects the first time), select the person nearest `name`, track them. */
async function trackPerson(page, name) {
  await seek(page, 0.5);
  if (!(await page.locator('#objects-editor').count())) await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, truth(name, 0.5));
  await page.locator('#objects-track-start').click();
  await page.waitForFunction(() => !window.__tracking.isTracking() && window.__tracking.getSelectedTrack(), null, { timeout: 120000 });
  return page.evaluate(() => window.__tracking.getSelectedTrackKey());
}

/** Clicks "+ <type>" in the Effects card; returns the new effect. */
async function addEffect(page, type) {
  const before = await page.evaluate(() => window.__appState.objectEffects.length);
  await page.locator(`#objects-effect-add-${type}`).click();
  await page.waitForFunction((n) => window.__appState.objectEffects.length === n + 1, before);
  return page.evaluate(() => window.__appState.objectEffects[window.__appState.objectEffects.length - 1]);
}

/** Each drawn effect at the playhead: its region's centre on SCREEN (from the canvas), and where the shared maths says the tracked object is. */
async function regions(page) {
  return page.evaluate(() => {
    const v = document.getElementById('preview-video');
    const t = v.currentTime;
    const canvas = document.getElementById('object-effects-canvas');
    const cr = canvas.getBoundingClientRect();
    const r = document.getElementById('state-video').getBoundingClientRect();
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const p = { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height,
      transform: { offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
        scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation') } };
    return window.__objectEffects.debugEffectRegions(t).map((reg) => {
      const effect = window.__objectEffects.getObjectEffect(reg.id);
      return {
        ...reg,
        trackKey: effect.trackKey,
        screen: { x: cr.left + (reg.geometry.cx * cr.width) / canvas.width, y: cr.top + (reg.geometry.cy * cr.height) / canvas.height },
        p,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height }
      };
    });
  });
}

/** Where the shared maths puts the centre of `box` (video space) on screen. */
const onScreen = (box, p, rect) => compositionToScreen(videoToComposition({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, p), rect);

/** The tracked box of `trackKey` at the playhead, smoothed — what effects read. */
const trackedBox = (page, trackKey) => page.evaluate((k) => {
  const t = document.getElementById('preview-video').currentTime;
  return window.__objectEffects.debugTrackedBox(k, t);
}, trackKey);

/** The effects canvas's pixel (RGBA) at a SCREEN point. */
const canvasPixel = (page, x, y) => page.evaluate(([sx, sy]) => {
  const c = document.getElementById('object-effects-canvas');
  const r = c.getBoundingClientRect();
  const px = Math.round(((sx - r.left) * c.width) / r.width);
  const py = Math.round(((sy - r.top) * c.height) / r.height);
  return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
}, [x, y]);

test('track a person, add a glow and an outline: they follow him as you scrub, on screen where the maths says, with no keyframes', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  const key = await trackPerson(page, 'white');
  const glow = await addEffect(page, 'glow');
  const outline = await addEffect(page, 'outline');
  expect(glow.trackKey).toBe(key);
  expect(outline.trackKey).toBe(key);
  expect(glow.start).toBeCloseTo(0.5, 2);
  // No keyframes anywhere: the effect is a reference to the track.
  expect(Object.keys(glow)).not.toContain('keyframes');
  expect(Object.keys(glow)).not.toContain('samples');
  // The Objects tool closed: effects are content, not an editing aid — still drawn.
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await expect(page.locator('#objects-editor')).toHaveCount(0);

  for (const t of [0.6, 1.2, 1.9, 2.8, 3.1]) {
    await seek(page, t);
    const regs = await regions(page);
    expect(regs.map((r) => r.type).sort(), `both drawn at ${t}s`).toEqual(['glow', 'outline']);
    const box = await trackedBox(page, key);
    expect(iou(box, truth('white', t)), `on white at ${t}s`).toBeGreaterThan(0.5);
    expect(iou(box, truth('white', t))).toBeGreaterThan(iou(box, truth('green', t)));
    for (const reg of regs) {
      const want = onScreen(box, reg.p, reg.rect);
      expect(Math.hypot(reg.screen.x - want.x, reg.screen.y - want.y), `${reg.type} centred on him at ${t}s`).toBeLessThan(2);
    }
    // The outline is drawn where its region's edge is: the middle of its top edge has ink; far away, nothing.
    const o = regs.find((r) => r.type === 'outline');
    const scale = await page.evaluate(() => { const c = document.getElementById('object-effects-canvas'); return c.getBoundingClientRect().width / c.width; });
    const g = o.geometry;
    const top = { x: o.screen.x + Math.sin(g.angle) * (g.height / 2) * scale, y: o.screen.y - Math.cos(g.angle) * (g.height / 2) * scale };
    const [r, gg, , a] = await canvasPixel(page, top.x, top.y);
    expect(a, `ink on the outline at ${t}s`).toBeGreaterThan(150);
    expect(gg).toBeGreaterThan(r);
    const far = await canvasPixel(page, o.rect.left + 6, o.rect.top + 6);
    expect(far[3], 'nothing far from him').toBe(0);
  }
  // Before the effects start (0.5s): nothing.
  await seek(page, 0.3);
  expect(await regions(page)).toEqual([]);
  // He leaves the frame (~3.47s): held briefly, then nothing.
  await seek(page, 3.9);
  expect(await regions(page)).toEqual([]);
  expect(errs).toEqual([]);
});

test('two people, two effects: each stays on its own person through the crossing; settings, timing and Show reach the pixels', async ({ page }) => {
  await open(page);
  const whiteKey = await trackPerson(page, 'white');
  const outline = await addEffect(page, 'outline');
  const greenKey = await trackPerson(page, 'green');
  const spot = await addEffect(page, 'spotlight');
  expect(whiteKey).not.toBe(greenKey);
  expect(outline.trackKey).toBe(whiteKey);
  expect(spot.trackKey).toBe(greenKey);
  // Through the crossing (~1.8s) and after it: never swapped.
  for (const t of [1.0, 1.7, 2.2, 2.6]) {
    await seek(page, t);
    const regs = await regions(page);
    const byType = Object.fromEntries(regs.map((r) => [r.type, r]));
    const wBox = await trackedBox(page, whiteKey);
    const gBox = await trackedBox(page, greenKey);
    expect(iou(wBox, truth('white', t)), `white's track on white at ${t}s`).toBeGreaterThan(0.4);
    expect(iou(gBox, truth('green', t)), `green's track on green at ${t}s`).toBeGreaterThan(0.4);
    for (const [type, box] of [['outline', wBox], ['spotlight', gBox]]) {
      const reg = byType[type];
      expect(reg, `${type} drawn at ${t}s`).toBeTruthy();
      const want = onScreen(box, reg.p, reg.rect);
      expect(Math.hypot(reg.screen.x - want.x, reg.screen.y - want.y), `${type} on its own person at ${t}s`).toBeLessThan(2);
    }
  }
  // The spotlight dims everything but green.
  await seek(page, 1.0);
  let regs = await regions(page);
  const s = regs.find((r) => r.type === 'spotlight');
  const corner = await canvasPixel(page, s.rect.left + 6, s.rect.top + 6);
  expect(corner[3] / 255, 'dimmed outside').toBeCloseTo(0.6, 1);
  expect((await canvasPixel(page, s.screen.x, s.screen.y))[3], 'clear on him').toBeLessThan(10);

  // Settings reach the pixels: dim harder. (A new effect is the selected one.)
  await expect(page.locator('#object-effect-editor')).toHaveAttribute('data-type', 'spotlight');
  await page.evaluate((id) => window.__objectEffects.patchObjectEffectAppearance(id, { strength: 0.9 }), spot.id);
  await seek(page, 1.0);
  expect((await canvasPixel(page, s.rect.left + 6, s.rect.top + 6))[3] / 255).toBeCloseTo(0.9, 1);
  // Its own timing: start it at 2.0 — at 1.0 it is not drawn; the outline still is.
  await page.locator('#object-effect-start').fill('2');
  await page.locator('#object-effect-start').press('Enter');
  await seek(page, 1.0);
  regs = await regions(page);
  expect(regs.map((r) => r.type)).toEqual(['outline']);
  // Show: off — not drawn anywhere.
  await page.locator('#object-effects-list [data-effect-id]').nth(0).click();
  await page.locator('#object-effect-enabled-off').click();
  await seek(page, 2.4);
  expect((await regions(page)).map((r) => r.type)).toEqual(['spotlight']);
});

test('the Effects lane: drag moves it (one undo), Delete removes it, Undo brings it back', async ({ page }) => {
  await open(page);
  await trackPerson(page, 'green');
  const glow = await addEffect(page, 'glow');
  const clip = page.locator(`#timeline-effects-track [data-clip-id="${glow.id}"]`);
  await expect(clip).toHaveCount(1);
  await expect(clip).toContainText('Glow · Person');
  const box = await clip.boundingBox();
  const track = await page.locator('#timeline-effects-track').boundingBox();
  const duration = await page.evaluate(() => document.getElementById('preview-video').duration);
  // Left: green is tracked to the end of the video, so the glow already ends there.
  const dx = -(0.3 / duration) * track.width;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + dx / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 30 + dx, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const moved = await page.evaluate((id) => window.__objectEffects.getObjectEffect(id), glow.id);
  expect(moved.start - glow.start).toBeCloseTo(-0.3, 1);
  expect(moved.end - moved.start).toBeCloseTo(glow.end - glow.start, 3);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect((await page.evaluate((id) => window.__objectEffects.getObjectEffect(id), glow.id)).start).toBeCloseTo(glow.start, 3);
  // Selected (the press selected it): Delete removes it; Undo restores it.
  await clip.click();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.__appState.objectEffects.length)).toBe(0);
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  expect(await page.evaluate(() => window.__appState.objectEffects.length)).toBe(1);
});

test('reload keeps the effects on their tracks; the export gets them and only the tracks they follow; another video unlinks them', async ({ page }) => {
  await open(page);
  const key = await trackPerson(page, 'white');
  await addEffect(page, 'outline');
  await addEffect(page, 'blur');
  // A second tracked object with no effect: its track must not ride along.
  await trackPerson(page, 'green');
  const payload = await page.evaluate(() => {
    const p = window.__getStyleParams();
    return { keys: Object.keys(p).filter((k) => /object|track|detect/i.test(k)), trackKeys: Object.keys(p.objectEffectTracks || {}), n: (p.objectEffects || []).length };
  });
  expect(payload.keys.sort()).toEqual(['objectEffectTracks', 'objectEffects']);
  expect(payload.trackKeys).toEqual([key]);
  expect(payload.n).toBe(2);

  await seek(page, 1.0);
  const before = (await regions(page)).map((r) => [r.type, Math.round(r.screen.x), Math.round(r.screen.y)]);
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await seek(page, 1.0);
  const after = (await regions(page)).map((r) => [r.type, Math.round(r.screen.x), Math.round(r.screen.y)]);
  expect(after).toEqual(before);

  // The blur draws the video, blurred, inside the region only.
  const regs = await regions(page);
  const blur = regs.find((r) => r.type === 'blur');
  expect((await canvasPixel(page, blur.screen.x, blur.screen.y))[3]).toBeGreaterThan(200);

  // Another video: the tracks no longer apply — the effects are kept but unlinked, drawn nowhere, and not exported.
  await page.unroute('**/demo-video.mp4');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await seek(page, 1.0);
  expect(await page.evaluate(() => window.__appState.objectEffects.length)).toBe(2);
  expect(await page.evaluate(() => window.__appState.objectEffects.map((e) => window.__objectEffects.isEffectLinked(e)))).toEqual([false, false]);
  expect(await regions(page)).toEqual([]);
  expect(await page.evaluate(() => Object.keys(window.__getStyleParams()).filter((k) => /object|track|detect/i.test(k)))).toEqual([]);
  await expect(page.locator('#timeline-effects-track .is-unlinked')).toHaveCount(2);
});

test('the effect stays on the person when the window is resized and the video is moved, scaled and rotated on a square canvas', async ({ page }) => {
  await open(page);
  const key = await trackPerson(page, 'green');
  await addEffect(page, 'outline');
  const check = async (t, label) => {
    await seek(page, t);
    const [reg] = await regions(page);
    const box = await trackedBox(page, key);
    const want = onScreen(box, reg.p, reg.rect);
    expect(Math.hypot(reg.screen.x - want.x, reg.screen.y - want.y), label).toBeLessThan(2);
    expect(iou(box, truth('green', t))).toBeGreaterThan(0.5);
    return reg;
  };
  await check(1.2, '1400px window');
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(500);
  await check(1.2, '1100px window');
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 8, offsetYPct: -5, scale: 0.75, rotation: 18 }
  }, { recordHistory: false }));
  await page.waitForTimeout(500);
  const reg = await check(2.6, 'square canvas, rotated, scaled, moved');
  expect(reg.geometry.angle).toBeCloseTo((18 * Math.PI) / 180, 3);
});
