/**
 * The expanded pack's synthesis engines. Each models one PHYSICAL or
 * ELECTRONIC mechanism well enough to play a whole family of sounds from
 * parameters — which is the difference between a library and a folder:
 *
 *   click     — a struck contact: key, switch, mouse, snap, tick, tap
 *   modal     — a resonating body: wood, glass, metal, plastic, bells
 *   crackle   — a cloud of tiny impulses: paper, sparks, static, grit
 *   friction  — a tool dragged across a surface: pencil, pen, marker, chalk, brush
 *   tones     — a sequence of synthetic notes: UI, success, sci-fi, stings
 *   varispeed — a recording played at a changing speed: tape stop, rewind, scratch
 *   servo     — a small motor: autofocus, lens, zoom
 *   buzz      — mains-frequency electricity: hum, fluorescent flicker, power on/off
 *
 * All pure functions of their parameters and a seeded random source, so every
 * sound built on them is reproducible.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, taperEnd, envAD, envSwell, mul, scale, peakOf,
  norm, place, sum, lp, hp, bp, sat, pluck, reverb, withRoom, panned, reverse, sampleHold, crush,
  resample, fadeEdges
} from './dsp.js';
import { harmonicBody, transient } from './instruments.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const len = (a) => a.length;

/** Mix mono buffers at offsets (seconds) with gains into one buffer sized to fit them all. */
export function layer(parts) {
  let L = 0;
  for (const [src, at = 0] of parts) L = Math.max(L, N(at) + src.length);
  return place(L, parts.map(([s, at = 0, g = 1]) => [s, at, g]));
}

/** Mix STEREO pairs (or mono, duplicated) at offsets with gains. */
export function layerStereo(parts) {
  const stereo = parts.map(([s, at = 0, g = 1]) => [Array.isArray(s) ? s : [s, s], at, g]);
  let L = 0;
  for (const [[l], at] of stereo) L = Math.max(L, N(at) + l.length);
  return [0, 1].map((c) => place(L, stereo.map(([pair, at, g]) => [pair[c], at, g])));
}

// ---- click ---------------------------------------------------------------------

/**
 * A struck contact. Three optional layers, each a physical part of a click:
 *   noise  — the contact itself: a resonant band of noise (what makes a TICK
 *            rather than a beep);
 *   tone   — a short ring from whatever was struck;
 *   body   — a low, slightly pitch-dropping thump from the housing.
 * `then` adds a second contact after a gap — a mouse button's press and
 * release, a key bottoming out, a switch's two stages.
 */
export function click(r, {
  centre = 3000, Q = 2, tau = 0.004, gain = 1,
  tone = 0, toneTau = 0.006, toneMix = 0,
  bodyF = 0, bodyTau = 0.012, bodyMix = 0,
  highpass = 0, lowpass = 0, drive = 0, then = null
} = {}) {
  const longest = Math.max(tau, toneMix ? toneTau : 0, bodyMix ? bodyTau : 0);
  const L = N(span(0.0003, longest) + 0.002);
  const parts = [[norm(bp(mul(white(L, r), envAD(L, 0.0002, tau)), centre, Q)), gain]];
  if (toneMix) parts.push([norm(mul(osc(L, tone), envAD(L, 0.0003, toneTau))), toneMix]);
  if (bodyMix) parts.push([norm(mul(osc(L, glide(bodyF * 1.3, bodyF, 0.006)), envAD(L, 0.0005, bodyTau))), bodyMix]);
  let out = sum(L, ...parts);
  if (drive) out = sat(norm(out), drive);
  if (highpass) out = hp(out, highpass);
  if (lowpass) out = lp(out, lowpass);
  if (then) {
    const { at, level = 0.7, ...rest } = then;
    out = layer([[out, 0, 1], [norm(click(r, rest)), at, level]]);
  }
  return out;
}

// ---- modal ---------------------------------------------------------------------

/**
 * A resonating body: a set of damped modes [freq, amp, tau] excited by a short
 * strike. Wood has few, low, fast-dying modes; glass many high inharmonic ones
 * that ring; metal inharmonic with long decays. Materials below are starting
 * points, scaled by `pitch` and `decay`.
 */
export const MATERIALS = {
  wood: [[1, 1, 0.045], [2.75, 0.55, 0.03], [4.1, 0.35, 0.02], [6.3, 0.18, 0.012]],
  hollowWood: [[1, 1, 0.07], [1.9, 0.6, 0.05], [3.2, 0.3, 0.03], [5.2, 0.15, 0.015]],
  glass: [[1, 1, 0.28], [2.32, 0.6, 0.2], [4.25, 0.45, 0.15], [6.63, 0.3, 0.1], [9.38, 0.18, 0.07]],
  metal: [[1, 1, 0.4], [2.76, 0.7, 0.3], [5.4, 0.5, 0.22], [8.93, 0.35, 0.15], [13.3, 0.2, 0.1]],
  plastic: [[1, 1, 0.018], [2.2, 0.6, 0.012], [3.9, 0.35, 0.008]],
  ceramic: [[1, 1, 0.12], [2.4, 0.5, 0.09], [4.6, 0.3, 0.06], [7.1, 0.2, 0.04]]
};

export function modal(r, { material = 'wood', f = 400, decay = 1, strike = 0.35, strikeCentre = 4000, bright = 1, modes } = {}) {
  const set = modes || MATERIALS[material];
  const longest = Math.max(...set.map(([, , t]) => t * decay));
  const L = N(span(0.0005, longest) + 0.003);
  const out = new Float32Array(L);
  set.forEach(([ratio, amp, t], k) => {
    const fk = f * ratio;
    if (fk > 18000) return;
    const s = mul(osc(L, fk, { phase: r() * TAU }), envAD(L, 0.0004, t * decay));
    const a = amp * Math.pow(bright, k);
    for (let i = 0; i < L; i++) out[i] += s[i] * a;
  });
  const hit = strike ? scale(transient(L, r, strikeCentre, 0.0015, 0.8), strike) : null;
  return hit ? sum(L, [norm(out), 1], [hit, 1]) : out;
}

// ---- crackle -------------------------------------------------------------------

/**
 * A cloud of tiny impulses, scattered in time by a Poisson process whose rate
 * follows `density(t)` (impulses per second). Paper, sparks, static and grit
 * are all this, differing in rate, impulse length and colour.
 */
export function crackle(r, { dur, density, centre = 4000, Q = 0.8, grainTau = 0.0006, amp = () => 1, spread = 1, highpass = 0, lowpass = 0 }) {
  const L = N(dur + grainTau * 12);
  const out = new Float32Array(L);
  let t = 0;
  while (t < dur) {
    const rate = Math.max(1, typeof density === 'function' ? density(t / dur) : density);
    t += -Math.log(1 - r()) / rate;
    if (t >= dur) break;
    const g = 0.2 + 0.8 * Math.pow(r(), spread);
    const a = (typeof amp === 'function' ? amp(t / dur) : amp) * g * (r() < 0.5 ? -1 : 1);
    const at = N(t);
    const tauK = grainTau * (0.5 + r());
    // Each grain sized by ITS OWN decay (to -60 dB). A fixed length, set from
    // the nominal grain time, cut the longest grains off at about -41 dB.
    const gL = N(tauK * 6.9) + 2;
    for (let i = 0; i < gL && at + i < L; i++) out[at + i] += a * (r() * 2 - 1) * Math.exp(-(i / SR) / tauK);
  }
  let o = bp(out, centre, Q);
  if (highpass) o = hp(o, highpass);
  if (lowpass) o = lp(o, lowpass);
  return o;
}

// ---- friction (writing and drawing) ---------------------------------------------

/**
 * Speed profiles for the gestures a hand makes, v(t) in 0..1 over the
 * gesture's length. The sound of drawing is mostly THIS: texture scaled by
 * how fast the tool is moving, so the shape of the motion is what makes a
 * circle sound unlike a scribble.
 */
function gestureSpeed(gesture, r, dur) {
  const smooth = (x) => Math.sin(Math.PI * clamp(x, 0, 1));
  switch (gesture) {
    case 'stroke': return (x) => Math.pow(smooth(x), 0.7);
    case 'underline': return (x) => Math.pow(smooth(x), 0.5) * (0.85 + 0.15 * x);
    case 'circle': return (x) => Math.pow(smooth(x), 0.35) * (0.8 + 0.2 * Math.sin(TAU * 2 * x + 1));
    case 'scribble': {
      const hz = 9;
      return (x) => Math.pow(smooth(x), 0.3) * (0.25 + 0.75 * Math.abs(Math.sin(Math.PI * hz * x * dur)));
    }
    case 'scribble-slow': {
      const hz = 4.5;
      return (x) => Math.pow(smooth(x), 0.3) * (0.3 + 0.7 * Math.abs(Math.sin(Math.PI * hz * x * dur)));
    }
    case 'scribble-fast': {
      const hz = 14;
      return (x) => Math.pow(smooth(x), 0.3) * (0.2 + 0.8 * Math.abs(Math.sin(Math.PI * hz * x * dur)));
    }
    case 'check': return (x) => (x < 0.3 ? smooth(x / 0.3) * 0.8 : x < 0.38 ? 0.05 : smooth((x - 0.38) / 0.62));
    case 'cross': return (x) => (x < 0.45 ? smooth(x / 0.45) : x < 0.55 ? 0.03 : smooth((x - 0.55) / 0.45));
    case 'scratch': return (x) => Math.pow(Math.abs(Math.sin(Math.PI * 5 * x)), 0.6) * smooth(x);
    case 'write': {
      // Letters: a run of short strokes of random length with small lifts
      // between them — handwriting's rhythm.
      const segs = [];
      let t = 0;
      while (t < 1) {
        const d = (0.06 + r() * 0.12) / dur, gap = (0.015 + r() * 0.04) / dur;
        segs.push([t, Math.min(1, t + d), 0.6 + 0.4 * r()]);
        t += d + gap;
      }
      return (x) => {
        for (const [a, b, lvl] of segs) if (x >= a && x < b) return lvl * Math.pow(smooth((x - a) / (b - a)), 0.5);
        return 0;
      };
    }
    default: return () => 1;
  }
}

/**
 * Tools: the colour and grain of the texture each one makes on its surface.
 * Pencil is gritty graphite; pen smoother and brighter; marker soft felt with
 * a faint squeak; chalk very gritty with knocks where strokes start; brush a
 * soft wash of bristles.
 */
export const TOOLS = {
  pencil: { centre: 3600, Q: 0.7, grit: 0.55, gritRate: 2200, gritCentre: 5200, lowpass: 9500, highpass: 700, speedExp: 1.1 },
  graphite: { centre: 3000, Q: 0.6, grit: 0.8, gritRate: 3200, gritCentre: 4200, lowpass: 8000, highpass: 600, speedExp: 1.2 },
  pen: { centre: 3200, Q: 1.1, grit: 0.2, gritRate: 900, gritCentre: 6000, lowpass: 10000, highpass: 900, speedExp: 1 },
  marker: { centre: 1700, Q: 0.9, grit: 0.1, gritRate: 500, gritCentre: 3000, lowpass: 6500, highpass: 400, speedExp: 0.9, squeak: 0.18 },
  chalk: { centre: 2600, Q: 0.55, grit: 1, gritRate: 5000, gritCentre: 3800, lowpass: 8500, highpass: 500, speedExp: 1.3, knock: 0.5 },
  brush: { centre: 1300, Q: 0.45, grit: 0.25, gritRate: 6000, gritCentre: 2500, lowpass: 4500, highpass: 250, speedExp: 0.8 },
  paint: { centre: 1100, Q: 0.45, grit: 0.3, gritRate: 7000, gritCentre: 2200, lowpass: 4000, highpass: 200, speedExp: 0.8, wet: 0.35 }
};

export function friction(r, { tool = 'pencil', gesture = 'stroke', dur = 0.4 }) {
  const T = TOOLS[tool];
  const L = N(dur);
  const v = gestureSpeed(gesture, r, dur);
  const speed = new Float32Array(L);
  for (let i = 0; i < L; i++) speed[i] = v(i / L);
  const amp = speed.map((s) => Math.pow(Math.max(0, s), T.speedExp));
  // Texture: the surface noise, brighter the faster the tool moves.
  const base = bp(pink(L, r), (t) => T.centre * (0.75 + 0.5 * v(t / dur)), T.Q);
  const grit = crackle(r, {
    dur, density: (x) => T.gritRate * (0.2 + v(x)), centre: T.gritCentre, Q: 0.9, grainTau: 0.0004,
    amp: (x) => v(x)
  }).slice(0, L);
  const parts = [[mul(norm(base), amp), 1], [norm(grit), T.grit]];
  if (T.squeak) {
    // Felt tips squeak faintly at speed: a thin tone that tracks the stroke.
    const sq = mul(osc(L, (t) => 900 + 700 * v(t / dur)), amp.map((a) => Math.pow(a, 3)));
    parts.push([norm(sq), T.squeak]);
  }
  if (T.wet) parts.push([mul(norm(lp(white(L, r), 700)), amp.map((a) => a * a)), T.wet]);
  let out = sum(L, ...parts);
  if (T.knock) {
    // Chalk knocks the board where each stroke begins.
    const knocks = [];
    for (let i = 1; i < L; i++) if (speed[i - 1] < 0.08 && speed[i] >= 0.08) knocks.push([modal(r, { material: 'wood', f: 900, decay: 0.4, strike: 0.6 }), i / SR, T.knock]);
    if (knocks.length) out = layer([[out, 0, 1], ...knocks]).slice(0, L);
  }
  return fadeEdges(lp(hp(out, T.highpass), T.lowpass), 2, 8);
}

// ---- tones -----------------------------------------------------------------------

/**
 * A sequence of synthetic notes: [freqHz, atSeconds, holdSeconds, level].
 * Timbres: 'sine' (pure, UI), 'soft' (sine + a little 3rd harmonic), 'bell'
 * (struck partials), 'fm' (glassy), 'pulse' (hollow square, retro-free by
 * filtering), 'saw' (bright, for stings). `echo` repeats the whole line
 * quieter — a cheap, very effective sense of space.
 */
export function tones(r, notes, { timbre = 'soft', tau = 0.06, attack = 0.003, lowpass = 0, vibrato = 0, echo = 0, echoDelay = 0.11, chorus = 0 } = {}) {
  const parts = notes.map(([f, at, hold = 0, level = 1]) => {
    const L = N(span(attack, tau, hold) + 0.004);
    const vib = vibrato ? (t) => f * (1 + vibrato * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.08)) : f;
    let s;
    if (timbre === 'sine') s = osc(L, vib);
    else if (timbre === 'soft') s = sum(L, [osc(L, vib), 1], [osc(L, typeof vib === 'function' ? (t) => 3 * vib(t) : 3 * f), 0.12]);
    else if (timbre === 'bell') {
      s = new Float32Array(L);
      [[1, 1, 1], [2, 0.3, 0.5], [3, 0.12, 0.35], [4.2, 0.05, 0.25]].forEach(([ratio, a, ts]) => {
        const p = mul(osc(L, f * ratio), envAD(L, attack, tau * ts));
        for (let i = 0; i < L; i++) s[i] += p[i] * a;
      });
    } else if (timbre === 'fm') {
      s = new Float32Array(L);
      let pc = 0, pm = 0;
      for (let i = 0; i < L; i++) { const t = i / SR; s[i] = Math.sin(pc + (1.6 * Math.exp(-t / 0.04) + 0.3) * Math.sin(pm)); pc += (TAU * f) / SR; pm += (TAU * f * 2.76) / SR; }
    } else if (timbre === 'pulse') s = lp(osc(L, vib, { shape: 'square', harmonics: 9 }), 3500);
    else s = lp(osc(L, vib, { shape: 'saw', harmonics: 30 }), 4500);
    if (chorus) s = sum(L, [s, 1], [osc(L, f * (1 + chorus)), 0.5]);
    const env = timbre === 'bell' ? envAD(L, attack, 1e9, 0) : envAD(L, attack, tau, hold);
    return [mul(s, env), at, level];
  });
  let out = layer(parts);
  if (lowpass) out = lp(out, lowpass);
  if (echo) out = layer([[out, 0, 1], [out, echoDelay, echo], [out, echoDelay * 2, echo * echo]]);
  return out;
}

// Equal-tempered pitches by name, so recipes read as music rather than numbers.
const NOTE = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
export function hz(name) {
  const m = /^([A-G]#?)(\d)$/.exec(name);
  return 440 * Math.pow(2, (NOTE[m[1]] + (Number(m[2]) - 4) * 12) / 12);
}

// ---- varispeed --------------------------------------------------------------------

/**
 * Plays `src` with a playback rate that changes over time (rate(t), with
 * negative meaning backwards), the way a tape or a record does. Pitch and
 * speed move together, which is what a tape stop IS.
 */
export function varispeed(src, rate, dur, { start = 0 } = {}) {
  const L = N(dur);
  const out = new Float32Array(L);
  let p = start * SR;
  for (let i = 0; i < L; i++) {
    const j = Math.floor(p), f = p - j;
    const a = src[((j % src.length) + src.length) % src.length], b = src[(((j + 1) % src.length) + src.length) % src.length];
    out[i] = a * (1 - f) + b * f;
    p += rate(i / SR);
  }
  return out;
}

/** A short synthetic "music" bed — a chord and a pulse — for tape and record effects to act on. */
export function musicBed(r, dur = 2) {
  const L = N(dur);
  const chord = [hz('A3'), hz('C4'), hz('E4'), hz('A4')];
  const pad = new Float32Array(L);
  chord.forEach((f, k) => { const s = osc(L, f * (1 + (k - 1.5) * 0.002), { shape: 'saw', harmonics: 24 }); for (let i = 0; i < L; i++) pad[i] += s[i] * 0.25; });
  const beat = new Float32Array(L);
  for (let t = 0; t < dur; t += 0.25) {
    const k = modal(r, { material: 'wood', f: 180, decay: 1.5, strike: 0.2 });
    const at = N(t);
    for (let i = 0; i < k.length && at + i < L; i++) beat[at + i] += k[i] * 0.8;
  }
  return sum(L, [norm(lp(pad, 2500)), 0.7], [norm(beat), 0.6]);
}

// ---- servo ------------------------------------------------------------------------

/** A small motor: a whine that tracks its speed, gear ticks, and a band of mechanical noise. */
export function servo(r, { dur, pitch = 1800, pitchEnd = pitch, bursts = [[0, 1]], ticks = 0.5 }) {
  const L = N(dur);
  const env = new Float32Array(L);
  for (const [a, b] of bursts) {
    const s = N(a * dur), e = N(b * dur);
    for (let i = s; i < e && i < L; i++) { const x = (i - s) / Math.max(1, e - s); env[i] = Math.max(env[i], Math.pow(Math.sin(Math.PI * x), 0.4)); }
  }
  const whine = osc(L, (t) => (pitch + (pitchEnd - pitch) * (t / dur)) * (1 + 0.01 * Math.sin(TAU * 37 * t)));
  const gears = crackle(r, { dur, density: 380, centre: 5000, Q: 1.5, grainTau: 0.00025 }).slice(0, L);
  const mech = bp(pink(L, r), pitch * 1.4, 1.2);
  return mul(sum(L, [norm(whine), 0.3], [norm(gears), ticks], [norm(mech), 0.45]), env);
}

// ---- buzz -------------------------------------------------------------------------

/**
 * Mains electricity: a harmonic-rich 120 Hz buzz (the frequency lighting
 * actually buzzes at) with random jitter, optionally gated by a flicker
 * pattern of [onSeconds, offSeconds] pairs.
 */
export function buzz(r, { dur, f = 120, gate = null, jitter = 0.25, bright = 2600, crackleAmt = 0.25, highpass = 160 }) {
  const L = N(dur);
  // High-passed above the fundamental: what the ear knows as "buzz" is the
  // harmonic series, and a phone cannot play the 120 Hz fundamental anyway —
  // leaving it in only spent the loudness budget on something inaudible.
  let tone = hp(lp(osc(L, (t) => f * (1 + 0.003 * Math.sin(TAU * 3 * t)), { shape: 'square', harmonics: 25 }), bright), highpass);
  const jit = lp(white(L, r), 30).map((v) => 1 + jitter * v * 6);
  tone = mul(tone, jit);
  let g = null;
  if (gate) {
    g = new Float32Array(L);
    let t = 0;
    for (const [on, off] of gate) {
      const s = N(t), e = N(t + on);
      // A fixed ~2 ms edge. Ramping over 1/40th of each segment gave a 0.4 ms
      // edge on a short flicker — a hard switch, heard as a click on every flick.
      const edge = N(0.002);
      for (let i = s; i < e && i < L; i++) g[i] = Math.min(1, (i - s) / edge, (e - i) / edge);
      t += on + off;
    }
    tone = mul(tone, g);
  }
  // Sparks are gated where they START, not multiplied by the gate: a spark
  // caught by a closing gate was chopped mid-decay — a truncation click on
  // every flick. A real arc that has struck finishes its own tiny decay.
  // Gated, the arcs STRIKE as each flick comes on and die away within ~8 ms,
  // which is also how a tube sparks.
  let strike = null;
  if (gate) {
    strike = new Float32Array(L);
    let t = 0;
    for (const [on, off] of gate) { const s0 = N(t), e0 = Math.min(L, N(t + on) - N(0.006)); for (let i = s0; i < e0; i++) strike[i] = Math.exp(-(i - s0) / N(0.008)); t += on + off; }
  }
  const sparkAmp = strike ? (x) => strike[Math.min(L - 1, Math.floor(x * L))] : () => 1;
  const sparks = crackle(r, { dur, density: 140, centre: 4500, Q: 0.7, grainTau: 0.0004, amp: sparkAmp }).slice(0, L);
  return sum(L, [norm(tone), 1], [norm(sparks), crackleAmt]);
}

/** A random flicker pattern for `dur` seconds: short on/off pairs. */
export function flickerPattern(r, dur, { on = [0.02, 0.07], off = [0.015, 0.05] } = {}) {
  const out = [];
  let t = 0;
  while (t < dur) {
    const a = on[0] + r() * (on[1] - on[0]), b = off[0] + r() * (off[1] - off[0]);
    out.push([a, b]);
    t += a + b;
  }
  return out;
}

export { clamp, len };
