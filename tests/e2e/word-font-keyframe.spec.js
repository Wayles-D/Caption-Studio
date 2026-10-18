import { test, expect } from '@playwright/test';
import { resolveCaptionTransformsAtTime } from '../../shared/captionTransform.js';

// "I can't find this" — the ◆ Change font here control, driven through the
// REAL Word panel, as a user reaches it: click the caption, click the word,
// open Word, and use the row under the Font dropdown.
//
// Hits :5173 for the same reason per-word-style.spec.js does: caption fonts
// come from the backend, whose CORS allowlist covers that port only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function pickOption(page, selector, value) {
  await page.locator(selector).click();
  await page.locator(`[data-hover-option="${value}"]`).click();
}

async function setupTwoWordCaption(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration && !Number.isNaN(v.duration) && v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'ONE', start: 0, end: 3, wordIndex: 0 },
      { word: 'TWO', start: 3, end: 4, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 4, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);
}

async function selectWordZero(page) {
  const frameBox = await page.locator('#preview-video').boundingBox();
  const rect = await page.evaluate(() => window.__debugWordScreenRect(0));
  const pt = { x: frameBox.x + rect.centerX, y: frameBox.y + rect.centerY };
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  expect((await page.evaluate(() => window.__debugGroupState())).selectedWordIndex).toBe(0);
  await page.getByRole('button', { name: 'Word', exact: true }).click();
  await page.waitForTimeout(300);
}

async function seekTo(page, t) {
  await page.evaluate((time) => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = time;
  }, t);
  await page.waitForTimeout(350);
}

test('the ◆ Change font here row is in the Word panel, under Font', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  // It sits directly beneath the Font dropdown the user was already looking at.
  const row = page.locator('#word-fontFamily-kf');
  await expect(row).toBeVisible();
  const btn = page.locator('#word-fontFamily-kf-add');
  await expect(btn).toHaveText(/Change font here/);

  const fontBox = await page.locator('#word-font-select').boundingBox();
  const rowBox = await row.boundingBox();
  expect(rowBox.y).toBeGreaterThan(fontBox.y);
});

test('a word can wear one font up to the playhead and another after it', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  // The word starts out in one font...
  await pickOption(page, '#word-font-select', 'Montserrat');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__appState.captionTransforms?.w0?.style?.fontFamily)).toBe('Montserrat');

  // ...then at 1.5s the user says "change it from here".
  await seekTo(page, 1.5);
  await page.locator('#word-fontFamily-kf-add').click();
  await page.waitForTimeout(200);

  // Two keyframes: the word's own start, pinned, and the playhead.
  const stored = () => page.evaluate(() =>
    (window.__appState.captionTransforms?.w0?.keyframes || []).map((k) => [k.t, k.values.fontFamily]).filter((e) => e[1]));
  expect(await stored()).toEqual([[0, 'Montserrat'], [1.5, 'Montserrat']]);

  // Picking a new font NOW edits the keyframe at the playhead, not the whole word.
  await pickOption(page, '#word-font-select', 'Anton');
  await page.waitForTimeout(300);
  expect(await stored()).toEqual([[0, 'Montserrat'], [1.5, 'Anton']]);

  // The panel lists both instants, and offers a way out.
  await expect(page.locator('#word-fontFamily-kf-times')).toHaveText('0.00s, 1.50s');
  await expect(page.locator('#word-fontFamily-kf-clear')).toBeVisible();

  // What the renderer resolves at each instant — a font HOLDS, it never blends.
  const transforms = await page.evaluate(() => window.__appState.captionTransforms);
  const fontAt = (t) =>
    resolveCaptionTransformsAtTime({ captionTransforms: transforms }, t).captionTransforms.w0.style.fontFamily;
  expect(fontAt(0.2)).toBe('Montserrat');
  expect(fontAt(1.49)).toBe('Montserrat');
  expect(fontAt(1.5)).toBe('Anton');
  expect(fontAt(2.9)).toBe('Anton');
});

// Pixels, against GROUND TRUTH — not against "something changed".
//
// An earlier version of this test only asked that the ink count move by >3%
// across the keyframe, and it passed while the word was rendering in neither
// font: the keyframed face was never loaded, so the canvas silently fell back.
// ctx.font fails that way without erroring, so the only honest assertion is
// that the keyframed word paints EXACTLY what a statically styled word paints.
// Everything is measured at one instant, so the entrance animation is held
// constant and the font is the only variable.
test('the keyframed word paints exactly what a statically styled word paints', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  const ink = () => page.evaluate(() => {
    const c = document.getElementById('captions-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });

  await seekTo(page, 1.5);
  await page.locator('#word-fontFamily-kf-add').click();
  await page.waitForTimeout(250);
  await pickOption(page, '#word-font-select', 'Anton');
  await page.waitForFunction(() => document.fonts.check('40px Anton'));
  await page.waitForTimeout(900);

  // After the keyframe, the word should be in Anton.
  await seekTo(page, 2.2);
  const keyframed = await ink();

  // Ground truth at the SAME instant: inherited, then statically Anton.
  await page.evaluate(() => window.__updateState({ captionTransforms: {} }, { recordHistory: false }));
  await page.waitForTimeout(600);
  await seekTo(page, 2.2);
  const inherited = await ink();

  await page.evaluate(() => window.__updateState(
    { captionTransforms: { w0: { style: { fontFamily: 'Anton' } } } }, { recordHistory: false }));
  await page.waitForFunction(() => document.fonts.check('40px Anton'));
  await page.waitForTimeout(900);
  await seekTo(page, 2.2);
  const staticAnton = await ink();

  expect(inherited).toBeGreaterThan(50);
  // The two fonts must genuinely differ, or this test proves nothing.
  expect(Math.abs(staticAnton - inherited)).toBeGreaterThan(5);
  // ...and the keyframed word must be the Anton one, not the fallback.
  expect(keyframed).toBe(staticAnton);
});

// THE BUG THIS FEATURE SHIPPED WITH, and the only order a user actually tries:
// click ◆ on a word that has never been styled, THEN pick the new font.
//
// The word had no font of its own, so ◆ pinned `null` — and a keyframe holding
// null is not a keyframe at all (getPropertyTrack drops it). The track stayed
// empty, no times appeared, the button never lit, and the font pick fell
// through to the plain static path. Nothing happened, exactly as reported.
//
// A word with no override is still WEARING a font: the caption's. That is what
// ◆ now pins.
test('◆ works on a word that has never been styled, then the font pick splits it', async ({ page }) => {
  await setupTwoWordCaption(page);
  await selectWordZero(page);

  const captionFont = await page.evaluate(() => window.__appState.fontFamily);
  expect(await page.evaluate(() => window.__appState.captionTransforms)).toEqual({});

  await seekTo(page, 1.5);
  await page.locator('#word-fontFamily-kf-add').click();
  await page.waitForTimeout(250);

  // Both keyframes hold the font it was ALREADY wearing — nothing has changed
  // yet, which is what "pin it here" should mean.
  const stored = () => page.evaluate(() =>
    (window.__appState.captionTransforms?.w0?.keyframes || []).map((k) => [k.t, k.values.fontFamily]).filter((e) => e[1]));
  expect(await stored()).toEqual([[0, captionFont], [1.5, captionFont]]);
  await expect(page.locator('#word-fontFamily-kf-times')).toHaveText('0.00s, 1.50s');

  // Now the new font lands on the playhead keyframe, not on the whole word.
  await pickOption(page, '#word-font-select', 'Anton');
  await page.waitForTimeout(300);
  expect(await stored()).toEqual([[0, captionFont], [1.5, 'Anton']]);

  // And the dropdown reflects what is drawn AT the playhead, not the stale
  // static value — otherwise the control reads as "nothing happened" too.
  await expect(page.locator('#word-font-select')).toContainText('Anton');
});
