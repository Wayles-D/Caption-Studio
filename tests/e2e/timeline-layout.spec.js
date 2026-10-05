import { test, expect } from '@playwright/test';

// The timeline's own layout: any lane folds to a slim strip (and stays folded
// across reloads), and the whole panel slides taller or shorter from its top
// edge (remembered too).

async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => { localStorage.removeItem('bhynd.timeline.collapsed'); localStorage.removeItem('bhynd.timeline.height'); });
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
}

const laneHeight = (page, lane) => page.locator(`[data-lane="${lane}"]`).first().evaluate((el) => el.getBoundingClientRect().height);

test('every lane — the video strip included — folds and unfolds, and a fold is remembered', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    window.__audioTimeline.addSoundEvent('tick', 1);
    window.__audioTimeline.addSoundEvent('tick', 3);
  });
  for (const lane of ['video', 'captions', 'text', 'sfx', 'audio']) {
    const open = await laneHeight(page, lane);
    await page.locator(`[data-collapse-lane="${lane}"]`).click();
    const folded = await laneHeight(page, lane);
    expect(folded, `${lane} folds`).toBeLessThan(Math.min(open, 26));
    await expect(page.locator(`[data-collapse-lane="${lane}"]`)).toHaveAttribute('aria-expanded', 'false');
  }
  // A folded lane still shows where its clips are.
  const bars = page.locator('[data-lane="sfx"] .timeline-lane-track > *');
  await expect(bars).toHaveCount(2);
  for (const b of await bars.all()) expect((await b.boundingBox()).width).toBeGreaterThan(2);
  // Unfold one; reload keeps the rest folded.
  await page.locator('[data-collapse-lane="captions"]').click();
  expect(await laneHeight(page, 'captions')).toBeGreaterThan(26);
  await page.reload();
  await page.waitForSelector('[data-collapse-lane="sfx"]');
  const folded = await page.evaluate(() => [...document.querySelectorAll('.is-collapsed')].map((e) => e.dataset.lane).sort());
  expect(folded).toEqual(['audio', 'sfx', 'text', 'video']);
});

test('the timeline slides taller and shorter from its top edge; the preview makes room; double-click resets', async ({ page }) => {
  await setup(page);
  const panel = page.locator('#timeline-panel-container');
  const before = (await panel.boundingBox()).height;
  const frameBefore = (await page.locator('#state-video').boundingBox()).height;
  const h = await page.locator('#timeline-resize-handle').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y - 150, { steps: 8 });
  await page.mouse.up();
  const after = (await panel.boundingBox()).height;
  expect(after - before).toBeGreaterThan(140);
  await page.waitForTimeout(400);
  expect((await page.locator('#state-video').boundingBox()).height, 'the preview shrinks to make room').toBeLessThan(frameBefore);
  // Never past the point the preview would vanish.
  const h2 = await page.locator('#timeline-resize-handle').boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + 2);
  await page.mouse.down();
  await page.mouse.move(h2.x + h2.width / 2, 10, { steps: 8 });
  await page.mouse.up();
  expect((await panel.boundingBox()).height).toBeLessThan(900 - 56 - 80 - 200);
  // Remembered across a reload.
  const kept = (await panel.boundingBox()).height;
  await page.reload();
  await page.waitForSelector('#timeline-panel-container');
  expect(Math.abs((await page.locator('#timeline-panel-container').boundingBox()).height - kept)).toBeLessThan(2);
  // Double-click the edge: back to the default.
  await page.locator('#timeline-resize-handle').dblclick();
  expect(Math.abs((await page.locator('#timeline-panel-container').boundingBox()).height - 272)).toBeLessThan(2);
});
