/**
 * End-to-end export verification for CINEMATIC TEXT INTERLUDES
 * (shared/textElement.js, kind 'interlude') — a REAL ffmpeg render of a
 * moving test pattern with a tone, sampled frame by frame and sample by
 * sample.
 *
 * What an interlude must do in the exported file, and what this checks:
 *   - the picture is REPLACED for exactly [start, end): its background fills
 *     the whole frame, captions (transcript and manual) are covered, text
 *     overlays stay on top;
 *   - the video comes back afterwards;
 *   - the audio is untouched: with no sound effects the source audio stream
 *     is copied through bit for bit, interlude or not;
 *   - overlapping interludes resolve to the latest-starting one;
 *   - an interlude with no words still renders its background;
 *   - a video with no speech still gets its interludes (the graphics pipeline
 *     is the only one that can draw them).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { tryRenderCaptionsWithGraphics } from './utils/graphicsExport.js';
import { getASSStyleFromConfig } from '../shared/captionConfig.js';
import { createInterlude, getActiveTextElements, orderForCompositing, textElementFromCaption } from '../shared/textElement.js';

console.log('--- Cinematic Text Interlude Export Verification (real ffmpeg render) ---');

const WIDTH = 360;
const HEIGHT = 640;
const DURATION = 4;
const FPS = 25;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-interlude-'));

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
  });
}

/** A moving, colourful test pattern plus a 440 Hz tone — nothing about it is uniform, so a full-frame fill is unmistakable. */
async function makeSourceVideo(file) {
  await run(['-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=${FPS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}

async function readFrame(file, time) {
  const raw = path.join(work, `frame-${path.basename(file)}-${Math.round(time * 1000)}.rawvideo`);
  await run(['-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  assert.strictEqual(buf.length, WIDTH * HEIGHT * 3, 'decoded frame size must match the source dimensions');
  const px = (x, y) => { const i = (y * WIDTH + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const count = (pred, box = [0, 0, WIDTH, HEIGHT]) => {
    let n = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) if (pred(px(x, y))) n++;
    return n;
  };
  return { px, count };
}

const near = (c, [r, g, b], tol = 18) => Math.abs(c[0] - r) < tol && Math.abs(c[1] - g) < tol && Math.abs(c[2] - b) < tol;
const isWhite = (c) => near(c, [255, 255, 255]);
const isBlack = (c) => near(c, [0, 0, 0]);
const isRed = (c) => c[0] > 180 && c[1] < 80 && c[2] < 80;

/** The four corner patches — a full-frame background reaches them; nothing else does. */
function cornersAre(frame, pred) {
  const patches = [[2, 2], [WIDTH - 12, 2], [2, HEIGHT - 12], [WIDTH - 12, HEIGHT - 12]];
  return patches.every(([x0, y0]) => frame.count(pred, [x0, y0, x0 + 10, y0 + 10]) === 100);
}

async function decodeAudio(file) {
  const raw = path.join(work, `audio-${path.basename(file)}.f32`);
  await run(['-y', '-i', file, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', raw]);
  return new Float32Array(fs.readFileSync(raw).buffer.slice(0));
}

const baseParams = (extra = {}) => ({
  preset: 'caps-white', fontFamily: 'Poppins', fontSize: '20', position: 'bottom',
  captionMode: 'sentence', animationMode: 'karaoke',
  inactiveWordColor: '#FFFF00', activeWordColor: '#FFFF00',
  ...extra
});
const phrases = [{ start: 0, end: DURATION, breakAfterIndices: [], words: [{ word: 'CAPTION', start: 0, end: DURATION, wordIndex: 0 }] }];

// Interlude A: white, black text, [1.0, 2.0). Interlude B: black, white text,
// [2.6, 3.4). A red overlay spans A; a manual caption spans A too (it must be
// covered). C and D overlap at the end: D starts later, so D wins.
const A = createInterlude({ id: 'intl_a', start: 1.0, end: 2.0, text: 'THIS CHANGED\nEVERYTHING.', style: { fontSize: 26 } });
const B = createInterlude({ id: 'intl_b', start: 2.6, end: 3.4, text: 'NEXT', background: { color: '#000000' }, style: { activeWordColor: '#FFFFFF', inactiveWordColor: '#FFFFFF', captionAnimationType: 'none' } });
const C = createInterlude({ id: 'intl_c', start: 3.5, end: 3.96, text: '', background: { color: '#FFFFFF' } });
const D = createInterlude({ id: 'intl_d', start: 3.6, end: 3.96, text: '', background: { color: '#000000' } });
const overlay = {
  id: 'txt_red', kind: 'overlay', start: 1.0, end: 2.0, text: 'OVERLAY', enabled: true, keyframes: [],
  style: { position: 'manual', customPosX: 50, customPosY: 15, fontSize: 30, inactiveWordColor: '#FF0000', activeWordColor: '#FF0000', outlineSize: 0, shadowMode: 'none' }
};
const manualCaption = {
  id: 'mcap_x', kind: 'caption', start: 1.0, end: 2.0, text: 'MANUAL', enabled: true, keyframes: [],
  style: { position: 'manual', customPosX: 50, customPosY: 70, fontSize: 30, inactiveWordColor: '#FF0000', activeWordColor: '#FF0000' }
};

// ---------------------------------------------------------------------------
console.log('\n[Test 1] Draw order and overlap rule are defined, shared, and tested directly');
const at15 = orderForCompositing(getActiveTextElements([A, overlay, manualCaption], 1.5)).map((e) => e.id);
assert.deepStrictEqual(at15, ['mcap_x', 'intl_a', 'txt_red'], 'manual caption, then the interlude, then overlays');
const at37 = orderForCompositing(getActiveTextElements([C, D], 3.7)).map((e) => e.id);
assert.deepStrictEqual(at37, ['intl_d'], 'overlapping interludes: only the latest-starting one draws');
assert.deepStrictEqual(getActiveTextElements([C], 3.6).map((e) => e.id), ['intl_c'], 'an interlude with no words is still on screen');
// Half-open at both edges.
assert.strictEqual(getActiveTextElements([A], 0.9999).length, 0, 'just before start: not active');
assert.strictEqual(getActiveTextElements([A], 1.0).length, 1, 'exactly at start: active');
assert.strictEqual(getActiveTextElements([A], 1.9999).length, 1, 'just before end: active');
assert.strictEqual(getActiveTextElements([A], 2.0).length, 0, 'exactly at end: not active');
console.log('✓ [start, end) half-open; captions under, overlays over, latest interlude wins');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] The segment stream cuts EXACTLY at the interlude edges, and its frames are opaque');
const src = path.join(work, 'src.mp4');
await makeSourceVideo(src);
const frames = path.join(work, 'frames');
fs.mkdirSync(frames, { recursive: true });
const params = baseParams({ textElements: [A, B, C, D, overlay, manualCaption] });
const layers = buildFullTimelineSegments(phrases, params, WIDTH, HEIGHT, DURATION, frames);
const cutAt = (t) => layers.text.some((s) => Math.abs(s.start - t) < 1e-9);
[1.0, 2.0, 2.6, 3.4, 3.5, 3.6].forEach((t) => assert.ok(cutAt(t), `a text-layer segment must start exactly at ${t}s`));
console.log(`✓ ${layers.text.length} text segments, cut at every interlude edge`);

// ---------------------------------------------------------------------------
console.log('\n[Test 3] A real render: picture replaced, captions covered, overlay on top, video returns');
const out = path.join(work, 'out.mp4');
await compositeGraphicsCaptionTrack(src, layers.captions, out, {
  duration: DURATION, canvasWidth: WIDTH, canvasHeight: HEIGHT,
  textBlendMode: getASSStyleFromConfig(params).textBlendMode,
  manualCaptionSegments: layers.manualCaptions,
  textElementSegments: layers.text
});

const before = await readFrame(out, 0.52);
assert.ok(!cornersAre(before, isWhite), 'before the interlude the video is on screen');

const during = await readFrame(out, 1.52);
assert.ok(cornersAre(during, isWhite), 'during interlude A every corner is its white background');
const darkText = during.count((c) => c[0] < 70 && c[1] < 70 && c[2] < 70, [0, 200, WIDTH, 440]);
assert.ok(darkText > 300, `interlude A's black text is drawn (${darkText} dark px in the middle band)`);
const redTop = during.count(isRed, [0, 40, WIDTH, 160]);
assert.ok(redTop > 150, `the red overlay is drawn ON TOP of the interlude (${redTop} red px)`);
const redCaptionBand = during.count(isRed, [0, 400, WIDTH, 520]);
assert.strictEqual(redCaptionBand, 0, 'the red MANUAL caption is covered by the interlude');
const yellowCaption = during.count((c) => c[0] > 200 && c[1] > 200 && c[2] < 90);
assert.strictEqual(yellowCaption, 0, 'the yellow transcript caption is covered by the interlude');
console.log(`  dark text px ${darkText}, red overlay px ${redTop}, covered caption px ${redCaptionBand + yellowCaption}`);

const after = await readFrame(out, 2.28);
assert.ok(!cornersAre(after, isWhite) && !cornersAre(after, isBlack), 'after the interlude the video is back');
const afterCaption = after.count((c) => c[0] > 200 && c[1] > 200 && c[2] < 90);
assert.ok(afterCaption > 50, 'and so is the transcript caption');

const bFrame = await readFrame(out, 3.0);
assert.ok(cornersAre(bFrame, isBlack), 'interlude B fills the frame with its black background');
assert.ok(bFrame.count(isWhite, [0, 200, WIDTH, 440]) > 150, "interlude B's white text is drawn");

const overlapFrame = await readFrame(out, 3.8);
assert.ok(cornersAre(overlapFrame, isBlack), 'where C and D overlap, the later one (D, black) is what shows');
const emptyFrame = await readFrame(out, 3.52);
assert.ok(cornersAre(emptyFrame, isWhite), 'an interlude with no words still shows its background');
console.log('✓ Replaced for its span, covered captions, overlay on top, video and captions return');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] Boundaries in the file: last video frame before, first interlude frame at start');
// 25 fps: frames at multiples of 0.04 s. 0.96 is the last frame before A's
// start, 1.00 the first inside; 1.96 the last inside, 2.00 the first after.
for (const [t, inside] of [[0.96, false], [1.0, true], [1.96, true], [2.0, false]]) {
  const f = await readFrame(out, t);
  assert.strictEqual(cornersAre(f, isWhite), inside, `frame at ${t}s must be ${inside ? 'the interlude' : 'the video'}`);
}
console.log('✓ Switches on the exact frame, both ways');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Audio is untouched: copied through bit for bit');
const srcAudio = await decodeAudio(src);
const outAudio = await decodeAudio(out);
const md5 = (a) => crypto.createHash('md5').update(Buffer.from(a.buffer)).digest('hex');
assert.strictEqual(outAudio.length, srcAudio.length, 'same number of audio samples');
assert.strictEqual(md5(outAudio), md5(srcAudio), 'the exported audio is identical to the source audio');
console.log(`✓ ${outAudio.length} samples, identical — the interlude never touches sound`);

// ---------------------------------------------------------------------------
console.log('\n[Test 6] A video with NO speech still gets its interludes');
const silentOut = path.join(work, 'no-words.mp4');
const ok = await tryRenderCaptionsWithGraphics(src, [], baseParams({ textElements: [A] }), silentOut, path.join(work, 'frames-nowords'));
assert.strictEqual(ok, true, 'with text elements present, an empty transcript does not force the fallback');
assert.ok(cornersAre(await readFrame(silentOut, 1.52), isWhite), 'and the interlude is in the file');
const noText = await tryRenderCaptionsWithGraphics(src, [], baseParams(), path.join(work, 'nothing.mp4'), path.join(work, 'frames-nothing'));
assert.strictEqual(noText, false, 'with nothing to draw at all, it still reports the fallback as before');
console.log('✓ Interludes render on a speechless video; an empty project still falls back');

// ---------------------------------------------------------------------------
console.log('\n[Test 7] A caption turned into text keeps its karaoke in the export, word by word');
{
  const spoken = 'changed everything so'.split(' ').map((w, i) => ({ word: w, start: 1 + i * 0.5, end: 1 + i * 0.5 + 0.45 }));
  const event = { id: 'cap_k', start: 1, end: 2.45, wordIndices: [0, 1, 2], breakAfterIndices: [] };
  const fromCaption = textElementFromCaption({ kind: 'overlay', event, words: spoken });
  const kDir = path.join(work, 'frames-karaoke');
  fs.mkdirSync(kDir, { recursive: true });
  const { text } = buildFullTimelineSegments([], baseParams({ preset: 'bold-yellow', activeWordColor: '#FFFF00', inactiveWordColor: '#FFFFFF', textElements: [fromCaption] }), WIDTH, HEIGHT, DURATION, kDir);
  // Cut at every spoken word edge, exactly as the caption stream is.
  [1.45, 1.5, 1.95, 2.0].forEach((t) => assert.ok(text.some((s) => Math.abs(s.start - t) < 1e-9), `a segment must start at the word edge ${t}s`));
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const highlightX = async (t) => {
    const seg = text.find((s) => s.start <= t && s.end > t);
    const img = await loadImage(seg.file);
    const c = createCanvas(WIDTH, HEIGHT); const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] < 90) { sum += (i / 4) % WIDTH; n++; }
    return n ? sum / n : null;
  };
  const [x1, x2, x3] = [await highlightX(1.1), await highlightX(1.6), await highlightX(2.1)];
  console.log(`  highlight centre: word 1 ${x1?.toFixed(0)}px, word 2 ${x2?.toFixed(0)}px, word 3 ${x3?.toFixed(0)}px`);
  assert.ok(x1 != null && x2 != null && x3 != null && x1 < x2 && x2 < x3, 'the highlight moves across the words in spoken order');
}
console.log('✓ Word timing reaches the file: the highlight follows the speech');

// ---------------------------------------------------------------------------
console.log('\n[Test 8] On a 29.97 fps video, every frame at an off-grid edge matches the preview rule');
{
  const ntscSrc = path.join(work, 'src-ntsc.mp4');
  await run(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=30000/1001`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ntscSrc]);
  const { getVideoInfo } = await import('./utils/graphicsCompositor.js');
  const info = await getVideoInfo(ntscSrc);
  assert.strictEqual(info.frameRate, '30000/1001', 'the frame rate is read exactly');
  const fps = 30000 / 1001;
  // Starts and ends chosen to fall BETWEEN frames, where the old fixed 20 ms
  // grid could land on the wrong side of a frame.
  const spans = [[0.513, 1.271], [1.9, 2.66], [3.047, 3.518]];
  const els = spans.map(([s, e], i) => createInterlude({ id: `intl_n${i}`, start: s, end: e, text: '' }));
  const nDir = path.join(work, 'frames-ntsc');
  fs.mkdirSync(nDir, { recursive: true });
  const layers2 = buildFullTimelineSegments(phrases, baseParams({ textElements: els }), WIDTH, HEIGHT, DURATION, nDir);
  const nOut = path.join(work, 'out-ntsc.mp4');
  await compositeGraphicsCaptionTrack(ntscSrc, layers2.captions, nOut, {
    duration: DURATION, canvasWidth: WIDTH, canvasHeight: HEIGHT, frameRate: info.frameRate,
    textBlendMode: getASSStyleFromConfig(baseParams()).textBlendMode,
    manualCaptionSegments: layers2.manualCaptions, textElementSegments: layers2.text
  });
  let checked = 0;
  for (const [s, e] of spans) {
    for (const edge of [s, e]) {
      const k0 = Math.floor(edge * fps);
      for (let k = k0 - 2; k <= k0 + 2; k++) {
        const t = k / fps;
        const expected = spans.some(([a, b]) => t >= a && t < b); // the preview's own rule
        // Accurate seek returns the first frame at or after the time, so ask just before it.
        const f = await readFrame(nOut, Math.max(0, t - 0.004));
        assert.strictEqual(cornersAre(f, isWhite), expected, `frame ${k} (${t.toFixed(4)}s) must ${expected ? '' : 'not '}be the interlude`);
        checked++;
      }
    }
  }
  console.log(`  ${checked} frames around ${spans.length * 2} off-grid edges`);
}
console.log('✓ Every frame agrees with the preview, on the video\'s own frame grid');

// ---------------------------------------------------------------------------
console.log('\n[Test 9] A render that fell back to the subtitle burn still gets its interludes');
{
  // Stands in for the ASS-burned file: the source video, captions and all.
  const { compositeTextElementsOnto } = await import('./utils/graphicsExport.js');
  const withText = path.join(work, 'fallback-with-text.mp4');
  const added = await compositeTextElementsOnto(src, baseParams({ textElements: [A, overlay] }), withText, path.join(work, 'frames-fallback'));
  assert.strictEqual(added, true, 'text elements were composited onto the fallback render');
  const f = await readFrame(withText, 1.52);
  assert.ok(cornersAre(f, isWhite), 'the interlude is in the file');
  assert.ok(f.count(isRed, [0, 40, WIDTH, 160]) > 150, 'and the overlay on top of it');
  assert.ok(!cornersAre(await readFrame(withText, 0.52), isWhite), 'the burned video is untouched outside it');
  const a1 = await decodeAudio(src), a2 = await decodeAudio(withText);
  assert.strictEqual(md5(a2), md5(a1), 'the already-mixed audio is copied through untouched');
  const none = await compositeTextElementsOnto(src, baseParams(), path.join(work, 'nothing2.mp4'), path.join(work, 'frames-none2'));
  assert.strictEqual(none, false, 'nothing to add: reports so, writes nothing');
  assert.ok(!fs.existsSync(path.join(work, 'nothing2.mp4')));
}
console.log('✓ Overlays and interludes survive a fallback render, audio untouched');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All cinematic text interlude export checks passed ---');
