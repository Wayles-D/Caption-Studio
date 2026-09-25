/**
 * End-to-end verification that a keyframed VIDEO transform actually reaches
 * the exported file — every property, and every COMBINATION of them.
 *
 * Combinations are the whole point. Reported from real use: a keyframed zoom
 * did nothing in the exported video, yet the same zoom worked as soon as a
 * rotation was keyframed alongside it — so each property "worked" when tested
 * on its own and the bug only existed in company. Measured here:
 *
 *   scale only      white-area ratio 3.50  (a real zoom)
 *   scale+opacity   white-area ratio 0.97  (nothing happened)
 *   scale+rotation  white-area ratio 3.52  (a real zoom)
 *
 * Cause: `scale` with eval=frame emits a different frame size every frame,
 * and the opacity stage (sendcmd + colorchannelmixer) does not survive that.
 * The rotation branch pads/rotates to a FIXED size, so everything downstream
 * of it sees a constant size — which is why adding a rotation "fixed" the
 * zoom, purely as a side effect. See videoTransformFilter.js's
 * CONSTANT-SIZE NORMALIZATION branch.
 *
 * The source is deliberately synthetic — a black frame with a known white
 * square — so "did it zoom", "did it fade" and "did it move" are all plain
 * measurements on real decoded frames rather than eyeballing.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { buildVideoTransformFilterChain } from './utils/videoTransformFilter.js';

console.log('--- Video Transform Export Verification (real ffmpeg renders) ---');

const W = 540, H = 960, DURATION = 6;
const SQ = 120;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vtx-'));

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
  });
}

const src = path.join(work, 'src.mp4');
await run([
  '-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=${DURATION}:r=25`,
  '-vf', `drawbox=x=(iw-${SQ})/2:y=(ih-${SQ})/2:w=${SQ}:h=${SQ}:color=white:t=fill`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src
]);

/** Bright-pixel area, mean brightness of the lit region, and its centroid. */
async function sample(file, time) {
  const raw = path.join(work, `f-${Math.random().toString(36).slice(2)}.rgb`);
  await run(['-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  let area = 0, sum = 0, sx = 0, sy = 0;
  for (let i = 0; i < buf.length; i += 3) {
    const lum = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
    if (lum > 60) {
      const p = i / 3;
      area++; sum += lum; sx += p % W; sy += Math.floor(p / W);
    }
  }
  fs.rmSync(raw, { force: true });
  return area
    ? { area, brightness: sum / area, cx: sx / area, cy: sy / area }
    : { area: 0, brightness: 0, cx: 0, cy: 0 };
}

// No captions in frame: a caption would add its own bright pixels and muddy
// every measurement. An empty phrase list still exercises the real segment +
// composite path.
const params = {
  preset: 'caps-white', fontFamily: 'Poppins', fontSize: '20',
  position: 'bottom', captionMode: 'sentence', animationMode: 'karaoke'
};
const phrases = [];

async function render(label, values) {
  const frames = path.join(work, `fr-${label.replace(/\W+/g, '-')}`);
  fs.mkdirSync(frames, { recursive: true });
  const out = path.join(work, `o-${label.replace(/\W+/g, '-')}.mp4`);
  const videoTransform = { keyframes: [
    { t: 0.5, easing: 'linear', values: values(0) },
    { t: DURATION - 0.5, easing: 'linear', values: values(1) }
  ] };
  const { captions, text } = buildFullTimelineSegments(phrases, { ...params, videoTransform }, W, H, DURATION, frames);
  await compositeGraphicsCaptionTrack(src, captions, out, {
    videoTransform, duration: DURATION, canvasWidth: W, canvasHeight: H, textElementSegments: text
  });
  return { early: await sample(out, 0.7), late: await sample(out, DURATION - 0.7) };
}

// A working 1x -> 2x zoom roughly quadruples the square's area; real output
// loses some to encoding and to the frame edge, so 2.5x is the floor for
// "this unmistakably zoomed" while still being far above the 1.0 of a zoom
// that never happened at all.
const ZOOMED = 2.5;

const SCALE_COMBOS = [
  ['scale alone', (m) => ({ scale: 1 + m })],
  ['scale + opacity', (m) => ({ scale: 1 + m, opacity: 100 - m * 30 })],
  ['scale + rotation', (m) => ({ scale: 1 + m, rotation: m * 20 })],
  ['scale + position', (m) => ({ scale: 1 + m, positionX: m * 10 })],
  ['scale + opacity + position', (m) => ({ scale: 1 + m, opacity: 100 - m * 30, positionX: m * 10 })],
  ['all four', (m) => ({ scale: 1 + m, opacity: 100 - m * 30, rotation: m * 20, positionX: m * 10, positionY: m * -8 })]
];

console.log('\n[Test 1] A keyframed zoom reaches the file in EVERY combination');
for (const [label, values] of SCALE_COMBOS) {
  const { early, late } = await render(label, values);
  const ratio = early.area ? late.area / early.area : 0;
  console.log(`  ${label.padEnd(28)} area ${String(early.area).padStart(6)} -> ${String(late.area).padStart(6)}   ratio ${ratio.toFixed(2)}`);
  assert.ok(early.area > 0, `${label}: nothing visible at the start of the clip`);
  assert.ok(
    ratio > ZOOMED,
    `${label}: the keyframed zoom did not reach the exported file (area ratio ${ratio.toFixed(2)}, expected > ${ZOOMED}). ` +
    'This is the scale+opacity regression — see videoTransformFilter.js CONSTANT-SIZE NORMALIZATION.'
  );
}
console.log('✓ Scale animates in the exported file whatever else is keyframed with it');

console.log('\n[Test 2] Opacity still fades, including alongside a zoom');
for (const [label, values] of [
  ['opacity alone', (m) => ({ opacity: 100 - m * 70 })],
  ['opacity + scale', (m) => ({ opacity: 100 - m * 70, scale: 1 + m })]
]) {
  const { early, late } = await render(label, values);
  console.log(`  ${label.padEnd(28)} brightness ${early.brightness.toFixed(1)} -> ${late.brightness.toFixed(1)}`);
  assert.ok(
    late.brightness < early.brightness * 0.85,
    `${label}: opacity did not fade the exported frames (${early.brightness.toFixed(1)} -> ${late.brightness.toFixed(1)})`
  );
}
console.log('✓ Opacity reaches the file, and padding the frame to a constant size did not break it');

console.log('\n[Test 3] Position still moves, including alongside a zoom');
for (const [label, values] of [
  ['position alone', (m) => ({ positionX: m * 20 })],
  ['position + scale + opacity', (m) => ({ positionX: m * 20, scale: 1 + m * 0.5, opacity: 100 - m * 20 })]
]) {
  const { early, late } = await render(label, values);
  console.log(`  ${label.padEnd(28)} centroid x ${early.cx.toFixed(1)} -> ${late.cx.toFixed(1)}`);
  assert.ok(
    late.cx > early.cx + 10,
    `${label}: position did not move the exported frames (${early.cx.toFixed(1)} -> ${late.cx.toFixed(1)})`
  );
}
console.log('✓ Position reaches the file in combination too');

console.log('\n[Test 4] Many keyframes still produce an expression ffmpeg can parse');
// Reported as a hard export failure, with this in the browser console:
//   [Parsed_scale_12] Cannot parse expression for width: 'iw*(if(...'
//   [AVFilterGraph] Error initializing filters
//   Failed to set value '<script>' for option 'filter_complex_script'
//
// The piecewise expression used to be a nested if/else chain — one nesting
// level per SAMPLE. ffmpeg's expression parser (libavutil/eval.c) allows a
// depth of 100, and MAX_TOTAL_SAMPLES is 120, so a transform with enough
// keyframes emitted an expression ffmpeg could not parse at all. It then
// exits non-zero and the whole job silently degrades to the ASS renderer.
//
// It depended on the TOTAL sample count across every property, not on which
// properties were used, which is why it looked arbitrary: a few more
// keyframes anywhere could tip a working project over, and adding a
// rotation could change the sample thinning enough to bring it back under.
//
// buildPiecewiseExpr now emits a flat sum of mutually-exclusive gated terms
// — depth-constant whatever the sample count — so this asserts BOTH that the
// render succeeds and that the emitted graph stays nowhere near the limit.
const manyKeyframes = [];
for (let i = 0; i < 14; i++) {
  manyKeyframes.push({
    t: 0.4 + i * (DURATION - 0.8) / 13,
    easing: 'ease-out',
    values: {
      opacity: i % 2 ? 45 : 100,
      scale: i % 3 === 0 ? 1 : 1.5,
      rotation: (i % 2) * 12,
      positionX: (i % 4) * 5,
      positionY: (i % 5) * -3
    }
  });
}

const manyFrames = path.join(work, 'fr-many');
fs.mkdirSync(manyFrames, { recursive: true });
const manyOut = path.join(work, 'o-many.mp4');
const manyTransform = { keyframes: manyKeyframes };

const chain = buildVideoTransformFilterChain(manyTransform, DURATION, W, H);
assert.ok(chain, 'a keyframed transform must produce a filter chain');
let depth = 0, maxDepth = 0;
for (const ch of chain.filterComplex) {
  if (ch === '(') { depth++; if (depth > maxDepth) maxDepth = depth; }
  else if (ch === ')') depth--;
}
console.log(`  ${manyKeyframes.length} keyframes -> ${chain.filterComplex.length} chars, max expression depth ${maxDepth}`);
assert.ok(
  maxDepth < 50,
  `The emitted expression nests ${maxDepth} deep — ffmpeg's parser gives up past 100, and a nested-if form scales with the sample count`
);

const { captions: manyCaptions, text: manyText } =
  buildFullTimelineSegments(phrases, { ...params, videoTransform: manyTransform }, W, H, DURATION, manyFrames);
await compositeGraphicsCaptionTrack(src, manyCaptions, manyOut, {
  videoTransform: manyTransform, duration: DURATION, canvasWidth: W, canvasHeight: H, textElementSegments: manyText
});
assert.ok(fs.existsSync(manyOut) && fs.statSync(manyOut).size > 1000, 'the render must actually produce a file');
console.log('✓ A heavily keyframed transform renders instead of falling back to ASS');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All video-transform export checks passed ---');
