import fs from 'fs';

/**
 * Serves a local video in place of the demo clip — WITH byte ranges.
 *
 * A plain `route.fulfill({ path })` answers every request with the whole
 * file and no Range support, and a browser cannot seek a media file served
 * that way: every seek silently stays on the first frame. Anything that
 * analyses frames at different times (object detection, tracking) would then
 * look at frame 0 again and again and still "pass".
 */
export async function serveVideo(page, file, pattern = '**/demo-video.mp4') {
  const data = fs.readFileSync(file);
  await page.route(pattern, async (route) => {
    const range = route.request().headers().range;
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (!m) {
      await route.fulfill({ status: 200, body: data, headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(data.length) } });
      return;
    }
    const start = m[1] ? +m[1] : 0;
    const end = m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1;
    await route.fulfill({
      status: 206,
      body: data.subarray(start, end + 1),
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': String(end - start + 1)
      }
    });
  });
}
