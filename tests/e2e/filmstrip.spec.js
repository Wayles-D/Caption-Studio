import { test, expect } from '@playwright/test';

/**
 * The timeline's video filmstrip (src/js/components/filmstrip.js). These assert
 * the properties that are expensive to re-establish by hand: that tiles are
 * REAL frames rather than placeholders, that the strip shares the existing
 * playhead/time system instead of building a second one, that clicking it seeks
 * the authoritative #preview-video, and — the one most likely to regress — that
 * caption edits never trigger thumbnail regeneration.
 */

const TRACK = '#timeline-filmstrip-track';
const TILE = '.timeline-filmstrip-tile';

async function loadDemo(page) {
  await page.goto('http://localhost:5173');
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => {
    const v = document.getElementById('preview-video');
    return v && v.duration > 0 && v.videoWidth > 0;
  }, { timeout: 30000 });
}

/** Waits until at least `n` tiles have a real extracted frame painted in. */
async function waitForLoadedTiles(page, n = 1, timeout = 60000) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.timeline-filmstrip-tile.is-loaded').length >= count,
    n,
    { timeout }
  );
}

test('filmstrip renders real video frames and shares the existing timeline', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);

  // The row exists and sits inside the SAME scroll container as the playhead,
  // which is what makes the one existing playhead span it.
  const inScroll = await page.evaluate(() => {
    const track = document.querySelector('#timeline-filmstrip-track');
    const scroll = document.getElementById('timeline-scroll');
    const playhead = document.getElementById('timeline-playhead');
    return {
      trackInScroll: !!(track && scroll && scroll.contains(track)),
      playheadInScroll: !!(playhead && scroll && scroll.contains(playhead)),
      playheadCount: document.querySelectorAll('.timeline-playhead').length
    };
  });
  expect(inScroll.trackInScroll).toBe(true);
  expect(inScroll.playheadInScroll).toBe(true);
  // Exactly ONE playhead in the app — no second indicator was introduced.
  expect(inScroll.playheadCount).toBe(1);

  await waitForLoadedTiles(page, 1);

  const stats = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.timeline-filmstrip-tile')];
    return {
      total: tiles.length,
      loaded: tiles.filter((t) => t.classList.contains('is-loaded')).length,
      // Real extracted frames are blob: URLs produced by canvas.toBlob.
      blobBacked: tiles.filter((t) => /url\("blob:/.test(t.style.backgroundImage)).length,
      widths: [...new Set(tiles.map((t) => t.style.width))]
    };
  });
  console.log('filmstrip stats:', JSON.stringify(stats));

  expect(stats.total).toBeGreaterThanOrEqual(4);
  expect(stats.total).toBeLessThanOrEqual(40);
  expect(stats.blobBacked).toBeGreaterThan(0);
  // Tiles are sized in PERCENT so the strip re-flows with the editor.
  expect(stats.widths.every((w) => w.includes('%'))).toBe(true);

  // Tiles must be flush — a filmstrip, not a row of cards.
  const gaps = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.timeline-filmstrip-tile')];
    const out = [];
    for (let i = 1; i < tiles.length; i++) {
      out.push(tiles[i].getBoundingClientRect().left - tiles[i - 1].getBoundingClientRect().right);
    }
    return out;
  });
  expect(Math.max(...gaps.map(Math.abs))).toBeLessThan(1.5);
});

test('clicking the filmstrip seeks the authoritative video', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);
  await waitForLoadedTiles(page, 1);

  const box = await page.locator(TRACK).boundingBox();
  // Click at ~70% across and assert the REAL video element moved there.
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.waitForTimeout(300);

  const { currentTime, duration } = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    return { currentTime: v.currentTime, duration: v.duration };
  });
  expect(currentTime / duration).toBeGreaterThan(0.6);
  expect(currentTime / duration).toBeLessThan(0.8);
});

test('playhead tracks the video across the filmstrip', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);
  await waitForLoadedTiles(page, 1);

  const readPlayhead = () => page.evaluate(() => {
    const ph = document.getElementById('timeline-playhead');
    const track = document.querySelector('#timeline-filmstrip-track');
    const phRect = ph.getBoundingClientRect();
    const tRect = track.getBoundingClientRect();
    const v = document.getElementById('preview-video');
    return {
      // Playhead position as a fraction of the filmstrip track.
      fraction: (phRect.left - tRect.left) / tRect.width,
      videoFraction: v.currentTime / v.duration
    };
  });

  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForTimeout(400);
  const atStart = await readPlayhead();

  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.currentTime = v.duration * 0.5;
  });
  await page.waitForTimeout(400);
  const atMid = await readPlayhead();

  console.log('playhead start:', JSON.stringify(atStart), 'mid:', JSON.stringify(atMid));
  // The playhead must track the video's own time, on the filmstrip's axis.
  expect(Math.abs(atMid.fraction - atMid.videoFraction)).toBeLessThan(0.05);
  expect(atMid.fraction).toBeGreaterThan(atStart.fraction + 0.3);
});

test('caption edits do not regenerate thumbnails', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);
  // Wait for extraction to FINISH, not merely to start. Sampling mid-extraction
  // makes progressive tiles still arriving look like a regeneration.
  await page.waitForFunction(
    () => {
      const track = document.querySelector('#timeline-filmstrip-track');
      return track && !track.classList.contains('is-loading');
    },
    null,
    { timeout: 90000 }
  );

  // Identity of the painted frames before any caption edit.
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('.timeline-filmstrip-tile')].map((t) => t.style.backgroundImage)
  );

  // Caption-only state changes across every axis the brief calls out.
  await page.evaluate(() => {
    window.__updateState({
      customPosX: 30, customPosY: 60,
      textOpacity: 55,
      rotation: 12,
      fontSize: 20,
      currentPreset: 'caps-white',
      captionMode: 'rolling-stack'
    }, { recordHistory: false });
  });
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() =>
    [...document.querySelectorAll('.timeline-filmstrip-tile')].map((t) => t.style.backgroundImage)
  );

  // Same tiles, same blob URLs — nothing was re-extracted.
  expect(after).toEqual(before);
});
