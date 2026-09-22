/**
 * The timeline's video filmstrip — a row of real frames sampled across the
 * loaded video, rendered directly under the ruler so the timeline reads like
 * a video editor's rather than an abstract keyframe grid.
 *
 * SCOPE: this module extracts and caches IMAGES. It owns no time state of its
 * own. `#preview-video` remains the single source of truth for duration and
 * currentTime (see timelinePanel.js's tick loop), the filmstrip row is mounted
 * inside the timeline's existing `scroll` element so the ONE existing
 * `.timeline-playhead` already spans it, and clicking it seeks that same video
 * through the same xToTime math the ruler uses. There is deliberately no
 * second timeline, no second playhead, and no second notion of "now".
 *
 * Extraction uses a DETACHED <video> element, never `#preview-video`. Seeking
 * the real playback element to sample frames would visibly jump the user's
 * preview, so this keeps its own decoder instance and leaves playback alone.
 *
 * Browser support: `video.currentTime` + the `seeked` event + `drawImage(video)`
 * + `canvas.toBlob` are universally available in modern browsers and need no
 * dependency, which is why this is preferred over WebCodecs here. The canvas is
 * never tainted because the app's video sources are same-origin: either a
 * `blob:` object URL created from the user's own File, or the bundled demo clip
 * (see src/App.jsx's setVideoSrc) — so `toBlob` is always permitted.
 *
 * ROTATION: the app's video rotation (shared/videoTransform.js) is a
 * RENDER/EXPORT transform — it never alters the source file's intrinsic
 * orientation — so thumbnails are deliberately NOT rotated by it. They show the
 * underlying video, exactly like the preview element does before its own CSS
 * transform is applied. Any rotation baked into the FILE's own display matrix
 * is applied by the browser on decode, so that is reflected automatically.
 */

// Tile geometry. Height is fixed so the row never changes height as tiles
// arrive (no layout shift); width follows the source aspect ratio, clamped so
// an extreme aspect can't produce absurd tiles.
const TILE_HEIGHT_PX = 44;
// The floor is deliberately generous. Tile WIDTH is what drives the tile count
// (count = trackWidth / tileWidth), so a small floor produces many very narrow
// tiles — at 28px a portrait frame became a ~31px sliver that read as blurry
// even when rasterized pixel-perfect, simply because there was almost nothing
// to see. A wider floor yields fewer, larger, actually legible frames.
const MIN_TILE_WIDTH_PX = 44;
const MAX_TILE_WIDTH_PX = 96;

// Never fewer than this (a filmstrip of 2 frames is not a filmstrip), never
// more than this (each tile is a real seek+decode, so the ceiling bounds the
// total work for a long video).
const MIN_TILES = 4;
const MAX_TILES = 40;

// A short clip should not be sampled more finely than this, or a 3-second video
// produces a row of near-identical frames for no informational gain.
const MIN_SECONDS_PER_TILE = 0.35;

// Re-extracting on every resize pixel would be pathological, so a regeneration
// only happens when the ideal count actually moves by more than this.
const COUNT_CHANGE_THRESHOLD = 2;

/**
 * Per-video in-memory cache: src -> { count, tiles: [{ t, url }], aspect }.
 * Deliberately not persisted — thumbnails are cheap to rebuild for the current
 * video and a permanent store would be a cache-invalidation problem for no
 * real benefit. Object URLs are revoked when an entry is evicted.
 */
const cache = new Map();
// Only the most recent few videos are worth keeping; each entry holds N object
// URLs that pin decoded image memory until revoked.
const MAX_CACHED_VIDEOS = 3;

function revokeEntry(entry) {
  entry?.tiles?.forEach((tile) => {
    if (tile.url) URL.revokeObjectURL(tile.url);
  });
}

function evictIfNeeded() {
  while (cache.size > MAX_CACHED_VIDEOS) {
    const oldestKey = cache.keys().next().value;
    revokeEntry(cache.get(oldestKey));
    cache.delete(oldestKey);
  }
}

/** Clears every cached video's thumbnails and frees their object URLs. */
export function clearFilmstripCache() {
  cache.forEach(revokeEntry);
  cache.clear();
}

/**
 * How many tiles to sample. Bounded by BOTH the available width (so tiles stay
 * a sensible size rather than being squashed) and the video's own length (so a
 * short clip isn't oversampled), then clamped.
 */
export function computeTileCount(trackWidthPx, durationSeconds, tileWidthPx) {
  if (!(trackWidthPx > 0) || !(durationSeconds > 0)) return 0;
  const width = Math.max(MIN_TILE_WIDTH_PX, Math.min(MAX_TILE_WIDTH_PX, tileWidthPx || MIN_TILE_WIDTH_PX));
  const byWidth = Math.round(trackWidthPx / width);
  const byDuration = Math.floor(durationSeconds / MIN_SECONDS_PER_TILE);
  return Math.max(MIN_TILES, Math.min(MAX_TILES, Math.max(1, Math.min(byWidth, byDuration))));
}

/** Tile width implied by the source's aspect ratio at the fixed row height. */
function tileWidthForAspect(aspect) {
  if (!(aspect > 0)) return MIN_TILE_WIDTH_PX;
  return Math.max(MIN_TILE_WIDTH_PX, Math.min(MAX_TILE_WIDTH_PX, Math.round(TILE_HEIGHT_PX * aspect)));
}

/**
 * Evenly spaced sample times. Offset by half a step so each tile shows the
 * MIDDLE of the slice it represents rather than its leading edge — sampling at
 * exactly 0 and exactly `duration` tends to land on black/blank frames.
 */
function sampleTimes(count, duration) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const t = ((i + 0.5) / count) * duration;
    // Keep a hair inside the clip; seeking exactly to duration can fail to fire
    // `seeked` on some browsers.
    times.push(Math.max(0, Math.min(duration - 0.02, t)));
  }
  return times;
}

function seekTo(video, time, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
      ok ? resolve() : reject(new Error(`seek to ${time} failed/timed out`));
    };
    const onSeeked = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      video.currentTime = time;
    } catch (err) {
      done(false);
    }
  });
}

function loadMetadata(video, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.duration > 0) return resolve();
    let settled = false;
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      clearTimeout(timer);
      ok ? resolve() : reject(new Error(msg || 'metadata load failed'));
    };
    const onLoaded = () => done(true);
    const onError = () => done(false, 'video failed to load');
    const timer = setTimeout(() => done(false, 'metadata load timed out'), timeoutMs);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

/**
 * Draws `source` into `ctx` cover-fitted, halving through a scratch canvas
 * whenever the reduction is extreme.
 *
 * A single `drawImage` from (say) 608x1080 straight down to 63x88 undersamples
 * badly — the browser's bilinear filter samples far too few source pixels, so
 * detail turns to mush and edges alias. Repeatedly halving keeps every step
 * within bilinear's competent range, which is the standard fix and is why
 * these tiles look sharp rather than smeared.
 */
function drawFrameScaled(ctx, source, sw, sh, buffers) {
  const dw = ctx.canvas.width;
  const dh = ctx.canvas.height;
  // Cover-fit: fill the tile, cropping the overflowing axis, so tiles are a
  // uniform size and butt together with no letterboxing gaps.
  const coverScale = Math.max(dw / sw, dh / sh);
  const targetW = sw * coverScale;
  const targetH = sh * coverScale;

  let curSrc = source;
  let curW = sw;
  let curH = sh;
  let slot = 0;

  // Halve while a further halving would still be at or above the target size.
  // Two buffers are alternated because assigning canvas.width CLEARS that
  // canvas — halving in place would read an empty bitmap on the second pass.
  while (curW / 2 >= targetW && curH / 2 >= targetH && curW > 2 && curH > 2) {
    const nextW = Math.max(1, Math.round(curW / 2));
    const nextH = Math.max(1, Math.round(curH / 2));
    const buf = buffers[slot % 2];
    slot++;
    buf.canvas.width = nextW;
    buf.canvas.height = nextH;
    buf.ctx.imageSmoothingEnabled = true;
    buf.ctx.imageSmoothingQuality = 'high';
    buf.ctx.drawImage(curSrc, 0, 0, curW, curH, 0, 0, nextW, nextH);
    curSrc = buf.canvas;
    curW = nextW;
    curH = nextH;
  }

  const finalScale = Math.max(dw / curW, dh / curH);
  const drawW = curW * finalScale;
  const drawH = curH * finalScale;
  ctx.drawImage(curSrc, 0, 0, curW, curH, (dw - drawW) / 2, (dh - drawH) / 2, drawW, drawH);
}

function canvasToBlobUrl(canvas) {
  return new Promise((resolve) => {
    try {
      // Tiles are small, so the file-size saving from aggressive compression is
      // negligible while the quality cost is very visible — 0.6 JPEG was adding
      // real mushiness on top of the scaling problems. WebP is preferred where
      // supported (noticeably better at these sizes); browsers that don't
      // support it silently hand back a PNG blob from toBlob, which is fine.
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
        'image/webp',
        0.92
      );
    } catch (err) {
      // Tainted canvas or an unsupported type — treated as "this tile failed"
      // rather than failing the whole strip.
      resolve(null);
    }
  });
}

/**
 * Extracts `count` frames from `src`, invoking `onTile(index, url)` as each one
 * finishes so the caller can paint progressively instead of waiting for all of
 * them. Returns the full tile list.
 *
 * `shouldAbort()` is polled between frames so a video swap (or unmount) stops
 * the work immediately instead of finishing a strip nobody will see.
 */
export async function extractThumbnails(src, { count, tileWidthPx, onTile, shouldAbort } = {}) {
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  // Same-origin sources only (blob:/relative), but this keeps the canvas
  // untainted if a remote source is ever introduced AND the server sends CORS.
  video.crossOrigin = 'anonymous';
  video.src = src;

  const tiles = [];
  try {
    await loadMetadata(video);
    const duration = video.duration;
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('video has no usable duration');

    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const aspect = vw / vh;
    // The canvas MUST be sized from the width the tile is actually DISPLAYED
    // at, not from the aspect-derived width used to pick the tile count. Those
    // two are decoupled (tiles lay out at trackWidth/count), so sizing by the
    // latter rendered a 28px-wide image into a ~32 CSS px slot — then the
    // browser upscaled it again for HiDPI, which is what made tiles look soft.
    const tileWidth = tileWidthPx > 0 ? tileWidthPx : tileWidthForAspect(aspect);

    const canvas = document.createElement('canvas');
    // Backing store at device scale keeps tiles crisp on HiDPI without
    // re-extracting per display. Capped at 2 so a 3x phone doesn't quadruple
    // the decode/encode cost for no visible gain at this size.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(tileWidth * dpr));
    canvas.height = Math.max(1, Math.round(TILE_HEIGHT_PX * dpr));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Two alternating scratch buffers for stepped downscaling — see
    // drawFrameScaled on why one is not enough.
    const buffers = [0, 1].map(() => {
      const c = document.createElement('canvas');
      return { canvas: c, ctx: c.getContext('2d') };
    });

    const times = sampleTimes(count, duration);
    for (let i = 0; i < times.length; i++) {
      if (shouldAbort?.()) break;
      let url = null;
      try {
        await seekTo(video, times[i]);
        drawFrameScaled(ctx, video, vw, vh, buffers);
        url = await canvasToBlobUrl(canvas);
      } catch (err) {
        // One unreadable frame must not kill the strip — that tile just stays
        // blank and the rest still render.
        url = null;
      }
      const tile = { t: times[i], url };
      tiles.push(tile);
      if (url) onTile?.(i, url, tileWidth);
    }
    return { tiles, tileWidth, aspect };
  } finally {
    // Release the decoder promptly; without this the detached element can keep
    // a pipeline alive for the lifetime of the page.
    video.removeAttribute('src');
    try { video.load(); } catch (err) { /* element already torn down */ }
  }
}

/**
 * Cache-aware entry point. Returns the cached strip when the same video has
 * already been sampled at a comparable count, otherwise extracts and stores it.
 */
export async function getFilmstrip(src, { count, tileWidthPx, onTile, shouldAbort } = {}) {
  const cached = cache.get(src);
  // Re-extract if the tile is now rendered meaningfully LARGER than what the
  // cached images were rasterized for, otherwise the browser upscales them and
  // they look soft. Growing past the cached resolution is the only case worth
  // paying for; rendering smaller just downsamples, which is fine.
  const resolutionStale = cached && tileWidthPx > (cached.tileWidth || 0) * 1.25;
  if (cached && !resolutionStale && Math.abs(cached.count - count) <= COUNT_CHANGE_THRESHOLD) {
    // Re-announce cached tiles so the caller paints without re-extracting.
    cached.tiles.forEach((tile, i) => { if (tile.url) onTile?.(i, tile.url, cached.tileWidth); });
    return cached;
  }
  if (cached) {
    revokeEntry(cached);
    cache.delete(src);
  }

  const { tiles, tileWidth, aspect } = await extractThumbnails(src, { count, tileWidthPx, onTile, shouldAbort });
  if (shouldAbort?.()) {
    // Discard rather than cache a half-built strip for a video that is gone.
    tiles.forEach((tile) => { if (tile.url) URL.revokeObjectURL(tile.url); });
    return { tiles: [], tileWidth, aspect };
  }
  const entry = { count, tiles, tileWidth, aspect };
  cache.set(src, entry);
  evictIfNeeded();
  return entry;
}

export const FILMSTRIP_TILE_HEIGHT_PX = TILE_HEIGHT_PX;
export const FILMSTRIP_COUNT_CHANGE_THRESHOLD = COUNT_CHANGE_THRESHOLD;
