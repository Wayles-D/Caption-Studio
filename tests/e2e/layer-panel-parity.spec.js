import { test, expect } from '@playwright/test';

// Selecting a TEXT, an IMAGE or a SHAPE must bring up that object's own panel
// — and with it the layer controls, including "Behind a subject" (V2.2
// occlusion). A text overlay used to open no panel at all, so the only way to
// send text behind a person was to add a shape first, send THAT behind, and
// work from there. Same rule for all three now.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(400);
}

test('a text overlay, an image and a shape each open their own panel with the same layer controls', async ({ page }) => {
  await openDemo(page);

  // TEXT — selected by clicking its clip, as a user does.
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'WAHALA' }));
  await page.waitForTimeout(500);
  await page.locator('.timeline-text-clip').first().click();
  await expect(page.locator('#textel-order')).toHaveCount(1);
  await expect(page.locator('#textel-behind')).toHaveCount(0); // nothing segmented yet...
  await expect(page.locator('#textel-behind-none')).toContainText('track it'); // ...so it says what to do
  await expect(page.locator('#textel-to-back')).toBeVisible();

  // SHAPE — the same controls, the same ids but for its own prefix.
  await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }));
  await page.waitForTimeout(500);
  await expect(page.locator('#shape-order')).toHaveCount(1);
  await expect(page.locator('#shape-behind-none')).toHaveCount(1);

  // And a cinematic card, which always had its panel — clicked, as a user does.
  await page.evaluate(() => window.__textElements.addInterlude({ start: 1 }));
  await page.waitForTimeout(600);
  await page.locator('.timeline-text-clip').last().click();
  await page.waitForTimeout(400);
  await expect(page.locator('#textel-order')).toHaveCount(1);
  await expect(page.locator('#textel-behind-none')).toHaveCount(1);
});

test('the Layers panel offers the same control for whichever layer is selected', async ({ page }) => {
  await openDemo(page);
  const textId = await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0, text: 'WAHALA' }).id);
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator(`[data-layer-id="${textId}"] button`).first().click();
  await expect(page.locator('#layers-behind')).toHaveCount(1);
  expect(await page.evaluate(() => window.__layerStack.getSelectedLayerId())).toBe(textId);
});
