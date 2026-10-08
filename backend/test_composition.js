/**
 * THE COMPOSITION (shared/composition.js) — the canvas, its background, and
 * the video placed inside it — from the model to a REAL ffmpeg render:
 *
 *   - the model: defaults, normalization, the three ratios, the video's
 *     resting box, JSON transport;
 *   - migration: a project that never set a composition renders EXACTLY as
 *     before — the same ffmpeg graph, byte for byte;
 *   - export: a reshaped canvas with a coloured background, the video moved,
 *     scaled, rotated (and keyframed), rounded, bordered and shadowed, with a
 *     shape over it — checked frame by frame against the shared composition
 *     maths drawn independently with a 2D canvas.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas } from '@napi-rs/canvas';
import {
  normalizeComposition, normalizeVideoStyle, resolveComposition, videoBaseBox, isPassthroughComposition,
  hasVideoDecoration, videoDecorationMetrics, drawVideoDecoration, COMPOSITION_DEFAULTS, ASPECT_RATIOS
} from '../shared/composition.js';
import { resolveVideoTransformAtTime } from '../shared/videoTransform.js';
import { normalizeShapeLayer, drawShapeLayer } from '../shared/shapeLayer.js';
import { buildVideoTransformFilterChain } from './utils/videoTransformFilter.js';
import { prepareVideoComposition, compositionNeedsRender } from './utils/videoDecoration.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';

console.log('--- The Composition ---');

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: defaults, ratios, the resting box');
{
  assert.deepStrictEqual(normalizeComposition(null), COMPOSITION_DEFAULTS, 'nothing stored = the source frame, black');
  assert.deepStrictEqual(normalizeComposition({ aspectRatio: '7:3', background: { type: 'video', color: 'red' } }), COMPOSITION_DEFAULTS, 'unknown values fall back');
  assert.deepStrictEqual(normalizeComposition(JSON.stringify({ aspectRatio: '1:1' })).aspectRatio, '1:1', 'JSON transport');
  const sizes = (src) => ['original', '9:16', '16:9', '1:1'].map((aspectRatio) => {
    const c = resolveComposition({ aspectRatio }, src[0], src[1]);
    return `${c.width}x${c.height}`;
  });
  assert.deepStrictEqual(sizes([1080, 1920]), ['1080x1920', '1080x1920', '1920x1080', '1080x1080'], 'a phone video keeps its 1080px short side');
  assert.deepStrictEqual(sizes([1920, 1080]), ['1920x1080', '1080x1920', '1920x1080', '1080x1080'], 'and a landscape one');
  assert.deepStrictEqual(sizes([721, 1281]), ['721x1281', '722x1282', '1282x722', '722x722'], 'reshaped sizes are even (yuv420p); the original is untouched');
  // Every other shape on offer, from a 1080x1920 phone video: the short side
  // stays 1080, the long side follows the ratio, and it is always even.
  const every = Object.fromEntries(Object.keys(ASPECT_RATIOS).map((aspectRatio) => {
    const c = resolveComposition({ aspectRatio }, 1080, 1920);
    return [aspectRatio, `${c.width}x${c.height}`];
  }));
  assert.deepStrictEqual(every, {
    original: '1080x1920', '9:16': '1080x1920', '16:9': '1920x1080', '1:1': '1080x1080',
    '4:5': '1080x1350', '3:4': '1080x1440', '4:3': '1440x1080',
    '2:1': '2160x1080', '2.35:1': '2538x1080', '1.85:1': '1998x1080'
  });
  for (const [aspectRatio, [a, b]] of Object.entries(ASPECT_RATIOS).filter(([, r]) => r)) {
    const c = resolveComposition({ aspectRatio }, 721, 1281);
    assert.ok(c.width % 2 === 0 && c.height % 2 === 0, `${aspectRatio}: even sides`);
    assert.ok(Math.abs(c.width / c.height - a / b) < 0.01, `${aspectRatio}: the shape is the ratio (${c.width}x${c.height})`);
  }
  const sq = resolveComposition({ aspectRatio: '1:1' }, 1080, 1920);
  assert.deepStrictEqual(videoBaseBox(sq, 1080, 1920), { width: 607.5, height: 1080 }, 'a 9:16 video in a square canvas: whole, as tall as the canvas');
  assert.deepStrictEqual(videoBaseBox(resolveComposition({ aspectRatio: '9:16' }, 1920, 1080), 1920, 1080), { width: 1080, height: 607.5 }, 'a landscape video in a vertical canvas: whole, as wide as it');
  assert.ok(isPassthroughComposition(resolveComposition(null, 720, 1280), 720, 1280));
  assert.ok(!isPassthroughComposition(sq, 1080, 1920));
  assert.strictEqual(hasVideoDecoration(null), false);
  assert.strictEqual(hasVideoDecoration({ border: { enabled: true, width: 0 } }), false, 'a zero-width border is nothing');
  assert.strictEqual(hasVideoDecoration({ cornerRadius: 10 }), true);
  assert.strictEqual(normalizeVideoStyle({ cornerRadius: 90 }).cornerRadius, 50, 'corners clamp to fully round');
  const m = videoDecorationMetrics({ cornerRadius: 10, border: { enabled: true, width: 3 } }, 300, 600, 660);
  assert.strictEqual(m.radius, 30, '10% of the shorter side');
  assert.strictEqual(m.borderWidth, 6, 'authored px against a 330px canvas: double on a 660px one');
  assert.strictEqual(m.outerRadius, 36, 'the ring\'s outer corner = radius + width, as CSS box-shadow spread does');
  assert.strictEqual(compositionNeedsRender({}), false);
  assert.strictEqual(compositionNeedsRender({ composition: { aspectRatio: '1:1' } }), true);
  assert.strictEqual(compositionNeedsRender({ videoStyle: JSON.stringify({ shadow: { enabled: true } }) }), true);
}
console.log('✓ Defaults are the source frame; ratios keep the short side; the video fits whole');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Migration: an untouched project renders exactly as before');
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-comp-legacy-'));
  const legacy = prepareVideoComposition({ composition: null, videoStyle: null, sourceWidth: 720, sourceHeight: 1280, outDir: work });
  assert.strictEqual(legacy.passthrough, true);
  assert.deepStrictEqual([legacy.width, legacy.height], [720, 1280], 'the canvas is the source frame');
  assert.deepStrictEqual(legacy.files, {}, 'nothing drawn');
  assert.strictEqual(buildVideoTransformFilterChain(undefined, 5, 720, 1280, legacy), null, 'no transform: [0:v] as-is, as always');
  const vt = { scale: 1.2, rotation: 8, keyframes: [{ t: 1, values: { positionX: 0 } }, { t: 3, values: { positionX: 10 } }] };
  assert.strictEqual(
    buildVideoTransformFilterChain(vt, 5, 720, 1280, legacy).filterComplex,
    buildVideoTransformFilterChain(vt, 5, 720, 1280).filterComplex,
    'with a transform: the graph is byte-identical to the one built without any composition'
  );
  // A background colour on the source-shaped canvas only shows when the video
  // doesn't cover it — and then it is that colour, not black.
  const white = prepareVideoComposition({ composition: { background: { color: '#FFFFFF' } }, sourceWidth: 720, sourceHeight: 1280, outDir: work });
  assert.match(buildVideoTransformFilterChain({ scale: 0.5 }, 5, 720, 1280, white).filterComplex, /color=0xFFFFFF/);
}
console.log('✓ Same graph, same file');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] A real render: square canvas, white, the video moved/scaled/rotated/keyframed, rounded, bordered, shadowed');
const SW = 360;
const SH = 640;
const DURATION = 3;
const FPS = 30;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-comp-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-3000)))));
});
// A source with structure everywhere — quadrants and a grid — so any error in
// where the video lands, how big it is or which way it turns shows.
const pattern = createCanvas(SW, SH);
{
  const pc = pattern.getContext('2d');
  const quads = ['#1D4ED8', '#16A34A', '#F59E0B', '#9333EA'];
  quads.forEach((c, i) => { pc.fillStyle = c; pc.fillRect((i % 2) * SW / 2, Math.floor(i / 2) * SH / 2, SW / 2, SH / 2); });
  pc.strokeStyle = '#FFFFFF';
  pc.lineWidth = 16;
  for (let x = 60; x < SW; x += 120) { pc.beginPath(); pc.moveTo(x, 0); pc.lineTo(x, SH); pc.stroke(); }
  for (let y = 60; y < SH; y += 120) { pc.beginPath(); pc.moveTo(0, y); pc.lineTo(SW, y); pc.stroke(); }
}
const patternFile = path.join(work, 'pattern.png');
fs.writeFileSync(patternFile, pattern.toBuffer('image/png'));
const src = path.join(work, 'src.mp4');
await run(['-y', '-loop', '1', '-framerate', String(FPS), '-t', String(DURATION), '-i', patternFile, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', src]);

const compositionModel = { aspectRatio: '1:1', background: { type: 'solid', color: '#FFFFFF' } };
const videoStyle = {
  cornerRadius: 12,
  border: { enabled: true, width: 3, color: '#E11D48', opacity: 100 },
  shadow: { enabled: true, blur: 10, offsetX: 4, offsetY: 8, color: '#000000', opacity: 60 }
};
// Static position/scale; rotation keyframed 0 -> 15 between 0.5 and 2.0s.
const videoTransform = { offsetXPct: 8, offsetYPct: -4, scale: 0.8, keyframes: [{ t: 0.5, values: { rotation: 0 } }, { t: 2.0, values: { rotation: 15 } }] };
const shape = normalizeShapeLayer({ id: 's1', kind: 'rectangle', start: 0, end: DURATION, transform: { x: 80, y: 85, width: 20, height: 10 }, appearance: { fill: { color: '#22D3EE' } } });
const params = { preset: 'caps-white', captionMode: 'sentence', shapeLayers: [shape], composition: compositionModel, videoStyle, videoTransform };

const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const comp = prepareVideoComposition({ composition: compositionModel, videoStyle, sourceWidth: SW, sourceHeight: SH, outDir: path.join(framesDir, 'composition') });
assert.deepStrictEqual([comp.width, comp.height], [360, 360]);
assert.ok(comp.files.mask && comp.files.under && comp.files.over, 'mask, shadow and border drawn');
const W = comp.width;
const H = comp.height;
const built = buildFullTimelineSegments([], params, W, H, DURATION, framesDir, { frameRate: String(FPS) });
const out = path.join(work, 'out.mp4');
await compositeGraphicsCaptionTrack(src, built.captions, out, {
  videoTransform, duration: DURATION, canvasWidth: W, canvasHeight: H, frameRate: String(FPS),
  composition: comp, layerRuns: built.runs
});

const probe = await new Promise((resolve) => {
  const proc = spawn(ffmpegPath, ['-i', out]);
  let s = '';
  proc.stderr.on('data', (d) => { s += d.toString(); });
  proc.on('close', () => resolve(s));
});
assert.match(probe, /360x360/, 'the file is the composition\'s size');
const [hh, mm, ss] = probe.match(/Duration: (\d+):(\d+):([\d.]+)/).slice(1).map(Number);
assert.ok(Math.abs(hh * 3600 + mm * 60 + ss - DURATION) < 0.1, `the file is as long as the source (${ss}s) — the looped corner mask must not outlast it`);

async function exported(k) {
  const raw = path.join(work, `f${k}.rgb`);
  await run(['-y', '-ss', String(Math.max(0, k / FPS - 0.004)), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  return fs.readFileSync(raw);
}

// The reference: the shared composition maths, drawn with a 2D canvas — the
// video fitted into its box, masked, its shadow under and border over, then
// moved/scaled/rotated about its centre, on the background; the shape on top.
// The SOURCE as decoded, not the PNG it was made from: the encode's own
// colour conversion is the same in both, so only the composition is compared.
const decodedSource = createCanvas(SW, SH);
{
  const raw = path.join(work, 'src0.rgb');
  await run(['-y', '-i', src, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const rgb = fs.readFileSync(raw);
  const dc = decodedSource.getContext('2d');
  const img = dc.createImageData(SW, SH);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { img.data[i] = rgb[j]; img.data[i + 1] = rgb[j + 1]; img.data[i + 2] = rgb[j + 2]; img.data[i + 3] = 255; }
  dc.putImageData(img, 0, 0);
}
const box = { width: comp.boxWidth, height: comp.boxHeight };
const metrics = videoDecorationMetrics(videoStyle, box.width, box.height, W);
const LW = box.width + 2 * metrics.pad;
const LH = box.height + 2 * metrics.pad;
const layer = createCanvas(LW, LH);
{
  const lc = layer.getContext('2d');
  drawVideoDecoration(lc, 'under', metrics, box.width, box.height);
  const vid = createCanvas(box.width, box.height);
  const vc = vid.getContext('2d');
  vc.drawImage(decodedSource, 0, 0, box.width, box.height);
  vc.globalCompositeOperation = 'destination-in';
  drawVideoDecoration(vc, 'mask', metrics, box.width, box.height);
  lc.drawImage(vid, metrics.pad, metrics.pad);
  drawVideoDecoration(lc, 'over', metrics, box.width, box.height);
}
const ref = createCanvas(W, H);
const rc = ref.getContext('2d');
function expected(t) {
  rc.setTransform(1, 0, 0, 1, 0, 0);
  rc.globalAlpha = 1;
  rc.fillStyle = '#FFFFFF';
  rc.fillRect(0, 0, W, H);
  const v = resolveVideoTransformAtTime(videoTransform, t);
  rc.save();
  rc.translate(W / 2 + (v.offsetXPct / 100) * W, H / 2 + (v.offsetYPct / 100) * H);
  rc.rotate((v.rotation * Math.PI) / 180);
  rc.scale(v.scale, v.scale);
  rc.drawImage(layer, -LW / 2, -LH / 2);
  rc.restore();
  drawShapeLayer(rc, shape, { canvasWidth: W, canvasHeight: H, time: t, createOffscreenCanvas: (w, h) => createCanvas(w, h) });
  const d = rc.getImageData(0, 0, W, H).data;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}
/** Debug aid: COMPOSITION_DUMP=<dir> writes each compared pair as PNGs. */
function dumpPair(dir, k, ...frames) {
  frames.forEach((rgb, n) => {
    const c = createCanvas(W, H);
    const cx = c.getContext('2d');
    const img = cx.createImageData(W, H);
    for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) { img.data[i] = rgb[j]; img.data[i + 1] = rgb[j + 1]; img.data[i + 2] = rgb[j + 2]; img.data[i + 3] = 255; }
    cx.putImageData(img, 0, 0);
    fs.writeFileSync(path.join(dir, `${n ? 'reference' : 'export'}-${k}.png`), c.toBuffer('image/png'));
  });
}
/**
 * Mean |Δ| at quarter resolution. The exporter places and sizes the scaled
 * layer on whole pixels (ffmpeg's scale/overlay are integer), the reference
 * on exact ones, so every hard edge can sit a pixel apart — noise at full
 * resolution, invisible at 4x4 blocks. A wrong position, size, angle or
 * colour is still many blocks wrong.
 */
const BLOCK = 4;
function blocks(rgb) {
  const bw = W / BLOCK;
  const bh = H / BLOCK;
  const out = new Float64Array(bw * bh * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const o = ((Math.floor(y / BLOCK) * bw) + Math.floor(x / BLOCK)) * 3;
    out[o] += rgb[i] / (BLOCK * BLOCK); out[o + 1] += rgb[i + 1] / (BLOCK * BLOCK); out[o + 2] += rgb[i + 2] / (BLOCK * BLOCK);
  }
  return out;
}
const meanDiff = (x, y) => { const a = blocks(x); const b = blocks(y); let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
let worst = 0;
for (const k of [0, 10, 15, 25, 35, 45, 60, 75, 89]) {
  const ex = await exported(k);
  const re = expected(k / FPS);
  if (process.env.COMPOSITION_DUMP) dumpPair(process.env.COMPOSITION_DUMP, k, ex, re);
  const d = meanDiff(ex, re);
  worst = Math.max(worst, d);
  assert.ok(d < 6, `frame ${k} (${(k / FPS).toFixed(2)}s): the file matches the composition maths (mean |Δ| ${d.toFixed(2)})`);
}
console.log(`  9 frames compared, worst mean difference ${worst.toFixed(2)} (of 255, 4x4 blocks)`);

// The video's measured extent — leftmost/rightmost video pixel along a row,
// topmost down a column — within 2px of the maths, upright and turned.
const isVideo = (rgb, x, y) => { const i = (y * W + x) * 3; const sum = rgb[i] + rgb[i + 1] + rgb[i + 2]; return sum < 500 && !(rgb[i] < 80 && rgb[i + 1] > 180 && rgb[i + 2] > 200); };
const extent = (rgb) => {
  let L = -1; let R = -1; let T = -1;
  for (let x = 0; x < W; x++) if (isVideo(rgb, x, 100)) { if (L < 0) L = x; R = x; }
  for (let y = 0; y < H * 0.75; y++) if (isVideo(rgb, 180, y)) { T = y; break; }
  return [L, R, T];
};
for (const k of [0, 75]) {
  const e = extent(await exported(k));
  const r = extent(expected(k / FPS));
  e.forEach((v, i) => assert.ok(Math.abs(v - r[i]) <= 2, `frame ${k}: video edge ${["left", "right", "top"][i]} at ${v}, the maths says ${r[i]}`));
}

// In the pixels: the background where the video isn't, the border colour on
// its edge, the shape on top, the shadow darker below than above.
const f = await exported(10);
const px = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [f[i], f[i + 1], f[i + 2]]; };
assert.ok(px(4, 4).every((c) => c > 240), `the corner is background white (${px(4, 4)})`);
assert.ok(px(W * 0.8, H * 0.85)[2] > 200 && px(W * 0.8, H * 0.85)[0] < 80, 'the shape sits on top');
console.log('✓ Canvas size, background, placement, rotation over time, corners, border, shadow, and the layers on top all reach the file');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] Every ratio exports: the right size, the right length, the video whole and centred');
for (const aspectRatio of Object.keys(ASPECT_RATIOS).filter((k) => k !== 'original')) {
  const dir = path.join(work, `ratio-${aspectRatio.replace(/[:.]/g, 'x')}`);
  fs.mkdirSync(dir, { recursive: true });
  const c = prepareVideoComposition({ composition: { aspectRatio, background: { color: '#FFFFFF' } }, videoStyle: { cornerRadius: 8 }, sourceWidth: SW, sourceHeight: SH, outDir: path.join(dir, 'c') });
  const segs = buildFullTimelineSegments([], { shapeLayers: [shape] }, c.width, c.height, DURATION, dir, { frameRate: String(FPS) });
  const file = path.join(dir, 'out.mp4');
  await compositeGraphicsCaptionTrack(src, segs.captions, file, {
    duration: DURATION, canvasWidth: c.width, canvasHeight: c.height, frameRate: String(FPS), composition: c, layerRuns: segs.runs
  });
  const info = await new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file]);
    let s = '';
    proc.stderr.on('data', (d) => { s += d.toString(); });
    proc.on('close', () => resolve(s));
  });
  assert.match(info, new RegExp(`${c.width}x${c.height}`), `${aspectRatio}: the file is ${c.width}x${c.height}`);
  const [h2, m2, s2] = info.match(/Duration: (\d+):(\d+):([\d.]+)/).slice(1).map(Number);
  assert.ok(Math.abs(h2 * 3600 + m2 * 60 + s2 - DURATION) < 0.1, `${aspectRatio}: as long as the source`);
  // The centre pixel is the video's (not the white background); the
  // canvas's left-middle edge is background unless the video fills the width.
  const raw = path.join(dir, 'mid.rgb');
  await run(['-y', '-ss', '1', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const f = fs.readFileSync(raw);
  const at = (x, y) => { const i = (Math.round(y) * c.width + Math.round(x)) * 3; return [f[i], f[i + 1], f[i + 2]]; };
  // Inside the source's purple quadrant (clear of the white grid lines).
  const inside = at(c.width / 2 + c.boxWidth * 0.2, c.height / 2 + c.boxHeight * 0.2);
  assert.ok(inside[2] > 150 && inside[1] < 120, `${aspectRatio}: the video, centred (${inside})`);
  const fillsWidth = c.boxWidth >= c.width - 2;
  if (!fillsWidth) assert.ok(at(2, c.height / 2).every((v) => v > 230), `${aspectRatio}: background beside the video (${at(2, c.height / 2)})`);
  console.log(`  ${aspectRatio.padEnd(7)} ${c.width}x${c.height}, video ${c.boxWidth}x${c.boxHeight}`);
}
console.log('✓ Every ratio renders at its own size, for the whole clip');

console.log('\n--- All composition checks passed ---');
