import { test, expect } from '@playwright/test';

// The playhead goes wherever you press on the timeline — not only on the
// ruler and the video strip, but on the empty space of every lane — and
// follows a drag. Clips keep their own gestures.

async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.getByText('Try Demo Video').click();
  return page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
}

const playhead = (page) => page.evaluate(() => document.getElementById('preview-video').currentTime);

/** The screen x of time t on the shared axis, and the vertical middle of a lane's track. */
async function pointOn(page, laneTrack, t) {
  const box = await page.locator(laneTrack).boundingBox();
  const duration = await page.evaluate(() => document.getElementById('preview-video').duration);
  return { x: box.x + (t / duration) * box.width, y: box.y + box.height / 2 };
}

test('pressing empty space on any lane moves the playhead there', async ({ page }) => {
  await setup(page);
  const lanes = ['#timeline-captions-track', '#timeline-text-track', '#timeline-sfx-track', '#timeline-audio-track'];
  let t = 1.5;
  for (const lane of lanes) {
    if (!(await page.locator(lane).count())) continue;
    const p = await pointOn(page, lane, t);
    await page.mouse.click(p.x, p.y);
    expect(Math.abs((await playhead(page)) - t), lane).toBeLessThan(0.15);
    t += 2;
  }
});

test('dragging along a lane scrubs; pressing a clip does not jump the playhead to the press', async ({ page }) => {
  await setup(page);
  const lane = '#timeline-sfx-track';
  const a = await pointOn(page, lane, 1);
  const b = await pointOn(page, lane, 5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  expect(Math.abs((await playhead(page)) - 1)).toBeLessThan(0.15);
  await page.mouse.move(b.x, b.y, { steps: 10 });
  expect(Math.abs((await playhead(page)) - 5)).toBeLessThan(0.15);
  await page.mouse.up();

  // A clip is not empty space: pressing its middle selects/moves IT, and the
  // scrub doesn't take over.
  const id = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 2, text: 'X' }).id);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  const clip = await page.locator(`[data-clip-id="${id}"]`).boundingBox();
  await page.mouse.click(clip.x + clip.width * 0.7, clip.y + clip.height / 2);
  const t = await playhead(page);
  const pressedAt = await page.evaluate(({ x }) => {
    const r = document.getElementById('timeline-text-track').getBoundingClientRect();
    return ((x - r.left) / r.width) * document.getElementById('preview-video').duration;
  }, { x: clip.x + clip.width * 0.7 });
  expect(Math.abs(t - pressedAt)).toBeGreaterThan(0.2);
});
