import { test, expect } from '@playwright/test';

// TRIMMING AND CUTTING A SOUND EFFECT (shared/audioTimeline.js,
// src/js/components/splitClip.js, timelinePanel.js).
//
// A sound effect is a REAL CLIP: as long as the sound it plays, showing that
// sound's waveform, with a trim handle at each end and Replace still on it.
//
// Trimming the START keeps the clip's TAIL where it is and plays from further
// INTO the asset — which is the whole point: a riser whose swell must land on
// a beat is trimmed from the head, because moving it would change when it
// resolves.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.activeElement?.blur());
}

const sfx = (page) => page.evaluate(() => window.__audioTimeline.getSoundEvents()[0]);

test('a sound effect can be trimmed at both edges and put back to full length', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__audioTimeline.addSoundEvent('writing-pencil-circle', 2).id);
  const before = await sfx(page);
  expect(before.trimStart).toBe(0);
  expect(before.duration).toBeNull();

  // Trim the END: it simply stops sooner, and stays where it was.
  await page.evaluate((i) => window.__audioTimeline.trimSoundEvent(i, 'end', 2.4), id);
  let now = await sfx(page);
  expect(now.startTime).toBeCloseTo(2, 3);
  expect(now.duration).toBeCloseTo(0.4, 2);

  // Trim the START: the head moves, it plays from further in, and the END
  // does not move.
  const endBefore = now.startTime + now.duration;
  await page.evaluate((i) => window.__audioTimeline.trimSoundEvent(i, 'start', 2.15), id);
  now = await sfx(page);
  expect(now.startTime).toBeCloseTo(2.15, 2);
  expect(now.trimStart).toBeCloseTo(0.15, 2);
  expect(now.startTime + now.duration, 'the tail stays put').toBeCloseTo(endBefore, 2);

  // Never longer than what is left of the asset.
  await page.evaluate((i) => window.__audioTimeline.trimSoundEvent(i, 'end', 99), id);
  now = await sfx(page);
  expect(now.startTime + now.duration).toBeLessThan(2.15 + 0.7);

  // Back to its full length.
  await page.evaluate((i) => window.__audioTimeline.resetSoundEventTrim(i), id);
  now = await sfx(page);
  expect(now.trimStart).toBe(0);
  expect(now.duration).toBeNull();
});

test('a sound clip shows its length, waveform, handles and Replace without being selected first', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__audioTimeline.addSoundEvent('writing-pencil-circle', 2).id);
  await page.waitForTimeout(800);
  const clip = page.locator(`.timeline-sfx-clip[data-clip-id="${id}"]`);
  await expect(clip).toHaveCount(1);
  // Nothing selected, and it is still a trimmable clip.
  await page.evaluate(() => window.__audioTimeline.selectClip(null));
  await page.waitForTimeout(400);
  await expect(clip).toHaveClass(/is-trimming/);
  await expect(clip.locator('.timeline-sfx-clip-wave')).toHaveCount(1);
  await expect(clip.locator('[data-sfx-handle="start"]')).toHaveCount(1);
  await expect(clip.locator('[data-sfx-handle="end"]')).toHaveCount(1);
  await expect(clip.locator('[data-replace-clip]'), 'Replace is still there').toHaveCount(1);

  // Dragging the end handle shortens it, and the way back appears.
  const box = await clip.locator('[data-sfx-handle="end"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 30, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await sfx(page);
  expect(after.duration).not.toBeNull();
  expect(after.duration).toBeLessThan(0.699);
  await expect(clip.locator('[data-sfx-full]')).toHaveCount(1);
});

// A CLASSIC sound, not one of the generated pack. These had no measured
// length in the registry, so their clips had no width, no handles and no
// waveform — which is what made a 5s riser impossible to place.
test('a classic sound (the 5s Reverse Riser) is trimmable, waveformed and can be cut in two', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__audioTimeline.addSoundEvent('riser-reverse', 1).id);
  await page.waitForTimeout(1200);
  const clip = page.locator(`.timeline-sfx-clip[data-clip-id="${id}"]`);
  await expect(clip).toHaveClass(/is-trimming/);
  await expect(clip.locator('[data-sfx-handle="start"]')).toHaveCount(1);
  await expect(clip.locator('.timeline-sfx-clip-wave')).toHaveCount(1);
  const box = await clip.boundingBox();
  expect(box.width, 'a 5s sound is a wide clip, not a capsule').toBeGreaterThan(200);

  // Trim the start: the tail stays put.
  const endBefore = 1 + (await page.evaluate(() => window.__audioTimeline.getSoundEvents()[0].duration ?? 5.06));
  await page.evaluate((i) => window.__audioTimeline.trimSoundEvent(i, 'start', 2.5), id);
  const after = await sfx(page);
  expect(after.trimStart).toBeCloseTo(1.5, 1);
  expect(after.startTime + after.duration).toBeCloseTo(endBefore, 1);

  // Cut it in two at the playhead, through the real path: select it, press S.
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 4; });
  await page.waitForTimeout(300);
  await page.evaluate((i) => window.__audioTimeline.selectClip(i), id);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('s');
  await page.waitForTimeout(400);
  const halves = await page.evaluate(() => window.__audioTimeline.getSoundEvents()
    .map((e) => ({ start: e.startTime, trimStart: e.trimStart || 0, duration: e.duration })));
  expect(halves.length).toBe(2);
  expect(halves[1].start).toBeCloseTo(4, 1);
  // The second half plays from exactly where the first stopped, so the two
  // together are the sound that was there.
  expect(halves[1].trimStart).toBeCloseTo(halves[0].trimStart + halves[0].duration, 1);
});
