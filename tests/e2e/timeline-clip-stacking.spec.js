import { test, expect } from '@playwright/test';

// Overlapping clips used to be uneditable. Clips are positioned by TIME, so
// two that overlap land on top of each other and only the topmost can be
// clicked or dragged — the one behind became unreachable with no way to get
// at it. Reported for text, captions and sound effects alike.
//
// Lanes now pack their clips into as few sub-rows as possible (see
// timelinePanel.js's stackClips) and grow to fit, the way CapCut does. It
// needs no extra interaction: a lane with no overlaps still renders as a
// single row.
//
// The assertions here are about REACHABILITY, not layout cosmetics — the bug
// was "I can't drag the one behind", so the test drags the one behind.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [{ word: 'HELLO', start: 0, end: 9, wordIndex: 0 }];
    window.__updateState({ words, phrases: [{ start: 0, end: 9, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.waitForTimeout(500);
}

const elements = (page) => page.evaluate(() => window.__appState.textElements);

/** Every clip's laid-out box in a lane, plus which sub-row it was packed into. */
const clipBoxes = (page, trackId) => page.evaluate((id) => {
  const track = document.getElementById(id);
  return [...track.querySelectorAll('.timeline-text-clip, .timeline-sfx-clip, .timeline-audio-clip')].map((el) => ({
    id: el.dataset.clipId,
    row: el.dataset.stackRow,
    top: el.offsetTop,
    left: el.offsetLeft,
    width: el.offsetWidth,
    height: el.offsetHeight
  }));
}, trackId);

test('a lane with no overlap stays a single row', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  await page.evaluate(() => {
    window.__textElements.addTextElement({ kind: 'overlay', text: 'FIRST', start: 0.5 });
    window.__textElements.addTextElement({ kind: 'overlay', text: 'SECOND', start: 5 });
  });
  await page.waitForTimeout(600);

  const boxes = await clipBoxes(page, 'timeline-text-track');
  console.log('no-overlap rows:', JSON.stringify(boxes.map((b) => b.row)));
  expect(boxes.length).toBe(2);
  expect(boxes.every((b) => b.row === '0')).toBe(true);
  expect(errs).toEqual([]);
});

test('overlapping clips stack, and the one behind is draggable', async ({ page }) => {
  await setup(page);

  // Two overlays covering almost exactly the same span — before stacking,
  // the second completely covered the first.
  await page.evaluate(() => {
    window.__textElements.addTextElement({ kind: 'overlay', text: 'BEHIND', start: 1 });
    window.__textElements.addTextElement({ kind: 'overlay', text: 'INFRONT', start: 1.1 });
  });
  await page.waitForTimeout(700);

  const boxes = await clipBoxes(page, 'timeline-text-track');
  console.log('overlapping boxes:', JSON.stringify(boxes));
  expect(boxes.length).toBe(2);
  // They landed on different sub-rows...
  expect(new Set(boxes.map((b) => b.row)).size).toBe(2);
  // ...at genuinely different heights, so neither covers the other.
  const tops = boxes.map((b) => b.top).sort((a, b) => a - b);
  expect(tops[1] - tops[0]).toBeGreaterThanOrEqual(boxes[0].height);

  // THE POINT: grab the one that used to be buried and drag it.
  const first = (await elements(page)).find((e) => e.text === 'BEHIND');
  const target = page.locator(`.timeline-text-clip[data-clip-id="${first.id}"]`);
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 130, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = (await elements(page)).find((e) => e.id === first.id);
  console.log('buried clip start', first.start.toFixed(2), '->', after.start.toFixed(2));
  expect(after.start).toBeGreaterThan(first.start + 0.5);
  // The other one did not move.
  const other = (await elements(page)).find((e) => e.text === 'INFRONT');
  expect(other.start).toBeCloseTo(1.1, 1);
});

test('the lane grows to fit its rows and shrinks back', async ({ page }) => {
  await setup(page);

  const laneHeight = () => page.evaluate(() =>
    document.getElementById('timeline-text-track').closest('.timeline-lane').getBoundingClientRect().height);

  await page.evaluate(() => window.__textElements.addTextElement({ kind: 'overlay', text: 'ONE', start: 1 }));
  await page.waitForTimeout(500);
  const oneRow = await laneHeight();

  await page.evaluate(() => {
    window.__textElements.addTextElement({ kind: 'overlay', text: 'TWO', start: 1.2 });
    window.__textElements.addTextElement({ kind: 'overlay', text: 'THREE', start: 1.4 });
  });
  await page.waitForTimeout(700);
  const threeRows = await laneHeight();
  console.log('lane height 1 row', oneRow, '-> 3 overlapping', threeRows);
  expect(threeRows).toBeGreaterThan(oneRow * 1.8);

  // Remove the extras — the lane must come back down rather than keeping the
  // space forever.
  await page.evaluate(() => {
    const els = window.__appState.textElements.filter((e) => e.text !== 'ONE');
    els.forEach((e) => window.__textElements.removeTextElement(e.id));
  });
  await page.waitForTimeout(700);
  const backDown = await laneHeight();
  console.log('after removing the overlaps:', backDown);
  expect(backDown).toBeCloseTo(oneRow, 0);
});

test('sound effects at nearly the same instant are both reachable', async ({ page }) => {
  await setup(page);

  // Two effects a few hundredths apart: their TIMES barely overlap, but each
  // renders as a pill far wider than that gap — which is why the packer works
  // on laid-out boxes rather than on time.
  await page.evaluate(() => {
    window.__audioTimeline.addSoundEvent('tick', 3);
    window.__audioTimeline.addSoundEvent('whoosh', 3.25);
  });
  await page.waitForTimeout(700);

  const boxes = await clipBoxes(page, 'timeline-sfx-track');
  console.log('sfx boxes:', JSON.stringify(boxes));
  expect(boxes.length).toBe(2);
  expect(new Set(boxes.map((b) => b.row)).size).toBe(2);

  // Both pills are individually hit-testable at their own centres.
  for (const b of boxes) {
    const el = page.locator(`.timeline-sfx-clip[data-clip-id="${b.id}"]`);
    await expect(el).toBeVisible();
    const bb = await el.boundingBox();
    const topMost = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('.timeline-sfx-clip')?.dataset.clipId,
      { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
    );
    expect(topMost).toBe(b.id);
  }
});
