/**
 * EXPORT BENCHMARK — the real export (tryRenderCaptionsWithGraphics) on a
 * short cut of a real video, with karaoke captions at a talking pace, timed
 * in its two halves: drawing the caption frames, and ffmpeg compositing.
 *
 *   node backend/bench_export.js <video> [seconds=20] [startAt=60] [original|hd]
 *
 * The cut is a stream copy (no re-encode), so the benchmark decodes exactly
 * what a full export of that video decodes — just less of it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { tryRenderCaptionsWithGraphics } from './utils/graphicsExport.js';

const [, , src, secondsArg = '20', startArg = '60', exportSize = 'original'] = process.argv;
if (!src || !fs.existsSync(src)) {
  console.error('usage: node backend/bench_export.js <video> [seconds=20] [startAt=60]');
  process.exit(1);
}
const seconds = Number(secondsArg);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-bench-'));
const cut = path.join(work, `cut${path.extname(src)}`);
const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-ss', startArg, '-i', src, '-t', String(seconds), '-c', 'copy', '-map_metadata', '0', cut]);
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }

// ~2.6 words a second, grouped by the app's own grouper (no caption events).
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

const out = path.join(work, 'out.mp4');
// Peak memory, sampled through the run — the old frame loop's failure mode.
let peak = 0;
const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100);
const t0 = Date.now();
const ok = await tryRenderCaptionsWithGraphics(cut, words, styles, out, path.join(work, 'frames'), { exportSize });
const total = (Date.now() - t0) / 1000;
clearInterval(sampler);
console.log(`peak memory ${(peak / 1e6).toFixed(0)} MB`);
console.log(`\nBENCH ${path.basename(src)} ${seconds}s: ${ok === true ? 'ok' : 'FAILED'} in ${total.toFixed(1)}s  (${(total / seconds).toFixed(2)}s per second of video)`);
if (ok === true) console.log(`output ${(fs.statSync(out).size / 1e6).toFixed(1)} MB → ${out}`);
