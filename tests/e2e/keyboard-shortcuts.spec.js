import { test, expect } from '@playwright/test';

// KEYBOARD SHORTCUTS (src/js/components/keyboardShortcuts.js) in the real
// editor, pressed on the real keyboard: undo/redo, play, stepping, jumping,
// duplicating, deselecting, the list — and none of them when the key is
// typed into a field.

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.waitForTimeout(300);
  // Nothing focused: the keys go to the editor.
  await page.evaluate(() => document.activeElement?.blur());
}

const time = (page) => page.evaluate(() => document.getElementById('preview-video').currentTime);
const shapes = (page) => page.evaluate(() => window.__shapeLayers.getShapeLayers().length);

test('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo — but not while typing in a field', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }));
  expect(await shapes(page)).toBe(1);
  await page.keyboard.press('Control+z');
  expect(await shapes(page)).toBe(0);
  await page.keyboard.press('Control+y');
  expect(await shapes(page)).toBe(1);
  await page.keyboard.press('Control+z');
  expect(await shapes(page)).toBe(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await shapes(page)).toBe(1);
  await page.keyboard.press('Meta+z');
  expect(await shapes(page), '⌘Z too').toBe(0);
  await page.keyboard.press('Meta+Shift+z');
  expect(await shapes(page)).toBe(1);

  // In a text field, Ctrl+Z is the field's own.
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'probe-input';
    document.body.appendChild(i);
  });
  await page.locator('#probe-input').fill('abc');
  await page.locator('#probe-input').press('Control+z');
  expect(await shapes(page), 'no undo from inside a field').toBe(1);
  await page.locator('#probe-input').press('Space');
  expect(await page.evaluate(() => document.getElementById('preview-video').paused), 'Space types a space in a field').toBe(true);
});

test('Space plays and pauses; arrows step a frame or a second; Home and End jump', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.getElementById('preview-video').paused);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('preview-video').paused);

  await page.keyboard.press('Home');
  await expect.poll(() => time(page)).toBe(0);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => time(page)).toBeCloseTo(1, 3);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => time(page)).toBeCloseTo(1 + 1 / 30, 3);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => time(page)).toBeCloseTo(1, 3);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => time(page)).toBeCloseTo(0, 3);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => time(page), 'never before the start').toBe(0);
  await page.keyboard.press('End');
  const d = await page.evaluate(() => document.getElementById('preview-video').duration);
  await expect.poll(() => time(page)).toBeCloseTo(d, 2);

  // Space does not also press the focused button.
  await page.locator('#timeline-undo-btn').focus();
  await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }));
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !document.getElementById('preview-video').paused);
  await page.keyboard.press('Space');
  expect(await shapes(page), 'the focused Undo button was not pressed').toBe(1);
});

test('Ctrl+D duplicates the selected shape; Esc deselects; ? lists the shortcuts', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => window.__shapeLayers.addShapeLayer('rectangle', { start: 0 }));
  const first = await page.evaluate(() => window.__appState.selectedShapeLayerId);
  expect(first).toBeTruthy();
  await page.keyboard.press('Control+d');
  expect(await shapes(page)).toBe(2);
  const copy = await page.evaluate(() => window.__appState.selectedShapeLayerId);
  expect(copy).not.toBe(first);
  await page.keyboard.press('Control+z');
  expect(await shapes(page), 'one undo takes the copy back').toBe(1);

  await page.evaluate((id) => window.__shapeLayers.selectShapeLayer(id), first);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__appState.selectedShapeLayerId)).toBeNull();
  // Nothing selected: Ctrl+D is left alone.
  await page.keyboard.press('Control+d');
  expect(await shapes(page)).toBe(1);

  await page.keyboard.press('?');
  await expect(page.locator('#shortcuts-dialog')).toBeVisible();
  await expect(page.locator('#shortcuts-dialog')).toContainText('Undo');
  await expect(page.locator('#shortcuts-dialog')).toContainText('Ctrl+Z');
  // Keys do nothing behind it.
  await page.keyboard.press('Control+z');
  expect(await shapes(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#shortcuts-dialog')).toBeHidden();
  await page.locator('#timeline-shortcuts-btn').click();
  await expect(page.locator('#shortcuts-dialog')).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(page.locator('#shortcuts-dialog')).toBeHidden();
});
