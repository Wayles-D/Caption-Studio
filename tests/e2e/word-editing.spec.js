import { test, expect } from '@playwright/test';

// Editing single words, driven through the real UI:
//  - a word typed in the transcript reaches the video, and stays there when
//    the captions are rebuilt from the transcript;
//  - one word of a cinematic card is styled on its own — its own case and
//    font — from the Text & Cinematic panel, without touching the rest.
//
// Hits :5173 explicitly (caption fonts come from the backend, whose CORS
// allowlist covers :5173 only). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-9) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

/** The caption canvas's pixels, as a fingerprint of what it shows. */
const captionPixels = (page) => page.evaluate(() => {
  const c = document.getElementById('captions-canvas');
  return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).join(',');
});

test('a word typed in the transcript reaches the video, and survives the captions being rebuilt', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    const words = 'HOME OFFICE HACKS FOR YOU'.split(' ').map((w, i) => ({ word: w, start: 0.5 + i * 0.4, end: 0.85 + i * 0.4 }));
    window.__updateState({ words, phrases: [{ start: 0.5, end: 2.45, words: words.map((w, i) => ({ ...w, wordIndex: i })), breakAfterIndices: [] }], captionEvents: [] }, { recordHistory: false });
  });
  await seek(page, 1.0);
  await page.waitForTimeout(300);
  const before = await captionPixels(page);

  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  const chip = page.locator('#transcript-words-container .word-chip[data-index="1"]');
  await chip.click();
  await page.keyboard.press('End');
  await page.keyboard.type('XYZ');
  await seek(page, 1.0);
  // Already on the video while typing.
  expect(await page.evaluate(() => window.__appState.phrases[0].words[1].word)).toBe('OFFICEXYZ');
  const typed = await captionPixels(page);
  expect(typed).not.toBe(before);

  // Leaving the word commits it to the transcript itself…
  await page.keyboard.press('Enter');
  const word = await page.evaluate(() => window.__appState.words[1]);
  expect(word.word).toBe('OFFICEXYZ');
  expect(word.originalWord).toBe('OFFICE');
  // …so rebuilding the captions from the transcript keeps it.
  await page.evaluate(() => window.__updateState({ captionEvents: window.__appState.captionEvents.map((e) => ({ ...e })) }, { recordHistory: false }));
  expect(await page.evaluate(() => window.__appState.phrases[0].words.map((w) => w.word).join(' '))).toBe('HOME OFFICEXYZ HACKS FOR YOU');
  await seek(page, 1.01);
  await seek(page, 1.0);
  expect(await captionPixels(page)).toBe(typed);
  // The chip still shows it was edited.
  await expect(page.locator('#transcript-words-container .word-chip[data-index="1"]')).toHaveClass(/border-amber-500/);
});

/** A card at 2s reading "HOME OFFICE HACKS", no entrance, shown at 3s. */
async function addCard(page) {
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  await page.evaluate(() => {
    const [el] = window.__appState.textElements;
    window.__textElements.updateTextElement(el.id, { text: 'HOME OFFICE HACKS' });
    window.__textElements.updateTextElementStyle(el.id, { captionAnimationType: 'none' });
  });
  await seek(page, 3);
}

/** Clicks on the video until word `index` of the card is the selection (the first click selects the card). */
async function selectCardWord(page, index) {
  const frame = await page.locator('#preview-video').boundingBox();
  const w = (await page.evaluate(() => window.__debugTextWordRects()))[index];
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(frame.x + w.x + w.width / 2, frame.y + w.y + w.height / 2);
    if (await page.evaluate(() => window.__debugSelectedTextWordIndex()) === index) break;
  }
  expect(await page.evaluate(() => window.__debugSelectedTextWordIndex())).toBe(index);
}

/** Dark (text) pixels in a frame-relative rect of the card layer. */
const darkIn = (page, r) => page.evaluate((rect) => {
  const frame = document.getElementById('preview-video').getBoundingClientRect();
  const c = document.getElementById('text-elements-canvas');
  const cr = c.getBoundingClientRect();
  const s = c.width / cr.width;
  const d = c.getContext('2d').getImageData(Math.round((frame.x + rect.x - cr.left) * s), Math.round((frame.y + rect.y - cr.top) * s), Math.max(1, Math.round(rect.width * s)), Math.max(1, Math.round(rect.height * s))).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100 && d[i + 3] > 200) n++;
  return n;
}, r);

const card = (page) => page.evaluate(() => window.__appState.textElements[0]);

test('one word of a cinematic card takes its own case and font, from the card\'s own panel', async ({ page }) => {
  await openDemo(page);
  await addCard(page);
  const words = await page.evaluate(() => window.__debugTextWordRects());
  const inkBefore = [await darkIn(page, words[0]), await darkIn(page, words[1]), await darkIn(page, words[2])];

  // Select the word on the video: the panel switches to that word.
  await selectCardWord(page, 1);
  await expect(page.locator('#textel-word-editing')).toBeVisible();
  await expect(page.locator('#textel-word-editing')).toContainText('OFFICE');

  await page.locator('#word-case-select').selectOption('lowercase');
  await page.locator('#word-font-select').selectOption('Pacifico');
  const el = await card(page);
  expect(el.wordTransforms).toEqual({ w1: { style: { textCase: 'lowercase', fontFamily: 'Pacifico' } } });
  expect(el.style.textCase).toBe('uppercase');
  expect(el.style.fontFamily).toBe('Montserrat');

  // Once the face has loaded, only that word looks different. (The line
  // re-centres around the new word's width, so the others are compared by
  // how much of them there is, not pixel for pixel.)
  await page.waitForTimeout(1000);
  await seek(page, 3.01);
  const after = await page.evaluate(() => window.__debugTextWordRects());
  const inkAfter = [await darkIn(page, after[0]), await darkIn(page, after[1]), await darkIn(page, after[2])];
  console.log('dark px per word, before → after:', JSON.stringify(inkBefore), '→', JSON.stringify(inkAfter));
  expect(Math.abs(inkAfter[0] - inkBefore[0])).toBeLessThan(inkBefore[0] * 0.05);
  expect(Math.abs(inkAfter[2] - inkBefore[2])).toBeLessThan(inkBefore[2] * 0.05);
  // The restyled word is laid out in its own face: its width changes; the
  // others keep theirs exactly.
  expect(Math.abs(after[1].width - words[1].width)).toBeGreaterThan(words[1].width * 0.1);
  expect(after[0].width).toBeCloseTo(words[0].width, 6);
  expect(after[2].width).toBeCloseTo(words[2].width, 6);

  // "Whole text" goes back to styling every word.
  await page.locator('#textel-edit-whole').click();
  await expect(page.locator('#textel-word-editing')).toHaveCount(0);
  await expect(page.locator('#textel-word-hint')).toBeVisible();
});

test('one word of a card is moved, resized and rotated on its own; the others stay; each gesture is one undo', async ({ page }) => {
  await openDemo(page);
  await addCard(page);
  const rest = await page.evaluate(() => window.__debugTextWordRects());
  await selectCardWord(page, 1);
  const frame = await page.locator('#preview-video').boundingBox();

  // The handles are there for the word.
  const corner = page.locator('#caption-transform-box .caption-transform-handle[data-handle="br"]');
  await expect(corner).toBeVisible();

  // Resize: drag the corner outwards.
  const hb = await corner.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 30, hb.y + hb.height / 2 + 15, { steps: 6 });
  await page.mouse.up();
  let entry = (await card(page)).wordTransforms?.w1;
  console.log('after resize:', JSON.stringify(entry));
  expect(entry.fontScale).toBeGreaterThan(1.2);

  // Move: drag the word itself down.
  const word = (await page.evaluate(() => window.__debugTextWordRects()))[1];
  const cx = frame.x + word.x + word.width / 2;
  const cy = frame.y + word.y + word.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 40, { steps: 6 });
  await page.mouse.up();
  entry = (await card(page)).wordTransforms.w1;
  console.log('after move:', JSON.stringify(entry));
  expect(entry.offsetYPx).toBeGreaterThan(10);
  // The word is still the selection, and the card itself did not move.
  expect(await page.evaluate(() => window.__debugSelectedTextWordIndex())).toBe(1);
  expect((await card(page)).style.customPosY).toBe(50);

  // Rotate.
  const rot = page.locator('#caption-transform-handle-rotate');
  const rb = await rot.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2 + 60, rb.y + rb.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  entry = (await card(page)).wordTransforms.w1;
  expect(Math.abs(entry.rotationDeg)).toBeGreaterThan(10);

  // The other words have not moved, and have no entry of their own.
  const now = await page.evaluate(() => window.__debugTextWordRects());
  expect(now[0]).toEqual(rest[0]);
  expect(now[2]).toEqual(rest[2]);
  expect(Object.keys((await card(page)).wordTransforms)).toEqual(['w1']);

  // A plain click on the word changes nothing.
  const sel = (await page.evaluate(() => window.__debugTextWordRects()))[1];
  const before = JSON.stringify((await card(page)).wordTransforms);
  const box = await page.locator('#caption-transform-box').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(JSON.stringify((await card(page)).wordTransforms)).toBe(before);
  void sel;

  // One Undo per gesture: rotate, then move, then resize.
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' });
  await undo.click();
  expect((await card(page)).wordTransforms.w1.rotationDeg ?? 0).toBe(0);
  await undo.click();
  expect((await card(page)).wordTransforms.w1.offsetYPx ?? 0).toBe(0);
  await undo.click();
  expect((await card(page)).wordTransforms?.w1?.fontScale ?? 1).toBe(1);
});
