/**
 * One reusable canvas per size for the exporter's FRAME canvases.
 *
 * Every phrase, run and effect stream the exporter renders used to allocate a
 * brand-new full-size canvas. @napi-rs/canvas releases a canvas's native memory
 * only when the event loop turns, and frame generation is one long synchronous
 * loop that never does — so those canvases piled up for the whole export.
 * Measured on a real 3.5-minute 4K portrait phone video (2160x3840, so 33MB a
 * canvas) with the frame generator itself: ~36MB retained per phrase, projected
 * ~6.8GB for the whole job on a machine with 7.8GB of RAM. Not a crash on its
 * own, but one browser tab away from one — and the reason the fast PNG encoder
 * (pngFast.js) could not be allowed to add its own per-frame copies on top.
 *
 * A reused canvas costs nothing to wipe: ctx.reset() restores EVERYTHING a
 * fresh canvas has — pixels transparent, fill/alpha/blend/shadow/font back to
 * defaults, identity transform, clip cleared, any unbalanced save() dropped
 * (checked against a deliberately dirtied context on this library version) —
 * so a caller cannot tell it from a new one.
 *
 * ONLY the main frame canvases come from here. The offscreen canvases the
 * caption renderer asks for (createOffscreenCanvas) are nested: one drawing
 * pass can hold several at once, and two callers sharing one would draw over
 * each other. Those stay fresh.
 *
 * Safe because frame generation is synchronous: no two callers can be using
 * the pooled canvas at the same time, and every caller finishes with it —
 * handing back file paths, never the canvas — before the next one starts.
 * If generation ever becomes async, acquire/release must be scoped to a call
 * rather than shared at module level.
 */
import fs from 'fs';
import os from 'os';
import { createCanvas } from '@napi-rs/canvas';
import { snapshotPngRows, encodePngRowsAsync } from './pngFast.js';

const pool = new Map();
let pooling = process.env.BHYND_POOL_CANVAS !== '0';

/** A clean, transparent canvas of this size — reused when pooling is on. */
export function acquireFrameCanvas(width, height) {
  if (!pooling) return createCanvas(width, height);
  const key = `${width}x${height}`;
  let canvas = pool.get(key);
  if (!canvas) {
    canvas = createCanvas(width, height);
    pool.set(key, canvas);
  } else {
    canvas.getContext('2d').reset();
  }
  return canvas;
}

/** Lets go of every pooled canvas — called when an export finishes, so an idle server holds none. */
export function releaseFrameCanvases() {
  pool.clear();
}

/** For tests: pooling off gives every caller a fresh canvas, exactly as before. */
export function setFrameCanvasPooling(on) {
  pooling = !!on;
  if (!pooling) pool.clear();
}

// --- The frame writer: drawing and saving frames side by side ----------------------
//
// Saving a frame was the export's real cost: drawing a 2160x3840 caption frame
// takes ~7ms, compressing it to PNG ~600ms — measured on this library. And it
// ran one frame at a time, in a loop that never let the event loop turn. The
// writer saves frames in the BACKGROUND (canvas.encode runs on libuv's thread
// pool), up to `concurrency` at once, while the next frame is already being
// drawn. Each frame gets its own canvas (a frame still saving cannot be drawn
// over), and canvases go back to a small pool once saved — so at most
// concurrency + 1 full-size canvases exist at a time. When every slot is busy
// the drawing WAITS, which is also what lets the event loop turn and release
// native memory the old synchronous loop piled up.
//
// Scoped to ONE build (graphicsFrameGenerator.js creates one per export and
// flushes it before returning), so nothing outlives the export.


// Scratch-grade PNGs (zlib level 1 — pngFast.js): ~140ms a 4K frame against
// ~1s for the library's own maximum-compression PNG, for files that live
// seconds. BHYND_SCRATCH_PNG=native goes back to the library's encoder.
const FAST = process.env.BHYND_SCRATCH_PNG !== 'native';
const DEFAULT_CONCURRENCY = Math.max(2, Math.min(4, Number(process.env.BHYND_FRAME_CONCURRENCY) || (os.cpus().length - 1)));

export function createFrameWriter({ concurrency = DEFAULT_CONCURRENCY } = {}) {
  const free = new Map();
  const pending = new Set();
  const waiters = [];
  let inFlight = 0;
  let failure = null;
  const keyOf = (w, h) => `${w}x${h}`;
  return {
    /** A clean, transparent canvas of this size — waits while every save slot is busy. */
    async canvas(width, height) {
      while (inFlight >= concurrency) await new Promise((resolve) => waiters.push(resolve));
      if (failure) throw failure;
      const reused = free.get(keyOf(width, height))?.pop();
      if (reused) {
        reused.getContext('2d').reset();
        return reused;
      }
      return createCanvas(width, height);
    },
    /** Saves `canvas` to `file` as a PNG in the background; the canvas is the writer's again once saved. */
    write(canvas, file) {
      inFlight += 1;
      const key = keyOf(canvas.width, canvas.height);
      const giveBack = () => {
        if (!free.has(key)) free.set(key, []);
        free.get(key).push(canvas);
      };
      let encoded;
      if (FAST) {
        // The pixels are copied out now, so the canvas is free for the next
        // frame at once; only the compression waits its turn.
        encoded = encodePngRowsAsync(snapshotPngRows(canvas));
        giveBack();
      } else {
        encoded = canvas.encode('png').finally(giveBack);
      }
      const job = encoded
        .then((buffer) => fs.promises.writeFile(file, buffer))
        .catch((err) => { failure = failure || err; })
        .finally(() => {
          inFlight -= 1;
          pending.delete(job);
          waiters.shift()?.();
        });
      pending.add(job);
    },
    /** Waits for every frame still saving; throws the first save that failed. Lets the pool go. */
    async flush() {
      while (pending.size) await Promise.all([...pending]);
      free.clear();
      if (failure) throw failure;
    }
  };
}
