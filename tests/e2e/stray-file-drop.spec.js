import { test, expect } from '@playwright/test';

/**
 * A file dropped anywhere on the editor must not navigate the page.
 *
 * The browser's default action for a file dropped on a document is to OPEN it,
 * which replaces the single-page app — indistinguishable from "the whole app
 * restarted and I lost everything". The upload dropzone does preventDefault,
 * but it lives inside `.view-state`, which is `display: none` once a video is
 * loaded, so the editor had no guard at all: importing audio with the file
 * picker worked while DRAGGING the same file in wiped the session.
 */
test('a file dropped on the editor does not navigate the page away', async ({ page }) => {
  test.setTimeout(2 * 60 * 1000);
  await page.goto('/');
  await page.getByText('Try Demo Video').click();
  await page.waitForFunction(() => {
    const v = document.getElementById('preview-video');
    return v && v.duration > 0;
  }, { timeout: 30000 });

  // Survives an in-page update; wiped by a navigation.
  await page.evaluate(() => { window.__sessionCanary = 'alive'; });

  const result = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['fake audio bytes'], 'song.mp3', { type: 'audio/mpeg' }));

    // Drop on the editor body — deliberately NOT on the upload dropzone, which
    // is display:none by now anyway.
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(over);
    document.body.dispatchEvent(drop);

    return {
      // defaultPrevented true == the browser will NOT open/navigate to the file.
      dragoverPrevented: over.defaultPrevented,
      dropPrevented: drop.defaultPrevented
    };
  });

  expect(result.dragoverPrevented).toBe(true);
  expect(result.dropPrevented).toBe(true);

  // And the session is still the same document.
  await page.waitForTimeout(500);
  const canary = await page.evaluate(() => window.__sessionCanary ?? 'GONE');
  expect(canary).toBe('alive');
});

test('the upload dropzone still receives its own drops', async ({ page }) => {
  await page.goto('/');

  // On the upload screen the dropzone is active; the global guard must not
  // stop it from handling a real drop (preventDefault does not stop propagation).
  const handled = await page.evaluate(() => {
    const zone = document.getElementById('drop-zone');
    if (!zone) return 'no dropzone';
    let reached = false;
    zone.addEventListener('drop', () => { reached = true; }, { once: true });
    const dt = new DataTransfer();
    dt.items.add(new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return reached ? 'reached' : 'blocked';
  });

  expect(handled).toBe('reached');
});
