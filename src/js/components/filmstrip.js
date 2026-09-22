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
const MIN_TILE_WIDTH_PX = 28;
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

function canvasToBlobUrl(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
        'image/jpeg',
        0.6
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
export async function extractThumbnails(src, { count, onTile, shouldAbort } = {}) {
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
    const tileWidth = tileWidthForAspect(aspect);

    const canvas = document.createElement('canvas');
    // Backing store at device scale keeps tiles crisp on HiDPI without
    // re-extracting per display.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(tileWidth * dpr);
    canvas.height = Math.round(TILE_HEIGHT_PX * dpr);
    const ctx = canvas.getContext('2d');

    const times = sampleTimes(count, duration);
    for (let i = 0; i < times.length; i++) {
      if (shouldAbort?.()) break;
      let url = null;
      try {
        await seekTo(video, times[i]);
        // Cover-fit: fill the tile, cropping the overflowing axis, so tiles are
        // a uniform size and butt together with no letterboxing gaps.
        const scale = Math.max(canvas.width / vw, canvas.height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
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
export async function getFilmstrip(src, { count, onTile, shouldAbort } = {}) {
  const cached = cache.get(src);
  if (cached && Math.abs(cached.count - count) <= COUNT_CHANGE_THRESHOLD) {
    // Re-announce cached tiles so the caller paints without re-extracting.
    cached.tiles.forEach((tile, i) => { if (tile.url) onTile?.(i, tile.url, cached.tileWidth); });
    return cached;
  }
  if (cached) {
    revokeEntry(cached);
    cache.delete(src);
  }

  const { tiles, tileWidth, aspect } = await extractThumbnails(src, { count, onTile, shouldAbort });
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
