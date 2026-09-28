/**
 * End-to-end export verification for manually placed captions / text overlays
 * (shared/textElement.js) — a REAL ffmpeg render, sampled pixel by pixel.
 *
 * Why this exists: a text overlay used to be flattened into the caption
 * rasters, so the caption's Text Blend Mode was applied to it as well. On a
 * project using 'difference' for the transparent-caption look, an overlay the
 * user had deliberately coloured white came out showing the blended video
 * underneath instead. It looked right in the preview the whole time, because
 * the preview has always had two canvases and only ever applied
 * mix-blend-mode to the captions one — so nothing short of inspecting a real
 * exported frame could have caught it. Hence this file: the frame generator's
 * own PNGs were always correct; the bug lived entirely in the ffmpeg graph.
 *
 * Text elements are now their own composited layer (see
 * buildTextElementSegments + graphicsCompositor's second track), always
 * alpha-over, never blended.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { createCanvas } from '@napi-rs/canvas';
import { buildFullTimelineSegments } from './utils/graphicsFrameGenerator.js';
import { compositeGraphicsCaptionTrack } from './utils/graphicsCompositor.js';
import { getASSStyleFromConfig } from '../shared/captionConfig.js';

console.log('--- Text Overlay Export Verification (real ffmpeg render) ---');

const WIDTH = 360;
const HEIGHT = 640;
const DURATION = 2;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-textoverlay-'));

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-2000)))));
  });
}

/** A flat mid-grey source clip — a known, uniform base makes a blend obvious. */
async function makeSourceVideo(file) {
  await run(['-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=${WIDTH}x${HEIGHT}:d=${DURATION}:r=25`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

/** Decodes one frame of `file` at `time` into raw RGB and returns a pixel reader. */
async function readFrame(file, time) {
  const raw = path.join(work, `frame-${Math.round(time * 1000)}.rawvideo`);
  await run(['-y', '-ss', String(time), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = fs.readFileSync(raw);
  assert.strictEqual(buf.length, WIDTH * HEIGHT * 3, 'decoded frame size must match the source dimensions');
  return {
    at(x, y) {
      const i = (y * WIDTH + x) * 3;
      return [buf[i], buf[i + 1], buf[i + 2]];
    },
    /** How many pixels in the frame are near-white — i.e. how much unblended white text survived. */
    countNearWhite() {
      let n = 0;
      for (let i = 0; i < buf.length; i += 3) {
        if (buf[i] > 215 && buf[i + 1] > 215 && buf[i + 2] > 215) n++;
      }
      return n;
    },
    /** Pixels that are neither the grey base nor near-white — what a blend produces here. */
    countOffBase() {
      let n = 0;
      for (let i = 0; i < buf.length; i += 3) {
        const nearBase = Math.abs(buf[i] - 128) < 12 && Math.abs(buf[i + 1] - 128) < 12 && Math.abs(buf[i + 2] - 128) < 12;
        const nearWhite = buf[i] > 215 && buf[i + 1] > 215 && buf[i + 2] > 215;
        if (!nearBase && !nearWhite) n++;
      }
      return n;
    }
  };
}

function baseParams(extra = {}) {
  return {
    preset: 'caps-white',
    fontFamily: 'Poppins',
    fontSize: '20',
    position: 'bottom',
    captionMode: 'sentence',
    animationMode: 'karaoke',
    inactiveWordColor: '#FFFF00',
    activeWordColor: '#FFFF00',
    ...extra
  };
}

const phrases = [{
  start: 0, end: DURATION, breakAfterIndices: [],
  words: [{ word: 'CAPTION', start: 0, end: DURATION, wordIndex: 0 }]
}];

/** One white overlay, dead centre, for the whole clip. */
function whiteOverlay() {
  return [{
    id: 'txt_test', kind: 'overlay', start: 0, end: DURATION, text: 'OVERLAY', enabled: true,
    keyframes: [],
    style: {
      position: 'manual', customPosX: 50, customPosY: 50,
      fontSize: 34, inactiveWordColor: '#FFFFFF', activeWordColor: '#FFFFFF',
      outlineSize: 0, shadowMode: 'none'
    }
  }];
}

async function render(params, label) {
  const src = path.join(work, `src-${label}.mp4`);
  const out = path.join(work, `out-${label}.mp4`);
  const frames = path.join(work, `frames-${label}`);
  fs.mkdirSync(frames, { recursive: true });
  await makeSourceVideo(src);

  const { captions, manualCaptions, text } = buildFullTimelineSegments(phrases, params, WIDTH, HEIGHT, DURATION, frames);
  await compositeGraphicsCaptionTrack(src, captions, out, {
    duration: DURATION,
    canvasWidth: WIDTH,
    canvasHeight: HEIGHT,
    textBlendMode: getASSStyleFromConfig(params).textBlendMode,
    manualCaptionSegments: manualCaptions,
    textElementSegments: text
  });
  return { out, captions, manualCaptions, text };
}

// ---------------------------------------------------------------------------
// 1. THE REPORTED BUG: a blend-mode project must not drag the overlay into it
// ---------------------------------------------------------------------------
console.log('\n[Test 1] A caption blend mode does not reach a text overlay');
const blended = await render(
  baseParams({ textBlendMode: 'difference', textElements: whiteOverlay() }),
  'blend'
);
assert.ok(blended.text.length > 0, 'a project with a text element must produce a second layer');
console.log(`  ${blended.captions.length} caption segments + ${blended.text.length} text segments`);

const blendFrame = await readFrame(blended.out, DURATION / 2);
const whiteCount = blendFrame.countNearWhite();
const offBase = blendFrame.countOffBase();
console.log(`  near-white pixels (the overlay): ${whiteCount}, blended pixels (the caption): ${offBase}`);

// The overlay kept its own white. Before the fix these pixels came out as
// 0x808080 differenced against white — mid-grey inverted, nowhere near white.
assert.ok(whiteCount > 150, `A white overlay must stay white through a 'difference' caption export — only ${whiteCount} near-white pixels survived`);
// ...and the CAPTION is still genuinely blended, so the fix didn't just
// disable the feature.
assert.ok(offBase > 100, `The caption itself must still be blended (found only ${offBase} blended pixels)`);
console.log('✓ The overlay keeps its own colour while the caption still blends');

// ---------------------------------------------------------------------------
// 2. The same overlay renders identically with no caption blend in play
// ---------------------------------------------------------------------------
console.log('\n[Test 2] The overlay renders the same with the blend mode off');
const plain = await render(baseParams({ textElements: whiteOverlay() }), 'plain');
const plainFrame = await readFrame(plain.out, DURATION / 2);
const plainWhite = plainFrame.countNearWhite();
console.log(`  near-white pixels: ${plainWhite} (blended project: ${whiteCount})`);
// Allowing a little slack for the extra rgb->yuv round trip the blend branch
// puts the frame through; the point is that the overlay is the same text at
// the same size in both, not corrupted in one of them.
assert.ok(Math.abs(plainWhite - whiteCount) < plainWhite * 0.2,
  `The overlay must render the same whether or not the caption blends (${plainWhite} vs ${whiteCount})`);
console.log('✓ Overlay rendering is independent of the caption layer');

// ---------------------------------------------------------------------------
// 3. No text elements => no second layer at all
// ---------------------------------------------------------------------------
console.log('\n[Test 3] A project with no text elements adds no second layer');
const framesOnly = path.join(work, 'frames-none');
fs.mkdirSync(framesOnly, { recursive: true });
const noneLayers = buildFullTimelineSegments(phrases, baseParams(), WIDTH, HEIGHT, DURATION, framesOnly);
assert.deepStrictEqual(noneLayers.text, [], 'text layer must be empty when the project has no text elements');
assert.ok(noneLayers.captions.length > 0, 'caption segments must still be produced');
console.log(`✓ ${noneLayers.captions.length} caption segments, 0 text segments — the single-track graph is unchanged`);

// ---------------------------------------------------------------------------
// 4. Overlay text elements are drawn OVER captions, not under
// ---------------------------------------------------------------------------
console.log('\n[Test 4] Overlays composite above captions');
const stacked = whiteOverlay();
// Park it exactly where the bottom-anchored caption sits, so the two overlap.
stacked[0].style.customPosY = 88;
const over = await render(baseParams({ textElements: stacked }), 'over');
const overFrame = await readFrame(over.out, DURATION / 2);
assert.ok(overFrame.countNearWhite() > 150,
  'A white overlay sitting on top of a yellow caption must still read as white');
console.log('✓ The overlay is on top');

// ---------------------------------------------------------------------------
// 5. Consecutive overlays each disappear at their OWN end
// ---------------------------------------------------------------------------
console.log('\n[Test 5] Back-to-back overlays disappear when they should');
// Reported against a real export of "Five home office hacks", timed word by
// word: "five" and "home" went away, but "office" and "hacks" stayed on
// screen until the video ended.
//
// Cause: the slicer asked getActiveTextElements "what is visible AT this
// segment's start time", and that test was inclusive at the end
// (`time <= el.end`). An element whose end landed exactly on a cut counted
// as still visible and was then drawn for that segment's whole span — so
// every element bled one segment past its end, and for the LAST elements on
// the timeline that segment runs to the end of the video. Two elements
// sharing an end time (adjacent words very often do) both got stuck.
const words = [
  { id: 'w1', kind: 'overlay', start: 0.0, end: 0.5, text: 'FIVE', enabled: true, keyframes: [], style: { position: 'manual', customPosX: 50, customPosY: 50, fontSize: 30 } },
  { id: 'w2', kind: 'overlay', start: 0.5, end: 1.0, text: 'HOME', enabled: true, keyframes: [], style: { position: 'manual', customPosX: 50, customPosY: 50, fontSize: 30 } },
  // Same end time, which is what made TWO of them stick in the report.
  { id: 'w3', kind: 'overlay', start: 1.0, end: 1.5, text: 'OFFICE', enabled: true, keyframes: [], style: { position: 'manual', customPosX: 35, customPosY: 50, fontSize: 30 } },
  { id: 'w4', kind: 'overlay', start: 1.0, end: 1.5, text: 'HACKS', enabled: true, keyframes: [], style: { position: 'manual', customPosX: 65, customPosY: 50, fontSize: 30 } }
];
const wordFrames = path.join(work, 'frames-words');
fs.mkdirSync(wordFrames, { recursive: true });
const wordLayers = buildFullTimelineSegments(
  phrases, baseParams({ textElements: words }), WIDTH, HEIGHT, DURATION, wordFrames
);

const tail = wordLayers.text[wordLayers.text.length - 1];
console.log(`  last text segment: [${tail.start.toFixed(3)}, ${tail.end.toFixed(3)}) -> ${path.basename(tail.file)}`);
assert.ok(tail.start >= 1.5 - 1e-9, 'the final text segment must begin once the last element has ended');

// The honest check is the rendered pixels, not the segment list: every
// segment from the last element's end onward must be genuinely empty.
const { loadImage } = await import('@napi-rs/canvas');
const inkOf = async (file) => {
  const img = await loadImage(file);
  const c = createCanvas(WIDTH, HEIGHT);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) n++;
  return n;
};

for (const segment of wordLayers.text) {
  const ink = await inkOf(segment.file);
  const shouldBeEmpty = segment.start >= 1.5 - 1e-9;
  console.log(`  [${segment.start.toFixed(3)}, ${segment.end.toFixed(3)})  ink=${ink}`);
  if (shouldBeEmpty) {
    assert.strictEqual(ink, 0, `Nothing may still be drawn at ${segment.start.toFixed(3)}s — every element ended by 1.5s`);
  } else {
    assert.ok(ink > 0, `Text is expected on screen at ${segment.start.toFixed(3)}s but the frame is empty`);
  }
}
console.log('✓ Each overlay ends exactly when it should; none survive to the end of the video');

// ---------------------------------------------------------------------------
// 6. A manual CAPTION blends with the captions; an OVERLAY never does
// ---------------------------------------------------------------------------
console.log('\n[Test 6] kind decides which layer, and therefore whether it blends');
// The two kinds want opposite compositing, and this is the one place that
// difference is observable. A manual caption exists to be indistinguishable
// from the transcript's own captions, so on a blend-mode project it has to
// blend like them — compositing it alpha-over would leave it looking plainly
// different from the captions around it. An overlay is the reverse: it is
// artwork the user coloured deliberately and must never be dragged through
// the caption's blend (that was Test 1's whole bug).
function whiteElement(kind) {
  return {
    id: `el_${kind}`, kind, start: 0, end: DURATION, text: 'SAMPLE', enabled: true, keyframes: [],
    style: {
      position: 'manual', customPosX: 50, customPosY: 50,
      fontSize: 34, inactiveWordColor: '#FFFFFF', activeWordColor: '#FFFFFF',
      outlineSize: 0, shadowMode: 'none'
    }
  };
}

const asCaption = await render(
  baseParams({ textBlendMode: 'difference', textElements: [whiteElement('caption')] }),
  'kind-caption'
);
const asOverlay = await render(
  baseParams({ textBlendMode: 'difference', textElements: [whiteElement('overlay')] }),
  'kind-overlay'
);

console.log(`  manual caption -> ${asCaption.manualCaptions.length} manual-caption segments, ${asCaption.text.length} text segments`);
console.log(`  overlay        -> ${asOverlay.manualCaptions.length} manual-caption segments, ${asOverlay.text.length} text segments`);
assert.ok(asCaption.manualCaptions.length > 0 && asCaption.text.length === 0,
  'a kind:caption element belongs to the manual-caption layer only');
assert.ok(asOverlay.text.length > 0 && asOverlay.manualCaptions.length === 0,
  'a kind:overlay element belongs to the text layer only');

const captionWhite = (await readFrame(asCaption.out, DURATION / 2)).countNearWhite();
const overlayWhite = (await readFrame(asOverlay.out, DURATION / 2)).countNearWhite();
console.log(`  near-white pixels — as a caption: ${captionWhite}, as an overlay: ${overlayWhite}`);

// Identical text, identical style, identical position — the ONLY difference
// is `kind`, and it decides whether the blend reaches it.
assert.ok(overlayWhite > 150, `An overlay must keep its own white (got ${overlayWhite})`);
assert.ok(captionWhite < overlayWhite * 0.25,
  `A manual caption must blend like the captions it belongs with, not stay opaque white ` +
  `(caption ${captionWhite} vs overlay ${overlayWhite})`);
console.log('✓ kind alone decides the layer, and the layer decides the blend');

fs.rmSync(work, { recursive: true, force: true });
console.log('\n--- All text-overlay export checks passed ---');
