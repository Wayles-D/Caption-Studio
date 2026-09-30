/**
 * TECH, ELECTRIC & GLITCH — the sound of software, AI, electricity and things
 * breaking digitally.
 *
 * A rule this section learned the hard way (see impact-digital): anything that
 * is bit-crushed or sample-held is crushed FIRST and enveloped AFTER. Crushing
 * a decaying signal quantises its tail, and the tail then snaps to zero once
 * it falls below one step — a truncation click hiding inside a glitch.
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, place, sum,
  lp, hp, bp, sat, withRoom, panned, reverse, sampleHold, crush, resample, fadeEdges
} from '../dsp.js';
import { transient } from '../instruments.js';
import { click, tones, hz, layer, layerStereo, crackle, buzz, flickerPattern } from '../engines.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });
const room = (mono, wet = 0.18, size = 0.78, tail = 0.35) => withRoom(norm(mono), { room: size, damp: 0.4, wet, tail });

/** FM: carrier f(t), modulator at `ratio`×, index(t). The workhorse of sci-fi. */
function fm(L, fc, ratio, index) {
  const o = new Float32Array(L);
  let pc = 0, pm = 0;
  for (let i = 0; i < L; i++) {
    const t = i / SR, f = typeof fc === 'function' ? fc(t) : fc;
    o[i] = Math.sin(pc + (typeof index === 'function' ? index(t) : index) * Math.sin(pm));
    pc += (TAU * f) / SR; pm += (TAU * f * ratio) / SR;
  }
  return o;
}

/** Repeat a grain `count` times, each repeat shorter than the last — the classic stutter. */
function stutter(grain, count, shrink = 0.8, gap = 0.002) {
  const parts = [];
  let at = 0, g = grain;
  for (let k = 0; k < count; k++) {
    parts.push([fadeEdges(g, 0.3, 0.5), at, 1 - k * 0.05]);
    at += g.length / SR + gap;
    g = g.slice(0, Math.max(N(0.003), Math.floor(g.length * shrink)));
  }
  return layer(parts);
}

/** Chops a signal with random hard mutes (0.5 ms edges) — a signal dropping in and out. */
function dropouts(r, sig, { on = [0.012, 0.05], off = [0.004, 0.02] } = {}) {
  const g = new Float32Array(sig.length);
  let i = 0;
  while (i < sig.length) {
    const a = N(on[0] + r() * (on[1] - on[0])), b = N(off[0] + r() * (off[1] - off[0])), e = N(0.0015); // 1.5 ms: still an abrupt cut-out, without a click on every edge
    for (let k = 0; k < a && i + k < sig.length; k++) g[i + k] = Math.min(1, k / e, (a - k) / e);
    i += a + b;
  }
  return mul(sig, g);
}

export const SOUNDS = [
  // ---- Sci-Fi & AI ----------------------------------------------------------------------
  S('scifi-ai-activate', 'AI Activate', 'scifi', 'strong', ['ai', 'activate', 'future'], 'a rising FM shimmer resolving into a glassy chord; an AI switching on',
    (r) => {
      const L = N(0.45);
      const rise = mul(fm(L, sweep(300, 1400, 0.4), 2.01, (t) => 3 * (1 - t / 0.45) + 0.4), new Float32Array(L).map((_, i) => Math.pow(i / L, 1.5)));
      const chord = tones(r, [[hz('E5'), 0], [hz('B5'), 0.02], [hz('E6'), 0.04]], { timbre: 'fm', tau: 0.3 });
      return room(layer([[fadeEdges(norm(rise), 0, 4), 0, 0.6], [chord, 0.4, 1]]), 0.26, 0.84, 0.5);
    }),
  S('scifi-ai-process', 'AI Processing', 'scifi', 'medium', ['ai', 'processing', 'thinking'], 'faint data ticks over a slowly shifting tone; an AI thinking',
    (r) => {
      const L = N(1.1);
      const tone = mul(osc(L, (t) => 660 + 110 * Math.sin(TAU * 0.9 * t)), new Float32Array(L).map((_, i) => 0.6 + 0.4 * Math.sin((TAU * 7 * i) / SR)));
      const ticks = [];
      for (let t = 0.03; t < 1.05; t += 0.03 + r() * 0.07) ticks.push([tones(r, [[hz(['E6', 'G6', 'A6', 'C7', 'D7'][Math.floor(r() * 5)]), 0, 0.004]], { timbre: 'sine', tau: 0.005 }), t, 0.3 + 0.4 * r()]);
      return room(mul(sum(L, [norm(tone), 0.45], [norm(layer(ticks)).slice(0, L), 0.7]), envSwell(L, 0.2, 0.35, 1)), 0.2, 0.8, 0.3);
    }),
  S('scifi-pulse', 'Futuristic Pulse', 'scifi', 'medium', ['future', 'pulse', 'tech'], 'a wobbling FM pulse; a futuristic beat',
    () => { const L = N(0.35); return [lp(mul(fm(L, (t) => 220 * (1 + 0.04 * Math.sin(TAU * 18 * t)), 1.5, (t) => 4 * Math.exp(-t / 0.08)), envAD(L, 0.003, 0.07)), 6000)]; }),
  S('scifi-click', 'Futuristic Click', 'scifi', 'micro', ['future', 'click', 'hud'], 'a tiny FM chirp-click; a HUD element snapping in',
    () => { const L = N(0.03); return [mul(fm(L, glide(4000, 2200, 0.004), 1.41, 2), envAD(L, 0.0004, 0.004))]; }),
  S('scifi-holo', 'Holographic Blip', 'scifi', 'medium', ['future', 'hologram', 'blip'], 'a chorused blip with a shimmering tail; a hologram appearing',
    (r) => room(tones(r, [[hz('A6'), 0, 0.02], [hz('A6') * 1.007, 0.001, 0.02, 0.7], [hz('A6') * 0.993, 0.002, 0.02, 0.7]], { timbre: 'sine', tau: 0.07, echo: 0.35, echoDelay: 0.07 }), 0.28, 0.82, 0.4)),
  S('scifi-scan', 'Scan', 'scifi', 'medium', ['scan', 'future', 'analyse'], 'a scanning beam sweeping up and back; analysing, detecting',
    (r) => {
      const L = N(0.9);
      const pos = (t) => Math.sin(Math.PI * Math.min(1, t / 0.9));
      const beam = mul(osc(L, (t) => 900 + 1800 * pos(t)), new Float32Array(L).map((_, i) => 0.55 + 0.45 * Math.sin((TAU * 32 * i) / SR)));
      const hiss = bp(pink(L, r), (t) => 1500 + 3500 * pos(t), 2);
      return room(mul(sum(L, [norm(beam), 0.5], [norm(hiss), 0.5]), envSwell(L, 0.5, 0.12, 1)), 0.16);
    }),
  S('scifi-scan-fast', 'Fast Scan', 'scifi', 'medium', ['scan', 'fast', 'sweep'], 'a quick upward scanning sweep',
    (r) => {
      const L = N(0.35);
      const beam = mul(osc(L, sweep(700, 3200, 0.35)), new Float32Array(L).map((_, i) => 0.5 + 0.5 * Math.sin((TAU * 45 * i) / SR)));
      return [mul(sum(L, [norm(beam), 0.6], [norm(bp(pink(L, r), sweep(1200, 6000, 0.35), 2)), 0.4]), envSwell(L, 0.7, 0.03, 1))];
    }),
  S('scifi-data-pulse', 'Data Pulse', 'scifi', 'medium', ['data', 'pulse', 'tech'], 'a low pulse and a tiny burst of data; information arriving',
    (r) => {
      const L = N(0.12);
      const pulse = mul(lp(osc(L, 165, { shape: 'square', harmonics: 15 }), 1500), envAD(L, 0.002, 0.03));
      const burst = tones(r, [0, 1, 2, 3].map((k) => [hz(['C7', 'E7', 'G7', 'D7'][k]), 0.05 + k * 0.018, 0.004, 0.7]), { timbre: 'sine', tau: 0.004 });
      return [layer([[norm(pulse), 0, 1], [burst, 0, 0.6]])];
    }),
  S('scifi-transfer', 'Data Transfer', 'scifi', 'medium', ['data', 'transfer', 'sync'], 'a stream of blips climbing in pitch; data moving',
    (r) => {
      const notes = [];
      const scale = ['C6', 'D6', 'E6', 'G6', 'A6', 'C7', 'D7', 'E7', 'G7'].map(hz);
      for (let k = 0; k < 22; k++) { const x = k / 22; notes.push([scale[Math.min(scale.length - 1, Math.floor(x * 6 + r() * 3))], k * 0.026, 0.006, 0.5 + 0.5 * x]); }
      return [tones(r, notes, { timbre: 'sine', tau: 0.006 })];
    }),
  S('scifi-boot', 'System Boot', 'scifi', 'strong', ['boot', 'startup', 'system'], 'a click, a filter opening, and a rising chord; a system starting up',
    (r) => {
      const L = N(0.9);
      const pad = mul(lp(sum(L, [osc(L, 110, { shape: 'saw', harmonics: 30 }), 0.5], [osc(L, 110.5, { shape: 'saw', harmonics: 30 }), 0.5]), sweep(200, 3500, 0.8), 1.6), new Float32Array(L).map((_, i) => Math.pow(i / L, 1.2)));
      const chord = tones(r, [[hz('A4'), 0], [hz('E5'), 0.08], [hz('A5'), 0.16], [hz('C#6'), 0.24]], { timbre: 'fm', tau: 0.3 });
      return room(layer([[click(r, { centre: 2500, Q: 1.5, tau: 0.003 }), 0, 0.6], [fadeEdges(norm(pad), 0, 6), 0, 0.5], [chord, 0.6, 1]]), 0.24, 0.82, 0.5);
    }),
  S('scifi-confirm', 'Futuristic Confirm', 'scifi', 'micro', ['confirm', 'future', 'hud'], 'two glassy FM notes with a holographic tail; a futuristic yes',
    (r) => room(tones(r, [[hz('B5'), 0], [hz('F#6'), 0.055]], { timbre: 'fm', tau: 0.08, echo: 0.25, echoDelay: 0.08 }), 0.2)),
  S('scifi-notify', 'Synthetic Notification', 'scifi', 'subtle', ['notification', 'future', 'alert'], 'a glassy synthetic notification with an echo',
    (r) => room(tones(r, [[hz('G#6'), 0], [hz('D#7'), 0.08], [hz('G#6'), 0.16, 0, 0.6]], { timbre: 'fm', tau: 0.07, echo: 0.3, echoDelay: 0.12 }), 0.22)),
  S('scifi-robot', 'Robotic Tone', 'scifi', 'medium', ['robot', 'voice', 'machine'], 'stepped buzzy formant blips; a robot talking',
    (r) => {
      const steps = [hz('C4'), hz('G4'), hz('E4'), hz('A4')];
      const parts = steps.map((f, k) => {
        const L = N(0.085);
        const buzzT = osc(L, f, { shape: 'square', harmonics: 25 });
        const v = sum(L, [norm(bp(buzzT, 700 + 400 * (k % 2), 4)), 1], [norm(bp(buzzT, 1900 - 300 * (k % 2), 5)), 0.7]);
        return [mul(v, envAD(L, 0.003, 0.02, 0.05)), k * 0.09, 1];
      });
      return [layer(parts)];
    }),
  S('scifi-machine', 'Machine Pulse', 'scifi', 'medium', ['machine', 'mechanical', 'industrial'], 'a low mechanical pulse with a clatter; machinery working',
    (r) => {
      const L = N(0.5);
      // A SOFT square gate: sign(sin) switched the hum instantaneously, and
      // every edge was a truncation click. tanh of a scaled sine keeps the
      // chugging shape with a ~2 ms edge.
      const gate = new Float32Array(L).map((_, i) => 0.5 + 0.5 * Math.tanh(3 * Math.sin((TAU * 12 * i) / SR)));
      const hum = mul(hp(lp(osc(L, 110, { shape: 'square', harmonics: 20 }), 1400), 150), gate);
      // The clatter comes on each stroke (the rising half of the cycle), not as
      // the hum falls away, where a grain read as the hum being cut off.
      const stroke = (x) => { const ph = (x * 0.5 * 12) % 1; return ph < 0.3 ? 1 : 0; };
      const clatter = crackle(r, { dur: 0.5, density: 260, centre: 2200, Q: 1, grainTau: 0.0008, amp: stroke }).slice(0, L);
      return [mul(sum(L, [norm(hum), 1], [norm(clatter), 0.5]), envSwell(L, 0.15, 0.15, 1))];
    }),
  S('scifi-neural', 'Neural Pulse', 'scifi', 'subtle', ['ai', 'neural', 'thought'], 'a soft ping that bends up and echoes away; a thought forming',
    (r) => {
      const L = N(0.18);
      const ping = mul(osc(L, glide(700, 1050, 0.03)), envAD(L, 0.002, 0.04));
      return room(layer([[ping, 0, 1], [ping, 0.12, 0.45], [ping, 0.24, 0.2]]), 0.28, 0.82, 0.4);
    }),
  S('scifi-interface', 'Digital Interface', 'scifi', 'medium', ['hud', 'interface', 'populate'], 'a HUD filling in: small tones at scattered moments',
    (r) => {
      const notes = [];
      for (let k = 0; k < 7; k++) notes.push([hz(['C6', 'E6', 'G6', 'B6', 'D7', 'E7'][Math.floor(r() * 6)]), r() * 0.25, 0.008, 0.5 + 0.5 * r()]);
      return room(tones(r, notes, { timbre: 'soft', tau: 0.018 }), 0.14);
    }),

  // ---- Electric & Light --------------------------------------------------------------------
  S('electric-flicker-light', 'Light Flicker', 'electric', 'medium', ['flicker', 'light', 'flash'], 'a bulb buzzing and flickering; flashing text, unstable light',
    (r) => [buzz(r, { dur: 0.7, gate: flickerPattern(r, 0.7), bright: 1800, crackleAmt: 0.15 })]),
  S('electric-flicker-fluo', 'Fluorescent Flicker', 'electric', 'medium', ['flicker', 'fluorescent', 'office'], 'a fluorescent tube stuttering on with ballast tinks',
    (r) => {
      const pat = flickerPattern(r, 0.8, { on: [0.015, 0.05], off: [0.01, 0.04] });
      const hum = buzz(r, { dur: 0.8, gate: pat, bright: 3200, crackleAmt: 0.2 });
      const tinks = [];
      let t = 0;
      for (const [on, off] of pat) { if (r() < 0.5) tinks.push([tones(r, [[4200, 0, 0]], { timbre: 'sine', tau: 0.006 }), t, 0.35]); t += on + off; }
      return [layer([[hum, 0, 1], ...tinks]).slice(0, hum.length)];
    }),
  S('electric-buzz', 'Electrical Buzz', 'electric', 'subtle', ['buzz', 'hum', 'electric'], 'a short mains buzz; a live wire, a sign humming',
    (r) => { const b = buzz(r, { dur: 0.3, bright: 2400, crackleAmt: 0.2 }); return [mul(b, envSwell(b.length, 0.3, 0.06, 1))]; }),
  S('electric-spark', 'Spark', 'electric', 'medium', ['spark', 'electric', 'snap'], 'a sharp electrical spark with a tiny ring',
    (r) => [layer([[norm(crackle(r, { dur: 0.06, density: 6000, centre: 5000, Q: 0.7, grainTau: 0.0003, amp: (x) => Math.exp(-x * 3) })), 0, 1], [tones(r, [[3200, 0, 0]], { timbre: 'sine', tau: 0.01 }), 0, 0.25]])]),
  S('electric-spark-tiny', 'Tiny Spark', 'electric', 'micro', ['spark', 'tiny', 'electric'], 'a tiny crackle of a spark; small, fast flashes',
    (r) => [norm(crackle(r, { dur: 0.025, density: 4000, centre: 5500, Q: 0.8, grainTau: 0.00025, amp: (x) => Math.exp(-x * 3) }))], { gain: -2 }),
  S('electric-zap', 'Electric Zap', 'electric', 'medium', ['zap', 'electric', 'shock'], 'a falling FM zap wrapped in crackle; a jolt of electricity',
    (r) => {
      const L = N(0.14);
      const zap = mul(fm(L, glide(3000, 150, 0.03), 1.73, (t) => 6 * Math.exp(-t / 0.05)), envAD(L, 0.0005, 0.035));
      return [lp(layer([[zap, 0, 1], [norm(crackle(r, { dur: 0.1, density: 3000, centre: 4000, Q: 0.7, grainTau: 0.0004, amp: (x) => 1 - x })), 0, 0.5]]), 10000)];
    }),
  S('electric-crackle', 'Electricity Crackle', 'electric', 'medium', ['crackle', 'electric', 'energy'], 'bursts of electrical crackle; current arcing',
    (r) => {
      // Continuous, not switched: an instant density change made each burst
      // stop dead, which the cut detector correctly called a truncation.
      const bursts = (x) => 800 + 3700 * Math.pow(0.5 + 0.5 * Math.sin(TAU * 3.5 * x + 1), 1.5);
      return [mul(norm(crackle(r, { dur: 0.5, density: bursts, centre: 3500, Q: 0.6, grainTau: 0.0004 })), envSwell(N(0.5), 0.15, 0.2, 1))];
    }),
  S('electric-switch', 'Light Switch', 'electric', 'micro', ['switch', 'light', 'mechanical'], 'a two-stage light switch snap; lights on, a scene changing',
    (r) => [click(r, { centre: 2800, Q: 1.4, tau: 0.003, bodyF: 600, bodyTau: 0.01, bodyMix: 0.6, then: { at: 0.008, centre: 1800, Q: 1.2, tau: 0.004, bodyF: 380, bodyTau: 0.012, bodyMix: 0.7, level: 0.85 } })]),
  S('electric-switch-click', 'Switch Click', 'electric', 'micro', ['switch', 'click', 'small'], 'a small crisp toggle switch',
    (r) => [click(r, { centre: 3600, Q: 2, tau: 0.002, bodyF: 900, bodyTau: 0.005, bodyMix: 0.4 })]),
  S('electric-power-on', 'Power On', 'electric', 'medium', ['power', 'on', 'startup'], 'a click, then a hum and a whine rising up to speed',
    (r) => {
      const L = N(0.6);
      const hum = mul(lp(osc(L, sweep(40, 120, 0.5), { shape: 'square', harmonics: 20 }), 1500), new Float32Array(L).map((_, i) => Math.min(1, i / L * 2)));
      const whine = mul(osc(L, sweep(600, 3200, 0.55)), new Float32Array(L).map((_, i) => 0.3 * Math.pow(i / L, 1.5)));
      return [layer([[click(r, { centre: 2400, Q: 1.3, tau: 0.003, bodyF: 400, bodyTau: 0.01, bodyMix: 0.5 }), 0, 0.8], [fadeEdges(sum(L, [norm(hum), 0.7], [norm(whine), 0.35]), 3, 30), 0.01, 1]])];
    }),
  S('electric-power-off', 'Power Off', 'electric', 'medium', ['power', 'off', 'shutdown'], 'a switch, then the hum and whine winding down to nothing',
    (r) => {
      const L = N(0.7);
      const hum = lp(osc(L, sweep(120, 35, 0.65), { shape: 'square', harmonics: 20 }), 1500);
      const whine = osc(L, sweep(3200, 200, 0.6));
      const fall = new Float32Array(L).map((_, i) => Math.pow(1 - i / L, 1.6));
      return [layer([[click(r, { centre: 2000, Q: 1.3, tau: 0.003, bodyF: 350, bodyTau: 0.01, bodyMix: 0.5 }), 0, 0.8], [mul(sum(L, [norm(hum), 0.7], [norm(whine), 0.3]), fall), 0.005, 1]])];
    }),
  S('electric-pulse', 'Electrical Pulse', 'electric', 'medium', ['electric', 'pulse', 'charge'], 'a short burst of buzz with a crackle edge',
    // Sized by span(): at a flat 80 ms the envelope was still at -18 dB when
    // the buffer ended — the same truncation the chimes had.
    (r) => { const b = buzz(r, { dur: span(0.002, 0.02, 0.03), bright: 3000, crackleAmt: 0.5 }); return [mul(b, envAD(b.length, 0.002, 0.02, 0.03))]; }),
  S('electric-energy', 'Energy Pulse', 'electric', 'strong', ['energy', 'charge', 'power'], 'a charged swell ending in a snap; energy building and releasing',
    (r) => {
      const L = N(0.42);
      const grow = new Float32Array(L).map((_, i) => Math.pow(i / L, 1.8));
      const charge = mul(sum(L, [norm(bp(pink(L, r), sweep(500, 5000, 0.42), 1.5)), 0.6], [norm(fm(L, sweep(200, 1600, 0.42), 2.5, 2)), 0.5]), grow);
      const snap = norm(crackle(r, { dur: 0.04, density: 5000, centre: 4500, Q: 0.7, grainTau: 0.0003, amp: (x) => Math.exp(-3 * x) }));
      return room(layer([[fadeEdges(charge, 0, 3), 0, 1], [snap, 0.42, 0.8]]), 0.14, 0.76, 0.3);
    }),
  S('electric-static', 'Static Burst', 'electric', 'micro', ['static', 'noise', 'burst'], 'a tiny burst of static; a quick cut, interference',
    (r) => { const L = N(0.1); return [mul(sum(L, [norm(lp(white(L, r), 7000)), 0.7], [norm(crackle(r, { dur: 0.1, density: 2000, centre: 4000 })).slice(0, L), 0.5]), envAD(L, 0.001, 0.02, 0.03))]; }, { gain: -1 }),

  // ---- Glitch -----------------------------------------------------------------------------------
  S('glitch-click', 'Glitch Click', 'glitch', 'micro', ['glitch', 'click', 'tech'], 'a click that stutters three times; a glitched tick',
    (r) => [stutter(click(r, { centre: 3500, Q: 1.5, tau: 0.0015 }).slice(0, N(0.004)), 3, 0.8, 0.003)]),
  S('glitch-distort', 'Digital Distortion', 'glitch', 'medium', ['glitch', 'distortion', 'harsh'], 'a chord burst overdriven and crushed; digital distortion',
    () => {
      const L = N(0.2);
      const chord = sum(L, [osc(L, hz('A3'), { shape: 'saw', harmonics: 20 }), 1], [osc(L, hz('E4'), { shape: 'saw', harmonics: 20 }), 1]);
      return [lp(mul(crush(sat(norm(chord), 8), 6), envAD(L, 0.001, 0.05)), 8000)];
    }),
  S('glitch-crackle', 'Digital Crackle', 'glitch', 'medium', ['glitch', 'crackle', 'digital'], 'sparse sample-and-hold spikes; a digital signal crackling',
    (r) => { const L = N(0.3); const spikes = sampleHold(white(L, r).map((v) => (Math.abs(v) > 0.93 ? v : 0)), 12); return [lp(mul(spikes, envSwell(L, 0.2, 0.1, 1)), 9000)]; }),
  S('glitch-static', 'Glitch Static', 'glitch', 'medium', ['glitch', 'static', 'interference'], 'noise chopped into tiny random pieces; interference',
    (r) => { const L = N(0.2); return [lp(mul(dropouts(r, white(L, r), { on: [0.002, 0.008], off: [0.001, 0.008] }), envSwell(L, 0.1, 0.06, 1)), 9000)]; }),
  S('glitch-corrupt', 'Corrupted Signal', 'glitch', 'medium', ['glitch', 'corrupt', 'broken'], 'a tone torn into grains and reshuffled with pitch jumps',
    (r) => {
      const src = osc(N(0.3), 520, { shape: 'square', harmonics: 11 });
      const parts = [];
      let at = 0;
      while (at < 0.28) {
        const d = 0.01 + r() * 0.02, from = Math.floor(r() * (src.length - N(d)));
        let g = src.slice(from, from + N(d));
        if (r() < 0.4) g = resample(g, [0.5, 1.5, 2][Math.floor(r() * 3)]);
        parts.push([fadeEdges(crush(g, 5), 0.3, 0.3), at, 0.6 + 0.4 * r()]);
        at += d + (r() < 0.3 ? r() * 0.01 : 0);
      }
      return [lp(layer(parts), 8000)];
    }),
  S('glitch-interrupt', 'Signal Interruption', 'glitch', 'medium', ['glitch', 'interrupt', 'dropout'], 'a steady tone dropping in and out; a signal breaking up',
    (r) => { const L = N(0.4); const tone = sum(L, [osc(L, 440), 0.7], [osc(L, 880), 0.2], [lp(white(L, r), 3000), 0.08]); return [mul(dropouts(r, tone), envSwell(L, 0.05, 0.12, 1))]; }),
  S('glitch-transmission', 'Transmission Glitch', 'glitch', 'medium', ['glitch', 'radio', 'transmission'], 'a radio-band signal buzzing and cutting out; a transmission failing',
    (r) => {
      const L = N(0.42);
      const radio = mul(sum(L, [norm(bp(white(L, r), 1400, 0.6)), 0.6], [norm(osc(L, 900)), 0.4]), new Float32Array(L).map((_, i) => 0.6 + 0.4 * Math.sin((TAU * 50 * i) / SR)));
      return [mul(dropouts(r, lp(hp(radio, 400), 3200), { on: [0.02, 0.08], off: [0.005, 0.03] }), envSwell(L, 0.1, 0.15, 1))];
    }),
  S('glitch-bitcrush', 'Bitcrush Accent', 'glitch', 'medium', ['glitch', 'bitcrush', 'lofi'], 'a note crushed to three bits; a lo-fi digital accent',
    () => { const L = N(0.2); return [lp(mul(crush(sampleHold(osc(L, hz('A4'), { shape: 'saw', harmonics: 20 }), 4), 3), envAD(L, 0.001, 0.05)), 9000)]; }),
  S('glitch-stutter', 'Digital Stutter', 'glitch', 'medium', ['glitch', 'stutter', 'repeat'], 'a grain repeating faster and faster; the classic stutter edit',
    (r) => { const g = mul(sum(N(0.04), [osc(N(0.04), glide(900, 600, 0.02), { shape: 'square', harmonics: 9 }), 1], [white(N(0.04), r), 0.2]), envAD(N(0.04), 0.001, 0.015)); return [lp(stutter(norm(g), 8, 0.78, 0.004), 9000)]; }),
  S('glitch-scan', 'Scanline', 'glitch', 'medium', ['glitch', 'scan', 'crt'], 'a staircase pitch sweep with a buzz; a scanline rolling',
    () => {
      const L = N(0.36);
      const stepped = (t) => 400 * Math.pow(2, Math.floor((t / 0.36) * 10) / 4);
      return [lp(mul(osc(L, stepped, { shape: 'square', harmonics: 9 }), envSwell(L, 0.2, 0.08, 1)), 6000)];
    }),
  S('glitch-modem', 'Modem Texture', 'glitch', 'medium', ['glitch', 'modem', 'data'], 'fast switching tones and noise; data squealing down a line',
    (r) => {
      const L = N(0.45);
      const freqs = [1270, 2025, 2225];
      let cur = freqs[0];
      const f = (t) => { if (Math.floor(t / 0.008) !== Math.floor((t - 1 / SR) / 0.008)) cur = freqs[Math.floor(r() * 3)]; return cur; };
      const tones_ = osc(L, f);
      return [mul(sum(L, [norm(tones_), 0.7], [norm(dropouts(r, bp(white(L, r), 2500, 1), { on: [0.01, 0.03], off: [0.02, 0.05] })), 0.35]), envSwell(L, 0.05, 0.1, 1))];
    }),
  S('glitch-error', 'Synthetic Error', 'glitch', 'medium', ['glitch', 'error', 'fail'], 'a low crushed buzz falling in two steps; a system error',
    (r) => {
      const L1 = N(0.12), L2 = N(0.16);
      // An octave up from the first version, which lost 7 dB on a phone.
      const a = mul(crush(osc(L1, hz('E4'), { shape: 'square', harmonics: 15 }), 4), envAD(L1, 0.002, 0.04, 0.05));
      const b = mul(crush(osc(L2, hz('C4'), { shape: 'square', harmonics: 15 }), 4), envAD(L2, 0.002, 0.05, 0.06));
      return [lp(layer([[a, 0, 1], [b, 0.12, 1]]), 5000)];
    }),
  S('glitch-malfunction', 'Malfunction', 'glitch', 'strong', ['glitch', 'malfunction', 'breakdown'], 'a tone sliding down while stuttering and cutting out; something breaking',
    (r) => { const L = N(0.6); const tone = osc(L, sweep(900, 110, 0.6), { shape: 'saw', harmonics: 25 }); return [lp(mul(dropouts(r, crush(sampleHold(norm(tone), 3), 5), { on: [0.015, 0.06], off: [0.005, 0.025] }), envSwell(L, 0.05, 0.25, 1)), 7000)]; }),
  S('glitch-transition', 'Glitch Transition', 'glitch', 'medium', ['glitch', 'transition', 'cut'], 'a whoosh chopped by a stutter gate; a digital cut between scenes',
    (r) => {
      const L = N(0.36);
      const air = mul(norm(bp(pink(L, r), sweep(600, 4500, 0.36), 1)), envSwell(L, 0.6, 0.05));
      const gated = dropouts(r, crush(air, 7), { on: [0.008, 0.025], off: [0.004, 0.012] });
      return panned(lp(gated, 9000), (t) => -0.5 + t / 0.36);
    })
];
