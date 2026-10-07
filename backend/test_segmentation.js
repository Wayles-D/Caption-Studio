/**
 * OBJECT SEGMENTATION (shared/objects/segmentation.js) — the record, its
 * cache key and staleness, the pixel storage, the geometry, reading a mask
 * at any time, and the identity rules, on controlled input; then the REAL
 * segmenter (MobileSAM, onnxruntime-web — backend/segmentationHarness.js) on
 * segment.mp4, whose two people are drawn with their real silhouettes, so
 * every frame's mask is scored against the EXACT pixels of that person
 * (tests/fixtures/objects/make-crossing.mjs's visibleMask):
 *
 *   - a person in clear view: IoU ≥ 0.85 with their true pixels;
 *   - crossing behind another person: never more than a sliver of the mask
 *     on the other person — a keyframe it cannot vouch for has NO mask;
 *   - two tracks, two segmentations, each on its own person;
 *   - the stored artifact round-trips, and is checked against its record.
 */
import assert from 'assert';
import zlib from 'zlib';
import {
  segmentationCacheKey, isSegmentationValidFor, trackSignature, normalizeSegmentation, buildSegmentation, segmentTrack,
  encodeRLE, decodeRLE, packMasks, unpackMasks, createMaskReader, getMaskAtTime, rasterizeMask, coverageIoU,
  maskFrame, gridFor, cropFor, boxPrompt, logitsToGrid, cleanMask, warpLowRes, maskOnOthers, negativePoints,
  judgeKeyframe, keyframeTimes, gridIoU, maskLevel, DEFAULT_SEGMENTATION_CONFIG, SEGMENTER, MAX_SPILL
} from '../shared/objects/segmentation.js';
import { buildTrack, normalizeTrack, trackObject, getTrackAtTime, iou } from '../shared/objects/tracking.js';
import { observe, probe } from './trackingHarness.js';
import { grabCrop, segmentOnce, getSegmenter } from './segmentationHarness.js';
import { truth, visibleMask, W, H, FPS } from '../tests/fixtures/objects/make-crossing.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEGMENT = path.join(here, '..', 'tests', 'fixtures', 'objects', 'segment.mp4');

console.log('--- Object Segmentation ---');

const box = (x, y, w = 0.1, h = 0.4) => ({ x, y, width: w, height: h });
function track(samples, gaps = []) {
  return normalizeTrack(buildTrack({
    detection: { id: 'd0', class: 'person', label: 'Person', time: samples[0].time, box: samples[0].box, confidence: 0.9 },
    config: {}, samples, gaps, ends: { forward: { reason: 'video-end', time: samples[samples.length - 1].time }, backward: { reason: 'video-start', time: samples[0].time } }
  }));
}
const walk = (from = 0, to = 2, x0 = 0.2, speed = 0.1, state = () => 'tracked') => {
  const s = [];
  for (let t = from; t <= to + 1e-9; t += 0.2) s.push({ time: +t.toFixed(3), box: box(x0 + speed * t, 0.3), confidence: 0.9, state: state(t) });
  return s;
};
/** A filled ellipse in a grid — a stand-in mask. */
function blob(grid, cx = 0.5, cy = 0.5, rx = 0.25, ry = 0.35) {
  const a = new Uint8Array(grid.width * grid.height);
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const u = ((x + 0.5) / grid.width - cx) / rx; const v = ((y + 0.5) / grid.height - cy) / ry;
    if (u * u + v * v <= 1) a[y * grid.width + x] = 255;
  }
  return a;
}

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The record: keyed to its track (and its content), model, format and settings; stale when any changes');
{
  const t = track(walk());
  const key = segmentationCacheKey('trackA', t);
  assert.ok(key.startsWith('trackA|seg:') && key.includes(`${SEGMENTER.id}@${SEGMENTER.version}`));
  assert.notStrictEqual(key, segmentationCacheKey('trackB', t), 'another track');
  assert.notStrictEqual(key, segmentationCacheKey('trackA', t, { ...DEFAULT_SEGMENTATION_CONFIG, step: 0.2 }), 'other settings');
  const retracked = track(walk(0, 2, 0.21));
  assert.notStrictEqual(trackSignature(t), trackSignature(retracked), 'a re-track changes the fingerprint');
  assert.notStrictEqual(key, segmentationCacheKey('trackA', retracked), '...and so the key: the old masks are stale');
  assert.strictEqual(segmentationCacheKey(null, t), null);
  const rec = buildSegmentation({ track: t, trackKey: 'trackA', config: DEFAULT_SEGMENTATION_CONFIG, grid: { width: 40, height: 96 }, keyframes: [{ time: 0, confidence: 0.9, level: 'high', state: 'tracked' }, { time: 0.4, confidence: 0.3, level: 'low', state: 'uncertain' }] });
  assert.ok(isSegmentationValidFor(rec, 'trackA', t));
  assert.ok(!isSegmentationValidFor(rec, 'trackA', retracked), 'stale after a re-track');
  const back = normalizeSegmentation(JSON.parse(JSON.stringify(rec)));
  assert.deepStrictEqual(back, rec, 'save/load round trip');
  assert.strictEqual(normalizeSegmentation({ ...rec, segmenter: { id: SEGMENTER.id, version: '0.0.1' } }), null, 'another model version: discarded');
  assert.strictEqual(normalizeSegmentation({ ...rec, analysisVersion: 99 }), null, 'another format: discarded');
  assert.strictEqual(buildSegmentation({ track: t, trackKey: 'k', config: {}, grid: { width: 4, height: 4 }, keyframes: [] }).status, 'failed');
  assert.strictEqual(buildSegmentation({ track: t, trackKey: 'k', config: {}, grid: { width: 4, height: 4 }, keyframes: rec.keyframes, cancelled: true }).status, 'partial');
  assert.strictEqual(maskLevel(0.8), 'high'); assert.strictEqual(maskLevel(0.6), 'medium'); assert.strictEqual(maskLevel(0.2), 'low');
  // Keyframes: every step across the track, never inside a gap, both edges of a gap kept.
  const gapped = track(walk(0, 3), [{ start: 1, end: 2, reason: 'lost' }]);
  const kfs = keyframeTimes(gapped, 0.4);
  assert.ok(!kfs.some((x) => x > 1 && x < 2), 'nothing inside the gap');
  assert.ok(kfs.includes(1) && kfs.includes(2) && kfs[0] === 0 && kfs[kfs.length - 1] === 3);
}
console.log('✓ Keys, staleness (track content, model, format, settings), round trip, statuses, keyframes');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] The pixels: run-length coded, packed, deflated — and checked against their record');
{
  const grid = { width: 64, height: 128 };
  const masks = [blob(grid), blob(grid, 0.4), new Uint8Array(grid.width * grid.height)];
  masks[1][100] = 77; // a soft value survives exactly
  masks.forEach((m) => assert.deepStrictEqual(decodeRLE(encodeRLE(m), m.length), m, 'RLE round trip'));
  const big = blob({ width: 192, height: 96 });
  assert.ok(encodeRLE(big).length < big.length / 8, `a mask codes small (${encodeRLE(big).length} of ${big.length} bytes)`);
  const t = track(walk());
  const rec = buildSegmentation({ track: t, trackKey: 'k', config: {}, grid, keyframes: masks.map((_, i) => ({ time: i * 0.4, confidence: 0.9, level: 'high', state: 'tracked' })) });
  const stored = zlib.inflateRawSync(zlib.deflateRawSync(packMasks(rec, masks)));
  const parts = unpackMasks(new Uint8Array(stored), rec);
  parts.forEach((p, i) => assert.deepStrictEqual(decodeRLE(p, grid.width * grid.height), masks[i]));
  assert.throws(() => unpackMasks(new Uint8Array(stored), { ...rec, key: 'someone-else' }), /another segmentation/, 'another record\'s file is refused');
  assert.throws(() => unpackMasks(new Uint8Array(stored), { ...rec, grid: { width: 10, height: 10 } }), /does not match/);
  assert.throws(() => unpackMasks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), rec), /not a segmentation/);
  // The reader decodes on demand and keeps only a few.
  const reader = createMaskReader(rec, masks.map(encodeRLE));
  assert.deepStrictEqual(reader.mask(1), masks[1]);
}
console.log('✓ Lossless, compact, and never read as another segmentation\'s');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] Geometry and clean-up: the crop, the box prompt, logits → a box-relative grid, stray blobs and holes');
{
  const fb = box(0.4, 0.3, 0.1, 0.4);
  const crop = cropFor(fb, 640, 360, 0.35);
  assert.strictEqual(Math.max(crop.inputWidth, crop.inputHeight), 1024, 'the encoder\'s long side');
  const prompt = boxPrompt(fb, crop, 640, 360);
  assert.deepStrictEqual(prompt.labels, [2, 3]);
  assert.ok(Math.abs(prompt.coords[0] - (0.4 * 640 - crop.x) * crop.scale) < 1e-9);
  // Logits of a disc centred on the box → a disc centred in the grid.
  const logits = new Float32Array(crop.width * crop.height);
  const cx = (0.45 * 640) - crop.x; const cy = (0.5 * 360) - crop.y;
  for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) logits[y * crop.width + x] = 20 - Math.hypot(x - cx, y - cy);
  const grid = gridFor(fb, 640, 360);
  const g = logitsToGrid(logits, crop, fb, grid, 0.2, 640, 360);
  const at = (u, v) => g[Math.floor(v * grid.height) * grid.width + Math.floor(u * grid.width)];
  assert.ok(at(0.5, 0.5) > 200 && at(0.05, 0.05) < 20, 'the disc lands at the box\'s centre in the grid');
  const frame = maskFrame(fb, 0.2);
  assert.ok(Math.abs(frame.width - 0.1 * 1.4) < 1e-12 && Math.abs(frame.x - (0.4 - 0.02)) < 1e-12);
  // Clean-up: a stray blob goes; a speckle hole fills; a big gap (between legs) stays.
  const cg = { width: 60, height: 120 };
  const m = blob(cg, 0.5, 0.5, 0.3, 0.4);
  m[2 * 60 + 2] = 255; m[2 * 60 + 3] = 255; // a stray blob
  m[60 * 60 + 30] = 0; // a one-cell hole
  for (let y = 90; y < 120; y++) for (let x = 28; x < 33; x++) m[y * 60 + x] = 0; // a gap open to the edge
  cleanMask(m, cg);
  assert.strictEqual(m[2 * 60 + 2], 0, 'stray blob removed');
  assert.strictEqual(m[60 * 60 + 30], 255, 'speckle hole filled');
  assert.strictEqual(m[100 * 60 + 30], 0, 'the gap between the legs kept');
  // The previous mask prompt moves WITH the box.
  const prev = new Float32Array(256 * 256).fill(-20);
  const b0 = box(0.4, 0.3); const c0 = cropFor(b0, 640, 360); const b1 = box(0.5, 0.3); const c1 = cropFor(b1, 640, 360);
  const centreCell = (bb, c) => [Math.floor(((bb.x + bb.width / 2) * 640 - c.x) * c.scale / 4), Math.floor(((bb.y + bb.height / 2) * 360 - c.y) * c.scale / 4)];
  const [px, py] = centreCell(b0, c0);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) prev[(py + dy) * 256 + px + dx] = 10;
  const warped = warpLowRes(prev, c0, b0, c1, b1, 640, 360);
  const [qx, qy] = centreCell(b1, c1);
  assert.ok(warped[qy * 256 + qx] > 5, 'the old shape arrives where the object now is');
}
console.log('✓ Crop and prompt in the encoder\'s pixels; box-relative grid; blobs, holes and gaps handled; mask prompt follows the box');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] Reading a mask at any time: follows the track, morphs between keyframes, nothing where it cannot vouch');
{
  const grid = { width: 40, height: 96 };
  const t = track(walk(0, 2, 0.2, 0.1, (x) => (Math.abs(x - 1.0) < 1e-6 ? 'uncertain' : 'tracked')), [{ start: 1.6, end: 1.8, reason: 'lost' }]);
  const A = blob(grid, 0.4); const B = blob(grid, 0.6);
  const kfs = [0, 0.4, 0.8, 1.2].map((time) => ({ time, confidence: 0.9, level: 'high', state: 'tracked' }));
  kfs.push({ time: 1.6, confidence: 0, level: 'low', state: 'tracked', hidden: true });
  kfs.push({ time: 2.0, confidence: 0.9, level: 'high', state: 'tracked' });
  const masks = [A, B, A, B, new Uint8Array(A.length), A];
  const rec = buildSegmentation({ track: t, trackKey: 'k', config: { step: 0.4 }, grid, keyframes: kfs });
  const reader = createMaskReader(rec, masks.map(encodeRLE));
  const boxAt = (x) => getTrackAtTime(t, x);
  const m0 = getMaskAtTime(reader, boxAt, 0.4);
  assert.deepStrictEqual(m0.alpha, B, 'at a keyframe: that keyframe');
  // It is laid on the box AT THAT TIME: it moves with the track between keyframes.
  const mid = getMaskAtTime(reader, boxAt, 0.2);
  assert.ok(Math.abs(mid.frame.x - maskFrame(boxAt(0.2).box, rec.margin).x) < 1e-12, 'placed on the track\'s box now');
  // Between two keyframes: a morph, re-sharpened — no half-transparent double image.
  const soft = Array.from(mid.alpha).filter((v) => v > 30 && v < 225).length;
  assert.ok(soft < A.length * 0.03, `sharp, not a cross-fade (${soft} soft cells)`);
  const both = (Array.from(A).filter((v, i) => v && !B[i])).length;
  assert.ok(Array.from(mid.alpha).filter((v, i) => v >= 128 && A[i] && !B[i]).length < both, 'part-way: not simply the union of both');
  // Beside a hidden keyframe: only close to the visible one; inside the gap: nothing; outside the track: nothing.
  assert.ok(getMaskAtTime(reader, boxAt, 1.25), 'near the visible keyframe');
  assert.strictEqual(getMaskAtTime(reader, boxAt, 1.5), null, 'half way to the hidden one: nothing');
  assert.strictEqual(getMaskAtTime(reader, boxAt, 1.7), null, 'inside the track\'s gap: nothing');
  assert.strictEqual(getMaskAtTime(reader, boxAt, 2.3), null, 'after the track: nothing');
  // Where the track is unsure, so is the mask.
  assert.ok(getMaskAtTime(reader, boxAt, 1.0).confidence < getMaskAtTime(reader, boxAt, 0.6).confidence);
  // Rasterized onto a frame: inside the box, nothing far away.
  const cov = rasterizeMask(m0, 320, 180);
  const b = boxAt(0.4).box;
  assert.ok(cov[Math.floor((b.y + b.height / 2) * 180) * 320 + Math.floor((b.x + b.width * 0.6) * 320)] > 128);
  assert.strictEqual(cov[5 * 320 + 5], 0);
}
console.log('✓ Moves with the track; morphs sharply; no mask beside hidden keyframes, in gaps or outside the track');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Identity: "not this" points, spill onto another, and an unsure track inside someone else\'s box');
{
  const self = box(0.4, 0.3, 0.1, 0.4);
  const crop = cropFor(self, 640, 360);
  // A fragment of the object itself (half of it beside a pillar): wholly inside its box — never a negative.
  assert.deepStrictEqual(negativePoints(self, [box(0.42, 0.35, 0.03, 0.3)], crop, 640, 360), []);
  // Someone overlapping and reaching outside: points on the part outside.
  const other = box(0.45, 0.3, 0.1, 0.4);
  const pts = negativePoints(self, [self, other], crop, 640, 360);
  assert.strictEqual(pts.length, 6, 'three points on the other person');
  for (let i = 0; i < pts.length; i += 2) assert.ok(pts[i] / crop.scale + crop.x > 0.5 * 640, 'outside the object\'s own box');
  // Spill: mask cells beyond its own box and inside another's.
  const grid = gridFor(self, 640, 360);
  const inner = blob(grid, 0.5, 0.5, 0.3, 0.35);
  assert.strictEqual(maskOnOthers(inner, grid, self, 0.2, [self, other]).spill, 0);
  const wide = blob(grid, 0.75, 0.5, 0.35, 0.35);
  const on = maskOnOthers(wide, grid, self, 0.2, [self, other]);
  assert.ok(on.spill > MAX_SPILL, `reaching into the other person (${on.spill.toFixed(2)})`);
  assert.strictEqual(judgeKeyframe({ alpha: wide, grid, margin: 0.2, predictedIoU: 0.95, trackState: 'tracked', spill: on.spill, overlap: on.overlap }).hidden, true, 'spilling: no mask');
  // The object behind someone: its mask inside its own box but inside theirs too — while the track is unsure, no mask.
  const behind = box(0.4, 0.3, 0.12, 0.42);
  // (The frame's detections: the object's own, and the person in front of it.)
  const ov = maskOnOthers(inner, grid, self, 0.2, [self, behind]);
  assert.ok(ov.overlap > 0.5 && ov.spill === 0);
  assert.strictEqual(judgeKeyframe({ alpha: inner, grid, margin: 0.2, predictedIoU: 0.95, trackState: 'uncertain', ...ov }).hidden, true, 'unsure track, someone else\'s box: no mask');
  assert.strictEqual(judgeKeyframe({ alpha: inner, grid, margin: 0.2, predictedIoU: 0.95, trackState: 'tracked', ...ov }).hidden, false, 'a confident track: kept');
  // An empty mask is not the object; a good one is confident.
  assert.strictEqual(judgeKeyframe({ alpha: new Uint8Array(inner.length), grid, margin: 0.2, predictedIoU: 0.9, trackState: 'tracked' }).hidden, true);
  const ok = judgeKeyframe({ alpha: inner, grid, margin: 0.2, predictedIoU: 0.97, previous: inner, trackState: 'tracked' });
  assert.ok(!ok.hidden && ok.confidence > 0.75);
  assert.strictEqual(gridIoU(inner, inner), 1);
}
console.log('✓ Fragments of itself never excluded; spill and unsure overlap give no mask; clean masks are confident');

// ---------------------------------------------------------------------------
console.log('\n[Test 6] Real segmentation (MobileSAM) of real silhouettes, scored against their exact pixels (segment.mp4)');
{
  await getSegmenter({ threads: 4 });
  const info = probe(SEGMENT);
  const start = await observe(SEGMENT, 0.5, info);
  const results = {};
  for (const [who, other] of [['olive', 'shirt'], ['shirt', 'olive']]) {
    const gt0 = truth(who, 0.5, 'segment');
    const det = start.candidates.filter((c) => c.class === 'person').sort((a, b) => iou(b.box, gt0) - iou(a.box, gt0))[0];
    const tr = await trackObject({ detection: det, appearance: det.appearance, startThumb: start.thumb, frameSize: { width: info.width, height: info.height }, duration: info.duration, observe: (t, look) => observe(SEGMENT, t, info, look) });
    const t0 = Date.now();
    const { record, masks } = await segmentTrack({
      track: tr, trackKey: who, frameSize: { width: info.width, height: info.height },
      boxAt: (t) => getTrackAtTime(tr, t),
      others: async (t) => (await observe(SEGMENT, t, info)).candidates.filter((c) => c.class === 'person' && c.confidence >= 0.3).map((c) => c.box),
      grab: (t, crop) => grabCrop(SEGMENT, t, crop, info),
      segment: segmentOnce
    });
    const seconds = (Date.now() - t0) / 1000;
    // Stored and read back, as the editor does.
    const artifact = zlib.deflateRawSync(packMasks(record, masks));
    const reader = createMaskReader(record, unpackMasks(new Uint8Array(zlib.inflateRawSync(artifact)), record));
    const clear = []; let worstLeak = 0; let frames = 0;
    for (let k = Math.ceil(tr.startTime * FPS); k / FPS <= tr.endTime + 1e-6; k++) {
      const t = k / FPS;
      const m = getMaskAtTime(reader, (x) => getTrackAtTime(tr, x), t);
      if (!m) continue;
      frames++;
      const cov = rasterizeMask(m, W, H);
      const og = await visibleMask(other, t, 'segment');
      let area = 0; let leak = 0;
      for (let i = 0; i < cov.length; i++) if (cov[i] >= 128) { area++; if (og[i] >= 128) leak++; }
      if (area) worstLeak = Math.max(worstLeak, leak / area);
      // "Clear view": nobody in front, no pillar, wholly in frame.
      const b = truth(who, t, 'segment'); const ob = truth(other, t, 'segment');
      const apart = b.x + b.width < ob.x - 0.02 || ob.x + ob.width < b.x - 0.02;
      const pillar = b.x * W < 500 && (b.x + b.width) * W > 470 && who === 'olive';
      if (apart && !pillar && b.x > 0 && b.x + b.width < 1) clear.push(coverageIoU(cov, await visibleMask(who, t, 'segment')));
    }
    clear.sort((a, b) => a - b);
    const mean = clear.reduce((a, b) => a + b, 0) / clear.length;
    results[who] = { record, mean };
    console.log(`  ${who}: ${record.keyframes.length} keyframes in ${seconds.toFixed(0)}s, ${record.status}, conf ${record.confidence}; clear view IoU mean ${mean.toFixed(3)} min ${clear[0].toFixed(3)} over ${clear.length} frames; worst share on ${other} ${(worstLeak * 100).toFixed(1)}% over ${frames} masked frames; artifact ${artifact.length} bytes`);
    assert.ok(mean >= 0.85, `${who} in clear view: IoU ${mean.toFixed(3)} with the true pixels`);
    assert.ok(clear[0] >= 0.6, `${who}: no clear-view frame badly wrong (${clear[0].toFixed(3)})`);
    assert.ok(worstLeak <= 0.15, `${who}: never more than a sliver on ${other} (${(worstLeak * 100).toFixed(1)}%)`);
    assert.ok(artifact.length < 60000, 'the stored masks are small');
  }
  assert.notStrictEqual(results.olive.record.key, results.shirt.record.key, 'two tracks, two segmentations');
}
console.log('✓ Clear-view masks match the true silhouettes; identity held through the crossing; two objects kept apart');

console.log('\n--- All object segmentation checks passed ---');
