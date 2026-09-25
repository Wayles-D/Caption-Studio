import { test, expect } from '@playwright/test';

// The transcript's own captions as EDITABLE clips (shared/captionEvent.js).
//
// They used to be derived: backend/utils/phraseGrouper.js rebuilt them from
// `words` on every regenerate AND inside the export, by pause gaps,
// punctuation, a 3-word cap and a ~22-char limit. So a caption had no
// identity and no stored timing — retiming one by shifting word timings
// appeared to work and then silently regrouped on export (drag a caption near
// its neighbour and the two MERGE, because the gap fell under the 0.25s pause
// threshold), and splitting was not expressible at all.
//
// The grouper still produces the FIRST version of the list. After that these
// events are authoritative and the exporter renders them instead of
// regrouping — which is what makes an edit survive at all.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';

/**
 * Seeds a transcript the way an upload does, then hands it to the same
 * capture path App.jsx uses.
 */
async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.evaluate(() => {
    const words = [
      { word: 'HERE', start: 0.0, end: 0.4 },
      { word: 'ARE', start: 0.4, end: 0.8 },
      { word: 'FIVE', start: 0.8, end: 1.3 },
      { word: 'HOME', start: 2.0, end: 2.4 },
      { word: 'OFFICE', start: 2.4, end: 2.9 },
      { word: 'HACKS', start: 2.9, end: 3.4 }
    ].map((w, i) => ({ ...w, wordIndex: i }));
    const phrases = [
      { start: 0.0, end: 1.3, breakAfterIndices: [], words: words.slice(0, 3).map((w, i) => ({ ...w, wordIndex: i })) },
      { start: 2.0, end: 3.4, breakAfterIndices: [], words: words.slice(3).map((w, i) => ({ ...w, wordIndex: i + 3 })) }
    ];
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
  });
  await page.waitForTimeout(600);
}

const events = (page) => page.evaluate(() => window.__appState.captionEvents);
const phrases = (page) => page.evaluate(() => window.__appState.phrases);
const words = (page) => page.evaluate(() => window.__appState.words);

test('each on-screen caption becomes a clip on the Captions lane', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  const evs = await events(page);
  console.log('caption events:', JSON.stringify(evs.map((e) => ({ s: e.start, e: e.end, w: e.wordIndices }))));
  expect(evs.length).toBe(2);
  expect(evs[0].wordIndices).toEqual([0, 1, 2]);
  expect(evs[1].wordIndices).toEqual([3, 4, 5]);

  const clips = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript');
  await expect(clips).toHaveCount(2);
  // The clip shows what is actually on screen at that time.
  await expect(clips.first()).toContainText('HERE ARE FIVE');
  await expect(clips.nth(1)).toContainText('HOME OFFICE HACKS');
  expect(errs).toEqual([]);
});

test('dragging a caption retimes it, and takes its words with it', async ({ page }) => {
  await setup(page);

  const before = (await events(page))[0];
  const beforeWords = await words(page);

  const clip = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').first();
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = (await events(page))[0];
  const afterWords = await words(page);
  const delta = after.start - before.start;
  console.log('caption start', before.start.toFixed(2), '->', after.start.toFixed(2), 'delta', delta.toFixed(2));
  expect(delta).toBeGreaterThan(0.5);
  // Duration preserved by a move.
  expect(after.end - after.start).toBeCloseTo(before.end - before.start, 1);

  // The WORDS moved by the same delta — their timings drive the karaoke
  // highlight, so leaving them behind would light up the wrong words.
  [0, 1, 2].forEach((i) => {
    expect(afterWords[i].start - beforeWords[i].start).toBeCloseTo(delta, 1);
    expect(afterWords[i].end - beforeWords[i].end).toBeCloseTo(delta, 1);
  });
  // The caption that was NOT dragged is untouched, words included.
  expect(afterWords[3].start).toBeCloseTo(beforeWords[3].start, 2);

  // `phrases` is a projection of the events, so it followed automatically —
  // this is what let captions become editable without touching a renderer.
  const ph = await phrases(page);
  expect(ph[0].start).toBeCloseTo(after.start, 2);
});

test('trimming an edge changes how long it shows, without moving its words', async ({ page }) => {
  await setup(page);
  const before = (await events(page))[0];
  const beforeWords = await words(page);

  const clip = page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').first();
  const box = await clip.boundingBox();
  // Grab the right edge and pull it out.
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2 + 90, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = (await events(page))[0];
  console.log('caption end', before.end.toFixed(2), '->', after.end.toFixed(2));
  expect(after.end).toBeGreaterThan(before.end + 0.3);
  expect(after.start).toBeCloseTo(before.start, 2);

  // Trimming is about screen time, not speech — the words stayed put.
  const afterWords = await words(page);
  [0, 1, 2].forEach((i) => {
    expect(afterWords[i].start).toBeCloseTo(beforeWords[i].start, 2);
    expect(afterWords[i].end).toBeCloseTo(beforeWords[i].end, 2);
  });
});

test('a caption can be split in two, and merged back', async ({ page }) => {
  await setup(page);
  expect((await events(page)).length).toBe(2);

  const first = (await events(page))[0];
  // Split after the second of its three words.
  await page.evaluate((id) => window.__captionEvents.splitCaptionEventAt(id, 1), first.id);
  await page.waitForTimeout(500);

  let evs = await events(page);
  console.log('after split:', JSON.stringify(evs.map((e) => e.wordIndices)));
  expect(evs.length).toBe(3);
  expect(evs[0].wordIndices).toEqual([0, 1]);
  expect(evs[1].wordIndices).toEqual([2]);
  // Three clips on the lane now, and the text reflects the new split.
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript')).toHaveCount(3);
  await expect(page.locator('#timeline-captions-track .timeline-text-clip.is-transcript').first()).toContainText('HERE ARE');

  // ...and merging puts them back.
  await page.evaluate((id) => window.__captionEvents.mergeCaptionEventWithNext(id), evs[0].id);
  await page.waitForTimeout(500);
  evs = await events(page);
  console.log('after merge:', JSON.stringify(evs.map((e) => e.wordIndices)));
  expect(evs.length).toBe(2);
  expect(evs[0].wordIndices).toEqual([0, 1, 2]);
});

test('an edited caption list is not clobbered by a re-capture', async ({ page }) => {
  await setup(page);

  const targetId = (await events(page))[0].id;
  await page.evaluate((id) => window.__captionEvents.moveCaptionEventTo(id, 5), targetId);
  await page.waitForTimeout(400);
  // Looked up by id, not by index: the list is kept sorted by time, so a
  // caption moved past its neighbour is no longer where it started.
  const moved = (await events(page)).find((e) => e.id === targetId);
  expect(moved.start).toBeCloseTo(5, 1);

  // A regenerate hands back freshly grouped phrases. Adopting them would
  // silently undo the retime — capture only ever fills an EMPTY list.
  await page.evaluate(() => {
    window.__captionEvents.captureCaptionEventsFromPhrases([
      { start: 0, end: 1.3, breakAfterIndices: [], words: [{ word: 'HERE', start: 0, end: 0.4, wordIndex: 0 }] }
    ]);
  });
  await page.waitForTimeout(400);

  const after = await events(page);
  console.log('after a non-forced re-capture:', JSON.stringify(after.map((e) => e.start)));
  expect(after.length).toBe(2);
  expect(after.find((e) => e.id === moved.id).start).toBeCloseTo(5, 1);
});
