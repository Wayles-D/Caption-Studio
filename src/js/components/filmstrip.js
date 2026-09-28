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

// Never fewer than this (a filmstrip of 2 frames is not a filmstrip).
const MIN_TILES = 4;

// The ceiling on tiles EXTRACTED AT ONCE — not on tiles in the clip.
//
// It used to be both, and that was the bug: a zoomed timeline asks for more
// frames than a fitted one, the request was clamped to 40, and the tiles were
// then stretched to fill the row. On a portrait clip a frame's natural width
// at this row height is ~25px, so at 2.3x zoom each was drawn ~72px wide —
// about 3x its own size, which is exactly the zoomed, blurry strip that got
// reported.
//
// The strip is now VIRTUALIZED: tiles sit on a fixed time grid at their
// natural width however long the clip is, and only the ones inside the
// visible window (plus a margin) are ever extracted. So this bounds the work
// per pan, which is constant, instead of bounding the clip's resolution.
const MAX_VISIBLE_TILES = 80;

// Extra window either side of what's on screen, as a fraction of the viewport
// — panning a little should not have to wait for a fresh extraction.
const WINDOW_MARGIN_FRACTION = 0.5;


/**
 * The grid of sample times, as a ladder of doubling intervals.
 *
 * Doubling matters: the times on any coarser grid are a SUBSET of the times on
 * the next finer one, so zooming out reuses frames already extracted rather
 * than re-decoding the whole window. A ladder of "nice" seconds (0.5, 1, 2,
 * 5, 10) would not nest and would throw the cache away on every zoom step.
 */
const TILE_SECONDS_LADDER = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

// Sampling exactly at 0 tends to land on a black frame, and some browsers
// never fire 'seeked' for it. A hair inside the slice avoids both while
// keeping the grid's doubling property intact (the offset is constant, so a
// coarse grid's times are still a subset of a finer one's).
const GRID_EPSILON_SECONDS = 0.04;

/**
 * How much time one tile should span so it renders at roughly its natural
 * width — snapped UP the ladder, so tiles are never narrower than natural
 * (which is what made them look like slivers) and the extraction count is
 * never higher than it needs to be.
 */
export function chooseSecondsPerTile(tileWidthPx, pixelsPerSecond) {
  if (!(pixelsPerSecond > 0) || !(tileWidthPx > 0)) return TILE_SECONDS_LADDER[TILE_SECONDS_LADDER.length - 1];
  // No separate floor on the interval. A 0.35s floor used to apply
  // here and silently defeated the whole feature: at 0.35s it snapped to the
  // 0.5s rung whatever the zoom, so a 3x-wider track just drew the same
  // frames 3x larger — measured 44.6px -> 151.5px per tile, which is exactly
  // the stretching this was meant to remove. The ladder's own first rung is
  // the real floor, and the "do not oversample a short clip" concern it was
  // guarding is handled by the arithmetic anyway: a short clip has a high
  // pixels-per-second, so the interval it asks for is already coarse.
  const wanted = tileWidthPx / pixelsPerSecond;
  return TILE_SECONDS_LADDER.find((step) => step >= wanted)
    ?? TILE_SECONDS_LADDER[TILE_SECONDS_LADDER.length - 1];
}

/**
 * The grid times covering [windowStart, windowEnd], each tile's own sample
 * point. Returned as {t, index} so the caller can position a tile by its slot
 * without re-deriving the arithmetic.
 */
export function tileTimesForWindow(windowStart, windowEnd, secondsPerTile, duration) {
  if (!(duration > 0) || !(secondsPerTile > 0)) return [];
  // A clip shorter than a few slots would otherwise render as one or two
  // tiles, which does not read as a filmstrip at all.
  const slotsInClip = Math.ceil(duration / secondsPerTile);
  if (slotsInClip < MIN_TILES) {
    const step = duration / MIN_TILES;
    return Array.from({ length: MIN_TILES }, (_, i) => ({
      index: i,
      slotStart: i * step,
      t: Math.max(0, Math.min(duration - 0.02, i * step + GRID_EPSILON_SECONDS)),
      span: step
    }));
  }
  const first = Math.max(0, Math.floor(windowStart / secondsPerTile));
  const last = Math.min(
    Math.ceil(duration / secondsPerTile) - 1,
    Math.ceil(windowEnd / secondsPerTile)
  );
  const out = [];
  for (let i = first; i <= last && out.length < MAX_VISIBLE_TILES; i++) {
    const slotStart = i * secondsPerTile;
    if (slotStart >= duration) break;
    out.push({
      index: i,
      slotStart,
      t: Math.max(0, Math.min(duration - 0.02, slotStart + GRID_EPSILON_SECONDS))
    });
  }
  return out;
}

/**
 * Per-video cache of individual FRAMES: src -> Map<timeKey, { url, width }>.
 *
 * Keyed by time rather than by "the strip as a whole", which is what makes
 * virtualization work. The old cache stored one finished strip per video and
 * threw all of it away whenever the tile count moved, so panning or zooming
 * meant re-decoding everything. A frame keyed by its own timestamp is reusable
 * by any window that happens to include it — and because the sample grid
 * doubles (see TILE_SECONDS_LADDER), zooming out reuses frames the finer grid
 * already produced instead of starting over.
 *
 * Deliberately not persisted: thumbnails are cheap to rebuild for the current
 * video and a permanent store would be a cache-invalidation problem for no
 * real benefit. Object URLs are revoked when an entry is evicted.
 */
const cache = new Map();

/** Frames are matched to a grid slot, so the key is the time in milliseconds. */
function timeKey(t) {
  return Math.round(t * 1000);
}

// Frames are small, but each one pins decoded image memory until revoked, so
// a long session panning a long clip needs a ceiling. Oldest-first eviction
// within a video, since the user is usually moving forwards.
const MAX_CACHED_FRAMES_PER_VIDEO = 400;
// Only the most recent few videos are worth keeping; each entry holds N object
// URLs that pin decoded image memory until revoked.
const MAX_CACHED_VIDEOS = 3;

function revokeEntry(entry) {
  entry?.frames?.forEach((frame) => {
    if (frame.url) URL.revokeObjectURL(frame.url);
  });
}

/** Drops the oldest frames of one video once it holds more than the ceiling. */
function trimFrames(entry) {
  while (entry.frames.size > MAX_CACHED_FRAMES_PER_VIDEO) {
    const oldest = entry.frames.keys().next().value;
    const frame = entry.frames.get(oldest);
    if (frame?.url) URL.revokeObjectURL(frame.url);
    entry.frames.delete(oldest);
  }
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
export async function extractThumbnails(src, { times, count, tileWidthPx, onTile, shouldAbort } = {}) {
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

    // Explicit times when the caller has a grid (the virtualized strip);
    // evenly-spaced ones when it just wants N frames across the clip.
    const sampleAt = Array.isArray(times) && times.length ? times : sampleTimes(count, duration);
    for (let i = 0; i < sampleAt.length; i++) {
      if (shouldAbort?.()) break;
      let url = null;
      try {
        await seekTo(video, sampleAt[i]);
        drawFrameScaled(ctx, video, vw, vh, buffers);
        url = await canvasToBlobUrl(canvas);
      } catch (err) {
        // One unreadable frame must not kill the strip — that tile just stays
        // blank and the rest still render.
        url = null;
      }
      const tile = { t: sampleAt[i], url };
      tiles.push(tile);
      if (url) onTile?.(i, url, tileWidth, sampleAt[i]);
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
 * Cache-aware entry point for a WINDOW of the clip.
 *
 * Announces every frame it already has immediately (so a pan repaints with no
 * decoding at all), then extracts only the ones missing. This is what makes
 * the cost constant: it is bounded by how many tiles fit on screen, not by how
 * long the video is or how far it is zoomed in.
 *
 * @param {{t:number}[]} slots - The grid slots to cover, from tileTimesForWindow.
 * @param {number} tileWidthPx - The width each tile is actually DISPLAYED at; frames are rasterized to exactly this so the browser never upscales them.
 * @param {(t:number, url:string, width:number) => void} onTile - Called per frame, cached or freshly extracted.
 */
export async function getFilmstripWindow(src, { slots, tileWidthPx, onTile, shouldAbort } = {}) {
  if (!src || !Array.isArray(slots) || !slots.length) return { extracted: 0, reused: 0 };

  let entry = cache.get(src);
  if (!entry) {
    entry = { frames: new Map(), tileWidth: 0 };
    cache.set(src, entry);
    evictIfNeeded();
  }

  // A frame rasterized for a NARROWER tile than it is about to be drawn at
  // would be upscaled by the browser and look soft — the same reasoning the
  // whole-strip cache used, applied per frame. Drawing one smaller than it was
  // rasterized is just downsampling, which is fine.
  const resolutionStale = tileWidthPx > (entry.tileWidth || 0) * 1.25;
  if (resolutionStale) {
    revokeEntry(entry);
    entry.frames = new Map();
    entry.tileWidth = tileWidthPx;
  }

  const missing = [];
  let reused = 0;
  slots.forEach((slot) => {
    const cachedFrame = entry.frames.get(timeKey(slot.t));
    if (cachedFrame?.url) {
      reused++;
      onTile?.(slot.t, cachedFrame.url, entry.tileWidth);
    } else {
      missing.push(slot.t);
    }
  });

  if (!missing.length || shouldAbort?.()) return { extracted: 0, reused };

  const { tileWidth } = await extractThumbnails(src, {
    times: missing,
    tileWidthPx,
    shouldAbort,
    onTile: (_i, url, width, t) => {
      if (shouldAbort?.()) return;
      entry.frames.set(timeKey(t), { url, width });
      onTile?.(t, url, width);
    }
  });
  entry.tileWidth = Math.max(entry.tileWidth, tileWidth || tileWidthPx);
  trimFrames(entry);
  return { extracted: missing.length, reused };
}

/** How many frames are cached for a video — for tests and diagnostics. */
export function cachedFrameCount(src) {
  return cache.get(src)?.frames.size || 0;
}

export const FILMSTRIP_TILE_HEIGHT_PX = TILE_HEIGHT_PX;

/** Natural on-screen width of one frame at the row's fixed height. */
export function filmstripTileWidth(aspect) {
  return tileWidthForAspect(aspect);
}
