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
 * Not #captions-canvas or #caption-transform-overlay either: both are
 * `display:none` until a caption/word is actually selected/active (see their
 * own CSS), so their getBoundingClientRect() is a zero rect for most of a
 * gesture's lifetime (e.g. the very first click that selects something).
 */
/**
 * THE FRAME, not the video. Since the composition system (shared/
 * composition.js) the video is an object placed INSIDE the canvas — fitted,
 * moved, scaled, rotated, rounded — so its own box is no longer the canvas
 * and cannot stand in for it. #state-video is: it is the frame's whole
 * content box, laid out for exactly as long as the video view is showing,
 * and never transformed, so its bounding box is its layout box.
 *
 * (Before, this read #preview-video and had to strip the video's CSS
 * transform off it on every call to undo the inflated box a rotation gives
 * — measuring the frame itself makes that unnecessary.)
 */
export function getCanvasContentRect() {
  const surface = document.getElementById('state-video');
  if (surface && surface.offsetWidth > 0) return surface.getBoundingClientRect();
  const video = document.getElementById('preview-video');
  return video ? video.getBoundingClientRect() : null;
}
