/**
 * MOTION, TRANSITIONS, RISE & AIR — things moving, and the space between
 * moments.
 *
 * Nearly everything here is noise in a moving band (see instruments.js's
 * whooshCore): the ear reads a band of noise whose centre sweeps while its
 * level swells and falls as something travelling past. What separates a swipe
 * from a whoosh from a zoom is the band's speed, direction, width and what, if
 * anything, lands at the end.
 *
 * Two shapes, used deliberately:
 *   - movement PEAKS IN THE MIDDLE (it comes, it passes);
 *   - a riser PEAKS AT ITS END and stops there, because it leads INTO the
 *     moment it is placed before. Its last 10-15 ms is a fade, not a cut.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, sum,
  lp, hp, bp, sat, peakOf, withRoom, reverb, panned, reverse, sampleHold, crush, fadeEdges
} from '../dsp.js';
import { whooshCore, transient, harmonicBody } from '../instruments.js';
import { click, modal, tones, hz, layer, layerStereo } from '../engines.js';
import { hit } from './cinematic.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });

/** Two decorrelated renders of `one`, partly correlated so they hold up in mono. */
function wide(one, k = 0.35) {
  const a = one(), b = one();
  return [a.map((v, i) => v * (1 - k) + b[i] * k), b.map((v, i) => v * (1 - k) + a[i] * k)];
}
const both = (pair, f) => pair.map(f);
/** A level that grows to 1 at the END — the shape of every riser. */
const grow = (L, p) => new Float32Array(L).map((_, i) => Math.pow(i / L, p));
/** End a riser on its peak without a click: a short fade, then silence. */
const landEnd = (pair, ms = 12) => both(pair, (c) => fadeEdges(c, 0, ms));
const room = (pair, wet = 0.2, size = 0.8, tail = 0.5) => {
  const [l, r] = pair;
  const [wl] = reverb(l, { room: size, damp: 0.4, tail }), [, wr] = reverb(r, { room: size, damp: 0.4, tail });
  const g = wet * (peakOf(l) / Math.max(1e-9, peakOf(wl)));
  const L = wl.length;
  return [new Float32Array(L).map((_, i) => (l[i] ?? 0) + wl[i] * g), new Float32Array(L).map((_, i) => (r[i] ?? 0) + wr[i] * g)];
};

/** A reversed cymbal: bright noise and inharmonic metal partials, decaying, played backwards. */
function reverseCymbal(r, dur = 1.1) {
  const L = N(dur);
  const one = () => {
    const nz = norm(hp(bp(white(L, r), 7000, 0.6), 3000));
    const metal = new Float32Array(L);
    [3150, 4210, 5380, 6600, 8120].forEach((f, k) => { const s = osc(L, f * (1 + 0.004 * (r() - 0.5)), { phase: r() * TAU }); for (let i = 0; i < L; i++) metal[i] += s[i] * (0.5 / (k + 1)); });
    // Decays to -50 dB inside the buffer, so the reversed START is silence, not a cut.
    return reverse(mul(sum(L, [nz, 1], [norm(metal), 0.35]), envAD(L, 0.001, dur / 5.9)));
  };
  return wide(one, 0.3);
}

/** Band noise whose samples are held and quantised — crushed FIRST, enveloped after (see tech.js). */
function digitalBand(r, L, f0, f1, dur, hold = 5, bits = 5) {
  return crush(sampleHold(norm(bp(pink(L, r), sweep(f0, f1, dur), 1)), hold), bits);
}

export const SOUNDS = [
  // ---- WHOOSH -----------------------------------------------------------------
  S('whoosh-tiny', 'Tiny Whoosh', 'whoosh', 'micro', ['whoosh', 'tiny', 'text-move', 'word'], 'a very short airy whoosh; one word sliding in, safe on consecutive words',
    (r) => whooshCore(r, { len: 0.12, f0: 1500, f1: 5000, Q: 1, peakAt: 0.5, tauFall: 0.02, pan0: -0.2, pan1: 0.2, highpass: 800 }), { gain: -1 }),
  S('whoosh-fast', 'Fast Whoosh', 'whoosh', 'medium', ['whoosh', 'fast', 'cut', 'swipe'], 'a quick bright whoosh; a fast cut or a swipe between shots',
    (r) => whooshCore(r, { len: 0.18, f0: 800, f1: 5000, Q: 1.2, peakAt: 0.5, tauFall: 0.025, pan0: -0.6, pan1: 0.6 })),
  S('whoosh-long', 'Long Whoosh', 'whoosh', 'medium', ['whoosh', 'long', 'transition', 'scene'], 'a long even whoosh; a slow move or a scene change with time to breathe',
    (r) => whooshCore(r, { len: 1.1, f0: 300, f1: 2500, Q: 0.8, peakAt: 0.6, tauFall: 0.15, pan0: -0.7, pan1: 0.7 })),
  S('whoosh-airy', 'Airy Whoosh', 'whoosh', 'subtle', ['whoosh', 'airy', 'light', 'subtle'], 'a thin high breath of air moving; lighter than Soft Whoosh, sits over speech',
    (r) => whooshCore(r, { len: 0.6, f0: 2500, f1: 7000, Q: 0.5, peakAt: 0.5, tauFall: 0.1, pan0: -0.4, pan1: 0.4, highpass: 2500 }), { gain: -1 }),
  S('whoosh-digital', 'Digital Whoosh', 'whoosh', 'medium', ['whoosh', 'digital', 'tech', 'transition'], 'a whoosh made of crushed digital noise; a tech or UI transition',
    (r) => {
      const len = 0.32, L = N(len + 0.06);
      const env = envSwell(L, 0.5, 0.035);
      return panned(mul(digitalBand(r, L, 700, 5000, len), env), (t) => -0.6 + (1.2 * t) / len);
    }),
  S('whoosh-reverse', 'Reverse Whoosh', 'whoosh', 'medium', ['whoosh', 'reverse', 'suck-in', 'before-cut'], 'a whoosh played backwards that sucks in to a stop; lands exactly on a cut',
    (r) => {
      const [l, rr] = whooshCore(r, { len: 0.45, f0: 3500, f1: 600, Q: 1, peakAt: 0.08, tauFall: 0.07, pan0: 0.5, pan1: -0.5 });
      return [reverse(l), reverse(rr)];
    }),
  S('whoosh-passby', 'Pass-By', 'whoosh', 'strong', ['whoosh', 'doppler', 'pass-by', 'fast'], 'something flying past left to right with a doppler pitch drop',
    (r) => {
      const len = 1.2, L = N(len), mid = 0.55;
      const x = (t) => (t - mid) / 0.11;
      const amp = new Float32Array(L).map((_, i) => Math.pow(1 / (1 + x(i / SR) ** 2), 1.5));
      // Doppler: higher approaching, lower receding, fastest change at the closest point.
      const tone = lp(osc(L, (t) => 480 * (1 - 0.06 * Math.tanh(x(t))), { shape: 'saw', harmonics: 14 }), 2600);
      const air = bp(pink(L, r), (t) => 1400 * (1 - 0.15 * Math.tanh(x(t))), 0.7);
      const mono = mul(sum(L, [norm(tone), 0.45], [norm(air), 1]), amp);
      return both(panned(mono, (t) => 0.85 * Math.tanh(x(t) / 1.5)), (c) => fadeEdges(c, 30, 30));
    }),
  S('whoosh-whip', 'Whip', 'whoosh', 'medium', ['whoosh', 'whip', 'snap', 'fast'], 'a whip-fast rising swish with a crack at the end; a whip pan',
    (r) => {
      const len = 0.09, L = N(span(0.001, 0.03) + len);
      const env = envSwell(L, len / (L / SR), 0.02, 3);
      const sw = mul(norm(bp(pink(L, r), sweep(300, 7000, len), 1.6)), env);
      const crack = scale(transient(L, r, 3500, 0.004, 1.2), 0.5);
      const mono = sum(L, [sw, 1], [new Float32Array(L).map((_, i) => (i >= N(len) ? crack[i - N(len)] : 0)), 1]);
      return panned(mono, (t) => -0.7 + 1.4 * Math.min(1, t / len));
    }),
  S('whoosh-double', 'Double Swish', 'whoosh', 'medium', ['whoosh', 'double', 'swish', 'back-and-forth'], 'two quick swishes, there and back; a flick or a two-part move',
    (r) => layerStereo([
      [whooshCore(r, { len: 0.16, f0: 900, f1: 3800, Q: 1.1, peakAt: 0.5, tauFall: 0.025, pan0: -0.5, pan1: 0.3 }), 0, 1],
      [whooshCore(r, { len: 0.16, f0: 1100, f1: 4400, Q: 1.1, peakAt: 0.5, tauFall: 0.025, pan0: 0.5, pan1: -0.3 }), 0.14, 0.85]
    ])),
  S('whoosh-spin', 'Spin', 'whoosh', 'medium', ['whoosh', 'spin', 'rotate', 'swirl'], 'a whoosh that swirls round, speeding up; something spinning or rotating in',
    (r) => {
      const len = 0.7, L = N(len);
      let ph = 0;
      const am = new Float32Array(L), pan = new Float32Array(L);
      for (let i = 0; i < L; i++) { am[i] = 0.55 + 0.45 * Math.cos(ph); pan[i] = 0.6 * Math.sin(ph); ph += (TAU * (6 + 14 * (i / L))) / SR; }
      const mono = mul(mul(norm(bp(pink(L, r), sweep(700, 2600, len), 1)), am), envSwell(L, 0.6, 0.06));
      return panned(mono, (t) => pan[Math.min(L - 1, Math.floor(t * SR))]);
    }),
  S('whoosh-sweep-down', 'Sweep Down', 'whoosh', 'medium', ['sweep', 'down', 'filter', 'outro'], 'a filter sweep falling from bright to dark; closing a section, winding down',
    (r) => {
      const len = 0.75, L = N(len);
      const env = envSwell(L, 0.12, 0.22);
      return wide(() => mul(norm(lp(white(L, r), sweep(9000, 300, len), 1.4)), env));
    }, { gain: -1 }),

  // ---- MOTION -----------------------------------------------------------------
  S('motion-swipe-fast', 'Fast Swipe', 'motion', 'micro', ['swipe', 'fast', 'word', 'text-move'], 'a tiny quick swipe; a word flicking in, repeatable word after word',
    (r) => {
      const L = N(0.08);
      const s = mul(norm(hp(bp(pink(L, r), sweep(3000, 6000, 0.08), 1.2), 1200)), envSwell(L, 0.4, 0.012));
      return panned(s, (t) => 0.3 - t * 6);
    }),
  S('motion-swipe-soft', 'Soft Swipe', 'motion', 'subtle', ['swipe', 'soft', 'card', 'slide'], 'a soft swipe of a finger or a card; a panel or element sliding over',
    (r) => {
      const L = N(0.18);
      const s = mul(norm(hp(bp(pink(L, r), sweep(4000, 2000, 0.18), 1.5), 1200)), envSwell(L, 0.35, 0.03));
      return panned(s, (t) => 0.3 - t * 3.3);
    }),
  S('motion-slide-in', 'Slide In', 'motion', 'subtle', ['slide', 'in', 'land', 'text-move'], 'a slide that settles with a soft stop; text or a card sliding into place',
    (r) => {
      const [l, rr] = whooshCore(r, { len: 0.28, f0: 700, f1: 2000, Q: 1.3, peakAt: 0.8, tauFall: 0.03, pan0: -0.6, pan1: 0 });
      const stop = modal(r, { material: 'hollowWood', f: 320, decay: 0.8, strike: 0.25, strikeCentre: 2500 });
      return layerStereo([[[l, rr], 0, 1], [stop, 0.215, 0.45]]);
    }),
  S('motion-slide-out', 'Slide Out', 'motion', 'subtle', ['slide', 'out', 'exit', 'text-move'], 'a slide falling away and fading; text or a card leaving',
    (r) => whooshCore(r, { len: 0.34, f0: 2000, f1: 700, Q: 1.3, peakAt: 0.2, tauFall: 0.08, pan0: 0, pan1: 0.6 })),
  S('motion-snap-in', 'Snap In', 'motion', 'medium', ['snap', 'in', 'lock', 'place'], 'a fast swish that snaps into place with a click; an element locking into position',
    (r) => {
      const [l, rr] = whooshCore(r, { len: 0.08, f0: 1500, f1: 5000, Q: 1.2, peakAt: 0.85, tauFall: 0.01, pan0: -0.4, pan1: 0 });
      const snap = click(r, { centre: 2600, Q: 2.5, tau: 0.003, bodyF: 420, bodyMix: 0.5, bodyTau: 0.01 });
      return layerStereo([[[l, rr], 0, 0.7], [snap, 0.068, 1]]);
    }),
  S('motion-drag', 'Drag', 'motion', 'subtle', ['drag', 'scrape', 'move', 'object'], 'an object dragged a short way across a surface; a slow, gritty move',
    (r) => {
      const len = 0.5, L = N(len + 0.02);
      const env = envSwell(L, 0.35, 0.06, 1.5);
      const grit = norm(bp(pink(L, r), 650, 0.9));
      const judder = lp(white(L, r), 25).map((v) => 0.7 + 3 * v);
      return wide(() => mul(mul(grit, judder), env), 0.6);
    }, { literal: true }),
  S('motion-zoom-in', 'Zoom In', 'motion', 'medium', ['zoom', 'in', 'push', 'focus'], 'a rising whoosh with a rising tone; a push-in or zoom on a detail',
    (r) => {
      const len = 0.4, L = N(len + 0.05);
      const env = envSwell(L, 0.8, 0.02);
      const tone = scale(norm(mul(osc(L, sweep(260, 1040, len)), env)), 0.3);
      const nz = norm(mul(bp(pink(L, r), sweep(400, 3500, len), 1), env));
      return panned(sum(L, [nz, 1], [tone, 1]), 0);
    }),
  S('motion-zoom-out', 'Zoom Out', 'motion', 'medium', ['zoom', 'out', 'pull', 'wide'], 'a falling whoosh with a falling tone; a pull-back to the wide shot',
    (r) => {
      const len = 0.45, L = N(len + 0.2);
      const env = envSwell(L, 0.08, 0.12);
      const tone = scale(norm(mul(osc(L, sweep(1040, 260, len)), env)), 0.3);
      const nz = norm(mul(bp(pink(L, r), sweep(3500, 400, len), 1), env));
      return panned(sum(L, [nz, 1], [tone, 1]), 0);
    }),
  S('motion-flip', 'Flip', 'motion', 'subtle', ['flip', 'card', 'turn', 'page'], 'two quick flaps; a card or a panel flipping over',
    (r) => {
      const flap = (c, tau) => { const L = N(span(0.001, tau)); return mul(norm(bp(white(L, r), c, 1.4)), envAD(L, 0.001, tau)); };
      return [layer([[flap(1400, 0.012), 0, 1], [flap(900, 0.02), 0.002, 0.5], [flap(2100, 0.01), 0.045, 0.8]])];
    }),
  S('motion-bounce', 'Bounce', 'motion', 'medium', ['bounce', 'ball', 'playful', 'settle'], 'a rubber ball bouncing to rest, the bounces closing up; playful settling',
    (r) => {
      const at = [0, 0.22, 0.38, 0.5, 0.59, 0.655, 0.705, 0.74];
      return [layer(at.map((t, k) => [modal(r, { material: 'plastic', f: 240 + 6 * k, decay: 2.2, strike: 0.4, strikeCentre: 1800 }), t, Math.pow(0.72, k)]))];
    }),

  // ---- TRANSITION -------------------------------------------------------------
  S('transition-land', 'Whoosh & Land', 'transition', 'medium', ['transition', 'land', 'whoosh', 'hit'], 'a whoosh that lands on a soft hit; a new section arriving',
    (r) => layerStereo([
      [whooshCore(r, { len: 0.35, f0: 400, f1: 2600, Q: 1, peakAt: 0.8, tauFall: 0.04, pan0: -0.6, pan1: 0.1 }), 0, 0.8],
      [hit(r, { f0: 140, f1: 60, tauA: 0.1, tr: { centre: 1600, gain: 0.3 }, drive: 1.6 }), 0.275, 1]
    ])),
  S('transition-impact', 'Whoosh Impact', 'transition', 'strong', ['transition', 'impact', 'hard', 'hit'], 'a fast whoosh straight into a hard hit; a punchy hard cut',
    (r) => room(layerStereo([
      [whooshCore(r, { len: 0.2, f0: 700, f1: 5000, Q: 1.1, peakAt: 0.85, tauFall: 0.02, pan0: -0.7, pan1: 0 }), 0, 0.8],
      [hit(r, { f0: 170, f1: 60, tauF: 0.015, tr: { centre: 3000, gain: 0.9 }, knock: { freq: 460, gain: 0.9 }, drive: 3 }), 0.17, 1]
    ]), 0.18, 0.75, 0.35)),
  S('transition-cinematic', 'Cinematic Transition', 'transition', 'cinematic', ['transition', 'cinematic', 'boom', 'trailer'], 'a long deep whoosh into a low boom and a room; a trailer-style section change',
    (r) => room(layerStereo([
      [whooshCore(r, { len: 1.0, f0: 200, f1: 1600, Q: 0.9, peakAt: 0.7, tauFall: 0.15, pan0: -0.7, pan1: 0.7 }), 0, 0.8],
      [hit(r, { f0: 95, f1: 42, tauF: 0.04, tauA: 0.3, len: 1.0, tr: { centre: 1400, gain: 0.4 }, nz: { cutoff: 500, tau: 0.12, gain: 0.45 }, knock: { freq: 300, tau: 0.03 }, drive: 2.4 }), 0.68, 1]
    ]), 0.28, 0.85, 0.8)),
  S('transition-digital', 'Digital Transition', 'transition', 'medium', ['transition', 'digital', 'tech', 'ui'], 'a crushed digital sweep that resolves on a two-note blip; a tech scene change',
    (r) => {
      const len = 0.3, L = N(len + 0.05);
      const sweepPart = panned(mul(digitalBand(r, L, 500, 4500, len), envSwell(L, 0.85, 0.02)), (t) => -0.5 + t / len);
      const blips = tones(r, [[1320, 0, 0.02], [1760, 0.05, 0.03]], { timbre: 'pulse', tau: 0.03 });
      return layerStereo([[sweepPart, 0, 0.8], [blips, 0.26, 0.7]]);
    }),
  S('transition-glitch', 'Glitch Transition', 'transition', 'medium', ['transition', 'glitch', 'cut', 'broken'], 'a short burst of broken digital slices; a glitchy jump cut',
    (r) => {
      const parts = [];
      let t = 0;
      while (t < 0.42) {
        const d = 0.012 + r() * 0.03, L = N(d);
        const src = r() < 0.5 ? norm(bp(white(L, r), 800 + r() * 5000, 1.2)) : osc(L, 200 + r() * 1800, { shape: 'square', harmonics: 12 });
        // Crushed first, then a 1.5 ms edge — the slices are hard but never truncated.
        const seg = mul(crush(src, 3 + Math.floor(r() * 4)), envAD(L, 0.0015, 1e9));
        const edge = fadeEdges(seg, 0, 1.5);
        parts.push([panned(edge, r() * 1.6 - 0.8), t, 0.5 + r() * 0.5]);
        t += d + (r() < 0.3 ? r() * 0.02 : 0);
      }
      return layerStereo(parts);
    }),
  S('transition-reverse', 'Reverse Into Hit', 'transition', 'strong', ['transition', 'reverse', 'cymbal', 'hit'], 'a reversed cymbal sucking in to a hit; the classic build-and-land',
    (r) => layerStereo([[reverseCymbal(r, 0.8), 0, 0.7], [hit(r, { f0: 150, f1: 58, tr: { centre: 2600, gain: 0.7 }, drive: 2.4 }), 0.8, 1]])),
  S('transition-zoom', 'Zoom Transition', 'transition', 'medium', ['transition', 'zoom', 'push', 'snap'], 'a zoom-in whoosh that snaps shut; a punch-in to the next shot',
    (r) => {
      const len = 0.3, L = N(len + 0.02);
      const env = envSwell(L, 0.92, 0.008);
      const tone = scale(norm(mul(osc(L, sweep(300, 1400, len)), env)), 0.35);
      const nz = norm(mul(bp(pink(L, r), sweep(500, 4500, len), 1), env));
      const snap = click(r, { centre: 3000, Q: 2, tau: 0.003, bodyF: 500, bodyMix: 0.6 });
      return layerStereo([[sum(L, [nz, 1], [tone, 1]), 0, 0.8], [snap, 0.285, 1]]);
    }),
  S('transition-whip', 'Whip Transition', 'transition', 'medium', ['transition', 'whip-pan', 'fast', 'snap'], 'a whip pan: a violent swish across the image into a thud',
    (r) => layerStereo([
      [whooshCore(r, { len: 0.14, f0: 400, f1: 6000, Q: 1.4, peakAt: 0.7, tauFall: 0.02, pan0: -0.9, pan1: 0.9 }), 0, 1],
      [modal(r, { material: 'hollowWood', f: 180, decay: 1.2, strike: 0.5, strikeCentre: 2000 }), 0.1, 0.6]
    ])),
  S('transition-bright', 'Bright Transition', 'transition', 'medium', ['transition', 'bright', 'positive', 'reveal'], 'an upward sweep that opens onto a bell ping; an upbeat new section',
    (r) => {
      const len = 0.36, L = N(len);
      const up = landEnd(wide(() => mul(norm(hp(bp(pink(L, r), sweep(800, 7000, len), 0.9), 500)), grow(L, 2.5))), 6);
      const ping = tones(r, [[hz('E6'), 0, 0], [hz('B6'), 0, 0, 0.6]], { timbre: 'bell', tau: 0.35, echo: 0.3, echoDelay: 0.09 });
      return layerStereo([[up, 0, 0.7], [ping, len - 0.004, 0.9]]);
    }),
  S('transition-soft', 'Soft Transition', 'transition', 'subtle', ['transition', 'soft', 'gentle', 'calm'], 'an airy whoosh resolving on a soft note; a calm change of topic',
    (r) => room(layerStereo([
      [whooshCore(r, { len: 0.5, f0: 1200, f1: 4000, Q: 0.7, peakAt: 0.55, tauFall: 0.08, pan0: -0.4, pan1: 0.4, highpass: 900 }), 0, 0.8],
      [tones(r, [[hz('G5'), 0, 0], [hz('D6'), 0.002, 0, 0.4]], { timbre: 'soft', tau: 0.14 }), 0.26, 0.55]
    ]), 0.25, 0.8, 0.5), { gain: -1.5 }),

  // ---- RISE -------------------------------------------------------------------
  S('rise-short', 'Short Riser', 'rise', 'medium', ['riser', 'short', 'before-reveal', 'lift'], 'a quick quarter-second lift that peaks at its end; right before a word lands',
    (r) => {
      const len = 0.28, L = N(len);
      const tone = scale(norm(mul(osc(L, sweep(600, 2400, len)), grow(L, 2))), 0.3);
      return landEnd(wide(() => sum(L, [mul(norm(hp(pink(L, r), sweep(500, 7000, len), 0.7)), grow(L, 3)), 1], [tone, 1])), 8);
    }),
  S('rise-cinematic', 'Cinematic Riser', 'rise', 'cinematic', ['riser', 'cinematic', 'build', 'trailer'], 'a long trailer build: a chord opening up, noise rising, tremolo speeding up; before a big reveal',
    (r) => {
      const len = 1.8, L = N(len);
      let ph = 0;
      const trem = new Float32Array(L);
      for (let i = 0; i < L; i++) { trem[i] = 0.6 + 0.4 * Math.sin(ph); ph += (TAU * (4 + 12 * Math.pow(i / L, 1.5))) / SR; }
      const chord = new Float32Array(L);
      [hz('A2'), hz('E3'), hz('A3'), hz('C#4')].forEach((f) => [-0.004, 0, 0.004].forEach((d) => {
        const s = osc(L, (t) => f * (1 + d) * Math.pow(2, (1.5 * t) / len / 12), { shape: 'saw', harmonics: 30 });
        for (let i = 0; i < L; i++) chord[i] += s[i];
      }));
      const pad = mul(mul(norm(lp(chord, sweep(300, 5000, len), 1.2)), trem), grow(L, 1.8));
      return landEnd(wide(() => sum(L, [pad, 0.8], [mul(norm(bp(pink(L, r), sweep(300, 6000, len), 0.8)), grow(L, 2.5)), 0.7]), 0.3), 15);
    }),
  S('rise-digital', 'Digital Riser', 'rise', 'medium', ['riser', 'digital', 'arpeggio', 'tech'], 'a rising run of digital blips, accelerating; a tech build or countdown',
    (r) => {
      const n = 14, notes = [];
      for (let k = 0; k < n; k++) notes.push([hz('C5') * Math.pow(2, (2 * k) / 12), 0.9 * (1 - Math.pow(1 - k / n, 1.6)), 0.012, 0.35 + 0.65 * (k / (n - 1))]);
      return [tones(r, notes, { timbre: 'pulse', tau: 0.02 })];
    }),
  S('rise-tension', 'Tension Riser', 'rise', 'strong', ['riser', 'tension', 'suspense', 'dark'], 'a dissonant cluster creeping upward with a trembling edge; suspense before a reveal',
    (r) => {
      const len = 1.5, L = N(len);
      const cl = new Float32Array(L);
      [hz('A3'), hz('A#3'), hz('B3'), hz('A2')].forEach((f) => {
        const s = osc(L, (t) => f * Math.pow(2, (2 * t) / len / 12), { shape: 'saw', harmonics: 24 });
        for (let i = 0; i < L; i++) cl[i] += s[i];
      });
      const trem = new Float32Array(L).map((_, i) => 0.7 + 0.3 * Math.sin((TAU * 7 * i) / SR));
      return landEnd(wide(() => mul(mul(norm(lp(cl, sweep(900, 3200, len))), trem), grow(L, 1.6)).map((v, i, a) => v + 0.05 * (r() - 0.5) * (i / L)), 0.15), 15);
    }),
  S('rise-tonal', 'Tonal Riser', 'rise', 'medium', ['riser', 'tonal', 'sweep', 'lift'], 'a clean pitched sweep rising two octaves with growing vibrato; a musical lift',
    (r) => {
      const len = 0.9, L = N(len);
      const f = (t) => 220 * Math.pow(4, t / len) * (1 + 0.012 * (t / len) * Math.sin(TAU * 6 * t));
      const s = sum(L, [osc(L, f), 1], [osc(L, (t) => 2 * f(t)), 0.35], [osc(L, (t) => 3 * f(t)), 0.15]);
      return landEnd(panned(mul(norm(s), grow(L, 2)), 0), 12);
    }),
  S('rise-reverse-hit', 'Reverse Hit', 'rise', 'strong', ['reverse', 'hit', 'suck-in', 'before-cut'], 'an impact and its room played backwards; a swell that slams shut on the cut',
    (r) => {
      const h = hit(r, { f0: 140, f1: 55, tauA: 0.16, len: 0.5, tr: { centre: 2200, gain: 0.6 }, drive: 2.2 });
      const [wl, wr] = withRoom(norm(h), { room: 0.86, damp: 0.35, wet: 0.5, tail: 0.9 });
      const keep = N(0.85);
      return [wl, wr].map((c) => fadeEdges(reverse(c).slice(Math.max(0, c.length - keep)), 0, 4));
    }),
  S('rise-reverse-cymbal', 'Reverse Cymbal', 'rise', 'strong', ['reverse', 'cymbal', 'swell', 'build'], 'a bright reversed cymbal swelling to a stop; the textbook lead-in to a hit',
    (r) => landEnd(reverseCymbal(r, 1.2), 5), { gain: -1 }),
  S('rise-reverse-shimmer', 'Reverse Shimmer', 'rise', 'medium', ['reverse', 'shimmer', 'magic', 'reveal'], 'sparkling bells played backwards, gathering to a point; a magical reveal lead-in',
    (r) => {
      const bells = tones(r, [[hz('E6'), 0, 0], [hz('G#6'), 0.01, 0], [hz('B6'), 0.02, 0], [hz('E7'), 0.03, 0, 0.6]], { timbre: 'bell', tau: 0.4 });
      const [wl, wr] = withRoom(norm(bells), { room: 0.9, damp: 0.25, wet: 0.7, tail: 1.2 });
      const keep = N(1.0);
      return [wl, wr].map((c) => fadeEdges(reverse(c).slice(Math.max(0, c.length - keep)), 0, 4));
    }),
  S('rise-pulse', 'Anticipation Pulse', 'rise', 'medium', ['anticipation', 'pulse', 'build', 'countdown'], 'low pulses speeding up and rising; the beat before something happens',
    (r) => {
      const parts = [];
      let t = 0, k = 0;
      while (t < 1.2) {
        const rate = 3 + 11 * Math.pow(t / 1.2, 1.4);
        const f = 90 * Math.pow(2, (4 * t) / 1.2 / 12);
        const L = N(span(0.002, 0.05));
        const body = norm(harmonicBody(L, () => f, 0.002, 0.05, [0.7, 0.6, 0.45, 0.3, 0.2]));
        // A mid knock with each pulse, so a phone speaker hears the beat too.
        const knock = norm(bp(mul(white(L, r), envAD(L, 0.0005, 0.015)), 380, 1.3));
        parts.push([sum(L, [body, 1], [knock, 0.45]), t, 0.45 + 0.55 * (t / 1.2)]);
        t += 1 / rate; k++;
      }
      return [layer(parts)];
    }),
  S('rise-sweep', 'Noise Sweep Up', 'rise', 'medium', ['sweep', 'up', 'filter', 'build'], 'white noise opening from dark to bright; the EDM-style build into a drop',
    (r) => {
      const len = 0.9, L = N(len);
      return landEnd(wide(() => mul(norm(hp(white(L, r), sweep(150, 6000, len), 1.3)), grow(L, 1.5))), 10);
    }, { gain: -1 }),

  // ---- AIR --------------------------------------------------------------------
  S('air-breath', 'Breath of Air', 'air', 'subtle', ['air', 'breath', 'soft', 'space'], 'a soft breath of air swelling and fading; space under a pause',
    (r) => { const L = N(0.9); return wide(() => mul(norm(bp(pink(L, r), 1200, 0.7)), envSwell(L, 0.45, 0.15))); }),
  S('air-gust', 'Gust', 'air', 'subtle', ['air', 'wind', 'gust', 'outdoor'], 'a short gust of wind that wavers and passes',
    (r) => {
      const L = N(1.4);
      const env = envSwell(L, 0.4, 0.25, 1.5);
      const waver = lp(white(L, r), 6).map((v) => 0.7 + 8 * v);
      return wide(() => mul(mul(norm(bp(pink(L, r), (t) => 600 + 250 * Math.sin(TAU * 0.9 * t), 1.8)), waver), env), 0.5);
    }, { literal: true }),
  S('air-release', 'Air Release', 'air', 'medium', ['air', 'hiss', 'release', 'pressure'], 'a quick hiss of pressure released; a seal breaking, a pneumatic move',
    (r) => {
      const L = N(span(0.003, 0.12));
      return wide(() => mul(norm(sum(L, [hp(white(L, r), 3500), 1], [bp(white(L, r), 6000, 1.5), 0.5])), envAD(L, 0.003, 0.12)), 0.5);
    }),
  S('air-puff', 'Puff', 'air', 'micro', ['air', 'puff', 'tiny', 'word'], 'a tiny soft puff of air; the lightest touch on a word',
    (r) => { const L = N(span(0.004, 0.03)); return [mul(norm(bp(pink(L, r), 1100, 0.8)), envAD(L, 0.004, 0.03))]; }),
  S('air-hush', 'Hush', 'air', 'subtle', ['air', 'hush', 'high', 'reveal'], 'a high hush of air rising under a moment; the space before a reveal',
    (r) => { const L = N(1.6); return wide(() => mul(norm(hp(pink(L, r), 5000)), envSwell(L, 0.7, 0.3))); })
];
