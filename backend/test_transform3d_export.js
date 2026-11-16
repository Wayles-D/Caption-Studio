/**
 * V2.4.0 — THE VIDEO IN 3D, exported. A plain white video on the default
 * black canvas, laid on a floor (and later, tilting over time): the white
 * area of the real ffmpeg export must be exactly the quad the shared
 * homography predicts (shared/videoTransform.js's videoHomographyAt — the
 * same matrix the preview turns into CSS), corner for corner.
 *
 * Also: a background-render chunk (a window of the export) shows the same
 * tilted video the whole export shows at that moment.
 *
 *   node backend/test_transform3d_export.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack, setExportGpu } from './utils/graphicsCompositor.js';
import { videoHomographyAt, resolveVideoTransformAtTime } from '../shared/videoTransform.js';
import { projectedQuad } from '../shared/transform3d.js';

setExportGpu(false); // pixel measurements: the CPU encoder, the same every run
const W = 540, H = 960, DURATION = 5, FPS = 25;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-3d-'));

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
  });
}

const src = path.join(work, 'white.mp4');
await run(['-y', '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:d=${DURATION}:r=${FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);

async function frame(file, time) {
  const raw = path.join(work, `f-${Math.random().toString(36).slice(2)}.rgb`);
  await run(['-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return buf;
}
const lum = (buf, x, y) => {
  const i = (Math.round(y) * W + Math.round(x)) * 3;
  return (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
};
const brightArea = (buf) => { let n = 0; for (let i = 0; i < buf.length; i += 3) if (buf[i] > 128) n++; return n; };
const polygonArea = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;

/** The placed video's corners (its 2D offset, scale and spin) through its homography at `time` (TL, TR, BR, BL). */
function quadAt(videoTransform, time) {
  const h = videoHomographyAt(videoTransform, time, { canvasWidth: W, canvasHeight: H, boxWidth: W, boxHeight: H });
  const t = resolveVideoTransformAtTime(videoTransform, time);
  // Not tilted (yet): the identity — the flat corners.
  return projectedQuad(h || [1, 0, 0, 0, 1, 0, 0, 0, 1], {
    centerX: W / 2 + (t.offsetXPct / 100) * W, centerY: H / 2 + (t.offsetYPct / 100) * H,
    width: W * t.scale, height: H * t.scale, rotationDeg: t.rotation
  });
}

async function render(name, videoTransform, extra = {}) {
  const frames = path.join(work, `fr-${name}`);
  fs.mkdirSync(frames, { recursive: true });
  const params = { preset: 'caps-white', captionMode: 'sentence', videoTransform };
  const { captions } = await buildFullTimelineSegments([], params, W, H, DURATION, frames);
  const out = path.join(work, `${name}.mp4`);
  await compositeGraphicsCaptionTrack(src, captions, out, { videoTransform, duration: DURATION, canvasWidth: W, canvasHeight: H, frameRate: String(FPS), ...extra });
  return out;
}

function checkQuad(buf, quad, label) {
  const cx = quad.reduce((a, p) => a + p.x, 0) / 4;
  const cy = quad.reduce((a, p) => a + p.y, 0) / 4;
  quad.forEach((p, i) => {
    // 8px towards the centre: inside; 8px away from it: outside (where on the canvas).
    const d = Math.hypot(cx - p.x, cy - p.y);
    const ix = p.x + ((cx - p.x) / d) * 8, iy = p.y + ((cy - p.y) / d) * 8;
    const ox = p.x - ((cx - p.x) / d) * 8, oy = p.y - ((cy - p.y) / d) * 8;
    assert.ok(lum(buf, ix, iy) > 200, `${label}: just inside corner ${i} is the video (${lum(buf, ix, iy).toFixed(0)})`);
    if (ox > 0 && oy > 0 && ox < W - 1 && oy < H - 1) assert.ok(lum(buf, ox, oy) < 40, `${label}: just outside corner ${i} is the background (${lum(buf, ox, oy).toFixed(0)})`);
  });
  const expected = polygonArea(quad.map((p) => ({ x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) })));
  const got = brightArea(buf);
  assert.ok(Math.abs(got - expected) / expected < 0.02, `${label}: white area ${got} vs predicted ${expected.toFixed(0)}`);
  return { got, expected };
}

// 1. Laid on a floor, hinged on its bottom edge.
const floor = { transform3d: { enabled: true, rotateX: 55, originX: 50, originY: 100, perspective: 60 } };
{
  const out = await render('floor', floor);
  const r = checkQuad(await frame(out, 2), quadAt(floor, 2), 'floor');
  console.log(`✓ the video on a floor fills exactly the predicted quad (${r.got} px vs ${r.expected.toFixed(0)})`);
}

// 2. A left wall, pushed back, with a 2D offset and spin underneath.
const wall = { offsetXPct: 5, rotation: 8, scale: 0.8, transform3d: { enabled: true, rotateY: 40, originX: 0, originY: 50, depth: 20 } };
{
  const out = await render('wall', wall);
  const r = checkQuad(await frame(out, 2), quadAt(wall, 2), 'wall');
  console.log(`✓ a turned, pushed-back, spun and offset video too (${r.got} px vs ${r.expected.toFixed(0)})`);
}

// 3. Tilting over time: keyframes from upright to a floor.
const animated = {
  transform3d: { enabled: true, originX: 50, originY: 100 },
  keyframes: [
    { t: 1, easing: 'linear', values: { rotateX: 0 } },
    { t: 4, easing: 'linear', values: { rotateX: 60 } }
  ]
};
const animatedOut = await render('animated', animated);
for (const t of [0.48, 2.48, 4.48]) {
  const r = checkQuad(await frame(animatedOut, t), quadAt(animated, t), `animated @${t}s`);
  console.log(`✓ tilting over time, at ${t}s: ${r.got} px vs ${r.expected.toFixed(0)} predicted`);
}

// 4. A background-render chunk (a window from 2s) shows what the whole export shows at that moment.
{
  const windowed = await render('window', animated, { window: { start: 2, frames: FPS } });
  const [a, b] = await Promise.all([frame(animatedOut, 2.6), frame(windowed, 0.6)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  const mean = diff / a.length;
  assert.ok(mean < 3, `the chunk matches the whole export at 2.6s (mean difference ${mean.toFixed(2)})`);
  console.log(`✓ a background-render chunk of a tilting video matches the whole export (mean difference ${mean.toFixed(2)})`);
}

fs.rmSync(work, { recursive: true, force: true });
console.log('\nAll 3D video export checks passed.');
