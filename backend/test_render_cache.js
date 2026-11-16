/**
 * BACKGROUND RENDERING (renderCache.js) on a short cut of a real video:
 *
 *  1. the chunked export matches the one-pass export (same length, same frame
 *     count, near-identical pictures — SSIM — and the sound is there);
 *  2. changing one word near the end re-renders only the chunk it is in;
 *  3. an export of an unchanged project renders nothing — it only joins.
 *
 *   node backend/test_render_cache.js <video> [seconds=25] [startAt=60] [hd|original]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { tryRenderCaptionsWithGraphics } from './utils/graphicsExport.js';
import { renderFromChunks, requestPrerender, prerenderStatus } from './utils/renderCache.js';

const [, , src, secondsArg = '25', startArg = '60', exportSize = 'hd'] = process.argv;
if (!src || !fs.existsSync(src)) {
  console.error('usage: node backend/test_render_cache.js <video> [seconds=25] [startAt=60] [hd|original]');
  process.exit(1);
}
const seconds = Number(secondsArg);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-cache-'));
const cut = path.join(work, `cut${path.extname(src)}`);
const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-ss', startArg, '-i', src, '-t', String(seconds), '-c', 'copy', '-map_metadata', '0', cut]);
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }

const said = 'so this is how we put a word behind a person and it just works on every phone the captions follow the speech and the sound effects land on the beat';
const words = [];
for (let t = 0.2, i = 0; t < seconds - 0.4; i++) {
  const w = said.split(' ')[i % said.split(' ').length];
  words.push({ word: w, start: +t.toFixed(2), end: +(t + 0.32).toFixed(2), isKeyword: w === 'behind' || w === 'works' });
  t += 0.38;
}
const styles = {
  currentPreset: 'bold-yellow', preset: 'bold-yellow', fontFamily: 'Montserrat', fontSize: 14,
  captionMode: 'sentence', animationMode: 'karaoke', textCase: 'uppercase', position: 'bottom',
  marginV: 300, customPosX: 50, customPosY: 85, enableKeywordHighlighting: true, keywordColor: '#EF4444',
  wordSpacing: 4, lineHeight: 1.2, popScale: 118, shadowMode: 'individual', textOpacity: 100, keywordOpacity: 100,
  captionAnimationType: 'none', scaleOverflow: 'stack'
};

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures += 1; };

function probe(file) {
  const out = spawnSync(ffmpegPath, ['-i', file, '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const frames = Number((out.match(/frame=\s*(\d+)/g) || []).pop()?.match(/\d+/)[0] || 0);
  const dur = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return { frames, duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]) : 0, audio: /Stream #\d+:\d+.*Audio/.test(out) };
}
function ssim(a, b) {
  const out = spawnSync(ffmpegPath, ['-i', a, '-i', b, '-lavfi', '[0:v][1:v]ssim', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = out.match(/All:([\d.]+)/);
  return m ? Number(m[1]) : 0;
}
const chunkFiles = (dir) => fs.readdirSync(dir).filter((f) => /^chunk-/.test(f)).sort();

const baseName = 'job_cachetest';
const dir = path.join(work, 'cache');

// 1. The one-pass export, the reference.
let t0 = Date.now();
const onePass = path.join(work, 'one-pass.mp4');
check(await tryRenderCaptionsWithGraphics(cut, words, styles, onePass, path.join(work, 'frames'), { exportSize }) === true, 'one-pass export renders');
console.log(`  one pass: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 2. In the background, then exported: the background did the work, the export only joins.
t0 = Date.now();
requestPrerender(baseName, { videoPath: cut, words, styles, exportSize, dir });
await new Promise((res) => { const iv = setInterval(() => { const s = prerenderStatus(baseName); if (s && s.upToDate && !s.rendering) { clearInterval(iv); res(); } }, 200); });
console.log(`  background render: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${JSON.stringify(prerenderStatus(baseName))}`);
const before = chunkFiles(dir);
t0 = Date.now();
const chunked = path.join(work, 'chunked.mp4');
check(await renderFromChunks(baseName, { videoPath: cut, words, styles, exportSize, dir, outputPath: chunked }) === true, 'export from the cache');
const joinSeconds = (Date.now() - t0) / 1000;
console.log(`  export after the background render: ${joinSeconds.toFixed(1)}s`);
check(JSON.stringify(chunkFiles(dir)) === JSON.stringify(before), 'an unchanged project renders no chunk at export');

const a = probe(onePass);
const b = probe(chunked);
console.log(`  one pass ${JSON.stringify(a)}  chunked ${JSON.stringify(b)}`);
check(Math.abs(a.duration - b.duration) < 0.1, 'same length');
check(Math.abs(a.frames - b.frames) <= 1, 'same number of frames');
check(b.audio, 'the sound is there');
const similarity = ssim(onePass, chunked);
console.log(`  SSIM one pass vs chunked: ${similarity}`);
check(similarity > 0.97, 'the chunked picture matches the one-pass picture');

// 3. One word near the end changes: only its chunk renders again.
const edited = words.map((w) => (w.start > seconds - 4 && w.start < seconds - 3 ? { ...w, word: 'CHANGED' } : w));
check(edited.some((w) => w.word === 'CHANGED'), 'a word near the end was edited');
t0 = Date.now();
const chunked2 = path.join(work, 'chunked2.mp4');
check(await renderFromChunks(baseName, { videoPath: cut, words: edited, styles, exportSize, dir, outputPath: chunked2 }) === true, 'export after one edit');
console.log(`  export after one edit: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const after = chunkFiles(dir);
const changed = after.filter((f) => !before.includes(f));
console.log(`  chunks re-rendered: ${changed.join(', ') || 'none'} of ${after.length}`);
check(changed.length === 1 && changed[0] === after[after.length - 1], 'only the last chunk re-rendered');

// 4. A richer project: the video zooms and turns on keyframes across every
// chunk edge, a text overlay crosses an edge, and the video's own sound is
// turned down (so the sound is MIXED, not copied). Chunked must match one pass
// frame for frame — a keyframe or an overlay off by a frame at an edge shows
// as a dip here.
const rich = {
  ...styles,
  videoTransform: { keyframes: [
    { t: 2, easing: 'linear', values: { scale: 1, rotation: 0 } },
    { t: seconds - 3, easing: 'linear', values: { scale: 1.4, rotation: 15 } }
  ] },
  textElements: [{
    id: 'txt_edge', kind: 'overlay', start: 7, end: 13, text: 'ACROSS THE EDGE', enabled: true, keyframes: [],
    style: { position: 'manual', customPosX: 50, customPosY: 30, fontSize: 30, inactiveWordColor: '#FFFFFF', activeWordColor: '#FFFFFF', outlineSize: 0, shadowMode: 'none' }
  }],
  audio: { soundEvents: [], audioTracks: [], video: { volume: 0.5 } }
};
const richOne = path.join(work, 'rich-one-pass.mp4');
check(await tryRenderCaptionsWithGraphics(cut, words, rich, richOne, path.join(work, 'frames-rich'), { exportSize }) === true, 'rich: one-pass export renders');
const richChunked = path.join(work, 'rich-chunked.mp4');
check(await renderFromChunks('job_cachetest_rich', { videoPath: cut, words, styles: rich, exportSize, dir: path.join(work, 'cache-rich'), outputPath: richChunked }) === true, 'rich: export from chunks');
const ra = probe(richOne);
const rb = probe(richChunked);
console.log(`  rich one pass ${JSON.stringify(ra)}  chunked ${JSON.stringify(rb)}`);
check(Math.abs(ra.frames - rb.frames) <= 1 && rb.audio, 'rich: same frames, sound there');
// Run inside the work folder: a relative stats file keeps the drive colon out of the filter.
spawnSync(ffmpegPath, ['-i', richOne, '-i', richChunked, '-lavfi', '[0:v][1:v]ssim=stats_file=rich-ssim.log', '-f', 'null', '-'], { cwd: work });
const perFrame = fs.readFileSync(path.join(work, 'rich-ssim.log'), 'utf8').trim().split('\n').map((l) => Number(l.match(/All:([\d.]+)/)?.[1] || 0));
const worst = perFrame.reduce((m, v, i) => (v < m.v ? { v, i } : m), { v: 1, i: -1 });
console.log(`  rich: ${perFrame.length} frames compared, worst SSIM ${worst.v} at frame ${worst.i}`);
check(perFrame.length > 0 && worst.v > 0.95, 'rich: every frame matches the one-pass export');

console.log(failures ? `\n${failures} FAILED  (files in ${work})` : `\nALL PASS  (files in ${work})`);
process.exit(failures ? 1 : 0);
