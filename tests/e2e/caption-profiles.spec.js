import { test, expect } from '@playwright/test';

// Caption profiles: save the font pairing (font + weight, keyword font + weight)
// under a name, hover to preview, click to apply as one undo step; survives a
// reload. Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const get = (page, k) => page.evaluate((key) => window.__appState[key], k);

async function setup(page) {
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.removeItem('bhynd.captionProfiles.v1'));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.getByRole('button', { name: 'Text', exact: true }).first().click();
}

test('save a font pair, preview on hover, apply with one undo, persists', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__updateState({ fontFamily: 'Anton', fontWeight: '900', keywordFont: 'Outfit', keywordWeight: '600' }, { recordHistory: false }));
  await page.locator('#caption-profile-name').scrollIntoViewIfNeeded();
  await page.locator('#caption-profile-name').fill('Punchy');
  await page.locator('#caption-profile-save').click();
  const row = page.locator('[data-profile="Punchy"]');
  await expect(row).toBeVisible();

  await page.evaluate(() => window.__updateState({ fontFamily: 'Inter', fontWeight: '400', keywordFont: null, keywordWeight: null }, { recordHistory: false }));
  await row.hover();
  await expect.poll(() => get(page, 'fontFamily')).toBe('Anton');
  await expect.poll(() => get(page, 'keywordWeight')).toBe('600');
  await page.mouse.move(5, 5);
  await expect.poll(() => get(page, 'fontFamily')).toBe('Inter');
  await expect.poll(() => get(page, 'keywordFont')).toBe(null);

  await row.locator('button').first().click();
  expect(await get(page, 'fontFamily')).toBe('Anton');
  expect(await get(page, 'fontWeight')).toBe('900');
  expect(await get(page, 'keywordFont')).toBe('Outfit');
  expect(await get(page, 'keywordWeight')).toBe('600');

  await page.evaluate(() => document.querySelector('[title^="Undo"]')?.click());
  await expect.poll(() => get(page, 'fontFamily')).toBe('Inter');

  await page.reload();
  // The project restores itself on reload, so there is no demo button to press.
  await page.getByRole('button', { name: 'Text', exact: true }).first().click();
  await expect(page.locator('[data-profile="Punchy"]')).toBeVisible();
});

test('caption weight dropdown sets the weight; delete removes a profile', async ({ page }) => {
  await setup(page);
  await page.locator('#select-font-weight').scrollIntoViewIfNeeded();
  await page.locator('#select-font-weight').click();
  await page.locator('[data-hover-option="900"]').click();
  expect(await get(page, 'fontWeight')).toBe('900');
  await page.locator('#caption-profile-name').fill('Temp');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-profile="Temp"]')).toBeVisible();
  await page.getByLabel('Delete profile Temp').click();
  await expect(page.locator('[data-profile="Temp"]')).toHaveCount(0);
});
