import { test, expect } from '@playwright/test';

// The filmstrip is virtualized against the timeline's zoom.
//
// It used to sample a fixed number of frames across the WHOLE clip and stretch
// them to fill the row, capped at 40 tiles. Zooming asked for more frames, hit
// the cap, and the tiles were stretched instead: on a portrait clip a frame's
// natural width at the 44px row height is ~25px, so at 2.3x zoom each was
// drawn ~72px wide — about 3x its own size, which is the enormous, soft strip
// that got reported.
//
// Tiles now sit on a fixed time grid at their natural width however far the
// timeline is zoomed, and only the slots inside the visible window (plus a
// margin) are mounted and extracted. The cost is bounded by how many tiles fit
// on screen rather than by the length of the clip.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function loadDemo(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  // Wait for at least a couple of real frames so widths are measured on a
  // strip that has actually been built.
  await page.waitForFunction(
    () => document.querySelectorAll('.timeline-filmstrip-tile.is-loaded').length >= 2,
    null,
    { timeout: 90000 }
  );
}

const strip = (page) => page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.timeline-filmstrip-tile')];
  const widths = tiles.map((t) => t.getBoundingClientRect().width);
  const track = document.getElementById('timeline-filmstrip-track');
  return {
    count: tiles.length,
    trackWidth: Math.round(track.getBoundingClientRect().width),
    medianWidth: widths.length ? +widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)].toFixed(1) : 0,
    images: tiles.map((t) => t.style.backgroundImage).filter(Boolean).length
  };
});

const waitForFrames = (page, atLeast) => page.waitForFunction(
  (n) => document.querySelectorAll('.timeline-filmstrip-tile.is-loaded').length >= n,
  atLeast,
  { timeout: 90000 }
);

test('zooming multiplies frames instead of stretching them', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await loadDemo(page);

  const fitted = await strip(page);
  console.log('fitted strip:', JSON.stringify(fitted));
  expect(fitted.count).toBeGreaterThanOrEqual(4);

  for (let i = 0; i < 3; i++) await page.locator('#timeline-zoom-in').click();
  await waitForFrames(page, 2);
  await page.waitForTimeout(1500);

  const zoomed = await strip(page);
  console.log('zoomed strip:', JSON.stringify(zoomed));

  // The track really did get much wider — otherwise this proves nothing.
  expect(zoomed.trackWidth).toBeGreaterThan(fitted.trackWidth * 2);

  // THE POINT: a tile is still about the same size on screen. Before, the
  // count was capped so each tile ballooned with the zoom.
  const ratio = zoomed.medianWidth / fitted.medianWidth;
  console.log('tile width ratio fitted -> zoomed:', ratio.toFixed(2));
  expect(ratio).toBeLessThan(2.2);

  // ...and the strip is virtualized, so the DOM does not grow without bound
  // even though the clip now spans far more slots than fit on screen.
  expect(zoomed.count).toBeLessThanOrEqual(80);
  expect(errs).toEqual([]);
});

test('panning mounts the new window and drops what scrolled away', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);
  for (let i = 0; i < 4; i++) await page.locator('#timeline-zoom-in').click();
  await waitForFrames(page, 2);
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => ({
    count: document.querySelectorAll('.timeline-filmstrip-tile').length,
    lefts: [...document.querySelectorAll('.timeline-filmstrip-tile')].map((t) => t.style.left)
  }));

  await page.evaluate(() => { document.getElementById('timeline-scroll').scrollLeft = 2500; });
  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => ({
    count: document.querySelectorAll('.timeline-filmstrip-tile').length,
    lefts: [...document.querySelectorAll('.timeline-filmstrip-tile')].map((t) => t.style.left)
  }));
  console.log('tiles before/after pan:', before.count, after.count);

  // A different part of the clip is mounted now...
  const moved = after.lefts.filter((l) => !before.lefts.includes(l)).length;
  console.log('newly mounted tiles:', moved, 'of', after.count);
  expect(moved).toBeGreaterThan(0);
  // ...and the row did not simply accumulate every tile it has ever shown.
  expect(after.count).toBeLessThanOrEqual(80);
});

test('tiles stay flush and land on the time axis at every zoom', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);
  for (let i = 0; i < 2; i++) await page.locator('#timeline-zoom-in').click();
  await waitForFrames(page, 2);
  await page.waitForTimeout(1200);

  const geo = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.timeline-filmstrip-tile')]
      .map((t) => ({ el: t, r: t.getBoundingClientRect() }))
      .sort((a, b) => a.r.left - b.r.left);
    const gaps = [];
    for (let i = 1; i < tiles.length; i++) gaps.push(tiles[i].r.left - tiles[i - 1].r.right);
    return {
      gaps,
      // Percentage positioning, so the strip re-flows with the editor rather
      // than carrying baked-in pixel coordinates.
      allPercent: tiles.every((t) => t.el.style.left.includes('%') && t.el.style.width.includes('%'))
    };
  });
  console.log('max gap:', Math.max(...geo.gaps.map(Math.abs)).toFixed(2));

  expect(geo.allPercent).toBe(true);
  // A filmstrip, not a row of cards.
  expect(Math.max(...geo.gaps.map(Math.abs))).toBeLessThan(1.5);
});

test('zooming back out reuses the frames it already extracted', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await loadDemo(page);

  // Zoom in and let the finer grid populate.
  for (let i = 0; i < 2; i++) await page.locator('#timeline-zoom-in').click();
  await waitForFrames(page, 3);
  await page.waitForTimeout(1800);

  const zoomedUrls = await page.evaluate(() =>
    [...document.querySelectorAll('.timeline-filmstrip-tile')]
      .map((t) => t.style.backgroundImage)
      .filter((b) => /url\("blob:/.test(b)));
  expect(zoomedUrls.length).toBeGreaterThan(2);

  // Back out. The sample grid DOUBLES, so the coarser grid's times are a
  // subset of the finer one's and those frames are already cached.
  for (let i = 0; i < 2; i++) await page.locator('#timeline-zoom-out').click();
  // Deliberately short: a fresh extraction is a seek+decode+encode per frame
  // and could not complete in this window.
  await page.waitForTimeout(600);

  const afterUrls = await page.evaluate(() =>
    [...document.querySelectorAll('.timeline-filmstrip-tile')]
      .map((t) => t.style.backgroundImage)
      .filter((b) => /url\("blob:/.test(b)));

  const reused = afterUrls.filter((u) => zoomedUrls.includes(u));
  console.log('blob URLs: zoomed', zoomedUrls.length, '| after zoom-out', afterUrls.length, '| reused', reused.length);
  // The SAME object URLs came back — the frames were served from cache
  // rather than re-extracted, which is the whole point of a doubling grid.
  expect(reused.length).toBeGreaterThan(0);
});
