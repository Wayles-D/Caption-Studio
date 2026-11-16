import { test, expect } from '@playwright/test';

// THE ROTATE BUTTON, CapCut-style (canvasTransform.js's rotationNow): a round
// button under the selection box. Dragging it round the object turns it by
// the angle swept since the press — grabbing it never moves anything —
// snapping to right angles; one gesture is one undo step. Also: a box whose
// controls have flipped below it (near the top of the frame) turns the same
// way, with no 180° jump; and a TILTED text's selection box — whole text or
// one word — is drawn through its 3D projection, and a click on what is seen
// hits it.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = 1; });
  await page.waitForTimeout(500);
}

/** Drags the rotate button round the selection box's on-screen centre by `degrees`, in small steps. */
async function turnBy(page, degrees, { release = true } = {}) {
  const box = await page.locator('#caption-transform-box').boundingBox();
  const btn = await page.locator('#caption-transform-handle-rotate').boundingBox();
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const p0 = { x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 };
  const r = Math.hypot(p0.x - c.x, p0.y - c.y);
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  const steps = Math.max(6, Math.ceil(Math.abs(degrees) / 5));
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((degrees * Math.PI) / 180) * (i / steps);
    await page.mouse.move(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
  }
  if (release) await page.mouse.up();
}

test('the rotate button turns a shape by the angle dragged, snaps at 90°, one undo step', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }).id);
  await page.evaluate((i) => window.__shapeLayers.selectShapeLayer(i), id);
  await page.waitForTimeout(400);
  const rot = () => page.evaluate((i) => window.__shapeLayers.getShapeLayer(i).transform.rotation, id);
  const btn = page.locator('#caption-transform-handle-rotate');
  await expect(btn).toBeVisible();
  // Under the box, not above it.
  const box = await page.locator('#caption-transform-box').boundingBox();
  expect((await btn.boundingBox()).y).toBeGreaterThan(box.y + box.height);

  // Grabbing it and letting go changes nothing.
  const b = await btn.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  expect(await rot()).toBe(0);

  await turnBy(page, 30);
  expect(Math.abs((await rot()) - 30)).toBeLessThanOrEqual(1);
  // 30 + 57 = 87: within the snap of a right angle.
  await turnBy(page, 57);
  expect(await rot()).toBe(90);
  // And back the other way past zero — no jump at ±180.
  await turnBy(page, -130);
  expect(Math.abs((await rot()) - (-40))).toBeLessThanOrEqual(1);

  await page.keyboard.press('Control+z');
  expect(await rot()).toBe(90);
  await page.keyboard.press('Control+z');
  expect(Math.abs((await rot()) - 30)).toBeLessThanOrEqual(1);
});

test('a text near the top of the frame (controls flipped below) turns without jumping', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'NEAR THE TOP' }).id);
  await page.evaluate((i) => {
    window.__textElements.updateTextElementStyle(i, { position: 'manual', customPosX: 50, customPosY: 6 });
    window.__textElements.selectTextElement(i);
  }, id);
  await page.waitForTimeout(500);
  const rot = () => page.evaluate((i) => window.__textElements.getTextElement(i).style.rotation || 0, id);
  await turnBy(page, 20);
  expect(Math.abs((await rot()) - 20)).toBeLessThanOrEqual(1);
});

test('a tilted one-word text: its box (and its word box) follow the tilt; a click on what is seen hits it', async ({ page }) => {
  await openDemo(page);
  const id = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'bhYnd' }).id);
  await page.evaluate((i) => {
    window.__textElements.updateTextElementStyle(i, { fontSize: 30, position: 'manual', customPosX: 60, customPosY: 40 });
    window.__textElements.setTextElementTransform3d(i, { enabled: true, rotateY: -50, originX: 100, originY: 50 });
    window.__textElements.selectTextElement(i);
  }, id);
  await page.waitForTimeout(500);
  const transform = () => page.evaluate(() => document.getElementById('caption-transform-box').style.transform);
  expect(await transform()).toContain('matrix3d');

  // The centre of what is drawn: the solid pixels on the text canvas.
  const seen = await page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 150) { const p = (i - 3) / 4; n++; sx += p % c.width; sy += Math.floor(p / c.width); }
    const r = c.getBoundingClientRect();
    return { x: r.left + (sx / n) * (r.width / c.width), y: r.top + (sy / n) * (r.height / c.height) };
  });
  // Deselect, then click where the text is SEEN: it is selected again.
  await page.evaluate(() => window.__textElements.selectTextElement(null));
  await page.waitForTimeout(300);
  await page.mouse.click(seen.x, seen.y);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__appState.selectedTextElementId)).toBe(id);
  // A second click there drills into the word: its box is tilted too.
  await page.mouse.click(seen.x, seen.y);
  await page.waitForTimeout(500);
  await expect(page.locator('#textel-word-editing')).toBeVisible();
  expect(await transform()).toContain('matrix3d');
});
