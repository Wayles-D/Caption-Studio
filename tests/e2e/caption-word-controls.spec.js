import { test, expect } from '@playwright/test';
import { openTool } from './helpers/dock.js';

// CAPTION WORD CONTROLS — the three things a creator needs when a caption
// word has to be different from the rest of its caption:
//
//  1. CASE AS TYPED. 'none' used to fall through to sentence case, so a
//     brand typed "BHYND" — in the transcript or in an overlay's "As typed" —
//     rendered "Bhynd"/"bhynd". Now caption-wide and per word (from the
//     Transcript panel's "Aa") it renders exactly as written.
//  2. SWITCH A WORD OFF. Gone from the video, still in the transcript and in
//     its caption's timing; every word around it keeps its own moment.
//  3. DELETE OR HIDE A CAPTION from the timeline (Backspace / the capsule
//     menu) — the creator used to drag a caption off-screen, where it still
//     flashed by.
//  4. A CAPTION WORD BEHIND SOMEONE: one action lifts the word out as an
//     overlay (the only kind of layer a subject can stand in front of).
//
// Pixels, compared against GROUND TRUTH rather than "something changed": an
// as-typed "BHYND" must paint exactly the ink an UPPERCASE "BHYND" does.
//
// :5173 explicitly — caption fonts come from the backend, whose CORS covers
// that origin only. Needs `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function setup(page, wordsIn) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.videoWidth > 0);
  await page.evaluate((list) => {
    const words = list.map((w, i) => ({ word: w, start: i * 0.6, end: i * 0.6 + 0.55, wordIndex: i }));
    const phrases = [{ start: 0, end: words.at(-1).end, words, breakAfterIndices: [] }];
    window.__updateState({ words, phrases, captionTransforms: {} }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
  }, wordsIn);
  await seek(page, 0.3);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
  await page.waitForTimeout(250);
}

/**
 * Opaque caption pixels the viewer can SEE, and a hash of where they are —
 * two paints with equal ink in the same places are the same text. With no
 * caption on screen the preview hides the canvas (display:none) rather than
 * clearing it, so a hidden canvas counts as no ink.
 */
const ink = (page) => page.evaluate(() => {
  const c = document.getElementById('captions-canvas');
  if (getComputedStyle(c).display === 'none') return { n: 0, h: 0 };
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; let h = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 128) { n++; h = (h * 31 + i) | 0; }
  return { n, h };
});

async function paintWith(page, patch) {
  await page.evaluate((p) => window.__updateState(p, { recordHistory: false }), patch);
  await page.evaluate(() => document.fonts.ready);
  await seek(page, 0.31);
  await seek(page, 0.3);
  return ink(page);
}

test('As typed keeps "BHYND" exactly — caption-wide', async ({ page }) => {
  await setup(page, ['SAY', 'BHYND', 'NOW']);
  const upper = await paintWith(page, { textCase: 'uppercase' });
  const asTyped = await paintWith(page, { textCase: 'none' });
  const sentence = await paintWith(page, { textCase: 'normal' });
  console.log('ink  uppercase', upper.n, '| as typed', asTyped.n, '| sentence', sentence.n);
  expect(upper.n).toBeGreaterThan(100);
  // Every word here is typed in capitals, so as-typed IS uppercase, pixel for pixel...
  expect(asTyped).toEqual(upper);
  // ...and sentence case writes the way people do: an all-capitals word
  // (a brand, an acronym) is left as it is — so here, nothing changes either.
  expect(sentence).toEqual(upper);

  // The caption-wide radio now shows the real value.
  await openTool(page, 'Text').catch(() => {});
  const checked = await page.evaluate(() => [...document.getElementsByName('text-case')].find((r) => r.checked)?.value);
  expect(checked).toBe('normal');
});

test('the Transcript "Aa" sets one word As typed, beating the caption case', async ({ page }) => {
  await setup(page, ['say', 'BHYND', 'now']);
  // The caption is lowercase; only BHYND is to keep its capitals.
  const reference = await paintWith(page, { textCase: 'lowercase', captionTransforms: { w1: { style: { textCase: 'uppercase' } } } });
  await paintWith(page, { textCase: 'lowercase', captionTransforms: {} });

  await openTool(page, 'Transcript');
  // Click the word: its options appear above it — Case among them.
  await page.locator('#transcript-words-container .word-chip[data-index="1"]').click();
  const caseBtn = page.locator('#word-actions [data-word-action="case"]');
  await caseBtn.waitFor();
  await caseBtn.click();
  await page.locator('#word-case-menu [data-case-choice="none"]').click();
  await expect(caseBtn).toHaveClass(/active/);
  expect(await page.evaluate(() => window.__appState.captionTransforms.w1?.style?.textCase)).toBe('none');

  await page.evaluate(() => document.fonts.ready);
  await seek(page, 0.31);
  await seek(page, 0.3);
  const result = await ink(page);
  console.log('ink  reference (BHYND upper in a lowercase line)', reference.n, '| as typed via transcript', result.n);
  expect(result).toEqual(reference);
});

test('a word switched off disappears, its neighbours keep their timing, and Undo brings it back', async ({ page }) => {
  await setup(page, ['THIS', 'IS', 'BEHIND']);
  await page.evaluate(() => window.__updateState({ textCase: 'uppercase' }, { recordHistory: false }));
  const all = await paintWith(page, {});

  await openTool(page, 'Transcript');
  await page.locator('#transcript-words-container .word-chip[data-index="2"]').click();
  const hideBtn = page.locator('#word-actions [data-word-action="hide"]');
  await hideBtn.click();
  await expect(page.locator('[data-word-index="2"]')).toHaveClass(/word-chip-hidden/);
  expect(await page.evaluate(() => window.__appState.captionTransforms.w2?.hidden)).toBe(true);

  await seek(page, 0.31); await seek(page, 0.3);
  const without = await ink(page);
  console.log('ink  all three', all.n, '| BEHIND switched off', without.n);
  expect(without.n).toBeLessThan(all.n);
  expect(without.n).toBeGreaterThan(0);

  // Timing untouched: the transcript and the caption still hold all three words.
  const timing = await page.evaluate(() => ({
    words: window.__appState.words.map((w) => [w.word, w.start, w.end]),
    caption: window.__appState.captionEvents[0].wordIndices
  }));
  expect(timing.caption).toEqual([0, 1, 2]);
  expect(timing.words[1]).toEqual(['IS', 0.6, 1.15]);

  // One Undo: the word is back on the video AND the chip follows.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-word-index="2"]')).not.toHaveClass(/word-chip-hidden/);
  await seek(page, 0.31); await seek(page, 0.3);
  expect(await ink(page)).toEqual(all);
});

test('Backspace deletes a selected caption, the capsule hides one, and both undo', async ({ page }) => {
  await setup(page, ['ONE', 'TWO']);
  await page.evaluate(() => {
    const ev = window.__appState.captionEvents[0];
    window.__captionEvents.splitCaptionEventAt(ev.id, 0);
  });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__appState.captionEvents.map((e) => ({ id: e.id, words: e.wordIndices, start: e.start })));
  expect(before.length).toBe(2);

  // Select the second caption on the timeline and press Backspace.
  await page.locator(`.timeline-text-clip.is-transcript[data-clip-id="${before[1].id}"]`).click();
  await page.keyboard.press('Backspace');
  const after = await page.evaluate(() => window.__appState.captionEvents.map((e) => ({ id: e.id, words: e.wordIndices, start: e.start })));
  expect(after).toEqual([before[0]]);  // the other caption untouched, same time

  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => window.__appState.captionEvents.length)).toBe(2);

  // Hide the first through the capsule's menu: it stays on the lane, off the video.
  await seek(page, 0.3);
  const shown = await ink(page);
  const clip = page.locator(`.timeline-text-clip.is-transcript[data-clip-id="${before[0].id}"]`);
  await clip.hover();
  await clip.locator('.timeline-caption-convert').click();
  await page.locator('#timeline-convert-menu [data-caption-action="toggle-hidden"]').click();
  await expect(clip).toHaveClass(/is-hidden-caption/);
  await seek(page, 0.31); await seek(page, 0.3);
  const hidden = await ink(page);
  console.log('ink  caption shown', shown.n, '| hidden', hidden.n);
  expect(shown.n).toBeGreaterThan(50);
  expect(hidden.n).toBe(0);
  // Nothing at all, not the demo's placeholder subtitle ("WELCOME TO BHYND.")
  // that used to fill any caption-less moment of the first 21 seconds.
  expect((await page.locator('#captions-text').innerText()).trim()).toBe('');

  // ...and back on from the same menu.
  await clip.hover();
  await clip.locator('.timeline-caption-convert').click();
  await page.locator('#timeline-convert-menu [data-caption-action="toggle-hidden"]').click();
  await expect(clip).not.toHaveClass(/is-hidden-caption/);
});

test('"Put behind someone" lifts one caption word out as an overlay, in one Undo', async ({ page }) => {
  await setup(page, ['THIS', 'IS', 'BEHIND']);
  // Select BEHIND the way a user does: click the caption, then the word.
  const frame = await page.locator('#preview-video').boundingBox();
  await page.waitForFunction(() => window.__debugWordScreenRect?.(2) != null);
  const r = await page.evaluate(() => window.__debugWordScreenRect(2));
  await seek(page, 1.4);
  const r2 = await page.evaluate(() => window.__debugWordScreenRect(2));
  const pt = { x: frame.x + r2.centerX, y: frame.y + r2.centerY };
  await page.mouse.click(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y);
  expect(r).toBeTruthy();
  await openTool(page, 'Word');
  await page.locator('#word-to-overlay').click();

  const out = await page.evaluate(() => ({
    captions: window.__appState.captionEvents.map((e) => e.wordIndices),
    overlays: (window.__appState.textElements || []).map((e) => ({ kind: e.kind, text: e.text, start: e.start, end: e.end }))
  }));
  console.log('after:', JSON.stringify(out));
  expect(out.overlays).toEqual([{ kind: 'overlay', text: 'BEHIND', start: 1.2, end: 1.75 }]);
  expect(out.captions).toEqual([[0, 1]]);
  // The overlay is selected, so its panel — with "Behind a subject" — is open.
  await expect(page.locator('#textel-content')).toBeVisible();

  // One Undo: the caption whole again, no overlay.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => ({
    captions: window.__appState.captionEvents.map((e) => e.wordIndices),
    overlays: (window.__appState.textElements || []).length
  }))).toEqual({ captions: [[0, 1, 2]], overlays: 0 });
});
