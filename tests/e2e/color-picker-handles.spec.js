import { test, expect } from '@playwright/test';

// react-colorful ships a 28px round pointer and 24px hue/alpha bars, sized for
// a full-page picker. In a narrow inspector popover that handle hides a visible
// chunk of the gradient it is meant to be picking from.
//
// The override has to be two classes deep: react-colorful injects its own
// single-class rules into <head> when the component mounts, AFTER this app's
// stylesheet, so a matching specificity loses on source order and the handle
// silently stays 28px. This test exists because that is exactly what happened
// — and it would happen again on a library upgrade with no other symptom.
test('the picker handles are the small ones, not the library defaults', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.waitForTimeout(600);
  await page.locator('.color-swatch-trigger').first().click();
  await page.locator('.react-colorful').waitFor();
  await page.waitForTimeout(400);

  const pointers = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.react-colorful__pointer'))
      .map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(pointers.length).toBeGreaterThan(0);
  pointers.forEach((w) => expect(w).toBe(16));

  const bars = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.react-colorful__hue, .react-colorful__alpha'))
      .map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(bars.length).toBeGreaterThan(0);
  bars.forEach((h) => expect(h).toBe(14));

  // The area you pick FROM is untouched — only the handles shrank.
  const width = await page.evaluate(() =>
    Math.round(document.querySelector('.react-colorful').getBoundingClientRect().width));
  expect(width).toBeGreaterThan(180);
});
