import { test, expect } from '@playwright/test';
import { SOUND_IDS } from '../../shared/soundRegistry.js';

// THE TRANSCRIPT AS AN EDITING SURFACE, and the live SFX preview's first play.
//
//  - Focusing a word shows THAT word on the canvas, not its neighbour.
//    Transcript words usually touch (one ends on the instant the next starts),
//    and the preview resolves a shared boundary to the earlier word/phrase.
//  - A word's ♪ places a sound effect on that word, on the SFX lane.
//  - The first play of a project plays its effects even when the sound files
//    take a while to arrive, and nothing sounds while the video is stalled.

// Touching words — every boundary shared — grouped three to a caption.
const TEXTS = 'Here are five home office hacks to create a productive space first we have this monitor light bar'.split(' ');
const WORDS = TEXTS.map((word, i) => ({ word, start: +(0.5 + i * 0.3).toFixed(2), end: +(0.8 + i * 0.3).toFixed(2) }));

async function load(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?splash=0');
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.evaluate((words) => {
    const phrases = [];
    for (let i = 0; i < words.length; i += 3) {
      const ws = words.slice(i, i + 3).map((w, k) => ({ ...w, wordIndex: i + k }));
      phrases.push({ start: ws[0].start, end: ws.at(-1).end, words: ws, breakAfterIndices: [] });
    }
    window.__updateState({ words, phrases, soundEvents: [] }, { recordHistory: false });
  }, WORDS);
  await page.getByRole('button', { name: 'Transcript', exact: true }).first().click();
  await expect(page.locator('.word-chip')).toHaveCount(WORDS.length);
}

/** What the preview puts on screen at the playhead: the phrase and word its lookups resolve to (preview.js). */
const onScreen = (page) => page.evaluate(() => {
  const t = document.getElementById('preview-video').currentTime;
  const p = window.__appState.phrases.find((x) => t >= x.start && t <= x.end);
  return { phrase: p?.words.map((w) => w.wordIndex), word: p?.words.find((w) => t >= w.start && t <= w.end)?.wordIndex };
});

test('focusing a word in the transcript puts that word — not the one before — on the canvas', async ({ page }) => {
  await load(page);
  for (let i = 0; i < WORDS.length; i++) {
    await page.locator('.word-chip').nth(i).focus();
    const s = await onScreen(page);
    expect(s.word, `word ${i} "${WORDS[i].word}"`).toBe(i);
    expect(s.phrase).toContain(i);
  }
  // A playhead parked exactly on a shared boundary is not "already there".
  await page.locator('.word-chip').nth(4).blur();
  await page.evaluate((t) => { document.getElementById('preview-video').currentTime = t; }, WORDS[5].start);
  await page.locator('.word-chip').nth(5).focus();
  expect((await onScreen(page)).word).toBe(5);
});

test('a word\'s ♪ places a sound effect on that word, on the SFX lane; undo takes it back', async ({ page }) => {
  await load(page);
  const sfx = page.locator('.word-chip-sfx-toggle[data-word-sfx="7"]');
  await expect(sfx).not.toHaveClass(/active/);
  await sfx.click();
  await expect(page.locator('#sound-library-panel')).toBeVisible();
  // Scrubbing while choosing must not move where it lands.
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 4.2; });
  await page.locator(`[data-sound-add="${SOUND_IDS[0]}"]`).click();
  await expect(page.locator('#sound-library-panel')).toHaveCount(0);

  const events = await page.evaluate(() => window.__appState.soundEvents.map((e) => ({ id: e.id, t: e.startTime, s: e.soundId })));
  expect(events).toHaveLength(1);
  expect(events[0].t).toBeCloseTo(WORDS[7].start, 6);
  expect(events[0].s).toBe(SOUND_IDS[0]);
  await expect(page.locator(`#timeline-sfx-track .timeline-sfx-clip`)).toHaveCount(1);
  await expect(sfx).toHaveClass(/active/);
  await expect(page.locator('.word-chip-sfx-toggle.active')).toHaveCount(1);

  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await expect(page.locator('#timeline-sfx-track .timeline-sfx-clip')).toHaveCount(0);
  await expect(sfx).not.toHaveClass(/active/);
});

/** Records every Web Audio source started, against the video's state at that moment. */
async function recordSources(page) {
  await page.addInitScript(() => {
    window.__sources = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
      const v = document.getElementById('preview-video');
      // When it will sound, in VIDEO time: where the video is now plus how far ahead it is scheduled.
      window.__sources.push({ at: v.currentTime + Math.max(0, when - this.context.currentTime) * v.playbackRate, paused: v.paused });
      return start.call(this, when, ...rest);
    };
  });
}

test('first play: effects play even when the sound files are slow to arrive', async ({ page }) => {
  await recordSources(page);
  await page.route('**/sounds/**', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await load(page);
  await page.evaluate((ids) => { [1.5, 2.0, 2.5].forEach((t, i) => window.__audioTimeline.addSoundEvent(ids[i], t)); }, SOUND_IDS);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.locator('#timeline-play-btn').click();
  await page.waitForFunction(() => document.getElementById('preview-video').currentTime > 2.8, null, { timeout: 15000 });
  await page.locator('#timeline-play-btn').click();
  const started = await page.evaluate(() => window.__sources);
  // All three — the files arrived ~0.9s in, before any of them was due.
  expect(started.map((s) => Math.round(s.at * 2) / 2).sort()).toEqual([1.5, 2, 2.5]);
  expect(started.every((s) => !s.paused)).toBe(true);
});

test('a stall while sounds are loading stays silent, then playback resumes them in place', async ({ page }) => {
  await recordSources(page);
  await page.route('**/sounds/**', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
  await load(page);
  await page.evaluate((ids) => { [2.5, 3.0].forEach((t, i) => window.__audioTimeline.addSoundEvent(ids[i], t)); }, SOUND_IDS);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  await page.locator('#timeline-play-btn').click();
  // The browser reports a stall: the picture is frozen, though not paused.
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('preview-video').dispatchEvent(new Event('waiting')));
  await page.waitForTimeout(1000); // the sounds arrive meanwhile
  expect(await page.evaluate(() => window.__sources.length)).toBe(0);
  await page.evaluate(() => document.getElementById('preview-video').dispatchEvent(new Event('playing')));
  await page.waitForFunction(() => window.__sources.length === 2, null, { timeout: 5000 });
  await page.locator('#timeline-play-btn').click();
  const started = await page.evaluate(() => window.__sources);
  expect(started.map((s) => Math.round(s.at * 2) / 2).sort()).toEqual([2.5, 3]);
});
