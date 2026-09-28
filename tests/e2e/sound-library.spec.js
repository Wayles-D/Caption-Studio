import { test, expect } from '@playwright/test';
import { SOUND_IDS, SOUND_CATEGORIES, listSoundsByCategory } from '../../shared/soundRegistry.js';

// The sound library panel (src/components/SoundLibraryPanel.jsx).
//
// It replaced a popover anchored to the SFX lane's "+". That was fine for
// eleven sounds; at thirty-eight it has to group and scroll, which a popover
// pinned to a button does not. The panel opens on the left — the one side of
// the workspace that was otherwise empty — so it displaces neither the
// preview nor the Video Inspector opposite it.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const PANEL = '#sound-library-panel';

async function openLibrary(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.waitForTimeout(400);
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
}

const soundEvents = (page) => page.evaluate(() => window.__appState.soundEvents || []);

test('every registered sound appears, grouped by category', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openLibrary(page);

  const panel = page.locator(PANEL);
  // Derived from the registry, not a literal: the panel's contract is "lists
  // every registered sound", so adding one must not fail this test.
  await expect(panel.locator('[data-sound-add]')).toHaveCount(SOUND_IDS.length);

  // ...and every non-empty category is a visible heading, in registry order.
  const expectedGroups = listSoundsByCategory();
  const rendered = await page.evaluate(() =>
    [...document.querySelectorAll('#sound-library-panel [data-sound-group]')].map((el) => el.dataset.soundGroup));
  console.log('groups rendered:', rendered.join(', '), '| sounds:', SOUND_IDS.length);
  expect(rendered).toEqual(expectedGroups.map((g) => g.id));
  // Sanity: the registry really does define categories, so this is testing
  // something rather than an empty list.
  expect(SOUND_CATEGORIES.length).toBeGreaterThan(3);

  // Each group's label is on screen.
  for (const group of expectedGroups) {
    await expect(panel.getByText(group.label, { exact: true })).toBeVisible();
  }
  expect(errs).toEqual([]);
});

test('the list scrolls rather than overflowing the panel', async ({ page }) => {
  await openLibrary(page);

  const metrics = await page.evaluate(() => {
    const list = document.getElementById('sound-library-list');
    const panel = document.getElementById('sound-library-panel');
    return {
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      panelBottom: Math.round(panel.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight
    };
  });
  console.log('list metrics:', JSON.stringify(metrics));

  // With 38 sounds the list is genuinely taller than its box...
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // ...and the panel itself stays within the window rather than running off
  // the bottom, which is the failure mode a non-scrolling list would cause.
  expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);

  // It actually scrolls.
  await page.evaluate(() => { document.getElementById('sound-library-list').scrollTop = 400; });
  await page.waitForTimeout(200);
  const scrolled = await page.evaluate(() => document.getElementById('sound-library-list').scrollTop);
  expect(scrolled).toBeGreaterThan(200);
});

test('picking a sound adds it at the playhead and closes the panel', async ({ page }) => {
  await openLibrary(page);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 2; });
  await page.waitForTimeout(300);

  await page.locator('[data-sound-add="netflix-intro"]').click();
  await page.waitForTimeout(400);

  const events = await soundEvents(page);
  console.log('after picking:', JSON.stringify(events.map((e) => ({ id: e.soundId, t: +e.startTime.toFixed(2) }))));
  expect(events.length).toBe(1);
  // One of the newly registered sounds, so this also proves the additions are
  // reachable end to end rather than just present in the registry.
  expect(events[0].soundId).toBe('netflix-intro');
  expect(events[0].startTime).toBeCloseTo(2, 1);
  await expect(page.locator(PANEL)).toHaveCount(0);
});

test('auditioning a sound does not add it', async ({ page }) => {
  await openLibrary(page);

  await page.locator('[data-sound-preview="whoosh"]').click();
  await page.waitForTimeout(400);

  // The ▶ is for hearing it before committing — the whole difference between
  // picking a sound and guessing one.
  expect(await soundEvents(page)).toEqual([]);
  await expect(page.locator(PANEL)).toBeVisible();
});

test('Cancel, Escape and an outside press each close it', async ({ page }) => {
  await openLibrary(page);
  await page.locator('#sound-library-cancel').click();
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(await soundEvents(page)).toEqual([]);

  // Escape
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toHaveCount(0);

  // A press anywhere outside it
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
  await page.mouse.click(960, 300);
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(await soundEvents(page)).toEqual([]);
});

test('the "+" toggles rather than fighting the outside-press close', async ({ page }) => {
  await openLibrary(page);
  // Pressing the opener while open must close it once — not close it via the
  // outside-press handler and immediately reopen it.
  await page.locator('#timeline-add-sfx-btn').click();
  await page.waitForTimeout(300);
  await expect(page.locator(PANEL)).toHaveCount(0);

  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
});
