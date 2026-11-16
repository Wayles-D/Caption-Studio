import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// EXPORT SIZE — asked at every export of a video bigger than 1080p: 1080p
// (fast, what TikTok/Reels/Shorts play) or the original's own size. The
// last choice comes back preselected. The choice travels to the server.
//
// Whether to ask is decided by the ORIGINAL's size, which the server measures
// (/api/upload/info) — never by the preview, which is often the 1080p proxy
// under a blob: address. The server is faked, so this checks the dialog and
// the request, not a real render.
const APP_URL = 'http://localhost:5173/?splash=0';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.join(here, '..', '..', 'public', 'demo-video.mp4');
const SP = process.env.BHYND_SHOTS || null;

// A 3½-minute portrait 4K phone video, as the server reports it.
const UHD = { success: true, width: 2160, height: 3840, duration: 210 };

async function open(page, theme = 'dark', info = UHD) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/output/job_test_proxy.mp4*', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: fs.readFileSync(DEMO) }));
  const sent = [];
  await page.route('**/api/upload/regenerate', async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, renderedVideoPath: '/output/job_test_captioned.mp4', phrases: [] }) });
  });
  await page.route('**/output/job_test_captioned.mp4*', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Content-Disposition': 'attachment; filename=job_test_captioned.mp4' }, body: 'x' }));
  await page.route('**/api/upload/info/**', (route) => (info
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) })
    : route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' })));
  await page.route('**/api/upload/ensure*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
  await page.goto(APP_URL);
  await page.evaluate((t) => { localStorage.clear(); localStorage.setItem('bhynd-theme', JSON.stringify({ state: { theme: t }, version: 0 })); }, theme);
  await page.reload();
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
  // Now an uploaded project whose preview is the proxy of a bigger original.
  await page.evaluate(async () => {
    const words = 'so this is the export'.split(' ').map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    window.__updateState({ words, phrases: [{ start: 0, end: 2.4, words, breakAfterIndices: [] }], uploadedFile: { name: 'big.mov' }, baseName: 'job_test', isProcessing: false }, { recordHistory: false });
    const v = document.getElementById('preview-video');
    v.src = `${location.protocol}//localhost:5000/output/job_test_proxy.mp4`;
    await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  });
  return sent;
}

test('Export asks the size, defaults to 1080p, and sends the choice; Cancel exports nothing', async ({ page }) => {
  const sent = await open(page);
  await page.locator('#btn-toolbar-export').click();
  const dialog = page.locator('#export-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#export-size-hd')).toHaveAttribute('aria-checked', 'true');
  // The original is named by its real size, and both files by their size.
  await expect(page.locator('#export-size-original')).toContainText('Original quality (4K)');
  await expect(page.locator('[data-export-size="hd"]')).toHaveText('about 230 MB');
  await expect(page.locator('[data-export-size="original"]')).toHaveText('about 720 MB');
  if (SP) await page.screenshot({ path: `${SP}/export-dark.png` });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(sent).toHaveLength(0);

  await page.locator('#btn-toolbar-export').click();
  await page.locator('#export-dialog-go').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].exportSize).toBe('hd');
});

test('choosing the original is remembered for next time', async ({ page }) => {
  const sent = await open(page, 'light');
  await page.locator('#btn-toolbar-export').click();
  await page.locator('#export-size-original').click();
  if (SP) await page.screenshot({ path: `${SP}/export-light.png` });
  await page.locator('#export-dialog-go').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].exportSize).toBe('original');

  await page.locator('#btn-toolbar-export').click();
  await expect(page.locator('#export-size-original')).toHaveAttribute('aria-checked', 'true');
});

test('a video that is already 1080p exports straight away, at its own size', async ({ page }) => {
  const sent = await open(page, 'dark', { success: true, width: 1080, height: 1920, duration: 30 });
  await page.locator('#btn-toolbar-export').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].exportSize).toBe('original');
  await expect(page.locator('#export-dialog')).toHaveCount(0);
});

test('when the server cannot say how big the original is, the question is still asked', async ({ page }) => {
  const sent = await open(page, 'dark', null);
  await page.locator('#btn-toolbar-export').click();
  await expect(page.locator('#export-dialog')).toBeVisible();
  await expect(page.locator('#export-size-original')).toContainText('Original quality');
  await expect(page.locator('[data-export-size="original"]')).toHaveCount(0);
  expect(sent).toHaveLength(0);
});

test('a reopened project (preview under a blob: address) still asks', async ({ page }) => {
  const sent = await open(page);
  await page.evaluate(async () => {
    const v = document.getElementById('preview-video');
    const blob = await (await fetch(v.currentSrc)).blob();
    v.src = URL.createObjectURL(blob);
    await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  });
  await page.locator('#btn-toolbar-export').click();
  await expect(page.locator('#export-dialog')).toBeVisible();
  expect(sent).toHaveLength(0);
});
