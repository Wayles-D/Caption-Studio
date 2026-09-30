import { test, expect } from '@playwright/test';

// The v1 fixes, each driven through the real UI:
//   - the project survives a reload (IndexedDB, src/js/projectPersistence.js);
//   - the Text & Cinematic panel opens itself, beside the preview, on desktop;
//   - the on-video toolbar no longer shows caption options over a text element;
//   - sounds linked to an interlude move and delete with it.
const APP_URL = 'http://localhost:5173/?splash=0';

async function openDemo(page) {
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

test('the project survives a reload — text, cinematic, sounds, styles — and the video with it', async ({ page }) => {
  await openDemo(page);
  await seek(page, 2.5);
  await page.locator('#timeline-add-interlude-btn').click();
  await page.evaluate(() => {
    const [el] = window.__appState.textElements;
    window.__textElements.updateTextElement(el.id, { text: 'SAVED\nACROSS A RELOAD' });
    window.__textElements.updateInterludeBackground(el.id, { color: '#000000' });
    window.__textElements.addLinkedSound(el.id, 'impact-soft');
    window.__textElements.addTextElement({ kind: 'overlay', start: 6, text: 'an overlay too' });
    window.__updateState({ fontSize: 19 }, { recordHistory: true });
  });
  const before = await page.evaluate(() => ({
    text: window.__appState.textElements.map((e) => [e.kind, e.text, e.start, e.end, e.background?.color || null, e.soundIds || null]),
    sfx: window.__appState.soundEvents.map((e) => [e.id, e.soundId, e.startTime]),
    fontSize: window.__appState.fontSize
  }));
  // Let the autosave land (it is debounced).
  await page.waitForTimeout(1200);

  await page.reload();
  await expect(page.locator('#state-video.active')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Reopened your last project/)).toBeVisible();
  const after = await page.evaluate(() => ({
    text: window.__appState.textElements.map((e) => [e.kind, e.text, e.start, e.end, e.background?.color || null, e.soundIds || null]),
    sfx: window.__appState.soundEvents.map((e) => [e.id, e.soundId, e.startTime]),
    fontSize: window.__appState.fontSize,
    src: document.getElementById('preview-video').getAttribute('src'),
    canUndo: !document.querySelector('[aria-label="Undo (Ctrl+Z)"], button[title="Undo (Ctrl+Z)"]')?.disabled
  }));
  console.log('restored:', JSON.stringify(after.text));
  expect(after.text).toEqual(before.text);
  expect(after.sfx).toEqual(before.sfx);
  expect(after.fontSize).toBe(19);
  expect(after.src).toContain('demo-video');

  // It renders, too: the black card at its time.
  await page.evaluate(() => new Promise((r) => { const v = document.getElementById('preview-video'); if (v.readyState >= 1) return r(); v.addEventListener('loadedmetadata', r, { once: true }); }));
  await seek(page, 3.4);
  const corner = await page.evaluate(() => Array.from(document.getElementById('text-elements-canvas').getContext('2d').getImageData(2, 2, 1, 1).data));
  expect(corner).toEqual([0, 0, 0, 255]);
});

test('creating cinematic text opens its settings beside the preview, not over the timeline', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDemo(page);
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  // The side panel, titled for it, with the interlude's own controls.
  await expect(page.getByText('Text & Cinematic', { exact: true })).toBeVisible();
  await expect(page.locator('#interlude-bg-white')).toBeVisible();
  // …and the new clip on the timeline is still uncovered and clickable.
  const clip = page.locator('#timeline-interlude-track .timeline-text-clip').first();
  const box = await clip.boundingBox();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.timeline-text-clip') != null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toBe(true);
});

test('selecting text on the video hides the caption-only toolbar options', async ({ page }) => {
  await openDemo(page);
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  await seek(page, 3);
  const toolbar = await page.evaluate(() => {
    const t = document.getElementById('caption-transform-toolbar');
    return { hiddenAttr: t.hidden, display: getComputedStyle(t).display, captionsVisible: !!document.getElementById('btn-transform-scope-all')?.offsetParent };
  });
  console.log('toolbar while text is selected:', JSON.stringify(toolbar));
  expect(toolbar.hiddenAttr).toBe(true);
  expect(toolbar.display).toBe('none');
  expect(toolbar.captionsVisible).toBe(false);
});

test('a sound added at an interlude\'s start is linked: it moves and deletes with it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openDemo(page);
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  await page.locator('#interlude-add-sound').click();
  await page.locator('#sound-library-search').fill('soft impact');
  await page.locator('[data-sound-add="impact-soft"]').click();
  await page.waitForTimeout(300);

  let state = await page.evaluate(() => ({ el: window.__appState.textElements[0], sfx: window.__appState.soundEvents }));
  expect(state.sfx.length).toBe(1);
  expect(state.sfx[0].startTime).toBe(state.el.start);
  expect(state.el.soundIds).toEqual([state.sfx[0].id]);
  await expect(page.locator(`[data-interlude-sound-link="${state.sfx[0].id}"]`)).toBeChecked();

  // Drag the interlude on the timeline: the sound comes along by the same amount.
  const clip = page.locator('#timeline-interlude-track .timeline-text-clip').first();
  const b = await clip.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 150, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  state = await page.evaluate(() => ({ el: window.__appState.textElements[0], sfx: window.__appState.soundEvents }));
  console.log('after drag:', state.el.start.toFixed(3), state.sfx[0].startTime.toFixed(3));
  expect(state.el.start).toBeGreaterThan(2.5);
  expect(state.sfx[0].startTime).toBeCloseTo(state.el.start, 6);

  // One Undo puts BOTH back.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await page.waitForTimeout(300);
  state = await page.evaluate(() => ({ el: window.__appState.textElements[0], sfx: window.__appState.soundEvents }));
  expect(state.el.start).toBe(2);
  expect(state.sfx[0].startTime).toBe(2);

  // Unlinked, it stays put when the interlude moves.
  await page.locator(`[data-interlude-sound-link="${state.sfx[0].id}"]`).uncheck();
  await page.evaluate((id) => window.__textElements.moveTextElement(id, 4), state.el.id);
  state = await page.evaluate(() => ({ el: window.__appState.textElements[0], sfx: window.__appState.soundEvents }));
  expect(state.sfx[0].startTime).toBe(2);

  // Re-linked, deleting the interlude deletes it too; Undo restores both.
  // (Only sounds inside the span, or already linked, are offered — so bring it back over the sound first.)
  await page.evaluate((id) => window.__textElements.moveTextElement(id, 2), state.el.id);
  await page.locator(`[data-interlude-sound-link="${state.sfx[0].id}"]`).check();
  await page.evaluate((id) => window.__textElements.removeTextElement(id), state.el.id);
  state = await page.evaluate(() => ({ els: window.__appState.textElements.length, sfx: window.__appState.soundEvents.length }));
  expect(state).toEqual({ els: 0, sfx: 0 });
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await page.waitForTimeout(300);
  state = await page.evaluate(() => ({ els: window.__appState.textElements.length, sfx: window.__appState.soundEvents.length }));
  expect(state).toEqual({ els: 1, sfx: 1 });
});
