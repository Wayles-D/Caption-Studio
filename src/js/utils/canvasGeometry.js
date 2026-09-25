/**
 * The canonical on-screen CSS rect for the video/caption rendering &
 * interaction surface — the single source of truth every pointer/canvas
 * coordinate conversion in the app (canvasTransform.js, videoCanvasControls.js,
 * preview.js) must derive its origin from.
 *
 * NOT `.phone-frame`'s own getBoundingClientRect(): `.phone-frame` has a 4px
 * CSS border (see style.css), and getBoundingClientRect() on a bordered
 * element includes the border in its rect — but the actual rendering
 * surfaces (#captions-canvas, #caption-transform-overlay, #preview-video)
 * are ordinary children laid out INSIDE that border, at a smaller, inset
 * rect. Treating the border-inclusive phone-frame rect as the content origin
 * introduced a real, confirmed bug: every pointer-to-canvas conversion
 * (hit-testing, drag math, selection-box placement) was off by the border
 * width, and the graphics canvas's own backing-store size
 * (preview.js's prepareGraphicsCanvas) was computed ~5% too large, since it
 * sized itself off the same border-inclusive measurement instead of its own
 * actual displayed size — confirmed via direct pixel-buffer scanning against
 * the reported geometry.
 *
 * Deliberately reads #preview-video, not #captions-canvas or
 * #caption-transform-overlay: both of those are `display:none` until a
 * caption/word is actually selected/active (see their own CSS), so their
 * getBoundingClientRect() is a zero rect for most of a gesture's lifetime
 * (e.g. the very first click that selects something). #preview-video is
 * `width:100%; height:100%` of the exact same content box and is always
 * laid out for the entire time the video view is showing — the only time
 * any of this coordinate math ever runs.
 */
/**
 * Cache for the transform-stripped measurement below. Keyed entirely on
 * READS, so a cache hit costs nothing — the expensive part is the write/read/
 * write cycle, which this keeps to at most once per frame even though several
 * callers ask per tick.
 */
let untransformedRectCache = null;

export function getCanvasContentRect() {
  const video = document.getElementById('preview-video');
  if (!video) return null;

  // FAST PATH: no video transform (every project that doesn't use one), so
  // the bounding box IS the layout box and nothing below is needed.
  const applied = video.style.transform;
  if (!applied) return video.getBoundingClientRect();

  // The VIDEO's own transform (see shared/videoTransform.js) is applied as a
  // CSS transform on #preview-video — and getBoundingClientRect() on a
  // rotated or scaled element returns the axis-aligned box of the
  // TRANSFORMED shape, not the element's layout box. Measured directly: a
  // 145x264 preview reports 216x295 at 17° of rotation.
  //
  // Everything this rect feeds is NOT transformed with the video — the
  // caption canvas, the text-overlay canvas and the selection overlay are
  // siblings laid out against the video's layout box, and the exporter
  // likewise composites them on top of the already-transformed frame rather
  // than rotating them too. So using the inflated box made the preview
  // disagree with the export the moment a video rotation was applied: the
  // selection overlay sprawled well outside the phone frame, and every
  // pointer-to-canvas conversion (hit testing, drag math) was scaled and
  // offset by the inflation. Export was never affected — it measures no DOM
  // at all, which is exactly why this only ever showed up in the preview.
  //
  // Measured with the transform neutralized rather than derived from it: the
  // transform is a translate+scale+rotate composite, and inverting that by
  // hand is both fiddly and a second source of truth about geometry, which
  // this file exists to avoid.
  const parent = video.parentElement;
  const parentRect = parent ? parent.getBoundingClientRect() : null;
  const key = [
    applied,
    video.offsetWidth, video.offsetHeight, video.offsetLeft, video.offsetTop,
    parentRect ? `${parentRect.left},${parentRect.top},${parentRect.width},${parentRect.height}` : ''
  ].join('|');
  if (untransformedRectCache && untransformedRectCache.key === key) {
    return untransformedRectCache.rect;
  }

  video.style.transform = 'none';
  const rect = video.getBoundingClientRect();
  video.style.transform = applied;
  untransformedRectCache = { key, rect };
  return rect;
}
