import { test, expect } from '@playwright/test';

// NEW PROJECT (src/components/Toolbar.jsx): the open project is saved in the
// browser and reopens on every visit; "New Project" puts it away — after
// asking — and lands on the upload screen, empty, without the intro.

const savedDoc = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('bhynd');
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('project')) { db.close(); resolve(null); return; }
    const req = db.transaction('project').objectStore('project').get('current');
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); resolve(null); };
  };
  open.onerror = () => resolve(null);
}));

const savedFileCount = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('bhynd');
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('files')) { db.close(); resolve(0); return; }
    const req = db.transaction('files').objectStore('files').count();
    req.onsuccess = () => { db.close(); resolve(req.result); };
  };
  open.onerror = () => resolve(0);
}));

const upload = (page) => page.locator('#state-upload.active');

test('New Project asks first, then clears the saved project and opens the upload screen — no intro', async ({ page }) => {
  test.setTimeout(90000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();

  // Nothing open: nothing to start over from.
  await expect(upload(page)).toBeVisible();
  await expect(page.locator('#btn-toolbar-new')).toHaveCount(0);

  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', start: 0.5, text: 'KEEP ME' }));
  await expect(page.locator('#btn-toolbar-new')).toBeVisible();
  await expect.poll(async () => (await savedDoc(page))?.textElements?.length ?? 0).toBe(1);

  // Today's behaviour, which is why the button exists: a visit reopens it.
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);

  // It asks. Escape, a click elsewhere, and Cancel all leave everything as it was.
  await page.locator('#btn-toolbar-new').click();
  await expect(page.locator('#new-project-confirm')).toBeVisible();
  await expect(page.locator('#new-project-confirm')).toContainText('removes the current video and all its edits');
  await page.keyboard.press('Escape');
  await expect(page.locator('#new-project-confirm')).toHaveCount(0);
  await page.locator('#btn-toolbar-new').click();
  await page.mouse.click(700, 500);
  await expect(page.locator('#new-project-confirm')).toHaveCount(0);
  await page.locator('#btn-toolbar-new').click();
  await page.locator('#new-project-cancel').click();
  await expect(page.locator('#new-project-confirm')).toHaveCount(0);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(1);
  expect((await savedDoc(page))?.textElements?.length).toBe(1);

  // Visit without ?splash=0 — the intro plays, as on any visit; click past it.
  await page.goto('/');
  await page.locator('#bhynd-splash').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await expect(page.locator('#bhynd-splash')).toHaveCount(0, { timeout: 5000 });

  // Yes: the page reloads onto the upload screen — straight, no intro.
  await page.locator('#btn-toolbar-new').click();
  await Promise.all([
    page.waitForEvent('load'),
    page.locator('#new-project-confirm-btn').click()
  ]);
  await expect(upload(page)).toBeVisible();
  await expect(page.locator('#bhynd-splash')).toHaveCount(0);
  await expect(page.locator('#btn-toolbar-new')).toHaveCount(0);
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(0);
  expect(await page.evaluate(() => !!window.__appState.isLoaded)).toBe(false);
  expect(await savedDoc(page)).toBeNull();
  expect(await savedFileCount(page)).toBe(0);

  // Gone for good — and the intro skip was one-time: the next visit plays it again, still empty.
  await page.reload();
  await expect(page.locator('#bhynd-splash')).toBeVisible();
  await page.locator('#bhynd-splash').click();
  await expect(upload(page)).toBeVisible();
  expect(await savedDoc(page)).toBeNull();

  // And a new project starts and saves as normal.
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await expect(page.locator('#btn-toolbar-new')).toBeVisible();
  expect(await page.evaluate(() => window.__appState.textElements.length)).toBe(0);
  expect(errs).toEqual([]);
});
