/**
 * OBJECT DETECTION (shared/objects/) — the real model on real footage
 * (tests/fixtures/objects/, CC BY 4.0), the detection data model, the
 * sampling strategy, the cache and invalidation rules, and the video ↔
 * composition ↔ screen conversions:
 *
 *   - YOLOX-Tiny loads in onnxruntime-web (the editor's own runtime) and
 *     returns its documented output; people in a crowd frame are found, as
 *     separate same-class detections with in-range boxes;
 *   - bad input fails cleanly; an empty frame finds nothing;
 *   - detections keep unique ids, survive a save/load, and a stored set is
 *     valid only for its own video, model and settings;
 *   - a box placed through any canvas shape and any video placement (moved,
 *     scaled, rotated) maps back exactly, and a click finds the smallest box.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import * as ort from 'onnxruntime-web';
import { preprocess, postprocess, COCO_CLASSES, classLabel } from '../shared/objects/yolox.js';
import {
  DETECTION_MODELS, DEFAULT_MODEL_ID, videoSourceKey, detectionCacheKey, makeFrameDetections,
  normalizeDetectionSet, isDetectionSetValidFor, frameAt, visibleDetections, withFrame, sampleTimes
} from '../shared/objects/detections.js';
import { videoToComposition, compositionToVideo, videoBoxToComposition, compositionToScreen, screenToComposition, detectionAtScreenPoint } from '../shared/objects/coordinates.js';
import { resolveComposition, videoBaseBox } from '../shared/composition.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fixtures = path.join(root, 'tests', 'fixtures', 'objects');
const model = DETECTION_MODELS[DEFAULT_MODEL_ID];

console.log('--- Object Detection ---');

/** A fixture frame as RGBA, decoded by ffmpeg (which applies rotation metadata, as the browser does). */
function frameOf(file, time = 0) {
  const info = spawnSync(ffmpegPath, ['-i', file], { encoding: 'utf8' }).stderr;
  const rot = /rotation of -?90/.test(info);
  const [, w0, h0] = info.match(/, (\d{2,5})x(\d{2,5})/);
  const [w, h] = rot ? [+h0, +w0] : [+w0, +h0];
  const r = spawnSync(ffmpegPath, ['-v', 'error', ...(time ? ['-ss', String(time)] : []), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  assert.strictEqual(r.status, 0, `decoded ${path.basename(file)}`);
  return { data: new Uint8ClampedArray(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length), width: w, height: h };
}

async function detectIn(session, frame) {
  const { input, scale } = preprocess(frame, model.inputSize);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, model.inputSize, model.inputSize]) });
  const raw = out[session.outputNames[0]];
  return { raw, detections: postprocess(raw.data, { size: model.inputSize, scale, frameWidth: frame.width, frameHeight: frame.height, minScore: 0.25 }) };
}

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: loads, its output, real people found');
const t0 = Date.now();
const session = await ort.InferenceSession.create(path.join(root, 'public', 'models', model.file), { executionProviders: ['wasm'] });
console.log(`  ${model.id} loaded in ${Date.now() - t0}ms`);
{
  const frame = frameOf(path.join(fixtures, 'crowd.jpg'));
  const t1 = Date.now();
  const { raw, detections } = await detectIn(session, frame);
  console.log(`  ${frame.width}x${frame.height} frame in ${Date.now() - t1}ms: ${detections.filter((d) => d.confidence >= 0.45).map((d) => `${d.cls} ${d.confidence.toFixed(2)}`).join(', ')}`);
  assert.deepStrictEqual(raw.dims, [1, 3549, 85], 'YOLOX output: 3549 anchor points × (4 box + objectness + 80 classes)');
  const people = detections.filter((d) => d.cls === 'person' && d.confidence >= 0.45);
  assert.ok(people.length >= 3, `several people in the crowd (${people.length})`);
  assert.ok(people[0].confidence > 0.7, 'the nearest person, confidently');
  detections.forEach((d) => {
    assert.ok(COCO_CLASSES.includes(d.cls));
    const b = d.box;
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 1 + 1e-9 && b.y + b.height <= 1 + 1e-9 && b.width > 0 && b.height > 0, 'boxes inside the frame, normalized');
  });
  // Same class, distinct detections: no two person boxes are the same box.
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    assert.notDeepStrictEqual(people[i].box, people[j].box);
  }
}
{
  const blank = { data: new Uint8ClampedArray(320 * 240 * 4).fill(40), width: 320, height: 240 };
  const { detections } = await detectIn(session, blank);
  assert.strictEqual(detections.filter((d) => d.confidence >= 0.45).length, 0, 'an empty frame: nothing');
  await assert.rejects(() => session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(30), [1, 3, 2, 5]) }), 'a malformed input is rejected, not crashed on');
}
console.log('✓ Model, output, real detections, empty frame, bad input');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Rotation metadata: the video as displayed, not as stored');
{
  const upright = await detectIn(session, frameOf(path.join(fixtures, 'crowd-3s.mp4'), 1));
  const rotated = await detectIn(session, frameOf(path.join(fixtures, 'crowd-3s-rotated.mp4'), 1));
  const a = upright.detections.filter((d) => d.confidence >= 0.45);
  const b = rotated.detections.filter((d) => d.confidence >= 0.45);
  assert.ok(a.length >= 2);
  a.forEach((d) => {
    const m = b.find((x) => x.cls === d.cls && Math.abs(x.box.x - d.box.x) < 0.03 && Math.abs(x.box.y - d.box.y) < 0.03);
    assert.ok(m, `${d.cls} at ${d.box.x.toFixed(2)},${d.box.y.toFixed(2)} found in the same place in the rotation-metadata copy`);
  });
}
console.log('✓ Same boxes for a portrait video stored landscape with rotation metadata');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] Detections: ids, same-class, round trip, cache and invalidation');
{
  const raw = [
    { cls: 'person', confidence: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.6 } },
    { cls: 'person', confidence: 0.7, box: { x: 0.5, y: 0.2, width: 0.3, height: 0.6 } },
    { cls: 'cell phone', confidence: 0.6, box: { x: 0.2, y: 0.4, width: 0.05, height: 0.08 } },
    { cls: 'person', confidence: 0.3, box: { x: 0.8, y: 0.1, width: 0.1, height: 0.3 } }
  ];
  const at2 = makeFrameDetections(2, raw);
  const at3 = makeFrameDetections(3, raw);
  assert.strictEqual(new Set([...at2, ...at3].map((d) => d.id)).size, 8, 'every detection unique — across classes, within a class, across frames');
  assert.deepStrictEqual(at2.filter((d) => d.class === 'person').length, 3, 'two people are two detections');
  assert.strictEqual(at2.find((d) => d.class === 'cell phone').label, 'Phone');
  assert.strictEqual(classLabel('dining table'), 'Table');
  assert.ok(at2.every((d) => d.time === 2));
  assert.deepStrictEqual(visibleDetections({ detections: at2 }, 0.45).length, 3, 'the display threshold filters; nothing is thrown away');

  const sourceKey = videoSourceKey({ videoId: 'job1', duration: 12, width: 270, height: 480 });
  const key = detectionCacheKey(sourceKey);
  let set = normalizeDetectionSet({ source: { kind: 'video', key: sourceKey }, model: { id: model.id, version: model.version }, frames: [] });
  set = withFrame(set, 3, at3);
  set = withFrame(set, 2, at2);
  assert.deepStrictEqual(set.frames.map((f) => f.time), [2, 3], 'frames kept in time order');
  const reloaded = normalizeDetectionSet(JSON.parse(JSON.stringify(set)));
  assert.deepStrictEqual(reloaded, set, 'save/load round trip unchanged');
  assert.ok(isDetectionSetValidFor(reloaded, key), 'valid for its video and model');
  assert.ok(!isDetectionSetValidFor(reloaded, detectionCacheKey(videoSourceKey({ videoId: 'job2', duration: 12, width: 270, height: 480 }))), 'a replaced video: stale');
  assert.ok(!isDetectionSetValidFor(reloaded, detectionCacheKey(videoSourceKey({ videoId: 'job1', duration: 14, width: 270, height: 480 }))), 'a changed video: stale');
  assert.strictEqual(normalizeDetectionSet({ ...set, model: { id: model.id, version: '0.0.1' } }), null, 'another model version: discarded');
  assert.strictEqual(normalizeDetectionSet({ ...set, model: { id: 'gpt-vision' } }), null, 'an unknown model: discarded');
  assert.strictEqual(frameAt(set, 2.01, 0.02).time, 2, 'the analysed frame at a time');
  assert.strictEqual(frameAt(set, 2.5, 0.02), null, 'an unanalysed time: nothing (never another frame\'s boxes)');
  // Sampling.
  assert.deepStrictEqual(sampleTimes(4), [0.5, 1.5, 2.5, 3.5]);
  assert.strictEqual(sampleTimes(600, { interval: 1, maxFrames: 60 }).length, 60, 'a long video is spread, not flooded');
  assert.deepStrictEqual(sampleTimes(0), []);
}
console.log('✓ Unique ids, same-class kept apart, round trip, cache key, invalidation, sampling');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] Video ↔ composition ↔ screen, for every canvas and placement');
{
  const close = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
  const placements = [];
  for (const aspectRatio of ['9:16', '16:9', '1:1']) {
    for (const [srcW, srcH] of [[1080, 1920], [1920, 1080]]) {
      const comp = resolveComposition({ aspectRatio }, srcW, srcH);
      const box = videoBaseBox(comp, srcW, srcH);
      for (const transform of [
        { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 0 },
        { offsetXPct: 15, offsetYPct: -10, scale: 1, rotation: 0 },
        { offsetXPct: 0, offsetYPct: 0, scale: 0.6, rotation: 0 },
        { offsetXPct: -8, offsetYPct: 12, scale: 1.4, rotation: 33 }
      ]) placements.push({ aspectRatio, src: `${srcW}x${srcH}`, p: { canvasWidth: comp.width, canvasHeight: comp.height, boxWidth: box.width, boxHeight: box.height, transform } });
    }
  }
  placements.forEach(({ aspectRatio, src, p }) => {
    for (const pt of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.25, y: 0.8 }, { x: 0.5, y: 0.5 }]) {
      const back = compositionToVideo(videoToComposition(pt, p), p);
      assert.ok(close(back.x, pt.x) && close(back.y, pt.y), `${aspectRatio} ${src} ${JSON.stringify(p.transform)}: round trip`);
    }
    // The video's centre is the canvas centre moved by the offset.
    const c = videoToComposition({ x: 0.5, y: 0.5 }, p);
    assert.ok(close(c.x, 0.5 + p.transform.offsetXPct / 100) && close(c.y, 0.5 + p.transform.offsetYPct / 100));
  });
  // Known geometry: a 9:16 video fills a 9:16 canvas — video space IS canvas space.
  const fill = placements.find((x) => x.aspectRatio === '9:16' && x.src === '1080x1920' && x.p.transform.scale === 1 && !x.p.transform.offsetXPct).p;
  const tl = videoToComposition({ x: 0.2, y: 0.3 }, fill);
  assert.ok(close(tl.x, 0.2) && close(tl.y, 0.3));
  // A portrait video in a square canvas: centred, as wide as 9/16 of it.
  const sq = placements.find((x) => x.aspectRatio === '1:1' && x.src === '1080x1920' && x.p.transform.scale === 1 && !x.p.transform.offsetXPct).p;
  const left = videoToComposition({ x: 0, y: 0.5 }, sq);
  assert.ok(close(left.x, (1 - 9 / 16) / 2, 1e-3), `left edge at ${left.x}`);
  // Scaled to 60%: a corner moves 40% of the way to the centre.
  const sc = placements.find((x) => x.aspectRatio === '9:16' && x.src === '1080x1920' && x.p.transform.scale === 0.6).p;
  assert.ok(close(videoToComposition({ x: 0, y: 0 }, sc).x, 0.2));
  // Rotated 90°: the video's top edge becomes its right edge.
  const rot = { ...fill, transform: { offsetXPct: 0, offsetYPct: 0, scale: 1, rotation: 90 } };
  const topMid = videoToComposition({ x: 0.5, y: 0 }, rot);
  assert.ok(topMid.x > 0.5 && close(topMid.y, 0.5), 'top-middle swings to the right of centre');
  const corners = videoBoxToComposition({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, rot);
  assert.strictEqual(corners.length, 4);
  // Screen: a 300×533 frame at (100, 50).
  const rect = { left: 100, top: 50, width: 300, height: 533 };
  const s = compositionToScreen({ x: 0.5, y: 0.25 }, rect);
  assert.deepStrictEqual(s, { x: 250, y: 50 + 533 * 0.25 });
  const s2 = screenToComposition(s, rect);
  assert.ok(close(s2.x, 0.5) && close(s2.y, 0.25));
  // Clicking: the smallest containing box wins (a phone held in front of a person).
  const dets = makeFrameDetections(1, [
    { cls: 'person', confidence: 0.9, box: { x: 0.2, y: 0.2, width: 0.6, height: 0.7 } },
    { cls: 'cell phone', confidence: 0.6, box: { x: 0.45, y: 0.45, width: 0.1, height: 0.1 } }
  ]);
  const screenOf = (vx, vy, p) => compositionToScreen(videoToComposition({ x: vx, y: vy }, p), rect);
  for (const p of [fill, sq, sc, placements.at(-1).p]) {
    assert.strictEqual(detectionAtScreenPoint(dets, screenOf(0.5, 0.5, p), rect, p).class, 'cell phone');
    assert.strictEqual(detectionAtScreenPoint(dets, screenOf(0.3, 0.3, p), rect, p).class, 'person');
    assert.strictEqual(detectionAtScreenPoint(dets, screenOf(0.05, 0.05, p), rect, p), null, 'outside every box: nothing');
  }
}
console.log('✓ 9:16, 16:9, 1:1 canvases; portrait and landscape video; moved, scaled, rotated');

console.log('\n--- All object detection checks passed ---');
