/**
 * OBJECT-AWARE EFFECTS (shared/objects/effects.js) — the model, the
 * confidence/loss policy and the geometry on controlled input, then REAL
 * exports through the real pipeline (graphicsFrameGenerator +
 * graphicsCompositor) on crossing.mp4, whose people walk KNOWN paths:
 *
 *   - an effect is a reference to a track, normalized, timed, serializable;
 *   - tracked → full, uncertain → softened, lost → held briefly then gone,
 *     never extrapolated; its own span and fade respected;
 *   - its region is the tracked box carried through the video's placement
 *     (square canvas, scaled, rotated, moved) — exactly coordinates.js's;
 *   - EXPORT PARITY: an export with effects equals the same export without
 *     them plus the shared effects layer drawn independently at that instant
 *     (the preview's draw) — outline, glow and spotlight; the blur blurs the
 *     tracked region of the video and nothing else;
 *   - two effects on one track and effects on two tracks are independent;
 *   - an effect whose track is missing draws nothing.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas } from '@napi-rs/canvas';
import {
  normalizeObjectEffect, normalizeObjectEffectList, createObjectEffect, effectStateAt, trackedRegionAt, effectGeometry,
  resolveObjectEffects, drawObjectEffects, blurSigma, EFFECT_POLICY, EFFECT_DEFAULTS
} from '../shared/objects/effects.js';
import { buildTrack, normalizeTrack, iou } from '../shared/objects/tracking.js';
import { videoBoxToComposition } from '../shared/objects/coordinates.js';
import { resolveVideoTransformAtTime } from '../shared/videoTransform.js';
import { prepareVideoComposition } from './utils/videoDecoration.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { truth } from '../tests/fixtures/objects/make-crossing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CROSSING = path.join(here, '..', 'tests', 'fixtures', 'objects', 'crossing.mp4');

console.log('--- Object-Aware Effects ---');

/** A track made from a person's TRUE path (make-crossing.mjs), every 0.2s over [from, to]. */
function truthTrack(name, from, to, { uncertain = [], gaps = [] } = {}) {
  const samples = [];
  for (let t = from; t <= to + 1e-9; t += 0.2) {
    const time = +t.toFixed(3);
    if (gaps.some((g) => time > g.start && time < g.end)) continue;
    samples.push({ time, box: truth(name, time), confidence: 0.9, state: uncertain.some(([a, b]) => time >= a && time <= b) ? 'uncertain' : 'tracked' });
  }
  return normalizeTrack(buildTrack({
    detection: { id: `det-${name}`, class: 'person', label: 'Person', time: from, box: truth(name, from), confidence: 0.9 },
    config: {}, samples, gaps, ends: { forward: { reason: 'exited', time: to }, backward: { reason: 'video-start', time: from } }
  }));
}

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: a reference to a track, normalized, serializable');
{
  const e = createObjectEffect({ type: 'glow', trackKey: 'k1', label: 'Person', start: 1, end: 3 });
  assert.strictEqual(e.type, 'glow');
  assert.strictEqual(e.trackKey, 'k1');
  assert.ok(/^ofx/.test(e.id));
  assert.deepStrictEqual(e.appearance, EFFECT_DEFAULTS.glow, 'defaults per type');
  assert.ok(!('samples' in e) && !('track' in e), 'no tracking data inside an effect');
  assert.deepStrictEqual(normalizeObjectEffect(JSON.parse(JSON.stringify(e))), e, 'save/load round trip');
  assert.deepStrictEqual(normalizeObjectEffectList(JSON.stringify([e])), [e], 'the export transport (a JSON string)');
  assert.strictEqual(normalizeObjectEffect({ type: 'sparkles', trackKey: 'k' }), null, 'unknown type');
  assert.strictEqual(normalizeObjectEffect({ type: 'outline' }), null, 'no track: not an effect');
  const wild = normalizeObjectEffect({ type: 'outline', trackKey: 'k', start: 2, end: 1, appearance: { thickness: 999, color: 'red', opacity: -1 } });
  assert.ok(wild.end >= wild.start + 0.1, 'end after start');
  assert.strictEqual(wild.appearance.thickness, 40);
  assert.strictEqual(wild.appearance.color, EFFECT_DEFAULTS.outline.color, 'a bad colour falls back');
  assert.strictEqual(wild.appearance.opacity, 0);
  assert.deepStrictEqual(normalizeObjectEffectList([e, null, { type: 'x' }, 'junk']).length, 1);
}
console.log('✓ Typed, keyed to a track (not a copy), defaults, ranges, round trip');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Confidence and loss: full, softened, held then gone — never extrapolated');
{
  const track = truthTrack('white', 0, 2, { uncertain: [[1.0, 1.0]], gaps: [] });
  const fx = createObjectEffect({ type: 'outline', trackKey: 'k', start: 0, end: 4 });
  fx.fade = 0;
  assert.strictEqual(effectStateAt(fx, track, 0.5).presence, 1, 'tracked: full');
  assert.strictEqual(effectStateAt(fx, track, 1.0).presence, EFFECT_POLICY.uncertainPresence.outline, 'uncertain: an outline softens');
  const between = effectStateAt(fx, track, 0.9).presence;
  assert.ok(between < 1 && between > EFFECT_POLICY.uncertainPresence.outline, `it eases into it, no jump (${between.toFixed(2)})`);
  const asType = (type) => ({ ...fx, type });
  assert.strictEqual(effectStateAt(asType('spotlight'), track, 1.0).presence, EFFECT_POLICY.uncertainPresence.spotlight, 'a spotlight barely softens — it dims the whole frame');
  assert.strictEqual(effectStateAt(asType('blur'), track, 1.0).presence, 1, 'a privacy blur does not let go when unsure');
  assert.strictEqual(effectStateAt(asType('blur'), track, 2.2).presence, 1, '...and holds the last sighting at full');
  assert.strictEqual(effectStateAt(asType('blur'), track, 2.0 + EFFECT_POLICY.holdSeconds + 0.01), null, '...then stops');
  // After the last sighting (2.0): held where it was last seen, fading, then nothing.
  const held = effectStateAt(fx, track, 2.15);
  assert.strictEqual(held.state, 'held');
  assert.ok(held.presence > 0.3 && held.presence < 0.6, `fading (${held.presence.toFixed(2)})`);
  assert.ok(iou(held.box, truth('white', 2.0)) > 0.9, 'held where it was last SEEN — not moved on by a guess');
  assert.strictEqual(effectStateAt(fx, track, 2.0 + EFFECT_POLICY.holdSeconds + 0.01), null, 'then gone');
  // Before the track starts: nothing, not even held.
  const late = truthTrack('white', 1, 2);
  assert.strictEqual(trackedRegionAt(late, 0.9), null);
  // A gap (lost and found again): held at its edge, gone inside, back after.
  const gapped = truthTrack('white', 0, 3, { gaps: [{ start: 1.0, end: 2.0, reason: 'lost' }] });
  assert.ok(effectStateAt(fx, gapped, 1.1)?.state === 'held');
  assert.strictEqual(effectStateAt(fx, gapped, 1.6), null, 'nothing claimed while lost');
  assert.strictEqual(effectStateAt(fx, gapped, 2.4).presence, 1, 'back when found');
  // Its own span and fade.
  const span = createObjectEffect({ type: 'glow', trackKey: 'k', start: 0.5, end: 1.5 });
  assert.strictEqual(effectStateAt(span, track, 0.4), null, 'not before its own start');
  assert.strictEqual(effectStateAt(span, track, 1.5), null, 'half-open: off at its end');
  assert.ok(effectStateAt(span, track, 0.55).presence < 0.3, 'fades in');
  assert.strictEqual(effectStateAt({ ...span, enabled: false }, track, 1.0), null, 'disabled');
}
console.log('✓ Policy holds; effect timing and fades respected');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] Geometry: the tracked box through the video\'s placement, padded');
{
  const placement = { canvasWidth: 1080, canvasHeight: 1080, boxWidth: 1080, boxHeight: 607.5, transform: { offsetXPct: 8, offsetYPct: -4, scale: 0.8, rotation: 15 } };
  const box = { x: 0.3, y: 0.4, width: 0.1, height: 0.5 };
  const fx = createObjectEffect({ type: 'outline', trackKey: 'k', start: 0, end: 1, appearance: { padding: 0 } });
  const g = effectGeometry(fx, box, placement, 1080, 1080);
  const corners = videoBoxToComposition(box, placement).map((p) => ({ x: p.x * 1080, y: p.y * 1080 }));
  const cx = corners.reduce((a, p) => a + p.x, 0) / 4;
  const cy = corners.reduce((a, p) => a + p.y, 0) / 4;
  assert.ok(Math.abs(g.cx - cx) < 1e-6 && Math.abs(g.cy - cy) < 1e-6, 'centred on the placed box');
  assert.ok(Math.abs(g.angle - (15 * Math.PI) / 180) < 1e-9, 'turned with the video');
  assert.ok(Math.abs(g.width - Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)) < 1e-6, 'its width');
  const padded = effectGeometry({ ...fx, appearance: { ...fx.appearance, padding: 0.1 } }, box, placement, 1080, 1080);
  assert.ok(padded.width > g.width && Math.abs((padded.width - g.width) - (padded.height - g.height)) < 1e-9, 'padding is even on every side');
  // The same region on a small (preview) canvas, scaled: the geometry is canvas-size independent.
  const small = effectGeometry(fx, box, { ...placement }, 540, 540);
  assert.ok(Math.abs(small.cx * 2 - g.cx) < 1e-6 && Math.abs(small.width * 2 - g.width) < 1e-6);
}
console.log('✓ Centred, rotated, sized and padded as the placement says, at any canvas size');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] One track, several effects; two tracks; a missing track');
{
  const white = truthTrack('white', 0, 3.4);
  const green = truthTrack('green', 0, 4);
  const tracks = { kw: white, kg: green };
  const placementAt = () => ({ canvasWidth: 640, canvasHeight: 360, boxWidth: 640, boxHeight: 360, transform: resolveVideoTransformAtTime({}, 0) });
  const effects = [
    createObjectEffect({ type: 'glow', trackKey: 'kw', start: 0, end: 4 }),
    createObjectEffect({ type: 'outline', trackKey: 'kw', start: 0, end: 4 }),
    createObjectEffect({ type: 'spotlight', trackKey: 'kg', start: 0, end: 4 }),
    createObjectEffect({ type: 'outline', trackKey: 'gone', start: 0, end: 4 })
  ];
  const r = resolveObjectEffects(effects, tracks, 1.0, placementAt, 640, 360);
  assert.strictEqual(r.length, 3, 'the effect on a missing track draws nothing');
  const [glow, outline, spot] = r;
  assert.deepStrictEqual(glow.state.box, outline.state.box, 'two effects on one track read the same tracked state');
  assert.ok(iou(spot.state.box, truth('green', 1.0)) > 0.9 && iou(glow.state.box, truth('white', 1.0)) > 0.9, 'each on its own object');
}
console.log('✓ Shared track read once per effect; separate objects separate; missing track skipped');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Real exports: square canvas, the video scaled, rotated and moved — export = no-effect export + the shared layer');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ofx-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-3000)))));
});
const SW = 640;
const SH = 360;
const DURATION = 4;
const FPS = 15;
const composition = { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } };
const videoTransform = { offsetXPct: 6, offsetYPct: -5, scale: 0.85, rotation: 12 };
const tracks = { kw: truthTrack('white', 0, 3.4), kg: truthTrack('green', 0, 4) };

async function render(name, effects) {
  const framesDir = path.join(work, name);
  fs.mkdirSync(framesDir, { recursive: true });
  const comp = prepareVideoComposition({ composition, videoStyle: null, sourceWidth: SW, sourceHeight: SH, outDir: path.join(framesDir, 'composition') });
  const params = { preset: 'caps-white', captionMode: 'sentence', composition, videoTransform, objectEffects: JSON.stringify(effects), objectEffectTracks: JSON.stringify(tracks) };
  const built = buildFullTimelineSegments([], params, comp.width, comp.height, DURATION, framesDir, { frameRate: String(FPS), videoBox: { boxWidth: comp.boxWidth, boxHeight: comp.boxHeight } });
  const out = path.join(work, `${name}.mp4`);
  await compositeGraphicsCaptionTrack(CROSSING, built.captions, out, {
    videoTransform, duration: DURATION, canvasWidth: comp.width, canvasHeight: comp.height, frameRate: String(FPS),
    composition: comp, layerRuns: built.runs, objectEffects: built.objectEffects
  });
  return { out, comp, built };
}
async function frameAt(file, k, W, H) {
  const raw = path.join(work, `${path.basename(file)}-${k}.rgb`);
  await run(['-y', '-ss', String(Math.max(0, k / FPS - 0.004)), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  assert.strictEqual(buf.length, W * H * 3);
  return buf;
}

const effects = [
  createObjectEffect({ type: 'outline', trackKey: 'kw', label: 'Person', start: 0.4, end: 4, appearance: { thickness: 8 } }),
  createObjectEffect({ type: 'glow', trackKey: 'kw', label: 'Person', start: 0.4, end: 4 }),
  createObjectEffect({ type: 'spotlight', trackKey: 'kg', label: 'Person', start: 0.4, end: 4 })
];
effects.forEach((e) => { e.fade = 0; });
const t0 = Date.now();
const [plain, withFx] = await Promise.all([render('plain', []), render('fx', effects)]);
console.log(`  two renders in ${Date.now() - t0}ms; ${withFx.built.objectEffects.overlay.length} effect segments`);
const { comp } = withFx;
const W = comp.width;
const H = comp.height;
assert.strictEqual(plain.built.objectEffects.overlay.length, 0, 'no effects: no effect stream at all');

const placementAt = (t) => ({ canvasWidth: W, canvasHeight: H, boxWidth: comp.boxWidth, boxHeight: comp.boxHeight, transform: resolveVideoTransformAtTime(videoTransform, t) });
const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

/** What the export SHOULD be at frame k: the no-effect frame, with the shared layer drawn over it. */
function expectedFrame(base, t) {
  const c = createCanvas(W, H);
  const cx = c.getContext('2d');
  const img = cx.createImageData(W, H);
  for (let i = 0, j = 0; j < base.length; i += 4, j += 3) { img.data[i] = base[j]; img.data[i + 1] = base[j + 1]; img.data[i + 2] = base[j + 2]; img.data[i + 3] = 255; }
  cx.putImageData(img, 0, 0);
  const layer = createCanvas(W, H);
  drawObjectEffects(layer.getContext('2d'), resolveObjectEffects(effects, tracks, t, placementAt, W, H), { canvasWidth: W, canvasHeight: H, createOffscreenCanvas: (w, h) => createCanvas(w, h) });
  cx.drawImage(layer, 0, 0);
  const d = cx.getImageData(0, 0, W, H).data;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}
const px = (rgb, x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [rgb[i], rgb[i + 1], rgb[i + 2]]; };

for (const k of [3, 8, 15, 24, 33, 45, 51, 54, 57]) {
  const t = k / FPS;
  const [a, b] = await Promise.all([frameAt(plain.out, k, W, H), frameAt(withFx.out, k, W, H)]);
  const exp = expectedFrame(a, t);
  const d = meanDiff(b, exp);
  const changed = meanDiff(b, a);
  console.log(`  t=${t.toFixed(2)}s: export vs expected Δ${d.toFixed(2)} (effects changed the frame by Δ${changed.toFixed(1)})`);
  assert.ok(d < 2.0, `t=${t.toFixed(2)}: the exported effects are the shared layer, where and when the preview draws it (Δ${d.toFixed(2)})`);
  // (An extra compositing pass alone moves a frame by under 1 level — colour conversion, not an effect.)
  if (t < 0.4) assert.ok(changed < 1.5, 'before the effects start: nothing drawn');
}
// Spot checks at 1.0s: the outline is on WHITE's padded box; outside the spotlight is dimmed; GREEN is not.
{
  const k = 15;
  const t = k / FPS;
  const [a, b] = await Promise.all([frameAt(plain.out, k, W, H), frameAt(withFx.out, k, W, H)]);
  const [outline] = resolveObjectEffects([effects[0]], tracks, t, placementAt, W, H);
  const g = outline.geometry;
  // The middle of the outline's top edge, in the rotated frame.
  const topMid = { x: g.cx + Math.sin(g.angle) * (g.height / 2), y: g.cy - Math.cos(g.angle) * (g.height / 2) };
  const [r, gg, bb] = px(b, topMid.x, topMid.y);
  assert.ok(gg > 170 && r < 120 && bb > 100, `outline colour on white's box (${r},${gg},${bb})`);
  const [spot] = resolveObjectEffects([effects[2]], tracks, t, placementAt, W, H);
  const inGreen = px(b, spot.geometry.cx, spot.geometry.cy);
  const inGreenPlain = px(a, spot.geometry.cx, spot.geometry.cy);
  assert.ok(Math.abs(inGreen[0] - inGreenPlain[0]) < 6, 'inside the spotlight: as it was');
  const corner = px(b, 4, 4);
  const cornerPlain = px(a, 4, 4);
  assert.ok(corner[0] < cornerPlain[0] * 0.55 && corner[0] > cornerPlain[0] * 0.25, `outside: dimmed (${cornerPlain[0]} → ${corner[0]})`);
}
// White leaves (his track ends 3.4s): the effects on him hold briefly, then go.
{
  const late = expectedFrame(await frameAt(plain.out, 57, W, H), 57 / FPS);
  assert.ok(meanDiff(await frameAt(withFx.out, 57, W, H), late) < 2.0);
  const onWhite = resolveObjectEffects(effects.slice(0, 2), tracks, 57 / FPS, placementAt, W, H);
  assert.strictEqual(onWhite.length, 0, 'gone 0.4s after his last sighting');
}
console.log('✓ Export = no-effect export + the shared effects layer, at every checked frame; outline, spotlight, timing and hold');

// ---------------------------------------------------------------------------
console.log('\n[Test 6] The blur: the tracked region of the video, Gaussian-blurred — and nothing else');
{
  const blur = [createObjectEffect({ type: 'blur', trackKey: 'kw', start: 0, end: 4, appearance: { strength: 0.6, padding: 0.05 } })];
  blur[0].fade = 0;
  const blurred = await render('blur', blur);
  assert.strictEqual(blurred.built.objectEffects.masks.length, 1);
  assert.strictEqual(blurred.built.objectEffects.masks[0].sigma, blurSigma(blur[0], W, H));
  for (const k of [6, 15, 30]) {
    const t = k / FPS;
    const [a, b] = await Promise.all([frameAt(plain.out, k, W, H), frameAt(blurred.out, k, W, H)]);
    const [r] = resolveObjectEffects(blur, tracks, t, placementAt, W, H);
    const g = r.geometry;
    const inside = (x, y) => {
      const dx = x - g.cx; const dy = y - g.cy;
      const u = dx * Math.cos(g.angle) + dy * Math.sin(g.angle);
      const v = -dx * Math.sin(g.angle) + dy * Math.cos(g.angle);
      return Math.abs(u) < g.width / 2 - 2 && Math.abs(v) < g.height / 2 - 2;
    };
    const outside = (x, y) => {
      const dx = x - g.cx; const dy = y - g.cy;
      const u = dx * Math.cos(g.angle) + dy * Math.sin(g.angle);
      const v = -dx * Math.sin(g.angle) + dy * Math.cos(g.angle);
      return Math.abs(u) > g.width / 2 + 3 || Math.abs(v) > g.height / 2 + 3;
    };
    // Detail (neighbour differences) inside the region: much less after the blur.
    let detailA = 0; let detailB = 0; let n = 0; let outDiff = 0; let m = 0;
    for (let y = 1; y < H; y += 1) {
      for (let x = 1; x < W; x += 1) {
        const i = (y * W + x) * 3;
        if (inside(x, y)) {
          detailA += Math.abs(a[i] - a[i - 3]) + Math.abs(a[i] - a[i - W * 3]);
          detailB += Math.abs(b[i] - b[i - 3]) + Math.abs(b[i] - b[i - W * 3]);
          n++;
        } else if (outside(x, y)) {
          outDiff += Math.abs(a[i] - b[i]); m++;
        }
      }
    }
    console.log(`  t=${t.toFixed(2)}s: detail inside ${(detailA / n).toFixed(2)} → ${(detailB / n).toFixed(2)}; outside Δ${(outDiff / m).toFixed(2)}`);
    assert.ok(detailB < detailA * 0.5, 'the region is blurred');
    assert.ok(outDiff / m < 1.0, 'nothing outside the region changes');
  }
}
console.log('✓ Blur follows the tracked region and touches nothing else');

// Debug aid: OFX_DUMP=<dir> keeps the exported files there.
if (process.env.OFX_DUMP) fs.readdirSync(work).filter((f) => f.endsWith('.mp4')).forEach((f) => fs.copyFileSync(path.join(work, f), path.join(process.env.OFX_DUMP, f)));
fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All object-aware effect checks passed ---');
