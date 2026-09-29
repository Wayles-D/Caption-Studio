/**
 * The pack's first 31 sounds — the set that was generated, listened to and
 * approved before the library grew. Their recipes are moved here VERBATIM
 * from the original generator and are checked byte-for-byte against the
 * files they produced then (see the generator's --verify-core mode), so they
 * are preserved exactly rather than "improved" as a side effect of growth.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, place, sum,
  lp, hp, bp, sat, pluck, reverb, withRoom, panned, reverse, sampleHold, crush, resample, fadeEdges
} from '../dsp.js';
import { bell, blip, popBody, transient, harmonicBody, impactCore, whooshCore } from '../instruments.js';

export const CORE_RENDERERS = {
  // MICRO. Dry and tail-free, because a run puts four of these inside a
  // second. Mostly a resonant noise click — which reads as a TICK — with only
  // a hint of tone, which is what stops it being a beep.
  'micro-tick-soft': (r) => {
    const L = N(0.05);
    const click = norm(bp(mul(white(L, r), envAD(L, 0.0003, 0.0055)), 3200, 3.5));
    const tone = norm(mul(osc(L, 2600), envAD(L, 0.0004, 0.007)));
    return [lp(sum(L, [click, 1], [tone, 0.3]), 9000)];
  },
  // Higher and shorter: the same idea tuned to cut through music.
  'micro-tick-bright': (r) => {
    const L = N(0.035);
    const click = norm(bp(mul(white(L, r), envAD(L, 0.0002, 0.004)), 5600, 3));
    const tone = norm(mul(osc(L, 4400), envAD(L, 0.0003, 0.004)));
    return [hp(sum(L, [click, 1], [tone, 0.3]), 1500)];
  },
  // Woody rather than glassy: a low resonance and a small pitched body.
  'micro-tap': (r) => {
    const L = N(span(0.0006, 0.02));
    const knock = norm(bp(mul(white(L, r), envAD(L, 0.0003, 0.009)), 950, 1.6));
    const body = norm(popBody(L, glide(380, 295, 0.012), 0.0006, 0.02));
    return [lp(sum(L, [knock, 0.6], [body, 1]), 5500)];
  },
  // A real (Karplus-Strong) string, muted by a fast envelope: pitched, so a
  // run of words gets a little melody-free musical rhythm.
  'micro-pluck': (r) => {
    const L = N(span(0.0005, 0.045));
    const s = mul(pluck(L, 659.25, r, { brightness: 0.5, decay: 0.994 }), envAD(L, 0.0005, 0.045));
    return [lp(s, 4500)];
  },

  // POP. The sine sweep is what makes a pop; the variants differ in pitch,
  // speed and body, and one rises instead of falling so it has a different
  // character, not just a different pitch.
  'pop-soft': (r) => {
    const L = N(span(0.0008, 0.028));
    const body = norm(popBody(L, glide(950, 250, 0.012), 0.0008, 0.028));
    return [lp(sum(L, [body, 1], [transient(L, r, 2000, 0.0015), 0.12]), 7000)];
  },
  'pop-bright': (r) => {
    // Rises, like a bubble: a lighter, happier pop than the falling ones.
    const L = N(span(0.0006, 0.018));
    const body = norm(popBody(L, glide(700, 1500, 0.01), 0.0006, 0.018));
    return [hp(sum(L, [body, 1], [transient(L, r, 3800, 0.0012), 0.18]), 300)];
  },
  'pop-deep': (r) => {
    const L = N(span(0.001, 0.055));
    const body = norm(popBody(L, glide(480, 120, 0.02), 0.001, 0.055));
    return [lp(sat(sum(L, [body, 1], [transient(L, r, 1200, 0.002), 0.1]), 1.6), 3500)];
  },
  'pop-punch': (r) => {
    const L = N(span(0.0005, 0.03));
    const body = norm(popBody(L, glide(1400, 260, 0.012), 0.0005, 0.03));
    return [lp(sat(sum(L, [body, 1], [transient(L, r, 2600, 0.003, 1.2), 0.7]), 2.6), 8000)];
  },

  // DIGITAL. Band-limited squares softened to their first harmonics: clean,
  // synthetic, and never aliasing.
  'digital-blip': () => [lp(blip(1760, 0.022, 0.005, 5), 9000)],
  'digital-confirm': () => {
    const L = N(0.14);
    return [place(L, [[blip(1318.5, 0.03, 0.006), 0, 0.85], [blip(1975.5, 0.04, 0.008), 0.07, 1]])];
  },
  'digital-pulse': () => {
    const L = N(span(0.002, 0.05));
    const tone = lp(osc(L, 220, { shape: 'saw', harmonics: 16 }), glide(2800, 500, 0.04), 1.4);
    // Low-passed AFTER the saturation: tanh grows harmonics above the band it
    // was fed, and a low-mid pulse has no use for anything past 7 kHz.
    return [lp(sat(mul(norm(tone), envAD(L, 0.002, 0.05)), 1.3), 7000)];
  },
  'digital-data': (r) => {
    const L = N(0.2);
    const scaleHz = [1318.5, 1568, 1760, 1975.5, 2349.3, 2637];
    const parts = [];
    for (let k = 0; k < 7; k++) {
      parts.push([blip(scaleHz[Math.floor(r() * scaleHz.length)], 0.01, 0.004), k * 0.024, 1 - k * 0.06]);
    }
    return [place(L, parts)];
  },

  // CHIME. Partials above the fundamental decay faster than it does, which is
  // what a real struck bell does and what keeps these from sounding like an
  // organ. A small room rather than a hall, so they stay short.
  'chime-soft': () => {
    const b = bell(0, 1318.5, [[1, 1, 1], [2.0, 0.2, 0.5], [3.0, 0.07, 0.33], [4.16, 0.035, 0.22]], { attack: 0.004, tau: 0.12 });
    return withRoom(norm(b), { room: 0.7, damp: 0.4, wet: 0.12, tail: 0.3 });
  },
  'chime-duo': () => {
    const p = [[1, 1, 1], [2, 0.18, 0.5], [3, 0.06, 0.33]];
    const lo = bell(0, 880, p, { attack: 0.003, tau: 0.11 }), hi = bell(0, 1318.5, p, { attack: 0.003, tau: 0.11 });
    const two = place(N(0.085) + hi.length, [[lo, 0, 0.85], [hi, 0.085, 1]]);
    return withRoom(norm(two), { room: 0.74, damp: 0.4, wet: 0.15, tail: 0.35 });
  },
  // FM with a non-integer ratio (2.76) is what makes glass: inharmonic
  // partials. The ratio and index are chosen so the brightest sideband stays
  // under 18 kHz — past Nyquist it would fold back as noise.
  'chime-glass': () => {
    const L = N(span(0.002, 0.16));
    const fc = 1760, fm = fc * 2.76;
    const out = new Float32Array(L);
    let pc = 0, pm = 0;
    for (let i = 0; i < L; i++) {
      const t = i / SR;
      const index = 2.2 * Math.exp(-t / 0.05) + 0.35;
      out[i] = Math.sin(pc + index * Math.sin(pm));
      pc += (TAU * fc) / SR; pm += (TAU * fm) / SR;
    }
    const tone = mul(out, envAD(L, 0.002, 0.16));
    const sparkle = scale(norm(mul(osc(L, fc * 5.07), envAD(L, 0.001, 0.05))), 0.06);
    return withRoom(norm(sum(L, [tone, 1], [sparkle, 1])), { room: 0.8, damp: 0.35, wet: 0.22, tail: 0.4 });
  },

  // SHIMMER. Deliberately faint and scattered — its job is for a moment to
  // feel finished, not to be heard as a sound.
  'shimmer-soft': (r) => {
    const L = N(0.25 + span(0.003, 0.12));
    const partials = [];
    for (let k = 0; k < 11; k++) {
      const f = (6 + Math.floor(r() * 9)) * 587.33; // harmonics of D5, so the scatter stays consonant
      const G = N(span(0.003, 0.12));
      const s = scale(mul(osc(G, f), envAD(G, 0.003, 0.12)), 0.35 + 0.65 * r());
      partials.push([s, r() * 0.25, (r() * 1.6 - 0.8)]);
    }
    const L2 = new Float32Array(L), R2 = new Float32Array(L);
    for (const [s, at, p] of partials) {
      const [pl, pr] = panned(s, p);
      const o = N(at);
      for (let i = 0; i < s.length && o + i < L; i++) { L2[o + i] += pl[i]; R2[o + i] += pr[i]; }
    }
    const air = scale(norm(mul(hp(white(L, r), 6000), envSwell(L, 0.3, 0.2))), 0.15);
    const mono = norm(L2.map((v, i) => 0.5 * (v + R2[i]) + air[i]));
    const [wl, wr] = withRoom(mono, { room: 0.75, damp: 0.3, wet: 0.3, tail: 0.3 });
    // Keep the per-partial panning: add the stereo difference back over the room.
    return [wl.map((v, i) => v + 0.5 * ((L2[i] ?? 0) - (R2[i] ?? 0))), wr.map((v, i) => v - 0.5 * ((L2[i] ?? 0) - (R2[i] ?? 0)))];
  },
  // Detuned pairs beat against each other, which is the slow metallic
  // shimmer; each pair is split left/right so the beating moves in stereo.
  'shimmer-metal': () => {
    const L = N(0.04 + span(0, 0.2));
    const base = 1046.5;
    const ratios = [1, 2.32, 3.87, 5.43, 6.8], amps = [0.5, 1, 0.8, 0.6, 0.4], det = [3.5, 5.2, 2.8, 4.1, 6.0];
    const Lc = new Float32Array(L), Rc = new Float32Array(L);
    ratios.forEach((ratio, k) => {
      const env = mul(envSwell(L, 0.04 / (L / SR), 0.2 / (1 + 0.3 * k), 1), new Float32Array(L).fill(amps[k]));
      const a = mul(osc(L, base * ratio), env), b = mul(osc(L, base * ratio + det[k]), env);
      for (let i = 0; i < L; i++) { Lc[i] += a[i] * 0.8 + b[i] * 0.2; Rc[i] += b[i] * 0.8 + a[i] * 0.2; }
    });
    const [ll] = withRoom(norm(hp(Lc, 800)), { room: 0.78, damp: 0.35, wet: 0.25, tail: 0.3 });
    const [, rr] = withRoom(norm(hp(Rc, 800)), { room: 0.78, damp: 0.35, wet: 0.25, tail: 0.3 });
    return [ll, rr];
  },

  // GLITCH. Stutters, sample-rate reduction and bit-crushing, but low-passed
  // afterwards and quiet: a glitch, not a pain.
  'glitch-micro': (r) => {
    const g = N(0.014);
    const src = sum(g, [osc(g, (t) => 900 + 2070 * Math.sin(TAU * 2070 * t) * 0.3), 1], [white(g, r), 0.25]);
    const grain = fadeEdges(norm(src), 0.3, 0.3);
    const L = N(0.085);
    return [hp(lp(place(L, [
      [grain, 0, 0.9],
      [fadeEdges(sampleHold(grain, 4), 0.3, 0.3), 0.016, 0.8],
      [fadeEdges(resample(grain, 1.5), 0.3, 0.3), 0.032, 0.8],
      [fadeEdges(crush(sampleHold(grain, 8), 4), 0.3, 0.3), 0.058, 0.7]
    ]), 9000), 150)];
  },
  'glitch-burst': (r) => {
    const S = N(0.3);
    const src = sum(S, [osc(S, sweep(600, 1400, 0.3)), 1], [pink(S, r), 0.3], [osc(S, 2200, { shape: 'square', harmonics: 5 }), 0.2]);
    const L = N(0.24);
    const parts = [];
    let at = 0;
    const treatments = [(g) => g, (g) => sampleHold(g, 6), (g) => crush(g, 5), reverse, (g) => resample(g, 2)];
    while (at < 0.22) {
      const dur = 0.008 + r() * 0.012, from = Math.floor(r() * (S - N(dur)));
      let grain = src.slice(from, from + N(dur));
      grain = fadeEdges(treatments[Math.floor(r() * treatments.length)](grain), 0.3, 0.3);
      parts.push([grain, at, 0.5 + 0.5 * r()]);
      at += dur + r() * 0.004;
    }
    return [hp(lp(mul(place(L, parts), envAD(L, 0.0005, 0.12)), 10000), 120)];
  },

  // WHOOSH. A band of noise whose centre sweeps upward while its level swells
  // and falls, panned across the image — that combination is what the ear
  // reads as something moving past.
  'whoosh-short': (r) => whooshCore(r, { len: 0.3, f0: 500, f1: 3000, Q: 1.1, peakAt: 0.55, tauFall: 0.045, pan0: -0.5, pan1: 0.5 }),
  'whoosh-soft': (r) => whooshCore(r, { len: 0.52, f0: 1200, f1: 4200, Q: 0.7, peakAt: 0.5, tauFall: 0.09, pan0: -0.3, pan1: 0.3, highpass: 900 }),
  'whoosh-deep': (r) => {
    const [l, rr] = whooshCore(r, { len: 0.78, f0: 220, f1: 1300, Q: 0.9, peakAt: 0.6, tauFall: 0.12, pan0: -0.6, pan1: 0.6 });
    const L = l.length;
    const sub = scale(mul(osc(L, sweep(70, 48, 0.78)), envSwell(L, 0.6, 0.12)), 0.35);
    return [sat(l.map((v, i) => v + sub[i]), 1.2), sat(rr.map((v, i) => v + sub[i]), 1.2)];
  },

  // RISE. Peaks at its END, deliberately: a riser leads INTO a moment.
  'rise-micro': (r) => {
    const L = N(0.45), len = 0.45;
    const grow = new Float32Array(L).map((_, i) => Math.pow(i / L, 2.2));
    const one = () => mul(norm(hp(pink(L, r), sweep(300, 6000, len), 0.7)), grow);
    const tone = scale(norm(mul(osc(L, sweep(440, 1760, len)), new Float32Array(L).map((_, i) => Math.pow(i / L, 2)))), 0.35);
    const a = one(), b = one();
    return [fadeEdges(a.map((v, i) => v + tone[i]), 0, 6), fadeEdges(b.map((v, i) => v + tone[i]), 0, 6)];
  },
  // A struck bell drowned in a room, played BACKWARDS: the tail becomes a
  // swell that sucks in and stops dead where the strike was.
  'rise-reverse': (r) => {
    const L = N(0.3);
    let pc = 0, pm = 0;
    const hit = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const t = i / SR;
      hit[i] = Math.sin(pc + (1.8 * Math.exp(-t / 0.06) + 0.3) * Math.sin(pm)) * Math.exp(-t / 0.12);
      pc += (TAU * 1318.5) / SR; pm += (TAU * 1318.5 * 2.76) / SR;
    }
    const src = norm(sum(L, [hit, 1], [transient(L, r, 3000, 0.03), 0.3]));
    const [wl, wr] = reverb(src, { room: 0.86, damp: 0.3, tail: 1.0 });
    const keep = N(0.9);
    const tailOf = (w) => { const f = w.map((v, i) => v + (i < src.length ? src[i] * 0.02 : 0)); return reverse(f).slice(f.length - keep); };
    return [fadeEdges(tailOf(wl), 0, 4), fadeEdges(tailOf(wr), 0, 4)];
  },

  // DROP. Pure sub-bass is inaudible on a phone, so the drop is driven into
  // saturation: the harmonics it grows are what a phone speaker plays.
  'drop-sub': (r) => {
    const L = N(span(0.002, 0.2));
    const body = norm(harmonicBody(L, glide(160, 42, 0.07), 0.002, 0.2, [0.8, 0.7, 0.55, 0.45, 0.35, 0.28, 0.2, 0.15]));
    return [lp(sat(sum(L, [body, 1], [transient(L, r, 1500, 0.002), 0.4]), 3), 2800)];
  },
  'drop-digital': () => {
    const L = N(span(0.001, 0.09));
    const f = sweep(1200, 140, 0.3);
    const tone = lp(osc(L, f, { shape: 'saw', harmonics: 20 }), (t) => 6 * f(t), 0.9);
    return [hp(mul(norm(tone), envAD(L, 0.001, 0.09)), 60)];
  },

  // IMPACT. A pitch-dropping body, a transient and a thump of low noise —
  // weight without the broadband wash that makes something an explosion.
  'impact-soft': (r) => withRoom(norm(impactCore(r, {
    f0: 110, f1: 52, tauF: 0.03, tauA: 0.13, len: 0.4,
    tr: { centre: 1400, tau: 0.0025, gain: 0.3 }, nz: { cutoff: 600, tau: 0.05, gain: 0.3 },
    knock: { freq: 340, tau: 0.024, gain: 0.8 }, drive: 1.5
  })), { room: 0.72, damp: 0.5, wet: 0.1, tail: 0.2 }),
  'impact-punch': (r) => [impactCore(r, {
    f0: 150, f1: 60, tauF: 0.018, tauA: 0.08, len: 0.3,
    tr: { centre: 2200, tau: 0.003, gain: 0.6 }, nz: { cutoff: 900, tau: 0.03, gain: 0.35 },
    knock: { freq: 420, tau: 0.018, gain: 0.9 }, drive: 2.4
  })],
  'impact-deep': (r) => withRoom(norm(impactCore(r, {
    f0: 85, f1: 38, tauF: 0.05, tauA: 0.2, len: 0.8,
    tr: { centre: 900, tau: 0.004, gain: 0.35 }, nz: { cutoff: 500, tau: 0.1, gain: 0.35 },
    knock: { freq: 280, tau: 0.035, gain: 0.75 }, drive: 1.9
  })), { room: 0.8, damp: 0.45, wet: 0.15, tail: 0.3 }),

  // CINEMATIC. Occasional by design.
  //   Hit: a deep impact plus a struck-metal ring — nine inharmonic modes,
  //   lower ones ringing longest — in a larger room.
  'cinematic-hit': (r) => {
    const L = N(span(0.001, 0.32));
    const core = norm(impactCore(r, {
      f0: 85, f1: 36, tauF: 0.05, tauA: 0.22, len: 1.2,
      tr: { centre: 900, tau: 0.004, gain: 0.35 }, nz: { cutoff: 500, tau: 0.12, gain: 0.35 },
      knock: { freq: 300, tau: 0.035, gain: 0.75 }, drive: 1.7
    }));
    const modes = [182, 297, 419, 571, 783, 1037, 1379, 1811, 2403];
    const amps = [1, 0.8, 0.7, 0.55, 0.45, 0.35, 0.28, 0.2, 0.15];
    const taus = [0.32, 0.28, 0.24, 0.2, 0.17, 0.14, 0.12, 0.1, 0.08];
    const metal = new Float32Array(L);
    modes.forEach((f, k) => {
      const s = mul(osc(L, f, { phase: r() * TAU }), envAD(L, 0.001, taus[k]));
      for (let i = 0; i < L; i++) metal[i] += s[i] * amps[k];
    });
    const air = scale(norm(hp(mul(white(L, r), envAD(L, 0.0005, 0.02)), 2000)), 0.2);
    const mono = sat(sum(Math.max(L, core.length), [core, 1], [norm(metal), 0.5], [air, 1]), 1.3);
    return withRoom(norm(mono), { room: 0.86, damp: 0.3, wet: 0.35, tail: 0.6 });
  },
  //   Pulse: detuned low saws under a filter that opens and closes, with a
  //   sub underneath — dark and felt rather than heard.
  'cinematic-pulse': () => {
    const L = N(0.06 + span(0, 0.3));
    const open = envAD(L, 0.09, 0.35);
    const cutoff = (t) => 220 + 900 * open[Math.min(L - 1, Math.round(t * SR))];
    const chan = (detune) => {
      const tone = sum(L, [osc(L, 55, { shape: 'saw', harmonics: 40 }), 0.5], [osc(L, 55 + detune, { shape: 'saw', harmonics: 40 }), 0.5],
        [osc(L, 110 + detune, { shape: 'saw', harmonics: 30 }), 0.45]);
      return lp(tone, cutoff, 3);
    };
    const amp = envSwell(L, 0.06 / (L / SR), 0.3);
    const sub = scale(osc(L, 55), 0.22);
    const side = (x) => sat(mul(norm(sum(L, [x, 1], [sub, 1])), amp), 1.5);
    return [side(chan(0.4)), side(chan(-0.3))];
  }
};

const S = (id, label, family, tier, tags, use, extra = {}) => ({ id, label, family, tier, tags, use, render: CORE_RENDERERS[id], ...extra });

/** The approved 31, with the metadata they shipped with plus a tier. */
export const CORE_SOUNDS = [
  S('micro-tick-soft', 'Soft Tick', 'micro', 'micro', ['word', 'caption', 'list', 'text'], 'soft dry tick; the default sound under individual words and list markers'),
  S('micro-tick-bright', 'Bright Tick', 'micro', 'micro', ['word', 'caption', 'text'], 'brighter, higher tick that cuts through music or busy speech'),
  S('micro-tap', 'Soft Tap', 'micro', 'micro', ['word', 'caption', 'warm'], 'rounded woody tap; a warmer alternative to the tick for calm videos'),
  S('micro-pluck', 'Muted Pluck', 'micro', 'micro', ['word', 'caption', 'musical'], 'short muted string pluck; gives a run of words a musical, pitched rhythm'),
  S('pop-soft', 'Soft Pop', 'pop', 'micro', ['word', 'keyword', 'text-appear'], 'rounded soft pop; text or a keyword appearing on screen'),
  S('pop-bright', 'Bright Pop', 'pop', 'micro', ['word', 'keyword', 'snappy'], 'small snappy rising pop; quick text, fast cuts'),
  S('pop-deep', 'Deep Pop', 'pop', 'micro', ['keyword', 'emphasis', 'weight'], 'lower pop with body; a word that should land with weight'),
  S('pop-punch', 'Punchy Pop', 'pop', 'medium', ['keyword', 'emphasis', 'scale'], 'pop with a hard attack; keyword emphasis, text scaling up', { usage: 'word' }),
  S('digital-blip', 'Interface Blip', 'digital', 'micro', ['tech', 'ui', 'app', 'word'], 'clean interface blip; app, software and tech words'),
  S('digital-confirm', 'UI Confirm', 'digital', 'micro', ['tech', 'ui', 'success'], 'two rising blips; a confirmation, something completing or working'),
  S('digital-pulse', 'Digital Pulse', 'digital', 'medium', ['tech', 'product', 'reveal'], 'low-mid synthetic pulse; a product or feature being introduced'),
  S('digital-data', 'Data Burst', 'digital', 'medium', ['tech', 'ai', 'data'], 'rapid run of tiny blips; data, AI, something computing'),
  S('chime-soft', 'Soft Chime', 'chime', 'subtle', ['reveal', 'positive', 'name'], 'single soft bell; a product name, a gentle reveal', { usage: 'word' }),
  S('chime-duo', 'Two-Note Chime', 'chime', 'medium', ['reveal', 'success', 'positive'], 'elegant rising two-note chime; a success or a satisfying reveal'),
  S('chime-glass', 'Glass Chime', 'chime', 'medium', ['reveal', 'premium', 'payoff'], 'glassy bell with a shimmer; a premium reveal or a payoff'),
  S('shimmer-soft', 'Soft Sparkle', 'shimmer', 'subtle', ['polish', 'reveal', 'subtle'], 'faint scattered sparkle; makes a reveal feel finished, barely noticed'),
  S('shimmer-metal', 'Metallic Shimmer', 'shimmer', 'subtle', ['polish', 'premium', 'texture'], 'soft metallic shimmer; a premium, polished texture under a moment'),
  S('glitch-micro', 'Micro Glitch', 'glitch', 'medium', ['tech', 'glitch', 'cut'], 'tiny stuttered glitch; a jump cut, something digital breaking briefly'),
  S('glitch-burst', 'Glitch Burst', 'glitch', 'medium', ['tech', 'glitch', 'transition'], 'short granular glitch burst; a digital transition or a corrupted beat'),
  S('whoosh-short', 'Short Whoosh', 'whoosh', 'medium', ['transition', 'text-move', 'slide'], 'quick whoosh; text sliding in, a fast cut'),
  S('whoosh-soft', 'Soft Whoosh', 'whoosh', 'subtle', ['transition', 'airy', 'subtle'], 'airy soft whoosh; a gentle move or scene change'),
  S('whoosh-deep', 'Cinematic Whoosh', 'whoosh', 'strong', ['transition', 'cinematic', 'topic-change'], 'deep cinematic whoosh; a big transition between sections'),
  S('rise-micro', 'Micro Riser', 'rise', 'medium', ['anticipation', 'build', 'before-reveal'], 'short riser that peaks at its end; place just before a reveal'),
  S('rise-reverse', 'Reverse Swell', 'rise', 'medium', ['anticipation', 'swell', 'before-reveal'], 'reversed bell swell that sucks in to a cut; place just before a moment'),
  S('drop-sub', 'Sub Drop', 'drop', 'strong', ['punchline', 'beat', 'bass'], 'deep sub-bass drop; a punchline or a beat landing'),
  S('drop-digital', 'Digital Drop', 'drop', 'medium', ['punchline', 'tech', 'down'], 'downward synthetic sweep; something falling away, a tech punchline'),
  S('impact-soft', 'Soft Impact', 'impact', 'medium', ['statement', 'emphasis', 'subtle'], 'soft low thump; under a strong statement without drama'),
  S('impact-punch', 'Punch Impact', 'impact', 'strong', ['statement', 'emphasis', 'punch'], 'tight punchy hit; a claim that should land hard'),
  S('impact-deep', 'Deep Impact', 'impact', 'strong', ['statement', 'conclusion', 'weight'], 'deep heavy hit with a short tail; the biggest line in the video'),
  S('cinematic-hit', 'Cinematic Hit', 'cinematic', 'cinematic', ['cinematic', 'reveal', 'dramatic'], 'layered trailer-style hit with a metallic ring; a dramatic reveal, used rarely'),
  S('cinematic-pulse', 'Dark Pulse', 'cinematic', 'cinematic', ['cinematic', 'tension', 'dark'], 'dark low pulse; tension, a warning, a serious turn')
];
