/**
 * IMAGE LAYERS (shared/imageLayer.js) — the model, and a REAL 30 fps ffmpeg
 * render checked frame by frame against the shared drawing function at that
 * frame's own instant (the call the preview makes):
 *
 *   - timing: not drawn before its start or from its end, drawn between;
 *   - layout: position, size (aspect kept), scale, rotation, opacity;
 *   - appearance: crop, rounded corners, an inside border, a shadow;
 *   - stacking: under the captions vs above all text;
 *   - motion: the shared entrance presets, from the image's own start;
 *   - preview/export: every compared frame matches the shared draw.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  normalizeImageLayer, normalizeImageLayerList, createImageLayer, isImageLayerActive,
  resolveImageGeometry, drawImageLayer, textLayerStack, imageLayerMotionSpans
} from '../shared/imageLayer.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { getASSStyleFromConfig } from '../shared/captionConfig.js';

console.log('--- Image Layers ---');

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: complete, safe, serializable; sources, timing, layout, appearance and motion apart');
{
  assert.strictEqual(normalizeImageLayer({ start: 1 }), null, 'no source, no layer');
  const l = normalizeImageLayer({ assetId: 'a.png', start: 2, end: 1, crop: { left: 0.7, right: 0.7 }, motions: [{ preset: 'pop' }, { preset: 'none' }] });
  assert.ok(l.end > l.start, 'an inverted window is repaired');
  assert.ok(l.crop.left + l.crop.right <= 0.9 + 1e-9, 'at least 10% of the picture always survives a crop');
  assert.deepStrictEqual(l.motions.map((m) => [m.kind, m.preset]), [['entrance', 'pop']], 'motions are a motion list');
  assert.strictEqual(l.layer, 'under-captions', 'default placement');
  assert.deepStrictEqual(normalizeImageLayer(JSON.parse(JSON.stringify(l))), l, 'JSON round trip unchanged');
  assert.deepStrictEqual(normalizeImageLayerList(JSON.stringify([l])), [l], 'from its JSON string form too');
  // A new layer keeps the picture's aspect ratio and fits the frame.
  const wide = createImageLayer({ assetId: 'w.png', naturalWidth: 400, naturalHeight: 300, frameAspect: 9 / 16 });
  const tall = createImageLayer({ assetId: 't.png', naturalWidth: 300, naturalHeight: 900, frameAspect: 9 / 16 });
  assert.strictEqual(wide.transform.width, 60);
  const gt = resolveImageGeometry(tall, 360, 640);
  assert.ok(gt.height <= 640 * 0.6 + 0.5, `a tall picture is no taller than 60% of the frame (${gt.height.toFixed(1)}px)`);
  assert.ok(Math.abs(gt.width / gt.height - 300 / 900) < 1e-9, 'never stretched');
  const gw = resolveImageGeometry(wide, 360, 640);
  assert.ok(Math.abs(gw.width / gw.height - 4 / 3) < 1e-9);
  assert.notStrictEqual(wide.id, tall.id);
  // Timing: half-open.
  const span = normalizeImageLayer({ assetId: 's.png', start: 1, end: 2 });
  assert.deepStrictEqual([0.99, 1, 1.5, 1.999, 2].map((t) => isImageLayerActive(span, t)), [false, true, true, true, false]);
  // Stacking order of the text layer.
  const order = textLayerStack(
    [{ id: 'c', kind: 'caption' }, { id: 'i', kind: 'interlude' }, { id: 'o', kind: 'overlay' }],
    [{ id: 'A', layer: 'over-text' }, { id: 'B', layer: 'under-text' }, { id: 'U', layer: 'under-captions' }]
  ).map((e) => e.item.id);
  assert.deepStrictEqual(order, ['c', 'B', 'i', 'o', 'A'], 'captions → images above captions → card → overlays → images above all text');
}
console.log('✓ Normalized, sized without stretching, half-open timing, one stacking order');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] A real 30 fps render, frame by frame against the shared draw');
const W = 360;
const H = 640;
const DURATION = 3;
const FPS = 30;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-images-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
});

// A flat grey video, so every pixel of the expected frame is known.
const src = path.join(work, 'src.mp4');
await run(['-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:d=${DURATION}:r=${FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);

// The picture: four solid quadrants, so position, crop and rotation all show.
const pic = createCanvas(400, 300);
const pc = pic.getContext('2d');
pc.fillStyle = '#E11D48'; pc.fillRect(0, 0, 400, 300);
pc.fillStyle = '#2563EB'; pc.fillRect(0, 0, 200, 150);
pc.fillStyle = '#16A34A'; pc.fillRect(200, 150, 200, 150);
const picFile = path.join(work, 'pic.png');
fs.writeFileSync(picFile, pic.toBuffer('image/png'));
const picture = await loadImage(picFile);
const sources = new Map([['pic.png', picture]]);

const layers = [
  // Rotated, rounded, bordered, shadowed, sliding up — from 0.5s.
  normalizeImageLayer({
    id: 'img_a', assetId: 'pic.png', naturalWidth: 400, naturalHeight: 300, start: 0.5, end: 2.0, layer: 'over-text',
    transform: { x: 40, y: 35, width: 50, scale: 1, rotation: 12, opacity: 100 },
    appearance: { cornerRadius: 20, border: { enabled: true, width: 6, color: '#FFFF00' }, shadow: { enabled: true, blur: 10, offsetX: 6, offsetY: 8, color: '#000000', opacity: 70 } },
    motions: [{ preset: 'slide-up', duration: 0.4, easing: 'ease-out' }]
  }),
  // Cropped to its blue quadrant, scaled, half opaque, under the captions — from 1.0s.
  normalizeImageLayer({
    id: 'img_b', assetId: 'pic.png', naturalWidth: 400, naturalHeight: 300, start: 1.0, end: 2.6, layer: 'under-captions',
    transform: { x: 65, y: 70, width: 30, scale: 1.5, rotation: 0, opacity: 60 },
    crop: { left: 0, top: 0, right: 0.5, bottom: 0.5 },
    motions: [{ preset: 'pop', duration: 0.3, easing: 'linear' }]
  })
];
const params = { preset: 'caps-white', fontFamily: 'Poppins', fontSize: '20', position: 'bottom', captionMode: 'sentence', animationMode: 'karaoke', imageLayers: layers };

const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const built = buildFullTimelineSegments([], params, W, H, DURATION, framesDir, { frameRate: '30', imageSources: sources });
assert.ok(built.imagesUnder.length > 0 && built.text.length > 0, 'one layer under the captions, one with the text');
// Every motion sample sits on the frame grid.
const offGrid = [...built.text, ...built.imagesUnder]
  .filter((s) => imageLayerMotionSpans(layers[0]).concat(imageLayerMotionSpans(layers[1])).some((sp) => s.start > sp.start && s.start < sp.end))
  .filter((s) => Math.abs(s.start * FPS - Math.round(s.start * FPS)) > 1e-6);
assert.deepStrictEqual(offGrid, [], 'motion is sampled on the output frame grid');

const out = path.join(work, 'out.mp4');
await compositeGraphicsCaptionTrack(src, built.captions, out, {
  duration: DURATION, canvasWidth: W, canvasHeight: H, frameRate: '30',
  textBlendMode: getASSStyleFromConfig(params).textBlendMode,
  imageUnderSegments: built.imagesUnder, manualCaptionSegments: built.manualCaptions, textElementSegments: built.text
});

async function exported(k) {
  const raw = path.join(work, `f${k}.rgb`);
  await run(['-y', '-ss', String(Math.max(0, k / FPS - 0.004)), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  return fs.readFileSync(raw);
}
const ref = createCanvas(W, H);
const rc = ref.getContext('2d');
function expected(t) {
  rc.globalAlpha = 1;
  rc.fillStyle = '#808080';
  rc.fillRect(0, 0, W, H);
  // Under the captions first, then the text layer's order.
  layers.filter((l) => l.layer === 'under-captions' && isImageLayerActive(l, t)).forEach((l) => drawImageLayer(rc, l, picture, { canvasWidth: W, canvasHeight: H, time: t, createOffscreenCanvas: (w, h) => createCanvas(w, h) }));
  textLayerStack([], layers.filter((l) => l.layer !== 'under-captions' && isImageLayerActive(l, t))).forEach(({ item }) => drawImageLayer(rc, item, picture, { canvasWidth: W, canvasHeight: H, time: t, createOffscreenCanvas: (w, h) => createCanvas(w, h) }));
  const d = rc.getImageData(0, 0, W, H).data;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}
const px = (buf, x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const near = (c, target, tol = 40) => c.every((v, i) => Math.abs(v - target[i]) <= tol);

// Preview/export parity on every frame across both entrances and every edge.
let worst = 0;
const checked = [];
for (let k = 0; k <= DURATION * FPS - 1; k += 1) {
  const t = k / FPS;
  const interesting = (t >= 0.4 && t <= 1.0) || (t >= 0.95 && t <= 1.4) || (t >= 1.9 && t <= 2.1) || (t >= 2.5 && t <= 2.7) || k % 15 === 0;
  if (!interesting) continue;
  const d = meanDiff(await exported(k), expected(t));
  worst = Math.max(worst, d);
  checked.push(k);
  assert.ok(d < 2.5, `frame ${k} (${t.toFixed(3)}s): the file matches the shared draw (mean |Δ| ${d.toFixed(2)})`);
}
console.log(`  ${checked.length} frames compared, worst mean difference ${worst.toFixed(2)} (of 255)`);

// Timing — before, during, after.
const grey = [128, 128, 128];
const ga = resolveImageGeometry(layers[0], W, H);
assert.ok(near(px(await exported(10), ga.centerX, ga.centerY), grey, 12), 'before its start (0.33s): not drawn');
assert.ok(!near(px(await exported(45), ga.centerX, ga.centerY), grey, 12), 'during (1.5s): drawn');
assert.ok(near(px(await exported(63), ga.centerX, ga.centerY), grey, 12), 'from its end (2.1s): gone');
// The entrance starts from the image's OWN start: invisible at its first frame, moving after.
const atStart = await exported(15);
assert.ok(near(px(atStart, ga.centerX, ga.centerY), grey, 12), 'slide up: invisible at the image\'s own first frame (0.5s)');
// At rest (1.5s): border colour just inside the rotated edge, rounded corner shows the background.
const rest = await exported(45);
const rad = (12 * Math.PI) / 180;
const local = (lx, ly) => [ga.centerX + lx * Math.cos(rad) - ly * Math.sin(rad), ga.centerY + lx * Math.sin(rad) + ly * Math.cos(rad)];
const insideTopEdge = local(0, -ga.height / 2 + 3);
assert.ok(near(px(rest, ...insideTopEdge), [255, 255, 0], 60), `an inside border in its colour (${px(rest, ...insideTopEdge)})`);
const corner = local(-ga.width / 2 + 2, -ga.height / 2 + 2);
assert.ok(!near(px(rest, ...corner), [255, 255, 0], 60) && !near(px(rest, ...corner), [225, 29, 72], 60), 'a rounded corner: the very corner is not the picture');
// Just below the middle of the bottom edge — where a shadow offset down-right falls.
const shadowSpot = local(0, ga.height / 2 + 5);
assert.ok(px(rest, ...shadowSpot)[0] < 100, `a shadow beyond the bottom-right edge (${px(rest, ...shadowSpot)})`);
// Crop + scale: image B shows only the blue quadrant, at 30% × 1.5 of the frame, half opaque over grey.
const gb = resolveImageGeometry(layers[1], W, H);
assert.ok(Math.abs(gb.width / gb.height - 4 / 3) < 1e-9, 'the cropped quadrant keeps its own aspect ratio');
const bCentre = px(await exported(54), gb.centerX, gb.centerY);
assert.ok(bCentre[2] > bCentre[0] + 30, `cropped to blue, blended at 60% (${bCentre})`);
console.log('✓ Timing, the entrance from its own start, border, rounded corners, shadow, crop + scale, opacity');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] Stacking against the captions: under them, or above all text');
{
  const phrases = [{ start: 0, end: DURATION, breakAfterIndices: [], words: [{ word: 'CAPTION', start: 0, end: DURATION, wordIndex: 0 }] }];
  const full = (layer) => normalizeImageLayer({ id: `img_${layer}`, assetId: 'pic.png', naturalWidth: 400, naturalHeight: 300, start: 0, end: DURATION, layer, transform: { x: 50, y: 85, width: 100, scale: 1, rotation: 0, opacity: 100 } });
  const capParams = (layer) => ({ preset: 'caps-white', fontFamily: 'Poppins', fontSize: '24', position: 'bottom', captionMode: 'sentence', animationMode: 'karaoke', inactiveWordColor: '#FFFFFF', activeWordColor: '#FFFFFF', outlineSize: 0, shadowMode: 'none', imageLayers: [full(layer)] });
  const whiteCount = async (layer) => {
    const dir = path.join(work, `stack-${layer}`);
    fs.mkdirSync(dir, { recursive: true });
    const p = capParams(layer);
    const b = buildFullTimelineSegments(phrases, p, W, H, DURATION, dir, { frameRate: '30', imageSources: sources });
    const o = path.join(work, `stack-${layer}.mp4`);
    await compositeGraphicsCaptionTrack(src, b.captions, o, { duration: DURATION, canvasWidth: W, canvasHeight: H, frameRate: '30', textBlendMode: getASSStyleFromConfig(p).textBlendMode, imageUnderSegments: b.imagesUnder, manualCaptionSegments: b.manualCaptions, textElementSegments: b.text });
    const raw = path.join(work, `stack-${layer}.rgb`);
    await run(['-y', '-ss', '1.5', '-i', o, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
    const buf = fs.readFileSync(raw);
    let n = 0;
    for (let i = 0; i < buf.length; i += 3) if (buf[i] > 235 && buf[i + 1] > 235 && buf[i + 2] > 235) n++;
    return n;
  };
  const under = await whiteCount('under-captions');
  const over = await whiteCount('over-text');
  console.log(`  white caption pixels — image under the captions: ${under}, image above all text: ${over}`);
  assert.ok(under > 200, 'under the captions: the caption is drawn over the picture');
  assert.ok(over < 20, 'above all text: the picture covers the caption');
}
console.log('✓ Under the captions, the caption shows; above all text, the picture covers it');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All image layer checks passed ---');
