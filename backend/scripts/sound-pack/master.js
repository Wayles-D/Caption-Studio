/**
 * Mastering — identical for every pack sound, which is what makes it a pack.
 * See generate-sound-pack.js's header for the five stages. Moved verbatim.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import { SR, mulberry32, seedFor, scale, peakOf, fadeEdges } from './dsp.js';
import { PACK_DEFAULT_VOLUME, packFileName } from '../../../shared/soundPack.js';

export const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../public/sounds');
const PEAK_CEILING_DBTP = -1.0;

// ---- mastering ------------------------------------------------------------------

function dcBlock(a) {
  const o = new Float32Array(a.length);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < a.length; i++) { const y = a[i] - x1 + 0.9995 * y1; x1 = a[i]; y1 = y; o[i] = y; }
  return o;
}

function writeWav(file, channels, { float = false, dither = null } = {}) {
  const n = channels[0].length, c = channels.length, bytes = float ? 4 : 2;
  const buf = Buffer.alloc(44 + n * c * bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * c * bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(float ? 3 : 1, 20); buf.writeUInt16LE(c, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * c * bytes, 28); buf.writeUInt16LE(c * bytes, 32); buf.writeUInt16LE(bytes * 8, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * c * bytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < c; ch++) {
      const v = channels[ch][i];
      if (float) { buf.writeFloatLE(v, o); o += 4; }
      else {
        // TPDF dither: two uniform randoms summed, one LSB wide.
        const d = dither ? (dither() - dither()) : 0;
        const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767 + d)));
        buf.writeInt16LE(s, o); o += 2;
      }
    }
  }
  fs.writeFileSync(file, buf);
}

/** EBU R128 max momentary loudness and true peak, measured by ffmpeg. */
function measure(file) {
  const log = spawnSync(ffmpegPath, ['-hide_banner', '-nostats', '-v', 'verbose', '-i', file,
    '-af', 'apad=pad_dur=1,ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  let maxM = -Infinity;
  for (const m of log.matchAll(/ M:\s*(-?[\d.]+)/g)) maxM = Math.max(maxM, +m[1]);
  const tp = /Peak:\s*(-?[\d.]+) dBFS/.exec(log.split('Summary:').pop() || '');
  return { maxM, truePeak: tp ? +tp[1] : NaN };
}

function master(id, channels, targetLufsM) {
  // Channels rendered independently (a random sparkle per side) can differ in
  // length; pad to the longest rather than let writeWav cut one short.
  const longest = Math.max(...channels.map((c) => c.length));
  channels = channels.map((c) => { if (c.length === longest) return c; const p = new Float32Array(longest); p.set(c); return p; });
  let ch = channels.map(dcBlock);
  const peak = Math.max(...ch.map(peakOf));
  // The START is trimmed at -60 dB, so a sound begins on its first audible
  // sample. The END is trimmed at -50 dB: under speech a tail that far down
  // is silence, and keeping it only makes a sound's clip longer than anything
  // anyone will hear.
  const startFloor = peak * 0.001, endFloor = peak * 0.00316;
  let start = 0, end = ch[0].length - 1;
  while (start < end && !ch.some((c) => Math.abs(c[start]) > startFloor)) start++;
  while (end > start && !ch.some((c) => Math.abs(c[end]) > endFloor)) end--;
  const outMs = Math.min(20, (((end - start) / SR) * 1000) * 0.15);
  ch = ch.map((c) => {
    let seg = c.slice(start, end + 1);
    // A sound only tens of milliseconds long is over before the 4 Hz DC filter
    // settles, and a fast-decaying sine body is asymmetric by nature, so it can
    // carry a real offset. Remove the mean where it is audible-level; the
    // threshold is above every one of the approved first 31 sounds, so they
    // are untouched (checked by --verify-core).
    let mean = 0;
    for (const v of seg) mean += v;
    mean /= seg.length;
    if (Math.abs(mean) <= 5e-4 * peak) return fadeEdges(seg, 0.17, outMs);
    // Remove the mean THROUGH the fade window: on a sound only ~10 ms long the
    // fades cover enough of it to reintroduce the offset a plain subtraction
    // took out. Subtracting offset·w (w = the fade window, the offset chosen so the result
    // sums to zero) removes the DC and still leaves both ends at exactly zero.
    const w = fadeEdges(new Float32Array(seg.length).fill(1), 0.17, outMs);
    const faded = seg.map((v, i) => v * w[i]);
    let sf = 0, sw = 0;
    for (let i = 0; i < seg.length; i++) { sf += faded[i]; sw += w[i]; }
    const offset = sf / sw;
    return faded.map((v, i) => v - offset * w[i]);
  });

  const tmp = path.join(os.tmpdir(), `bh-pack-${id}.wav`);
  writeWav(tmp, ch, { float: true });
  const pre = measure(tmp);
  // The level the FILE must have so that at the default clip volume it lands
  // on the family target.
  const fileTarget = targetLufsM - 20 * Math.log10(PACK_DEFAULT_VOLUME);
  let gainDb = fileTarget - pre.maxM;
  let limited = false;
  if (pre.truePeak + gainDb > PEAK_CEILING_DBTP) { gainDb = PEAK_CEILING_DBTP - pre.truePeak; limited = true; }
  const g = Math.pow(10, gainDb / 20);
  ch = ch.map((c) => scale(c, g));

  const out = path.join(OUT_DIR, packFileName(id));
  writeWav(out, ch, { dither: mulberry32(seedFor(`${id}#dither`)) });
  fs.unlinkSync(tmp);
  const post = measure(out);
  return {
    id, file: out, channels: ch.length, duration: ch[0].length / SR,
    atDefault: post.maxM + 20 * Math.log10(PACK_DEFAULT_VOLUME), target: targetLufsM,
    truePeak: post.truePeak, leadTrimMs: (start / SR) * 1000, limited
  };
}

export { dcBlock, writeWav, measure, master };
