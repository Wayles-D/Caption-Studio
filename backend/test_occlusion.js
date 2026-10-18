/**
 * DYNAMIC OCCLUSION (shared/objects/occlusion.js) — a text, image or shape
 * layer passing BEHIND a tracked subject:
 *
 *   - the model: relationships serialize, bad ones are refused, 'in front'
 *     beats 'behind', a relationship is time-bounded, and the tracks needing
 *     masks are exactly the ones asked for;
 *   - the stack: a subject takes its place directly above the layers it
 *     hides; ONE PASS PER RELATIONSHIP, so two layers behind the same subject
 *     at different times never hide each other; with no usable subject the
 *     stack is returned untouched;
 *   - REAL EXPORTS against segment.mp4's ground truth (the exact visible
 *     pixels of a person are known): a word drawn across him is HIDDEN where
 *     he is and VISIBLE beside him; with the relationship off it covers him;
 *     outside its span it covers him; the person's own pixels are never
 *     damaged;
 *   - an image layer and a shape behind the same subject;
 *   - a layer explicitly in front stays in front;
 *   - no masks on this device: the layer simply shows, and the export is the
 *     one it would have been.
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
  createOcclusion, normalizeOcclusion, normalizeOcclusionList, occludedLayersAt, stackWithSubjects,
  isOcclusionActive, occlusionTrackKeys, occlusionBoundaryTimes, subjectEntryId, OCCLUSION_MODES
} from '../shared/objects/occlusion.js';
import { buildTrack, normalizeTrack } from '../shared/objects/tracking.js';
import { buildSegmentation, encodeRLE, maskFrame, DEFAULT_SEGMENTATION_CONFIG } from '../shared/objects/segmentation.js';
import { videoToComposition } from '../shared/objects/coordinates.js';
import { resolveLayerStack, layerRuns } from '../shared/visualLayers.js';
import { normalizeShapeLayer } from '../shared/shapeLayer.js';
import { normalizeTextElement } from '../shared/textElement.js';
import { normalizeImageLayer } from '../shared/imageLayer.js';
import { prepareVideoComposition } from './utils/videoDecoration.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { truth, visibleMask, W as FW, H as FH } from '../tests/fixtures/objects/make-crossing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'tests', 'fixtures', 'objects');
const SEGMENT = path.join(fixtures, 'segment.mp4');

console.log('--- Dynamic occlusion ---');

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: relationships, refusals, timing, front over behind');
{
  const r = createOcclusion({ trackKey: 't1', layerIds: ['lay1'], start: 1, end: 4 });
  assert.ok(r.id && r.mode === 'behind' && r.enabled && r.feather >= 0);
  assert.deepStrictEqual(r.layerIds, ['lay1']);
  assert.strictEqual(normalizeOcclusion({ layerIds: ['a'] }), null, 'no subject: not a relationship');
  assert.strictEqual(normalizeOcclusion({ trackKey: 't', layerIds: [] }), null, 'no layers: not a relationship');
  assert.strictEqual(normalizeOcclusion({ trackKey: 't', layerIds: ['a', 'a', 'a'] }).layerIds.length, 1, 'the same layer once');
  assert.strictEqual(normalizeOcclusion({ trackKey: 't', layerIds: ['a'], mode: 'sideways' }).mode, 'behind', 'an unknown mode falls back');
  OCCLUSION_MODES.forEach((m) => assert.strictEqual(normalizeOcclusion({ trackKey: 't', layerIds: ['a'], mode: m }).mode, m));
  assert.strictEqual(normalizeOcclusion({ trackKey: 't', layerIds: ['a'], feather: 999 }).feather, 20, 'the edge stays in range');
  // Round trip through JSON, as the export's transport does it.
  const back = normalizeOcclusionList(JSON.stringify([r]));
  assert.deepStrictEqual(back[0], r, 'serializes and comes back the same');
  assert.deepStrictEqual(normalizeOcclusionList('not json'), [], 'junk is not a list');
  assert.deepStrictEqual(normalizeOcclusionList([{ trackKey: '' }, r]).length, 1, 'junk is dropped, the rest kept');
  // Timed, half-open.
  assert.ok(!isOcclusionActive(r, 0.9) && isOcclusionActive(r, 1) && isOcclusionActive(r, 3.9) && !isOcclusionActive(r, 4));
  assert.ok(!isOcclusionActive({ ...r, enabled: false }, 2), 'switched off is never active');
  assert.deepStrictEqual(occlusionBoundaryTimes([r]), [1, 4]);
  // 'front' wins, and needs no mask of its own.
  const front = createOcclusion({ trackKey: 't1', layerIds: ['lay1'], mode: 'front', start: 1, end: 4 });
  assert.strictEqual(occludedLayersAt([r, front], 2).length, 0, 'in front beats behind');
  assert.deepStrictEqual(occlusionTrackKeys([r, front]), ['t1']);
  assert.deepStrictEqual(occlusionTrackKeys([front]), [], 'a front-only relationship needs no mask');
  console.log('  ✓ model, refusals, JSON round trip, timing, precedence');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 2] The stack: the subject takes its place; one pass per relationship');
{
  const stack = [
    { type: 'image', id: 'A' }, { type: 'text', id: 'B' },
    { type: 'captions', id: 'captions' }, { type: 'shape', id: 'C' }
  ];
  const ids = (s) => s.map((e) => e.id);
  const rA = createOcclusion({ trackKey: 't', layerIds: ['A'], start: 0, end: 4 });
  const rB = createOcclusion({ trackKey: 't', layerIds: ['B'], start: 6, end: 10 });

  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA], 1))),
    ['A', subjectEntryId(rA.id), 'B', 'captions', 'C'], 'directly above the layer it hides');
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA], 9))), ids(stack), 'outside its span: nothing inserted');
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA], 1, () => false))), ids(stack), 'no usable subject: the stack is untouched');

  // THE REASON FOR ONE PASS PER RELATIONSHIP: at 1s only A is behind him; at
  // 7s only B is. A single shared pass would have to sit above both and would
  // hide B from the start.
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA, rB], 1))),
    ['A', subjectEntryId(rA.id), 'B', 'captions', 'C'], '1s: above A only');
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA, rB], 7))),
    ['A', 'B', subjectEntryId(rB.id), 'captions', 'C'], '7s: above B only');
  // The export inserts them all (its runs are cut once); each draws only in
  // its own span, so the picture is the same.
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rA, rB], null))),
    ['A', subjectEntryId(rA.id), 'B', subjectEntryId(rB.id), 'captions', 'C'], 'the export: every pass, each in its place');

  // Several layers behind one subject: above the TOPMOST of them.
  const rAll = createOcclusion({ trackKey: 't', layerIds: ['A', 'captions'], start: 0, end: 4 });
  assert.deepStrictEqual(ids(stackWithSubjects(stack, occludedLayersAt([rAll], 1))),
    ['A', 'B', 'captions', subjectEntryId(rAll.id), 'C'], 'above the topmost layer it hides');

  // A subject is always its own compositing run, never merged into a neighbour.
  const runs = layerRuns(stackWithSubjects(stack, occludedLayersAt([rA], 1)));
  const kinds = runs.map((r) => r.kind);
  assert.ok(kinds.includes('subject'), 'its own run');
  assert.strictEqual(runs.find((r) => r.kind === 'subject').entries.length, 1, 'alone in it');
  // The real stack resolver still works with it.
  assert.ok(resolveLayerStack({ textElements: [], imageLayers: [], shapeLayers: [] }).length >= 1);
  console.log('  ✓ placement, timing, per-relationship passes, its own run');
}

// ---------------------------------------------------------------------------
// Ground truth for segment.mp4's OLIVE, as the subject-isolation tests build it.
function truthTrack(name, from, to) {
  const samples = [];
  for (let t = from; t <= to + 1e-9; t += 0.2) {
    samples.push({ time: +t.toFixed(3), box: truth(name, +t.toFixed(3), 'segment'), confidence: 0.95, state: 'tracked' });
  }
  return normalizeTrack({
    ...buildTrack({
      detection: { id: 'det-truth', class: 'person', label: 'Person', confidence: 0.95, box: samples[0].box, time: from },
      config: {}, samples, ends: { forward: { reason: 'video-end', time: to }, backward: { reason: 'video-start', time: from } }
    }),
    source: { videoKey: 'v', detectionCacheKey: 'd' }
  });
}

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

console.log('\n[Test 3] A real export: a shape across a person is hidden where he is');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-occ-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-3000)))));
});
const DURATION = 3;
const FPS = 15;
const TIMES = [0.4, 0.8, 1.2];
const BAR = { r: 255, g: 0, b: 255 };

const track = truthTrack('olive', 0, DURATION);
const keyframes = [];
const keyMasks = [];
let grid = null;
for (const t of TIMES) {
  const m = await truthMask('olive', t);
  grid = m.grid;
  keyframes.push({ time: t, confidence: 0.95, level: 'high', state: 'tracked' });
  keyMasks.push(encodeRLE(m.alpha));
}
const record = buildSegmentation({ track, trackKey: 'kolive', config: { ...DEFAULT_SEGMENTATION_CONFIG, step: 0.4 }, grid, keyframes });
const segPayload = { kolive: { record, masks: keyMasks.map((p) => Buffer.from(p).toString('base64')).join(' ') } };

// A bright bar across the middle of the frame, wide enough to cross him.
const BAR_ID = 'shape-bar';
const shapeLayers = [normalizeShapeLayer({
  id: BAR_ID, kind: 'rectangle', start: 0, end: DURATION, enabled: true,
  transform: { x: 50, y: 42, width: 100, height: 16, scale: 1, rotation: 0, opacity: 100 },
  appearance: { fill: { enabled: true, color: '#FF00FF' } }
})];

async function render(name, occlusions, { segmentations = segPayload } = {}) {
  const framesDir = path.join(work, name);
  fs.mkdirSync(framesDir, { recursive: true });
  const comp = prepareVideoComposition({ composition: null, videoStyle: null, sourceWidth: FW, sourceHeight: FH, outDir: path.join(framesDir, 'composition') });
  const params = {
    preset: 'caps-white', captionMode: 'sentence',
    shapeLayers: JSON.stringify(shapeLayers),
    occlusions: JSON.stringify(occlusions),
    occlusionTracks: JSON.stringify({ kolive: track }),
    occlusionSegmentations: JSON.stringify(segmentations)
  };
  const built = buildFullTimelineSegments([], params, comp.width, comp.height, DURATION, framesDir, { frameRate: String(FPS), videoBox: { boxWidth: comp.boxWidth, boxHeight: comp.boxHeight } });
  const out = path.join(work, `${name}.mp4`);
  await compositeGraphicsCaptionTrack(SEGMENT, built.captions, out, {
    duration: DURATION, canvasWidth: comp.width, canvasHeight: comp.height, frameRate: String(FPS),
    composition: comp, layerRuns: built.runs
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

const near = (a, b, tol = 48) => Math.abs(a - b) <= tol;
const isBar = (buf, i) => near(buf[i], BAR.r) && near(buf[i + 1], BAR.g) && near(buf[i + 2], BAR.b);

{
  const behind = createOcclusion({ trackKey: 'kolive', layerIds: [BAR_ID], start: 0, end: DURATION });
  const t0 = Date.now();
  const [plain, occluded] = await Promise.all([render('plain', []), render('occ', [behind])]);
  console.log(`  two renders in ${Date.now() - t0}ms; runs: ${occluded.built.runs.map((r) => r.kind).join(', ')}`);
  assert.ok(occluded.built.runs.some((r) => r.kind === 'subject'), 'the export built a subject pass');
  assert.ok(!plain.built.runs.some((r) => r.kind === 'subject'), 'a project without occlusion has none');

  const { comp } = occluded;
  const W = comp.width;
  const H = comp.height;
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: comp.boxWidth, boxHeight: comp.boxHeight, transform: {} };
  for (const t of TIMES) {
    const [before, after] = await Promise.all([frameAt(plain.out, t, W, H), frameAt(occluded.out, t, W, H)]);
    const full = await visibleMask('olive', t, 'segment');
    let onHim = 0;
    let hidden = 0;
    let besideHim = 0;
    let stillThere = 0;
    for (let vy = 2; vy < FH - 2; vy += 2) {
      for (let vx = 2; vx < FW - 2; vx += 2) {
        const q = videoToComposition({ x: vx / FW, y: vy / FH }, placement);
        const sx = Math.round(q.x * W);
        const sy = Math.round(q.y * H);
        if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
        const i = (sy * W + sx) * 3;
        // Only where the bar actually is, in the un-occluded render.
        if (!isBar(before, i)) continue;
        const a = full[vy * FW + vx];
        const neighbours = [full[(vy - 2) * FW + vx], full[(vy + 2) * FW + vx], full[vy * FW + vx - 2], full[vy * FW + vx + 2]];
        if (a > 250 && neighbours.every((v) => v > 250)) {
          onHim++;
          if (!isBar(after, i)) hidden++;
        } else if (a === 0 && neighbours.every((v) => v === 0)) {
          besideHim++;
          if (isBar(after, i)) stillThere++;
        }
      }
    }
    assert.ok(onHim > 60 && besideHim > 300, `enough bar pixels sampled at ${t}s (${onHim} on him, ${besideHim} beside)`);
    const hiddenShare = hidden / onHim;
    const keptShare = stillThere / besideHim;
    assert.ok(hiddenShare > 0.9, `${t}s: the bar is hidden where he is (${(hiddenShare * 100).toFixed(1)}%)`);
    assert.ok(keptShare > 0.97, `${t}s: and still there beside him (${(keptShare * 100).toFixed(1)}%)`);
    console.log(`  ✓ ${t}s: ${(hiddenShare * 100).toFixed(1)}% of the bar hidden by him, ${(keptShare * 100).toFixed(1)}% kept beside him`);
  }

  // Switched off, outside its span, and with no masks: the bar covers him, and
  // the export is the one it would have been.
  const off = await render('off', [{ ...behind, enabled: false }]);
  const late = await render('late', [createOcclusion({ trackKey: 'kolive', layerIds: [BAR_ID], start: 2.5, end: DURATION })]);
  const noMasks = await render('nomasks', [behind], { segmentations: {} });
  const plainFrame = await frameAt(plain.out, 0.8, W, H);
  for (const [name, r] of [['switched off', off], ['without its masks', noMasks]]) {
    const f = await frameAt(r.out, 0.8, W, H);
    assert.ok(f.equals(plainFrame), `${name}: the exported frame is the one with no occlusion at all`);
    assert.ok(!r.built.runs.some((x) => x.kind === 'subject'), `${name}: no subject pass`);
  }
  const early = await frameAt(late.out, 0.8, W, H);
  assert.ok(early.equals(plainFrame), 'before the relationship starts: unchanged');
  console.log('  ✓ off, un-masked and outside its span: byte-identical to no occlusion');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 4] In front stays in front, and the person is never damaged');
{
  const behind = createOcclusion({ trackKey: 'kolive', layerIds: [BAR_ID], start: 0, end: DURATION });
  const front = createOcclusion({ trackKey: 'kolive', layerIds: [BAR_ID], mode: 'front', start: 0, end: DURATION });
  const [plain, bothWays] = await Promise.all([render('plain2', []), render('front', [behind, front])]);
  const W = plain.comp.width;
  const H = plain.comp.height;
  const a = await frameAt(plain.out, 0.8, W, H);
  const b = await frameAt(bothWays.out, 0.8, W, H);
  assert.ok(a.equals(b), 'told to stay in front, the layer is exactly where it always was');

  // The subject's own pixels, outside the bar, are untouched by occlusion.
  const occluded = await render('occ2', [behind]);
  const withOcc = await frameAt(occluded.out, 0.8, W, H);
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: plain.comp.boxWidth, boxHeight: plain.comp.boxHeight, transform: {} };
  const full = await visibleMask('olive', 0.8, 'segment');
  let checked = 0;
  let same = 0;
  for (let vy = 2; vy < FH - 2; vy += 2) {
    for (let vx = 2; vx < FW - 2; vx += 2) {
      if (full[vy * FW + vx] <= 250) continue;
      const q = videoToComposition({ x: vx / FW, y: vy / FH }, placement);
      const sx = Math.round(q.x * W);
      const sy = Math.round(q.y * H);
      if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
      const i = (sy * W + sx) * 3;
      if (isBar(a, i)) continue; // where the bar was, it is meant to change
      checked++;
      if (near(withOcc[i], a[i], 36) && near(withOcc[i + 1], a[i + 1], 36) && near(withOcc[i + 2], a[i + 2], 36)) same++;
    }
  }
  assert.ok(checked > 500, `enough of the person checked (${checked})`);
  assert.ok(same / checked > 0.97, `the person himself is unchanged (${((same / checked) * 100).toFixed(1)}%)`);
  console.log(`  ✓ 'in front' is a no-op; the person's own pixels unchanged (${((same / checked) * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
console.log('\n[Test 5] A TEXT layer and an IMAGE layer behind the same person');
{
  // A word written right across him, and a picture behind him.
  const WORD_ID = 'txt-wahala';
  const PIC_ID = 'img-bg';
  const picFile = path.join(work, 'pic.png');
  {
    const c = createCanvas(300, 80);
    const g = c.getContext('2d');
    g.fillStyle = '#00FF88';
    g.fillRect(0, 0, 300, 80);
    fs.writeFileSync(picFile, c.toBuffer('image/png'));
  }
  const { loadImage } = await import('@napi-rs/canvas');
  const imageSources = new Map([['asset-pic', await loadImage(picFile)]]);

  const textElements = [normalizeTextElement({
    id: WORD_ID, kind: 'overlay', start: 0, end: DURATION, text: 'WAHALA',
    style: { fontSize: 40, textColor: '#FFEE00', position: 'custom', customPosX: 50, customPosY: 46 }
  })];
  const imageLayers = [normalizeImageLayer({
    id: PIC_ID, assetId: 'asset-pic', start: 0, end: DURATION, enabled: true,
    transform: { x: 50, y: 46, width: 90, height: 22, scale: 1, rotation: 0, opacity: 100 }
  })];

  async function renderLayers(name, occlusions) {
    const framesDir = path.join(work, name);
    fs.mkdirSync(framesDir, { recursive: true });
    const comp = prepareVideoComposition({ composition: null, videoStyle: null, sourceWidth: FW, sourceHeight: FH, outDir: path.join(framesDir, 'composition') });
    const params = {
      preset: 'caps-white', captionMode: 'sentence',
      textElements: JSON.stringify(textElements),
      imageLayers: JSON.stringify(imageLayers),
      occlusions: JSON.stringify(occlusions),
      occlusionTracks: JSON.stringify({ kolive: track }),
      occlusionSegmentations: JSON.stringify(segPayload)
    };
    const built = buildFullTimelineSegments([], params, comp.width, comp.height, DURATION, framesDir, { frameRate: String(FPS), imageSources, videoBox: { boxWidth: comp.boxWidth, boxHeight: comp.boxHeight } });
    const out = path.join(work, name + '.mp4');
    await compositeGraphicsCaptionTrack(SEGMENT, built.captions, out, {
      duration: DURATION, canvasWidth: comp.width, canvasHeight: comp.height, frameRate: String(FPS),
      composition: comp, layerRuns: built.runs, imageSources
    });
    return { out, comp, built };
  }

  const behindBoth = createOcclusion({ trackKey: 'kolive', layerIds: [WORD_ID, PIC_ID], start: 0, end: DURATION });
  const [plainL, occL] = await Promise.all([renderLayers('layers-plain', []), renderLayers('layers-occ', [behindBoth])]);
  assert.ok(occL.built.runs.some((r) => r.kind === 'subject'), 'a subject pass for the text and the picture');
  const W = occL.comp.width;
  const H = occL.comp.height;
  const placement = { canvasWidth: W, canvasHeight: H, boxWidth: occL.comp.boxWidth, boxHeight: occL.comp.boxHeight, transform: {} };
  const t = 0.8;
  const [before, after] = await Promise.all([frameAt(plainL.out, t, W, H), frameAt(occL.out, t, W, H)]);
  const full = await visibleMask('olive', t, 'segment');
  const videoFrame = await frameAt(SEGMENT, t, FW, FH);
  let onHim = 0;
  let restored = 0;
  let besideHim = 0;
  let kept = 0;
  for (let vy = 2; vy < FH - 2; vy += 2) {
    for (let vx = 2; vx < FW - 2; vx += 2) {
      const q = videoToComposition({ x: vx / FW, y: vy / FH }, placement);
      const sx = Math.round(q.x * W);
      const sy = Math.round(q.y * H);
      if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= H - 1) continue;
      const i = (sy * W + sx) * 3;
      const j = (vy * FW + vx) * 3;
      // Only where a layer actually covers something in the plain render.
      const covered = Math.abs(before[i] - videoFrame[j]) > 60 || Math.abs(before[i + 1] - videoFrame[j + 1]) > 60 || Math.abs(before[i + 2] - videoFrame[j + 2]) > 60;
      if (!covered) continue;
      const a = full[vy * FW + vx];
      const nb = [full[(vy - 2) * FW + vx], full[(vy + 2) * FW + vx], full[vy * FW + vx - 2], full[vy * FW + vx + 2]];
      if (a > 250 && nb.every((v) => v > 250)) {
        onHim++;
        // Occluded: the person's own pixel is back, not the layer's.
        if (Math.abs(after[i] - videoFrame[j]) < 60 && Math.abs(after[i + 1] - videoFrame[j + 1]) < 60 && Math.abs(after[i + 2] - videoFrame[j + 2]) < 60) restored++;
      } else if (a === 0 && nb.every((v) => v === 0)) {
        besideHim++;
        if (Math.abs(after[i] - before[i]) < 40 && Math.abs(after[i + 1] - before[i + 1]) < 40 && Math.abs(after[i + 2] - before[i + 2]) < 40) kept++;
      }
    }
  }
  assert.ok(onHim > 100 && besideHim > 200, `enough layer pixels sampled (${onHim} on him, ${besideHim} beside)`);
  assert.ok(restored / onHim > 0.9, `the text and picture go behind him (${((restored / onHim) * 100).toFixed(1)}% of him back)`);
  assert.ok(kept / besideHim > 0.95, `and are untouched beside him (${((kept / besideHim) * 100).toFixed(1)}%)`);
  console.log(`  ✓ a word and a picture behind the same person: ${((restored / onHim) * 100).toFixed(1)}% of him restored, ${((kept / besideHim) * 100).toFixed(1)}% of them kept beside him`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log('\nAll dynamic occlusion checks passed.');
