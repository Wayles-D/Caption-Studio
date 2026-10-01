import { test, expect } from '@playwright/test';

// The playhead line must run the full height of the lanes, including when
// stacked clips make them taller than the timeline panel (reported: with many
// sound effects stacked, the line stopped partway down and the lower lanes had
// no playhead at all).
const APP_URL = 'http://localhost:5173/?splash=0';

test('the playhead reaches the bottom lane when the lanes outgrow the panel', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));

  // Enough near-simultaneous effects to stack into many rows.
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) window.__audioTimeline.addSoundEvent('tick', 2 + i * 0.02);
    document.getElementById('preview-video').currentTime = 2.1;
  });
  await page.waitForTimeout(600);

  const measure = () => page.evaluate(() => {
    const scroll = document.querySelector('.timeline-scroll');
    const lanes = document.getElementById('timeline-lanes');
    const line = document.getElementById('timeline-playhead').getBoundingClientRect();
    const lanesBox = lanes.getBoundingClientRect();
    return { overflows: scroll.scrollHeight > scroll.clientHeight + 4, lineBottom: line.bottom, lanesBottom: lanesBox.bottom, lineTop: line.top, lanesTop: lanesBox.top };
  });

  const before = await measure();
  expect(before.overflows).toBe(true);

  // Scrolled all the way down: the line still runs to the bottom of the last lane.
  await page.evaluate(() => { const s = document.querySelector('.timeline-scroll'); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(300);
  const after = await measure();
  console.log('scrolled to bottom:', JSON.stringify(after));
  expect(after.lineBottom).toBeGreaterThanOrEqual(after.lanesBottom - 1);

  // And it shrinks back once the rows go away.
  await page.evaluate(() => window.__updateState({ soundEvents: [] }, { recordHistory: false }));
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => {
    const scroll = document.querySelector('.timeline-scroll');
    const lanes = document.getElementById('timeline-lanes');
    return { lineHeight: document.getElementById('timeline-playhead').offsetHeight, content: Math.max(scroll.clientHeight, lanes.offsetTop + lanes.offsetHeight) };
  });
  console.log('after clearing:', JSON.stringify(cleared));
  // Exactly the (now shorter) content height — it did not stay stretched.
  expect(cleared.lineHeight).toBe(cleared.content);
  expect(cleared.lineHeight).toBeLessThan(after.lanesBottom - after.lineTop);
});
