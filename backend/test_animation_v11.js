/**
 * BHYND V1.1.0 — entrance animation timing, and preview/export parity for it.
 *
 * The animation maths (shared/captionAnimation.js) is shared by the preview
 * and the exporter, so parity comes down to WHEN the exporter samples it.
 * This checks, with a REAL ffmpeg render at 30 fps, that every frame of an
 * entrance in the exported file shows the text where the shared renderer
 * draws it at that frame's own instant — the instant the preview draws that
 * frame at — and checks the timing rules themselves:
 *
 *   - before its entrance begins a thing is not drawn (a word used to wait,
 *     fully visible, at its start offset);
 *   - slides travel about a line (font sizes, not a tenth of the frame), in
 *     the direction they name, and start invisible;
 *   - a word's entrance may run past the word's own spoken end, up to its
 *     caption's end (it used to be cut to the word, so duration did nothing);
 *   - 'together' anchors a word's entrance at its caption's start;
 *   - export samples on the output's frame grid.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas } from '@napi-rs/canvas';
import { getAnimationTransform, resolveWordAnimationWindow, SLIDE_DISTANCE_EM } from '../shared/captionAnimation.js';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack, getVideoInfo } from './utils/graphicsCompositor.js';
import { drawCaptionFrameForExport, paintFrameBackground, measureSentenceFrame } from '../shared/captionGraphics.js';
import { getCSSPreviewFromConfig, getASSStyleFromConfig } from '../shared/captionConfig.js';
import { createInterlude, textElementToPhrase, resolveTextElementParams, resolveInterludeBackground } from '../shared/textElement.js';

console.log('--- V1.1 Entrance Animation Timing + Export Parity ---');

// ---------------------------------------------------------------------------
console.log('\n[Test 1] The timing rules');
{
  const anim = (type, t, extra = {}) => getAnimationTransform({ captionAnimationType: type, captionAnimationDuration: 0.25, captionAnimationEasing: 'linear', ...extra }, t, 1, 3);
  for (const type of ['fade', 'pop', 'scale', 'slide-up', 'slide-down', 'slide-left', 'slide-right']) {
    assert.strictEqual(anim(type, 0.99).alpha, 0, `${type}: not drawn before its entrance begins`);
  }
  for (const type of ['slide-up', 'slide-down', 'slide-left', 'slide-right']) {
    assert.strictEqual(anim(type, 1).alpha, 0, `${type}: starts invisible, not standing at its offset`);
    assert.strictEqual(anim(type, 1.125).alpha, 1, `${type}: opaque well before it lands`);
    const t = anim(type, 1);
    const travel = Math.hypot(t.offsetXEm, t.offsetYEm);
    assert.ok(Math.abs(travel - SLIDE_DISTANCE_EM) < 1e-9, `${type}: travels ${SLIDE_DISTANCE_EM} font size(s), got ${travel}`);
  }
  // Directions name the way the text MOVES.
  assert.ok(anim('slide-up', 1.1).offsetYEm > 0, 'Slide Up starts below and rises');
  assert.ok(anim('slide-down', 1.1).offsetYEm < 0, 'Slide Down starts above and falls');
  assert.ok(anim('slide-left', 1.1).offsetXEm > 0, 'Slide Left starts to the right and travels left');
  assert.ok(anim('slide-right', 1.1).offsetXEm < 0, 'Slide Right starts to the left and travels right');
  assert.deepStrictEqual(anim('slide-up', 1.25), { alpha: 1, scale: 1, offsetXEm: 0, offsetYEm: 0 }, 'landed at the end of its duration');
  assert.deepStrictEqual(anim('none', 0), { alpha: 1, scale: 1, offsetXEm: 0, offsetYEm: 0 }, 'no animation, no effect — ever');

  // A word's window runs to its caption's end, so the duration is honoured.
  const word = { start: 1.5, end: 1.9 };
  const caption = { start: 1, end: 3 };
  assert.deepStrictEqual(resolveWordAnimationWindow(word, caption, {}), { start: 1.5, end: 3 });
  assert.deepStrictEqual(resolveWordAnimationWindow(word, caption, { animationTiming: 'together' }), { start: 1, end: 3 });
  const longSlide = { captionAnimationType: 'slide-up', captionAnimationDuration: 1, captionAnimationEasing: 'linear' };
  const win = resolveWordAnimationWindow(word, caption, {});
  assert.ok(getAnimationTransform(longSlide, 2.0, win.start, win.end).offsetYEm > 0.4, 'a 1s word entrance is still moving 0.5s in, after the word is said');
}
console.log('✓ Hidden before it begins, about a line of travel, right directions, duration honoured, together anchors at the caption');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] A real 30 fps render: every frame of a card\'s word entrances, against the shared renderer at that frame');
const WIDTH = 360;
const HEIGHT = 640;
const DURATION = 3;
const FPS = 30;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-anim-v11-'));
const run = (args) => new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, args);
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', reject);
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
});

const src = path.join(work, 'src.mp4');
await run(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
const info = await getVideoInfo(src);
assert.strictEqual(info.frameRate, '30');

// A card on white with its words spoken at 0.5 / 1.0 / 1.5: "HOME" plain,
// "OFFICE" slides up on its own time, "HACKS" pops in together with the
// card's start. The card's own entrance is off so only the words move.
const card = createInterlude({
  id: 'intl_v11', start: 0.5, end: 2.5, text: 'HOME OFFICE HACKS',
  style: { captionAnimationType: 'none' },
  timing: [
    { word: 'HOME', offset: 0, duration: 0.45 },
    { word: 'OFFICE', offset: 0.5, duration: 0.45 },
    { word: 'HACKS', offset: 1.0, duration: 0.45 }
  ],
  wordTransforms: {
    w1: { animationType: 'slide-up', animationDuration: 0.3, animationEasing: 'ease-out' },
    w2: { animationType: 'pop', animationDuration: 0.25, animationEasing: 'ease-out', animationTiming: 'together' }
  }
});
const params = {
  preset: 'caps-white', fontFamily: 'Poppins', fontSize: '20', position: 'bottom',
  captionMode: 'sentence', animationMode: 'karaoke', textElements: [card]
};

const framesDir = path.join(work, 'frames');
fs.mkdirSync(framesDir, { recursive: true });
const layers = buildFullTimelineSegments([], params, WIDTH, HEIGHT, DURATION, framesDir, { frameRate: info.frameRate });

// Inside each entrance, the export samples ON the 30 fps grid.
const offGrid = layers.text.filter((s) => (s.start > 1.0 && s.start < 1.3) || (s.start > 0.5 && s.start < 0.75))
  .filter((s) => Math.abs(s.start * FPS - Math.round(s.start * FPS)) > 1e-6);
assert.deepStrictEqual(offGrid.map((s) => s.start), [], 'every sample inside an entrance sits on a frame');

const out = path.join(work, 'out.mp4');
await compositeGraphicsCaptionTrack(src, layers.captions, out, {
  duration: DURATION, canvasWidth: WIDTH, canvasHeight: HEIGHT, frameRate: info.frameRate,
  textBlendMode: getASSStyleFromConfig(params).textBlendMode,
  manualCaptionSegments: layers.manualCaptions, textElementSegments: layers.text
});

async function exportedFrame(k) {
  const raw = path.join(work, `f-${k}.rgb`);
  // An accurate seek returns the first frame at or after the time.
  await run(['-y', '-ss', String(Math.max(0, k / FPS - 0.004)), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  return fs.readFileSync(raw);
}
const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext('2d');
function referenceFrame(t) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  paintFrameBackground(ctx, resolveInterludeBackground(card), WIDTH, HEIGHT);
  const p = resolveTextElementParams(params, card, t);
  drawCaptionFrameForExport(ctx, { canvasWidth: WIDTH, canvasHeight: HEIGHT, activePhrase: textElementToPhrase(card), currentTime: t, cssConfig: getCSSPreviewFromConfig(p), params: p, createOffscreenCanvas: (w, h) => createCanvas(w, h), clearCanvas: false });
  const rgba = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return rgb;
}
/** Dark (text) pixels in a column band: count and vertical centroid. */
function darkIn(buf, x0, x1) {
  let n = 0; let sy = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * WIDTH + x) * 3;
      if (buf[i] < 110 && buf[i + 1] < 110 && buf[i + 2] < 110) { n++; sy += y; }
    }
  }
  return { n, cy: n ? sy / n : null };
}

// The words' columns, where the renderer's own measure pass lays them out.
const restParams = resolveTextElementParams(params, card, 2.4);
const measured = measureSentenceFrame(ctx, { canvasWidth: WIDTH, canvasHeight: HEIGHT, activePhrase: textElementToPhrase(card), currentTime: 2.4, cssConfig: getCSSPreviewFromConfig(restParams), params: restParams });
const cols = measured.words.map((w) => [Math.max(0, Math.floor(w.x) - 2), Math.min(WIDTH, Math.ceil(w.x + w.width) + 2)]);
assert.strictEqual(new Set(measured.words.map((w) => Math.round(w.y))).size, 1, 'the three words sit on one line');

let compared = 0;
let worstDy = 0;
const rows = [];
for (let k = Math.round(0.5 * FPS); k <= Math.round(1.4 * FPS); k++) {
  const t = k / FPS;
  const exp = await exportedFrame(k);
  const ref = referenceFrame(t);
  cols.forEach(([x0, x1], w) => {
    const a = darkIn(exp, x0, x1);
    const b = darkIn(ref, x0, x1);
    if (b.n === 0) {
      assert.ok(a.n < 15, `frame ${k}: word ${w} is not drawn in the preview, nor in the file (${a.n} dark px)`);
    } else {
      // A word fading in is faint grey for a frame or two, and the encoder
      // moves faint pixels across the dark threshold — so those frames get
      // an absolute allowance. Where the word is gets checked whenever
      // there is enough of it to locate.
      assert.ok(Math.abs(a.n - b.n) <= Math.max(b.n * 0.25, 30), `frame ${k}: word ${w} has as much ink as the preview (${a.n} vs ${b.n})`);
      if (b.n >= 60) {
        const dy = Math.abs(a.cy - b.cy);
        worstDy = Math.max(worstDy, dy);
        assert.ok(dy < 1.0, `frame ${k} (${t.toFixed(3)}s): word ${w} is where the preview draws it (off by ${dy.toFixed(2)}px)`);
      }
    }
    compared++;
  });
  if (k % 3 === 0) rows.push(`${t.toFixed(2)}s ${cols.map((c, w) => { const d = darkIn(exp, c[0], c[1]); return `w${w}:${d.n}`; }).join(' ')}`);
}
console.log('  ' + rows.join('\n  '));
console.log(`✓ ${compared} word-frames compared, worst vertical difference ${worstDy.toFixed(2)}px`);

// "OFFICE" (spoken at 1.0) is absent before 1.0 and present after; "HACKS"
// (together) is present from the card's start although said at 1.5.
const before = await exportedFrame(Math.round(0.9 * FPS));
assert.ok(darkIn(before, ...cols[1]).n < 15, '"OFFICE" is not in the file before it is said');
assert.ok(darkIn(before, ...cols[2]).n > 100, '"HACKS", entering together, is in the file from the card\'s start');
console.log('✓ One by one and together, as the timing says');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All V1.1 animation checks passed ---');
