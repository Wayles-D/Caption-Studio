/**
 * SUBJECT ISOLATION & BACKGROUND REPLACEMENT (shared/objects/subject.js):
 * keeping the pixels a segmentation says are the object and putting
 * something else behind them.
 *
 *   - the model: 'background' is an object effect like any other (its own
 *     span, fade, enabled, undo-able shape), with its own appearance —
 *     the mode is one of three, an unknown one falls back, an asset id is
 *     carried whole;
 *   - edge work: GROW takes a halo of old background with the subject,
 *     SOFTEN gives it a gradient edge, both in reference pixels so they look
 *     the same at any canvas size;
 *   - the two draws: the background covers the VIDEO's rectangle only (not
 *     the whole canvas) and follows the video's scale/rotation/offset; the
 *     matte is the mask laid on the frame by the same transform;
 *   - NO MASK, NO CLAIM: a time with no mask draws neither, so the video is
 *     left exactly as it is;
 *   - REAL EXPORTS against segment.mp4's ground truth (the exact visible
 *     pixels of a person are known): the exported frame is the chosen
 *     background where the person is not, and the video's own pixels where
 *     he is — on a square canvas with the video scaled, moved and ROTATED;
 *   - an export with the effect off is byte-identical to one with no effect
 *     at all;
 *   - the mask bytes make the round trip through the export payload.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas } from '@napi-rs/canvas';
import { createObjectEffect, normalizeObjectEffect, resolveObjectEffects, effectUnit, OBJECT_EFFECT_TYPES, MASK_EFFECT_TYPES } from '../shared/objects/effects.js';
import {
  BACKGROUND_MODES, maskWithEdges, drawSubjectBackground, drawMaskAlpha, resolveSubjects, hasBackgroundEffect, traceVideoQuad
} from '../shared/objects/subject.js';
import { buildTrack, normalizeTrack } from '../shared/objects/tracking.js';
import { buildSegmentation, encodeRLE, createMaskReader, maskFrame, DEFAULT_SEGMENTATION_CONFIG } from '../shared/objects/segmentation.js';
import { videoToComposition } from '../shared/objects/coordinates.js';
import { prepareVideoComposition } from './utils/videoDecoration.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { truth, visibleMask, W as FW, H as FH } from '../tests/fixtures/objects/make-crossing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'tests', 'fixtures', 'objects');
const SEGMENT = path.join(fixtures, 'segment.mp4');

console.log('--- Subject isolation & background replacement ---');

const GRID = 64;
const offscreen = (w, h) => createCanvas(w, h);

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: a background is an effect, with its own appearance');
{
  assert.ok(OBJECT_EFFECT_TYPES.includes('background'));
  assert.deepStrictEqual(MASK_EFFECT_TYPES, ['background'], 'it is the type that needs pixels');
  const e = createObjectEffect({ type: 'background', trackKey: 'k', label: 'Person', start: 1, end: 3 });
  assert.strictEqual(e.appearance.mode, 'transparent', 'transparent by default');
  assert.ok(e.id && e.enabled && e.fade >= 0 && e.start === 1 && e.end === 3, 'an ordinary effect otherwise');
  const odd = normalizeObjectEffect({ type: 'background', trackKey: 'k', start: 0, end: 2, appearance: { mode: 'nonsense', color: 'blue', opacity: 5, imageAssetId: 'img-7', expand: -3 } });
  assert.strictEqual(odd.appearance.mode, 'transparent', 'an unknown mode falls back');
  assert.strictEqual(odd.appearance.color, '#000000', 'a colour that is not one falls back');
  assert.strictEqual(odd.appearance.opacity, 1, 'opacity stays in range');
  assert.strictEqual(odd.appearance.expand, 0, 'so does the edge');
  assert.strictEqual(odd.appearance.imageAssetId, 'img-7', 'the asset id is carried whole');
  BACKGROUND_MODES.forEach((mode) => assert.strictEqual(normalizeObjectEffect({ ...odd, appearance: { mode } }).appearance.mode, mode));
  assert.ok(hasBackgroundEffect([e]) && !hasBackgroundEffect([createObjectEffect({ type: 'blur', trackKey: 'k', start: 0, end: 1 })]));
  assert.ok(!hasBackgroundEffect([{ ...e, enabled: false }]), 'an effect that is off needs nothing');
  console.log('  ✓ type, defaults, ranges, fallbacks');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 2] The edge: grow takes the halo, soften makes a gradient, both scale with the canvas');
{
  // A solid square in the middle of a grid.
  const alpha = new Uint8Array(GRID * GRID);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) alpha[y * GRID + x] = 255;
  const mask = { alpha, grid: { width: GRID, height: GRID }, frame: { x: 0, y: 0, width: 1, height: 1 } };
  const count = (a, min = 128) => a.reduce((n, v) => n + (v >= min ? 1 : 0), 0);
  const plain = maskWithEdges(mask, { expand: 0, feather: 0 }, 1, GRID);
  assert.strictEqual(count(plain), 32 * 32, 'nothing asked for, nothing done');
  const grown = maskWithEdges(mask, { expand: 4, feather: 0 }, 1, GRID);
  assert.strictEqual(count(grown), 40 * 40, 'grown by exactly what was asked (4 cells each side)');
  // Every pixel that was in is still in: growing never eats the subject.
  for (let i = 0; i < alpha.length; i++) if (alpha[i] === 255) assert.strictEqual(grown[i], 255);
  const soft = maskWithEdges(mask, { expand: 0, feather: 4 }, 1, GRID);
  const edgeValues = [];
  for (let x = 10; x < 24; x++) edgeValues.push(soft[32 * GRID + x]);
  assert.ok(edgeValues.some((v) => v > 10 && v < 245), `the edge is a gradient, not a cliff (${edgeValues.join(',')})`);
  assert.strictEqual(soft[32 * GRID + 32], 255, 'the middle is untouched');
  assert.strictEqual(soft[32 * GRID + 2], 0, 'far outside stays out');
  // The SAME setting on a canvas twice the size covers the same share of the
  // object: the unit and the frame's canvas width both double, so the cells
  // asked for stay the same.
  const big = maskWithEdges(mask, { expand: 4, feather: 0 }, 2, GRID * 2);
  assert.strictEqual(count(big), count(grown), 'the same look at twice the size');
  console.log('  ✓ grow exact, soften gradual, size-independent');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 3] The two draws: the background covers the VIDEO, the matte is the mask');
{
  const W = 400;
  const H = 400;
  // A 16:9 video scaled down, moved and rotated on a square canvas.
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: W, boxHeight: W * (9 / 16), transform: { offsetXPct: 5, offsetYPct: -4, scale: 0.7, rotation: 15 } };
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const read = () => ctx.getImageData(0, 0, W, H).data;
  const at = (data, x, y) => [data[(y * W + x) * 4], data[(y * W + x) * 4 + 1], data[(y * W + x) * 4 + 2], data[(y * W + x) * 4 + 3]];
  const inVideo = (vx, vy) => {
    const p = videoToComposition({ x: vx, y: vy }, placement);
    return [Math.round(p.x * W), Math.round(p.y * H)];
  };

  ctx.clearRect(0, 0, W, H);
  const drew = drawSubjectBackground(ctx, { appearance: { mode: 'color', color: '#FF0000', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H });
  assert.ok(drew);
  let data = read();
  assert.deepStrictEqual(at(data, ...inVideo(0.5, 0.5)), [255, 0, 0, 255], 'the middle of the video is the colour');
  assert.deepStrictEqual(at(data, ...inVideo(0.05, 0.05)), [255, 0, 0, 255], 'a corner of the video too');
  assert.strictEqual(at(data, 2, 2)[3], 0, 'the canvas outside the video is untouched');
  assert.strictEqual(at(data, W - 3, H - 3)[3], 0, 'and its far corner');
  // Rotation: a point just outside the video's own rectangle is NOT covered.
  const outside = videoToComposition({ x: 1.08, y: 0.5 }, placement);
  assert.strictEqual(at(data, Math.round(outside.x * W), Math.round(outside.y * H))[3], 0, 'the cover is the rotated rectangle, not its bounding box');

  // Half opacity, and an effect only half present, multiply.
  ctx.clearRect(0, 0, W, H);
  drawSubjectBackground(ctx, { appearance: { mode: 'color', color: '#FFFFFF', opacity: 0.5 }, presence: 0.5, placement, canvasWidth: W, canvasHeight: H });
  const a = at(read(), ...inVideo(0.5, 0.5))[3];
  assert.ok(Math.abs(a - 64) <= 2, `opacity × presence (${a})`);

  // Transparent mode paints the canvas's own background.
  ctx.clearRect(0, 0, W, H);
  drawSubjectBackground(ctx, { appearance: { mode: 'transparent', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H, canvasBackground: '#00FF00' });
  assert.deepStrictEqual(at(read(), ...inVideo(0.5, 0.5)), [0, 255, 0, 255], 'transparent = the canvas showing through');

  // An image mode with no image draws nothing at all.
  ctx.clearRect(0, 0, W, H);
  assert.strictEqual(drawSubjectBackground(ctx, { appearance: { mode: 'image', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H, image: null }), false);
  assert.strictEqual(at(read(), ...inVideo(0.5, 0.5))[3], 0, 'no image: the video is left alone');

  // The matte: a mask over the left half of a box lands on the left half of
  // that box ON SCREEN, however the video is placed.
  const alpha = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID / 2; x++) alpha[y * GRID + x] = 255;
  const box = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
  const frame = maskFrame(box, 0);
  ctx.clearRect(0, 0, W, H);
  drawMaskAlpha(ctx, { grid: { width: GRID, height: GRID }, frame }, alpha, placement, W, H, offscreen);
  data = read();
  assert.strictEqual(at(data, ...inVideo(0.35, 0.5))[3], 255, 'the covered half is opaque');
  assert.strictEqual(at(data, ...inVideo(0.65, 0.5))[3], 0, 'the other half is not');
  assert.strictEqual(at(data, ...inVideo(0.35, 0.1))[3], 0, 'and nothing outside the box');
  // ROUNDED CORNERS: the video's own (shared/composition.js's videoStyle)
  // cut the background too — otherwise a square of colour would sit inside a
  // rounded frame. The border and shadow are drawn OUTSIDE the box, so the
  // background never reaches them.
  ctx.clearRect(0, 0, W, H);
  drawSubjectBackground(ctx, { appearance: { mode: 'color', color: '#FF0000', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H, cornerRadiusPct: 25 });
  data = read();
  assert.deepStrictEqual(at(data, ...inVideo(0.5, 0.5)), [255, 0, 0, 255], 'the middle is still filled');
  assert.strictEqual(at(data, ...inVideo(0.004, 0.006))[3], 0, 'the rounded-away corner is NOT filled');
  const sq = createCanvas(W, H);
  const sctx = sq.getContext('2d');
  drawSubjectBackground(sctx, { appearance: { mode: 'color', color: '#FF0000', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H });
  const square = sctx.getImageData(0, 0, W, H).data;
  assert.strictEqual(at(square, ...inVideo(0.004, 0.006))[3], 255, 'and a square video fills it');
  console.log('  ✓ background clipped to the placed video and its rounded corners; matte placed by the same transform');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 4] No mask, no claim');
{
  const W = 200;
  const H = 200;
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: W, boxHeight: H, transform: {} };
  const track = truthTrack('olive', 0, 2);
  const effect = createObjectEffect({ type: 'background', trackKey: 'k', start: 0, end: 2, appearance: { mode: 'color', color: '#FF0000' } });
  effect.fade = 0;
  const resolved = resolveObjectEffects([effect], { k: track }, 1.0, () => placement, W, H);
  assert.strictEqual(resolved.length, 1, 'the effect is on');
  assert.deepStrictEqual(resolveSubjects(resolved, () => null, 1.0, placement, W, H, effectUnit(W, H)), [], 'no mask: no subject, so nothing is drawn');
  console.log('  ✓ a time with no mask isolates nothing');
}

// ---------------------------------------------------------------------------
// A track and a segmentation of segment.mp4's OLIVE, built from the fixture's
// own ground truth: the pipeline is what is under test here, not the model.
function truthTrack(name, from, to, scene = 'segment') {
  const samples = [];
  for (let t = from; t <= to + 1e-9; t += 0.2) {
    samples.push({ time: +t.toFixed(3), box: truth(name, +t.toFixed(3), scene), confidence: 0.95, state: 'tracked' });
  }
  return normalizeTrack({
    ...buildTrack({
      detection: { id: 'det-truth', class: 'person', label: 'Person', confidence: 0.95, box: samples[0].box, time: from },
      config: {}, samples, ends: { forward: { reason: 'video-end', time: to }, backward: { reason: 'video-start', time: from } }
    }),
    source: { videoKey: 'v', detectionCacheKey: 'd' }
  });
}

/** The fixture's exact visible pixels of `name` at `t`, as a mask grid over its box. */
async function truthMask(name, t, grid = 96) {
  const full = await visibleMask(name, t, 'segment');
  const box = truth(name, t, 'segment');
  const frame = maskFrame(box, DEFAULT_SEGMENTATION_CONFIG.margin);
  const h = Math.max(1, Math.round((grid * frame.height * FH) / (frame.width * FW)));
  const out = new Uint8Array(grid * h);
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const vx = Math.round((frame.x + ((gx + 0.5) / grid) * frame.width) * FW);
      const vy = Math.round((frame.y + ((gy + 0.5) / h) * frame.height) * FH);
      out[gy * grid + gx] = vx >= 0 && vx < FW && vy >= 0 && vy < FH ? full[vy * FW + vx] : 0;
    }
  }
  return { alpha: out, grid: { width: grid, height: h } };
}

console.log('\n[Test 5] Real export against ground truth: the background replaces the frame, the person does not');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-subj-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-3000)))));
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const DURATION = 3;
const FPS = 15;
const TIMES = [0.4, 0.8, 1.2];
const BG = { r: 255, g: 0, b: 255 };

const track = truthTrack('olive', 0, DURATION);
// A segmentation whose masks are the fixture's own truth, at the times the
// export will ask for them.
const keyMasks = [];
const keyframes = [];
let grid = null;
for (const t of TIMES) {
  const m = await truthMask('olive', t);
  grid = m.grid;
  keyframes.push({ time: t, confidence: 0.95, level: 'high', state: 'tracked' });
  keyMasks.push(encodeRLE(m.alpha));
}
const record = buildSegmentation({ track, trackKey: 'kolive', config: { ...DEFAULT_SEGMENTATION_CONFIG, step: 0.4 }, grid, keyframes });
const payload = { kolive: { record, masks: keyMasks.map((p) => Buffer.from(p).toString('base64')).join(' ') } };

const composition = { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } };
const videoTransform = { offsetXPct: 4, offsetYPct: -3, scale: 0.8, rotation: 10 };

async function render(name, effects, { segmentations = payload } = {}) {
  const framesDir = path.join(work, name);
  fs.mkdirSync(framesDir, { recursive: true });
  const comp = prepareVideoComposition({ composition, videoStyle: null, sourceWidth: FW, sourceHeight: FH, outDir: path.join(framesDir, 'composition') });
  const params = {
    preset: 'caps-white', captionMode: 'sentence', composition, videoTransform,
    objectEffects: JSON.stringify(effects),
    objectEffectTracks: JSON.stringify({ kolive: track }),
    objectSegmentations: JSON.stringify(segmentations)
  };
  const built = buildFullTimelineSegments([], params, comp.width, comp.height, DURATION, framesDir, { frameRate: String(FPS), videoBox: { boxWidth: comp.boxWidth, boxHeight: comp.boxHeight } });
  const out = path.join(work, `${name}.mp4`);
  await compositeGraphicsCaptionTrack(SEGMENT, built.captions, out, {
    videoTransform, duration: DURATION, canvasWidth: comp.width, canvasHeight: comp.height, frameRate: String(FPS),
    composition: comp, layerRuns: built.runs, objectEffects: built.objectEffects
  });
  return { out, comp, built };
}

async function frameAt(file, t, W, H) {
  const raw = path.join(work, `${path.basename(file)}-${Math.round(t * 1000)}.rgb`);
  await run(['-y', '-ss', String(Math.max(0, t - 0.004)), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  assert.strictEqual(buf.length, W * H * 3);
  return buf;
}

{
  const bgEffect = createObjectEffect({ type: 'background', trackKey: 'kolive', label: 'Person', start: 0, end: DURATION, appearance: { mode: 'color', color: '#FF00FF', expand: 0, feather: 0 } });
  bgEffect.fade = 0;
  const t0 = Date.now();
  const [plain, isolated] = await Promise.all([render('plain', []), render('bg', [bgEffect])]);
  console.log(`  two renders in ${Date.now() - t0}ms; ${isolated.built.objectEffects.background.length} background frames`);
  assert.ok(isolated.built.objectEffects.background.length > 1, 'a background stream');
  assert.ok(isolated.built.objectEffects.subjectMask.length > 1, 'a matte stream');
  assert.strictEqual(plain.built.objectEffects.background.length, 0, 'a project without the effect has neither');

  const { comp } = isolated;
  const W = comp.width;
  const H = comp.height;
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: comp.boxWidth, boxHeight: comp.boxHeight, transform: videoTransform };
  for (const t of TIMES) {
    const [before, after] = await Promise.all([frameAt(plain.out, t, W, H), frameAt(isolated.out, t, W, H)]);
    const full = await visibleMask('olive', t, 'segment');
    let onPerson = 0;
    let personKept = 0;
    let offPerson = 0;
    let offReplaced = 0;
    // Walk the VIDEO's own pixels and ask what became of each on screen.
    for (let vy = 4; vy < FH - 4; vy += 3) {
      for (let vx = 4; vx < FW - 4; vx += 3) {
        const p = videoToComposition({ x: vx / FW, y: vy / FH }, placement);
        const sx = Math.round(p.x * W);
        const sy = Math.round(p.y * H);
        if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
        const i = (sy * W + sx) * 3;
        const isBg = near(after[i], BG.r, 40) && near(after[i + 1], BG.g, 40) && near(after[i + 2], BG.b, 40);
        // A pixel well inside the person, and one well away from him: the
        // edge itself is the mask's own accuracy, not the pipeline's.
        const a = full[vy * FW + vx];
        if (a > 250) {
          const neighbours = [full[(vy - 3) * FW + vx], full[(vy + 3) * FW + vx], full[vy * FW + vx - 3], full[vy * FW + vx + 3]];
          if (neighbours.every((v) => v > 250)) {
            onPerson++;
            // Kept = unchanged from the plain render.
            if (near(after[i], before[i], 36) && near(after[i + 1], before[i + 1], 36) && near(after[i + 2], before[i + 2], 36) && !isBg) personKept++;
          }
        } else if (a === 0) {
          const neighbours = [full[(vy - 3) * FW + vx], full[(vy + 3) * FW + vx], full[vy * FW + vx - 3], full[vy * FW + vx + 3]];
          if (neighbours.every((v) => v === 0)) {
            offPerson++;
            if (isBg) offReplaced++;
          }
        }
      }
    }
    const kept = personKept / Math.max(1, onPerson);
    const replaced = offReplaced / Math.max(1, offPerson);
    assert.ok(onPerson > 200 && offPerson > 2000, `enough pixels sampled at ${t}s (${onPerson} on, ${offPerson} off)`);
    assert.ok(kept > 0.9, `${t}s: the person's own pixels kept (${(kept * 100).toFixed(1)}%)`);
    assert.ok(replaced > 0.97, `${t}s: everything else is the new background (${(replaced * 100).toFixed(1)}%)`);
    console.log(`  ✓ ${t}s: ${(kept * 100).toFixed(1)}% of the person kept, ${(replaced * 100).toFixed(1)}% of the rest replaced`);
  }

  // Outside the effect's span the video is untouched — and an effect that is
  // off, or one whose masks never arrived, leaves the export exactly as it
  // would have been.
  const short = createObjectEffect({ type: 'background', trackKey: 'kolive', start: 0, end: 0.5, appearance: { mode: 'color', color: '#FF00FF' } });
  short.fade = 0;
  const [spanned, off, noMasks] = await Promise.all([
    render('span', [short]),
    render('off', [{ ...bgEffect, enabled: false }]),
    render('nomasks', [bgEffect], { segmentations: {} })
  ]);
  const late = await frameAt(spanned.out, 1.2, W, H);
  const plainLate = await frameAt(plain.out, 1.2, W, H);
  // Past the effect both streams are blank, so the video passes through the
  // two extra stages unchanged — but it does PASS THROUGH them, and an
  // overlay works in RGB while the file is YUV, so the frame is re-rounded
  // (the same cost V1.9 blur already pays). Invisible, and only ever paid by
  // a project that uses the effect: one with none has no streams at all, and
  // the switched-off render below is byte-identical.
  let worst = 0;
  let total = 0;
  for (let i = 0; i < late.length; i++) { const d = Math.abs(late[i] - plainLate[i]); if (d > worst) worst = d; total += d; }
  const mean = total / late.length;
  assert.ok(mean < 2 && worst < 32, `past the effect the frame is visually the no-effect frame (mean ${mean.toFixed(2)}, worst ${worst})`);
  assert.strictEqual(off.built.objectEffects.background.length, 0, 'an effect that is off: no streams');
  assert.strictEqual(noMasks.built.objectEffects.background.length, 0, 'no masks on this device: no streams');
  const offFrame = await frameAt(off.out, 0.8, W, H);
  assert.ok(offFrame.equals(await frameAt(plain.out, 0.8, W, H)), 'an effect that is off changes nothing');
  console.log('  ✓ outside its span, switched off, and without its masks: the export is unchanged');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 6] The masks make the round trip, and transparent shows the canvas');
{
  const parts = keyMasks.map((p) => Buffer.from(p).toString('base64'));
  const back = parts.map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
  back.forEach((part, i) => assert.deepStrictEqual([...part], [...keyMasks[i]], `keyframe ${i} survives base64`));
  const reader = createMaskReader(record, back);
  const first = reader.mask(0);
  assert.strictEqual(first.length, record.grid.width * record.grid.height);
  assert.ok(first.some((v) => v > 200) && first.some((v) => v === 0), 'a real silhouette, not a blank or a block');

  // Transparent: the canvas's own background, out of the composition.
  const transparent = createObjectEffect({ type: 'background', trackKey: 'kolive', start: 0, end: DURATION, appearance: { mode: 'transparent' } });
  transparent.fade = 0;
  const r = await render('clear', [transparent]);
  const W = r.comp.width;
  const H = r.comp.height;
  const frame = await frameAt(r.out, 0.8, W, H);
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: r.comp.boxWidth, boxHeight: r.comp.boxHeight, transform: videoTransform };
  const p = videoToComposition({ x: 0.08, y: 0.1 }, placement);
  const i = (Math.round(p.y * H) * W + Math.round(p.x * W)) * 3;
  assert.ok(frame[i] > 235 && frame[i + 1] > 235 && frame[i + 2] > 235, `the canvas's white shows where the video was (${frame[i]},${frame[i + 1]},${frame[i + 2]})`);
  console.log('  ✓ RLE round trip; transparent shows the canvas');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 7] An IMAGE background, and TWO subjects isolated at once');
{
  // A background image the export loads like any other picture asset.
  const imgFile = path.join(work, 'bg.png');
  {
    const c = createCanvas(200, 100);
    const g = c.getContext('2d');
    g.fillStyle = '#00A0FF';
    g.fillRect(0, 0, 200, 100);
    g.fillStyle = '#FFE000';
    g.fillRect(0, 0, 200, 20);
    fs.writeFileSync(imgFile, c.toBuffer('image/png'));
  }
  const { loadImage } = await import('@napi-rs/canvas');
  const picture = await loadImage(imgFile);

  const W = 300;
  const H = 300;
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: W, boxHeight: W * (FH / FW), transform: {} };
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawSubjectBackground(ctx, { appearance: { mode: 'image', opacity: 1 }, presence: 1, placement, canvasWidth: W, canvasHeight: H, image: picture });
  const data = ctx.getImageData(0, 0, W, H).data;
  const px = (x, y) => [data[(y * W + x) * 4], data[(y * W + x) * 4 + 1], data[(y * W + x) * 4 + 2], data[(y * W + x) * 4 + 3]];
  const mid = videoToComposition({ x: 0.5, y: 0.5 }, placement);
  const midPx = px(Math.round(mid.x * W), Math.round(mid.y * H));
  assert.ok(midPx[3] === 255 && midPx[2] > 150, 'the image fills the video (its blue shows)');
  const above = videoToComposition({ x: 0.5, y: -0.4 }, placement);
  assert.strictEqual(px(Math.round(above.x * W), Math.max(0, Math.round(above.y * H)))[3], 0, 'and nothing outside the video');
  // The image COVERS: a 2:1 picture in a 16:9 video keeps its own shape, so
  // its yellow stripe is still a stripe, not stretched over everything.
  let yellow = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const q = px(x, y); if (q[3] > 200 && q[0] > 200 && q[1] > 180 && q[2] < 100) yellow++; }
  let filled = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px(x, y)[3] > 200) filled++;
  assert.ok(yellow > 0 && yellow / filled < 0.4, `the picture keeps its shape (${((yellow / filled) * 100).toFixed(0)}% stripe)`);

  // TWO subjects: the second person in the same clip, isolated at the same
  // time, each from its own track and its own segmentation.
  const shirtTrack = truthTrack('shirt', 0, DURATION);
  const shirtKeys = [];
  const shirtMasks = [];
  let shirtGrid = null;
  for (const t of TIMES) {
    const m = await truthMask('shirt', t);
    shirtGrid = m.grid;
    shirtKeys.push({ time: t, confidence: 0.95, level: 'high', state: 'tracked' });
    shirtMasks.push(encodeRLE(m.alpha));
  }
  const shirtRecord = buildSegmentation({ track: shirtTrack, trackKey: 'kshirt', config: { ...DEFAULT_SEGMENTATION_CONFIG, step: 0.4 }, grid: shirtGrid, keyframes: shirtKeys });
  const both = {
    ...payload,
    kshirt: { record: shirtRecord, masks: shirtMasks.map((q) => Buffer.from(q).toString('base64')).join(' ') }
  };
  const two = [
    createObjectEffect({ type: 'background', trackKey: 'kolive', start: 0, end: DURATION, appearance: { mode: 'color', color: '#FF00FF', expand: 0, feather: 0 } }),
    createObjectEffect({ type: 'background', trackKey: 'kshirt', start: 0, end: DURATION, appearance: { mode: 'color', color: '#FF00FF', expand: 0, feather: 0 } })
  ];
  two.forEach((e) => { e.fade = 0; });
  const framesDir = path.join(work, 'two');
  fs.mkdirSync(framesDir, { recursive: true });
  const comp = prepareVideoComposition({ composition, videoStyle: null, sourceWidth: FW, sourceHeight: FH, outDir: path.join(framesDir, 'composition') });
  const params = {
    preset: 'caps-white', captionMode: 'sentence', composition, videoTransform,
    objectEffects: JSON.stringify(two),
    objectEffectTracks: JSON.stringify({ kolive: track, kshirt: shirtTrack }),
    objectSegmentations: JSON.stringify(both)
  };
  const built = buildFullTimelineSegments([], params, comp.width, comp.height, DURATION, framesDir, { frameRate: String(FPS), videoBox: { boxWidth: comp.boxWidth, boxHeight: comp.boxHeight } });
  const out = path.join(work, 'two.mp4');
  await compositeGraphicsCaptionTrack(SEGMENT, built.captions, out, {
    videoTransform, duration: DURATION, canvasWidth: comp.width, canvasHeight: comp.height, frameRate: String(FPS),
    composition: comp, layerRuns: built.runs, objectEffects: built.objectEffects
  });
  const CW = comp.width;
  const CH = comp.height;
  const frame = await frameAt(out, 0.4, CW, CH);
  const place2 = { canvasWidth: CW, canvasHeight: CH, boxWidth: comp.boxWidth, boxHeight: comp.boxHeight, transform: videoTransform };
  const bothKept = {};
  for (const who of ['olive', 'shirt']) {
    const full = await visibleMask(who, 0.4, 'segment');
    let on = 0;
    let kept = 0;
    for (let vy = 4; vy < FH - 4; vy += 3) {
      for (let vx = 4; vx < FW - 4; vx += 3) {
        if (full[vy * FW + vx] <= 250) continue;
        const q = videoToComposition({ x: vx / FW, y: vy / FH }, place2);
        const sx = Math.round(q.x * CW);
        const sy = Math.round(q.y * CH);
        if (sx < 1 || sy < 1 || sx >= CW - 1 || sy >= CH - 1) continue;
        const i = (sy * CW + sx) * 3;
        on++;
        if (!(near(frame[i], BG.r, 40) && near(frame[i + 1], BG.g, 40) && near(frame[i + 2], BG.b, 40))) kept++;
      }
    }
    bothKept[who] = kept / Math.max(1, on);
    assert.ok(on > 200, `enough of ${who} sampled (${on})`);
  }
  assert.ok(bothKept.olive > 0.9 && bothKept.shirt > 0.9, `both subjects survive their own isolation (olive ${(bothKept.olive * 100).toFixed(1)}%, shirt ${(bothKept.shirt * 100).toFixed(1)}%)`);
  console.log(`  ✓ an image background covers without stretching; two subjects kept at once (olive ${(bothKept.olive * 100).toFixed(1)}%, shirt ${(bothKept.shirt * 100).toFixed(1)}%)`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log('\nAll subject isolation checks passed.');
