import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth, visibleMask, W as FW, H as FH } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// DYNAMIC OCCLUSION in the real editor (shared/objects/occlusion.js): track
// and segment a person on segment.mp4 — real silhouettes, exact visible
// pixels known — put a shape across him, send it BEHIND him, and read the
// preview's own pixels: the shape gone where he is, there beside him, and
// fully visible wherever he has no mask.

test.describe.configure({ mode: 'default', timeout: 600000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const SEGMENT = path.join(here, '..', 'fixtures', 'objects', 'segment.mp4');
const BAR = [255, 0, 255];

async function open(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, SEGMENT);
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
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

async function trackAndSegment(page, name) {
  await seek(page, 0.5);
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, truth(name, 0.5, 'segment'));
  await page.locator('#objects-track-start').click();
  await page.waitForFunction(() => !window.__tracking.isTracking() && window.__tracking.getSelectedTrack(), null, { timeout: 120000 });
  await page.locator('#objects-segment-start').click();
  await page.waitForFunction(() => !window.__segmentation.isSegmenting() && window.__segmentation.getSelectedSegmentation(), null, { timeout: 500000 });
  return page.evaluate(() => window.__tracking.getSelectedTrackKey());
}

/** A bright bar straight across the middle of the frame. */
async function addBar(page) {
  return page.evaluate(() => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0 });
    window.__shapeLayers.patchShapeLayer(s.id, 'transform', { x: 50, y: 42, width: 100, height: 16 });
    window.__shapeLayers.patchShapeLayer(s.id, 'fill', { enabled: true, color: '#FF00FF' });
    window.__shapeLayers.updateShapeLayer(s.id, { start: 0, end: 4.4 });
    return s.id;
  });
}

/** What the PREVIEW shows at a video-space point: the topmost opaque layer canvas, else the video. */
async function previewPixelAt(page, pt) {
  const { placement, rect } = await page.evaluate(() => {
    const { width: fw, height: fh, comp } = window.__composition.getVideoBoxFraction();
    const r = document.getElementById('state-video').getBoundingClientRect();
    return {
      placement: {
        canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: fw * comp.width, boxHeight: fh * comp.height,
        transform: {
          offsetXPct: window.__composition.getCurrentVideoValue('positionX'), offsetYPct: window.__composition.getCurrentVideoValue('positionY'),
          scale: window.__composition.getCurrentVideoValue('scale'), rotation: window.__composition.getCurrentVideoValue('rotation')
        }
      },
      rect: { left: r.left, top: r.top, width: r.width, height: r.height }
    };
  });
  const s = compositionToScreen(videoToComposition(pt, placement), rect);
  return page.evaluate(([sx, sy]) => {
    // Every layer canvas, in DOM order (= stacking order): the LAST one with
    // an opaque pixel here is what the viewer sees.
    const canvases = [...document.querySelectorAll('#state-video canvas')];
    let top = null;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height || !c.classList.contains('active')) continue;
      const x = Math.round(((sx - r.left) * c.width) / r.width);
      const y = Math.round(((sy - r.top) * c.height) / r.height);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
      const px = Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
      if (px[3] > 200) top = { id: c.id, px };
    }
    return top;
  }, [s.x, s.y]);
}

const near = (a, b, tol = 46) => Math.abs(a - b) <= tol;
const isBar = (hit) => !!hit && near(hit.px[0], BAR[0]) && near(hit.px[1], BAR[1]) && near(hit.px[2], BAR[2]);
/** A point well inside the person (his chest), and one on the bar far from him. */
const onPerson = (t) => { const b = truth('olive', t, 'segment'); return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.3 }; };
const besidePerson = { x: 0.06, y: 0.46 };

test('send a shape behind a tracked subject: he passes in front of it as he walks', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  const trackKey = await trackAndSegment(page, 'olive');
  const barId = await addBar(page);

  // Before: the bar is over him — it is a layer, and layers are over the video.
  await seek(page, 1.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.0) !== null, null, { timeout: 20000 });
  await page.waitForTimeout(250);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'to begin with the bar covers him').toBe(true);

  // The one control, in the layer card: put it behind him.
  await page.getByRole('button', { name: 'Layers', exact: true }).click().catch(() => {});
  const relation = await page.evaluate(([id, key]) => window.__occlusion.setLayerBehind(id, key), [barId, trackKey]);
  expect(relation.trackKey).toBe(trackKey);
  expect(relation.mode).toBe('behind');
  expect(relation.layerIds).toEqual([barId]);

  // Now he is in front of it — and it is still there beside him.
  for (const t of [1.0, 3.0]) {
    await seek(page, t);
    await page.waitForFunction((time) => window.__segmentation.getSelectedMaskAt(time) !== null, t, { timeout: 20000 });
    await page.waitForTimeout(250);
    const him = await previewPixelAt(page, onPerson(t));
    const beside = await previewPixelAt(page, besidePerson);
    expect(isBar(him), `${t}s: the bar is hidden where he is (${JSON.stringify(him)})`).toBe(false);
    expect(isBar(beside), `${t}s: and still there beside him`).toBe(true);
  }

  // NO MASK, NO CLAIM: at 2s the other person crosses in front of him and the
  // segmentation hides that keyframe — the bar is simply visible again.
  await seek(page, 2.0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__segmentation.getSelectedMaskAt(2.0)), 'he is hidden at 2s').toBeNull();
  expect(isBar(await previewPixelAt(page, onPerson(2.0))), 'no mask: the bar shows, nothing is guessed').toBe(true);

  // Taking it out again puts the bar back over him.
  await page.evaluate((id) => window.__occlusion.setLayerBehind(id, null), barId);
  await seek(page, 1.0);
  await page.waitForTimeout(250);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'removed: the bar covers him again').toBe(true);
  expect(await page.evaluate(() => window.__occlusion.getOcclusions().length)).toBe(0);
  expect(errs).toEqual([]);
});

test('occlusion survives the video being moved, scaled and rotated, a reload, and undo/redo', async ({ page }) => {
  await open(page);
  const trackKey = await trackAndSegment(page, 'olive');
  const barId = await addBar(page);
  const relation = await page.evaluate(([id, key]) => window.__occlusion.setLayerBehind(id, key), [barId, trackKey]);

  // The mask is in SOURCE-VIDEO space and goes through the composition like
  // everything else: a moved, scaled, rotated video keeps the subject and its
  // mask together.
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 6, offsetYPct: -4, scale: 0.75, rotation: 14 }
  }, { recordHistory: false }));
  await page.waitForTimeout(500);
  await seek(page, 1.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.0) !== null, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'rotated: still behind him').toBe(false);
  expect(isBar(await previewPixelAt(page, besidePerson)), 'rotated: still there beside him').toBe(true);

  // Undo takes the relationship away; redo brings it back.
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__occlusion.getOcclusions().length)).toBe(0);
  await page.waitForTimeout(250);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'undone: the bar covers him').toBe(true);
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => window.__occlusion.getOcclusions().map((r) => r.id))).toEqual([relation.id]);
  await page.waitForTimeout(250);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'redone: behind him again').toBe(false);

  // Reload: the relationship, its subject and its masks all come back.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => window.__occlusion.getOcclusions());
  expect(back.length).toBe(1);
  expect(back[0].id).toBe(relation.id);
  expect(await page.evaluate(() => window.__occlusion.isOcclusionLinked(window.__occlusion.getOcclusions()[0]))).toBe(true);
  await seek(page, 1.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.0) !== null, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'after a reload: still behind him').toBe(false);
});

test('without a segmentation nothing is occluded, the panel says so, and the export carries the masks', async ({ page }) => {
  await open(page);
  // Track only — no segmentation.
  await seek(page, 0.5);
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await page.waitForFunction(() => window.__objects.getDetectionsAt(0.5)?.detections.length > 0, null, { timeout: 60000 });
  await page.evaluate((gt) => {
    const dets = window.__objects.getDetectionsAt(0.5).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, truth('olive', 0.5, 'segment'));
  await page.locator('#objects-track-start').click();
  await page.waitForFunction(() => !window.__tracking.isTracking() && window.__tracking.getSelectedTrack(), null, { timeout: 120000 });
  const trackKey = await page.evaluate(() => window.__tracking.getSelectedTrackKey());
  const barId = await addBar(page);

  // An unsegmented subject is not OFFERED (the panel points at Segment first)...
  expect(await page.evaluate(() => window.__occlusion.availableSubjects()), 'nothing to hide behind yet').toEqual([]);
  // ...but a relationship made before segmenting is kept and simply INERT,
  // so the order of work is the user's: it starts doing something the moment
  // the masks exist, and until then it changes nothing and is not exported.
  const early = await page.evaluate(([id, key]) => window.__occlusion.setLayerBehind(id, key), [barId, trackKey]);
  expect(early.trackKey).toBe(trackKey);
  expect(await page.evaluate(() => window.__occlusion.isOcclusionLinked(window.__occlusion.getOcclusions()[0])), 'inert without a segmentation').toBe(false);
  expect(await page.evaluate(() => window.__occlusion.occlusionsPayload().occlusions ?? null), 'and never sent to the export').toBeNull();
  await seek(page, 1.0);
  await page.waitForTimeout(250);
  expect(isBar(await previewPixelAt(page, onPerson(1.0))), 'nothing occluded: the bar covers him').toBe(true);

  // Segment, and now it works and the masks ride with the export. (Adding
  // the shape selected it, which moved the sidebar off the Objects panel.)
  await page.getByRole('button', { name: 'Objects', exact: true }).click();
  await expect(page.locator('#objects-segment-start')).toBeVisible();
  await page.locator('#objects-segment-start').click();
  await page.waitForFunction(() => !window.__segmentation.isSegmenting() && window.__segmentation.getSelectedSegmentation(), null, { timeout: 500000 });
  expect(await page.evaluate(() => window.__occlusion.availableSubjects().length)).toBe(1);
  // The relationship made earlier now works, untouched.
  expect(await page.evaluate(() => window.__occlusion.isOcclusionLinked(window.__occlusion.getOcclusions()[0]))).toBe(true);
  expect(await page.evaluate(() => window.__occlusion.getOcclusions()[0].id)).toBe(early.id);
  await page.evaluate(() => window.__occlusion.prepareOcclusionsForExport());
  const payload = await page.evaluate(() => {
    const p = window.__occlusion.occlusionsPayload();
    const key = Object.keys(p.occlusionSegmentations || {})[0];
    return {
      relations: p.occlusions.length,
      trackKeys: Object.keys(p.occlusionTracks || {}),
      masks: key ? p.occlusionSegmentations[key].masks.split(' ').length : 0,
      keyframes: key ? p.occlusionSegmentations[key].record.keyframes.length : 0
    };
  });
  expect(payload.relations).toBe(1);
  expect(payload.trackKeys).toEqual([trackKey]);
  expect(payload.masks).toBe(payload.keyframes);
  expect(payload.masks).toBeGreaterThan(1);
});
