/**
 * THE RHYTHM ENGINE (shared/rhythm/) — the analyser against audio whose
 * rhythm is KNOWN (tests/fixtures/rhythmSynth.js), the grid queries, the
 * timeline projection, and the beat map's validity rules:
 *
 *   - tempo and every beat found across 72-150 BPM, a drifting tempo
 *     followed, downbeats only when the audio accents them;
 *   - speech, a steady tone, silence and a too-short clip report no rhythm
 *     rather than inventing one;
 *   - the same answer after an MP3 round trip through ffmpeg (a real codec);
 *   - nearest / next / previous / range / downbeat / snap are exact;
 *   - beats land on the timeline where their track plays (start, trim, loop);
 *   - a map is valid only for the audio it came from, from this analyser.
 *
 * Opt-in real audio: RHYTHM_REAL_AUDIO="a.mp3;b.mp3" prints what the
 * analyser makes of each and checks the result is self-consistent.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { analyzeRhythm } from '../shared/rhythm/analyzer.js';
import { normalizeBeatMap, isBeatMapValidFor, rhythmSourceKey, confidenceLabel, ANALYZER_VERSION } from '../shared/rhythm/beatMap.js';
import { nearestBeat, nextBeat, previousBeat, beatsBetween, nearestDownbeat, snapTimeToBeat, beatContext, projectBeatMap } from '../shared/rhythm/rhythmGrid.js';
import { drums, speech, tone, toWav } from '../tests/fixtures/rhythmSynth.js';

console.log('--- The Rhythm Engine ---');

/** Share of true beats with a detected beat within `tol` seconds. */
const hitRate = (beats, truth, tol = 0.035) => truth.filter((x) => beats.some((b) => Math.abs(b.time - x.t) < tol)).length / truth.length;

// ---------------------------------------------------------------------------
console.log('\n[Test 1] Music: tempo, every beat, downbeats');
for (const bpm of [72, 96, 120, 128, 150]) {
  const { samples, sr, truth } = drums({ bpm, seconds: 30 });
  const m = analyzeRhythm(samples, sr);
  assert.strictEqual(m.status, 'ok', `${bpm}: a rhythm`);
  assert.ok(Math.abs(m.bpm - bpm) < 1, `${bpm}: tempo read as ${m.bpm}`);
  assert.ok(hitRate(m.beats, truth) === 1, `${bpm}: every beat within 35ms (${hitRate(m.beats, truth)})`);
  assert.strictEqual(m.beats.length, truth.length, `${bpm}: no extra beats`);
  assert.ok(m.confidence >= 0.6, `${bpm}: high confidence (${m.confidence})`);
  const trueDown = truth.filter((x) => x.down);
  assert.ok(hitRate(m.downbeats, trueDown) === 1 && m.downbeats.length === trueDown.length, `${bpm}: exactly the accented bar starts`);
  assert.deepStrictEqual(m.meter?.beatsPerBar, 4);
  m.beats.forEach((b, i) => {
    assert.ok(b.strength >= 0 && b.strength <= 1, 'strength in 0-1');
    assert.strictEqual(b.index, i);
  });
  console.log(`  ${bpm} BPM -> ${m.bpm}, ${m.beats.length} beats, ${m.downbeats.length} downbeats, confidence ${m.confidence}`);
}
{
  const flat = drums({ bpm: 110, seconds: 30, accentDownbeat: false });
  const m = analyzeRhythm(flat.samples, flat.sr);
  assert.strictEqual(m.status, 'ok');
  assert.deepStrictEqual(m.downbeats, [], 'no accent on the bar start: no downbeats claimed');
  assert.strictEqual(m.meter, null);
  assert.ok(m.beats.every((b) => b.type === 'beat'));
}
{
  const ramp = drums({ bpm: 100, rampTo: 130, seconds: 40 });
  const m = analyzeRhythm(ramp.samples, ramp.sr);
  assert.ok(hitRate(m.beats, ramp.truth, 0.05) > 0.9, `a drifting tempo is followed (${hitRate(m.beats, ramp.truth, 0.05)})`);
  assert.ok(m.bpm > 105 && m.bpm < 125, `its tempo is the average (${m.bpm})`);
  console.log(`  100->130 BPM ramp -> ${m.bpm} average, ${(hitRate(m.beats, ramp.truth, 0.05) * 100).toFixed(0)}% of beats`);
}
console.log('✓ Tempo, beats and downbeats');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] No rhythm is reported as no rhythm');
{
  const sp = speech({ seconds: 30 });
  const ms = analyzeRhythm(sp.samples, sp.sr);
  assert.strictEqual(ms.status, 'no-rhythm', `speech: ${ms.status} (${ms.confidence})`);
  assert.ok(ms.confidence < 0.2);
  const t = tone({ seconds: 12 });
  const mt = analyzeRhythm(t.samples, t.sr);
  assert.strictEqual(mt.status, 'no-rhythm', 'a steady tone: nothing ever starts');
  assert.deepStrictEqual(mt.beats, []);
  assert.strictEqual(analyzeRhythm(new Float32Array(22050 * 10), 22050).status, 'silent');
  const quiet = drums({ bpm: 120, seconds: 10, gain: 0.0003 });
  assert.strictEqual(analyzeRhythm(quiet.samples, quiet.sr).status, 'silent', 'near-silent');
  assert.strictEqual(analyzeRhythm(drums({ bpm: 120, seconds: 1.5 }).samples, 22050).status, 'too-short');
  // Music under speech: still found.
  const mix = drums({ bpm: 124, seconds: 30 });
  const voice = speech({ seconds: 30 });
  for (let i = 0; i < mix.samples.length; i++) mix.samples[i] = 0.5 * mix.samples[i] + voice.samples[i];
  const mm = analyzeRhythm(mix.samples, mix.sr);
  assert.strictEqual(mm.status, 'ok');
  assert.ok(Math.abs(mm.bpm - 124) < 1.5, `music + speech: ${mm.bpm}`);
  assert.ok(hitRate(mm.beats, mix.truth, 0.07) > 0.75);
  console.log(`  speech ${ms.status} (${ms.confidence}), tone ${mt.status}, silence silent, 1.5s too-short, music+speech ${mm.bpm} BPM (${mm.confidence})`);
}
console.log('✓ Speech, tone, silence and too-short report no rhythm; music under speech is still found');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] The same answer through a real codec (MP3 via ffmpeg)');
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rhythm-'));
  const { samples, sr, truth } = drums({ bpm: 98, seconds: 25 });
  const wav = path.join(work, 'in.wav');
  const mp3 = path.join(work, 'in.mp3');
  fs.writeFileSync(wav, toWav(samples, sr));
  const enc = spawnSync(ffmpegPath, ['-y', '-v', 'error', '-i', wav, '-ar', '44100', '-ac', '2', '-b:a', '160k', mp3]);
  assert.strictEqual(enc.status, 0, 'encoded');
  const dec = spawnSync(ffmpegPath, ['-v', 'error', '-i', mp3, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const decoded = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, dec.stdout.length / 4);
  const m = analyzeRhythm(decoded, 22050);
  assert.ok(Math.abs(m.bpm - 98) < 1, `after MP3: ${m.bpm}`);
  // MP3 adds a few ms of encoder delay; every beat is still found.
  assert.ok(hitRate(m.beats, truth, 0.05) === 1, `after MP3: every beat (${hitRate(m.beats, truth, 0.05)})`);
}
console.log('✓ Unchanged after an MP3 round trip');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] The grid: nearest, next, previous, range, downbeat, snap');
{
  const beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0].map((time, index) => ({ time, index, strength: index % 2 ? 0.4 : 0.9, type: index % 4 === 0 ? 'downbeat' : 'beat' }));
  assert.strictEqual(nearestBeat(beats, 1.2).time, 1.0);
  assert.strictEqual(nearestBeat(beats, 1.3).time, 1.5);
  assert.strictEqual(nearestBeat(beats, 1.25).time, 1.0, 'a tie goes to the earlier beat');
  assert.strictEqual(nearestBeat(beats, -5).time, 0.5);
  assert.strictEqual(nearestBeat(beats, 99).time, 3.0);
  assert.strictEqual(nextBeat(beats, 1.0).time, 1.5, 'a beat AT t is now, not next');
  assert.strictEqual(nextBeat(beats, 1.01).time, 1.5);
  assert.strictEqual(nextBeat(beats, 3.0), null);
  assert.strictEqual(previousBeat(beats, 1.0).time, 0.5);
  assert.strictEqual(previousBeat(beats, 0.5), null);
  assert.deepStrictEqual(beatsBetween(beats, 1.0, 2.0).map((b) => b.time), [1.0, 1.5, 2.0]);
  assert.deepStrictEqual(beatsBetween(beats, 2, 1), []);
  assert.strictEqual(nearestDownbeat(beats, 2.0).time, 2.5);
  assert.deepStrictEqual(nearestBeat(beats, 1.4, { minStrength: 0.8 }).time, 1.5, 'strong beats only');
  assert.deepStrictEqual(beatContext(beats, 1.6), { previous: beats[2], nearest: beats[2], next: beats[3] });
  assert.deepStrictEqual(snapTimeToBeat(1.43, beats, { threshold: 0.1 }), { time: 1.5, snapped: true, beat: beats[2] });
  assert.deepStrictEqual(snapTimeToBeat(1.3, beats, { threshold: 0.1 }), { time: 1.3, snapped: false, beat: null }, 'out of reach: unchanged');
  assert.strictEqual(snapTimeToBeat(1.3, [], { threshold: 1 }).time, 1.3, 'no beats: unchanged');
  assert.deepStrictEqual(nextBeat([], 1), null);
}
console.log('✓ Exact');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Beats on the timeline: where the track plays');
{
  const map = { duration: 10, beats: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((time, index) => ({ time, index, strength: 1, type: 'beat' })) };
  assert.deepStrictEqual(projectBeatMap(map, { kind: 'video' }, 5.5).map((b) => b.time), [1, 2, 3, 4, 5], 'the video: its own time, cut at its end');
  // Starts at 10s on the timeline, plays source 2.5-6.5.
  const placed = projectBeatMap(map, { kind: 'track', startTime: 10, trimStart: 2.5, trimEnd: 6.5, loop: false, duration: 4 }, 60);
  assert.deepStrictEqual(placed.map((b) => b.time), [10.5, 11.5, 12.5, 13.5]);
  assert.deepStrictEqual(placed.map((b) => b.sourceTime), [3, 4, 5, 6]);
  // Looping a 3s window across 9s of declared play.
  const looped = projectBeatMap(map, { kind: 'track', startTime: 0, trimStart: 1, trimEnd: 4, loop: true, duration: 9 }, 60);
  assert.deepStrictEqual(looped.map((b) => b.time), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // Past the video's end: dropped.
  assert.deepStrictEqual(projectBeatMap(map, { kind: 'track', startTime: 2, trimStart: 0, trimEnd: null, loop: false, duration: 10 }, 6).map((b) => b.time), [3, 4, 5]);
}
console.log('✓ Start, trim, loop and the video\'s end');

// ---------------------------------------------------------------------------
console.log('\n[Test 6] A map is valid only for its own audio, from this analyser');
{
  const keyA = rhythmSourceKey({ kind: 'track', assetId: 'a1', duration: 120 });
  const keyB = rhythmSourceKey({ kind: 'track', assetId: 'b2', duration: 120 });
  assert.notStrictEqual(keyA, keyB, 'different audio, different key');
  assert.notStrictEqual(keyA, rhythmSourceKey({ kind: 'track', assetId: 'a1', duration: 121 }), 'a change of length is a change of audio');
  assert.strictEqual(rhythmSourceKey({ kind: 'track' }), null, 'no asset: nothing to key');
  const { samples, sr } = drums({ bpm: 120, seconds: 12 });
  const raw = analyzeRhythm(samples, sr, { source: { kind: 'track', key: keyA } });
  const map = normalizeBeatMap(JSON.parse(JSON.stringify(raw)));
  assert.ok(isBeatMapValidFor(map, keyA), 'valid for its audio, after a save/load round trip');
  assert.ok(!isBeatMapValidFor(map, keyB), 'replaced audio: the old map is not used');
  assert.strictEqual(normalizeBeatMap({ ...raw, analyzerVersion: ANALYZER_VERSION - 1 }), null, 'an older analyser\'s map is discarded');
  assert.strictEqual(normalizeBeatMap(null), null);
  assert.deepStrictEqual(map.downbeats.map((b) => b.time), map.beats.filter((b) => b.type === 'downbeat').map((b) => b.time));
  assert.strictEqual(confidenceLabel(0.8), 'High');
  assert.strictEqual(confidenceLabel(0.4), 'Medium');
  assert.strictEqual(confidenceLabel(0.1), 'Low');
}
console.log('✓ Keys, round trip, replacement and version rules');

// ---------------------------------------------------------------------------
const real = (process.env.RHYTHM_REAL_AUDIO || '').split(';').map((s) => s.trim()).filter(Boolean);
if (real.length) {
  console.log('\n[Real audio] (RHYTHM_REAL_AUDIO)');
  for (const file of real) {
    const dec = spawnSync(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    if (dec.status !== 0) { console.log(`  ${path.basename(file)}: could not decode`); continue; }
    const samples = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, dec.stdout.length / 4);
    const t0 = Date.now();
    const m = analyzeRhythm(samples, 22050);
    const ibis = m.beats.slice(1).map((b, i) => b.time - m.beats[i].time).sort((a, b) => a - b);
    console.log(`  ${path.basename(file)}: ${m.duration.toFixed(0)}s in ${Date.now() - t0}ms — ${m.status}, ${m.bpm ?? '-'} BPM, ${m.beats.length} beats, ${m.downbeats.length} downbeats, confidence ${m.confidence} (${confidenceLabel(m.confidence)})`);
    if (m.status === 'ok') {
      assert.ok(m.bpm >= 40 && m.bpm <= 220, 'a plausible tempo');
      assert.ok(Math.abs(60 / ibis[Math.floor(ibis.length / 2)] - m.bpm) / m.bpm < 0.08, 'the beats agree with the tempo');
    }
  }
}

console.log('\n--- All rhythm checks passed ---');
