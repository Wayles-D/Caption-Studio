import { test, expect } from '@playwright/test';
import { isVideoCoveredAt } from '../../shared/textElement.js';
import { openTool } from './helpers/dock.js';

// An interlude REPLACES the picture (shared/textElement.js's
// orderForCompositing). The object overlay — the tracked box, the "tracked
// 97%" badge and the segmentation silhouette — is an SVG/canvas layer ABOVE
// every rendering canvas, so it never saw that rule: it kept drawing the
// tracked object over the white card, showing a trace of a frame that has
// been covered.
const APP_URL = 'http://localhost:5173/?splash=0';

test('the rule itself: covered only while an interlude is on screen', () => {
  const els = [{ id: 'i1', kind: 'interlude', start: 2, end: 4, text: 'A PROBLEM', enabled: true }];
  expect(isVideoCoveredAt(els, 1.9)).toBe(false);
  expect(isVideoCoveredAt(els, 2)).toBe(true);
  expect(isVideoCoveredAt(els, 3)).toBe(true);
  // Half-open at the end, like every other element test here.
  expect(isVideoCoveredAt(els, 4)).toBe(false);
  // An overlay does NOT cover the picture — only an interlude does.
  expect(isVideoCoveredAt([{ ...els[0], kind: 'overlay' }], 3)).toBe(false);
  expect(isVideoCoveredAt([], 3)).toBe(false);
});

test('the tracking overlay disappears behind an interlude and comes back after', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));

  await openTool(page, 'Objects');
  await page.waitForTimeout(600);

  const seek = async (t) => {
    await page.evaluate((x) => { const v = document.getElementById('preview-video'); v.pause(); v.currentTime = x; }, t);
    await page.waitForTimeout(400);
  };
  const overlayShown = () => page.evaluate(() => {
    const el = document.getElementById('object-overlay');
    return !!el && !el.hidden;
  });

  await seek(1);
  expect(await overlayShown()).toBe(true);

  // A cinematic card over 2-4s, exactly as the Cinematic button makes one.
  await page.evaluate(() => {
    const el = window.__textElements.addInterlude({ start: 2 });
    window.__textElements.updateTextElement(el.id, { text: 'A PROBLEM', end: 4 });
  });
  await page.waitForTimeout(500);
  // Creating a card selects it, which swings the panel over to Text &
  // Cinematic and leaves Objects mode — so come back to it, which is what the
  // user does too when they go on working with the tracked object.
  await openTool(page, 'Objects');
  await page.waitForTimeout(600);

  // Still visible before the card...
  await seek(1);
  expect(await overlayShown()).toBe(true);
  // ...gone while it covers the frame...
  await seek(3);
  expect(await overlayShown()).toBe(false);
  // ...and back once the picture returns.
  await seek(5);
  expect(await overlayShown()).toBe(true);
});
