import { test, expect } from '@playwright/test';

// The timeline viewport follows the playhead during playback.
//
// Once the timeline can be wider than its panel (see timeline-zoom.spec.js),
// the playhead walks off the right edge during playback and the user has to
// chase it by hand. The viewport now follows it instead.
//
// The anchor is a FRACTION of the visible track, never a pixel literal, and
// it is expressed against the same time -> pixel conversion the playhead is
// drawn by — so it adapts to panel width, zoom level and window size by
// construction rather than by a parallel pixels-per-second calculation.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page, { zoomClicks = 3 } = {}) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.waitForTimeout(500);
  // Zoom in so the timeline is genuinely wider than the panel — at Fit there
  // is nothing to follow, which is itself asserted below.
  for (let i = 0; i < zoomClicks; i++) await page.locator('#timeline-zoom-in').click();
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForTimeout(500);
}

/** Where the playhead sits INSIDE the visible viewport, and the scroll state. */
const viewport = (page) => page.evaluate(() => {
  const scroll = document.getElementById('timeline-scroll');
  const playhead = document.getElementById('timeline-playhead');
  const contentX = parseFloat(playhead.style.left) || 0;
  return {
    scrollLeft: Math.round(scroll.scrollLeft),
    maxScroll: Math.round(scroll.scrollWidth - scroll.clientWidth),
    clientWidth: scroll.clientWidth,
    // Negative or > clientWidth means the playhead is off screen.
    viewportX: Math.round(contentX - scroll.scrollLeft),
    currentTime: document.getElementById('preview-video').currentTime
  };
});

const play = (page, seconds) => page.evaluate(async (s) => {
  const v = document.getElementById('preview-video');
  v.muted = true;
  await v.play();
  await new Promise((r) => setTimeout(r, s * 1000));
  v.pause();
}, seconds);

test('the playhead never leaves the viewport during playback', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const start = await viewport(page);
  expect(start.maxScroll).toBeGreaterThan(100); // genuinely pannable
  expect(start.scrollLeft).toBe(0);

  // Sample the playhead's viewport position throughout a real play.
  const samples = await page.evaluate(async () => {
    const v = document.getElementById('preview-video');
    const scroll = document.getElementById('timeline-scroll');
    const playhead = document.getElementById('timeline-playhead');
    const out = [];
    v.muted = true;
    await v.play();
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const contentX = parseFloat(playhead.style.left) || 0;
      out.push({
        t: +v.currentTime.toFixed(2),
        viewportX: Math.round(contentX - scroll.scrollLeft),
        scrollLeft: Math.round(scroll.scrollLeft),
        w: scroll.clientWidth
      });
    }
    v.pause();
    return out;
  });

  const offscreen = samples.filter((s) => s.viewportX < 0 || s.viewportX > s.w);
  console.log('first/last sample:', JSON.stringify(samples[0]), JSON.stringify(samples[samples.length - 1]));
  console.log('offscreen samples:', offscreen.length, 'of', samples.length);
  expect(offscreen).toEqual([]);

  // It actually followed — the viewport moved rather than the playhead just
  // never reaching the edge.
  expect(samples[samples.length - 1].scrollLeft).toBeGreaterThan(50);
  expect(errs).toEqual([]);
});

test('the playhead settles at a stable anchor and the content slides under it', async ({ page }) => {
  await setup(page);

  const samples = await page.evaluate(async () => {
    const v = document.getElementById('preview-video');
    const scroll = document.getElementById('timeline-scroll');
    const playhead = document.getElementById('timeline-playhead');
    const out = [];
    v.muted = true;
    await v.play();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const contentX = parseFloat(playhead.style.left) || 0;
      out.push({ viewportX: Math.round(contentX - scroll.scrollLeft), scrollLeft: Math.round(scroll.scrollLeft) });
    }
    v.pause();
    return out;
  });

  // Once following has begun, the playhead stops advancing across the panel
  // and stays put while scrollLeft climbs.
  const following = samples.filter((s) => s.scrollLeft > 20);
  expect(following.length).toBeGreaterThan(3);
  const xs = following.map((s) => s.viewportX);
  const spread = Math.max(...xs) - Math.min(...xs);
  console.log('anchored viewportX range:', Math.min(...xs), '-', Math.max(...xs), '| spread', spread);
  // A stable anchor, not a sweep across the panel.
  expect(spread).toBeLessThan(60);

  // ...and the scroll advanced steadily rather than in a few big jumps.
  const deltas = [];
  for (let i = 1; i < following.length; i++) deltas.push(following[i].scrollLeft - following[i - 1].scrollLeft);
  const maxDelta = Math.max(...deltas);
  console.log('scroll deltas per 250ms:', JSON.stringify(deltas));
  expect(maxDelta).toBeLessThan(following[0].scrollLeft + 400);
});

test('seeking outside the viewport brings that moment into view', async ({ page }) => {
  await setup(page, { zoomClicks: 4 });

  const before = await viewport(page);
  expect(before.scrollLeft).toBe(0);

  // Jump well past the visible range, paused.
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 10; });
  await page.waitForTimeout(700);

  const after = await viewport(page);
  console.log('after seek to 10s:', JSON.stringify(after));
  expect(after.currentTime).toBeCloseTo(10, 0);
  // On screen, not merely scrolled somewhere.
  expect(after.viewportX).toBeGreaterThanOrEqual(0);
  expect(after.viewportX).toBeLessThanOrEqual(after.clientWidth);
  expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);

  // Seeking backwards pulls it back too.
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0.5; });
  await page.waitForTimeout(700);
  const back = await viewport(page);
  console.log('after seek back to 0.5s:', JSON.stringify(back));
  expect(back.viewportX).toBeGreaterThanOrEqual(0);
  expect(back.viewportX).toBeLessThanOrEqual(back.clientWidth);
});

test('scrolling manually during playback stops the timeline fighting you', async ({ page }) => {
  await setup(page);

  // Let it start following, then take over.
  await play(page, 2.5);
  const following = await viewport(page);
  expect(following.scrollLeft).toBeGreaterThan(20);

  const held = await page.evaluate(async () => {
    const v = document.getElementById('preview-video');
    const scroll = document.getElementById('timeline-scroll');
    v.muted = true;
    await v.play();
    // A user-initiated scroll back to the start.
    scroll.dispatchEvent(new Event('scroll'));
    scroll.scrollLeft = 0;
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 1500));
    const out = { scrollLeft: Math.round(scroll.scrollLeft), t: v.currentTime };
    v.pause();
    return out;
  });
  console.log('after manual scroll during playback:', JSON.stringify(held));
  // The viewport stayed where the user put it instead of snapping back every
  // frame; playback carried on regardless.
  expect(held.scrollLeft).toBeLessThan(40);
  expect(held.t).toBeGreaterThan(2.5);

  // Pressing play again is the user asking to see the playhead once more.
  await page.evaluate(async () => {
    const v = document.getElementById('preview-video');
    v.muted = true;
    await v.play();
    await new Promise((r) => setTimeout(r, 900));
    v.pause();
  });
  const resumed = await viewport(page);
  console.log('after pressing play again:', JSON.stringify(resumed));
  expect(resumed.scrollLeft).toBeGreaterThan(50);
});

test('a fitted timeline never scrolls, and following respects the end of the clip', async ({ page }) => {
  // No zoom: the whole clip is on screen, so there is nothing to follow.
  await setup(page, { zoomClicks: 0 });
  const fitted = await viewport(page);
  expect(fitted.maxScroll).toBeLessThanOrEqual(1);

  await play(page, 2);
  const afterFitted = await viewport(page);
  console.log('fitted during playback:', JSON.stringify(afterFitted));
  expect(afterFitted.scrollLeft).toBe(0);

  // Zoomed, near the end: the viewport must stop at the content boundary
  // rather than overscrolling past it.
  for (let i = 0; i < 3; i++) await page.locator('#timeline-zoom-in').click();
  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.currentTime = Math.max(0, v.duration - 0.6);
  });
  await page.waitForTimeout(800);

  const end = await viewport(page);
  console.log('near the end:', JSON.stringify(end));
  expect(end.scrollLeft).toBeLessThanOrEqual(end.maxScroll);
  expect(end.scrollLeft).toBeGreaterThanOrEqual(0);
  expect(end.viewportX).toBeLessThanOrEqual(end.clientWidth);
});
