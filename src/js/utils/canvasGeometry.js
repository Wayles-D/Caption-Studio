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
export function getCanvasContentRect() {
  const video = document.getElementById('preview-video');
  return video ? video.getBoundingClientRect() : null;
}
