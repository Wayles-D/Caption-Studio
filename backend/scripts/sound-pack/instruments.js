/**
 * Instruments: the reusable synthesis engines every pack sound is played on.
 * A variant is a different PARAMETER set on one of these, not a copied
 * recipe — which is what keeps a large pack coherent rather than a folder of
 * one-offs.
 *
 * The first block (bell … whooshCore) is moved verbatim from the original
 * generator; the pack's first 31 sounds depend on it byte-for-byte.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm,
  sum, lp, hp, bp, sat, panned
} from './dsp.js';

// ---- building blocks shared by several recipes --------------------------------

/** A struck bell: partials [ratio, amp, decayScale], each decaying on its own. */
function bell(len, f, partials, { attack = 0.003, tau = 0.16 } = {}) {
  len = Math.max(len, N(span(attack, tau)));
  const out = new Float32Array(len);
  for (const [ratio, amp, tScale] of partials) {
    const s = mul(osc(len, f * ratio), envAD(len, attack, tau * tScale));
    for (let i = 0; i < len; i++) out[i] += s[i] * amp;
  }
  return out;
}
/** A UI blip: a softened square that is on for `hold` and then decays in `tau`. */
function blip(f, hold, tau, harmonics = 3) {
  const len = N(span(0.001, tau, hold));
  return mul(osc(len, f, { shape: 'square', harmonics }), envAD(len, 0.001, tau, hold));
}
/** The pitched sine sweep every pop is built on, plus an optional tiny transient. */
function popBody(len, fn, attack, tau) {
  return mul(osc(len, fn), envAD(len, attack, tau));
}
function transient(len, rnd, centre, tau, Q = 1) {
  return norm(bp(mul(white(len, rnd), envAD(len, 0.0002, tau)), centre, Q));
}
/**
 * A pitch-dropping tone WITH its harmonic series, higher harmonics decaying
 * faster as they do in a real struck body.
 *
 * The harmonics are what make low sounds work on a PHONE. Measured through a
 * phone-speaker approximation, the first version of this pack's impacts lost
 * 15-18 dB — built on a bare 50-110 Hz sine, they were close to inaudible on
 * the device most short-form is watched on. A phone cannot play 50 Hz, but
 * given harmonics 3-8 the ear reconstructs the missing fundamental from them,
 * so the low note is still heard; the fundamental itself is still there for
 * headphones and speakers.
 */
function harmonicBody(L, fn, attack, tau, amps) {
  const body = new Float32Array(L);
  amps.forEach((amp, k) => {
    const h = mul(osc(L, (t) => fn(t) * (k + 1)), envAD(L, attack, tau / (1 + 0.5 * k)));
    for (let i = 0; i < L; i++) body[i] += h[i] * amp;
  });
  return body;
}

/**
 * A layered impact: a harmonic pitch-dropping body, a mid-range KNOCK (the
 * 250-450 Hz thud a small speaker actually reproduces — see harmonicBody), a
 * transient click and a thump of low noise. Weight without the broadband wash
 * that turns an impact into an explosion.
 */
function impactCore(rnd, { f0, f1, tauF, tauA, len, tr, nz, knock, drive }) {
  const L = N(Math.max(len, span(0.0015, tauA), span(0.001, nz.tau), span(0.0005, knock.tau)));
  const body = norm(harmonicBody(L, glide(f0, f1, tauF), 0.0015, tauA, [0.75, 0.7, 0.6, 0.5, 0.4, 0.3, 0.22]));
  const click = scale(transient(L, rnd, tr.centre, tr.tau, 0.9), tr.gain);
  const thump = scale(norm(lp(mul(white(L, rnd), envAD(L, 0.001, nz.tau)), nz.cutoff)), nz.gain);
  const knk = scale(norm(bp(mul(white(L, rnd), envAD(L, 0.0005, knock.tau)), knock.freq, 1.2)), knock.gain);
  return lp(sat(sum(L, [body, 1], [click, 1], [thump, 1], [knk, 1]), drive), 6000);
}
/** Filtered-noise movement, decorrelated per channel and panned across the image. */
function whooshCore(rnd, { len, f0, f1, Q, peakAt, tauFall, pan0, pan1, highpass }) {
  const peakSec = len * peakAt;
  len = Math.max(len, peakSec + tauFall * 5.76);
  const L = N(len);
  const env = envSwell(L, peakSec / len, tauFall);
  const centre = sweep(f0, f1, len);
  const one = () => {
    let n = bp(pink(L, rnd), centre, Q);
    if (highpass) n = hp(n, highpass);
    return mul(norm(n), env);
  };
  const a = one(), b = one();
  // Partly correlated, so it has width without falling apart in mono.
  const mono = a.map((v, i) => 0.6 * v + 0.4 * b[i]);
  const [pl, pr] = panned(mono, (t) => pan0 + (pan1 - pan0) * (t / len));
  const side = b.map((v, i) => 0.25 * (v - a[i]));
  return [pl.map((v, i) => v + side[i]), pr.map((v, i) => v - side[i])];
}

export { bell, blip, popBody, transient, harmonicBody, impactCore, whooshCore };
