/**
 * DSP primitives for the BHYND sound pack — oscillators, noise, envelopes,
 * RBJ biquads, Karplus-Strong, a Freeverb-style room, and the small signal
 * utilities the instruments are built from.
 *
 * Moved here verbatim from generate-sound-pack.js when the pack grew past what
 * one file could hold. The pack's first 31 sounds are checked byte-for-byte
 * against their pre-move output, so nothing here may change behaviour
 * without that check failing.
 */
export const SR = 48000;
export const TAU = Math.PI * 2;
// ---- primitives -------------------------------------------------------------

const N = (seconds) => Math.max(1, Math.round(seconds * SR));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFor(id) {
  let h = 2166136261;
  for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function white(len, rnd) {
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) b[i] = rnd() * 2 - 1;
  return b;
}
/** Pink noise (Paul Kellet's economy filter) — softer, more natural air than white. */
function pink(len, rnd) {
  const b = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    b[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return b;
}

/**
 * An oscillator whose frequency may change every sample. The phase is
 * INTEGRATED, which is the whole point: a sweep then moves smoothly through
 * every frequency between its ends. Saw and square are built additively and
 * band-limited to 20 kHz at every instant, so a high note cannot alias.
 */
function osc(len, freq, { shape = 'sine', harmonics = 40, phase = 0 } = {}) {
  const b = new Float32Array(len);
  const dynamic = typeof freq === 'function';
  let ph = phase;
  for (let i = 0; i < len; i++) {
    const f = dynamic ? freq(i / SR) : freq;
    let v;
    if (shape === 'sine') v = Math.sin(ph);
    else {
      const K = Math.max(1, Math.min(harmonics, Math.floor(20000 / Math.max(f, 1))));
      v = 0;
      if (shape === 'saw') { for (let k = 1; k <= K; k++) v += Math.sin(k * ph) / k; v *= 2 / Math.PI; }
      else { for (let k = 1; k <= K; k += 2) v += Math.sin(k * ph) / k; v *= 4 / Math.PI; }
    }
    b[i] = v;
    ph += (TAU * f) / SR;
    if (ph > 1e6) ph %= TAU;
  }
  return b;
}
/** f(t) that starts at f0 and relaxes exponentially toward f1 — the shape of a pop or a drop. */
const glide = (f0, f1, tau) => (t) => f1 + (f0 - f1) * Math.exp(-t / tau);
/** f(t) that moves from f0 to f1 over `dur` evenly in pitch (exponential in Hz). */
const sweep = (f0, f1, dur) => (t) => f0 * Math.pow(f1 / f0, Math.min(1, t / dur));

/**
 * Seconds for an attack/hold/decay envelope to fall 50 dB — the length a
 * buffer must have so the sound has genuinely finished inside it. Sizing a
 * buffer by eye is how the first version of this pack got its clicks: a
 * bell rendered into half a second was still ringing at -27 dB when the
 * buffer ended, and the room reverb carried on past the cut.
 */
const span = (attack, tau, hold = 0) => attack + hold + tau * 5.76;

/**
 * Every envelope ends at EXACTLY zero, over its last 5 ms. With buffers sized
 * by span() that taper happens 50 dB down and is inaudible — but it makes a
 * truncation click impossible rather than merely unlikely, for any buffer a
 * recipe gets wrong.
 */
function taperEnd(b) {
  const n = Math.min(b.length, N(0.005));
  for (let i = 0; i < n; i++) b[b.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return b;
}

/** Linear attack, optional hold, exponential decay. */
function envAD(len, attack, tau, hold = 0) {
  const b = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    b[i] = t < attack ? t / attack : t < attack + hold ? 1 : Math.exp(-(t - attack - hold) / tau);
  }
  return taperEnd(b);
}
/** Smooth rise to a peak at `peakAt` (fraction of the length), then exponential fall. */
function envSwell(len, peakAt, tauFall, riseShape = 2) {
  const b = new Float32Array(len);
  const pk = Math.max(1, Math.round(len * peakAt));
  for (let i = 0; i < len; i++) {
    b[i] = i < pk ? Math.pow(Math.sin((Math.PI / 2) * (i / pk)), riseShape) : Math.exp(-((i - pk) / SR) / tauFall);
  }
  return taperEnd(b);
}

const mul = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * (b[i] ?? 0); return o; };
const scale = (a, g) => a.map((x) => x * g);
function peakOf(a) { let p = 0; for (const x of a) { const v = Math.abs(x); if (v > p) p = v; } return p; }
/** Scaled to a peak of 1 — so components can be mixed in stated proportions. */
const norm = (a) => { const p = peakOf(a); return p > 0 ? scale(a, 1 / p) : a; };
/** Adds `src` into a buffer of length `len` at `offset` seconds, returning a new buffer. */
function place(len, parts) {
  const o = new Float32Array(len);
  for (const [src, offset = 0, gain = 1] of parts) {
    const at = N(offset);
    for (let i = 0; i < src.length && at + i < len; i++) o[at + i] += src[i] * gain;
  }
  return o;
}
const sum = (len, ...parts) => place(len, parts.map(([s, g]) => [s, 0, g]));

/** RBJ-cookbook biquad. `freq` may be a function of time for a moving filter. */
function biquad(x, type, freq, Q = 0.707) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const set = (f) => {
    f = Math.min(Math.max(f, 20), SR * 0.45);
    const w0 = (TAU * f) / SR, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * Q);
    let B0, B1, B2;
    if (type === 'lp') { B0 = (1 - c) / 2; B1 = 1 - c; B2 = (1 - c) / 2; }
    else if (type === 'hp') { B0 = (1 + c) / 2; B1 = -(1 + c); B2 = (1 + c) / 2; }
    else { B0 = al; B1 = 0; B2 = -al; } // band-pass, 0 dB peak
    const A0 = 1 + al;
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = (-2 * c) / A0; a2 = (1 - al) / A0;
  };
  const dynamic = typeof freq === 'function';
  if (!dynamic) set(freq);
  for (let i = 0; i < x.length; i++) {
    // Every sample, not every 16: stepping a moving filter's coefficients
    // makes zipper noise — small discontinuities, heard as grit on a sweep.
    if (dynamic) set(freq(i / SR));
    const v = x[i];
    const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    y[i] = o;
  }
  return y;
}
const lp = (x, f, Q) => biquad(x, 'lp', f, Q);
const hp = (x, f, Q) => biquad(x, 'hp', f, Q);
const bp = (x, f, Q) => biquad(x, 'bp', f, Q);

/** Soft saturation — adds harmonics so low sounds survive phone speakers. */
function sat(x, drive) {
  const d = Math.tanh(drive);
  return x.map((v) => Math.tanh(drive * v) / d);
}

/** Karplus-Strong plucked string, damped: a real string-like pluck in a few lines. */
function pluck(len, f, rnd, { brightness = 0.5, decay = 0.992 } = {}) {
  const L = Math.max(2, Math.round(SR / f));
  const line = new Float32Array(L);
  for (let i = 0; i < L; i++) line[i] = rnd() * 2 - 1;
  for (let i = 1; i < L; i++) line[i] = 0.5 * (line[i] + line[i - 1]); // soften the excitation
  // Remove the excitation's mean. A random burst is never exactly zero-mean,
  // and the string then carries that offset as DC for its whole (short) life
  // — too short for the mastering stage's 4 Hz DC filter to settle.
  let mean = 0;
  for (let i = 0; i < L; i++) mean += line[i];
  mean /= L;
  for (let i = 0; i < L; i++) line[i] -= mean;
  const o = new Float32Array(len);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = line[idx], b = line[(idx + 1) % L];
    o[i] = a;
    line[idx] = decay * ((1 - brightness) * a + brightness * b);
    idx = (idx + 1) % L;
  }
  return o;
}

/** A small Freeverb-style room: mono in, stereo WET out, `tail` seconds long. */
function reverb(x, { room = 0.78, damp = 0.35, tail = 0.8 } = {}) {
  const len = x.length + N(tail);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356];
  const aps = [556, 441, 341];
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0;
    const acc = new Float32Array(len);
    for (const d0 of combs) {
      const d = Math.round(((d0 + spread) * SR) / 44100);
      const buf = new Float32Array(d);
      let idx = 0, store = 0;
      for (let i = 0; i < len; i++) {
        const input = i < x.length ? x[i] * 0.015 : 0;
        const o = buf[idx];
        store = o * (1 - damp) + store * damp;
        buf[idx] = input + store * room;
        acc[i] += o;
        idx = (idx + 1) % d;
      }
    }
    let sig = acc;
    for (const d0 of aps) {
      const d = Math.round(((d0 + spread) * SR) / 44100);
      const buf = new Float32Array(d);
      let idx = 0;
      const o = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const bo = buf[idx];
        o[i] = -sig[i] + bo;
        buf[idx] = sig[i] + bo * 0.5;
        idx = (idx + 1) % d;
      }
      sig = o;
    }
    out.push(sig);
  }
  return out;
}
/** Dry mono plus a room, as a stereo pair. `wet` is relative to the dry peak. */
function withRoom(mono, opts) {
  const [wl, wr] = reverb(mono, opts);
  const g = (opts.wet ?? 0.2) * (peakOf(mono) / Math.max(peakOf(wl), 1e-9));
  const len = wl.length;
  const L = new Float32Array(len), R = new Float32Array(len);
  for (let i = 0; i < len; i++) { const d = i < mono.length ? mono[i] : 0; L[i] = d + wl[i] * g; R[i] = d + wr[i] * g; }
  return [L, R];
}
/** Equal-power pan of a mono signal along p(t) in [-1, 1]. */
function panned(mono, p) {
  const L = new Float32Array(mono.length), R = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const a = ((typeof p === 'function' ? p(i / SR) : p) + 1) * (Math.PI / 4);
    L[i] = mono[i] * Math.cos(a) * Math.SQRT2;
    R[i] = mono[i] * Math.sin(a) * Math.SQRT2;
  }
  return [L, R];
}
const reverse = (a) => a.slice().reverse();
function sampleHold(a, n) { const o = a.slice(); for (let i = 0; i < o.length; i++) o[i] = a[i - (i % n)]; return o; }
function crush(a, bits) { const q = Math.pow(2, bits - 1); return a.map((v) => Math.round(v * q) / q); }
function resample(a, rate) {
  const len = Math.floor(a.length / rate), o = new Float32Array(len);
  for (let i = 0; i < len; i++) { const p = i * rate, j = Math.floor(p), f = p - j; o[i] = (a[j] ?? 0) * (1 - f) + (a[j + 1] ?? 0) * f; }
  return o;
}
function fadeEdges(a, inMs, outMs) {
  const o = a.slice(), ni = Math.max(1, Math.round((inMs / 1000) * SR)), no = Math.max(1, Math.round((outMs / 1000) * SR));
  for (let i = 0; i < ni && i < o.length; i++) o[i] *= i / ni;
  for (let i = 0; i < no && i < o.length; i++) o[o.length - 1 - i] *= i / no;
  return o;
}

export {
  N, mulberry32, seedFor, white, pink, osc, glide, sweep, span, taperEnd, envAD, envSwell,
  mul, scale, peakOf, norm, place, sum, biquad, lp, hp, bp, sat, pluck, reverb, withRoom,
  panned, reverse, sampleHold, crush, resample, fadeEdges
};
