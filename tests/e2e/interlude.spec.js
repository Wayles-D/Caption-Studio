import { test, expect } from '@playwright/test';

// CINEMATIC TEXT INTERLUDES (shared/textElement.js, kind 'interlude'),
// driven through the real UI and verified on the preview's own pixels.
//
// Hits :5173 explicitly — caption fonts come from the BACKEND, whose CORS
// allowlist covers :5173 only (a blocked webfont renders as a silent
// fallback). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

async function setup(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  // A transcript caption across the whole clip, so "the interlude covers the
  // captions" is something that can actually fail.
  await page.evaluate(() => {
    const words = [{ word: 'CAPTION', start: 0, end: 12, wordIndex: 0 }];
    window.__updateState({ words, phrases: [{ start: 0, end: 12, words, breakAfterIndices: [] }] }, { recordHistory: false });
  });
  await page.waitForTimeout(400);
}

/** Seeks and waits for the seek to land AND the preview to redraw. */
async function seek(page, t) {
  await page.evaluate((time) => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    v.pause();
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    if (Math.abs(v.currentTime - time) < 1e-9) return done();
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = time;
  }), t);
}

/**
 * What the text layer shows right now: whether it is on, its four corner
 * pixels (a full-frame background reaches them; text never does), and how
 * much dark "ink" is in its middle band.
 */
function sample(page) {
  return page.evaluate(() => {
    const c = document.getElementById('text-elements-canvas');
    const active = c.classList.contains('active');
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const corners = [px(2, 2), px(w - 3, 2), px(2, h - 3), px(w - 3, h - 3)];
    const band = ctx.getImageData(0, Math.floor(h * 0.3), w, Math.floor(h * 0.4)).data;
    let dark = 0, light = 0, minX = w, maxX = 0;
    for (let i = 0; i < band.length; i += 4) {
      if (band[i + 3] > 200 && band[i] < 90 && band[i + 1] < 90 && band[i + 2] < 90) {
        dark++;
        const x = (i / 4) % w;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      if (band[i + 3] > 200 && band[i] > 200 && band[i + 1] > 200 && band[i + 2] > 200) light++;
    }
    return { active, corners, dark, light, inkLeft: minX / w, inkRight: maxX / w };
  });
}
const cornersAre = (s, [r, g, b]) => s.active && s.corners.every((p) => Math.abs(p[0] - r) < 4 && Math.abs(p[1] - g) < 4 && Math.abs(p[2] - b) < 4 && p[3] === 255);
const interludes = (page) => page.evaluate(() => window.__appState.textElements.filter((e) => e.kind === 'interlude'));

/** The Text panel, opened the way a user opens it: the toolbar's Overlay tool. */
async function openPanel(page) {
  if (await page.locator('#textel-content').count()) return;
  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await expect(page.locator('#textel-content')).toBeVisible();
}

test('+ Cinematic creates an interlude EXACTLY at the playhead, on its own lane, with its settings in the panel', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await setup(page);

  await seek(page, 4.37);
  const playhead = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  await page.locator('#timeline-add-interlude-btn').click();
  await page.waitForTimeout(300);

  const [el] = await interludes(page);
  console.log('created:', JSON.stringify({ start: el.start, end: el.end, playhead, bg: el.background }));
  expect(el.start).toBe(playhead); // exact — not rounded, not snapped
  expect(el.end - el.start).toBeCloseTo(2, 9);
  expect(el.kind).toBe('interlude');

  const clip = page.locator('#timeline-interlude-track .timeline-text-clip.is-interlude');
  await expect(clip).toHaveCount(1);
  await expect(clip).toHaveClass(/selected/);
  // It is NOT on the overlay lane.
  await expect(page.locator('#timeline-text-track .timeline-text-clip')).toHaveCount(0);

  // Its settings are what the panel shows for it.
  await openPanel(page);
  await expect(page.getByText('Cinematic text', { exact: true })).toBeVisible();
  await expect(page.locator('#interlude-bg-white')).toBeVisible();
  await expect(page.locator('#textel-duration')).toHaveValue('2.00');
  expect(errs).toEqual([]);
});

test('the picture is replaced for exactly [start, end), captions covered, video back afterwards', async ({ page }) => {
  await setup(page);
  await seek(page, 5);
  await page.locator('#timeline-add-interlude-btn').click();
  const [el] = await interludes(page);
  expect(el.start).toBe(5);

  // Boundaries: just before, exactly at, middle, just before end, exactly at end, just after.
  const probe = [[4.99, false], [5.0, true], [6.0, true], [6.99, true], [7.0, false], [7.01, false]];
  for (const [t, inside] of probe) {
    await seek(page, t);
    const s = await sample(page);
    console.log(`t=${t}: text layer ${s.active ? 'on' : 'off'}, corner ${JSON.stringify(s.corners[0])}`);
    expect(cornersAre(s, [255, 255, 255])).toBe(inside);
  }

  // Mid-interlude, after the fade has finished: opaque white frame, dark text on it.
  await seek(page, 6.2);
  const mid = await sample(page);
  expect(mid.dark).toBeGreaterThan(500);
  // The caption layer underneath still draws (it is covered, not removed) —
  // the interlude hides it by being opaque and above it.
  const captionsOn = await page.evaluate(() => document.getElementById('captions-canvas').classList.contains('active'));
  expect(captionsOn).toBe(true);
  const zText = await page.evaluate(() => getComputedStyle(document.getElementById('text-elements-canvas')).zIndex);
  const zCap = await page.evaluate(() => getComputedStyle(document.getElementById('captions-canvas')).zIndex);
  expect(Number(zText)).toBeGreaterThan(Number(zCap));
});

test('audio continues: the video keeps playing, unmuted, straight through the interlude', async ({ page }) => {
  await setup(page);
  await seek(page, 5);
  await page.locator('#timeline-add-interlude-btn').click();
  await seek(page, 4.6);

  const trace = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    const samples = [];
    const volumeBefore = v.volume;
    v.play();
    const t0 = performance.now();
    const tick = () => {
      samples.push({ t: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume, layer: document.getElementById('text-elements-canvas').classList.contains('active') });
      if (performance.now() - t0 < 3200) requestAnimationFrame(tick);
      else { v.pause(); resolve({ samples, volumeBefore }); }
    };
    requestAnimationFrame(tick);
  }));
  const inside = trace.samples.filter((s) => s.t >= 5.1 && s.t < 6.9);
  console.log(`samples ${trace.samples.length}, inside interlude ${inside.length}, time ${trace.samples[0].t.toFixed(2)} -> ${trace.samples.at(-1).t.toFixed(2)}`);
  expect(inside.length).toBeGreaterThan(20);
  // The layer is on for the interlude and the video is still PLAYING under it.
  expect(inside.every((s) => s.layer && !s.paused && !s.muted && s.volume === trace.volumeBefore)).toBe(true);
  // Time advanced continuously through it: no stall, no jump.
  for (let i = 1; i < trace.samples.length; i++) {
    const dt = trace.samples[i].t - trace.samples[i - 1].t;
    expect(dt).toBeGreaterThanOrEqual(0);
    expect(dt).toBeLessThan(0.25);
  }
  expect(trace.samples.at(-1).t).toBeGreaterThan(7.2); // played out the other side
  const after = trace.samples.filter((s) => s.t > 7.1);
  expect(after.every((s) => !s.layer)).toBe(true);
});

test('text, background, layout and duration edits all reach the pixels', async ({ page }) => {
  await setup(page);
  await seek(page, 3);
  await page.locator('#timeline-add-interlude-btn').click();
  await openPanel(page);
  await seek(page, 3.8);
  const initial = await sample(page);

  // Text
  await page.locator('#textel-content').fill('ONE\nTWO\nTHREE\nFOUR');
  await page.locator('#textel-content').blur();
  await seek(page, 3.81);
  const edited = await sample(page);
  console.log(`dark ink: default text ${initial.dark} -> four lines ${edited.dark}`);
  expect(edited.dark).not.toBe(initial.dark);
  expect((await interludes(page))[0].text).toBe('ONE\nTWO\nTHREE\nFOUR');

  // Background: black, then a custom colour through the same API the picker uses.
  await page.locator('#interlude-bg-black').click();
  await seek(page, 3.82);
  expect(cornersAre(await sample(page), [0, 0, 0])).toBe(true);
  await page.evaluate((id) => window.__textElements.updateInterludeBackground(id, { color: '#1E40AF' }), (await interludes(page))[0].id);
  await seek(page, 3.83);
  expect(cornersAre(await sample(page), [0x1e, 0x40, 0xaf])).toBe(true);
  await page.locator('#interlude-bg-white').click();

  // Alignment: left-aligned lines start further left than centred ones.
  await page.locator('#textel-content').fill('A\nLONGER LINE');
  await page.locator('#textel-content').blur();
  await seek(page, 3.84);
  const centred = await sample(page);
  await page.locator('#interlude-align-left').click();
  await seek(page, 3.85);
  const left = await sample(page);
  console.log(`ink span centred ${centred.inkLeft.toFixed(3)}-${centred.inkRight.toFixed(3)}, left ${left.inkLeft.toFixed(3)}-${left.inkRight.toFixed(3)}`);
  expect(left.dark).toBeGreaterThan(0);
  // The long line pins both; the short line "A" moves to the left edge, so
  // the ink's overall extent stays, but its distribution changes.
  expect(left.dark).toBeCloseTo(centred.dark, -2);
  const style = (await interludes(page))[0].style;
  expect(style.textAlign).toBe('left');

  // Duration: the field is a trim of the end.
  await page.locator('#textel-duration').fill('3.5');
  const [el] = await interludes(page);
  expect(el.end - el.start).toBeCloseTo(3.5, 6);
  await seek(page, el.start + 3.2);
  expect(cornersAre(await sample(page), [255, 255, 255])).toBe(true);
  await seek(page, el.start + 3.51);
  expect((await sample(page)).active).toBe(false);
});

test('dragging the clip edge resizes it, and the preview follows', async ({ page }) => {
  await setup(page);
  await seek(page, 2);
  await page.locator('#timeline-add-interlude-btn').click();
  const before = (await interludes(page))[0];

  const clip = page.locator('#timeline-interlude-track .timeline-text-clip').first();
  const box = await clip.boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = (await interludes(page))[0];
  console.log(`end ${before.end.toFixed(2)} -> ${after.end.toFixed(2)} (start ${after.start})`);
  expect(after.start).toBe(before.start);
  expect(after.end).toBeGreaterThan(before.end + 0.3);
  await seek(page, (before.end + after.end) / 2);
  expect(cornersAre(await sample(page), [255, 255, 255])).toBe(true);

  // Undo takes the resize back in one step.
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)' }).click();
  await page.waitForTimeout(300);
  expect((await interludes(page))[0].end).toBeCloseTo(before.end, 6);
});

test('animation: the default fade runs from the interlude\'s own start, and a preset change applies', async ({ page }) => {
  await setup(page);
  await seek(page, 3);
  await page.locator('#timeline-add-interlude-btn').click();

  await openPanel(page);
  const inkAt = async (t) => { await seek(page, t); return (await sample(page)).dark; };
  const early = await inkAt(3.02);
  const settled = await inkAt(3.8);
  console.log(`fade: ink at +0.02s ${early}, at +0.8s ${settled}`);
  expect(settled).toBeGreaterThan(early * 2);
  // The BACKGROUND is not faded — it is a hard cut from the video, frame 1.
  await seek(page, 3.0);
  expect(cornersAre(await sample(page), [255, 255, 255])).toBe(true);

  await page.locator('#textel-anim-type').selectOption('none');
  const noAnim = await inkAt(3.02);
  console.log(`no animation: ink at +0.02s ${noAnim}`);
  expect(noAnim).toBeGreaterThan(settled * 0.8);
});

test('several interludes are independent, and overlapping ones resolve to the latest', async ({ page }) => {
  await setup(page);
  await seek(page, 1);
  await page.locator('#timeline-add-interlude-btn').click();
  await seek(page, 6);
  await page.locator('#timeline-add-interlude-btn').click();
  await openPanel(page);
  await page.locator('#interlude-bg-black').click();
  const list = await interludes(page);
  expect(list.length).toBe(2);
  expect(new Set(list.map((e) => e.id)).size).toBe(2);
  expect(list.map((e) => e.background.color)).toEqual(['#FFFFFF', '#000000']);
  await expect(page.locator('#timeline-interlude-track .timeline-text-clip', { includeHidden: true })).toHaveCount(2);

  await seek(page, 1.5);
  expect(cornersAre(await sample(page), [255, 255, 255])).toBe(true);
  await seek(page, 6.5);
  expect(cornersAre(await sample(page), [0, 0, 0])).toBe(true);
  await seek(page, 4);
  expect((await sample(page)).active).toBe(false);

  // Overlap: a third, starting inside the first — the later start wins while both run.
  await seek(page, 2.2);
  await page.locator('#timeline-add-interlude-btn').click();
  await page.evaluate((id) => window.__textElements.updateInterludeBackground(id, { color: '#FF0000' }), (await interludes(page)).find((e) => e.start === 2.2).id);
  await seek(page, 2.5);
  expect(cornersAre(await sample(page), [255, 0, 0])).toBe(true);
  await seek(page, 1.5);
  expect(cornersAre(await sample(page), [255, 255, 255])).toBe(true);
});

test('rapid seeking across interludes never leaves a stale frame', async ({ page }) => {
  await setup(page);
  await seek(page, 3);
  await page.locator('#timeline-add-interlude-btn').click();
  await seek(page, 8);
  await page.locator('#timeline-add-interlude-btn').click();
  await openPanel(page);
  await page.locator('#interlude-bg-black').click();

  // Thirty seeks fired back-to-back without waiting, the way a scrub does.
  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    for (let i = 0; i < 30; i++) v.currentTime = (i * 0.37) % 11;
  });
  for (const [t, expected] of [[3.5, 'white'], [5.5, 'none'], [8.5, 'black'], [2.99, 'none'], [9.99, 'black'], [10.01, 'none'], [3.0, 'white']]) {
    await seek(page, t);
    const s = await sample(page);
    const got = cornersAre(s, [255, 255, 255]) ? 'white' : cornersAre(s, [0, 0, 0]) ? 'black' : (s.active ? 'other' : 'none');
    expect(`${t}:${got}`).toBe(`${t}:${expected}`);
  }
  // State untouched by all of that.
  const list = await interludes(page);
  expect(list.map((e) => [e.start, e.background.color])).toEqual([[3, '#FFFFFF'], [8, '#000000']]);
});

test('+ Sound at start places an ordinary SFX clip on the interlude\'s first frame', async ({ page }) => {
  await setup(page);
  await seek(page, 6.25);
  await page.locator('#timeline-add-interlude-btn').click();
  await openPanel(page);
  await seek(page, 1);

  await page.locator('#interlude-add-sound').click();
  await expect(page.locator('#sound-library-panel')).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('preview-video').currentTime)).toBe(6.25);
  await page.locator('#sound-library-search').fill('soft impact');
  await page.locator('[data-sound-add="impact-soft"]').click();
  await page.waitForTimeout(300);

  const sfx = await page.evaluate(() => window.__appState.soundEvents.map((e) => ({ s: e.soundId, t: e.startTime, v: e.volume })));
  console.log('sound events:', JSON.stringify(sfx));
  expect(sfx).toEqual([{ s: 'impact-soft', t: 6.25, v: 0.7 }]);
  // An ordinary clip on the SFX lane — the existing controls apply to it.
  await expect(page.locator('#timeline-sfx-track .timeline-sfx-clip')).toHaveCount(1);
  // ...and the interlude's panel lists it.
  await openPanel(page);
  await expect(page.locator('[data-interlude-sound]')).toHaveCount(1);
});

test('an overlay is untouched by all of this', async ({ page }) => {
  await setup(page);
  await seek(page, 2);
  await page.locator('#timeline-add-text-btn').click();
  const [overlay] = await page.evaluate(() => window.__appState.textElements);
  expect(overlay.kind).toBe('overlay');
  expect('background' in overlay).toBe(false);
  expect(overlay.end - overlay.start).toBeCloseTo(3, 9);
  // No cinematic controls on an overlay.
  await openPanel(page);
  await expect(page.getByText('Text overlay', { exact: true })).toBeVisible();
  await expect(page.locator('#interlude-bg-white')).toHaveCount(0);
  await seek(page, 3);
  const s = await sample(page);
  expect(s.active).toBe(true);
  expect(cornersAre(s, [255, 255, 255])).toBe(false);
});

test('clicking an interlude on the timeline shows its text, not just its background', async ({ page }) => {
  await setup(page);
  const el = await page.evaluate(() => window.__textElements.addInterlude({ start: 2 }));
  await seek(page, 6);
  await page.locator(`[data-clip-id="${el.id}"]`).click();
  await page.waitForFunction(() => !document.getElementById('preview-video').seeking);
  await seek(page, await page.evaluate(() => document.getElementById('preview-video').currentTime));
  const t = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  // On the interlude, past its entrance — its first frame is fully transparent text.
  expect(t).toBeGreaterThan(el.start);
  expect(t).toBeLessThan(el.end);
  const shown = await sample(page);
  await seek(page, 3);
  const settled = await sample(page);
  expect(settled.dark).toBeGreaterThan(500);
  expect(shown.dark).toBeGreaterThan(settled.dark * 0.95);
  // The playhead already on the visible interlude: a click leaves it there.
  await page.locator(`[data-clip-id="${el.id}"]`).click();
  expect(await page.evaluate(() => document.getElementById('preview-video').currentTime)).toBeCloseTo(3, 6);
});
