/**
 * EdgeTAM, propagating — scored frame by frame against the true pixels, so it
 * can be compared directly with the shipped pipeline (measure_occlusion_gap.js).
 *
 * Prompted ONCE with a box on the first frame; every frame after is decoded
 * with no prompt at all. What is being tested is whether the memory holds the
 * right person through a crossing — which is exactly where the current
 * pipeline leaks 11.3% of its mask onto the other person.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { getTam, grabFrames, TamTracker, INPUT } from './edgetamHarness.js';
import { truth, visibleMask, W, H, FPS } from '../tests/fixtures/objects/make-crossing.mjs';

const SEGMENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'objects', 'segment.mp4');
const FIRST = Number(process.argv[2] ?? 8);
const COUNT = Number(process.argv[3] ?? 24);
const WHO = process.argv[4] ?? 'olive';
const OTHER = WHO === 'olive' ? 'shirt' : 'olive';

const toFrame = (logits) => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(INPUT - 1, Math.round((y + 0.5) / H * INPUT));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(INPUT - 1, Math.round((x + 0.5) / W * INPUT));
      out[y * W + x] = logits[sy * INPUT + sx] > 0 ? 255 : 0;
    }
  }
  return out;
};

const s = await getTam({ threads: 4 });
const tracker = new TamTracker(s);
// Decoded in ONE pass: per-frame seeking aliased on this timebase and returned
// the wrong frame every third time.
const pixelRun = await grabFrames(SEGMENT, FIRST / FPS, COUNT, FPS);
const scores = [];
let worstSpill = 0;
const t0 = Date.now();

for (let i = 0; i < COUNT; i++) {
  const k = FIRST + i;
  const t = k / FPS;
  const pixels = pixelRun[i];
  if (!pixels) break;
  const out = i === 0
    ? await tracker.prompt(pixels, truth(WHO, t, 'segment'))
    : await tracker.track(pixels);
  const got = toFrame(out.high_res_masks.data);
  const want = await visibleMask(WHO, t, 'segment');
  const theirs = await visibleMask(OTHER, t, 'segment');
  let inter = 0, uni = 0, area = 0, leak = 0;
  for (let p = 0; p < got.length; p++) {
    const a = got[p] >= 128, b = want[p] >= 128;
    if (a && b) inter++;
    if (a || b) uni++;
    if (a) { area++; if (theirs[p] >= 128) leak++; }
  }
  const iou = uni ? inter / uni : 0;
  const spill = area ? leak / area : 0;
  if (spill > worstSpill) worstSpill = spill;
  scores.push(iou);
  console.log(`  frame ${String(k).padStart(3)}  ${t.toFixed(3)}s  IoU ${iou.toFixed(3)}  spill ${(spill * 100).toFixed(1)}%  ${i === 0 ? '(prompted)' : ''}`);
}

const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
const secs = (Date.now() - t0) / 1000;
console.log(`\n${WHO}: ${COUNT} frames propagated from ONE box prompt`);
console.log(`   mean IoU ${mean.toFixed(3)}   min ${Math.min(...scores).toFixed(3)}   worst spill ${(worstSpill * 100).toFixed(1)}%`);
console.log(`   ${secs.toFixed(0)}s total, ${(secs / COUNT).toFixed(1)}s per frame (WASM CPU; the browser uses WebGPU)`);
