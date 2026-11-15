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
import { createCanvas } from '@napi-rs/canvas';

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
