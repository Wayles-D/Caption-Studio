import { test, expect } from '@playwright/test';
import fs from 'fs';

// EDITING PROXY, end to end, in FIREFOX — the browser that broke.
//
// An iPhone records HEVC. Firefox on Windows cannot decode HEVC without a
// paid Windows codec: it reads the file's header (so the editor showed the
// name and "3:30") and then fails on the first frame (MEDIA_ERR_DECODE) —
// no picture, no video sound, only the separately-played sound effects. A
// reload brought the same undecodable file back.
//
// The fix (backend/utils/proxyVideo.js, src/js/proxyPlayback.js): the server
// makes a browser-safe H.264 copy while transcription runs; the editor opens
// without waiting for it, switches to it when it lands, and keeps it for
// every reload. This drives the REAL upload button with a REAL phone video.
//
// Needs `npm run dev:all` (backend + :5173, the origin the backend's CORS
// allows) and a real HEVC phone clip: BHYND_HEVC_SAMPLE, or the default path
// below. Skips cleanly when there is none — the sample is the user's own
// footage and is never part of the repository.
const SAMPLE = process.env.BHYND_HEVC_SAMPLE
  || 'C:/Users/User/OneDrive/Videos/Captures/CCCD2E97-7537-474F-BBE1-DD69A669D0BB Copy.mov';
const APP_URL = 'http://localhost:5173/?splash=0';

test.use({ browserName: 'firefox' });
test.describe.configure({ timeout: 15 * 60 * 1000 });
test.skip(!fs.existsSync(SAMPLE), `no HEVC sample at ${SAMPLE}`);

/** What the editor's player is doing right now. */
const playerState = (page) => page.evaluate(() => {
  const v = document.getElementById('preview-video');
  return v ? { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, err: v.error && v.error.code, src: (v.currentSrc || '').slice(0, 5) } : null;
});

/** Plays for a moment and reports whether time actually moved — real decoding, not just metadata. */
async function playsForReal(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.muted = true;
    const from = v.currentTime;
    v.play().then(() => setTimeout(() => {
      const moved = v.currentTime - from;
      v.pause();
      resolve({ moved: +moved.toFixed(2), readyState: v.readyState });
    }, 2500)).catch((e) => resolve({ moved: 0, error: String(e) }));
  }));
}

test('an iPhone HEVC video imports, plays in Firefox, and still plays after a reload', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();

  // The real upload control.
  const t0 = Date.now();
  await page.locator('input[type="file"][accept*="video"]').first().setInputFiles(SAMPLE);

  // The editor opens on the transcript WITHOUT waiting for the proxy — and
  // says so over the video instead of showing a player that looks broken.
  await expect(page.locator('#preview-notice')).toBeVisible({ timeout: 5 * 60 * 1000 });
  const editorOpenSeconds = Math.round((Date.now() - t0) / 1000);
  console.log(`editor open after ${editorOpenSeconds}s (was ~13-14 minutes)`);

  // The proxy arrives and the player moves onto it.
  await expect(page.locator('#preview-notice')).toHaveCount(0, { timeout: 10 * 60 * 1000 });
  const proxySeconds = Math.round((Date.now() - t0) / 1000);
  const afterSwap = await playerState(page);
  console.log(`preview ready after ${proxySeconds}s:`, JSON.stringify(afterSwap));
  expect(afterSwap.err, 'no decode error').toBeNull();
  expect(afterSwap.w, 'the 1080p proxy, upright').toBe(1080);
  expect(afterSwap.h).toBe(1920);

  const played = await playsForReal(page);
  console.log('playback:', JSON.stringify(played));
  expect(played.moved, 'the video actually plays').toBeGreaterThan(1);

  // THE RELOAD that used to bring back an undecodable file.
  await page.reload();
  await page.waitForFunction(() => {
    const v = document.getElementById('preview-video');
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, null, { timeout: 60000 });
  const reloaded = await playerState(page);
  console.log('after reload:', JSON.stringify(reloaded));
  expect(reloaded.err).toBeNull();
  expect(reloaded.w).toBe(1080);
  await expect(page.locator('#preview-notice'), 'nothing left to wait for').toHaveCount(0);
  const replayed = await playsForReal(page);
  console.log('playback after reload:', JSON.stringify(replayed));
  expect(replayed.moved).toBeGreaterThan(1);

  expect(errs, `page errors: ${errs.join(' | ')}`).toEqual([]);
});
