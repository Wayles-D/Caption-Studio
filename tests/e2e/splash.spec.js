import { test, expect } from '@playwright/test';

// The welcome animation (src/components/SplashScreen.jsx + BhyndIntro.jsx).
//
// Alone among the specs, this one does NOT pass ?splash=0 — every other file
// does, so that eighty-odd tests are not each four seconds slower. Which
// makes this the only place the real thing is exercised, so it drives it
// rather than checking that a component mounted: the assertions below read
// the attributes the rAF loop actually writes, and fail if the mark is on
// screen but frozen.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/';
const SPLASH = '#bhynd-splash';
const MARK = '#bhynd-splash svg[aria-label="bhYnd"]';

/** The attributes the animation writes, read straight off the live nodes. */
const readMark = (page) => page.evaluate(() => {
  const svg = document.querySelector('#bhynd-splash svg[aria-label="bhYnd"]');
  if (!svg) return null;
  const at = (sel, name) => svg.querySelector(sel)?.getAttribute(name) ?? null;
  return {
    points: at('polygon', 'points'),
    polyOpacity: Number(at('polygon', 'opacity')),
    glowOpacity: Number(at('circle', 'opacity')),
    finOpacity: Number(at('g', 'opacity')),
    bhX: Number(svg.querySelectorAll('text')[0]?.getAttribute('x')),
    ndX: Number(svg.querySelectorAll('text')[1]?.getAttribute('x'))
  };
});

test('it plays on load and animates rather than sitting still', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // Samples are buffered IN THE PAGE, one per animation frame, rather than
  // read at fixed sleeps from the test. The splash is only on screen for
  // about 3.7s; a sleep-and-read pass races its own subject, and under a
  // parallel run the second read can land after it has already gone.
  await page.addInitScript(() => {
    window.__splashSamples = [];
    const tick = () => {
      const svg = document.querySelector('#bhynd-splash svg[aria-label="bhYnd"]');
      if (svg) {
        const at = (sel, name) => svg.querySelector(sel)?.getAttribute(name) ?? null;
        window.__splashSamples.push({
          points: at('polygon', 'points'),
          glow: Number(at('circle', 'opacity')),
          fin: Number(at('g', 'opacity')),
          bhX: Number(svg.querySelectorAll('text')[0]?.getAttribute('x')),
          ndX: Number(svg.querySelectorAll('text')[1]?.getAttribute('x'))
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.goto(APP_URL);
  await expect(page.locator(SPLASH)).toBeVisible();
  await expect(page.locator(MARK)).toBeVisible();
  // Wait for the splash to finish and leave — the buffer outlives it.
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 8000 });

  const samples = await page.evaluate(() => window.__splashSamples);
  // The sampler starts on the frame the SVG is committed, which is one frame
  // before React's effect paints into it, so the very first entries can be
  // the empty shell.
  const drawn = samples.filter((s) => s.points);
  console.log('frames sampled:', samples.length, '| drawn:', drawn.length);
  console.log('first drawn:', JSON.stringify({ ...drawn[0], points: drawn[0].points?.slice(0, 40) }));
  console.log('last drawn: ', JSON.stringify({ ...drawn.at(-1), points: drawn.at(-1).points?.slice(0, 40) }));

  // The blank shell is gone within a frame or two — the mark is not an empty
  // box anyone could notice.
  expect(samples.length - drawn.length).toBeLessThanOrEqual(5);
  // A real reveal, not a handful of frames or a static SVG...
  expect(drawn.length).toBeGreaterThan(30);
  // ...whose vertices genuinely moved.
  expect(new Set(drawn.map((s) => s.points)).size).toBeGreaterThan(10);

  // The glow belongs to the back half only, so it orders the timeline on its
  // own: off at the start, up by the end.
  expect(drawn[0].glow).toBe(0);
  expect(drawn.at(-1).glow).toBeGreaterThan(0);
  // The morph hands off to the rounded final mark.
  expect(drawn[0].fin).toBe(0);
  expect(drawn.at(-1).fin).toBeGreaterThan(0.9);

  // The wordmark was laid out from MEASURED text widths, so "bh" and "nd"
  // sit either side of the 600-wide viewBox's centre. A miss here means the
  // text was not measured and the "Y" is off-axis — the one failure mode
  // that still looks plausible at a glance.
  expect(drawn[0].bhX).toBeLessThan(300);
  expect(drawn[0].ndX).toBeGreaterThan(300);

  expect(errs).toEqual([]);
});

test('it settles on the finished mark, then leaves on its own', async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page.locator(SPLASH)).toBeVisible();

  // The morph hands off to the rounded final mark before the splash exits.
  await expect.poll(async () => (await readMark(page))?.finOpacity ?? 0, { timeout: 5000 })
    .toBeGreaterThan(0.9);

  // And then it gets out of the way without being asked.
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 5000 });

  // The editor underneath was mounted the whole time, so it is immediately
  // usable rather than starting up now.
  await page.getByText('Try Demo Video').click();
  await expect(page.locator('#state-video')).toHaveClass(/active/);
});

test('a press or a keypress dismisses it early', async ({ page }) => {
  await page.goto(APP_URL);
  await expect(page.locator(SPLASH)).toBeVisible();
  await page.mouse.click(640, 360);
  // Well inside the ~3.7s it would otherwise take.
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 1500 });

  await page.goto(APP_URL);
  await expect(page.locator(SPLASH)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 1500 });
});

test('?splash=0 skips it entirely', async ({ page }) => {
  await page.goto(`${APP_URL}?splash=0`);
  // Not "gone quickly" — never there. The rest of the suite depends on this.
  await expect(page.locator(SPLASH)).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page.locator(SPLASH)).toHaveCount(0);
  await page.getByText('Try Demo Video').click();
  await expect(page.locator('#state-video')).toHaveClass(/active/);
});

test('reduced motion shows the finished mark instead of the reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(APP_URL);

  // No reveal to sit through: it is already the settled mark.
  await expect.poll(async () => (await readMark(page))?.finOpacity ?? 0, { timeout: 2000 })
    .toBeGreaterThan(0.9);
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 3000 });
});

test('two instances do not share gradient ids', async ({ page }) => {
  // The splash and the processing view can both be mounted, and every
  // fill="url(#…)" is a DOCUMENT-global lookup — a shared id would leave the
  // second instance pointing at the first one's defs, which vanish when the
  // splash unmounts. So the ids are namespaced per instance; this checks the
  // namespacing is real rather than decorative.
  await page.goto(APP_URL);
  await expect(page.locator(MARK)).toBeVisible();

  const report = await page.evaluate(() => {
    const svg = document.querySelector('#bhynd-splash svg[aria-label="bhYnd"]');
    const ids = [...svg.querySelectorAll('defs [id]')].map((n) => n.id);
    // Every paint-server reference in this instance resolves inside it.
    const refs = [...svg.querySelectorAll('[fill^="url("], [stroke^="url("]')]
      .flatMap((n) => ['fill', 'stroke'].map((a) => n.getAttribute(a)))
      .filter((v) => v?.startsWith('url('))
      .map((v) => v.slice(5, -1));
    return { ids, refs, unresolved: refs.filter((id) => !ids.includes(id)) };
  });
  console.log('defs:', report.ids.join(', '));

  expect(report.ids.length).toBeGreaterThan(0);
  expect(report.refs.length).toBeGreaterThan(0);
  expect(report.unresolved).toEqual([]);
  // A bare "glow"/"c1" would collide across instances; a useId() prefix
  // cannot.
  for (const id of report.ids) expect(id.length).toBeGreaterThan('glow'.length);
});

test('the processing view shows the mark, idling, for as long as the job runs', async ({ page }) => {
  // The second place the mark appears. Transcribing lands in this view and
  // takes tens of seconds; the slot above the title had been empty since the
  // React migration.
  //
  // Driven through a REAL file selection, because that is the only path into
  // this view — the demo shortcut deliberately skips the server entirely
  // (see handleDownloadVideo). The upload request is then held open rather
  // than left to fail: what is under test is the view WHILE a long job runs,
  // and a connection refused would close the window to a few milliseconds
  // and make this a timing test. Consistent with the rest of the suite, no
  // backend is involved.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/upload**', async (route) => {
    await held;
    await route.abort();
  });

  await page.goto(`${APP_URL}?splash=0`);
  await page.locator('#video-file-input').setInputFiles('public/demo-video.mp4');

  await expect(page.locator('#state-processing')).toHaveClass(/active/);
  const mark = page.locator('#state-processing svg[aria-label="bhYnd"]');
  await expect(mark).toBeVisible();

  const read = () => page.evaluate(() => {
    const svg = document.querySelector('#state-processing svg[aria-label="bhYnd"]');
    return {
      fin: Number(svg.querySelector('g')?.getAttribute('opacity')),
      glow: Number(svg.querySelector('circle')?.getAttribute('opacity'))
    };
  });

  // It starts PAST the wordmark (INTRO_MORPH_SECONDS) — a transcription job
  // is the wrong moment for a three-second logo reveal — so it reaches the
  // finished playhead in well under the full 2.6s reveal.
  await expect.poll(async () => (await read()).fin, { timeout: 2500 }).toBeGreaterThan(0.9);

  // ...and then it keeps breathing rather than freezing. The moving glow is
  // the whole point: a held frame would read as a hung job.
  const a = (await read()).glow;
  await page.waitForTimeout(700);
  const b = (await read()).glow;
  console.log('processing glow:', a.toFixed(3), '->', b.toFixed(3));
  expect(a).toBeGreaterThan(0);
  expect(Math.abs(b - a)).toBeGreaterThan(0.005);

  release();

  // And it is torn down with the view, not left looping behind the editor.
  await expect(page.locator('#state-processing svg[aria-label="bhYnd"]')).toHaveCount(0, { timeout: 10000 });
});
