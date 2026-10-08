/**
 * OBJECT TRACKING (shared/objects/tracking.js) — the rules on controlled
 * input, then the real tracker (YOLOX + appearance) on real footage:
 *
 *   - a track round-trips, is keyed by video + detections + start detection
 *     + tracker version + settings, and is stale when any of them changes;
 *   - reading a track interpolates without overshoot, claims nothing outside
 *     it, carries uncertainty, and smooths jitter without lag;
 *   - an ambiguous step is never resolved by guessing; a lost object is
 *     dropped after its coast; one leaving the frame EXITS; a half-hidden
 *     one is a partial sighting, not a new size;
 *   - the longer an object is unseen, the closer a likeness a match needs;
 *     hidden behind another of its class, it is held longer; a merged box
 *     is not taken as its own; a camera pan moves the prediction; a cut ends
 *     the track; finding it again needs a close, unique likeness;
 *   - frames.js: the zoomed look, its boxes back in the frame, camera
 *     motion and cuts measured on real pictures;
 *   - crossing.mp4 (two real people, known paths): each person's track stays
 *     on that person through the crossing, the pillar, and — for WHITE — out
 *     of the frame; neither is ever swapped for the other;
 *   - lookalike.mp4: the same crossing with identical twins — only motion
 *     tells them apart, and it does;
 *   - reentry.mp4: hidden behind a wall longer than the track coasts, he is
 *     found again on the far side — and nothing is claimed while he is hidden;
 *   - the crowd clip and its rotation-metadata twin give the same track.
 */
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  trackObject, startTracker, stepTracker, buildTrack, getTrackAtTime, smoothSamples, normalizeTrack, trackSegments,
  trackCacheKey, isTrackValidFor, iou, predictBox, lookRegion, reacquireCandidate, DEFAULT_TRACK_CONFIG, TRACK_ANALYSIS_TYPE, TRACKER
} from '../shared/objects/tracking.js';
import { appearanceOf, appearanceSimilarity } from '../shared/objects/appearance.js';
import { regionFor, fromRegion, thumbnail, cameraShift } from '../shared/objects/frames.js';
import { videoToComposition, compositionToVideo } from '../shared/objects/coordinates.js';
import { observe, probe, frameAt } from './trackingHarness.js';
import { truth } from '../tests/fixtures/objects/make-crossing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'tests', 'fixtures', 'objects');

console.log('--- Object Tracking ---');

const box = (x, y, w = 0.1, h = 0.3) => ({ x, y, width: w, height: h });
const red = new Float32Array(108); red[3] = 1;
const grey = new Float32Array(108); grey[0] = 1;
const det = (id, b, appearance = red, time = 0, cls = 'person') => ({ id, class: cls, label: 'Person', confidence: 0.9, box: b, time, appearance });

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: keys, round trip, invalidation, statuses');
{
  const key = trackCacheKey('video:a|yolox-tiny@1|min0.25', 'det-0000500-0');
  assert.ok(key.includes(TRACKER.version));
  assert.notStrictEqual(key, trackCacheKey('video:b|yolox-tiny@1|min0.25', 'det-0000500-0'), 'another video: another key');
  assert.notStrictEqual(key, trackCacheKey('video:a|yolox-tiny@1|min0.25', 'det-0000500-1'), 'another start detection: another key');
  assert.notStrictEqual(key, trackCacheKey('video:a|yolox-tiny@1|min0.25', 'det-0000500-0', { ...DEFAULT_TRACK_CONFIG, step: 0.1 }), 'other settings: another key');
  assert.strictEqual(trackCacheKey(null, 'x'), null);
  const samples = [0, 0.2, 0.4].map((t, i) => ({ time: t, box: box(0.1 + i * 0.1, 0.3), confidence: 0.9, state: 'tracked' }));
  const t = { ...buildTrack({ detection: det('det-0000000-0', box(0.1, 0.3)), config: DEFAULT_TRACK_CONFIG, samples, ends: { forward: { reason: 'video-end', time: 0.4 }, backward: { reason: 'video-start', time: 0 } } }), source: { videoKey: 'video:a', detectionCacheKey: 'video:a|yolox-tiny@1|min0.25' } };
  assert.strictEqual(t.analysisType, TRACK_ANALYSIS_TYPE);
  assert.strictEqual(t.status, 'completed');
  const back = normalizeTrack(JSON.parse(JSON.stringify(t)));
  assert.deepStrictEqual(back, t, 'save/load round trip unchanged');
  assert.ok(isTrackValidFor(back, trackCacheKey('video:a|yolox-tiny@1|min0.25', 'det-0000000-0')));
  assert.ok(!isTrackValidFor(back, trackCacheKey('video:b|yolox-tiny@1|min0.25', 'det-0000000-0')), 'a replaced video: stale');
  assert.strictEqual(normalizeTrack({ ...t, tracker: { id: TRACKER.id, version: '0.9.0' } }), null, 'another tracker version: discarded');
  assert.strictEqual(normalizeTrack({ ...t, analysisType: 'something' }), null);
  const status = (ends, s = samples) => buildTrack({ detection: det('d', box(0, 0)), config: DEFAULT_TRACK_CONFIG, samples: s, ends }).status;
  assert.strictEqual(status({ forward: { reason: 'lost' }, backward: { reason: 'video-start' } }), 'lost');
  assert.strictEqual(status({ forward: { reason: 'cancelled' }, backward: { reason: 'video-start' } }), 'partial');
  assert.strictEqual(status({ forward: { reason: 'exited' }, backward: { reason: 'video-start' } }), 'completed', 'leaving the frame is a natural end');
  assert.strictEqual(status({ forward: { reason: 'cut' }, backward: { reason: 'video-start' } }), 'completed', 'the shot ending is a natural end');
  assert.notStrictEqual(key, trackCacheKey('video:a|yolox-tiny@1|min0.25', 'det-0000500-0', { ...DEFAULT_TRACK_CONFIG, reacquireSeconds: 0 }), 'every setting is in the key');
  const withGap = { ...t, gaps: [{ start: 0.1, end: 0.3, reason: 'lost' }] };
  assert.deepStrictEqual(normalizeTrack(JSON.parse(JSON.stringify(withGap))).gaps, withGap.gaps, 'gaps survive save/load');
  assert.deepStrictEqual(normalizeTrack({ ...withGap, gaps: [{ start: 2, end: 1 }, null] }).gaps, [], 'nonsense gaps dropped');
  assert.strictEqual(status({}, samples.slice(0, 1)), 'failed', 'nothing followed: failed');
  assert.strictEqual(status({}, samples.map((s) => ({ ...s, state: 'uncertain', confidence: 0.3 })).concat(samples[0], samples[1])), 'low-confidence');
}
console.log('✓ Keys, round trip, stale rules, every status');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Reading a track: interpolation, gaps, smoothing');
{
  const samples = [
    { time: 0, box: box(0.1, 0.3), confidence: 0.9, state: 'tracked' },
    { time: 1, box: box(0.3, 0.3), confidence: 0.8, state: 'tracked' },
    { time: 2, box: box(0.5, 0.3), confidence: 0.4, state: 'uncertain' }
  ];
  const t = { ...buildTrack({ detection: det('d', box(0.1, 0.3)), config: DEFAULT_TRACK_CONFIG, samples, ends: {} }) };
  const mid = getTrackAtTime(t, 0.5, { smoothed: false });
  assert.ok(Math.abs(mid.box.x - 0.2) < 1e-9, 'linear between samples');
  assert.strictEqual(mid.state, 'tracked');
  assert.ok(Math.abs(mid.confidence - 0.8) < 1e-9, 'the lower confidence of the two');
  assert.strictEqual(getTrackAtTime(t, 1.5, { smoothed: false }).state, 'uncertain', 'next to an uncertain sample: uncertain');
  assert.strictEqual(getTrackAtTime(t, -0.1), null, 'before the track: no claim');
  assert.strictEqual(getTrackAtTime(t, 2.1), null, 'after the track: no claim');
  for (let x = 0; x <= 2; x += 0.05) {
    const s = getTrackAtTime(t, x, { smoothed: false });
    assert.ok(s.box.x >= 0.1 - 1e-9 && s.box.x <= 0.5 + 1e-9, 'never overshoots its samples');
  }
  // Smoothing: steady motion passes through unchanged (no lag); jitter is reduced.
  const steady = Array.from({ length: 11 }, (_, i) => ({ time: i * 0.2, box: box(0.1 + i * 0.05, 0.3), confidence: 0.9, state: 'tracked' }));
  smoothSamples(steady).slice(2, -2).forEach((s, i) => assert.ok(Math.abs(s.box.x - steady[i + 2].box.x) < 1e-9, 'no lag on steady motion'));
  const jitter = steady.map((s, i) => ({ ...s, box: { ...s.box, x: s.box.x + (i % 2 ? 0.02 : -0.02) } }));
  const rough = (list) => list.slice(1).reduce((a, s, i) => a + Math.abs((s.box.x - list[i].box.x) - 0.05), 0);
  assert.ok(rough(smoothSamples(jitter)) < rough(jitter) / 2, 'jitter more than halved');
  // A gap: nothing claimed inside it, no smoothing across it, the path broken there.
  const gapped = buildTrack({
    detection: det('d', box(0.1, 0.3)), config: DEFAULT_TRACK_CONFIG, ends: {},
    samples: [0, 0.2, 0.4, 2.0, 2.2, 2.4].map((x) => ({ time: x, box: box(x < 1 ? 0.1 : 0.6, 0.3), confidence: 0.9, state: 'tracked' })),
    gaps: [{ start: 0.4, end: 2.0, reason: 'lost' }]
  });
  assert.strictEqual(getTrackAtTime(gapped, 1.2), null, 'hidden: no claim');
  assert.ok(Math.abs(getTrackAtTime(gapped, 0.4).box.x - 0.1) < 1e-9, 'the last sighting before the gap is not pulled towards the next');
  assert.ok(Math.abs(getTrackAtTime(gapped, 2.0).box.x - 0.6) < 1e-9, 'nor the first after it');
  assert.deepStrictEqual(trackSegments(gapped).map((seg) => seg.length), [3, 3]);
}
console.log('✓ Linear, no overshoot, nothing outside, uncertainty carried; smoothing without lag');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] The rules: ambiguity, lost, exited, partial sightings');
{
  const cfg = DEFAULT_TRACK_CONFIG;
  // Two look-alikes equally close: no guess.
  let st = startTracker(det('a', box(0.40, 0.3)), red);
  let r = stepTracker(st, { time: 0.2, candidates: [det('x', box(0.37, 0.3), red, 0.2), det('y', box(0.43, 0.3), red, 0.2)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain', 'two equal look-alikes: uncertain, not a guess');
  // The same, but only one looks like it: appearance decides.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  r = stepTracker(st, { time: 0.2, candidates: [det('x', box(0.37, 0.3), red, 0.2), det('y', box(0.43, 0.3), grey, 0.2)] }, cfg);
  assert.strictEqual(r.sample.detectionId, 'x');
  // A different-looking object of the same class where it should be: refused.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  r = stepTracker(st, { time: 0.2, candidates: [det('y', box(0.40, 0.3), grey, 0.2)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain', 'someone else in its place is not it');
  // Another class: never considered.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  r = stepTracker(st, { time: 0.2, candidates: [det('c', box(0.40, 0.3), red, 0.2, 'dog')] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain');
  // Gone with nothing in its place: coasts, then lost.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  let ended = null;
  for (let t = 0.2; t < 2 && !ended; t += 0.2) ended = stepTracker(st, { time: t, candidates: [] }, cfg).ended;
  assert.strictEqual(ended.reason, 'lost');
  // Walking out of the right edge: exited.
  st = startTracker(det('a', box(0.80, 0.3)), red);
  stepTracker(st, { time: 0.2, candidates: [det('a2', box(0.86, 0.3), red, 0.2)] }, cfg);
  ended = null;
  for (let t = 0.4; t < 2 && !ended; t += 0.2) ended = stepTracker(st, { time: t, candidates: [] }, cfg).ended;
  assert.strictEqual(ended.reason, 'exited');
  // Half hidden (same height, half the width): a partial sighting — kept, uncertain, size not learned.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  r = stepTracker(st, { time: 0.2, candidates: [det('h', box(0.40, 0.3, 0.05, 0.3), red, 0.2)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain');
  assert.ok(Math.abs(r.sample.box.width - 0.1) < 1e-9, 'the object keeps its own size');
  // Coming closer (bigger, same shape): a real match.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  r = stepTracker(st, { time: 0.2, candidates: [det('n', box(0.39, 0.28, 0.12, 0.36), red, 0.2)] }, cfg);
  assert.strictEqual(r.sample.state, 'tracked', 'closer — larger, same shape — is still it');

  // A likeness of `sim` to red (Bhattacharyya of red with p·red is sqrt(p)).
  const alike = (sim) => { const a = new Float32Array(108); a[3] = sim * sim; a[0] = 1 - sim * sim; return a; };
  st = startTracker(det('a', box(0.40, 0.3)), red);
  assert.strictEqual(stepTracker(st, { time: 0.2, candidates: [det('m', box(0.40, 0.3), alike(0.65), 0.2)] }, cfg).sample.state, 'tracked', 'just seen: 0.65 is enough');
  st = startTracker(det('a', box(0.40, 0.3)), red);
  for (const x of [0.2, 0.4, 0.6]) stepTracker(st, { time: x, candidates: [] }, cfg);
  r = stepTracker(st, { time: 0.8, candidates: [det('m', box(0.40, 0.3), alike(0.65), 0.8)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain', 'unseen 0.8s: 0.65 is not enough');
  // Hidden behind someone of its class: held up to maxHiddenSeconds, then lost.
  const front = (x) => det('front', box(0.40, 0.3, 0.12, 0.32), grey, x);
  st = startTracker(det('a', box(0.40, 0.3)), red);
  ended = null;
  let last = 0;
  for (let x = 0.2; x < 3 && !ended; x += 0.2) { ended = stepTracker(st, { time: x, candidates: [front(x)] }, cfg).ended; last = x; }
  assert.strictEqual(ended.reason, 'lost');
  assert.ok(last > cfg.maxCoastSeconds + 0.5 && last <= cfg.maxHiddenSeconds + 0.21, `held while hidden, then lost (${last.toFixed(1)}s)`);
  // ...but once that long unseen, only a close likeness takes it back.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  for (let x = 0.2; x < 1.5; x += 0.2) stepTracker(st, { time: x, candidates: [front(x)] }, cfg);
  r = stepTracker(st, { time: 1.6, candidates: [front(1.6), det('m', box(0.40, 0.3), alike(0.75), 1.6)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain', 'unseen 1.6s: 0.75 is not enough');
  r = stepTracker(st, { time: 1.8, candidates: [front(1.8), det('m', box(0.40, 0.3), red, 1.8)] }, cfg);
  assert.strictEqual(r.sample.state, 'tracked', 'unseen 1.8s: its own look takes it back');
  // Two side by side, then one box, wider and no taller: merged — not taken as its own.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  stepTracker(st, { time: 0.2, candidates: [det('a1', box(0.40, 0.3), red, 0.2), det('b1', box(0.47, 0.3), grey, 0.2)] }, cfg);
  r = stepTracker(st, { time: 0.4, candidates: [det('ab', box(0.41, 0.3, 0.14, 0.3), red, 0.4)] }, cfg);
  assert.strictEqual(r.sample.state, 'uncertain', 'a merged box says it is there, not where');
  assert.ok(Math.abs(r.sample.box.width - 0.1) < 1e-9, 'the object keeps its own size');
  // The camera pans: the prediction moves with the picture.
  const tex = (shift = 0) => {
    const w = 128; const h = 72; const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const u = x - shift; d[y * w + x] = 128 + 60 * Math.sin(u * 0.37) * Math.cos(y * 0.29) + 50 * Math.sin(u * 0.11 + y * 0.07); }
    return { data: d, width: w, height: h };
  };
  st = startTracker(det('a', box(0.40, 0.3)), red, tex(0));
  stepTracker(st, { time: 0.2, thumb: tex(8), candidates: [] }, cfg);
  assert.ok(Math.abs(predictBox(st, 0.2).x - (0.40 + 8 / 128)) < 0.01, `a pan of 8px moves the prediction 8px (${predictBox(st, 0.2).x.toFixed(3)})`);
  r = stepTracker(st, { time: 0.4, thumb: tex(16), candidates: [det('p', box(0.40 + 16 / 128, 0.3), red, 0.4)] }, cfg);
  assert.strictEqual(r.sample.state, 'tracked', 'found where the pan put it');
  assert.ok(Math.abs(st.velocity.x) < 0.05, 'and the pan is not taken for its own motion');
  // A cut: a different picture altogether.
  // (Another scene: other shapes, other light.)
  const other = tex(40); other.data = other.data.map((v) => v * 0.35);
  st = startTracker(det('a', box(0.40, 0.3)), red, tex(0));
  r = stepTracker(st, { time: 0.2, thumb: other, candidates: [det('x', box(0.40, 0.3), red, 0.2)] }, cfg);
  assert.strictEqual(r.ended?.reason, 'cut', 'a different shot ends the track');
  // Finding it again: a close likeness, clearly closer than anyone else's, of its shape and size.
  st = startTracker(det('a', box(0.40, 0.3)), red);
  assert.ok(reacquireCandidate(st, [det('r', box(0.7, 0.3), alike(0.9), 2)]), 'it, elsewhere: found');
  assert.strictEqual(reacquireCandidate(st, [det('r', box(0.7, 0.3), alike(0.7), 2)]), null, 'only a passing likeness');
  assert.strictEqual(reacquireCandidate(st, [det('r', box(0.7, 0.3), alike(0.95), 2), det('s', box(0.2, 0.3), alike(0.9), 2)]), null, 'two who look like it: neither');
  assert.strictEqual(reacquireCandidate(st, [det('r', box(0.7, 0.3, 0.3, 0.3), red, 2)]), null, 'not its shape');
}
console.log('✓ No guessing between look-alikes; appearance decides; lost; exited; partial vs closer;');
console.log('  likeness bar rises unseen; hidden held longer; merged refused; pans followed; cuts end; re-finding strict');

// ---------------------------------------------------------------------------
console.log('\n[Test 3b] Frames: the zoomed look, its boxes, camera motion and cuts on real pictures');
{
  // A small object in 4K: a zoomed square around it. A big one: the whole frame. Never enlarged past 1.5x.
  const r4k = regionFor({ x: 0.5, y: 0.45, width: 0.08, height: 0.08 }, 2.2, 3840, 2160);
  assert.ok(r4k && Math.abs(r4k.width * 3840 - r4k.height * 2160) < 1, 'square in pixels');
  assert.ok(r4k.width * 3840 < 1500, 'and much smaller than the frame');
  assert.strictEqual(regionFor({ x: 0.3, y: 0.2, width: 0.3, height: 0.6 }, 2.2, 1920, 1080), null, 'a big object: the whole frame');
  const low = regionFor({ x: 0.5, y: 0.4, width: 0.03, height: 0.08 }, 2.2, 480, 272);
  assert.ok(!low || Math.max(low.width * 480, low.height * 272) >= 416 / 1.5 - 1, 'never enlarged past 1.5x');
  // Boxes back from the crop; a box cut by the crop's edge is dropped.
  const region = { x: 0.4, y: 0.2, width: 0.2, height: 0.4 };
  const back = fromRegion([{ box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, { box: { x: 0, y: 0.3, width: 0.2, height: 0.3 } }], region);
  assert.strictEqual(back.length, 1);
  const want = { x: 0.45, y: 0.3, width: 0.1, height: 0.2 };
  Object.keys(want).forEach((k) => assert.ok(Math.abs(back[0].box[k] - want[k]) < 1e-9, `mapped ${k}`));
  // Camera motion on a real picture: still is still; a shift is measured; a different picture is a cut.
  const f1 = thumbnail(frameAt(path.join(fixtures, 'crowd-3s.mp4'), 1.0));
  const f2 = thumbnail(frameAt(path.join(fixtures, 'crowd-3s.mp4'), 1.2));
  const still = cameraShift(f1, f2);
  assert.ok(!still.cut && Math.abs(still.dx) < 0.02 && Math.abs(still.dy) < 0.02, `a fixed camera: no shift (${still.dx}, ${still.dy})`);
  const moved = { ...f1, data: f1.data.map((_, i) => f1.data[i % f1.width >= 6 ? i - 6 : i]) };
  const pan = cameraShift(f1, moved);
  assert.ok(Math.abs(pan.dx - 6 / f1.width) < 1.5 / f1.width && !pan.cut, `a 6px pan measured (${(pan.dx * f1.width).toFixed(1)}px)`);
  const inverted = { ...f1, data: f1.data.map((v) => 255 - v) };
  assert.ok(cameraShift(f1, inverted).cut, 'a different picture: a cut');
}
console.log('✓ Zoom only where it helps; crop boxes mapped back; pans measured; cuts recognised');

/** The real tracker on a real file, as the editor runs it: zoomed looks, camera motion, both directions. */
function runTracker(file, d, inf, start, extra = {}) {
  return trackObject({ detection: d, appearance: d.appearance, startThumb: start.thumb, frameSize: { width: inf.width, height: inf.height }, duration: inf.duration, observe: (t, look) => observe(file, t, inf, look), ...extra });
}

// ---------------------------------------------------------------------------
console.log('\n[Test 4] Real footage: two real people crossing (crossing.mp4, known paths)');
const crossing = path.join(fixtures, 'crossing.mp4');
const info = probe(crossing);
{
  const start = await observe(crossing, 0.5, info);
  for (const [name, other] of [['white', 'green'], ['green', 'white']]) {
    const d = start.candidates.filter((c) => c.class === 'person').sort((a, b) => iou(b.box, truth(name, 0.5)) - iou(a.box, truth(name, 0.5)))[0];
    assert.ok(iou(d.box, truth(name, 0.5)) > 0.6, `${name}: found to start from`);
    const t0 = Date.now();
    let frames = 0;
    const track = await runTracker(crossing, d, info, start, { onProgress: (n) => { frames = n; } });
    console.log(`  ${name}: ${frames} frames in ${Date.now() - t0}ms — ${track.status}, ${track.startTime.toFixed(2)}-${track.endTime.toFixed(2)}s, ${track.samples.filter((s) => s.state === 'uncertain').length}/${track.samples.length} uncertain, ends ${track.ends.backward.reason}/${track.ends.forward.reason}`);
    track.samples.forEach((s) => {
      const self = iou(s.box, truth(name, s.time));
      const swap = iou(s.box, truth(other, s.time));
      if (s.state === 'tracked') assert.ok(self >= 0.5, `${name} @${s.time.toFixed(2)}: on its person (IoU ${self.toFixed(2)})`);
      // Never somewhere the other person is and it isn't.
      assert.ok(!(swap > 0.5 && self < 0.3), `${name} @${s.time.toFixed(2)}: never swapped for ${other}`);
    });
    // Back to the first frame either way.
    assert.strictEqual(track.ends.backward.reason, 'video-start');
    if (name === 'white') {
      // WHITE walks out on the right (over half gone by ~3.47s).
      assert.strictEqual(track.ends.forward.reason, 'exited');
      assert.ok(track.endTime > 2.9 && track.endTime < 3.6, `white's track ends as he leaves (${track.endTime.toFixed(2)})`);
      assert.strictEqual(getTrackAtTime(track, 3.8), null, 'nothing claimed after he is gone');
      // Behind the pillar (~2.3-2.6s) — still on him, honestly uncertain.
      const atPillar = getTrackAtTime(track, 2.45);
      assert.ok(iou(atPillar.box, truth('white', 2.45)) > 0.5, 'behind the pillar, still where he is');
    } else {
      assert.strictEqual(track.ends.forward.reason, 'video-end', 'green is in the frame to the end');
      assert.ok(track.samples.filter((s) => s.state === 'tracked').every((s) => iou(s.box, truth('green', s.time)) >= 0.5));
    }
    // Followed tightly: the smoothed state at arbitrary times matches the truth.
    for (const t of [0.13, 0.9, 1.33, 2.07]) {
      const s = getTrackAtTime(track, t);
      if (s) assert.ok(iou(s.box, truth(name, t)) > 0.55, `${name} at ${t}s: IoU ${iou(s.box, truth(name, t)).toFixed(2)}`);
    }
  }
}
console.log('✓ Identity held through the crossing; occlusion honest; exit detected; nothing claimed after');

// ---------------------------------------------------------------------------
console.log('\n[Test 4b] Identical twins crossing (lookalike.mp4): motion alone keeps them apart');
{
  const file = path.join(fixtures, 'lookalike.mp4');
  const inf = probe(file);
  const start = await observe(file, 0.5, inf);
  for (const [name, other] of [['white', 'twin'], ['twin', 'white']]) {
    const gt = truth(name, 0.5, 'lookalike');
    const d = start.candidates.filter((c) => c.class === 'person').sort((a, b) => iou(b.box, gt) - iou(a.box, gt))[0];
    const tr = await runTracker(file, d, inf, start);
    console.log(`  ${name}: ${tr.status}, ${tr.startTime.toFixed(2)}-${tr.endTime.toFixed(2)}s, ends ${tr.ends.backward.reason}/${tr.ends.forward.reason}`);
    assert.strictEqual(tr.ends.backward.reason, 'video-start');
    assert.strictEqual(tr.ends.forward.reason, name === 'white' ? 'exited' : 'video-end', `${name} followed to its real end, not lost at the crossing`);
    tr.samples.forEach((smp) => {
      const self = iou(smp.box, truth(name, smp.time, 'lookalike'));
      const swap = iou(smp.box, truth(other, smp.time, 'lookalike'));
      if (smp.state === 'tracked') assert.ok(self >= 0.5, `${name} @${smp.time.toFixed(2)}: on its twin (IoU ${self.toFixed(2)})`);
      assert.ok(!(swap > 0.5 && self < 0.3), `${name} @${smp.time.toFixed(2)}: never swapped`);
    });
    for (const t of [2.4, 3.0]) assert.ok(iou(getTrackAtTime(tr, t).box, truth(name, t, 'lookalike')) > 0.5, `${name} after the crossing at ${t}s`);
  }
}
console.log('✓ Twins with identical colours crossing: each followed to its end, never swapped');

// ---------------------------------------------------------------------------
console.log('\n[Test 4c] Hidden behind a wall longer than the coast (reentry.mp4): found again, nothing claimed while hidden');
{
  const file = path.join(fixtures, 'reentry.mp4');
  const inf = probe(file);
  const start = await observe(file, 0.5, inf);
  const gt = truth('white', 0.5, 'reentry');
  const d = start.candidates.filter((c) => c.class === 'person').sort((a, b) => iou(b.box, gt) - iou(a.box, gt))[0];
  const tr = await runTracker(file, d, inf, start);
  console.log(`  white: ${tr.status}, ${tr.startTime.toFixed(2)}-${tr.endTime.toFixed(2)}s, gaps ${JSON.stringify(tr.gaps)}, ends ${tr.ends.backward.reason}/${tr.ends.forward.reason}`);
  assert.strictEqual(tr.gaps.length, 1, 'one gap: behind the wall');
  const [gap] = tr.gaps;
  // Wholly hidden ~1.18-2.43s (make-crossing.mjs): the gap covers that, and ends as he comes out.
  assert.ok(gap.start < 1.2 && gap.end > 2.4 && gap.end < 3.3, `the gap is the wall (${gap.start.toFixed(2)}-${gap.end.toFixed(2)})`);
  for (const t of [1.5, 2.0]) assert.strictEqual(getTrackAtTime(tr, t), null, `nothing claimed at ${t}s, while he is hidden`);
  assert.strictEqual(tr.ends.forward.reason, 'exited', 'followed on, out of the frame');
  tr.samples.filter((smp) => smp.state === 'tracked').forEach((smp) => {
    assert.ok(iou(smp.box, truth('white', smp.time, 'reentry')) >= 0.5, `@${smp.time.toFixed(2)}: on him`);
    assert.ok(iou(smp.box, truth('green', smp.time, 'reentry')) < 0.1, 'never the man standing on the left');
  });
  assert.strictEqual(trackSegments(tr).length, 2, 'the path is broken at the wall');
  // Without finding again, the same video ends lost at the wall — what the gap replaced.
  const plain = await runTracker(file, d, inf, start, { config: { reacquireSeconds: 0 } });
  assert.strictEqual(plain.ends.forward.reason, 'lost');
}
console.log('✓ Lost behind the wall, found again on the far side, followed out; the hidden stretch is a gap');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Real crowd footage; a rotation-metadata copy gives the same track');
{
  const runOn = async (file, at, sameAs = null) => {
    const inf = probe(file);
    const s = await observe(file, at, inf);
    // Someone wholly in the frame (one half out of it is about to leave, and
    // rightly ends as exited at once).
    const inside = (b) => b.x > 0.02 && b.y > 0.02 && b.x + b.width < 0.98 && b.y + b.height < 0.98;
    const d = sameAs
      ? s.candidates.filter((c) => c.class === 'person').sort((x, y) => iou(y.box, sameAs) - iou(x.box, sameAs))[0]
      : s.candidates.filter((c) => c.class === 'person' && c.confidence > 0.6 && inside(c.box)).sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
    return runTracker(file, d, inf, s);
  };
  const a = await runOn(path.join(fixtures, 'crowd-3s.mp4'), 1);
  // The SAME person in the rotated copy (the one whose box matches).
  const b = await runOn(path.join(fixtures, 'crowd-3s-rotated.mp4'), 1, a.samples.find((x) => Math.abs(x.time - 1) < 1e-6).box);
  console.log(`  crowd: ${a.status}, ${a.startTime.toFixed(2)}-${a.endTime.toFixed(2)}s, ${a.samples.length} samples, confidence ${a.confidence}`);
  assert.ok(a.status !== 'failed' && a.samples.length >= 8, 'a person in a crowd is followed');
  // Continuity: a tracked object doesn't teleport between neighbouring samples.
  const tracked = a.samples.filter((s) => s.state === 'tracked');
  for (let i = 1; i < tracked.length; i++) {
    const p = tracked[i - 1].box;
    const q = tracked[i].box;
    const jump = Math.hypot((q.x + q.width / 2) - (p.x + p.width / 2), (q.y + q.height / 2) - (p.y + p.height / 2));
    assert.ok(jump < 0.6 * Math.max(p.width, p.height) + 0.05, `no teleport at ${tracked[i].time.toFixed(2)}s`);
  }
  for (const t of [0.4, 1.0, 1.6, 2.2]) {
    const sa = getTrackAtTime(a, t);
    const sb = getTrackAtTime(b, t);
    if (sa && sb) assert.ok(iou(sa.box, sb.box) > 0.7, `the rotated copy agrees at ${t}s (${iou(sa.box, sb.box).toFixed(2)})`);
  }
  // The track lives in VIDEO space: placing it on a rotated, scaled canvas and back is exact.
  const p = { canvasWidth: 1080, canvasHeight: 1080, boxWidth: 607.5, boxHeight: 1080, transform: { offsetXPct: 10, offsetYPct: -5, scale: 0.8, rotation: 25 } };
  const s = getTrackAtTime(a, 1.0);
  const c = { x: s.box.x + s.box.width / 2, y: s.box.y + s.box.height / 2 };
  const round = compositionToVideo(videoToComposition(c, p), p);
  assert.ok(Math.abs(round.x - c.x) < 1e-9 && Math.abs(round.y - c.y) < 1e-9);
}
console.log('✓ Followed continuously; rotation metadata changes nothing; composition placement exact');

// ---------------------------------------------------------------------------
console.log('\n[Test 6] Appearance: the same person matches, another does not');
{
  const f = await observe(crossing, 0.5, info);
  const later = await observe(crossing, 3.0, info);
  const fp = (o, name, t) => {
    const d = o.candidates.filter((c) => c.class === 'person').sort((a, b) => iou(b.box, truth(name, t)) - iou(a.box, truth(name, t)))[0];
    return appearanceOf(o.frame, d.box);
  };
  const same = appearanceSimilarity(fp(f, 'white', 0.5), fp(later, 'white', 3.0));
  const other = appearanceSimilarity(fp(f, 'white', 0.5), fp(later, 'green', 3.0));
  console.log(`  white→white ${same.toFixed(2)}, white→green ${other.toFixed(2)}`);
  assert.ok(same > 0.8 && other < 0.6 && same - other > 0.25, 'the fingerprint tells them apart');
}
console.log('✓ Fingerprints separate two people');

console.log('\n--- All object tracking checks passed ---');
