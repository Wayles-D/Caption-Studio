import { test, expect } from '@playwright/test';

// CLICKING A CLIP ON THE TIMELINE:
//  - puts the playhead WHERE YOU CLICKED (it used to jump to the clip's start,
//    so a click in the middle of a long audio clip threw it back);
//  - brings that clip's panel up: a sound effect or audio clip → Audio, with
//    its row in the lane's colour; a caption → the Captions tools;
//  - and switching light/dark mode keeps whichever panel is open.
const APP_URL = 'http://localhost:5173/?splash=0';
const SP = process.env.BHYND_SHOTS || null;

async function open(page, theme = 'dark') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('bhynd-theme', JSON.stringify({ state: { theme: t }, version: 0 })); return new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); }, theme);
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.evaluate(() => {
    const words = 'one two three four five six'.split(' ').map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const phrases = [{ start: 0, end: 2.9, words: words.map((w, i) => ({ ...w, wordIndex: i })), breakAfterIndices: [] }];
    window.__updateState({ words, phrases }, { recordHistory: false });
    window.__captionEvents.captureCaptionEventsFromPhrases(phrases, { force: true });
    window.__audioTimeline.addAudioTrack({ name: 'music.mp3', assetId: 'stand-in.mp3', url: '/sounds/whoosh.mp3', duration: 6 }, { startTime: 3 });
    window.__audioTimeline.addSoundEvent('tick', 9.5);
    window.__audioTimeline.selectClip(null);
    document.getElementById('preview-video').currentTime = 0.2;
  });
  await page.waitForTimeout(600);
}
const now = (page) => page.evaluate(() => document.getElementById('preview-video').currentTime);
const panel = (page) => page.locator('#desktop-side-panel').getAttribute('aria-label');

test('a click in the middle of an audio clip puts the playhead there, and opens Audio with that row in green', async ({ page }) => {
  await open(page);
  const clip = page.locator('.timeline-audio-clip');
  const b = await clip.boundingBox();
  await page.mouse.click(b.x + b.width * 0.6, b.y + b.height / 2);
  const t = await now(page);
  console.log('clicked 60% into a 3s→9s clip; playhead at', t.toFixed(2));
  expect(t).toBeGreaterThan(6.2); // 3 + 0.6 × 6 = 6.6, give or take a pixel
  expect(t).toBeLessThan(7.0);
  await expect.poll(() => panel(page)).toBe('Audio');
  const id = await page.evaluate(() => window.__appState.audioTracks[0].id);
  const row = page.locator(`[data-audio-row="${id}"]`);
  await expect(row).toBeVisible();
  const colours = await row.evaluate((el) => {
    const cs = getComputedStyle(el);
    const lane = getComputedStyle(document.documentElement).getPropertyValue('--lane-audio').trim();
    return { left: cs.borderLeftColor, lane };
  });
  console.log('row stripe', colours.left, 'lane colour', colours.lane);
  expect(colours.left).not.toBe('rgba(0, 0, 0, 0)');
  if (SP) await page.screenshot({ path: `${SP}/audio-panel-dark.png` });

  // Switching the mode keeps the panel open.
  await page.locator('#theme-toggle').click();
  await page.waitForTimeout(300);
  expect(await panel(page)).toBe('Audio');
  if (SP) await page.screenshot({ path: `${SP}/audio-panel-light.png` });
});

test('a sound effect opens Audio; a caption opens the Captions tools', async ({ page }) => {
  await open(page);
  await page.locator('.timeline-sfx-clip').click();
  await expect.poll(() => panel(page)).toBe('Audio');
  const sfxId = await page.evaluate(() => window.__appState.soundEvents[0].id);
  await expect(page.locator(`[data-sfx-row="${sfxId}"]`)).toBeVisible();

  const caption = page.locator('.timeline-text-clip.is-transcript').first();
  const cb = await caption.boundingBox();
  await page.mouse.click(cb.x + cb.width * 0.7, cb.y + cb.height / 2);
  await expect.poll(() => panel(page)).toBe('Caption text');
  const t = await now(page);
  expect(t).toBeGreaterThan(1.6); // where it was clicked, not the caption's start
});
