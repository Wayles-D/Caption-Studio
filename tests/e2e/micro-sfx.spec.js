import { test, expect } from '@playwright/test';
import { selectDirectedMoments } from '../../shared/sfxDirection.js';

// AI-directed micro-SFX — the director (shared/sfxDirection.js) driven through
// the real editor rather than as arithmetic, which backend/test_audio_pipeline
// already covers.
//
// What matters here is that a directed accent is an ORDINARY clip once placed:
// the whole design is that the AI decides "this moment matters" and BHYND
// decides everything else, so every assertion below is really asking whether
// the editor still owns the clip afterwards — replace, volume, move, delete,
// and the same timing in preview and export.
//
// Hits :5173 explicitly rather than the suite baseURL — caption fonts come
// from the BACKEND, whose CORS allowlist covers :5173 only. Requires
// `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const SFX_CLIP = '.timeline-sfx-clip';

/**
 * A transcript with real word timings, plus the analysis the backend would
 * have resolved from it. Written out here rather than mocked at the network
 * layer because applySemanticEvents is the integration point under test — the
 * model call itself is covered by the backend suite.
 */
const WORDS = [
  { word: "Here's", start: 0.40, end: 0.72 }, { word: 'the', start: 0.73, end: 0.84 },
  { word: 'one', start: 0.85, end: 1.10 }, { word: 'thing', start: 1.11, end: 1.44 },
  { word: 'nobody', start: 1.45, end: 1.90 }, { word: 'tells', start: 1.91, end: 2.20 },
  { word: 'you.', start: 2.21, end: 2.50 },
  { word: 'Number', start: 3.10, end: 3.40 }, { word: 'one,', start: 3.41, end: 3.80 },
  { word: 'Number', start: 6.90, end: 7.20 }, { word: 'two,', start: 7.21, end: 7.60 },
  { word: 'I', start: 9.00, end: 9.15 }, { word: 'bought', start: 9.16, end: 9.50 },
  { word: 'a', start: 9.51, end: 9.58 }, { word: 'chair.', start: 9.59, end: 10.00 }
];

/** What the analysis reports: list structure, plus rated expressive moments. */
const ANALYSIS = [
  { type: 'hook', timestamp: 0.40, intensity: 0.93, reason: 'opening_hook', word: "Here's" },
  { type: 'list_start', timestamp: 3.10, word: 'Number' },
  { type: 'list_item', index: 1, timestamp: 3.41, word: 'one,' },
  { type: 'list_item', index: 2, timestamp: 7.21, word: 'two,' },
  // Deliberately weak, and deliberately about a noun with no rhetorical weight
  // — "I bought a chair" is the case the feature must NOT mark.
  { type: 'emphasis', timestamp: 9.59, intensity: 0.22, reason: 'plain_noun' },
  // Strong, but sitting right on top of a list beat.
  { type: 'important_statement', timestamp: 3.60, intensity: 0.88, reason: 'collides_with_list' }
];

async function loadWithAnalysis(page, { sensitivity = 0.5 } = {}) {
  await page.goto(APP_URL);
  await page.getByText('Try Demo Video').click();
  await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('preview-video');
    if (v.duration > 0) return r();
    v.addEventListener('loadedmetadata', r, { once: true });
  }));
  return page.evaluate(({ words, analysis, sensitivity }) => {
    window.__updateState({ words, soundEvents: [], dismissedEventKeys: [], soundEventMapping: {} }, { recordHistory: false });
    window.__audioTimeline.setSfxSensitivity(sensitivity);
    const placed = window.__audioTimeline.applySemanticEvents(analysis);
    return placed.map((e) => ({
      id: e.id, soundId: e.soundId, t: +e.startTime.toFixed(2),
      eventType: e.eventType, volume: e.volume, duration: e.duration, source: e.source
    }));
  }, { words: WORDS, analysis: ANALYSIS, sensitivity });
}

const soundEvents = (page) => page.evaluate(() => window.__appState.soundEvents.map((e) => ({
  id: e.id, soundId: e.soundId, t: +e.startTime.toFixed(2), volume: e.volume,
  duration: e.duration, eventType: e.eventType, source: e.source, userModified: e.userModified
})));

test('list beats still place exactly as before, and accents are added sparingly', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const placed = await loadWithAnalysis(page);
  console.log('placed:', JSON.stringify(placed));

  const byType = placed.map((e) => e.eventType);
  // THE ORIGINAL BEHAVIOUR. Both list items and the list's opening are placed,
  // unconditionally — they are structure, and thinning a list is worse than
  // either extreme.
  expect(byType.filter((t) => t === 'list_item')).toEqual(['list_item', 'list_item']);
  expect(byType).toContain('list_start');
  // ...at the transcript's own word times, not near them.
  const listTimes = placed.filter((e) => e.eventType?.startsWith('list')).map((e) => e.t);
  expect(listTimes).toEqual([3.10, 3.41, 7.21]);

  // THE NEW BEHAVIOUR, and its restraint. The hook is placed; the weak
  // moment about a chair is not.
  expect(byType).toContain('hook');
  expect(byType).not.toContain('emphasis');
  // The strong moment colliding with a list beat is dropped rather than
  // layered — one decision per instant.
  expect(byType).not.toContain('important_statement');

  // Six moments proposed, four placed.
  expect(placed.length).toBe(4);
  expect(errs).toEqual([]);
});

test('an accent is levelled by confidence and capped to a beat; a list beat is not', async ({ page }) => {
  const placed = await loadWithAnalysis(page);
  const hook = placed.find((e) => e.eventType === 'hook');
  const listItem = placed.find((e) => e.eventType === 'list_item');
  console.log('hook:', JSON.stringify(hook), '| list item:', JSON.stringify(listItem));

  // A micro-SFX is capped so a long sting cannot become a scene...
  expect(hook.duration).toBeGreaterThan(0);
  expect(hook.duration).toBeLessThanOrEqual(1.2);
  // ...and its level follows the model's confidence.
  expect(hook.volume).toBeGreaterThan(0);

  // A list beat keeps its natural length and the sound's own default volume —
  // the original behaviour is not re-levelled by a feature it predates.
  expect(listItem.duration).toBe(null);
});

test('sensitivity re-judges the video with no second analysis', async ({ page }) => {
  await loadWithAnalysis(page, { sensitivity: 0.5 });

  const counts = await page.evaluate(() => {
    const out = {};
    for (const s of [0, 1]) {
      window.__updateState({ soundEvents: [], dismissedEventKeys: [] }, { recordHistory: false });
      window.__audioTimeline.setSfxSensitivity(s);
      out[s] = window.__appState.soundEvents.map((e) => e.eventType);
    }
    return out;
  });
  console.log('at sensitivity 0 / 1:', JSON.stringify(counts));

  // The list is structure and is never affected by the knob.
  for (const key of ['0', '1']) {
    expect(counts[key].filter((t) => t === 'list_item').length).toBe(2);
  }
  // More is more, but never everything: the chair is still not marked.
  expect(counts['1'].length).toBeGreaterThanOrEqual(counts['0'].length);
  expect(counts['1']).not.toContain('emphasis');
});

test('a directed accent is an ordinary clip: replace, re-level, move, delete', async ({ page }) => {
  const placed = await loadWithAnalysis(page);
  const hookId = placed.find((e) => e.eventType === 'hook').id;
  const before = (await soundEvents(page)).find((e) => e.id === hookId);

  // REPLACE — the existing per-clip control, not a second workflow for AI
  // clips. It swaps the sound in place: same clip, same id, same time.
  await page.evaluate((id) => window.__audioTimeline.setSoundEventSound(id, 'sad-violin'), hookId);
  const replaced = (await soundEvents(page)).find((e) => e.id === hookId);
  console.log('after replace:', JSON.stringify(replaced));
  expect(replaced.soundId).toBe('sad-violin');
  expect(replaced.t).toBe(before.t);
  expect(replaced.id).toBe(hookId);
  // Editing a suggestion promotes it, so a re-analysis cannot take it back.
  expect(replaced.userModified).toBe(true);

  // VOLUME still works, and overwrites the confidence-derived level.
  await page.evaluate((id) => window.__audioTimeline.updateSoundEvent(id, { volume: 1.4 }), hookId);
  expect((await soundEvents(page)).find((e) => e.id === hookId).volume).toBeCloseTo(1.4, 3);

  // MOVE.
  await page.evaluate((id) => window.__audioTimeline.moveSoundEvent(id, 5.25), hookId);
  expect((await soundEvents(page)).find((e) => e.id === hookId).t).toBe(5.25);

  // A re-analysis leaves the edited clip exactly where the creator put it.
  await page.evaluate((analysis) => window.__audioTimeline.applySemanticEvents(analysis), ANALYSIS);
  const survivor = (await soundEvents(page)).find((e) => e.id === hookId);
  expect(survivor).toBeTruthy();
  expect(survivor.soundId).toBe('sad-violin');
  expect(survivor.t).toBe(5.25);
  expect(survivor.volume).toBeCloseTo(1.4, 3);

  // DELETE, and it is not resurrected.
  await page.evaluate((id) => window.__audioTimeline.removeSoundEvent(id), hookId);
  await page.evaluate((analysis) => window.__audioTimeline.applySemanticEvents(analysis), ANALYSIS);
  expect((await soundEvents(page)).some((e) => e.id === hookId)).toBe(false);
});

test('re-analysis is idempotent — accents do not accumulate', async ({ page }) => {
  await loadWithAnalysis(page);
  const first = await soundEvents(page);

  const after = await page.evaluate((analysis) => {
    window.__audioTimeline.applySemanticEvents(analysis);
    window.__audioTimeline.applySemanticEvents(analysis);
    return window.__appState.soundEvents.length;
  }, ANALYSIS);
  console.log('after three runs:', after, 'clips (first run placed', first.length + ')');
  expect(after).toBe(first.length);

  // And no two clips share an instant.
  const times = (await soundEvents(page)).map((e) => e.t).sort((a, b) => a - b);
  expect(new Set(times).size).toBe(times.length);
});

test('manual effects survive the director untouched', async ({ page }) => {
  await loadWithAnalysis(page);
  const manual = await page.evaluate(() => {
    const e = window.__audioTimeline.addSoundEvent('cash', 9.6);
    window.__audioTimeline.updateSoundEvent(e.id, { volume: 0.8 });
    return e.id;
  });

  await page.evaluate((analysis) => window.__audioTimeline.applySemanticEvents(analysis), ANALYSIS);
  const kept = (await soundEvents(page)).find((e) => e.id === manual);
  console.log('manual clip after re-analysis:', JSON.stringify(kept));
  // Placed by hand at a moment the director rejected, and kept anyway — the
  // budget governs what the AI adds, never what the creator placed.
  expect(kept).toBeTruthy();
  expect(kept.soundId).toBe('cash');
  expect(kept.t).toBe(9.6);
  expect(kept.volume).toBeCloseTo(0.8, 3);
  expect(kept.source).toBe('manual');
});

test('every placed accent lands on a real transcript word, and reaches the timeline', async ({ page }) => {
  const placed = await loadWithAnalysis(page);

  // No invented timings: the director only ever reorders and drops, so every
  // surviving timestamp is still a word's own start.
  const wordStarts = WORDS.map((w) => +w.start.toFixed(2));
  for (const clip of placed) expect(wordStarts).toContain(clip.t);

  // And they are on the timeline as real, selectable clips.
  await expect(page.locator(`${SFX_CLIP}.auto`)).toHaveCount(placed.length);
  const firstId = placed[0].id;
  await page.evaluate((id) => window.__audioTimeline.selectClip(id), firstId);
  expect(await page.evaluate(() => window.__appState.selectedAudioClipId)).toBe(firstId);
});

test('the editor and the exporter are handed the same clips', async ({ page }) => {
  await loadWithAnalysis(page);

  // getStyleParams() is the snapshot the export request is built from, so
  // comparing it against live state is the real preview/export parity check —
  // a placement that existed only in the preview would differ here.
  const { live, exported } = await page.evaluate(() => {
    const shape = (e) => ({
      s: e.soundId, t: +e.startTime.toFixed(3), v: +e.volume.toFixed(4),
      d: e.duration, f: e.fadeOut, on: e.enabled
    });
    return {
      live: window.__appState.soundEvents.map(shape),
      // The exact payload POSTed to /api/upload/regenerate — audio.soundEvents
      // is what backend/utils/audioMixFilter.js builds the mix graph from.
      exported: window.__getStyleParams().audio.soundEvents.map(shape)
    };
  });
  console.log('export payload:', JSON.stringify(exported));
  expect(exported).toEqual(live);
  expect(exported.length).toBeGreaterThan(0);
});

test('the director agrees with the shared policy module', async ({ page }) => {
  // The editor must not have its own idea of what is sparse. Same inputs
  // through the shared module in Node and through applySemanticEvents in the
  // browser should name the same moments.
  const placed = await loadWithAnalysis(page);
  const duration = await page.evaluate(() => document.getElementById('preview-video').duration);

  const expected = selectDirectedMoments(ANALYSIS, { duration, sensitivity: 0.5 });
  const expectedTypes = [...expected.structural, ...expected.directed]
    .sort((a, b) => a.timestamp - b.timestamp).map((e) => e.type);
  console.log('node says:', expectedTypes.join(', '));
  expect(placed.map((e) => e.eventType)).toEqual(expectedTypes);
});

test('Replace on the capsule swaps the sound in place, keeping everything else', async ({ page }) => {
  const placed = await loadWithAnalysis(page);
  const hook = placed.find((e) => e.eventType === 'hook');

  // The capsule's own Replace button — the point being that this is where you
  // are looking when you hear the wrong sound, not the inspector list.
  const capsule = page.locator(`.timeline-sfx-clip[data-clip-id="${hook.id}"]`);
  await capsule.hover();
  await capsule.locator('.timeline-sfx-clip-replace').click();

  // It opens the SAME library panel, in replace mode — one picker, not two.
  await expect(page.locator('#sound-library-panel')).toBeVisible();
  await expect(page.locator('#sound-library-panel')).toContainText('Replace Sound');
  // Selecting the clip is part of the gesture, so the inspector follows.
  expect(await page.evaluate(() => window.__appState.selectedAudioClipId)).toBe(hook.id);

  await page.locator('[data-sound-add="cash"]').click();
  await page.waitForTimeout(300);

  const after = (await soundEvents(page)).find((e) => e.id === hook.id);
  console.log('replaced in place:', JSON.stringify(after));
  // Swapped, not deleted and re-added: same clip, same instant, same level,
  // same capped length, and no second clip left behind.
  expect(after.soundId).toBe('cash');
  expect(after.t).toBe(hook.t);
  expect(after.volume).toBeCloseTo(hook.volume, 4);
  expect(after.duration).toBe(hook.duration);
  expect((await soundEvents(page)).length).toBe(placed.length);
  await expect(page.locator('#sound-library-panel')).toHaveCount(0);
});

test('the "+" still adds rather than replacing, after a replace has been used', async ({ page }) => {
  const placed = await loadWithAnalysis(page);
  const hook = placed.find((e) => e.eventType === 'hook');

  await page.locator(`.timeline-sfx-clip[data-clip-id="${hook.id}"]`).hover();
  await page.locator(`.timeline-sfx-clip[data-clip-id="${hook.id}"] .timeline-sfx-clip-replace`).click();
  await expect(page.locator('#sound-library-panel')).toContainText('Replace Sound');

  // Pressing the lane's "+" while a replace is pending must mean ADD. The
  // target is dropped rather than left armed, or the next pick would silently
  // overwrite a clip the user is no longer thinking about.
  await page.locator('#timeline-add-sfx-btn').click();
  await page.locator('#timeline-add-sfx-btn').click();
  await expect(page.locator('#sound-library-panel')).toContainText('Sound Effects');
  await page.locator('[data-sound-add="ding"]').click();
  await page.waitForTimeout(300);

  const events = await soundEvents(page);
  console.log('after add:', events.length, 'clips; hook still', events.find((e) => e.id === hook.id)?.soundId);
  expect(events.length).toBe(placed.length + 1);
  expect(events.find((e) => e.id === hook.id).soundId).toBe(hook.soundId);
});

test('a volume change applies to the ticked effects, or to all when none are ticked', async ({ page }) => {
  await loadWithAnalysis(page);
  await page.getByRole('button', { name: 'Audio', exact: true }).click();

  const ids = (await soundEvents(page)).map((e) => e.id);
  expect(ids.length).toBeGreaterThanOrEqual(4);
  const [source, picked, unpicked] = ids;

  // Give the source a distinctive level, then copy it to ONE chosen effect.
  await page.evaluate((id) => window.__audioTimeline.updateSoundEvent(id, { volume: 1.55 }), source);
  await page.locator(`[data-sfx-pick="${picked}"]`).check();
  await page.locator(`[data-sfx-apply="${source}"]`).click();
  await page.waitForTimeout(300);

  let after = await soundEvents(page);
  const vol = (id) => after.find((e) => e.id === id).volume;
  console.log('scoped apply:', ids.map((id) => vol(id).toFixed(2)).join(', '));
  expect(vol(picked)).toBeCloseTo(1.55, 3);
  // The whole point of scoping: an effect nobody ticked is untouched.
  expect(vol(unpicked)).not.toBeCloseTo(1.55, 3);

  // With nothing ticked the same button means what it always did.
  await page.locator('#sfx-pick-clear').click();
  await page.locator(`[data-sfx-apply="${source}"]`).click();
  await page.waitForTimeout(300);

  after = await soundEvents(page);
  console.log('apply to all:', ids.map((id) => vol(id).toFixed(2)).join(', '));
  for (const id of ids) expect(vol(id)).toBeCloseTo(1.55, 3);
});
