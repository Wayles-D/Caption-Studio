/**
 * MANUAL OBJECTS (shared/objects/templateMatch.js) — a box the user DRAWS
 * round anything, followed by its own pixels through the same tracker
 * (shared/objects/tracking.js) detections go through:
 *
 *   - the model: a drawn object's id (where, when, which matcher), its box
 *     clipped to the frame, too small refused;
 *   - matching: a pattern found where it is, through a change of light and
 *     of size; a plain patch matches nothing;
 *   - custom.mp4: a patterned badge the detector has NO class for (checked:
 *     YOLOX finds nothing there) is followed while it drifts, grows ~40% and
 *     the camera pans — never onto the decoy badge in other colours;
 *   - a person drawn round by hand follows him, as a detection would;
 *   - crossing.mp4: drawn round WHITE, the track holds through GREEN passing
 *     in front (uncertain, never swapped onto GREEN) and the pillar, and ENDS
 *     when he leaves the frame — nothing claimed after;
 *   - a cut ends it; the record is an ordinary track (keys, round trip).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  manualObjectId, normalizeManualBox, isManualObject, matchTemplate, patchNCC, toGray, createTemplateObserver,
  MANUAL_CLASS, MATCHER, MIN_MANUAL_SIDE
} from '../shared/objects/templateMatch.js';
import { trackObject, getTrackAtTime, iou, normalizeTrack, trackCacheKey, isTrackValidFor, DEFAULT_TRACK_CONFIG } from '../shared/objects/tracking.js';
import { probe, grabRegion, observe } from './trackingHarness.js';
import { truth } from '../tests/fixtures/objects/make-crossing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'tests', 'fixtures', 'objects');

console.log('--- Manual objects (draw a box round anything) ---');

/** Tracks a box drawn at `t0` in `file`, as the editor does. */
async function trackDrawn(file, t0, box) {
  const info = probe(file);
  const observer = createTemplateObserver({ time: t0, box, frameSize: info, grab: (t, r, w, h) => grabRegion(file, t, info, r, w, h) });
  const primed = await observer.prime();
  const detection = { id: manualObjectId(t0, box), class: MANUAL_CLASS, label: 'Object', confidence: 1, box, time: t0 };
  return trackObject({
    detection, appearance: primed.appearance, startThumb: primed.thumb, frameSize: info, duration: info.duration,
    observe: (t, look) => observer.observe(t, look)
  });
}

const times = (from, to, step = 0.25) => { const out = []; for (let t = from; t <= to + 1e-9; t += step) out.push(+t.toFixed(3)); return out; };

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The model: id, box, refusal');
{
  const b = { x: 0.2, y: 0.3, width: 0.1, height: 0.2 };
  const id = manualObjectId(1.5, b);
  assert.ok(id.startsWith('manual-') && id.includes(MATCHER.version), 'the id names the matcher version (a new matcher, a new track)');
  assert.strictEqual(id, manualObjectId(1.5, { ...b }), 'the same box at the same time: the same id');
  assert.notStrictEqual(id, manualObjectId(1.6, b), 'another time: another id');
  assert.notStrictEqual(id, manualObjectId(1.5, { ...b, x: 0.21 }), 'another box: another id');
  const clipped = normalizeManualBox({ x: 0.9, y: -0.1, width: 0.3, height: 0.3 }, 1000, 1000);
  assert.ok([[clipped.x, 0.9], [clipped.y, 0], [clipped.width, 0.1], [clipped.height, 0.2]].every(([a, b]) => Math.abs(a - b) < 1e-9), 'clipped to the frame');
  const flipped = normalizeManualBox({ x: 0.5, y: 0.5, width: -0.2, height: -0.1 }, 1000, 1000);
  assert.ok(Math.abs(flipped.x - 0.3) < 1e-9 && Math.abs(flipped.y - 0.4) < 1e-9, 'dragged up-left: the same box');
  assert.strictEqual(normalizeManualBox({ x: 0.5, y: 0.5, width: (MIN_MANUAL_SIDE - 1) / 1000, height: 0.2 }, 1000, 1000), null, 'too thin to follow: refused');
  assert.strictEqual(normalizeManualBox({ x: 1.2, y: 0.5, width: 0.2, height: 0.2 }, 1000, 1000), null, 'off the frame: refused');
  assert.ok(isManualObject({ manual: true }) && isManualObject({ class: MANUAL_CLASS }) && !isManualObject({ class: 'person' }));
  console.log('  ✓ ids, boxes, refusals');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Matching: found where it is, through light and size; a plain patch matches nothing');
{
  // A textured scene, and a pattern from it.
  const W = 160; const H = 120;
  const scene = { data: new Float32Array(W * H), width: W, height: H };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) scene.data[y * W + x] = 128 + 60 * Math.sin(x * 0.37 + y * 0.11) * Math.cos(y * 0.29 - x * 0.05) + ((x * 7 + y * 13) % 17);
  const cut = (g, x0, y0, w, h) => { const d = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = g.data[(y0 + y) * g.width + x0 + x]; return { data: d, width: w, height: h }; };
  const templ = cut(scene, 70, 40, 24, 20);
  const found = matchTemplate(scene, templ);
  assert.ok(found.length && found[0].x === 70 && found[0].y === 40 && found[0].score > 0.99, `found exactly where it is (${JSON.stringify(found[0])})`);
  // Darker and lower-contrast: NCC does not care.
  const dim = { ...scene, data: scene.data.map((v) => v * 0.5 + 20) };
  const f2 = matchTemplate(dim, templ);
  assert.ok(f2[0].x === 70 && f2[0].y === 40 && f2[0].score > 0.99, 'found in a darker, flatter picture');
  assert.ok(Math.abs(patchNCC(templ, cut(dim, 70, 40, 24, 20)) - 1) < 1e-6, 'patch NCC ignores light');
  const flat = { data: new Float32Array(W * H).fill(90), width: W, height: H };
  assert.strictEqual(matchTemplate(flat, templ).length, 0, 'a plain picture: no match');
  // toGray: luma weights.
  const g = toGray({ data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 });
  assert.ok(Math.abs(g.data[0] - 76.245) < 0.01 && Math.abs(g.data[1] - 149.685) < 0.01);
  console.log('  ✓ position, light, plain patch');
}

// ---------------------------------------------------------------------------
console.log('\n[Test 3] custom.mp4: a badge the detector has no class for — followed; the decoy never taken');
{
  const file = path.join(fixtures, 'custom.mp4');
  const info = probe(file);
  // The need: the detector finds nothing where the badge is.
  for (const t of [0.5, 2, 3.5]) {
    const o = await observe(file, t, info);
    const hit = o.candidates.find((c) => iou(c.box, truth('badge', t, 'custom')) > 0.3);
    assert.ok(!hit, `the detector does not find the badge at ${t}s (${hit && hit.label})`);
  }
  const t0 = performance.now();
  const track = await trackDrawn(file, 1.0, truth('badge', 1.0, 'custom'));
  const ms = performance.now() - t0;
  assert.strictEqual(track.class, MANUAL_CLASS);
  assert.ok(track.startTime <= 0.01 && track.endTime >= 3.99, `the whole clip (${track.startTime}–${track.endTime})`);
  const ious = times(0, 4).map((t) => { const s = getTrackAtTime(track, t); return s ? iou(s.box, truth('badge', t, 'custom')) : 0; });
  const min = Math.min(...ious);
  assert.ok(min >= 0.75, `on the badge throughout: worst IoU ${min.toFixed(2)}`);
  const mean = ious.reduce((a, b) => a + b, 0) / ious.length;
  assert.ok(mean >= 0.85, `mean IoU ${mean.toFixed(2)}`);
  times(0, 4).forEach((t) => { const s = getTrackAtTime(track, t); assert.ok(!s || iou(s.box, truth('decoy', t, 'custom')) === 0, `never on the decoy (${t}s)`); });
  // It grew: the track's box grows with it.
  const a = getTrackAtTime(track, 0.2).box.width;
  const b = getTrackAtTime(track, 3.8).box.width;
  assert.ok(b / a > 1.2, `the box grows as the badge does (×${(b / a).toFixed(2)}; truly ×${(truth('badge', 3.8, 'custom').width / truth('badge', 0.2, 'custom').width).toFixed(2)})`);
  console.log(`  ✓ badge followed 0–4s, IoU min ${min.toFixed(2)} mean ${mean.toFixed(2)}; never the decoy; ${(ms / 1000).toFixed(1)}s for the whole track`);

  const decoy = await trackDrawn(file, 2.0, truth('decoy', 2.0, 'custom'));
  const dmin = Math.min(...times(0, 4).map((t) => { const s = getTrackAtTime(decoy, t); return s ? iou(s.box, truth('decoy', t, 'custom')) : 0; }));
  assert.ok(dmin >= 0.85, `the still decoy stays put through the pan (worst IoU ${dmin.toFixed(2)})`);
  console.log(`  ✓ the decoy, drawn round instead: worst IoU ${dmin.toFixed(2)}`);

  const person = await trackDrawn(file, 0.5, truth('olive', 0.5, 'custom'));
  const pious = times(0, 2.2).map((t) => { const s = getTrackAtTime(person, t); return s ? iou(s.box, truth('olive', t, 'custom')) : 0; });
  assert.ok(Math.min(...pious) >= 0.7, `a person drawn round by hand: worst IoU ${Math.min(...pious).toFixed(2)} to 2.2s`);
  console.log(`  ✓ a person drawn round by hand: worst IoU ${Math.min(...pious).toFixed(2)} (to 2.2s — after that the badge covers his head)`);
}

// ---------------------------------------------------------------------------
console.log('\n[Test 4] crossing.mp4: drawn round WHITE — held through the crossing, never swapped, ends as he leaves');
{
  const file = path.join(fixtures, 'crossing.mp4');
  const track = await trackDrawn(file, 1.0, truth('white', 1.0, 'crossing'));
  assert.strictEqual(track.ends.forward.reason, 'exited', `ends because he left the frame (${track.ends.forward.reason})`);
  assert.ok(track.endTime >= 2.9 && track.endTime <= 3.7, `ends as he goes (${track.endTime.toFixed(2)}s)`);
  for (const t of times(0, track.endTime, 0.1)) {
    const s = getTrackAtTime(track, t);
    if (!s) continue;
    const onHim = iou(s.box, truth('white', t, 'crossing'));
    const onGreen = iou(s.box, truth('green', t, 'crossing'));
    assert.ok(onHim > onGreen, `${t}s: on WHITE (${onHim.toFixed(2)}), not GREEN (${onGreen.toFixed(2)})`);
    if (s.state === 'tracked') assert.ok(onHim >= 0.6, `${t}s: tracked, and on him (${onHim.toFixed(2)})`);
  }
  assert.ok(track.samples.some((s) => s.state === 'uncertain' && s.time > 1.6 && s.time < 2.6), 'uncertain while GREEN hides him');
  for (const t of [3.8, 3.95]) assert.strictEqual(getTrackAtTime(track, t), null, `nothing claimed after he has gone (${t}s)`);
  console.log(`  ✓ 0–${track.endTime.toFixed(1)}s on WHITE, uncertain while hidden, exited — nothing after`);
}

// ---------------------------------------------------------------------------
console.log('\n[Test 5] A cut ends it; the record is an ordinary track');
{
  // custom.mp4's first 2s (a night street), then the daylight crowd: a cut at 2.0s.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-manual-'));
  const cutFile = path.join(tmp, 'cut.mp4');
  const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-t', '2', '-i', path.join(fixtures, 'custom.mp4'), '-t', '2', '-i', path.join(fixtures, 'crowd-3s.mp4'),
    '-filter_complex', '[0:v]fps=15,setsar=1[a];[1:v]scale=640:360,fps=15,setsar=1[b];[a][b]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', cutFile]);
  assert.strictEqual(r.status, 0, r.stderr?.toString());
  const track = await trackDrawn(cutFile, 1.0, truth('badge', 1.0, 'custom'));
  assert.strictEqual(track.ends.forward.reason, 'cut', `the shot changed (${track.ends.forward.reason})`);
  assert.ok(track.endTime < 2.05, `nothing claimed past the cut (${track.endTime.toFixed(2)})`);
  fs.rmSync(tmp, { recursive: true, force: true });

  const detectionCacheKey = 'video:custom|yolox-tiny@1|min0.25';
  const key = trackCacheKey(detectionCacheKey, track.sourceObjectId, DEFAULT_TRACK_CONFIG);
  const stored = normalizeTrack(JSON.parse(JSON.stringify({ ...track, source: { videoKey: 'video:custom', detectionCacheKey } })));
  assert.ok(stored && isTrackValidFor(stored, key), 'saved and reloaded: valid for its key');
  assert.strictEqual(stored.class, MANUAL_CLASS);
  assert.ok(key.includes('manual-'), 'keyed by the drawn object');
  console.log(`  ✓ ends at the cut (${track.endTime.toFixed(2)}s); round-trips as a track`);
}

console.log('\nAll manual object checks passed.');
