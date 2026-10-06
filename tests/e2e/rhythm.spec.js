import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { drums, toWav } from '../fixtures/rhythmSynth.js';

// THE RHYTHM ENGINE in the real editor (src/js/components/rhythm.js): audio
// imported through "+ Audio", analysed in the worker, its beats on the
// ruler; jumping beat to beat, optional snapping, "add at next beat";
// reopening without re-analysing; and a changed source never leaving stale
// beats behind.
//
// Imports go through the backend's /api/upload/audio, so this hits :5173
// (whose API is the dev backend). Requires `npm run dev:all`.
const APP_URL = 'http://localhost:5173/?splash=0';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bhynd-rhythm-'));
const fixture = (name, opts) => {
  const { samples, sr, truth } = drums(opts);
  const file = path.join(work, name);
  fs.writeFileSync(file, toWav(samples, sr));
  return { file, truth };
};
const DRUMS_120 = fixture('drums-120.wav', { bpm: 120, seconds: 16 });
const DRUMS_90 = fixture('drums-90.wav', { bpm: 90, seconds: 16, seed: 3 });

async function openDemo(page, { fresh = true } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(APP_URL);
  if (fresh) {
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* */ } });
    await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('bhynd'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.reload();
    await page.getByText('Try Demo Video').click();
  }
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0);
}

async function importAudio(page, file) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#timeline-add-audio-btn').click();
  await (await chooser).setFiles(file);
}

const rhythmInfo = (page) => page.evaluate(() => {
  const d = window.__rhythm.describeRhythm();
  return { state: d.state, title: d.title, detail: d.detail, bpm: d.bpm, beats: d.beats };
});

async function waitForRhythmOf(page, nameFragment) {
  await page.waitForFunction((frag) => {
    const d = window.__rhythm.describeRhythm();
    return d.state === 'ready' && (d.detail || '').includes(frag);
  }, nameFragment, { timeout: 60000 });
}

const playhead = (page) => page.evaluate(() => document.getElementById('preview-video').currentTime);

test('a video with no beat says so — no ticks, no rhythm controls', async ({ page }) => {
  await openDemo(page);
  await page.waitForFunction(() => window.__rhythm.describeRhythm().state === 'none', null, { timeout: 30000 });
  expect((await rhythmInfo(page)).title).toBe('No clear beat found');
  await expect(page.locator('.timeline-beat')).toHaveCount(0);
  await expect(page.locator('#timeline-rhythm-controls')).toBeHidden();
});

test('imported music: tempo, beats on the ruler where they are, playhead jumps beat to beat', async ({ page }) => {
  await openDemo(page);
  await importAudio(page, DRUMS_120.file);
  await waitForRhythmOf(page, 'drums-120');
  const info = await rhythmInfo(page);
  expect(Math.abs(info.bpm - 120)).toBeLessThan(1);
  expect(info.beats).toBe(DRUMS_120.truth.length);

  // The ruler shows every beat inside the video's 12 seconds, at its time.
  const beats = await page.evaluate(() => window.__rhythm.getTimelineBeats().map((b) => ({ t: b.time, type: b.type })));
  const inVideo = DRUMS_120.truth.filter((x) => x.t <= 12);
  expect(beats.length).toBe(inVideo.length);
  beats.forEach((b, i) => expect(Math.abs(b.t - inVideo[i].t)).toBeLessThan(0.035));
  await expect(page.locator('.timeline-beat')).toHaveCount(beats.length);
  await expect(page.locator('.timeline-beat.is-downbeat')).toHaveCount(beats.filter((b) => b.type === 'downbeat').length);
  const geo = await page.evaluate(() => {
    const r = document.getElementById('timeline-ruler').getBoundingClientRect();
    const m = document.querySelectorAll('.timeline-beat')[3].getBoundingClientRect();
    return { x: m.left + m.width / 2 - r.left, w: r.width, d: document.getElementById('preview-video').duration };
  });
  expect(Math.abs((geo.x / geo.w) * geo.d - beats[3].t)).toBeLessThan(0.05);

  // The Rhythm card, in plain words.
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await expect(page.locator('#rhythm-status')).toContainText('Rhythm detected');
  await expect(page.locator('#rhythm-bpm')).toHaveText('120');
  await expect(page.locator('#rhythm-confidence')).toHaveText('High');

  // Next / previous beat.
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 2.05; });
  await page.locator('#timeline-next-beat').click();
  expect(Math.abs((await playhead(page)) - beats.find((b) => b.t > 2.05).t)).toBeLessThan(0.01);
  await page.locator('#timeline-prev-beat').click();
  await page.locator('#timeline-prev-beat').click();
  const before = [...beats].reverse().find((b) => b.t < beats.find((x) => x.t > 2.05).t - 0.01);
  expect(Math.abs((await playhead(page)) - [...beats].reverse().find((b) => b.t < before.t - 0.01).t)).toBeLessThan(0.01);
});

test('snapping is optional: off, a dragged shape lands where dropped; on, its edge lands on the beat', async ({ page }) => {
  await openDemo(page);
  await importAudio(page, DRUMS_120.file);
  await waitForRhythmOf(page, 'drums-120');
  const beats = await page.evaluate(() => window.__rhythm.getTimelineBeats().map((b) => b.time));
  const id = await page.evaluate(() => {
    document.getElementById('preview-video').currentTime = 0.3;
    const s = window.__shapeLayers.addShapeLayer('rectangle', { start: 0.3 });
    window.__shapeLayers.updateShapeLayer(s.id, { end: 1.3 });
    return s.id;
  });
  const shapeStart = () => page.evaluate((i) => window.__appState.shapeLayers.find((s) => s.id === i).start, id);
  const dragBy = async (seconds) => {
    const track = await page.locator('#timeline-shapes-track').boundingBox();
    const clip = await page.locator(`[data-clip-id="${id}"]`).boundingBox();
    const dur = await page.evaluate(() => document.getElementById('preview-video').duration);
    const dx = (seconds / dur) * track.width;
    await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await page.mouse.down();
    await page.mouse.move(clip.x + clip.width / 2 + dx, clip.y + clip.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  // Target: 2 ms-ish short of a beat — close enough to catch, not on it.
  const target = beats.find((b) => b > 3) - 0.04;

  await dragBy(target - (await shapeStart()));
  const off = await shapeStart();
  expect(beats.some((b) => Math.abs(b - off) < 0.005), `snap off: ${off} is not moved onto a beat`).toBe(false);

  await page.locator('#timeline-snap-beats').click();
  await expect(page.locator('#timeline-snap-beats')).toHaveClass(/active/);
  await dragBy(target + 1.5 - (await shapeStart()));
  const on = await shapeStart();
  const end = on + 1.0;
  expect(beats.some((b) => Math.abs(b - on) < 0.002) || beats.some((b) => Math.abs(b - end) < 0.002), `snap on: an edge lands on a beat (${on})`).toBe(true);
  // The preference stays off for sounds: SFX are never snapped.
  await page.locator('#timeline-snap-beats').click();
  await expect(page.locator('#timeline-snap-beats')).not.toHaveClass(/active/);
});

test('"add at next beat" creates at the beat after the playhead — and edits nothing else', async ({ page }) => {
  await openDemo(page);
  await importAudio(page, DRUMS_120.file);
  await waitForRhythmOf(page, 'drums-120');
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const existing = await page.evaluate(() => window.__shapeLayers.addShapeLayer('ellipse', { start: 5 }).id);
  const before = await page.evaluate((i) => JSON.stringify(window.__appState.shapeLayers.find((s) => s.id === i)), existing);
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 1.0; });
  const expected = await page.evaluate(() => window.__rhythm.nextBeatAfter(1.0).time);
  await page.locator('#rhythm-add-shape').click();
  const made = await page.evaluate(() => window.__appState.shapeLayers.at(-1));
  expect(Math.abs(made.start - expected)).toBeLessThan(1e-6);
  await page.locator('#rhythm-add-text').click();
  const text = await page.evaluate(() => window.__appState.textElements.at(-1));
  expect(text.start).toBeGreaterThan(expected);
  expect(await page.evaluate((i) => JSON.stringify(window.__appState.shapeLayers.find((s) => s.id === i)), existing)).toBe(before);
});

test('reopening a project reuses its beat map; changing the audio never leaves stale beats', async ({ page }) => {
  await openDemo(page);
  await importAudio(page, DRUMS_120.file);
  await waitForRhythmOf(page, 'drums-120');
  const key120 = await page.evaluate(() => window.__rhythm.resolveRhythmSource().key);
  // Moving the track: same audio, beats follow it, no re-analysis.
  const shifted = await page.evaluate(() => {
    const t = window.__appState.audioTracks[0];
    const map = window.__rhythm.getActiveBeatMap();
    const first = window.__rhythm.getTimelineBeats()[0].time;
    window.__audioTimeline.moveAudioTrack(t.id, 1);
    return { sameMap: window.__rhythm.getActiveBeatMap() === map, first, after: window.__rhythm.getTimelineBeats()[0].time };
  });
  expect(shifted.sameMap).toBe(true);
  expect(shifted.after - shifted.first).toBeCloseTo(1, 3);

  // Reload: restored from the saved project, not analysed again.
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('preview-video')?.duration > 0 && window.__appState.audioTracks?.length === 1, null, { timeout: 20000 });
  const sawAnalyzing = await page.evaluate(() => new Promise((resolve) => {
    let seen = false;
    const t0 = performance.now();
    const poll = () => {
      if (window.__appState.rhythmStatus?.state === 'analyzing') seen = true;
      if (window.__rhythm.describeRhythm().state === 'ready' || performance.now() - t0 > 4000) resolve({ seen, ready: window.__rhythm.describeRhythm().state === 'ready' });
      else requestAnimationFrame(poll);
    };
    poll();
  }));
  expect(sawAnalyzing).toEqual({ seen: false, ready: true });
  expect(Object.keys(await page.evaluate(() => window.__appState.beatMaps))).toContain(key120);

  // Replace the audio: the new track's own rhythm; the old map is gone.
  await importAudio(page, DRUMS_90.file);
  await page.evaluate(() => window.__audioTimeline.removeAudioTrack(window.__appState.audioTracks[0].id));
  await waitForRhythmOf(page, 'drums-90');
  expect(Math.abs((await rhythmInfo(page)).bpm - 90)).toBeLessThan(1);
  await page.waitForFunction((k) => !Object.keys(window.__appState.beatMaps).includes(k), key120, { timeout: 5000 });

  // Remove it too: back to the video's own sound — no beats at all.
  await page.evaluate(() => window.__audioTimeline.removeAudioTrack(window.__appState.audioTracks[0].id));
  await page.waitForFunction(() => window.__rhythm.describeRhythm().state === 'none', null, { timeout: 30000 });
  await expect(page.locator('.timeline-beat')).toHaveCount(0);
});

test('the export is untouched: no beat data rides along to the renderer', async ({ page }) => {
  await openDemo(page);
  await importAudio(page, DRUMS_120.file);
  await waitForRhythmOf(page, 'drums-120');
  const keys = await page.evaluate(() => Object.keys(window.__getStyleParams()));
  expect(keys.filter((k) => /beat|rhythm/i.test(k))).toEqual([]);
});
