/**
 * Fast PNG writing for the export's SCRATCH frames.
 *
 * The graphics exporter writes one transparent PNG per timing slice, across
 * nine separate layer streams (captions, keyword captions, manual captions,
 * text elements, images, shapes, object effects, subject masks, blanks). A
 * project with several layers runs to thousands of frames, and every one of
 * them is handed to ffmpeg and then deleted with the scratch directory.
 *
 * `canvas.toBuffer('image/png')` compresses those as hard as it can, which is
 * exactly the wrong trade for a file that lives for seconds: measured at
 * 1080x1920, it spent ~157ms per frame to reach 15KB, while the drawing it was
 * encoding took ~18ms. Encoding the same pixels at zlib level 1 takes ~26ms
 * and reaches 45KB — 6x faster for 30KB of disk nobody keeps.
 *
 * The PNG is written by hand because @napi-rs/canvas exposes no compression
 * level for PNG (see its encode/encodeSync overloads — only webp/jpeg/gif/avif
 * take a quality). It is a minimal, entirely standard encoder: 8-bit RGBA,
 * no interlacing, filter type 0 (None) on every scanline. Filtering would buy
 * smaller output at more CPU, which is the trade being rejected here.
 *
 * Output is PIXEL-IDENTICAL to toBuffer's — PNG is lossless, so the
 * compression level changes only the file's size, never its contents.
 *
 * *** NOT THE DEFAULT, AND WHY — read before changing it. ***
 * Reading pixels out of an @napi-rs/canvas (getImageData, and data() — both
 * copy the whole canvas) allocates native memory that is only released when
 * the event loop gets a turn to run its finalizer. Frame generation is one
 * long SYNCHRONOUS loop that never yields, so every frame's copy piles up:
 * measured at 2160x3840 (a 4K portrait phone video), memory grew ~55MB per
 * frame — over 2GB after 40 frames — and a 3.5-minute export died with no
 * error at all, only nodemon's "app crashed". The same loop with an
 * `await setImmediate()` between frames sat flat at 186MB, so the mechanism
 * is certain; a forced synchronous gc() every 4 frames did NOT help.
 *
 * toBuffer('image/png') never exposes the pixels to JS, so it does not have
 * this cost — it is ~6x slower, but it cannot take the process down.
 *
 * The fast encoder is therefore OPT-IN (BHYND_SCRATCH_PNG=fast, or
 * setScratchPngMode('fast')) and is only safe once the frame loops yield to
 * the event loop. That is the real fix, and it is a deliberate piece of work:
 * the generators are synchronous, reach 13 files, and buildFullTimelineSegments
 * leans on a module-level `sampleFps` that is valid only for the duration of
 * one synchronous call.
 */
import fs from 'fs';
import zlib from 'zlib';

/** zlib level 1: nearly all of the size win, a fraction of the CPU. Level 0 is SLOWER — it writes 8MB. */
const SCRATCH_COMPRESSION_LEVEL = 1;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One PNG chunk: length, type, data, CRC of (type + data). */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encodes a canvas as a PNG buffer at scratch-grade compression.
 *
 * @param {object} canvas - A @napi-rs/canvas Canvas (or anything with
 *   width/height and a 2d context whose getImageData returns RGBA).
 * @returns {Buffer} A complete, standard PNG.
 */
export function encodePngFast(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);

  // Each scanline is prefixed with its filter byte — 0, meaning None.
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, at + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type 6: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: SCRATCH_COMPRESSION_LEVEL })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Encodes and writes in one step — the drop-in for writeFileSync(file, canvas.toBuffer('image/png')). */
export function writePngFast(canvas, file) {
  fs.writeFileSync(file, encodePngFast(canvas));
}

// --- Which encoder the exporter uses -----------------------------------------
// 'native' = canvas.toBuffer('image/png'): slower, and safe in a loop that never
// yields. 'fast' = writePngFast above: ~6x quicker and unsafe at high resolution
// until the loops yield (see the header). Native is the default on purpose.
let scratchMode = process.env.BHYND_SCRATCH_PNG === 'fast' ? 'fast' : 'native';

export function setScratchPngMode(mode) {
  if (mode !== 'fast' && mode !== 'native') throw new Error(`unknown scratch PNG mode: ${mode}`);
  scratchMode = mode;
}

export function getScratchPngMode() {
  return scratchMode;
}

/** Writes one scratch frame with whichever encoder is selected. Every frame the exporter writes goes through here. */
export function writeScratchPng(canvas, file) {
  if (scratchMode === 'fast') writePngFast(canvas, file);
  else fs.writeFileSync(file, canvas.toBuffer('image/png'));
}
