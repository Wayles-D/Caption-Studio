import { test, expect } from '@playwright/test';

// THE STARTING ZOOM. A video opens at a readable density (44 px per second of
// video — what 7.6x of Fit gave a 3½-minute clip on a laptop), not squeezed
// to Fit. That starting view is labelled 1.0x; + and − count from it, and −
// still reaches Fit. A video already readable at Fit opens at Fit.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto(APP_URL);
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* fine */ } return new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); });
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.waitForTimeout(500);
}

/** Pixels of track per second of video, as laid out. */
const pxPerSecond = (page) => page.evaluate(() => {
  const ruler = document.getElementById('timeline-ruler');
  return ruler.getBoundingClientRect().width / document.getElementById('preview-video').duration;
});
const level = (page) => page.locator('#timeline-zoom-level').textContent();

test('on a laptop, a short video that is readable at Fit opens at Fit', async ({ page }) => {
  await openDemo(page, 1440, 900);
  expect(await level(page)).toBe('Fit');
  expect(await pxPerSecond(page)).toBeGreaterThan(44);
});

test('on a phone the same video opens at the readable density, called 1.0x, and zooms from there', async ({ page }) => {
  await openDemo(page, 390, 844);
  expect(await level(page)).toBe('1.0x');
  const start = await pxPerSecond(page);
  console.log('px per second at the start:', start.toFixed(1));
  expect(start).toBeGreaterThan(42);
  expect(start).toBeLessThan(46);
  // The view starts at the start of the video.
  expect(await page.evaluate(() => document.getElementById('timeline-scroll').scrollLeft)).toBe(0);

  await page.locator('#timeline-zoom-in').click();
  expect(await level(page)).toBe('1.5x');
  expect(await pxPerSecond(page)).toBeCloseTo(start * 1.5, 0);

  // Back below the start, and all the way out to Fit.
  await page.locator('#timeline-zoom-out').click();
  await page.locator('#timeline-zoom-out').click();
  expect(await level(page)).toBe('0.7x');
  for (let i = 0; i < 4; i++) {
    if (await page.locator('#timeline-zoom-out').isDisabled()) break;
    await page.locator('#timeline-zoom-out').click();
  }
  expect(await level(page)).toBe('Fit');

  // Double-click: straight back to the starting zoom.
  await page.locator('#timeline-zoom-level').dblclick();
  expect(await level(page)).toBe('1.0x');
});
