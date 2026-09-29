import { test, expect } from '@playwright/test';
import { SOUND_IDS, SOUND_CATEGORIES, SOUND_REGISTRY, listSoundsByCategory, listSoundSections } from '../../shared/soundRegistry.js';
import { PACK_SOUNDS, packFileName } from '../../shared/soundPack.js';

// The sound library panel (src/components/SoundLibraryPanel.jsx).
//
// It replaced a popover anchored to the SFX lane's "+". That was fine for
// eleven sounds; at thirty-eight it has to group and scroll, which a popover
// pinned to a button does not. The panel opens on the left — the one side of
// the workspace that was otherwise empty — so it displaces neither the
// preview nor the Video Inspector opposite it.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const PANEL = '#sound-library-panel';

async function openLibrary(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  await page.waitForTimeout(400);
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
}

const soundEvents = (page) => page.evaluate(() => window.__appState.soundEvents || []);

test('every registered sound appears, grouped by category', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await openLibrary(page);

  const panel = page.locator(PANEL);
  // Derived from the registry, not a literal: the panel's contract is "lists
  // every registered sound", so adding one must not fail this test.
  await expect(panel.locator('[data-sound-add]')).toHaveCount(SOUND_IDS.length);

  // ...and every non-empty category is a visible heading, in registry order.
  const expectedGroups = listSoundsByCategory();
  const rendered = await page.evaluate(() =>
    [...document.querySelectorAll('#sound-library-panel [data-sound-group]')].map((el) => el.dataset.soundGroup));
  console.log('groups rendered:', rendered.join(', '), '| sounds:', SOUND_IDS.length);
  expect(rendered).toEqual(expectedGroups.map((g) => g.id));
  // Sanity: the registry really does define categories, so this is testing
  // something rather than an empty list.
  expect(SOUND_CATEGORIES.length).toBeGreaterThan(3);

  // Each group's label is its own heading. Scoped to the group, because at
  // this size a family ("Pop") and a sound ("Pop") can share a name.
  for (const group of expectedGroups) {
    await expect(panel.locator(`[data-sound-group="${group.id}"] > div`).first()).toHaveText(group.label);
  }

  // ...and the groups sit under their sections, pack first, Classic last.
  const sections = await page.evaluate(() =>
    [...document.querySelectorAll('#sound-library-panel [data-sound-section]')].map((el) => el.dataset.soundSection));
  expect(sections).toEqual(listSoundSections().map((s) => s.id));
  expect(sections.at(-1)).toBe('classic');
  expect(errs).toEqual([]);
});

// At ~400 sounds the search is how a sound is found. It matches name, id,
// tags and description — the same fields, so the same answer, as here.
test('search narrows the library to what matches', async ({ page }) => {
  await openLibrary(page);
  const panel = page.locator(PANEL);
  const expected = (q) => SOUND_IDS.filter((id) => {
    const s = SOUND_REGISTRY[id];
    const hay = [s.label, s.id, s.use, ...(s.tags || [])].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  });

  await page.locator('#sound-library-search').fill('underline');
  const shown = await page.evaluate(() => [...document.querySelectorAll('#sound-library-panel [data-sound-add]')].map((b) => b.dataset.soundAdd));
  console.log('"underline" ->', shown.join(', '));
  expect(shown.sort()).toEqual(expected('underline').sort());
  expect(shown).toEqual(expect.arrayContaining(['writing-pencil-underline', 'writing-pen-underline', 'writing-marker-underline']));

  // Two words must both match: "soft pop" finds soft pops, not every pop.
  await page.locator('#sound-library-search').fill('soft pop');
  const soft = await page.evaluate(() => [...document.querySelectorAll('#sound-library-panel [data-sound-add]')].map((b) => b.dataset.soundAdd));
  expect(soft.sort()).toEqual(expected('soft pop').sort());
  expect(soft).toContain('pop-soft');

  // Nothing matching says so rather than showing an empty panel.
  await page.locator('#sound-library-search').fill('zzzz-no-such-sound');
  await expect(panel.locator('[data-sound-add]')).toHaveCount(0);
  await expect(page.locator('#sound-library-empty')).toBeVisible();

  // Clearing it brings the whole library back.
  await page.locator('#sound-library-search').fill('');
  await expect(panel.locator('[data-sound-add]')).toHaveCount(SOUND_IDS.length);
});

// Every pack file must decode in a real browser — the preview path — not just
// exist on disk. Decoded here with the same Web Audio decoder the engine uses.
test('every pack sound decodes in the browser, with audio in it', async ({ page }) => {
  await page.goto(APP_URL);
  const files = PACK_SOUNDS.map((s) => ({ id: s.id, file: packFileName(s.id), duration: s.duration }));
  const results = await page.evaluate(async (list) => {
    const out = [];
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    for (const f of list) {
      try {
        const res = await fetch('/sounds/' + f.file);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
        out.push({ id: f.id, ok: res.ok, duration: buf.duration, expected: f.duration, peak });
      } catch (e) { out.push({ id: f.id, ok: false, error: String(e) }); }
    }
    return out;
  }, files);
  const bad = results.filter((r) => !r.ok || Math.abs(r.duration - r.expected) > 0.002 || r.peak < 0.01);
  console.log(`decoded ${results.length - bad.length}/${results.length} pack sounds`);
  expect(bad).toEqual([]);
});

// The preview button actually PLAYS the pack sound: an init script records
// every buffer the audio engine starts, so this sees the decoded audio reach a
// source node rather than trusting that a click did something.
test('previewing a pack sound plays its buffer', async ({ page }) => {
  await page.addInitScript(() => {
    window.__startedBuffers = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer) window.__startedBuffers.push({ duration: this.buffer.duration, channels: this.buffer.numberOfChannels });
      return start.apply(this, args);
    };
  });
  const warnings = [];
  page.on('console', (m) => { if (m.text().includes('[AudioEngine]')) warnings.push(m.text()); });
  await openLibrary(page);

  for (const id of ['pop-soft', 'writing-pencil-underline', 'transition-cinematic']) {
    const before = await page.evaluate(() => window.__startedBuffers.length);
    await page.locator(`[data-sound-preview="${id}"]`).click();
    await expect.poll(() => page.evaluate(() => window.__startedBuffers.length)).toBeGreaterThan(before);
    const played = await page.evaluate(() => window.__startedBuffers.at(-1));
    const def = PACK_SOUNDS.find((s) => s.id === id);
    console.log(`preview ${id}: played ${played.duration.toFixed(3)}s x${played.channels} (manifest ${def.duration}s x${def.channels})`);
    expect(played.duration).toBeCloseTo(def.duration, 2);
    expect(played.channels).toBe(def.channels);
  }
  expect(warnings).toEqual([]);
  // Auditioning placed nothing.
  expect(await soundEvents(page)).toEqual([]);
});

test('the list scrolls rather than overflowing the panel', async ({ page }) => {
  await openLibrary(page);

  const metrics = await page.evaluate(() => {
    const list = document.getElementById('sound-library-list');
    const panel = document.getElementById('sound-library-panel');
    return {
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      panelBottom: Math.round(panel.getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight
    };
  });
  console.log('list metrics:', JSON.stringify(metrics));

  // With 38 sounds the list is genuinely taller than its box...
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // ...and the panel itself stays within the window rather than running off
  // the bottom, which is the failure mode a non-scrolling list would cause.
  expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);

  // It actually scrolls.
  await page.evaluate(() => { document.getElementById('sound-library-list').scrollTop = 400; });
  await page.waitForTimeout(200);
  const scrolled = await page.evaluate(() => document.getElementById('sound-library-list').scrollTop);
  expect(scrolled).toBeGreaterThan(200);
});

test('picking a pack sound adds it at the playhead', async ({ page }) => {
  await openLibrary(page);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 3; });
  await page.waitForTimeout(300);
  await page.locator('#sound-library-search').fill('glitch transition');
  await page.locator('[data-sound-add="transition-glitch"]').click();
  await page.waitForTimeout(300);
  const events = await soundEvents(page);
  expect(events.map((e) => e.soundId)).toEqual(['transition-glitch']);
  expect(events[0].startTime).toBeCloseTo(3, 1);
  // A pack sound starts at the pack's shared default level.
  expect(events[0].volume).toBeCloseTo(0.7, 5);
});

test('picking a sound adds it at the playhead and closes the panel', async ({ page }) => {
  await openLibrary(page);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 2; });
  await page.waitForTimeout(300);

  await page.locator('[data-sound-add="netflix-intro"]').click();
  await page.waitForTimeout(400);

  const events = await soundEvents(page);
  console.log('after picking:', JSON.stringify(events.map((e) => ({ id: e.soundId, t: +e.startTime.toFixed(2) }))));
  expect(events.length).toBe(1);
  // One of the newly registered sounds, so this also proves the additions are
  // reachable end to end rather than just present in the registry.
  expect(events[0].soundId).toBe('netflix-intro');
  expect(events[0].startTime).toBeCloseTo(2, 1);
  await expect(page.locator(PANEL)).toHaveCount(0);
});

test('auditioning a sound does not add it', async ({ page }) => {
  await openLibrary(page);

  await page.locator('[data-sound-preview="whoosh"]').click();
  await page.waitForTimeout(400);

  // The ▶ is for hearing it before committing — the whole difference between
  // picking a sound and guessing one.
  expect(await soundEvents(page)).toEqual([]);
  await expect(page.locator(PANEL)).toBeVisible();
});

test('Cancel, Escape and an outside press each close it', async ({ page }) => {
  await openLibrary(page);
  await page.locator('#sound-library-cancel').click();
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(await soundEvents(page)).toEqual([]);

  // Escape
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toHaveCount(0);

  // A press anywhere outside it
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
  await page.mouse.click(960, 300);
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect(await soundEvents(page)).toEqual([]);
});

test('the "+" toggles rather than fighting the outside-press close', async ({ page }) => {
  await openLibrary(page);
  // Pressing the opener while open must close it once — not close it via the
  // outside-press handler and immediately reopen it.
  await page.locator('#timeline-add-sfx-btn').click();
  await page.waitForTimeout(300);
  await expect(page.locator(PANEL)).toHaveCount(0);

  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator(PANEL)).toBeVisible();
});
