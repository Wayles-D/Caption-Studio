import { test, expect } from '@playwright/test';

// Regression test for the ".phone-frame border-inclusive rect used as the
// content origin" bug: .phone-frame has a 4px CSS border (see style.css),
// and getBoundingClientRect() on it includes that border, but the actual
// rendering surface (#preview-video, #captions-canvas,
// #caption-transform-overlay) is inset INSIDE it. Every coordinate
// conversion in canvasTransform.js/videoCanvasControls.js/preview.js used to
// derive its origin from .phone-frame's own rect, and the graphics canvas's
// backing store was sized from it too — both confirmed (via direct
// pixel-buffer scanning) to introduce a real, ~9px position error and a ~5%
// canvas-scale error for a rotated caption. Fixed by
// src/js/utils/canvasGeometry.js's getCanvasContentRect(), which reads
// #preview-video (always laid out, unlike the canvas/overlay which are
// `display:none` until active) instead of .phone-frame.
//
// This test proves the fix numerically: it scans the canvas's own pixel
// buffer for where a rotated caption's glyph is ACTUALLY drawn, and checks
// that against the geometry the app reports for that same caption — no
// tolerance for the border-width-sized error the bug produced.

test('rotated caption geometry matches its actual rendered pixels (no phone-frame-border offset)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Try Demo Video').click();

  await page.evaluate(() => {
    const words = [{ word: 'CAPTIONS', start: 0, end: 1, wordIndex: 0 }];
    const phrases = [{ start: 0, end: 1, words, breakAfterIndices: [] }];
    window.__updateState({ words, phrases }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);

  // Sanity check on the fix itself: the canvas backing store must match its
  // actually-displayed CSS size almost exactly (previously off by ~5%,
  // since it was sized from .phone-frame's border-inclusive rect).
  const canvasScale = await page.evaluate(() => {
    const canvas = document.getElementById('captions-canvas');
    const rect = canvas.getBoundingClientRect();
    return canvas.width / rect.width;
  });
  expect(canvasScale).toBeGreaterThan(0.98);
  expect(canvasScale).toBeLessThan(1.02);

  // Select and rotate the caption -90deg (a static override, not a
  // keyframe) — the exact scenario that visibly showed the selection box
  // nowhere near the rotated text.
  const frameBox = await page.locator('#preview-video').boundingBox();
  const captionRect = await page.evaluate(() => window.__debugCaptionBoxRect());
  await page.mouse.click(frameBox.x + captionRect.centerX, frameBox.y + captionRect.centerY);

  await page.evaluate(() => {
    window.__appState.captionTransforms = {
      ...window.__appState.captionTransforms,
      '0': { ...(window.__appState.captionTransforms['0'] || {}), rotation: -90 }
    };
    // Video is paused — nudge currentTime to force a redraw (see
    // preview.js's timeupdate listener; the rAF loop only runs on playback).
    document.getElementById('preview-video').currentTime = 0.001;
  });
  await page.waitForTimeout(150);

  const reported = await page.evaluate(() => window.__debugCaptionBoxRect());

  // Ground truth: scan the canvas's own pixel buffer for the rotated
  // glyph's bounding box, independent of any geometry code, then convert to
  // the same CSS-px space __debugCaptionBoxRect reports in.
  const pixelCenter = await page.evaluate(() => {
    const canvas = document.getElementById('captions-canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const toCss = width / canvas.getBoundingClientRect().width;
    return { centerX: (minX + maxX) / 2 / toCss, centerY: (minY + maxY) / 2 / toCss };
  });

  // Both reported and pixelCenter are now relative to the same content
  // surface (#preview-video / #captions-canvas share one box) — previously
  // this comparison showed ~8.7px of vertical error from treating
  // .phone-frame's border-inclusive rect as that surface.
  expect(Math.abs(reported.centerX - pixelCenter.centerX)).toBeLessThan(2);
  expect(Math.abs(reported.centerY - pixelCenter.centerY)).toBeLessThan(2);
});
