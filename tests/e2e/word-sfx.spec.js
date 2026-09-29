import { test, expect } from '@playwright/test';
import { resolveCategorySound } from '../../shared/soundProfiles.js';

// What the model's "ui" category means for a RUN of words today — derived, so
// repointing a category at a different sound does not break the behaviour
// being tested here (the category, not the profile, drives the intro).
const UI_RUN_SOUND = resolveCategorySound('ui', { run: true });

// WORD-LEVEL SFX. A sound lands on a word, not a sentence: "5 home office
// hacks" is one idea and FOUR sounds, each on its own word's timestamp, all
// sharing one sound so they read as a rhythm.
//
// The timings below are real — Whisper's output for the opening of the home-
// office test video — and the moments are the shape the analysis returns
// after keywordAnalysisService.js has resolved each word to its own start.
// They are fed straight to applySemanticEvents because that is the
// integration point under test; the model call and its parsing are covered by
// backend/test_audio_pipeline.js.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';

const WORDS = [
  ['Here', 0.00], ['are', 0.24], ['5', 0.38], ['home', 0.62], ['office', 0.76], ['hacks', 1.06],
  ['to', 1.32], ['create', 1.46], ['a', 1.68], ['productive', 1.80], ['space', 2.12],
  ['First,', 3.64], ['we', 3.90], ['have', 4.00], ['this', 4.14], ['monitor', 4.34], ['light', 4.64], ['bar.', 4.92],
  ['Next,', 11.68], ['we', 11.94], ['have', 12.04], ['this', 12.14], ['headphone', 12.24], ['hook', 12.58]
].map(([word, start]) => ({ word, start, end: start + 0.2 }));

const at = (i) => ({ wordIndex: i, word: WORDS[i].word, timestamp: WORDS[i].start });

/** The analysis as the backend hands it over: runs of words, each with its own time. */
const ANALYSIS = [
  { type: 'topic', timestamp: 0.38, intensity: 0.9, soundCategory: 'ui', reason: 'topic_intro', words: [at(2), at(3), at(4), at(5)] },
  { type: 'list_item', index: 1, timestamp: 3.64, intensity: 0.7, soundCategory: 'ui', words: [at(11), at(15), at(16), at(17)] },
  { type: 'list_item', index: 2, timestamp: 11.68, intensity: 0.7, soundCategory: 'ui', words: [at(18), at(22), at(23)] },
  // The same product reported a second time as an entity — "genuinely
  // duplicate AI output for the same editorial event". It must not add a
  // second sound on any word the list item already sounded.
  { type: 'entity', timestamp: 4.34, intensity: 0.8, soundCategory: 'impact', words: [at(15), at(16), at(17)] }
];

async function load(page) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  return page.evaluate(({ words, analysis }) => {
    window.__updateState({
      words, soundEvents: [], dismissedEventKeys: [], soundEventMapping: {}, soundProfileId: 'default', videoDuration: 39.28
    }, { recordHistory: false });
    window.__audioTimeline.setSfxSensitivity(0.5);
    return window.__audioTimeline.applySemanticEvents(analysis)
      .map((e) => ({ id: e.id, t: e.startTime, s: e.soundId, type: e.eventType, d: e.duration, key: e.eventKey }));
  }, { words: WORDS, analysis: ANALYSIS });
}

const clips = (page) => page.evaluate(() => window.__appState.soundEvents
  .map((e) => ({ id: e.id, t: e.startTime, s: e.soundId, type: e.eventType, v: e.volume, d: e.duration, source: e.source }))
  .sort((a, b) => a.t - b.t));

const wordAt = (t) => WORDS.find((w) => Math.abs(w.start - t) < 1e-6)?.word;

test('"5 home office hacks" becomes four separate clips, one per word, same sound', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const placed = await load(page);
  const intro = placed.filter((c) => c.type === 'topic');
  console.log('intro:', intro.map((c) => `${wordAt(c.t)}@${c.t}:${c.s}`).join('  '));

  // FOUR events, not one.
  expect(intro.map((c) => wordAt(c.t))).toEqual(['5', 'home', 'office', 'hacks']);
  expect(new Set(intro.map((c) => c.id)).size).toBe(4);
  // Each on ITS OWN word's transcript time — the AI named the words, BHYND
  // supplied the timing.
  expect(intro.map((c) => c.t)).toEqual([0.38, 0.62, 0.76, 1.06]);
  // One sound for the run: that is the rhythm.
  expect(new Set(intro.map((c) => c.s)).size).toBe(1);

  // They are real, separate clips on the timeline.
  await expect(page.locator('.timeline-sfx-clip.auto')).toHaveCount(placed.length);
  expect(errs).toEqual([]);
});

test('identical adjacent sounds are never merged; the same word twice is one sound', async ({ page }) => {
  const placed = await load(page);

  // Every placed clip is on a distinct word. The entity re-reported "monitor
  // light bar", which the list item had already sounded, so it adds nothing:
  // de-duplication is by WORD, never by sound id.
  const times = placed.map((c) => c.t);
  expect(new Set(times).size).toBe(times.length);
  expect(placed.filter((c) => c.type === 'entity')).toEqual([]);

  // ...while four adjacent words sharing `click` stay four clips.
  const clickRun = placed.filter((c) => c.type === 'topic');
  expect(clickRun.length).toBe(4);
  console.log('placed per type:', JSON.stringify(placed.reduce((m, c) => ({ ...m, [c.type]: (m[c.type] || 0) + 1 }), {})));
});

test('list beats keep their profile sound; the intro uses its category — different sounds in one video', async ({ page }) => {
  const placed = await load(page);
  const list = placed.filter((c) => c.type === 'list_item');
  const intro = placed.filter((c) => c.type === 'topic');
  console.log('intro sound:', intro[0].s, '| list sound:', [...new Set(list.map((c) => c.s))].join(','));

  // List beats are structure: the profile decides them, exactly as it did
  // before runs existed — the Default profile's list_item is `tick`.
  expect(new Set(list.map((c) => c.s))).toEqual(new Set(['tick']));
  // The intro is expressive: the model's "ui" category decides it.
  expect(intro[0].s).toBe(UI_RUN_SOUND);
  expect(UI_RUN_SOUND).not.toBe('tick');

  // And the profile switcher still changes the list — it did not survive the
  // first version of this change.
  const punchy = await page.evaluate(() => {
    window.__updateState({ soundEvents: [], dismissedEventKeys: [] }, { recordHistory: false });
    window.__audioTimeline.setSoundProfile('punchy');
    return window.__appState.soundEvents.filter((e) => e.eventType === 'list_item').map((e) => e.soundId);
  });
  expect(new Set(punchy)).toEqual(new Set(['pop']));
});

test('sounds in a run follow each other rather than piling up', async ({ page }) => {
  const placed = await load(page);
  const intro = placed.filter((c) => c.type === 'topic');
  for (let i = 0; i < intro.length - 1; i++) {
    // Each sound ends before the next word's begins.
    expect(intro[i].t + intro[i].d).toBeLessThanOrEqual(intro[i + 1].t + 1e-6);
  }
});

test('replacing one word of a run changes only that clip', async ({ page }) => {
  await load(page);
  const before = await clips(page);
  const home = before.find((c) => wordAt(c.t) === 'home');

  // The capsule's own Replace — the same library panel, not a second flow.
  const capsule = page.locator(`.timeline-sfx-clip[data-clip-id="${home.id}"]`);
  await capsule.hover();
  await capsule.locator('.timeline-sfx-clip-replace').click();
  await expect(page.locator('#sound-library-panel')).toContainText('Replace Sound');
  await page.locator('[data-sound-add="ding"]').click();
  await page.waitForTimeout(300);

  const after = await clips(page);
  const changed = after.filter((c) => {
    const was = before.find((b) => b.id === c.id);
    return was && was.s !== c.s;
  });
  console.log('changed:', changed.map((c) => `${wordAt(c.t)}->${c.s}`).join(', '));
  // Exactly the one word, still at its own time, and nothing added or lost.
  expect(changed.map((c) => wordAt(c.t))).toEqual(['home']);
  expect(changed[0].s).toBe('ding');
  expect(changed[0].t).toBe(home.t);
  expect(after.length).toBe(before.length);
  // Its neighbours in the run keep their sound.
  for (const w of ['5', 'office', 'hacks']) expect(after.find((c) => wordAt(c.t) === w).s).toBe(UI_RUN_SOUND);
});

test('deleting one word of a run sticks through re-analysis; the rest of the run stays', async ({ page }) => {
  await load(page);
  const office = (await clips(page)).find((c) => wordAt(c.t) === 'office');
  await page.evaluate((id) => window.__audioTimeline.removeSoundEvent(id), office.id);

  // Re-running the SAME analysis — and a regrouped one, because the model is
  // not perfectly repeatable and may report the phrase differently next time.
  const regrouped = ANALYSIS.map((m) => (m.type === 'topic' ? { ...m, type: 'list_start', words: m.words.slice(1) } : m));
  await page.evaluate((a) => window.__audioTimeline.applySemanticEvents(a), ANALYSIS);
  await page.evaluate((a) => window.__audioTimeline.applySemanticEvents(a), regrouped);

  const after = await clips(page);
  console.log('intro after delete + two re-runs:', after.filter((c) => c.t < 2).map((c) => wordAt(c.t)).join(' '));
  // "office" stays gone: a deletion means "no sound on this word", keyed on
  // the word, so a re-grouped re-run cannot bring it back.
  expect(after.some((c) => wordAt(c.t) === 'office')).toBe(false);
  expect(after.some((c) => wordAt(c.t) === 'home')).toBe(true);
  expect(after.some((c) => wordAt(c.t) === 'hacks')).toBe(true);
});

test('re-analysis never duplicates a run', async ({ page }) => {
  const first = await load(page);
  const counts = await page.evaluate((a) => {
    const out = [];
    for (let i = 0; i < 3; i++) {
      window.__audioTimeline.applySemanticEvents(a);
      out.push(window.__appState.soundEvents.length);
    }
    return out;
  }, ANALYSIS);
  console.log('clip count after each re-run:', counts.join(', '), `(first run: ${first.length})`);
  expect(counts).toEqual([first.length, first.length, first.length]);
});

test('manual sounds survive; volume edits stick', async ({ page }) => {
  await load(page);
  const manual = await page.evaluate(() => window.__audioTimeline.addSoundEvent('cash', 8.0).id);
  const hacks = (await clips(page)).find((c) => wordAt(c.t) === 'hacks');
  await page.evaluate((id) => window.__audioTimeline.updateSoundEvent(id, { volume: 1.3 }), hacks.id);
  await page.evaluate((a) => window.__audioTimeline.applySemanticEvents(a), ANALYSIS);

  const after = await clips(page);
  expect(after.find((c) => c.id === manual)).toMatchObject({ s: 'cash', t: 8, source: 'manual' });
  expect(after.find((c) => c.id === hacks.id).v).toBeCloseTo(1.3, 4);
});

test('the export payload carries every per-word clip, exactly as the timeline holds them', async ({ page }) => {
  await load(page);
  const { live, exported } = await page.evaluate(() => {
    const shape = (e) => ({ s: e.soundId, t: +e.startTime.toFixed(3), v: +e.volume.toFixed(4), d: e.duration, on: e.enabled });
    return {
      live: window.__appState.soundEvents.map(shape).sort((a, b) => a.t - b.t),
      exported: window.__getStyleParams().audio.soundEvents.map(shape).sort((a, b) => a.t - b.t)
    };
  });
  expect(exported.length).toBeGreaterThan(8);
  expect(exported).toEqual(live);
});
