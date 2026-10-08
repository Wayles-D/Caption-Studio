/**
 * THE RHYTHM ANALYSER — mono PCM in, a beat map (shared/rhythm/beatMap.js)
 * out. Pure, deterministic JavaScript with no dependencies and no network:
 * the same function runs in the editor's Web Worker and in the backend's
 * tests (fed audio decoded by ffmpeg), so what is tested is what runs.
 *
 * The method is the standard one for beat tracking, in four steps:
 *
 *  1. ONSET ENVELOPE. A short-time spectrum (512-point FFT at 11025 Hz, hop
 *     128 = 86 frames/s). Each frame's log-compressed magnitudes are
 *     compared with the previous frame's; the summed INCREASES ("spectral
 *     flux") spike wherever a sound starts — a drum hit, a note, a syllable.
 *     A second, bass-only flux (below ~200 Hz) is kept for downbeats.
 *  2. TEMPO. The envelope's autocorrelation peaks at the beat period. Lags
 *     for 40-220 BPM are scored, weighted gently towards 120 BPM so a pulse
 *     isn't read at half or double its speed, and the best is refined
 *     between lags.
 *  3. BEATS. Dynamic programming (Ellis 2007): a beat on frame t scores its
 *     own onset strength plus the best earlier beat, penalised by how far
 *     their spacing strays from the period. The best path is a beat
 *     sequence that sits on strong onsets AND keeps a steady pulse — and,
 *     because the penalty is soft, follows a tempo that drifts.
 *  4. DOWNBEATS. Bars begin where the bass accents. For 4 and 3 beats per
 *     bar, beats are grouped by position in the bar and the groups' bass
 *     accents compared; downbeats are reported ONLY when one position stands
 *     clearly above the rest. Otherwise the map has none — no assumed "every
 *     fourth beat".
 *
 * Confidence combines how periodic the envelope is, how much stronger the
 * onsets are ON the beats than between them, and how regular the beats are.
 * Speech has onsets but no pulse, so it scores low rather than pretending.
 */
import { ANALYZER_VERSION } from './beatMap.js';

const SR = 11025;
const N_FFT = 512;
const HOP = 128;
const FPS = SR / HOP;
const MIN_BPM = 40;
const MAX_BPM = 220;
const PRIOR_BPM = 120;
const TIGHTNESS = 100;
const SILENCE_RMS = 0.001; // about -60 dBFS
const MIN_DURATION = 2;
const MIN_ONSET_ACTIVITY = 30; // see analyzeRhythm's onset-activity gate

/** Mono samples at any rate → 11025 Hz, with a box low-pass before decimating. */
function resampleTo(samples, rate) {
  if (rate === SR) return samples;
  const ratio = rate / SR;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  const span = Math.max(1, Math.round(ratio));
  for (let i = 0; i < out.length; i++) {
    const c = i * ratio;
    const a = Math.max(0, Math.floor(c - span / 2));
    const b = Math.min(samples.length, a + span);
    let s = 0;
    for (let j = a; j < b; j++) s += samples[j];
    out[i] = s / (b - a);
  }
  return out;
}

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Step 1: the full-band and bass onset envelopes, one value per hop. */
function onsetEnvelopes(x) {
  const frames = Math.max(0, Math.floor((x.length - N_FFT) / HOP) + 1);
  const win = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const bins = N_FFT / 2;
  const bassBins = Math.max(2, Math.round((200 / SR) * N_FFT));
  // BANDS, not bins: 24 log-spaced bands from 40 Hz to 5 kHz, each a band's
  // energy in dB. Per-bin flux on a dense real mix is dominated by noise —
  // vibrato, reverb tails, sustained chords flickering bin to bin — while a
  // drum hit or a new chord lifts whole bands at once.
  const BANDS = 24;
  const edges = [];
  for (let b = 0; b <= BANDS; b++) edges.push(Math.min(bins - 1, Math.max(1, Math.round((40 * (5000 / 40) ** (b / BANDS)) / SR * N_FFT))));
  let prevBand = new Float32Array(BANDS);
  let band = new Float32Array(BANDS);
  const env = new Float32Array(frames);
  // The same flux WITHOUT log compression: loudness-faithful, so a quiet
  // hi-hat stays quieter than a snare. Used to judge which onsets are the
  // beats (the tempo's octave, beat strength); the log flux, which is better
  // at WHEN something starts, drives the timing.
  const lin = new Float32Array(frames);
  let prevMag = new Float32Array(bins);
  let mags = new Float32Array(bins);
  const bass = new Float32Array(frames);
  // Bass ENERGY rise, linear: a louder kick must read as louder. (The log
  // compression that makes the full-band flux robust also flattens exactly
  // the loudness difference a downbeat accent is made of.)
  let prevBassEnergy = 0;
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    let linFlux = 0;
    let bassEnergy = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      mags[k] = mag;
      const dl = mag - prevMag[k];
      if (dl > 0) linFlux += dl;
      if (k <= bassBins) bassEnergy += mag * mag;
    }
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = edges[b]; k <= Math.max(edges[b], edges[b + 1] - 1); k++) e += mags[k] * mags[k];
      band[b] = 10 * Math.log10(e + 1e-6);
      const d = band[b] - prevBand[b];
      if (d > 0) flux += d;
    }
    [prevBand, band] = [band, prevBand];
    [prevMag, mags] = [mags, prevMag];
    env[f] = f === 0 ? 0 : flux;
    lin[f] = f === 0 ? 0 : linFlux;
    bass[f] = f === 0 ? 0 : Math.max(0, bassEnergy - prevBassEnergy);
    prevBassEnergy = bassEnergy;
  }
  return { env, lin, bass };
}

/** Removes the slow trend (a quarter-second moving average) so onsets stand on a level floor, then scales to unit spread. */
function normalizeEnvelope(env) {
  const n = env.length;
  const w = Math.max(1, Math.round(FPS * 0.25));
  const out = new Float32Array(n);
  // Centred moving average via prefix sums.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    out[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += out[i];
  m /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) v += (out[i] - m) ** 2;
  const sd = Math.sqrt(v / (n || 1)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/**
 * How periodic the envelope is LOCALLY: the best normalized autocorrelation
 * peak in each 8-second window, averaged. A tempo that drifts smears the
 * whole-clip autocorrelation, but each window still has a clear pulse of its
 * own; speech has none in any window.
 */
function localPeriodicity(env) {
  const win = Math.round(8 * FPS);
  if (env.length < win * 1.5) return 0;
  const minLag = Math.floor((60 * FPS) / MAX_BPM);
  const maxLag = Math.ceil((60 * FPS) / MIN_BPM);
  const peaks = [];
  for (let start = 0; start + win <= env.length; start += Math.round(win / 2)) {
    let mean = 0;
    for (let i = start; i < start + win; i++) mean += env[i];
    mean /= win;
    let ac0 = 0;
    for (let i = start; i < start + win; i++) ac0 += (env[i] - mean) ** 2;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = start; i + lag < start + win; i++) s += (env[i] - mean) * (env[i + lag] - mean);
      best = Math.max(best, (s / (win - lag)) * win / (ac0 || 1));
    }
    peaks.push(best);
  }
  return peaks.reduce((a, b) => a + b, 0) / (peaks.length || 1);
}

/** Step 2: the beat period in frames, and how periodic the envelope is (0-1). */
function estimatePeriod(env) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = env[i] - mean;
  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += c[i] * c[i];
  const minLag = Math.floor((60 * FPS) / MAX_BPM);
  const maxLag = Math.min(n - 1, Math.ceil((60 * FPS) / MIN_BPM));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += c[i] * c[i + lag];
    // Unbiased: shorter overlaps aren't penalised for being shorter.
    ac[lag] = s / (n - lag) * n / (ac0 || 1);
  }
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_BPM) / 1.0) ** 2);
    const score = Math.max(0, ac[lag]) * prior;
    if (score > best) { best = score; bestLag = lag; }
  }
  // Parabolic refinement between lags.
  const y0 = ac[bestLag - 1] ?? 0;
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1] ?? 0;
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
  return { period: bestLag + shift, periodicity: Math.max(0, Math.min(1, y1)) };
}

/** Mean envelope on a grid of period `p` at its best phase, and midway between. */
function gridStrength(env, p) {
  const n = env.length;
  const steps = Math.max(1, Math.round(p));
  let best = { on: 0, off: 0 };
  for (let phase = 0; phase < steps; phase++) {
    let on = 0;
    let off = 0;
    let k = 0;
    for (let t = phase; t < n; t += p, k++) {
      on += peakNear(env, Math.round(t), 1);
      off += peakNear(env, Math.round(t + p / 2), 1);
    }
    on /= k || 1;
    off /= k || 1;
    if (on > best.on) best = { on, off };
  }
  return best;
}

/**
 * The tempo's OCTAVE. Autocorrelation can't tell a pulse from its half or
 * double (eighth-note hi-hats look like a beat at twice the tempo; a kick on
 * 1 and 3 like one at half). So: if the positions midway between beats are
 * nearly as strong as the beats, the true beat is the faster one; if every
 * other beat is weak, it is the slower one.
 */
function resolveOctave(env, period) {
  const minP = (60 * FPS) / MAX_BPM;
  const maxP = (60 * FPS) / MIN_BPM;
  let p = period;
  for (let i = 0; i < 2 && p / 2 >= minP; i++) {
    const g = gridStrength(env, p);
    if (g.off >= 0.6 * g.on) p /= 2; else break;
  }
  if (p === period) {
    for (let i = 0; i < 2 && p * 2 <= maxP; i++) {
      const g = gridStrength(env, p * 2);
      if (g.off < 0.4 * g.on) p *= 2; else break;
    }
  }
  return p;
}

/** Step 3: Ellis's dynamic-programming beat tracker. Returns beat frames. */
function trackBeats(env, period) {
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = -Infinity;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - TIGHTNESS * Math.log((t - p) / period) ** 2;
      if (v > bestVal) { bestVal = v; bestPrev = p; }
    }
    score[t] = env[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestVal > 0 ? bestPrev : -1;
  }
  // End on the best-scoring frame within the last period.
  let end = n - 1;
  let endVal = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (score[t] > endVal) { endVal = score[t]; end = t; }
  }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // Trim leading/trailing beats that sit on silence (nothing sounding nearby).
  const strong = beats.map((b) => peakNear(env, b));
  const thr = 0.25 * median(strong);
  let a = 0;
  let z = beats.length;
  while (a < z && strong[a] < thr) a++;
  while (z > a && strong[z - 1] < thr) z--;
  return beats.slice(a, z);
}

function peakNear(arr, f, r = 2) {
  let m = 0;
  for (let i = Math.max(0, f - r); i <= Math.min(arr.length - 1, f + r); i++) m = Math.max(m, arr[i]);
  return m;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/** Step 4: downbeats from bass accents, reported only on clear evidence. */
function findDownbeats(beatFrames, bass, env) {
  const accents = beatFrames.map((f) => peakNear(bass, f) + 0.25 * peakNear(env, f));
  let best = null;
  for (const meter of [4, 3]) {
    if (beatFrames.length < meter * 3) continue;
    const sums = new Array(meter).fill(0);
    const counts = new Array(meter).fill(0);
    accents.forEach((a, i) => { sums[i % meter] += a; counts[i % meter] += 1; });
    const means = sums.map((s, i) => s / (counts[i] || 1));
    const top = Math.max(...means);
    const phase = means.indexOf(top);
    const others = means.filter((_, i) => i !== phase);
    const restMax = Math.max(...others);
    // How far the accented position stands above the next strongest.
    const contrast = top > 0 ? (top - restMax) / top : 0;
    if (!best || contrast > best.contrast) best = { meter, phase, contrast };
  }
  if (!best || best.contrast < 0.2) return { downbeatIdx: new Set(), meter: null };
  const idx = new Set();
  for (let i = best.phase; i < beatFrames.length; i += best.meter) idx.add(i);
  return { downbeatIdx: idx, meter: { beatsPerBar: best.meter, confidence: Math.min(1, best.contrast / 0.5) } };
}

/**
 * @param {Float32Array} samples - Mono PCM, -1..1.
 * @param {number} sampleRate
 * @param {{ source?: object }} [options]
 * @returns {object} A beat map (see beatMap.js) — `source` is copied in as given.
 */
export function analyzeRhythm(samples, sampleRate, options = {}) {
  const duration = samples.length / sampleRate;
  const base = { source: options.source || null, duration, analyzerVersion: ANALYZER_VERSION, beats: [], downbeats: [], meter: null, bpm: null, confidence: 0 };
  if (duration < MIN_DURATION) return { ...base, status: 'too-short' };
  let ss = 0;
  for (let i = 0; i < samples.length; i++) ss += samples[i] * samples[i];
  if (Math.sqrt(ss / samples.length) < SILENCE_RMS) return { ...base, status: 'silent' };

  const x = resampleTo(samples, sampleRate);
  const { env: rawEnv, lin: rawLin, bass: rawBass } = onsetEnvelopes(x);
  // ONSET ACTIVITY, in absolute terms: how big the real jumps in level are
  // (the mean of the strongest 10% of frames, in dB summed over the bands).
  // Everything after this normalises the envelope to unit spread, which
  // would blow a steady tone's near-zero ripple up into a "pulse" — so with
  // no real onsets there is no rhythm to look for, whatever the shape says.
  const onsetActivity = percentileMean(rawEnv, 0.9);
  // Measured: a steady tone ~21, a soft vocal ballad ~56, a trap beat ~168,
  // drums 470+, speech ~340. Below 30 nothing ever really starts.
  if (onsetActivity < MIN_ONSET_ACTIVITY) {
    return { ...base, status: 'no-rhythm', diagnostics: { onsetActivity: +onsetActivity.toFixed(2) } };
  }
  const env = normalizeEnvelope(rawEnv);
  const lin = normalizeEnvelope(rawLin);
  const bass = normalizeEnvelope(rawBass);
  const estimate = estimatePeriod(env);
  const period = resolveOctave(lin, estimate.period);
  // The better of whole-clip and windowed periodicity: steady music scores
  // the same either way; a drifting tempo keeps the credit its windows earn.
  const periodicity = Math.max(estimate.periodicity, Math.min(1, localPeriodicity(env)));
  const frames = trackBeats(env, period);
  if (frames.length < 4) return { ...base, status: 'no-rhythm', confidence: 0 };

  // A frame's flux describes the window CENTRED half a window after its
  // start. Each beat is then refined between frames, at the onset peak it
  // sits on (parabolic fit) — frames are 11.6ms apart, a beat needn't be.
  const timeOf = (f) => (f * HOP + N_FFT / 2) / SR;
  const refined = frames.map((f) => {
    let p = f;
    for (let i = Math.max(1, f - 2); i <= Math.min(env.length - 2, f + 2); i++) if (env[i] > env[p]) p = i;
    if (p < 1 || p > env.length - 2) return timeOf(p);
    const den = env[p - 1] - 2 * env[p] + env[p + 1];
    const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (env[p - 1] - env[p + 1])) / den)) : 0;
    return timeOf(p + shift);
  });
  const ibis = [];
  for (let i = 1; i < refined.length; i++) ibis.push(refined[i] - refined[i - 1]);
  // Tempo from a straight-line fit of beat time against beat number: every
  // beat contributes, so no single interval's rounding sets the tempo (and
  // for a drifting tempo, it is the average).
  const n = refined.length;
  const mx = (n - 1) / 2;
  const my = refined.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  refined.forEach((t, i) => { sxy += (i - mx) * (t - my); sxx += (i - mx) ** 2; });
  const slope = sxx > 0 ? sxy / sxx : 0;
  const bpm = slope > 0 ? 60 / slope : null;

  // Confidence (0-1): periodicity, on-beat vs off-beat contrast, regularity.
  const onBeat = frames.map((f) => peakNear(lin, f));
  // On the beats vs midway between them: music sounds ON its beats; speech
  // sounds anywhere, so for speech the two are about equal.
  const midway = frames.slice(1).map((f, i) => peakNear(lin, Math.round((f + frames[i]) / 2)));
  const onMean = onBeat.reduce((a, b) => a + b, 0) / onBeat.length || 1e-9;
  const offMean = midway.reduce((a, b) => a + b, 0) / (midway.length || 1);
  const contrast = Math.max(0, Math.min(1, 1 - offMean / onMean));
  const meanIbi = ibis.reduce((a, b) => a + b, 0) / ibis.length;
  const cv = Math.sqrt(ibis.reduce((a, b) => a + (b - meanIbi) ** 2, 0) / ibis.length) / (meanIbi || 1);
  const regularity = 1 - Math.min(1, cv / 0.15);
  // Periodicity GATES the rest: without a pulse, beats can still be placed
  // on onsets and look tidy, but nothing makes them trustworthy.
  // Above the floor that ANY signal shows in an 8-second window (~0.15 —
  // measured on speech and noise), to a clear pulse at ~0.45.
  const periodic = Math.max(0, Math.min(1, (periodicity - 0.15) / 0.3));
  const confidence = Math.max(0, Math.min(1, periodic * (0.5 + 0.25 * contrast + 0.25 * regularity)));

  const ref = percentile(onBeat, 0.9) || 1;
  const { downbeatIdx, meter } = findDownbeats(frames, bass, env);
  const beats = frames.map((f, i) => ({
    time: +refined[i].toFixed(4),
    strength: +Math.min(1, onBeat[i] / ref).toFixed(3),
    index: i,
    type: downbeatIdx.has(i) ? 'downbeat' : 'beat'
  }));
  return {
    ...base,
    status: confidence < 0.2 ? 'no-rhythm' : 'ok',
    bpm: bpm ? +bpm.toFixed(1) : null,
    confidence: +confidence.toFixed(3),
    beats,
    downbeats: beats.filter((b) => b.type === 'downbeat'),
    meter,
    diagnostics: { periodicity: +periodicity.toFixed(3), contrast: +contrast.toFixed(3), regularity: +regularity.toFixed(3), onsetActivity: +onsetActivity.toFixed(2) }
  };
}

/** Mean of the values at or above the p-th percentile. */
function percentileMean(arr, p) {
  if (!arr.length) return 0;
  const s = Array.from(arr).sort((a, b) => a - b);
  const top = s.slice(Math.floor(p * s.length));
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
}
