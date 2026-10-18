import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth, visibleMask, W, H } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';

// SUBJECT ISOLATION & BACKGROUND REPLACEMENT in the real editor
// (shared/objects/subject.js): track and segment a person on segment.mp4 —
// real silhouettes, exact visible pixels known — then put a colour behind
// them and check the PREVIEW'S OWN PIXELS: the person's own colours where he
// is, the new background everywhere else, nothing outside the effect's span,
// and nothing at all where the segmentation has no mask.
//
// The segmenter runs on the CPU here (no GPU in the test browser), so these
// segment with keyframes 1s apart, as the segmentation spec does.

test.describe.configure({ mode: 'default', timeout: 600000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const SEGMENT = path.join(here, '..', 'fixtures', 'objects', 'segment.mp4');
const PINK = [255, 0, 255];

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
}

/** Adds a background effect on the selected object, across the whole clip, with no fade. */
async function addBackground(page, appearance) {
  await page.locator('#objects-effect-add-background').click();
  return page.evaluate((look) => {
    const e = window.__objectEffects.getSelectedObjectEffect();
    window.__objectEffects.updateObjectEffect(e.id, { fade: 0, start: 0, end: 4.4 });
    window.__objectEffects.patchObjectEffectAppearance(e.id, look);
    return window.__objectEffects.getObjectEffect(e.id);
  }, appearance);
}

/** The effects canvas's pixel at a VIDEO-space point, by the shared maths. */
async function effectPixelAt(page, pt) {
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
    const c = document.getElementById('object-effects-canvas');
    const r = c.getBoundingClientRect();
    // With nothing to draw the canvas is hidden outright (it only carries the
    // 'active' class when something is on it), which is 'nothing drawn here'.
    if (!r.width || !r.height) return [0, 0, 0, 0];
    const x = Math.round(((sx - r.left) * c.width) / r.width);
    const y = Math.round(((sy - r.top) * c.height) / r.height);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  }, [s.x, s.y]);
}

const near = (a, b, tol = 40) => Math.abs(a - b) <= tol;
const isPink = (px) => !!px && px[3] > 200 && near(px[0], PINK[0]) && near(px[1], PINK[1]) && near(px[2], PINK[2]);

/** A point well inside the person at `t` (his chest), and one on the street far from him. */
const onPerson = (name, t) => { const b = truth(name, t, 'segment'); return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.3 }; };
const offPerson = { x: 0.06, y: 0.9 };

test('put a colour behind a segmented person: he stays, the rest of the frame goes', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);
  await trackAndSegment(page, 'olive');

  // Before any background: the Background button is there, and adding one
  // makes an ordinary effect on the Effects lane.
  await expect(page.locator('#objects-effect-add-background')).toBeVisible();
  const effect = await addBackground(page, { mode: 'color', color: '#FF00FF', expand: 0, feather: 0 });
  expect(effect.type).toBe('background');
  expect(effect.appearance.mode).toBe('color');
  await expect(page.locator('#object-effect-editor')).toHaveAttribute('data-type', 'background');
  await expect(page.locator('#object-background-mode-color')).toBeVisible();
  await expect(page.locator('.timeline-text-clip.is-effect.type-background')).toHaveCount(1);

  for (const t of [1.0, 3.0]) {
    await seek(page, t);
    // Wait for the mask at this instant to be ready, then for a frame to draw.
    await page.waitForFunction((time) => window.__segmentation.getSelectedMaskAt(time) !== null, t, { timeout: 20000 });
    await page.waitForTimeout(250);
    const him = await effectPixelAt(page, onPerson('olive', t));
    const street = await effectPixelAt(page, offPerson);
    expect(isPink(street), `the street at ${t}s is the new background (${street})`).toBe(true);
    expect(isPink(him), `the person at ${t}s is NOT painted over (${him})`).toBe(false);
    expect(him[3], `the person at ${t}s is drawn back in (${him})`).toBeGreaterThan(200);
  }

  // NO MASK, NO CLAIM: at 2s the other person crosses in front of him, the
  // segmentation hides that keyframe, and nothing is isolated there — the
  // frame is left exactly as it is rather than the background blinking on
  // over a subject that cannot be found.
  await seek(page, 2.0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__segmentation.getSelectedMaskAt(2.0)), 'he is hidden at 2s').toBeNull();
  expect(await effectPixelAt(page, offPerson), 'no mask: the video is untouched').toEqual([0, 0, 0, 0]);

  // Outside the effect's own span nothing is drawn at all.
  await page.evaluate(() => {
    const e = window.__objectEffects.getObjectEffects()[0];
    window.__objectEffects.updateObjectEffect(e.id, { start: 0, end: 1.5 });
  });
  await seek(page, 2.0);
  await page.waitForTimeout(250);
  expect(await effectPixelAt(page, offPerson)).toEqual([0, 0, 0, 0]);

  // Switched off, likewise.
  await page.evaluate(() => {
    const e = window.__objectEffects.getObjectEffects()[0];
    window.__objectEffects.updateObjectEffect(e.id, { start: 0, end: 4.4, enabled: false });
  });
  await seek(page, 1.0);
  await page.waitForTimeout(250);
  expect(await effectPixelAt(page, offPerson)).toEqual([0, 0, 0, 0]);
  expect(errs).toEqual([]);
});

test('a background follows the video when it is moved, scaled and rotated, and survives a reload', async ({ page }) => {
  await open(page);
  await trackAndSegment(page, 'olive');
  const effect = await addBackground(page, { mode: 'color', color: '#FF00FF', expand: 0, feather: 0 });
  await page.evaluate(() => window.__updateState({
    composition: { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } },
    videoTransform: { offsetXPct: 6, offsetYPct: -4, scale: 0.75, rotation: 14 }
  }, { recordHistory: false }));
  await page.waitForTimeout(500);
  await seek(page, 1.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.0) !== null, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  expect(isPink(await effectPixelAt(page, offPerson)), 'the street, through the rotation').toBe(true);
  expect(isPink(await effectPixelAt(page, onPerson('olive', 1.0))), 'the person, through the rotation').toBe(false);
  // Outside the video's own rectangle the canvas is left alone.
  const outside = await page.evaluate(() => {
    const c = document.getElementById('object-effects-canvas');
    return Array.from(c.getContext('2d').getImageData(2, 2, 1, 1).data);
  });
  expect(outside, 'the canvas beyond the video is untouched').toEqual([0, 0, 0, 0]);

  // Reload: the effect, its track and its segmentation all come back, and it
  // still draws.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => window.__segmentation.setSegmentationConfig({ step: 1.0 }));
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => window.__objectEffects.getObjectEffects());
  expect(back.length).toBe(1);
  expect(back[0].id).toBe(effect.id);
  expect(back[0].appearance.mode).toBe('color');
  expect(await page.evaluate(() => window.__objectEffects.isEffectLinked(window.__objectEffects.getObjectEffects()[0]))).toBe(true);
  await seek(page, 1.0);
  await page.waitForFunction(() => window.__segmentation.getSelectedMaskAt(1.0) !== null, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  expect(isPink(await effectPixelAt(page, offPerson)), 'still drawing after a reload').toBe(true);
});

test('without a segmentation nothing is isolated, and the panel says why; the export carries the masks', async ({ page }) => {
  await open(page);
  // Track only — no segmentation yet.
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

  const added = await addBackground(page, { mode: 'color', color: '#FF00FF' });
  await expect(page.locator('#object-effect-needs-mask')).toContainText('Segment object');

  // UNDO / REDO, through the editor's one history: the mode steps back and
  // forward, and undoing past the effect's creation takes it away — with the
  // original video untouched underneath it all along.
  await page.locator('#object-background-mode-image').click();
  await expect.poll(() => page.evaluate(() => window.__objectEffects.getObjectEffects()[0].appearance.mode)).toBe('image');
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__objectEffects.getObjectEffects()[0].appearance.mode)).toBe('color');
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => window.__objectEffects.getObjectEffects()[0].appearance.mode)).toBe('image');
  // Back past its creation (the colour, the timing and the effect itself were
  // each their own step, so this walks back rather than counting them).
  for (let i = 0; i < 6 && (await page.evaluate(() => window.__objectEffects.getObjectEffects().length)) > 0; i++) {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(80);
  }
  expect(await page.evaluate(() => window.__objectEffects.getObjectEffects().length), 'undone away entirely').toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => page.evaluate(() => window.__objectEffects.getObjectEffects().map((e) => e.id))).toEqual([added.id]);
  await page.evaluate((id) => window.__objectEffects.patchObjectEffectAppearance(id, { mode: 'color' }), added.id);
  await seek(page, 1.0);
  await page.waitForTimeout(300);
  expect(await effectPixelAt(page, offPerson), 'no mask, no claim: the video is left as it is').toEqual([0, 0, 0, 0]);
  // ...and the payload carries no masks it hasn't got.
  expect(await page.evaluate(() => window.__objectEffects.objectEffectsPayload().objectSegmentations ?? null)).toBeNull();

  // Segment, and now the masks ride with the export.
  await page.locator('#objects-segment-start').click();
  await page.waitForFunction(() => !window.__segmentation.isSegmenting() && window.__segmentation.getSelectedSegmentation(), null, { timeout: 500000 });
  await expect(page.locator('#object-effect-needs-mask')).toHaveCount(0);
  await page.evaluate(() => window.__objectEffects.prepareObjectEffectsForExport());
  const payload = await page.evaluate(() => {
    const p = window.__objectEffects.objectEffectsPayload();
    const key = Object.keys(p.objectSegmentations || {})[0];
    return key ? { key, keyframes: p.objectSegmentations[key].record.keyframes.length, masks: p.objectSegmentations[key].masks.split(' ').length } : null;
  });
  expect(payload, 'the masks are in the export payload').not.toBeNull();
  expect(payload.key).toBe(await page.evaluate(() => window.__tracking.getSelectedTrackKey()));
  expect(payload.masks).toBe(payload.keyframes);
});
