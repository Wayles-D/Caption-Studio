import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { videoToComposition, compositionToScreen } from '../../shared/objects/coordinates.js';
import { truth } from '../fixtures/objects/make-crossing.mjs';
import { serveVideo } from './serveVideo.js';
import { openTool } from './helpers/dock.js';

// THE WHOLE FEATURE, through the new engine: ONE box on the subject, no
// track step, no segment step — then a bar sent behind him, judged by the
// preview's own pixels. The occlusion system is untouched; it cannot tell
// these masks from the old engine's. Headed Chrome, because the model needs
// the GPU (headless has no adapter and falls to the CPU at ~20s a frame).
test.use({ headless: false, channel: 'chrome', launchOptions: { args: ['--enable-unsafe-webgpu'] } });
test.describe.configure({ mode: 'default', timeout: 600000 });

// The model needs a real GPU, and headless Chromium has none: on the CPU a
// frame costs ~20s and the suite would sit for ten minutes measuring nothing.
// Run with BHYND_GPU=1 (headed Chrome opens briefly).
test.skip(!process.env.BHYND_GPU, 'needs a GPU — run with BHYND_GPU=1');

const here = path.dirname(fileURLToPath(import.meta.url));
const SEGMENT = path.join(here, '..', 'fixtures', 'objects', 'segment.mp4');
const BAR = [255, 0, 255];
const T0 = 0.5333;
const SPAN = 1.2;

async function open(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await serveVideo(page, SEGMENT);
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
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

async function addBar(page) {
  return page.evaluate(() => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0 });
    window.__shapeLayers.patchShapeLayer(s.id, 'transform', { x: 50, y: 42, width: 100, height: 16 });
    window.__shapeLayers.patchShapeLayer(s.id, 'fill', { enabled: true, color: '#FF00FF' });
    window.__shapeLayers.updateShapeLayer(s.id, { start: 0, end: 4.4 });
    return s.id;
  });
}

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
const onPerson = (t) => { const b = truth('olive', t, 'segment'); return { x: b.x + b.width * 0.5, y: b.y + b.height * 0.3 }; };
const besidePerson = { x: 0.06, y: 0.46 };

test('ONE box, and a bar goes behind him — no track step, no segment step', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);

  // The detector only to establish the video's identity key — the selection
  // itself is the single box below, exactly what the UI will pass.
  await seek(page, T0);
  await openTool(page, 'Objects');
  await page.waitForFunction(() => !!window.__objects.getCacheKey?.() || window.__objects.getDetectionsAt(0.5333) !== null, null, { timeout: 60000 });

  const job = await page.evaluate(async ([t0, box, span]) => {
    const r = await window.__tamSegmentation.tamSegmentSpan({ box, start: t0, end: t0 + span, fps: 10, label: 'olive' });
    return r ? { trackKey: r.trackKey, keyframes: r.record.keyframes.length, status: r.record.status, seconds: r.record.seconds } : null;
  }, [T0, truth('olive', T0, 'segment'), SPAN]);
  console.log('JOB', JSON.stringify(job));
  expect(job).not.toBeNull();

  const barId = await addBar(page);
  await seek(page, T0 + 0.5);
  await page.waitForTimeout(300);
  expect(isBar(await previewPixelAt(page, onPerson(T0 + 0.5))), 'to begin with the bar covers him').toBe(true);

  // This bar runs the whole clip but goes behind him for the followed span
  // only — an effect with its OWN window, not following its layer (which
  // would follow him across the bar's whole 4.4s).
  await page.evaluate(([id, key]) => {
    const r = window.__occlusion.setLayerBehind(id, key);
    window.__occlusion.updateOcclusion(r.id, { followsLayer: false }, { recordHistory: false });
  }, [barId, job.trackKey]);

  // Inside the span: hidden where he is, present beside him.
  for (const dt of [0.3, 0.7, 1.1]) {
    const t = T0 + dt;
    await seek(page, t);
    await page.waitForTimeout(300);
    const him = await previewPixelAt(page, onPerson(t));
    const beside = await previewPixelAt(page, besidePerson);
    expect(isBar(him), `${t.toFixed(2)}s: the bar is hidden where he is (${JSON.stringify(him)})`).toBe(false);
    expect(isBar(beside), `${t.toFixed(2)}s: and still there beside him`).toBe(true);
  }

  // Outside the span there is no mask — so no claim, and the bar simply shows.
  await seek(page, T0 + SPAN + 0.8);
  await page.waitForTimeout(300);
  expect(isBar(await previewPixelAt(page, onPerson(T0 + SPAN + 0.8))), 'outside the span: the bar shows, nothing is guessed').toBe(true);

  expect(errs, `page errors: ${errs.join(' | ')}`).toEqual([]);
});

// STEP 3/4, THE REAL CONTROL: the user's own flow, driven through the actual
// dropdown. Select the person in the Objects panel, make a bar, open the
// Shape panel, and choose "Behind … — follow them now". Everything after that
// choice — the span job, the storage, the relation — happens behind one
// option in one select. Judged, as always, by the preview's own pixels.
test('the dropdown: "follow them now" does the whole job from one choice', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await open(page);

  // Select the person — a click on a detection, the app's normal selection.
  await seek(page, T0);
  await openTool(page, 'Objects');
  await page.waitForFunction((t) => window.__objects.getDetectionsAt(t)?.detections.length > 0, T0, { timeout: 60000 });
  await page.evaluate(([t, gt]) => {
    const dets = window.__objects.getDetectionsAt(t).detections.filter((d) => d.class === 'person');
    const c = (b) => b.x + b.width / 2;
    dets.sort((a, b) => Math.abs(c(a.box) - c(gt)) - Math.abs(c(b.box) - c(gt)));
    window.__objects.selectObject(dets[0]);
  }, [T0, truth('olive', T0, 'segment')]);

  // A bar that is on screen for 1.2s — the span the follow will cover.
  const barId = await page.evaluate(([t0, span]) => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: t0 });
    window.__shapeLayers.patchShapeLayer(s.id, 'transform', { x: 50, y: 42, width: 100, height: 16 });
    window.__shapeLayers.patchShapeLayer(s.id, 'fill', { enabled: true, color: '#FF00FF' });
    window.__shapeLayers.updateShapeLayer(s.id, { start: t0, end: t0 + span });
    window.__shapeLayers.selectShapeLayer(s.id);
    return s.id;
  }, [T0, SPAN]);

  // The real panel, the real select, the one choice. Selecting the shape
  // already opened its panel, and the tool button TOGGLES — clicking it
  // unconditionally would close the panel again (the same trap the Overlay
  // specs hit): click only if the control is not there yet.
  if (!(await page.locator('#shape-behind-select').count())) {
    await openTool(page, 'Shape');
  }
  const select = page.locator('#shape-behind-select');
  await select.waitFor({ timeout: 20000 });
  await expect(select.locator('option[value="__follow__"]')).toHaveCount(1);
  await select.selectOption('__follow__');

  // The control narrates while it works, and offers a way out.
  await expect(page.locator('#shape-behind-progress')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#shape-behind-cancel')).toBeVisible();

  // Done: the relation exists on this layer, for this span.
  await expect.poll(
    () => page.evaluate((id) => !!window.__occlusion.occlusionForLayer(id), barId),
    { timeout: 420000, intervals: [2000] }
  ).toBe(true);
  await expect(page.locator('#shape-behind-progress')).toHaveCount(0);

  // And the pixels agree: hidden where he is, present beside him.
  for (const dt of [0.3, 0.9]) {
    const t = T0 + dt;
    await seek(page, t);
    await page.waitForTimeout(300);
    const him = await previewPixelAt(page, onPerson(t));
    const beside = await previewPixelAt(page, besidePerson);
    expect(isBar(him), `${t.toFixed(2)}s: hidden where he is (${JSON.stringify(him)})`).toBe(false);
    expect(isBar(beside), `${t.toFixed(2)}s: present beside him`).toBe(true);
  }

  expect(errs, `page errors: ${errs.join(' | ')}`).toEqual([]);
});

/** A point in VIDEO space (0-1) as a screen point on the preview. */
async function screenPoint(page, pt) {
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
  return compositionToScreen(videoToComposition(pt, placement), rect);
}

// WHERE, NOT EVERYWHERE — the workflow as in Resolve: from the layer's own
// panel, "Put behind someone…", drag a box round him on the video, and ONLY
// the layer's time is processed. Stretch the layer later and the effect
// follows it, processing only the NEW seconds — the first frames are kept,
// not redone.
test('pick him on the video from the layer panel; stretch the layer and only the new part is processed', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (/Occlusion|Objects/.test(m.text()) || m.type() === 'error') console.log('[browser]', m.type(), m.text()); });
  await open(page);
  await seek(page, T0);

  const FIRST = 0.8;
  const barId = await page.evaluate(([t0, len]) => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: t0 });
    window.__shapeLayers.patchShapeLayer(s.id, 'transform', { x: 50, y: 42, width: 100, height: 16 });
    window.__shapeLayers.patchShapeLayer(s.id, 'fill', { enabled: true, color: '#FF00FF' });
    window.__shapeLayers.updateShapeLayer(s.id, { start: t0, end: t0 + len });
    window.__shapeLayers.selectShapeLayer(s.id);
    return s.id;
  }, [T0, FIRST]);
  if (!(await page.locator('#shape-behind-pick').count())) await openTool(page, 'Shape');

  // The one button — then the video is the picker.
  await page.locator('#shape-behind-pick').click();
  await expect(page.locator('#shape-behind-picking')).toBeVisible();
  const gt = truth('olive', T0, 'segment');
  const a = await screenPoint(page, { x: gt.x, y: gt.y });
  const b = await screenPoint(page, { x: gt.x + gt.width, y: gt.y + gt.height });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('#shape-behind-progress')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => page.evaluate((id) => !!window.__occlusion.occlusionForLayer(id), barId), { timeout: 420000, intervals: [2000] }).toBe(true);

  const first = await page.evaluate((id) => {
    const r = window.__occlusion.occlusionForLayer(id);
    const track = window.__appState.objectTracks[r.trackKey];
    return { start: r.start, end: r.end, followsLayer: r.followsLayer, trackStart: track.startTime, trackEnd: track.endTime, frames: track.samples.map((s) => s.time) };
  }, barId);
  console.log('FIRST', JSON.stringify(first));
  // Exactly the layer's time — not the video's.
  expect(first.start).toBeCloseTo(T0, 2);
  expect(first.end).toBeCloseTo(T0 + FIRST, 2);
  expect(first.followsLayer).toBe(true);
  expect(first.trackEnd - first.trackStart).toBeLessThan(FIRST + 0.2);

  await seek(page, T0 + 0.4);
  await page.waitForTimeout(300);
  expect(isBar(await previewPixelAt(page, onPerson(T0 + 0.4))), 'hidden where he is').toBe(false);
  expect(isBar(await previewPixelAt(page, besidePerson)), 'present beside him').toBe(true);

  // STRETCH the layer: the effect follows, and only the new part is processed.
  const totals = [];
  // THE PREVIEW STAYS PUT: park it somewhere else; the job reads its own
  // private copy of the video, so the picture must not move while it runs.
  await seek(page, 3.5);
  const previewTimes = [];
  await page.evaluate(([id, t0, span]) => window.__shapeLayers.updateShapeLayer(id, { end: t0 + span }), [barId, T0, SPAN]);
  await expect(page.locator('#shape-behind-progress')).toContainText('new part', { timeout: 30000 });
  await expect.poll(async () => {
    // allTextContents never waits — the progress line is GONE once the job ends.
    const txt = (await page.locator('#shape-behind-progress').allTextContents()).join(' ');
    const m = /of (\d+)/.exec(txt || '');
    if (m) totals.push(+m[1]);
    previewTimes.push(await page.evaluate(() => document.getElementById('preview-video').currentTime));
    return page.evaluate((id) => {
      const r = window.__occlusion.occlusionForLayer(id);
      return window.__appState.objectTracks[r.trackKey].endTime;
    }, barId);
  }, { timeout: 150000, intervals: [1000] }).toBeGreaterThan(T0 + SPAN - 0.2).catch(async (e) => {
    console.log('STATE', JSON.stringify(await page.evaluate(() => ({
      occlusions: window.__occlusion.getOcclusions(),
      tracks: Object.entries(window.__appState.objectTracks || {}).map(([k, t]) => ({ k: k.slice(-24), end: t.endTime, n: t.samples.length, src: t.source })),
      segs: Object.values(window.__appState.objectSegmentations || {}).map((r) => ({ key: r.key.slice(-24), track: r.trackKey.slice(-24), n: r.keyframes.length, last: r.keyframes.at(-1)?.time }))
    }))));
    throw e;
  });

  const after = await page.evaluate((id) => {
    const r = window.__occlusion.occlusionForLayer(id);
    const track = window.__appState.objectTracks[r.trackKey];
    return { end: r.end, frames: track.samples.map((s) => s.time) };
  }, barId);
  console.log('AFTER', JSON.stringify(after), 'frames processed for the stretch:', Math.max(...totals, 0));
  expect(after.end).toBeCloseTo(T0 + SPAN, 2);
  console.log('preview while the stretch was processed:', JSON.stringify([...new Set(previewTimes.map((t) => t.toFixed(3)))]));
  previewTimes.forEach((t) => expect(t, 'the preview never moved while the job ran').toBeCloseTo(3.5, 2));
  // The first part was kept, not redone…
  first.frames.forEach((t) => expect(after.frames).toContain(t));
  // …and only the new 0.4s was processed (at 6 fps: a handful of frames, not the whole span again).
  expect(Math.max(...totals)).toBeLessThanOrEqual(Math.ceil((SPAN - FIRST) * 6) + 2);

  await seek(page, T0 + 1.05);
  await page.waitForTimeout(300);
  expect(isBar(await previewPixelAt(page, onPerson(T0 + 1.05))), 'in the stretched part, still hidden where he is').toBe(false);

  expect(errs, `page errors: ${errs.join(' | ')}`).toEqual([]);
});
