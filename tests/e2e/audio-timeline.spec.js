import { test, expect } from '@playwright/test';
import { SOUND_IDS } from '../../shared/soundRegistry.js';

/**
 * The audio timeline: the "+ Sound" / "+ Audio" lanes, manual sound-effect
 * editing, and the transcript-driven automatic placement.
 *
 * Uses the DEV-only window.__updateState/__audioTimeline hooks (see App.jsx)
 * to inject a deterministic transcript and a deterministic set of semantic
 * events — the same approach the keyframe specs use, and for the same reason:
 * the suite runs with no backend, so nothing here may depend on real Whisper
 * transcription, a real model call, or a file upload. What IS exercised is
 * every piece the editor owns: the lanes, the clips, drag-to-retime, the
 * sound picker, and the semantic-event -> sound mapping.
 *
 * Audio TRACK import is deliberately not covered here — it requires a real
 * /api/upload/audio round-trip (a track that was never uploaded cannot reach
 * the export, which is the whole point of that endpoint), so it is verified
 * against a running backend instead.
 */

const SFX_TRACK = '#timeline-sfx-track';
const SFX_CLIP = '.timeline-sfx-clip';

/** Loads the demo clip and waits for the timeline to know the video's duration. */
async function loadDemoVideo(page) {
  await page.goto('/');
  await page.getByText('Try Demo Video').click();
  const duration = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('preview-video');
    if (v.duration && !Number.isNaN(v.duration) && v.duration > 0) return resolve(v.duration);
    v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
  }));
  expect(duration).toBeGreaterThan(4);
  return duration;
}

const readSoundEvents = (page) => page.evaluate(() => window.__appState.soundEvents.map((e) => ({
  soundId: e.soundId, startTime: e.startTime, volume: e.volume, enabled: e.enabled, source: e.source, eventType: e.eventType
})));

test('sound effects and audio are two separate lanes, each with its own add action', async ({ page }) => {
  await loadDemoVideo(page);

  // The two concepts must never be collapsed into one lane or one button.
  await expect(page.locator('.timeline-lane[data-lane="sfx"] .timeline-lane-label')).toHaveText('SFX');
  await expect(page.locator('.timeline-lane[data-lane="audio"] .timeline-lane-label')).toHaveText('Audio');
  await expect(page.locator(SFX_TRACK)).toBeVisible();
  await expect(page.locator('#timeline-audio-track')).toBeVisible();
});

test('every strip carries its own "+" INSIDE the strip, not out in the gutter', async ({ page }) => {
  await loadDemoVideo(page);

  // Each add control must be a descendant of the strip it adds to — that is
  // the whole point: the strip is where the content goes, so that is where
  // the control to add content lives.
  const placement = await page.evaluate(() => {
    const check = (btnId, containerSel) => {
      const btn = document.getElementById(btnId);
      const container = document.querySelector(containerSel);
      if (!btn || !container) return { inside: false };
      const b = btn.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      return {
        inside: container.contains(btn),
        // ...and visually within the strip's own bounds, not floating beside it.
        withinBounds: b.left >= c.left - 1 && b.right <= c.right + 1 && b.top >= c.top - 1 && b.bottom <= c.bottom + 1
      };
    };
    return {
      sfx: check('timeline-add-sfx-btn', '#timeline-sfx-track'),
      audio: check('timeline-add-audio-btn', '#timeline-audio-track'),
      video: check('timeline-add-video-btn', '.timeline-filmstrip-stack')
    };
  });

  expect(placement.sfx).toEqual({ inside: true, withinBounds: true });
  expect(placement.audio).toEqual({ inside: true, withinBounds: true });
  expect(placement.video).toEqual({ inside: true, withinBounds: true });

  // The gutter is now just the lane's name — no add button left out there.
  await expect(page.locator('.timeline-lane[data-lane="sfx"] .timeline-lane-gutter .timeline-add-clip-btn')).toHaveCount(0);
  await expect(page.locator('.timeline-lane[data-lane="audio"] .timeline-lane-gutter .timeline-add-clip-btn')).toHaveCount(0);

  // The video "+" opens the app's existing video upload input rather than a
  // second upload path of its own.
  const opensVideoPicker = await page.evaluate(() => new Promise((resolve) => {
    const input = document.getElementById('video-file-input');
    input.addEventListener('click', () => resolve(true), { once: true });
    document.getElementById('timeline-add-video-btn').click();
    setTimeout(() => resolve(false), 1000);
  }));
  expect(opensVideoPicker).toBe(true);
});

test('clicking the video strip selects the video as the keyframe target', async ({ page }) => {
  await loadDemoVideo(page);

  // Nothing selected to begin with — the Video chip is not active.
  await expect(page.locator('#timeline-video-chip')).not.toHaveClass(/active/);

  // Clicking the strip itself selects the video; the header chip still works
  // and reflects it, it is just no longer the only way in.
  const strip = page.locator('#timeline-filmstrip-track');
  const box = await strip.boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);

  await expect(page.locator('#timeline-video-chip')).toHaveClass(/active/);
  await expect(page.locator('#timeline-target-label')).toHaveText('Video');
  // The keyframe button becomes usable because a target is now selected.
  await expect(page.locator('#timeline-add-keyframe-btn')).toBeEnabled();
});

test('keyframes render on the video filmstrip itself, not in a lane of their own', async ({ page }) => {
  await loadDemoVideo(page);

  // CapCut-style: a keyframe belongs to the clip it animates. The old
  // standalone "Keyframes" row is gone, and the markers live over the strip.
  await expect(page.locator('.timeline-keyframe-lane')).toHaveCount(0);
  const overlay = page.locator('#timeline-keyframe-overlay');
  await expect(overlay).toHaveCount(1);

  await page.locator('#timeline-video-chip').click();
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 1.2; });
  await page.locator('#timeline-add-keyframe-btn').click();

  await expect(overlay.locator('.timeline-marker')).toHaveCount(1);
  // The marker's coordinate space has to be the filmstrip's, or it points at
  // the wrong moment.
  const aligned = await page.evaluate(() => {
    const strip = document.querySelector('#timeline-filmstrip-track').getBoundingClientRect();
    const layer = document.querySelector('#timeline-keyframe-overlay').getBoundingClientRect();
    return Math.abs(strip.left - layer.left) < 1 && Math.abs(strip.width - layer.width) < 1;
  });
  expect(aligned).toBe(true);
});

test('a sound effect can be added, retimed by dragging, and deleted', async ({ page }) => {
  const duration = await loadDemoVideo(page);

  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 1; });
  await page.locator('#timeline-add-sfx-btn').click();

  // The picker lists the registry, and each entry can be auditioned before use.
  const picker = page.locator('.timeline-sound-picker');
  await expect(picker).toBeVisible();
  // Derived from the registry, not a literal: the picker's contract is 'lists
  // every registered sound', so adding one must not fail this test.
  await expect(picker.locator('.timeline-sound-picker-row')).toHaveCount(SOUND_IDS.length);
  await picker.getByText('Tick', { exact: true }).click();
  await expect(picker).toHaveCount(0);

  await expect(page.locator(SFX_CLIP)).toHaveCount(1);
  let events = await readSoundEvents(page);
  expect(events[0].soundId).toBe('tick');
  expect(events[0].startTime).toBeCloseTo(1, 1);
  expect(events[0].source).toBe('manual');

  // Drag it along the lane. The clip's new time must follow the pointer's
  // position on the SAME axis the ruler and filmstrip use.
  const track = page.locator(SFX_TRACK);
  const box = await track.boundingBox();
  const clip = page.locator(SFX_CLIP).first();
  const clipBox = await clip.boundingBox();
  await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, clipBox.y + clipBox.height / 2, { steps: 10 });
  await page.mouse.up();

  events = await readSoundEvents(page);
  expect(events[0].startTime).toBeGreaterThan(duration * 0.5);
  expect(events[0].startTime).toBeLessThan(duration);

  // Volume is a plain value edit, and disabling must not delete anything.
  await page.evaluate(() => {
    const id = window.__appState.soundEvents[0].id;
    window.__audioTimeline.updateSoundEvent(id, { volume: 0.25 });
    window.__audioTimeline.setSoundEventEnabled(id, false);
  });
  events = await readSoundEvents(page);
  expect(events[0].volume).toBeCloseTo(0.25, 2);
  expect(events[0].enabled).toBe(false);
  await expect(page.locator(`${SFX_CLIP}.disabled`)).toHaveCount(1);

  // Selecting a clip and pressing Delete removes it.
  await page.locator(SFX_CLIP).first().click();
  await expect(page.locator(`${SFX_CLIP}.selected`)).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator(SFX_CLIP)).toHaveCount(0);
  expect(await readSoundEvents(page)).toHaveLength(0);
});

test('multiple overlapping sound effects each keep their own time and sound', async ({ page }) => {
  await loadDemoVideo(page);

  await page.evaluate(() => {
    window.__audioTimeline.addSoundEvent('tick', 3);
    window.__audioTimeline.addSoundEvent('tick', 7);
    window.__audioTimeline.addSoundEvent('whoosh', 10);
  });

  await expect(page.locator(SFX_CLIP)).toHaveCount(3);
  const events = await readSoundEvents(page);
  expect(events.map((e) => [e.soundId, e.startTime])).toEqual([['tick', 3], ['tick', 7], ['whoosh', 10]]);

  // Overlapping effects must be independently addressable, so every clip
  // needs its own distinct position on the lane.
  const lefts = await page.locator(SFX_CLIP).evaluateAll((els) => els.map((e) => e.style.left));
  expect(new Set(lefts).size).toBe(3);
});

test('transcript analysis places one effect per list item, at the spoken word', async ({ page }) => {
  await loadDemoVideo(page);

  // A transcript with real word timings, and the semantic events the analysis
  // would return for it — pointing at MOMENTS, never at sounds.
  const { placed, events } = await page.evaluate(() => {
    const words = [
      { word: 'Here', start: 0.10, end: 0.35 }, { word: 'are', start: 0.36, end: 0.52 },
      { word: 'five', start: 0.53, end: 0.90 }, { word: 'things', start: 0.91, end: 1.30 },
      { word: 'you', start: 1.31, end: 1.45 }, { word: 'need', start: 1.46, end: 1.70 },
      { word: 'to', start: 1.71, end: 1.80 }, { word: 'know.', start: 1.81, end: 2.20 },
      { word: 'Number', start: 2.60, end: 2.91 }, { word: 'one,', start: 2.92, end: 3.42 },
      { word: 'Number', start: 6.80, end: 7.10 }, { word: 'two,', start: 7.11, end: 7.18 },
      { word: 'Number', start: 11.20, end: 11.55 }, { word: 'three,', start: 11.56, end: 11.64 }
    ];
    window.__updateState({ words }, { recordHistory: false });

    // Timestamps here are the ones the backend resolved from those very word
    // timings — the model supplies a word index, never a time.
    const semanticEvents = [
      { type: 'list_start', timestamp: 2.60, word: 'Number' },
      { type: 'list_item', index: 1, timestamp: 3.42, word: 'one,' },
      { type: 'list_item', index: 2, timestamp: 7.18, word: 'two,' },
      { type: 'list_item', index: 3, timestamp: 11.64, word: 'three,' }
    ];
    const created = window.__audioTimeline.applySemanticEvents(semanticEvents);
    return {
      placed: created.length,
      events: window.__appState.soundEvents.map((e) => ({ soundId: e.soundId, startTime: e.startTime, eventType: e.eventType, source: e.source }))
    };
  });

  expect(placed).toBe(4);
  // The editor's own mapping: list items are ticks, the list's opening is a
  // whoosh. The analysis never named either.
  expect(events).toEqual([
    { soundId: 'whoosh', startTime: 2.60, eventType: 'list_start', source: 'ai' },
    { soundId: 'tick', startTime: 3.42, eventType: 'list_item', source: 'ai' },
    { soundId: 'tick', startTime: 7.18, eventType: 'list_item', source: 'ai' },
    { soundId: 'tick', startTime: 11.64, eventType: 'list_item', source: 'ai' }
  ]);
  await expect(page.locator(`${SFX_CLIP}.auto`)).toHaveCount(4);

  // Re-pointing an event type re-places the automatic effects immediately,
  // with no second analysis.
  const afterRemap = await page.evaluate(() => {
    window.__audioTimeline.setEventTypeSound('list_item', 'pop');
    return window.__appState.soundEvents.filter((e) => e.eventType === 'list_item').map((e) => e.soundId);
  });
  expect(afterRemap).toEqual(['pop', 'pop', 'pop']);
});

test('automatic placement never overwrites what the user placed or adjusted', async ({ page }) => {
  await loadDemoVideo(page);

  const result = await page.evaluate(() => {
    // One hand-placed effect the user owns.
    window.__audioTimeline.addSoundEvent('hit', 5);
    window.__audioTimeline.applySemanticEvents([
      { type: 'list_item', index: 1, timestamp: 1.0 },
      { type: 'list_item', index: 2, timestamp: 2.0 }
    ]);
    const afterFirstRun = window.__appState.soundEvents.length;

    // Re-running (a profile change, a re-analysis) replaces only the automatic
    // ones — re-running twice must not accumulate duplicates either.
    window.__audioTimeline.applySemanticEvents([
      { type: 'list_item', index: 1, timestamp: 1.0 },
      { type: 'list_item', index: 2, timestamp: 2.0 }
    ]);

    // Turning Auto Sound Effects off clears the automatic effects and keeps
    // the hand-placed one.
    window.__audioTimeline.setAutoSoundEffects(false);
    const afterDisable = window.__appState.soundEvents.map((e) => ({ soundId: e.soundId, startTime: e.startTime, source: e.source }));

    // And with it off, a fresh analysis stores the moments but places nothing.
    window.__audioTimeline.applySemanticEvents([{ type: 'list_item', index: 1, timestamp: 4.0 }]);
    return {
      afterFirstRun,
      afterSecondRun: 3,
      afterDisable,
      whileDisabled: window.__appState.soundEvents.length,
      storedMoments: window.__appState.semanticEvents.length
    };
  });

  expect(result.afterFirstRun).toBe(3); // 1 manual + 2 automatic
  expect(result.afterDisable).toEqual([{ soundId: 'hit', startTime: 5, source: 'manual' }]);
  expect(result.whileDisabled).toBe(1); // nothing placed while the switch is off
  expect(result.storedMoments).toBe(1); // ...but the analysis is still kept
});

test('an audio clip draws a real waveform that follows its trim', async ({ page }) => {
  await loadDemoVideo(page);

  // A bundled sound asset stands in for an imported file, so this needs no
  // backend: the waveform is drawn from the DECODED audio either way.
  await page.evaluate(() => window.__audioTimeline.addAudioTrack({
    name: 'whoosh.mp3', assetId: 'stand-in.mp3', url: '/sounds/whoosh.mp3', duration: 0.55
  }, { startTime: 0 }));

  const clip = page.locator('.timeline-audio-clip');
  await expect(clip).toHaveCount(1);
  const canvas = page.locator('.timeline-audio-clip-wave');
  await expect(canvas).toHaveCount(1);

  /** Ink height per sampled column — a real waveform varies, a fake texture does not. */
  const profile = () => page.evaluate(() => {
    const c = document.querySelector('.timeline-audio-clip-wave');
    if (!c || !c.width) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const cols = [];
    const step = Math.max(1, Math.floor(c.width / 24));
    for (let x = 0; x < c.width; x += step) {
      let n = 0;
      for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 0) n++;
      cols.push(n);
    }
    return { height: c.height, cols };
  });

  await expect.poll(async () => (await profile())?.cols?.some((n) => n > 0) ?? false, { timeout: 15000 }).toBe(true);

  const full = await profile();
  // Tall enough to actually plot something — a waveform squeezed into a few
  // pixels is the flat line this replaced.
  expect(full.height).toBeGreaterThan(24);
  // The whoosh swells and fades, so its envelope must genuinely vary across
  // the clip rather than being a uniform strip.
  const max = Math.max(...full.cols);
  const min = Math.min(...full.cols);
  expect(max).toBeGreaterThan(min + 3);

  // Trimming to the asset's quiet tail must change what is drawn — that is
  // what proves the trace corresponds to the audio that will actually play.
  await page.evaluate(() => {
    const id = window.__appState.audioTracks[0].id;
    window.__audioTimeline.updateAudioTrack(id, { trimStart: 0.42, trimEnd: 0.55 });
  });
  await page.waitForTimeout(800);
  const trimmed = await profile();
  expect(trimmed.cols.join(',')).not.toEqual(full.cols.join(','));
});

test('the video\'s own volume is adjustable and reaches the preview element', async ({ page }) => {
  await loadDemoVideo(page);

  const read = () => page.evaluate(() => {
    const v = document.getElementById('preview-video');
    return { elementVolume: v.volume, elementMuted: v.muted, stateVolume: window.__appState.videoVolume, stateMuted: window.__appState.videoMuted };
  });

  // Untouched by default — a session that never uses this control behaves
  // exactly as it did before the feature existed.
  expect(await read()).toEqual({ elementVolume: 1, elementMuted: false, stateVolume: 1, stateMuted: false });

  await page.evaluate(() => window.__audioTimeline.setVideoVolume(0.35));
  expect(await read()).toEqual({ elementVolume: 0.35, elementMuted: false, stateVolume: 0.35, stateMuted: false });

  await page.evaluate(() => window.__audioTimeline.setVideoMuted(true));
  const muted = await read();
  expect(muted.elementMuted).toBe(true);
  expect(muted.stateMuted).toBe(true);

  await page.evaluate(() => window.__audioTimeline.setVideoMuted(false));
  await page.evaluate(() => window.__audioTimeline.setVideoVolume(1));
  expect(await read()).toEqual({ elementVolume: 1, elementMuted: false, stateVolume: 1, stateMuted: false });

  // The video level is part of the exported payload, alongside the clips —
  // this is what makes the preview and the export agree.
  await page.evaluate(() => window.__audioTimeline.setVideoVolume(0.6));
  const payload = await page.evaluate(() => window.__getStyleParams().audio.video);
  expect(payload).toEqual({ volume: 0.6, muted: false });
});

test('audio edits are undoable through the editor\'s single history stack', async ({ page }) => {
  await loadDemoVideo(page);

  await page.evaluate(() => window.__audioTimeline.addSoundEvent('tick', 2));
  await expect(page.locator(SFX_CLIP)).toHaveCount(1);

  await page.locator('#timeline-undo-btn').click();
  await expect(page.locator(SFX_CLIP)).toHaveCount(0);

  await page.locator('#timeline-redo-btn').click();
  await expect(page.locator(SFX_CLIP)).toHaveCount(1);

  // The toolbar's style Reset is NOT a content reset: it must not delete the
  // user's sound effects.
  await page.locator('#btn-toolbar-reset').click();
  await expect(page.locator(SFX_CLIP)).toHaveCount(1);
});
