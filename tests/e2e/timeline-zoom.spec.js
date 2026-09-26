import { test, expect } from '@playwright/test';

// Timeline zoom + horizontal panning.
//
// At 1x the whole clip is squeezed into the panel's width, so on a real
// 40-second video each caption gets a few dozen pixels: its text wraps into an
// unreadable stack and its trim handles are a couple of pixels wide. Zooming
// stretches the rows past the panel and pans instead, which is the only way to
// see what you are editing.
//
// Everything inside a row is positioned as a percentage of it, so widening the
// row stretches clips, ruler ticks and filmstrip tiles together — the tests
// below check that that actually holds, rather than just that a number changed.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'HERE', start: 0.0, end: 0.4 },
      { word: 'ARE', start: 0.4, end: 0.8 },
      { word: 'FIVE', start: 0.8, end: 1.3 },
      { word: 'HOME', start: 6.0, end: 6.4 },
      { word: 'OFFICE', start: 6.4, end: 6.9 },
      { word: 'HACKS', start: 6.9, end: 7.4 }
    ].map((w, i) => ({ ...w, wordIndex: i }));
    const phrases = [
      { start: 0.0, end: 1.3, breakAfterIndices: [], words: words.slice(0, 3) },
      { start: 6.0, end: 7.4, breakAfterIndices: [], words: words.slice(3) }
    ];
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
  });
  await page.waitForTimeout(700);
}

const metrics = (page) => page.evaluate(() => {
  const scroll = document.getElementById('timeline-scroll');
  const ruler = document.getElementById('timeline-ruler');
  const clip = document.querySelector('#timeline-captions-track .timeline-text-clip.is-transcript');
  return {
    scrollWidth: scroll.scrollWidth,
    clientWidth: scroll.clientWidth,
    scrollLeft: scroll.scrollLeft,
    rulerWidth: Math.round(ruler.getBoundingClientRect().width),
    clipWidth: clip ? Math.round(clip.getBoundingClientRect().width) : 0,
    level: document.getElementById('timeline-zoom-level').textContent
  };
});

test('the timeline starts fitted, with nothing to scroll', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const m = await metrics(page);
  console.log('fitted:', JSON.stringify(m));
  expect(m.level).toBe('Fit');
  // No horizontal overflow at 1x — the rows fill the panel exactly, which is
  // how the timeline has always behaved.
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth + 2);
  await expect(page.locator('#timeline-zoom-out')).toBeDisabled();
  expect(errs).toEqual([]);
});

test('zooming in stretches the rows and the caption clips with them', async ({ page }) => {
  await setup(page);
  const before = await metrics(page);

  await page.locator('#timeline-zoom-in').click();
  await page.locator('#timeline-zoom-in').click();
  await page.waitForTimeout(500);

  const after = await metrics(page);
  console.log('zoomed:', JSON.stringify(after));

  // The content is now wider than the panel, so it pans.
  expect(after.scrollWidth).toBeGreaterThan(after.clientWidth + 50);
  // The ruler grew with it...
  expect(after.rulerWidth).toBeGreaterThan(before.rulerWidth * 1.8);
  // ...and so did the caption clip, which is the entire point: at 1x its text
  // has nowhere to go but wrap.
  expect(after.clipWidth).toBeGreaterThan(before.clipWidth * 1.8);
  expect(after.level).not.toBe('Fit');
});

test('zooming back out returns to a fitted timeline', async ({ page }) => {
  await setup(page);
  const fitted = await metrics(page);

  await page.locator('#timeline-zoom-in').click();
  await page.locator('#timeline-zoom-in').click();
  await page.waitForTimeout(400);
  expect((await metrics(page)).scrollWidth).toBeGreaterThan(fitted.clientWidth + 50);

  await page.locator('#timeline-zoom-out').click();
  await page.locator('#timeline-zoom-out').click();
  await page.waitForTimeout(500);

  const back = await metrics(page);
  console.log('back to fit:', JSON.stringify(back));
  expect(back.level).toBe('Fit');
  expect(back.scrollWidth).toBeLessThanOrEqual(back.clientWidth + 2);
  expect(back.rulerWidth).toBeCloseTo(fitted.rulerWidth, -1);
});

test('lane labels stay pinned while the tracks pan', async ({ page }) => {
  await setup(page);
  await page.locator('#timeline-zoom-in').click();
  await page.locator('#timeline-zoom-in').click();
  await page.waitForTimeout(400);

  const labelBefore = await page.evaluate(() =>
    Math.round(document.querySelector('#timeline-captions-track')
      .closest('.timeline-lane').querySelector('.timeline-lane-gutter').getBoundingClientRect().left));

  await page.evaluate(() => { document.getElementById('timeline-scroll').scrollLeft = 300; });
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    scrollLeft: document.getElementById('timeline-scroll').scrollLeft,
    labelLeft: Math.round(document.querySelector('#timeline-captions-track')
      .closest('.timeline-lane').querySelector('.timeline-lane-gutter').getBoundingClientRect().left)
  }));
  console.log('panned to', after.scrollLeft, '| label left', labelBefore, '->', after.labelLeft);

  expect(after.scrollLeft).toBeGreaterThan(200);
  // Scrolling a lane away from its own name would make a zoomed timeline
  // unreadable, so the gutter is sticky.
  expect(Math.abs(after.labelLeft - labelBefore)).toBeLessThan(2);
});

test('a caption can still be dragged while zoomed in', async ({ page }) => {
  await setup(page);
  await page.locator('#timeline-zoom-in').click();
  // Zoom anchors on the panel centre, so the first caption (at t=0) is now
  // panned off to the left — scroll back to the start to reach it.
  await page.evaluate(() => { document.getElementById('timeline-scroll').scrollLeft = 0; });
  await page.waitForTimeout(500);

  const before = (await page.evaluate(() => window.__appState.captionEvents))[0];
  const clip = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').first();
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = (await page.evaluate(() => window.__appState.captionEvents)).find((e) => e.id === before.id);
  console.log('zoomed drag:', before.start.toFixed(2), '->', after.start.toFixed(2));
  // Zoomed in, the same pixel drag covers LESS time — the drag must be read
  // against the stretched track, not the panel.
  expect(after.start).toBeGreaterThan(before.start + 0.2);
  expect(after.end - after.start).toBeCloseTo(before.end - before.start, 1);
});

test('the label column stays opaque and full height while tracks pan under it', async ({ page }) => {
  await setup(page);
  await page.locator('#timeline-zoom-in').click();
  await page.locator('#timeline-zoom-in').click();
  await page.evaluate(() => { document.getElementById('timeline-scroll').scrollLeft = 600; });
  await page.waitForTimeout(500);

  const geo = await page.evaluate(() => {
    const lane = document.querySelector('#timeline-captions-track').closest('.timeline-lane');
    const gutter = lane.querySelector('.timeline-lane-gutter');
    const track = lane.querySelector('.timeline-lane-track');
    const g = gutter.getBoundingClientRect();
    const t = track.getBoundingClientRect();
    return {
      gutterHeight: Math.round(g.height),
      laneHeight: Math.round(lane.getBoundingClientRect().height),
      // The track genuinely extends left underneath the gutter — otherwise
      // this test would pass without the masking mattering.
      trackLeft: Math.round(t.left),
      gutterLeft: Math.round(g.left),
      // What is painted at the gutter's centre, and just inside its edges?
      atCentre: document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2)?.closest('.timeline-lane-gutter') ? 'gutter' : 'other',
      atTop: document.elementFromPoint(g.left + g.width / 2, g.top + 3)?.closest('.timeline-lane-gutter') ? 'gutter' : 'other',
      atBottom: document.elementFromPoint(g.left + g.width / 2, g.bottom - 3)?.closest('.timeline-lane-gutter') ? 'gutter' : 'other'
    };
  });
  console.log('gutter masking:', JSON.stringify(geo));

  expect(geo.trackLeft).toBeLessThan(geo.gutterLeft);
  // The rows are `align-items: center`, which sizes a grid item to its
  // content — the gutter used to be only as tall as its label (15px in a
  // 36px lane), so scrolled clips reappeared above and below it.
  expect(geo.gutterHeight).toBe(geo.laneHeight);
  expect(geo.atCentre).toBe('gutter');
  expect(geo.atTop).toBe('gutter');
  expect(geo.atBottom).toBe('gutter');
});
