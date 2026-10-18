import { test, expect } from '@playwright/test';

// SPLIT AT THE PLAYHEAD (src/js/components/splitClip.js) and LIVE CLIP DRAG
// (timelinePanel.js) in the real editor.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.activeElement?.blur());
}

const seek = (page, t) => page.evaluate((time) => new Promise((resolve) => {
  const v = document.getElementById('preview-video');
  v.pause();
  if (Math.abs(v.currentTime - time) < 1e-6) return resolve();
  v.addEventListener('seeked', () => requestAnimationFrame(resolve), { once: true });
  v.currentTime = time;
}), t);

test('a shape splits at the playhead into two halves, and one undo puts it back', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0 });
    window.__shapeLayers.updateShapeLayer(s.id, { start: 1, end: 5 });
    return s.id;
  });
  await seek(page, 3);
  await page.waitForTimeout(200);
  await expect(page.locator('#timeline-split-btn')).toBeEnabled();
  await page.locator('#timeline-split-btn').click();
  const after = await page.evaluate(() => window.__shapeLayers.getShapeLayers().map((s) => [s.id, +s.start.toFixed(2), +s.end.toFixed(2)]));
  expect(after.length).toBe(2);
  expect(after[0][0]).toBe(id);
  expect(after[0][1]).toBe(1);
  expect(after[0][2]).toBe(3);
  expect(after[1][1]).toBe(3);
  expect(after[1][2]).toBe(5);
  expect(after[1][0]).not.toBe(id);
  // One undo, whole again.
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__shapeLayers.getShapeLayers().length)).toBe(1);
  expect(await page.evaluate(() => window.__shapeLayers.getShapeLayers()[0].end)).toBe(5);

  // The S key does the same, and the button is off where there is nothing to cut.
  await page.keyboard.press('s');
  await expect.poll(() => page.evaluate(() => window.__shapeLayers.getShapeLayers().length)).toBe(2);
  await seek(page, 0.2);
  await page.waitForTimeout(250);
  await expect(page.locator('#timeline-split-btn')).toBeDisabled();
});

test('dragging a clip shows it moving, with its new time', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0 });
    window.__shapeLayers.updateShapeLayer(s.id, { start: 1, end: 3 });
  });
  await page.waitForTimeout(400);
  const clip = page.locator('.timeline-text-clip').first();
  await expect(clip).toBeVisible();
  const before = await clip.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2, { steps: 8 });
  // MID-DRAG: the clip has moved on screen and says where it will land.
  const during = await clip.boundingBox();
  expect(during.x, 'the clip follows the pointer').toBeGreaterThan(before.x + 40);
  await expect(page.locator('.timeline-clip-dragtime')).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await clip.boundingBox();
  expect(Math.abs(after.x - during.x), 'it does not jump when released').toBeLessThan(6);
  await expect(page.locator('.timeline-clip-dragtime')).toHaveCount(0);
  expect(await page.evaluate(() => window.__shapeLayers.getShapeLayers()[0].start)).toBeGreaterThan(1.2);
});
