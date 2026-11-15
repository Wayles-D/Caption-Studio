/**
 * WHERE the mask is wrong, not just how wrong on average.
 *
 * The segmentation scores a mean IoU of ~0.88-0.94 against the true pixels,
 * which sounds healthy — and yet a layer put behind the subject visibly shows
 * through a moving hand. The suspicion the config itself records is that the
 * fault is TEMPORAL: masks exist on a fixed 0.4s grid and the frames between
 * them are a morph of two shapes, matching neither.
 *
 * So this scores every frame exactly as test_segmentation.js does, but buckets
 * the result by how far that frame sits from the nearest real keyframe. If the
 * morph is the problem, accuracy falls off with distance; if it does not, the
 * problem is elsewhere and denser sampling would be wasted work.
 *
 * Run: node backend/measure_occlusion_gap.js
 */
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  segmentTrack, packMasks, unpackMasks, createMaskReader, getMaskAtTime,
  rasterizeMask, coverageIoU, DEFAULT_SEGMENTATION_CONFIG
} from '../shared/objects/segmentation.js';
import { trackObject, getTrackAtTime, iou } from '../shared/objects/tracking.js';
import { observe, probe } from './trackingHarness.js';
import { grabCrop, segmentOnce, getSegmenter } from './segmentationHarness.js';
import { truth, visibleMask, W, H, FPS } from '../tests/fixtures/objects/make-crossing.mjs';

const SEGMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'objects', 'segment.mp4');

async function run(config, label) {
  await getSegmenter({ threads: 4 });
  const info = probe(SEGMENT);
  const start = await observe(SEGMENT, 0.5, info);
  const out = [];

  for (const [who, other] of [['olive', 'shirt'], ['shirt', 'olive']]) {
    const gt0 = truth(who, 0.5, 'segment');
    const det = start.candidates.filter((c) => c.class === 'person')
      .sort((a, b) => iou(b.box, gt0) - iou(a.box, gt0))[0];
    const tr = await trackObject({
      detection: det, appearance: det.appearance, startThumb: start.thumb,
      frameSize: { width: info.width, height: info.height }, duration: info.duration,
      observe: (t, look) => observe(SEGMENT, t, info, look)
    });
    const t0 = Date.now();
    const { record, masks } = await segmentTrack({
      track: tr, trackKey: who, config,
      frameSize: { width: info.width, height: info.height },
      boxAt: (t) => getTrackAtTime(tr, t),
      others: async (t) => (await observe(SEGMENT, t, info)).candidates
        .filter((c) => c.class === 'person' && c.confidence >= 0.3).map((c) => c.box),
      grab: (t, crop) => grabCrop(SEGMENT, t, crop, info),
      segment: segmentOnce
    });
    const seconds = (Date.now() - t0) / 1000;
    const reader = createMaskReader(record,
      unpackMasks(new Uint8Array(zlib.inflateRawSync(zlib.deflateRawSync(packMasks(record, masks)))), record));

    const kfTimes = record.keyframes.map((k) => k.time);
    const nearest = (t) => Math.min(...kfTimes.map((k) => Math.abs(k - t)));

    // Buckets by distance to the nearest keyframe, as a fraction of the step.
    const buckets = [[0, 0.1], [0.1, 0.25], [0.25, 0.4], [0.4, 0.51]];
    const scores = buckets.map(() => []);
    const series = [];
    let worstLeak = 0;

    for (let k = Math.ceil(tr.startTime * FPS); k / FPS <= tr.endTime + 1e-6; k++) {
      const t = k / FPS;
      const m = getMaskAtTime(reader, (x) => getTrackAtTime(tr, x), t);
      if (!m) continue;
      const cov = rasterizeMask(m, W, H);
      const og = await visibleMask(other, t, 'segment');
      let area = 0; let leak = 0;
      for (let i = 0; i < cov.length; i++) if (cov[i] >= 128) { area++; if (og[i] >= 128) leak++; }
      if (area) worstLeak = Math.max(worstLeak, leak / area);

      // Only frames in CLEAR VIEW, so occlusion by the other person cannot be
      // mistaken for a bad mask (same rule test_segmentation.js uses).
      const b = truth(who, t, 'segment'); const ob = truth(other, t, 'segment');
      const apart = b.x + b.width < ob.x - 0.02 || ob.x + ob.width < b.x - 0.02;
      const pillar = b.x * W < 500 && (b.x + b.width) * W > 470 && who === 'olive';
      if (!(apart && !pillar && b.x > 0 && b.x + b.width < 1)) continue;

      const score = coverageIoU(cov, await visibleMask(who, t, 'segment'));
      // The BOX the segmenter was given, against the true box: SAM only ever
      // sees the crop the tracker chooses, so a drifted box caps the mask.
      const boxNow = getTrackAtTime(tr, t);
      const boxIoU = boxNow?.box ? iou(boxNow.box, truth(who, t, 'segment')) : 0;
      series.push({ t: +t.toFixed(2), score: +score.toFixed(3), box: +boxIoU.toFixed(3), onKf: nearest(t) < 0.02 });
      const rel = nearest(t) / (config.step ?? DEFAULT_SEGMENTATION_CONFIG.step);
      const bi = buckets.findIndex(([lo, hi]) => rel >= lo && rel < hi);
      if (bi >= 0) scores[bi].push(score);
    }

    const stat = (arr) => arr.length
      ? { n: arr.length, mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3), min: +Math.min(...arr).toFixed(3) }
      : { n: 0, mean: null, min: null };
    out.push({ who, label, keyframes: record.keyframes.length, seconds: +seconds.toFixed(0),
      leak: +(worstLeak * 100).toFixed(1), buckets: scores.map(stat), series });
  }
  return out;
}

const off = await run({ ...DEFAULT_SEGMENTATION_CONFIG, promptFromMask: false }, 'tracked box');
const on = await run({ ...DEFAULT_SEGMENTATION_CONFIG, promptFromMask: true }, 'mask-derived box');
console.log('');
console.log('=== A/B: what the model is PROMPTED with ===');
for (let i = 0; i < off.length; i++) {
  const o = off[i], n = on[i];
  const mean = (r) => {
    const all = r.buckets.filter((b) => b.n).flatMap((b) => Array(b.n).fill(b.mean));
    return all.reduce((x, y) => x + y, 0) / all.length;
  };
  console.log(`${o.who}:  tracked box IoU ${mean(o).toFixed(3)} (spill ${o.leak}%)  ->  mask-derived ${mean(n).toFixed(3)} (spill ${n.leak}%)`);
  console.log(`   worst frame: ${Math.min(...o.buckets.filter((b)=>b.n).map((b)=>b.min)).toFixed(3)} -> ${Math.min(...n.buckets.filter((b)=>b.n).map((b)=>b.min)).toFixed(3)}`);
}
const rows = on;
console.log('\n=== IoU against the true pixels, by distance from the nearest keyframe ===');
console.log('(distance as a fraction of the 0.4s step: 0 = on a keyframe, 0.5 = exactly between two)\n');
for (const r of rows) {
  console.log(`${r.who}  —  ${r.keyframes} keyframes, ${r.seconds}s to segment, worst spill ${r.leak}%`);
  const names = ['on a keyframe   (0-10%)', 'near one       (10-25%)', 'further        (25-40%)', 'mid-way        (40-50%)'];
  r.buckets.forEach((b, i) => {
    console.log(`   ${names[i]}  n=${String(b.n).padStart(3)}  mean ${b.mean ?? '-'}  min ${b.min ?? '-'}`);
  });
  const worst = r.series.slice().sort((a, b) => a.score - b.score).slice(0, 8);
  console.log('   worst MASK frames (mask / box):');
  console.log('     ' + worst.map((f) => f.t + 's  m=' + f.score + ' b=' + f.box).join('  '));
  const corr = (() => {
    const xs = r.series.map((f) => f.box), ys = r.series.map((f) => f.score);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  })();
  console.log('   box IoU mean ' + (r.series.reduce((a, b) => a + b.box, 0) / r.series.length).toFixed(3)
    + '   correlation(box, mask) = ' + corr.toFixed(2));
  console.log('');
}
