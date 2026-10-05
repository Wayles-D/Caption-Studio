import { test, expect } from '@playwright/test';

// KEYFRAMES LIVE ON THE CLIP THEY ANIMATE (timelinePanel.js's refreshLanes):
// the video's on the video strip, a caption's (or a word's) on its caption
// clip, a text overlay's or cinematic card's on its own clip — each at the
// right moment, draggable there; and a keyframed clip that is NOT selected
// still shows (passive) diamonds, so it is recognisable at a glance.

const PHRASES = [[0.2, 1.8, ['HOME', 'OFFICE', 'HACKS']], [2.2, 4.0, ['FOR', 'YOUR', 'DESK']]];

async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  return page.evaluate((spec) => {
    let i = 0;
    const words = [];
    const phrases = spec.map(([start, end, texts]) => {
      const step = (end - start) / texts.length;
      const ws = texts.map((word, k) => ({ word, start: +(start + k * step).toFixed(2), end: +(start + (k + 1) * step).toFixed(2), wordIndex: i++ }));
      words.push(...ws);
      return { start, end, words: ws, breakAfterIndices: [] };
    });
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases);
    return document.getElementById('preview-video').duration;
  }, PHRASES);
}

async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-6) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

/** Where time `t` is on screen — the ruler, filmstrip and every lane share one axis. */
const xOfTime = (page, t) => page.evaluate((time) => {
  const r = document.getElementById('timeline-filmstrip-track').getBoundingClientRect();
  return r.left + (time / document.getElementById('preview-video').duration) * r.width;
}, t);

const centreX = async (loc) => { const b = await loc.boundingBox(); return b.x + b.width / 2; };
const videoStripMarkers = (page) => page.locator('#timeline-keyframe-overlay .timeline-marker');
const captionClip = (page, n) => page.evaluate((k) => window.__appState.captionEvents[k].id, n).then((id) => page.locator(`[data-clip-id="${id}"]`));

async function selectCaption(page, t) {
  await seek(page, t);
  await page.waitForFunction(() => window.__debugCaptionBoxRect?.() != null);
  const frame = await page.locator('#state-video').boundingBox();
  const r = await page.evaluate(() => window.__debugCaptionBoxRect());
  await page.mouse.click(frame.x + r.centerX, frame.y + r.centerY);
  await expect(page.locator('#timeline-target-label')).not.toHaveText('');
}

test('the video\'s keyframes stay on the video strip', async ({ page }) => {
  await setup(page);
  await page.locator('#timeline-video-chip').click();
  await seek(page, 1.5);
  await page.locator('#timeline-add-keyframe-btn').click();
  await expect(videoStripMarkers(page)).toHaveCount(1);
  expect(Math.abs(await centreX(videoStripMarkers(page)) - await xOfTime(page, 1.5))).toBeLessThan(3);
  await expect(page.locator('.timeline-kf-layer .timeline-marker')).toHaveCount(0);
});

test('a caption\'s keyframes go on its own caption clip, at their time — not on the video strip', async ({ page }) => {
  await setup(page);
  await selectCaption(page, 0.9);
  await page.locator('#timeline-add-keyframe-btn').click();
  await seek(page, 1.4);
  await page.locator('#timeline-add-keyframe-btn').click();

  const clip = await captionClip(page, 0);
  const onClip = clip.locator('.timeline-marker:not(.is-passive)');
  await expect(onClip).toHaveCount(2);
  await expect(videoStripMarkers(page)).toHaveCount(0);
  // Each where its keyframe is, on the shared time axis.
  const xs = await onClip.evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return b.x + b.width / 2; }));
  expect(Math.abs(xs[0] - await xOfTime(page, 0.9))).toBeLessThan(3);
  expect(Math.abs(xs[1] - await xOfTime(page, 1.4))).toBeLessThan(3);
  // The other caption has none.
  await expect((await captionClip(page, 1)).locator('.timeline-marker')).toHaveCount(0);

  // Select something else (the video): the caption keeps quiet diamonds, so
  // it still reads as animated; nothing moves to the video strip.
  await page.locator('#timeline-video-chip').click();
  await expect(clip.locator('.timeline-marker.is-passive')).toHaveCount(2);
  await expect(videoStripMarkers(page)).toHaveCount(0);
});

test('a single word\'s keyframe goes on the clip of the caption it is in', async ({ page }) => {
  await setup(page);
  await seek(page, 2.9);
  await page.waitForFunction(() => window.__debugWordScreenRect?.(4) != null);
  const frame = await page.locator('#state-video').boundingBox();
  // "YOUR" — word 4, in the second caption.
  const w = await page.evaluate(() => window.__debugWordScreenRect(4));
  // First click selects the caption, second the word.
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(frame.x + w.centerX, frame.y + w.centerY);
    if (/Word|Keyword/.test(await page.locator('#timeline-target-label').textContent())) break;
  }
  await expect(page.locator('#timeline-target-label')).toHaveText(/Word|Keyword/);
  await page.locator('#timeline-add-keyframe-btn').click();
  await expect((await captionClip(page, 1)).locator('.timeline-marker:not(.is-passive)')).toHaveCount(1);
  await expect((await captionClip(page, 0)).locator('.timeline-marker')).toHaveCount(0);
  await expect(videoStripMarkers(page)).toHaveCount(0);
});

test('a text overlay\'s and a cinematic card\'s keyframes go on their own clips; dragging one inside its clip retimes it', async ({ page }) => {
  await setup(page);
  const ids = await page.evaluate(() => {
    const ov = window.__textElements.addTextElement({ kind: 'overlay', start: 1, text: 'OVERLAY' });
    window.__textElements.updateTextElement(ov.id, { end: 5 });
    const card = window.__textElements.addInterlude({ start: 6 });
    return { ov: ov.id, card: card.id };
  });
  // The overlay: select it, two keyframes.
  await page.evaluate((id) => window.__textElements.selectTextElement(id), ids.ov);
  await seek(page, 2);
  await page.locator('#timeline-add-keyframe-btn').click();
  await seek(page, 4);
  await page.locator('#timeline-add-keyframe-btn').click();
  const ovClip = page.locator(`[data-clip-id="${ids.ov}"]`);
  await expect(ovClip.locator('.timeline-marker:not(.is-passive)')).toHaveCount(2);
  await expect(videoStripMarkers(page)).toHaveCount(0);

  // Drag the 2s diamond to 3s, inside the clip.
  const first = ovClip.locator('.timeline-marker').first();
  const b = await first.boundingBox();
  const to = await xOfTime(page, 3);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(to, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const times = await page.evaluate((id) => window.__appState.textElements.find((e) => e.id === id).keyframes.map((k) => k.t), ids.ov);
  expect(times[0]).toBeCloseTo(3, 1);
  expect(times[1]).toBeCloseTo(4, 6);

  // The card: its own clip on the Cinematic lane.
  await page.evaluate((id) => window.__textElements.selectTextElement(id), ids.card);
  await seek(page, 6.5);
  await page.locator('#timeline-add-keyframe-btn').click();
  await expect(page.locator(`[data-clip-id="${ids.card}"] .timeline-marker:not(.is-passive)`)).toHaveCount(1);
  // The overlay, no longer selected, keeps its two — passively.
  await expect(ovClip.locator('.timeline-marker.is-passive')).toHaveCount(2);
  await expect(videoStripMarkers(page)).toHaveCount(0);
});

test('the keyframe button toggles: pressed again on the same spot, it removes the keyframe', async ({ page }) => {
  await setup(page);
  const id = await page.evaluate(() => window.__textElements.addInterlude({ start: 1 }).id);
  await page.evaluate((i) => window.__textElements.selectTextElement(i), id);
  await seek(page, 1.6);
  const btn = page.locator('#timeline-add-keyframe-btn');
  await btn.click();
  const keyframes = () => page.evaluate((i) => (window.__appState.textElements.find((e) => e.id === i).keyframes || []).length, id);
  expect(await keyframes()).toBe(1);
  await expect(btn).toHaveText(/Remove keyframe/);
  await btn.click();
  expect(await keyframes()).toBe(0);
  await expect(btn).toHaveText(/◆ Keyframe/);
  // Moved on, it adds again.
  await btn.click();
  await seek(page, 2.2);
  await btn.click();
  expect(await keyframes()).toBe(2);
});

test('Backspace on a cinematic card\'s keyframe removes ONLY that keyframe — never the card', async ({ page }) => {
  await setup(page);
  const id = await page.evaluate(() => window.__textElements.addInterlude({ start: 1 }).id);
  await page.evaluate((i) => window.__textElements.selectTextElement(i), id);
  await seek(page, 1.4);
  await page.locator('#timeline-add-keyframe-btn').click();
  await seek(page, 2.4);
  await page.locator('#timeline-add-keyframe-btn').click();
  const state = () => page.evaluate((i) => {
    const el = window.__appState.textElements.find((e) => e.id === i);
    return el ? el.keyframes.map((k) => +k.t.toFixed(2)) : null;
  }, id);
  const diamonds = page.locator(`[data-clip-id="${id}"] .timeline-marker:not(.is-passive)`);

  // Click a diamond (it takes focus), Backspace: the focused-diamond path.
  await diamonds.first().click();
  await page.keyboard.press('Backspace');
  expect(await state()).toEqual([2.4]);

  // Click the other, then Delete with focus moved off it: the document path.
  await diamonds.first().click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Delete');
  expect(await state(), 'the card is still there').toEqual([]);

  // With no keyframe selected, Delete means the card again.
  await page.locator(`[data-clip-id="${id}"]`).click();
  await page.keyboard.press('Delete');
  expect(await state()).toBeNull();
});
