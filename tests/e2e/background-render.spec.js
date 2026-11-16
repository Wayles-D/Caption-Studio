import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

// BACKGROUND RENDERING (V2.3.2), against the REAL backend — nothing faked:
// the editor sends the project when the edits settle, the server renders it
// in chunks, and Export then only joins them. An edit afterwards is picked up
// the same way.
//
// Needs the backend running (npm run dev:backend). The video is placed on the
// server as an upload would leave it; BHYND_TEST_VIDEO (optional) is a real
// phone video to cut 25 seconds from, for the 1080p choice — the demo video
// is used otherwise.
const APP_URL = 'http://localhost:5173/?splash=0';
const API = 'http://localhost:5050';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const UPLOADS = path.join(ROOT, 'backend', 'uploads');
const SP = process.env.BHYND_SHOTS || null;
test.setTimeout(300000);

test.beforeAll(async ({ request }) => {
  const up = await request.get(`${API}/api/upload/info/x`).then(() => true, () => false);
  test.skip(!up, 'needs the backend running (npm run dev:backend)');
});

function placeUpload(id) {
  const src = process.env.BHYND_TEST_VIDEO;
  if (!src) {
    const file = path.join(UPLOADS, `${id}.mp4`);
    fs.copyFileSync(path.join(ROOT, 'public', 'demo-video.mp4'), file);
    return file;
  }
  const ffmpeg = spawnSync('node', ['-e', "import('ffmpeg-static').then(m=>console.log(m.default))"], { cwd: path.join(ROOT, 'backend'), encoding: 'utf8' }).stdout.trim();
  const file = path.join(UPLOADS, `${id}${path.extname(src)}`);
  spawnSync(ffmpeg, ['-y', '-v', 'error', '-ss', '60', '-i', src, '-t', '25', '-c', 'copy', '-map_metadata', '0', file]);
  return file;
}

async function openProject(page, id, theme = 'dark') {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(APP_URL);
  await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('bhynd-theme', JSON.stringify({ state: { theme: t }, version: 0 })); }, theme);
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  await page.evaluate((baseName) => {
    const said = 'so this is how we put a word behind a person and it just works on every phone'.split(' ');
    const words = [];
    for (let t = 0.2, i = 0; t < 9; i += 1, t += 0.4) words.push({ word: said[i % said.length], start: +t.toFixed(2), end: +(t + 0.32).toFixed(2) });
    window.__updateState({ words, phrases: [], uploadedFile: { name: 'phone.mov' }, baseName, isProcessing: false }, { recordHistory: false });
  }, id);
}

/**
 * Waits until the editor has sent the project as it is now (its own request,
 * after the edits settle) and the server has rendered every chunk of it.
 */
async function waitPrepared(page, id, sent) {
  await sent;
  await expect.poll(async () => {
    const r = await page.request.get(`${API}/api/upload/info/${id}`);
    const p = (await r.json()).prerender;
    return p && p.upToDate && !p.rendering && p.ready === p.total ? `${p.ready}/${p.total}` : 'not yet';
  }, { timeout: 240000, intervals: [1000] }).not.toBe('not yet');
}

async function exportAndTime(page) {
  const started = Date.now();
  const download = page.waitForEvent('download', { timeout: 240000 });
  await page.locator('#btn-toolbar-export').click();
  // The dialog opens once the server has said how big the original is (a 4K one asks).
  if (await page.locator('#export-dialog').waitFor({ timeout: 5000 }).then(() => true, () => false)) await page.locator('#export-dialog-go').click();
  const file = await download;
  return { seconds: (Date.now() - started) / 1000, path: await file.path() };
}

test('the export is rendered while you edit; Export only joins it, and an edit is picked up', async ({ page }) => {
  const id = '6f1c2d3e-4a5b-4c6d-8e7f-00000000a001';
  placeUpload(id);
  const sent = page.waitForResponse((r) => r.url().includes('/api/upload/prerender'), { timeout: 60000 });
  await openProject(page, id);
  await waitPrepared(page, id, sent);

  if (process.env.BHYND_TEST_VIDEO) {
    // A 4K original: the dialog says the 1080p file is ready.
    await page.locator('#btn-toolbar-export').click();
    await expect(page.locator('[data-export-prepared="hd"]')).toHaveText('Ready — exports in seconds');
    if (SP) await page.screenshot({ path: `${SP}/prepared-dark.png` });
    await page.locator('#export-dialog-cancel').click();
  }

  const first = await exportAndTime(page);
  console.log(`export after the background render: ${first.seconds.toFixed(1)}s`);
  expect(first.seconds).toBeLessThan(15);
  expect(fs.statSync(first.path).size).toBeGreaterThan(10000);

  // An edit: a word near the end changes. The background picks it up.
  const resent = page.waitForResponse((r) => r.url().includes('/api/upload/prerender'), { timeout: 60000 });
  await page.evaluate(() => {
    const words = window.__appState.words.map((w, i, all) => (i === all.length - 2 ? { ...w, word: 'CHANGED' } : w));
    window.__updateState({ words });
  });
  await waitPrepared(page, id, resent);
  const second = await exportAndTime(page);
  console.log(`export after one edit, prepared in the background: ${second.seconds.toFixed(1)}s`);
  expect(second.seconds).toBeLessThan(15);
});

test('the prepared line reads in light mode too', async ({ page }) => {
  test.skip(!process.env.BHYND_TEST_VIDEO, 'needs a 4K phone video (BHYND_TEST_VIDEO)');
  const id = '6f1c2d3e-4a5b-4c6d-8e7f-00000000a002';
  placeUpload(id);
  const sent = page.waitForResponse((r) => r.url().includes('/api/upload/prerender'), { timeout: 60000 });
  await openProject(page, id, 'light');
  await waitPrepared(page, id, sent);
  await page.locator('#btn-toolbar-export').click();
  await expect(page.locator('[data-export-prepared="hd"]')).toHaveText('Ready — exports in seconds');
  if (SP) await page.screenshot({ path: `${SP}/prepared-light.png` });
});
