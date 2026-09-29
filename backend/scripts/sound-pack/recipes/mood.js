/**
 * MOOD — shimmer, chime, tension and comedy: sounds that colour a moment
 * rather than mark it.
 *
 * Shimmer is the quietest family in the pack on purpose (see soundPack.js):
 * its job is sparkle over speech, never a note you notice. Tension leans on
 * the harmonic-body trick (instruments.js) so its low end survives a phone.
 * Comedy sounds are the one place where cartoonish is the point — each is
 * built to be recognised in a fraction of a second.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, sum,
  lp, hp, bp, sat, withRoom, panned, fadeEdges
} from '../dsp.js';
import { harmonicBody, transient } from '../instruments.js';
import { click, modal, tones, hz, layer, layerStereo } from '../engines.js';
import { hit } from './cinematic.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });
const room = (mono, wet = 0.25, size = 0.82, tail = 0.6) => withRoom(norm(mono), { room: size, damp: 0.35, wet, tail });

// A pentatonic ladder: random notes drawn from it are always consonant, which
// is what lets a random sparkle sound pretty rather than wrong.
const PENTA = ['E', 'F#', 'G#', 'B', 'C#'];
const pentaNote = (r, lo, hi) => hz(PENTA[Math.floor(r() * PENTA.length)] + (lo + Math.floor(r() * (hi - lo + 1))));

/** Tiny sine grains at random times: `count` grains over `dur`, bunched early by `bunch` > 1. */
function sparkle(r, { count, dur, fmin, fmax, tau = 0.008, bunch = 1, pitched = false }) {
  const notes = [];
  for (let k = 0; k < count; k++) {
    const t = dur * Math.pow(r(), bunch);
    const f = pitched ? pentaNote(r, 6, 8) : fmin * Math.pow(fmax / fmin, r());
    notes.push([f, t, 0, 0.3 + 0.7 * r() * (1 - t / dur)]);
  }
  return tones(r, notes, { timbre: 'sine', tau, attack: 0.001 });
}

/** An FM bell with a low, slightly inharmonic ratio — ominous rather than pretty. */
function darkBell(f, tau) {
  const L = N(span(0.002, tau));
  const o = new Float32Array(L);
  let pc = 0, pm = 0;
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    o[i] = Math.sin(pc + (3 * Math.exp(-t / 0.15) + 0.5) * Math.sin(pm)) * (t < 0.002 ? t / 0.002 : Math.exp(-(t - 0.002) / tau));
    pc += (TAU * f) / SR; pm += (TAU * f * 1.41) / SR;
  }
  return o;
}

/** A detuned saw cluster, low-passed: the raw material of drones and stabs. */
function cluster(L, notes, cutoff, detune = 0.004) {
  const out = new Float32Array(L);
  for (const f of notes) for (const d of [-detune, 0, detune]) {
    const s = osc(L, f * (1 + d), { shape: 'saw', harmonics: 30 });
    for (let i = 0; i < L; i++) out[i] += s[i];
  }
  return lp(norm(out), cutoff);
}

export const SOUNDS = [
  // ---- SHIMMER ----------------------------------------------------------------
  S('shimmer-bright', 'Bright Shimmer', 'shimmer', 'subtle', ['shimmer', 'bright', 'sparkle', 'magic'], 'a bright scatter of high bell notes; a clean, happy sparkle',
    (r) => room(sparkle(r, { count: 14, dur: 0.6, pitched: true, tau: 0.12, bunch: 1.3 }), 0.35, 0.85, 0.7)),
  S('shimmer-sparkle', 'Sparkle', 'shimmer', 'subtle', ['sparkle', 'fairy-dust', 'magic', 'glitter'], 'dense unpitched fairy-dust glitter thinning out; something magically appearing',
    (r) => [0, 1].map(() => sparkle(r, { count: 70, dur: 0.8, fmin: 5000, fmax: 11000, tau: 0.006, bunch: 1.8 }))),
  S('shimmer-tiny', 'Tiny Sparkle', 'shimmer', 'micro', ['sparkle', 'tiny', 'word', 'glint'], 'a tiny two-note glint with a pinch of glitter; a word catching the light, repeatable',
    (r) => [layer([[tones(r, [[hz('C8'), 0, 0], [hz('G7'), 0.028, 0, 0.7]], { timbre: 'sine', tau: 0.03 }), 0, 1], [sparkle(r, { count: 6, dur: 0.08, fmin: 8000, fmax: 11000, tau: 0.004 }), 0.004, 0.5]])], { gain: 2 }),
  S('shimmer-burst', 'Sparkle Burst', 'shimmer', 'medium', ['sparkle', 'burst', 'pop', 'magic'], 'a burst of glitter that bursts out and falls away fast; a magical pop',
    (r) => {
      const [l, rr] = [0, 1].map(() => sparkle(r, { count: 110, dur: 0.35, fmin: 3000, fmax: 9000, tau: 0.01, bunch: 3 }));
      const L = N(0.3);
      const puff = mul(norm(hp(pink(L, r), 3000)), envAD(L, 0.002, 0.04));
      return layerStereo([[[l, rr], 0, 1], [puff, 0, 0.35]]);
    }, { gain: 1.5 }),
  S('shimmer-glass', 'Glass Shimmer', 'shimmer', 'subtle', ['shimmer', 'glass', 'crystal', 'clean'], 'three rings of struck glass overlapping; a crystal-clean highlight',
    (r) => room(layer([2400, 3120, 3700].map((f, k) => [modal(r, { material: 'glass', f, decay: 1.2, strike: 0.15, strikeCentre: 8000 }), k * 0.05, 1 - k * 0.2])), 0.3, 0.85, 0.7)),
  S('shimmer-twinkle', 'Twinkle', 'shimmer', 'subtle', ['twinkle', 'star', 'arpeggio', 'magic'], 'a quick twinkling arpeggio up and back with an echo; a star, a wish',
    (r) => [tones(r, ['B6', 'D#7', 'F#7', 'B7', 'F#7'].map((n, k) => [hz(n), k * 0.055, 0, 1 - k * 0.1]), { timbre: 'bell', tau: 0.14, echo: 0.4, echoDelay: 0.12 })], { gain: 1 }),
  S('shimmer-tonal', 'Shimmer Pad', 'shimmer', 'subtle', ['shimmer', 'pad', 'tonal', 'warm'], 'a sustained high chord that glimmers and fades; a held glow under a moment',
    (r) => {
      const L = N(1.4);
      const pad = new Float32Array(L);
      ['E6', 'G#6', 'B6', 'D#7'].forEach((n, k) => {
        const f = hz(n), rate = 3 + 1.1 * k, ph = r() * TAU;
        for (let i = 0; i < L; i++) pad[i] += Math.sin((TAU * f * i) / SR) * (0.55 + 0.45 * Math.sin((TAU * rate * i) / SR + ph));
      });
      return room(mul(norm(pad), envSwell(L, 0.3, 0.3)), 0.3, 0.85, 0.5);
    }),
  S('shimmer-airy', 'Airy Shimmer', 'shimmer', 'subtle', ['shimmer', 'air', 'light', 'soft'], 'high air with a few far-off glints; lightness, a breath of magic',
    (r) => {
      const L = N(1.2);
      const air = mul(norm(hp(pink(L, r), 6000)), envSwell(L, 0.5, 0.25));
      const glints = sparkle(r, { count: 8, dur: 1.0, fmin: 6000, fmax: 9500, tau: 0.03 });
      return [0, 1].map((c) => layer([[air.map((v, i) => v * (c ? 1 : 0.8)), 0, 0.6], [glints, 0.05 + 0.02 * c, 0.8]]));
    }),
  S('shimmer-reveal', 'Sparkle Reveal', 'shimmer', 'medium', ['sparkle', 'reveal', 'rising', 'magic'], 'a rising glissando of glints that blooms into a sparkle; a magical reveal',
    (r) => {
      const n = 16, notes = [];
      for (let k = 0; k < n; k++) notes.push([2000 * Math.pow(4, k / (n - 1)), 0.4 * (1 - Math.pow(1 - k / n, 1.5)), 0, 0.4 + 0.6 * (k / n)]);
      const gliss = tones(r, notes, { timbre: 'sine', tau: 0.05, attack: 0.001 });
      return room(layer([[gliss, 0, 1], [sparkle(r, { count: 40, dur: 0.6, fmin: 5000, fmax: 10000, tau: 0.01, bunch: 1.6 }), 0.38, 0.7]]), 0.3, 0.85, 0.6);
    }, { gain: 1 }),

  // ---- CHIME ------------------------------------------------------------------
  S('chime-bell', 'Hand Bell', 'chime', 'medium', ['bell', 'ring', 'announce', 'clear'], 'a single clear hand bell ringing out; an announcement, a moment to notice',
    (r) => room(tones(r, [[hz('C6'), 0, 0]], { timbre: 'bell', tau: 0.5 }), 0.25, 0.82, 0.6)),
  S('chime-wind', 'Wind Chimes', 'chime', 'subtle', ['wind-chimes', 'calm', 'dreamy', 'outdoor'], 'wind chimes stirring, a handful of metal tubes touching; calm, dreamy',
    (r) => room(layer(Array.from({ length: 9 }, (_, k) => [modal(r, { material: 'metal', f: pentaNote(r, 6, 6), decay: 1.0, strike: 0.12, strikeCentre: 7000 }), k * 0.13 + r() * 0.06, 0.4 + 0.6 * r()])), 0.3, 0.85, 0.8)),
  S('chime-ascend', 'Ascending Chime', 'chime', 'medium', ['chime', 'up', 'positive', 'start'], 'three bell notes climbing; something starting, a positive turn',
    (r) => room(tones(r, [[hz('C6'), 0, 0], [hz('E6'), 0.09, 0], [hz('G6'), 0.18, 0]], { timbre: 'bell', tau: 0.32 }), 0.2)),
  S('chime-descend', 'Descending Chime', 'chime', 'medium', ['chime', 'down', 'end', 'close'], 'three bell notes falling; something ending, closing, signing off',
    (r) => room(tones(r, [[hz('G6'), 0, 0], [hz('E6'), 0.09, 0], [hz('C6'), 0.18, 0]], { timbre: 'bell', tau: 0.32 }), 0.2)),
  S('chime-tubular', 'Tubular Bell', 'chime', 'strong', ['bell', 'tubular', 'grand', 'moment'], 'a deep tubular bell with long metallic partials; a grand, solemn moment',
    (r) => room(modal(r, { material: 'metal', f: hz('A4'), decay: 1.6, strike: 0.2, strikeCentre: 3000 }), 0.25, 0.85, 0.9)),
  S('chime-crystal', 'Crystal Chime', 'chime', 'subtle', ['crystal', 'glassy', 'premium', 'clean'], 'a glassy FM chime in a wide space; premium, polished, clean',
    (r) => room(tones(r, [[hz('C7'), 0, 0], [hz('G7'), 0.004, 0, 0.5]], { timbre: 'fm', tau: 0.5 }), 0.35, 0.88, 0.8)),
  S('chime-marimba', 'Marimba', 'chime', 'medium', ['marimba', 'wood', 'warm', 'friendly'], 'two warm marimba notes; friendly, organic, a light positive beat',
    (r) => {
      const bar = (f) => modal(r, { modes: [[1, 1, 0.35], [4, 0.35, 0.1], [9.9, 0.08, 0.03]], f, strike: 0.3, strikeCentre: 2000 });
      return room(layer([[bar(hz('C5')), 0, 1], [bar(hz('G5')), 0.12, 0.85]]), 0.15, 0.7, 0.4);
    }),
  S('chime-kalimba', 'Kalimba', 'chime', 'medium', ['kalimba', 'pluck', 'gentle', 'playful'], 'two plucked kalimba tines; gentle, playful, a little magical',
    (r) => {
      const tine = (f) => modal(r, { modes: [[1, 1, 0.4], [6.3, 0.25, 0.06], [17.5, 0.08, 0.015]], f, strike: 0.4, strikeCentre: 5000 });
      return room(layer([[tine(hz('G5')), 0, 0.9], [tine(hz('C6')), 0.14, 1]]), 0.2, 0.75, 0.5);
    }),

  // ---- TENSION ----------------------------------------------------------------
  S('tension-pulse', 'Tension Pulse', 'tension', 'medium', ['tension', 'pulse', 'suspense', 'dark'], 'a low drone throbbing slowly; unease, something is off',
    (r) => {
      const L = N(1.8);
      const am = new Float32Array(L).map((_, i) => 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.cos((TAU * 1.6 * i) / SR), 3));
      const drone = cluster(L, [hz('A1'), hz('A2'), hz('E3')], 900);
      return room(mul(mul(drone, am), envSwell(L, 0.3, 0.3)), 0.2, 0.8, 0.5);
    }),
  S('tension-tick', 'Suspense Clock', 'tension', 'medium', ['clock', 'tick', 'waiting', 'time'], 'a clock ticking and tocking in a quiet room; waiting, time running',
    (r) => {
      const tick = (hi) => click(r, { centre: hi ? 3500 : 2300, Q: 4, tau: 0.002, tone: hi ? 2400 : 1650, toneMix: 0.5, toneTau: 0.008 });
      return room(layer([0, 1, 2, 3].map((k) => [tick(k % 2 === 0), k * 0.5, 1])), 0.25, 0.7, 0.35);
    }, { literal: true }),
  S('tension-heartbeat', 'Heartbeat', 'tension', 'medium', ['heartbeat', 'nervous', 'suspense', 'body'], 'two heartbeats, lub-dub, lub-dub; nerves, anticipation, a held breath',
    (r) => {
      const beat = (lvl) => [lp(hit(r, { f0: 85, f1: 52, tauF: 0.03, tauA: 0.08, len: 0.3, tr: { centre: 600, gain: 0.04 }, knock: { freq: 230, tau: 0.03, gain: 1 }, nz: { cutoff: 300, tau: 0.04, gain: 0.3 }, drive: 1.5 }), 1100), lvl];
      const [a, ga] = beat(1), [b, gb] = beat(0.75);
      return [layer([[a, 0, ga], [b, 0.17, gb], [a, 0.85, ga * 0.95], [b, 1.02, gb * 0.95]])];
    }, { literal: true }),
  S('tension-hit', 'Suspense Hit', 'tension', 'strong', ['tension', 'hit', 'dissonant', 'shock'], 'a dissonant low stab with a hit and a dark room; a shocking realisation',
    (r) => {
      const L = N(span(0.004, 0.3));
      const stabbed = mul(cluster(L, [hz('C3'), hz('C#3'), hz('G3'), hz('C2')], 2200), envAD(L, 0.004, 0.3));
      return room(layer([[norm(stabbed), 0, 0.8], [hit(r, { f0: 120, f1: 50, tauA: 0.14, drive: 2.2 }), 0, 1]]), 0.35, 0.86, 0.9);
    }),
  S('tension-drone', 'Dark Drone', 'tension', 'strong', ['drone', 'dark', 'ominous', 'bed'], 'a dark detuned drone swelling in and away; dread under a serious line',
    (r) => {
      const L = N(2.2);
      const d = cluster(L, [hz('A1'), hz('E2'), hz('A#2'), hz('A2')], 700, 0.006);
      return room(mul(lp(d, (t) => 400 + 700 * Math.sin((Math.PI * t) / 2.2)), envSwell(L, 0.45, 0.35, 1.5)), 0.25, 0.85, 0.6);
    }),
  S('tension-ominous', 'Ominous Bell', 'tension', 'strong', ['bell', 'ominous', 'dark', 'omen'], 'a low, off-kilter bell tolling once; an omen, bad news coming',
    (r) => room(sum(N(span(0.002, 0.9)), [darkBell(98, 0.65), 1], [darkBell(196.8, 0.4), 0.35]), 0.35, 0.88, 0.8)),
  S('tension-countdown', 'Countdown Ticks', 'tension', 'medium', ['countdown', 'ticks', 'urgent', 'build'], 'high ticks speeding up to a stop; a countdown, urgency building',
    (r) => {
      const parts = [];
      let t = 0;
      while (t < 1.3) { parts.push([click(r, { centre: 4200, Q: 5, tau: 0.0015, tone: 3000, toneMix: 0.4, toneTau: 0.004 }), t, 0.5 + 0.5 * (t / 1.3)]); t += 1 / (3 + 13 * Math.pow(t / 1.3, 1.3)); }
      return [layer(parts)];
    }),
  S('tension-shiver', 'Shiver', 'tension', 'subtle', ['eerie', 'shiver', 'high', 'unsettling'], 'a high trembling dissonance; eerie, cold, unsettling',
    (r) => {
      const L = N(1.3);
      const s = sum(L, [osc(L, hz('E6')), 1], [osc(L, hz('F6')), 0.8], [osc(L, hz('B5')), 0.4]);
      const trem = new Float32Array(L).map((_, i) => 0.55 + 0.45 * Math.sin((TAU * 11 * i) / SR));
      return room(mul(mul(norm(s), trem), envSwell(L, 0.55, 0.2, 1.5)), 0.35, 0.86, 0.6);
    }, { gain: -2 }),

  // ---- COMEDY -----------------------------------------------------------------
  S('comedy-bonk-tiny', 'Tiny Bonk', 'comedy', 'comedic', ['bonk', 'tiny', 'silly', 'cute'], 'a small hollow bonk; a cute tap on the head, a silly beat',
    (r) => [layer([[modal(r, { material: 'hollowWood', f: 700, decay: 0.9, strike: 0.3, strikeCentre: 2500 }), 0, 1], [mul(osc(N(0.2), glide(900, 600, 0.03)), envAD(N(0.2), 0.001, 0.035)), 0, 0.4]])], { gain: -2, usage: 'word' }),
  S('comedy-bonk', 'Bonk', 'comedy', 'comedic', ['bonk', 'hit', 'cartoon', 'head'], 'a big hollow cartoon bonk with a dropping ring; someone getting bopped',
    (r) => [layer([[modal(r, { material: 'hollowWood', f: 330, decay: 1.4, strike: 0.4, strikeCentre: 2000 }), 0, 1], [mul(osc(N(0.75), glide(560, 300, 0.05)), envAD(N(0.75), 0.001, 0.12)), 0, 0.5]])]),
  S('comedy-pop', 'Cork Pop', 'comedy', 'comedic', ['pop', 'cork', 'surprise', 'cartoon'], 'a cork popping out, pitch jumping up; a surprise, an idea popping up',
    (r) => {
      const L = N(span(0.001, 0.03));
      const tone = mul(osc(L, glide(350, 1500, 0.012)), envAD(L, 0.001, 0.03));
      return [sum(L, [norm(tone), 1], [transient(L, r, 2500, 0.004), 0.6])];
    }),
  S('comedy-awkward', 'Crickets', 'comedy', 'comedic', ['crickets', 'awkward', 'silence', 'nothing'], 'crickets chirping in the silence; an awkward pause, a joke that did not land',
    (r) => {
      const dur = 1.9, L = N(dur);
      const cricket = (f, offset) => {
        const gate = new Float32Array(L);
        for (let t = offset; t < dur - 0.1; t += 0.42 + 0.05 * r()) {
          for (let p = 0; p < 3; p++) {
            const s = N(t + p * 0.028), e = s + N(0.018);
            for (let i = s; i < e && i < L; i++) gate[i] = Math.sin((Math.PI * (i - s)) / (e - s)) ** 2;
          }
        }
        return mul(osc(L, f), gate);
      };
      return [panned(cricket(4650, 0.02), -0.4), panned(cricket(4400, 0.23), 0.5)].reduce((a, b) => [a[0].map((v, i) => v + b[0][i] * 0.7), a[1].map((v, i) => v + b[1][i] * 0.7)]);
    }, { literal: true, gain: -5 }),
  S('comedy-fail', 'Sad Trombone', 'comedy', 'comedic', ['fail', 'sad', 'trombone', 'wah-wah'], 'wah, wah, wah, waaah — a muted trombone falling; a fail, a let-down',
    (r) => {
      const notes = [['F4', 0, 0.26], ['E4', 0.32, 0.26], ['D#4', 0.64, 0.26], ['D4', 0.96, 0.85]];
      return [layer(notes.map(([n, at, d], k) => {
        const f0 = hz(n), L = N(span(0.02, 0.05, d - 0.02)), last = k === 3;
        const f = (t) => f0 * (1 - 0.02 * Math.exp(-t / 0.03)) * (1 + (last ? 0.012 * Math.min(1, t / 0.3) * Math.sin(TAU * 5.5 * t) : 0));
        // The plunger mute: each note's brightness opens and closes — "wah".
        const cut = (t) => 450 + 1700 * Math.sin(Math.PI * Math.min(1, t / (last ? 0.5 : d)));
        return [mul(lp(osc(L, f, { shape: 'saw', harmonics: 30 }), cut, 1.8), envAD(L, 0.02, 0.05, d - 0.02)), at, 1];
      }))];
    }, { literal: true }),
  S('comedy-slide-down', 'Slide Whistle Down', 'comedy', 'comedic', ['slide-whistle', 'down', 'fall', 'fail'], 'a slide whistle falling; something dropping, a deflating idea',
    (r) => {
      const d = 0.6, L = N(span(0.02, 0.04, d));
      const f = (t) => 500 + 1700 * Math.exp(-t / 0.25) * (1 + 0.01 * Math.sin(TAU * 6 * t));
      return [sum(L, [mul(osc(L, f), envAD(L, 0.02, 0.04, d)), 1], [mul(norm(hp(white(L, r), 3000)), envAD(L, 0.02, 0.04, d)), 0.03])];
    }),
  S('comedy-slide-up', 'Slide Whistle Up', 'comedy', 'comedic', ['slide-whistle', 'up', 'rise', 'silly'], 'a slide whistle rising; something shooting up, a silly lift',
    (r) => {
      const d = 0.5, L = N(span(0.02, 0.04, d));
      const f = (t) => (500 + 1600 * (1 - Math.exp(-t / 0.18))) * (1 + 0.01 * Math.sin(TAU * 6 * t));
      return [sum(L, [mul(osc(L, f), envAD(L, 0.02, 0.04, d)), 1], [mul(norm(hp(white(L, r), 3000)), envAD(L, 0.02, 0.04, d)), 0.03])];
    }),
  S('comedy-cartoon-hit', 'Cartoon Hit', 'comedy', 'comedic', ['cartoon', 'hit', 'wobble', 'slapstick'], 'a slapstick thwack with a wobbling ring; cartoon impact',
    (r) => {
      const L = N(span(0.001, 0.18));
      const wobble = mul(osc(L, (t) => 230 * (1 + 0.15 * Math.exp(-t / 0.12) * Math.sin(TAU * 16 * t))), envAD(L, 0.001, 0.18));
      return [layer([[hit(r, { f0: 200, f1: 90, tauA: 0.06, tr: { centre: 2500, gain: 0.8 }, drive: 2 }), 0, 0.9], [norm(wobble), 0, 0.6]])];
    }),
  S('comedy-boing', 'Boing', 'comedy', 'comedic', ['boing', 'bounce', 'spring', 'silly'], 'a jaw-harp boing, the twang wobbling away; a bounce, a silly surprise',
    (r) => {
      const L = N(span(0.003, 0.25));
      const tw = osc(L, (t) => 140 * (1 + 0.03 * Math.sin(TAU * 7 * t)), { shape: 'square', harmonics: 20 });
      const mouth = (t) => 700 + 2200 * (0.5 + 0.5 * Math.sin(TAU * 10 * t)) * Math.exp(-t / 0.3);
      return [mul(bp(tw, mouth, 2.5), envAD(L, 0.003, 0.25))];
    }),
  S('comedy-spring', 'Sproing', 'comedy', 'comedic', ['spring', 'sproing', 'coil', 'cartoon'], 'a coiled spring released — a metallic sproing; something launching',
    (r) => {
      const chirp = (lvl) => { const L = N(span(0.001, 0.008, 0.012)); return [mul(osc(L, sweep(4500, 500, 0.028)), envAD(L, 0.001, 0.008, 0.012)), lvl]; };
      const parts = [];
      for (let k = 0; k < 8; k++) { const [c, g] = chirp(Math.pow(0.72, k)); parts.push([c, k * 0.045, g]); }
      return [layer([...parts, [modal(r, { material: 'metal', f: 820, decay: 0.8, strike: 0 }), 0, 0.25]])];
    }),
  S('comedy-squeak', 'Squeak', 'comedy', 'comedic', ['squeak', 'toy', 'cute', 'squeeze'], 'a rubber toy squeaked; cute, small, silly',
    (r) => {
      const d = 0.24, L = N(span(0.01, 0.02, d - 0.02));
      const f = (t) => 1500 + 800 * Math.sin(Math.PI * Math.min(1, t / d)) * (1 + 0.06 * Math.sin(TAU * 30 * t));
      return [mul(bp(osc(L, f, { shape: 'square', harmonics: 6 }), 2000, 1.2), envAD(L, 0.01, 0.02, d - 0.02))];
    }, { literal: true, gain: -2 }),
  S('comedy-honk', 'Horn Honk', 'comedy', 'comedic', ['honk', 'horn', 'clown', 'silly'], 'a bicycle horn honked twice; clowning around, a silly interruption',
    (r) => {
      const honk = () => {
        const d = 0.2, L = N(span(0.008, 0.02, d));
        const reed = osc(L, (t) => 380 + 50 * Math.min(1, t / 0.05), { shape: 'saw', harmonics: 25 });
        return mul(sum(L, [bp(reed, 1100, 2), 1], [bp(reed, 2300, 3), 0.5]), envAD(L, 0.008, 0.02, d));
      };
      return [layer([[honk(), 0, 1], [honk(), 0.3, 1]])];
    }, { literal: true }),
  S('comedy-rimshot', 'Rimshot', 'comedy', 'comedic', ['rimshot', 'joke', 'ba-dum-tss', 'punchline'], 'ba-dum-tss — the drum sting after a joke; a punchline',
    (r) => {
      const snare = () => { const L = N(span(0.001, 0.09)); return sum(L, [norm(bp(mul(white(L, r), envAD(L, 0.001, 0.09)), 1900, 0.8)), 1], [mul(osc(L, 190), envAD(L, 0.001, 0.03)), 0.5]); };
      const tom = () => { const L = N(span(0.002, 0.15)); return mul(osc(L, glide(165, 115, 0.05)), envAD(L, 0.002, 0.15)); };
      const cym = () => { const L = N(span(0.001, 0.45)); return sum(L, [norm(hp(mul(white(L, r), envAD(L, 0.001, 0.45)), 6000)), 1], [norm(mul(osc(L, 5400), envAD(L, 0.001, 0.3))), 0.15]); };
      return room(layer([[snare(), 0, 1], [tom(), 0.17, 0.9], [snare(), 0.44, 0.9], [cym(), 0.44, 0.55]]), 0.15, 0.7, 0.4);
    }, { literal: true }),
  S('comedy-click', 'Cartoon Click', 'comedy', 'comedic', ['click', 'exaggerated', 'cartoon', 'idea'], 'an exaggerated two-stage cartoon click; a light bulb, an idea landing',
    (r) => [click(r, { centre: 1800, Q: 3, tau: 0.006, tone: 1400, toneMix: 0.45, toneTau: 0.03, bodyF: 700, bodyMix: 0.8, bodyTau: 0.03, then: { at: 0.055, centre: 2800, Q: 3, tau: 0.004, tone: 2100, toneMix: 0.4, toneTau: 0.02, bodyF: 900, bodyMix: 0.6, level: 0.8 } })])
];
