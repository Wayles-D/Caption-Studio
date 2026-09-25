import { test, expect } from '@playwright/test';

// Three reported editing problems with text overlays, plus the "make the
// others match" request that came with them:
//
//  1. Backspace while typing an overlay's text DELETED the whole element.
//     The timeline's global Delete/Backspace shortcut guarded only against
//     INPUT — and the Content field is a TEXTAREA.
//  2. Text could only be edited from the side panel. Double-clicking it on
//     the video now opens an inline editor over the element itself.
//  3. A style authored on one overlay had to be redone by hand on every
//     other one. "All text" / "Choose…" copies the look across.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page, { count = 1 } = {}) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'I', start: 0, end: 4, wordIndex: 0 },
      { word: 'AM', start: 4, end: 9, wordIndex: 1 },
    ];
    window.__updateState({ words, phrases: [{ start: 0, end: 9, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(400);

  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) {
      const el = window.__textElements.addTextElement({ kind: 'overlay', text: `TEXT${i}`, start: 3 });
      window.__textElements.updateTextElementStyle(el.id, {
        position: 'manual', customPosX: 30 + i * 20, customPosY: 30 + i * 20
      });
    }
    window.__textElements.selectTextElement(window.__appState.textElements[0].id);
  }, count);

  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await page.waitForTimeout(500);
}

const elements = (page) => page.evaluate(() => window.__appState.textElements);

test('Backspace in the Content field edits the text instead of deleting the element', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const field = page.locator('#textel-content');
  await field.click();
  await field.fill('HELLOO');
  await page.waitForTimeout(300);

  // The keystroke that used to wipe the element off the timeline.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);

  const els = await elements(page);
  console.log('after Backspace:', JSON.stringify(els.map((e) => e.text)));
  expect(els.length).toBe(1);
  expect(els[0].text).toBe('HELLO');

  // Delete in a text field is the same story.
  await field.press('Delete');
  await page.waitForTimeout(300);
  expect((await elements(page)).length).toBe(1);

  // ...but Delete OUTSIDE a text field must still remove the element, or the
  // fix would have traded one bug for another. Focus is moved off the field
  // to the document itself — the state the shortcut is actually meant for.
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.__textElements.selectTextElement(window.__appState.textElements[0].id);
  });
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  console.log('after Delete outside a field:', (await elements(page)).length);
  expect((await elements(page)).length).toBe(0);

  expect(errs).toEqual([]);
});

test('double-clicking an overlay on the video edits it in place', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const frame = await page.locator('#preview-video').boundingBox();
  const rects = await page.evaluate(() => window.__debugTextElementRects());
  const pt = { x: frame.x + rects[0].centerX, y: frame.y + rects[0].centerY };

  const editor = page.locator('#text-element-inline-editor');
  await expect(editor).toBeHidden();

  await page.mouse.dblclick(pt.x, pt.y);
  await page.waitForTimeout(400);
  await expect(editor).toBeVisible();
  expect(await editor.inputValue()).toBe('TEXT0');

  // Typing goes to the element, live.
  await editor.fill('ON CANVAS');
  await page.waitForTimeout(400);
  expect((await elements(page))[0].text).toBe('ON CANVAS');

  // Backspace here must edit, not delete — the same guard, via the field.
  await editor.press('Backspace');
  await page.waitForTimeout(300);
  let els = await elements(page);
  expect(els.length).toBe(1);
  expect(els[0].text).toBe('ON CANVA');

  // Enter commits and closes.
  await editor.press('Enter');
  await page.waitForTimeout(400);
  await expect(editor).toBeHidden();
  els = await elements(page);
  console.log('after inline edit:', JSON.stringify(els.map((e) => e.text)));
  expect(els[0].text).toBe('ON CANVA');

  // And the canvas actually redrew with the new words.
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) n++; return n;
  });
  expect(drawn).toBeGreaterThan(0);
  expect(errs).toEqual([]);
});

test('"All text" copies the look but never the position', async ({ page }) => {
  await setup(page, { count: 3 });

  // Style only the first one.
  await page.evaluate(() => {
    const first = window.__appState.textElements[0];
    window.__textElements.updateTextElementStyle(first.id, {
      fontSize: 42, inactiveWordColor: '#FF0000', activeWordColor: '#FF0000',
      outlineSize: 20, captionAnimationType: 'pop'
    });
  });
  await page.waitForTimeout(400);

  const before = await elements(page);
  const positionsBefore = before.map((e) => [e.style.customPosX, e.style.customPosY]);

  await page.locator('#textel-apply-all').click();
  await page.waitForTimeout(600);

  const after = await elements(page);
  console.log('styles after Apply to all:', JSON.stringify(after.map((e) => e.style)));

  after.forEach((el, i) => {
    expect(el.style.fontSize).toBe(42);
    expect(el.style.inactiveWordColor).toBe('#FF0000');
    expect(el.style.outlineSize).toBe(20);
    expect(el.style.captionAnimationType).toBe('pop');
    // Each one stayed exactly where it was — copying placement would stack
    // them all on top of each other.
    expect([el.style.customPosX, el.style.customPosY]).toEqual(positionsBefore[i]);
    // ...and kept its own words.
    expect(el.text).toBe(`TEXT${i}`);
  });

  // Three distinct positions still, all red on screen.
  const stats = await page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let drawn = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40) { drawn++; if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++; }
    }
    return { drawn, red };
  });
  console.log('overlay layer:', JSON.stringify(stats));
  expect(stats.red).toBeGreaterThan(stats.drawn * 0.2);

  // One undo takes the whole apply back.
  await page.locator('#timeline-undo-btn').click();
  await page.waitForTimeout(400);
  const undone = await elements(page);
  expect(undone[1].style.fontSize).toBeUndefined();
  expect(undone[0].style.fontSize).toBe(42);
});

test('"Choose…" applies the style to only the ticked elements', async ({ page }) => {
  await setup(page, { count: 3 });

  await page.evaluate(() => {
    const first = window.__appState.textElements[0];
    window.__textElements.updateTextElementStyle(first.id, { fontSize: 38, underline: true });
  });
  await page.waitForTimeout(400);

  const ids = (await elements(page)).map((e) => e.id);
  await page.locator('#textel-apply-choose').click();
  await page.waitForTimeout(300);

  // Tick the THIRD element only.
  await page.locator(`input[data-textel-apply-target="${ids[2]}"]`).check();
  await page.locator('#textel-apply-confirm').click();
  await page.waitForTimeout(500);

  const after = await elements(page);
  console.log('styles after Choose:', JSON.stringify(after.map((e) => ({ id: e.id, size: e.style.fontSize, u: e.style.underline }))));
  expect(after[0].style.fontSize).toBe(38);
  expect(after[1].style.fontSize).toBeUndefined();
  expect(after[1].style.underline).toBeUndefined();
  expect(after[2].style.fontSize).toBe(38);
  expect(after[2].style.underline).toBe(true);
});
