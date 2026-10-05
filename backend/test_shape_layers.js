/**
 * SHAPE LAYERS (shared/shapeLayer.js) and THE LAYER STACK
 * (shared/visualLayers.js) — the model and rules, and a REAL 30 fps ffmpeg
 * render of a restacked composition checked frame by frame against the
 * shared drawing functions composited in stack order (what the preview does):
 *
 *   - the V1.3 order is reproduced when nothing has been restacked;
 *   - restacking works across types; runs cut where compositing changes;
 *   - every shape kind draws; fill, border, corners, shadow, rotation, opacity;
 *   - shape motion comes from the shared engine, over the shape's own span;
 *   - a shape under the captions is covered by them; above, it covers them.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { normalizeShapeLayer, normalizeShapeLayerList, createShapeLayer, SHAPE_KINDS, resolveShapeGeometry, drawShapeLayer, isShapeLayerActive } from '../shared/shapeLayer.js';
import { normalizeImageLayer, drawImageLayer, isImageLayerActive } from '../shared/imageLayer.js';
import { resolveLayerStack, defaultLayerOrder, moveInLayerOrder, layerOrderOf, layerRuns, CAPTIONS_LAYER_ID } from '../shared/visualLayers.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { getASSStyleFromConfig, getCSSPreviewFromConfig } from '../shared/captionConfig.js';
import { drawCaptionFrameForExport } from '../shared/captionGraphics.js';

console.log('--- Shape Layers & the Layer Stack ---');

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The stack: V1.3 order by default, restacking across types, runs');
{
  const text = [
    { id: 'cap1', kind: 'caption', start: 0, end: 1 },
    { id: 'ov1', kind: 'overlay', start: 0, end: 1 },
    { id: 'card2', kind: 'interlude', start: 2, end: 3 },
    { id: 'card1', kind: 'interlude', start: 1, end: 3 }
  ];
  const images = [{ id: 'iU', layer: 'under-captions' }, { id: 'iT', layer: 'under-text' }, { id: 'iO', layer: 'over-text' }, { id: 'iLegacy' }];
  const shapes = [{ id: 's1', kind: 'rectangle' }];
  const ids = layerOrderOf(defaultLayerOrder({ textElements: text, imageLayers: images, shapeLayers: shapes }));
  assert.deepStrictEqual(ids, ['iU', 'iLegacy', CAPTIONS_LAYER_ID, 'cap1', 'iT', 'card1', 'card2', 'ov1', 'iO', 's1'],
    'V1.3: under-captions images, captions, manual captions, under-text images, cards (latest on top), overlays, over-text images; then shapes');
  // A stored order wins; unknown ids go on top; vanished ids are ignored.
  const stored = resolveLayerStack({ layerOrder: ['s1', 'gone', 'iO', CAPTIONS_LAYER_ID], textElements: [], imageLayers: [{ id: 'iO' }, { id: 'iNew' }], shapeLayers: shapes });
  assert.deepStrictEqual(layerOrderOf(stored), ['s1', 'iO', CAPTIONS_LAYER_ID, 'iNew']);
  // Restacking, across types.
  const stack = resolveLayerStack({ textElements: text, imageLayers: images, shapeLayers: shapes });
  assert.deepStrictEqual(moveInLayerOrder(stack, 's1', 'back').slice(0, 2), ['s1', 'iU'], 'a shape to the very back (still above the video)');
  assert.deepStrictEqual(moveInLayerOrder(stack, 'iU', 'forward').slice(0, 3), ['iLegacy', 'iU', CAPTIONS_LAYER_ID]);
  assert.strictEqual(moveInLayerOrder(stack, 's1', 'front'), null, 'already at the front: nothing moves');
  const capAbove = moveInLayerOrder(stack, CAPTIONS_LAYER_ID, 'front');
  assert.strictEqual(capAbove.at(-1), CAPTIONS_LAYER_ID, 'the captions can go above everything');
  // Runs: cut where compositing changes; manual captions blend like captions.
  const runs = layerRuns(stack).map((r) => [r.kind, r.beneathCaptions, r.entries.map((e) => e.id).join(',')]);
  assert.deepStrictEqual(runs, [
    ['plain', true, 'iU,iLegacy'],
    ['captions', false, CAPTIONS_LAYER_ID],
    ['caption-blend', false, 'cap1'],
    ['plain', false, 'iT,card1,card2,ov1,iO,s1']
  ]);
}
console.log('✓ Default = V1.3, stored order reconciled, any entry restacks, runs split by compositing');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Shapes: the model, every kind, geometry');
{
  assert.strictEqual(normalizeShapeLayer({ kind: 'blob' }), null, 'only the known kinds');
  for (const kind of SHAPE_KINDS) {
    const s = createShapeLayer({ kind, start: 1 });
    assert.strictEqual(s.kind, kind);
    assert.deepStrictEqual(normalizeShapeLayer(JSON.parse(JSON.stringify(s))), s, `${kind}: JSON round trip unchanged`);
  }
  const sq = normalizeShapeLayer({ kind: 'rectangle', transform: { width: 40, height: 40 } });
  const g = resolveShapeGeometry(sq, 360, 640);
  assert.strictEqual(g.width, g.height, 'width and height are both % of the frame width, so a square stays square');
  assert.deepStrictEqual(normalizeShapeLayerList(JSON.stringify([sq])), [sq]);
  const a = createShapeLayer({ kind: 'pill' });
  const b = createShapeLayer({ kind: 'pill' });
  assert.notStrictEqual(a.id, b.id);
  assert.deepStrictEqual([0.99, 1, 2.9, 3].map((t) => isShapeLayerActive(normalizeShapeLayer({ kind: 'line', start: 1, end: 3 }), t)), [false, true, true, false], 'half-open timing');
}
console.log('✓ Six kinds, safe defaults, JSON-safe, square stays square, half-open timing');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] A restacked composition, rendered for real, frame by frame against the shared draw');
const W = 360;
const H = 640;
const DURATION = 3;
const FPS = 30;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shapes-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
});
const src = path.join(work, 'src.mp4');
await run(['-y', '-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}:d=${DURATION}:r=${FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);

const pic = createCanvas(400, 300);
const pc = pic.getContext('2d');
pc.fillStyle = '#2563EB'; pc.fillRect(0, 0, 400, 300);
const picFile = path.join(work, 'pic.png');
fs.writeFileSync(picFile, pic.toBuffer('image/png'));
const picture = await loadImage(picFile);
const sources = new Map([['pic.png', picture]]);

// Every kind, each styled differently; a rounded rect under the captions.
const shapes = [
  normalizeShapeLayer({ id: 's_band', kind: 'rounded', start: 0.2, end: 2.8, transform: { x: 50, y: 85, width: 95, height: 22, rotation: 0, opacity: 100 }, appearance: { fill: { color: '#E11D48' }, cornerRadius: 30 } }),
  normalizeShapeLayer({ id: 's_circle', kind: 'ellipse', start: 0.5, end: 2.5, transform: { x: 35, y: 30, width: 30, height: 30 }, appearance: { fill: { color: '#16A34A' }, border: { enabled: true, width: 5, color: '#FFFF00' } }, motions: [{ preset: 'pop', duration: 0.3, easing: 'ease-out' }] }),
  normalizeShapeLayer({ id: 's_rect', kind: 'rectangle', start: 0.5, end: 2.5, transform: { x: 70, y: 40, width: 25, height: 15, rotation: 20, opacity: 70 }, appearance: { fill: { color: '#F59E0B' }, shadow: { enabled: true, blur: 8, offsetX: 4, offsetY: 6, opacity: 70 } }, motions: [{ preset: 'slide-up', duration: 0.4, easing: 'ease-out' }] }),
  normalizeShapeLayer({ id: 's_line', kind: 'line', start: 0.5, end: 2.5, transform: { x: 50, y: 55, width: 70, height: 2, rotation: -10 }, appearance: { fill: { color: '#FFFFFF' } } }),
  normalizeShapeLayer({ id: 's_arrow', kind: 'arrow', start: 0.5, end: 2.5, transform: { x: 45, y: 65, width: 40, height: 10 }, appearance: { fill: { color: '#22D3EE' } }, motions: [{ preset: 'slide-left', duration: 0.3 }] }),
  normalizeShapeLayer({ id: 's_pill', kind: 'pill', start: 0.5, end: 2.5, transform: { x: 60, y: 15, width: 50, height: 10 }, appearance: { fill: { color: '#A855F7' } } })
];
const image = normalizeImageLayer({ id: 'img_x', assetId: 'pic.png', naturalWidth: 400, naturalHeight: 300, start: 0.4, end: 2.6, transform: { x: 50, y: 30, width: 40, scale: 1, rotation: 0, opacity: 100 } });
const phrases = [{ start: 0, end: DURATION, breakAfterIndices: [], words: [{ word: 'CAPTION', start: 0, end: DURATION, wordIndex: 0 }] }];
// The band UNDER the captions; the picture ABOVE them; the circle over the picture.
const layerOrder = ['s_band', CAPTIONS_LAYER_ID, 'img_x', 's_circle', 's_rect', 's_line', 's_arrow', 's_pill'];
const params = { preset: 'caps-white', fontFamily: 'Poppins', fontSize: '24', position: 'bottom', captionMode: 'sentence', animationMode: 'karaoke', inactiveWordColor: '#FFFFFF', activeWordColor: '#FFFFFF', outlineSize: 0, shadowMode: 'none', imageLayers: [image], shapeLayers: shapes, layerOrder };

const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const built = buildFullTimelineSegments(phrases, params, W, H, DURATION, framesDir, { frameRate: '30', imageSources: sources });
assert.deepStrictEqual(built.runs.map((r) => [r.kind, r.beneathCaptions]), [['plain', true], ['plain', false]], 'one stream beneath the captions, one above');
const out = path.join(work, 'out.mp4');
await compositeGraphicsCaptionTrack(src, built.captions, out, {
  duration: DURATION, canvasWidth: W, canvasHeight: H, frameRate: '30',
  textBlendMode: getASSStyleFromConfig(params).textBlendMode, layerRuns: built.runs
});

async function exported(k) {
  const raw = path.join(work, `f${k}.rgb`);
  await run(['-y', '-ss', String(Math.max(0, k / FPS - 0.004)), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  return fs.readFileSync(raw);
}
const ref = createCanvas(W, H);
const rc = ref.getContext('2d');
const off = (w, h) => createCanvas(w, h);
const cssConfig = getCSSPreviewFromConfig(params);
/** The shared draws, composited in stack order — what the preview's canvases add up to. */
function expected(t) {
  rc.globalAlpha = 1;
  rc.fillStyle = '#606060';
  rc.fillRect(0, 0, W, H);
  const stack = resolveLayerStack({ layerOrder, textElements: [], imageLayers: [image], shapeLayers: shapes });
  stack.forEach(({ type, item }) => {
    if (type === 'captions') {
      const layer = createCanvas(W, H);
      drawCaptionFrameForExport(layer.getContext('2d'), { canvasWidth: W, canvasHeight: H, activePhrase: phrases[0], currentTime: t, cssConfig, params, createOffscreenCanvas: off });
      rc.drawImage(layer, 0, 0);
    } else if (type === 'shape' && isShapeLayerActive(item, t)) {
      drawShapeLayer(rc, item, { canvasWidth: W, canvasHeight: H, time: t, createOffscreenCanvas: off });
    } else if (type === 'image' && isImageLayerActive(item, t)) {
      drawImageLayer(rc, item, picture, { canvasWidth: W, canvasHeight: H, time: t, createOffscreenCanvas: off });
    }
  });
  const d = rc.getImageData(0, 0, W, H).data;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}
const meanDiff = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
let worst = 0;
let compared = 0;
for (let k = 0; k < DURATION * FPS; k++) {
  const t = k / FPS;
  if (!((t >= 0.15 && t <= 1.0) || (t >= 2.4 && t <= 2.9) || k % 10 === 0)) continue;
  const d = meanDiff(await exported(k), expected(t));
  worst = Math.max(worst, d);
  compared++;
  assert.ok(d < 2.5, `frame ${k} (${t.toFixed(3)}s): the file matches the shared draw in stack order (mean |Δ| ${d.toFixed(2)})`);
}
console.log(`  ${compared} frames compared, worst mean difference ${worst.toFixed(2)} (of 255)`);

// The stack in the pixels: the caption's white text lies over the red band
// beneath it; the green circle covers the blue picture beneath it.
const rest = await exported(45);
const px = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 3; return [rest[i], rest[i + 1], rest[i + 2]]; };
let whiteOnBand = 0;
for (let y = Math.round(H * 0.85 - 30); y < Math.round(H * 0.85 + 30); y++) for (let x = 0; x < W; x++) { const c = px(x, y); if (c[0] > 235 && c[1] > 235 && c[2] > 235) whiteOnBand++; }
assert.ok(whiteOnBand > 150, `captions drawn over the band beneath them (${whiteOnBand} white px)`);
const gc = resolveShapeGeometry(shapes[1], W, H);
const centre = px(gc.centerX, gc.centerY);
assert.ok(centre[1] > 120 && centre[2] < 110, `the circle is over the picture (${centre})`);
console.log('✓ Captions over the shape beneath them; the shape over the picture beneath it');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All shape layer and layer stack checks passed ---');
