/**
 * CINEMATIC & IMPACT — weight. Everything here is built on the same layered
 * impact (a harmonic pitch-dropping body, a mid-range knock, a transient and
 * a low thump — see instruments.js's impactCore), which is what lets a soft
 * hit and a slam sound like members of one family, and what keeps their low
 * end audible on a phone. Many are deliberately small: a "cinematic" accent
 * under dialogue is felt rather than heard.
 */
import {
  SR, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, sum, lp, hp, bp, sat,
  withRoom, reverb, reverse, crush, sampleHold, fadeEdges
} from '../dsp.js';
import { impactCore, harmonicBody, transient } from '../instruments.js';
import { modal, tones, hz, layer, layerStereo } from '../engines.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });

export const hit = (r, p) => impactCore(r, {
  f0: 130, f1: 58, tauF: 0.02, tauA: 0.12, len: 0.4,
  tr: { centre: 1800, tau: 0.003, gain: 0.45 }, nz: { cutoff: 800, tau: 0.04, gain: 0.3 },
  knock: { freq: 380, tau: 0.02, gain: 0.75 }, drive: 1.9, ...p,
  ...(p.tr ? { tr: { centre: 1800, tau: 0.003, gain: 0.45, ...p.tr } } : {}),
  ...(p.nz ? { nz: { cutoff: 800, tau: 0.04, gain: 0.3, ...p.nz } } : {}),
  ...(p.knock ? { knock: { freq: 380, tau: 0.02, gain: 0.75, ...p.knock } } : {})
});

/** A detuned saw chord stab — the basis of a sting. */
function stab(r, notes, { tau = 0.14, attack = 0.004, cutoff = 3500, detune = 0.006 } = {}) {
  const L = N(span(attack, tau) + 0.01);
  const out = new Float32Array(L);
  for (const f of notes) for (const d of [-detune, 0, detune]) {
    const s = osc(L, f * (1 + d), { shape: 'saw', harmonics: 30 });
    for (let i = 0; i < L; i++) out[i] += s[i];
  }
  return mul(lp(norm(out), glide(cutoff, cutoff * 0.4, tau * 0.8), 1.1), envAD(L, attack, tau));
}

/** A low FM bell — tonal weight without a pitch you would notice as a melody. */
function lowBell(f, tau = 0.4) {
  const L = N(span(0.002, tau));
  const o = new Float32Array(L);
  let pc = 0, pm = 0;
  for (let i = 0; i < L; i++) {
    const t = i / SR;
    o[i] = Math.sin(pc + (2.4 * Math.exp(-t / 0.08) + 0.4) * Math.sin(pm)) * (t < 0.002 ? t / 0.002 : Math.exp(-(t - 0.002) / tau));
    pc += (6.283185307179586 * f) / SR; pm += (6.283185307179586 * f * 1.41) / SR;
  }
  return o;
}

const room = (mono, room = 0.8, wet = 0.2, tail = 0.4) => withRoom(norm(mono), { room, damp: 0.4, wet, tail });

export const SOUNDS = [
  // ---- Impact: a full range, from a tap under a sentence to a slam -------------------
  S('impact-hard', 'Hard Impact', 'impact', 'strong', ['statement', 'punch', 'hard'], 'hard, bright, driven hit; a line that must land',
    // Clearly above Punch: brighter crack, harder drive, 3.5 dB louder.
    (r) => [hit(r, { f0: 180, f1: 64, tauF: 0.014, tauA: 0.1, tr: { centre: 3200, tau: 0.0025, gain: 1 }, knock: { freq: 480, tau: 0.018, gain: 0.95 }, nz: { cutoff: 1800, tau: 0.03, gain: 0.5 }, drive: 3.4 })], { gain: 3.5 }),
  S('impact-thump', 'Low Thump', 'impact', 'subtle', ['statement', 'subtle', 'under-speech'], 'dull low thump with no attack; weight under speech without a hit',
    (r) => [lp(hit(r, { f0: 110, f1: 62, tauA: 0.09, tr: { centre: 800, gain: 0.12 }, knock: { freq: 280, tau: 0.03, gain: 0.9 }, nz: { cutoff: 400, tau: 0.05, gain: 0.3 }, drive: 1.4 }), 2500)], { gain: -2 }),
  S('impact-bass', 'Bass Hit', 'impact', 'strong', ['bass', 'beat', 'weight'], 'deep driven bass hit; a beat landing with a lot of low end',
    // Short and punchy — a bass HIT, where Sub Hit is a bass FEEL.
    (r) => [hit(r, { f0: 95, f1: 50, tauF: 0.03, tauA: 0.14, tr: { centre: 1600, gain: 0.55 }, knock: { freq: 280, tau: 0.03, gain: 0.95 }, nz: { cutoff: 600, tau: 0.06, gain: 0.3 }, drive: 2.6 })], { gain: 1 }),
  S('impact-muted', 'Muted Punch', 'impact', 'medium', ['statement', 'muffled', 'subtle'], 'punch heard through a wall; strong but restrained',
    (r) => [lp(hit(r, { f0: 150, f1: 60, tauF: 0.018, tauA: 0.08, tr: { centre: 2200, gain: 0.6 }, knock: { freq: 420, tau: 0.018, gain: 0.9 }, drive: 2.4 }), 1300)], { gain: -1.5 }),
  S('impact-wood', 'Wooden Hit', 'impact', 'medium', ['wood', 'knock', 'organic'], 'dry wooden block hit; an organic, tactile accent',
    (r) => [layer([[modal(r, { material: 'hollowWood', f: 240, decay: 1.6, strike: 0.5, strikeCentre: 2500 }), 0, 1], [lp(hit(r, { f0: 140, f1: 90, tauA: 0.05, drive: 1.3 }), 3000), 0, 0.5]])]),
  S('impact-metal', 'Metallic Hit', 'impact', 'strong', ['metal', 'clang', 'industrial'], 'short metallic strike; industrial, mechanical moments',
    (r) => room(layer([[modal(r, { material: 'metal', f: 340, decay: 0.6, strike: 0.6, strikeCentre: 5000 }), 0, 0.7], [hit(r, { tauA: 0.08 }), 0, 0.7]]), 0.74, 0.14, 0.3)),
  S('impact-digital', 'Digital Hit', 'impact', 'medium', ['tech', 'synthetic', 'hit'], 'synthetic hit with a crushed transient; tech statements',
    (r) => {
      const h = hit(r, { tauA: 0.09, drive: 2.2 });
      // Crushed FIRST, enveloped AFTER. Crushing an already-decaying tone
      // quantises its tail, and the tail snaps to exactly zero once it falls
      // below one step (~52 ms here) — a truncation click. Enveloping the
      // crushed tone keeps the digital grit and decays it smoothly.
      const Lz = N(0.08);
      const raw = osc(Lz, glide(1400, 180, 0.015), { shape: 'square', harmonics: 11 });
      const zap = mul(crush(sampleHold(norm(raw), 3), 5), envAD(Lz, 0.0005, 0.015));
      // Loud enough to read as DIGITAL: at 0.45 it was masked by the hit.
      const blipTop = mul(osc(N(0.03), 2400, { shape: 'square', harmonics: 7 }), envAD(N(0.03), 0.0005, 0.006));
      return [layer([[h, 0, 0.9], [zap, 0, 0.85], [norm(blipTop), 0, 0.4]])];
    }),
  S('impact-slam-soft', 'Soft Slam', 'impact', 'medium', ['slam', 'door', 'weight'], 'soft broad slam; a heavy object set down, a door closing gently',
    (r) => {
      const L = N(0.35);
      const wash = norm(lp(mul(white(L, r), envAD(L, 0.001, 0.05)), 2500));
      return room(layer([[hit(r, { tauA: 0.13, knock: { freq: 300 } }), 0, 1], [wash, 0, 0.4]]), 0.76, 0.18, 0.35);
    }),
  S('impact-slam', 'Hard Slam', 'impact', 'strong', ['slam', 'hard', 'dramatic'], 'hard slam with a room; a decisive, dramatic stop',
    (r) => {
      const L = N(0.4);
      const wash = norm(lp(mul(white(L, r), envAD(L, 0.0008, 0.06)), 4500));
      return room(sat(norm(layer([[hit(r, { f0: 160, tauA: 0.14, drive: 2.6, knock: { gain: 0.9 } }), 0, 1], [wash, 0, 0.65]])), 1.6), 0.8, 0.24, 0.45);
    }, { gain: 2 }),
  S('impact-snap', 'Snap Impact', 'impact', 'medium', ['snap', 'crisp', 'cut'], 'crisp snap with a short body; a fast cut that lands',
    (r) => [layer([[norm(sat(bp(mul(white(N(0.05), r), envAD(N(0.05), 0.0002, 0.006)), 3000, 0.7), 2)), 0, 0.9], [hit(r, { tauA: 0.05, tr: { gain: 0.2 } }), 0, 0.7]])]),
  S('impact-crack', 'Crack Impact', 'impact', 'strong', ['crack', 'bright', 'sharp'], 'bright cracking hit; a sharp, splitting accent',
    (r) => {
      const L = N(0.08);
      const crack = norm(sat(hp(mul(white(L, r), envAD(L, 0.0001, 0.009)), 1500), 2.5));
      return room(layer([[crack, 0, 1], [hit(r, { tauA: 0.07 }), 0, 0.6]]), 0.74, 0.16, 0.3);
    }),
  S('impact-boom', 'Short Boom', 'impact', 'strong', ['boom', 'cinematic', 'weight'], 'short boom with a room tail; a big beat without an explosion',
    (r) => room(hit(r, { f0: 75, f1: 38, tauF: 0.05, tauA: 0.24, tr: { centre: 900, gain: 0.3 }, knock: { freq: 260, tau: 0.035, gain: 0.7 }, nz: { cutoff: 500, tau: 0.1, gain: 0.35 }, drive: 1.9 }), 0.82, 0.22, 0.5), { gain: 1 }),
  S('impact-sub', 'Sub Hit', 'impact', 'strong', ['sub', 'bass', 'felt'], 'sub-heavy hit, built to still register on a phone; felt more than heard',
    // Soft 6 ms onset and almost no transient, so it arrives as a swell of
    // pressure rather than a hit; the harmonics carry it on a phone.
    () => {
      const L = N(1.1);
      const body = harmonicBody(L, glide(64, 42, 0.06), 0.006, 0.28, [0.4, 0.55, 0.6, 0.58, 0.52, 0.45, 0.38, 0.3, 0.24]);
      return [lp(sat(norm(body), 2.8), 2400)];
    }),

  // ---- Drop ---------------------------------------------------------------------------
  S('drop-micro', 'Micro Drop', 'drop', 'medium', ['punchline', 'beat', 'small'], 'tiny 808-style drop; a quick punchline beat',
    (r) => [lp(sat(norm(harmonicBody(N(0.4), glide(220, 60, 0.04), 0.001, 0.08, [0.8, 0.7, 0.5, 0.35, 0.25, 0.18])), 2.4), 3000)], { gain: -1.5 }),
  S('drop-cinematic', 'Cinematic Drop', 'drop', 'cinematic', ['punchline', 'cinematic', 'reveal'], 'hit falling into a deep tail; a dramatic payoff',
    (r) => {
      const tail = sat(norm(harmonicBody(N(1.2), glide(140, 32, 0.12), 0.002, 0.26, [0.55, 0.65, 0.6, 0.5, 0.4, 0.3, 0.22])), 2.6);
      return room(layer([[hit(r, { tauA: 0.1 }), 0, 0.8], [lp(tail, 2500), 0, 1]]), 0.84, 0.2, 0.5);
    }),
  S('drop-low', 'Low Drop', 'drop', 'strong', ['bass', 'slow', 'down'], 'slow, heavy downward bass slide',
    () => [lp(sat(norm(harmonicBody(N(1.1), glide(120, 34, 0.15), 0.003, 0.3, [0.55, 0.65, 0.6, 0.5, 0.42, 0.34, 0.26, 0.2])), 3), 2600)]),
  S('drop-impact', 'Impact Drop', 'drop', 'strong', ['punchline', 'impact', 'beat'], 'impact with a sub drop behind it; a beat that falls away',
    (r) => [layer([[hit(r, { tauA: 0.08, drive: 2.4 }), 0, 1], [lp(sat(norm(harmonicBody(N(0.8), glide(110, 38, 0.1), 0.002, 0.2, [0.8, 0.6, 0.45, 0.35, 0.25])), 2), 2500), 0.02, 0.8]])]),
  S('drop-tonal', 'Tonal Drop', 'drop', 'medium', ['musical', 'down', 'reveal'], 'a musical tone falling an octave and a half; a graceful let-down',
    () => {
      const L = N(0.7);
      const f = sweep(880, 293, 0.5);
      const tone = sum(L, [osc(L, f), 1], [osc(L, (t) => 2 * f(t)), 0.3], [osc(L, (t) => 3 * f(t)), 0.1]);
      return room(mul(tone, envAD(L, 0.004, 0.18)), 0.78, 0.22, 0.4);
    }),
  S('drop-cutoff', 'Sudden Cutoff', 'drop', 'strong', ['cut', 'silence', 'stop'], 'a swell that stops dead; the silence afterwards is the accent',
    (r) => {
      const L = N(0.4);
      const grow = new Float32Array(L).map((_, i) => Math.pow(i / L, 1.6));
      const bed = sum(L, [norm(bp(pink(L, r), 900, 0.5)), 0.6], [norm(osc(L, 110, { shape: 'saw', harmonics: 20 })), 0.4]);
      return [fadeEdges(mul(lp(bed, 3000), grow), 0, 3)];
    }),

  // ---- Low End: textures, not hits -------------------------------------------------
  S('low-sub-pulse', 'Sub Pulse', 'low', 'subtle', ['bass', 'pulse', 'under-speech'], 'smooth sub pulse; tension or weight under dialogue',
    () => {
      const L = N(0.55);
      // Still a SUB pulse, but with enough upper harmonics that a phone plays
      // its shape — as a bare 50 Hz tone it lost 20 dB on one.
      const body = harmonicBody(L, () => 50, 0.08, 0.14, [0.5, 0.55, 0.5, 0.45, 0.38, 0.3, 0.22]);
      return [lp(sat(mul(norm(body), envSwell(L, 0.3, 0.1, 1)), 1.4), 1200)];
    }),
  S('low-rumble', 'Low Rumble', 'low', 'subtle', ['rumble', 'tension', 'bed'], 'short low rumble that swells and fades; an ominous undercurrent',
    (r) => {
      const L = N(1.3);
      // A low-mid band on top of the sub rumble, so the texture survives a phone.
      const noise = sum(L, [norm(lp(pink(L, r), 180)), 1], [norm(bp(pink(L, r), 260, 0.8)), 0.55]);
      const am = new Float32Array(L).map((_, i) => 0.7 + 0.3 * Math.sin((2 * Math.PI * 3.1 * i) / SR));
      return room(mul(mul(sum(L, [norm(noise), 1], [norm(harmonicBody(L, () => 42, 0.3, 0.5, [0.5, 0.6, 0.4, 0.3])), 0.6]), am), envSwell(L, 0.45, 0.25)), 0.8, 0.12, 0.3);
    }),
  S('low-swell', 'Bass Swell', 'low', 'medium', ['swell', 'build', 'bass'], 'soft bass swell that builds and settles; lead-in to a statement',
    () => {
      const L = N(1.1);
      const grow = new Float32Array(L).map((_, i) => { const x = i / L; return x < 0.8 ? Math.pow(x / 0.8, 2) : Math.exp(-(x - 0.8) * 12); });
      return [lp(sat(mul(norm(harmonicBody(L, sweep(45, 60, 1.1), 0.01, 10, [0.5, 0.55, 0.55, 0.5, 0.42, 0.34, 0.26])), grow), 1.8), 1500)];
    }),
  S('low-thump-deep', 'Deep Thump', 'low', 'medium', ['thump', 'bass', 'heartbeat'], 'single deep round thump; a felt beat',
    (r) => [lp(hit(r, { f0: 70, f1: 48, tauA: 0.14, tr: { centre: 600, gain: 0.1 }, knock: { freq: 230, tau: 0.03, gain: 0.8 }, nz: { cutoff: 300, tau: 0.06, gain: 0.3 }, drive: 1.6 }), 1800)]),

  // ---- Cinematic: caption and title hits ------------------------------------------------
  S('cinematic-hit-soft', 'Soft Cinematic Hit', 'cinematic', 'subtle', ['caption', 'cinematic', 'under-speech'], 'soft cinematic hit with a faint ring; a dramatic touch under a line of dialogue',
    (r) => room(layer([[hit(r, { tauA: 0.14, drive: 1.5, knock: { freq: 320 } }), 0, 1], [modal(r, { material: 'metal', f: 210, decay: 0.8, strike: 0 }), 0, 0.25]]), 0.84, 0.28, 0.5), { gain: -4 }),
  S('cinematic-hit-tonal', 'Tonal Hit', 'cinematic', 'cinematic', ['caption', 'title', 'musical'], 'hit with a low bell chord inside it; a title that has a key',
    (r) => room(layer([[hit(r, { tauA: 0.15 }), 0, 0.9], [lowBell(hz('A2'), 0.45), 0, 0.6], [lowBell(hz('E3'), 0.4), 0, 0.4]]), 0.84, 0.26, 0.5)),
  S('cinematic-hit-elegant', 'Elegant Hit', 'cinematic', 'medium', ['caption', 'premium', 'reveal'], 'soft hit topped with a glass ring; premium, graceful text',
    (r) => room(layer([[hit(r, { tauA: 0.1, drive: 1.4, knock: { freq: 340, gain: 0.6 } }), 0, 0.8], [tones(r, [[hz('E6'), 0.004, 0], [hz('B6'), 0.012, 0, 0.6]], { timbre: 'fm', tau: 0.25 }), 0, 0.35]]), 0.82, 0.3, 0.5)),
  S('cinematic-hit-dramatic', 'Dramatic Hit', 'cinematic', 'cinematic', ['caption', 'dramatic', 'title'], 'big dramatic text hit with metal and a long room',
    (r) => room(layer([[hit(r, { f0: 150, tauA: 0.2, drive: 2.6, knock: { gain: 0.9 } }), 0, 1], [modal(r, { material: 'metal', f: 180, decay: 1.4, strike: 0.3 }), 0, 0.45]]), 0.88, 0.36, 0.8), { gain: 1.5 }),
  S('cinematic-title', 'Title Hit', 'cinematic', 'cinematic', ['title', 'cinematic', 'opening'], 'layered title hit: sub, metal ring, air and a big room; the opening title',
    (r) => {
      const L = N(0.2);
      const air = norm(hp(mul(white(L, r), envAD(L, 0.0005, 0.025)), 3000));
      return room(layer([[hit(r, { f0: 80, f1: 36, tauF: 0.05, tauA: 0.28, drive: 2 }), 0, 1], [modal(r, { material: 'metal', f: 160, decay: 1.6, strike: 0.2 }), 0, 0.5], [air, 0, 0.25]]), 0.9, 0.34, 0.9);
    }, { gain: 1 }),
  S('cinematic-title-reveal', 'Title Reveal', 'cinematic', 'cinematic', ['title', 'reveal', 'build'], 'a reverse swell sucking into a title hit; the full reveal in one sound',
    (r) => {
      const L = N(0.3);
      const bell = norm(sum(L, [lowBell(hz('E4'), 0.12).slice(0, L), 1], [transient(L, r, 3000, 0.03), 0.3]));
      const [wl, wr] = reverb(bell, { room: 0.87, damp: 0.3, tail: 0.8 });
      const keep = N(0.6);
      const swell = [reverse(wl).slice(wl.length - keep), reverse(wr).slice(wr.length - keep)].map((c) => fadeEdges(c, 0, 3));
      const hitSt = room(layer([[hit(r, { tauA: 0.2, drive: 2.2 }), 0, 1], [modal(r, { material: 'metal', f: 180, decay: 1, strike: 0.2 }), 0, 0.4]]), 0.86, 0.3, 0.6);
      return layerStereo([[swell.map(norm), 0, 0.7], [hitSt, 0.6, 1]]);
    }),
  S('cinematic-tick', 'Cinematic Tick', 'cinematic', 'medium', ['tick', 'tension', 'clock'], 'deep clock-like tick in a big room; a dramatic beat of time',
    (r) => room(layer([[modal(r, { material: 'wood', f: 700, decay: 1.2, strike: 0.6, strikeCentre: 3500 }), 0, 1], [norm(harmonicBody(N(0.15), () => 110, 0.001, 0.03, [0.6, 0.6, 0.5])), 0, 0.5]]), 0.86, 0.34, 0.6)),
  S('cinematic-accent', 'Cinematic Accent', 'cinematic', 'subtle', ['caption', 'accent', 'tonal'], 'short low tonal accent with air; cinematic colour under speech',
    (r) => {
      const L = N(0.12);
      const air = mul(norm(bp(pink(L, r), 3000, 0.7)), envSwell(L, 0.2, 0.03));
      return room(layer([[lowBell(hz('D3'), 0.25), 0, 1], [air, 0, 0.3]]), 0.82, 0.28, 0.5);
    }, { gain: -3 }),
  S('cinematic-boom-micro', 'Micro Boom', 'cinematic', 'subtle', ['boom', 'small', 'under-speech'], 'tiny low boom; a cinematic beat small enough for a caption',
    (r) => room(hit(r, { f0: 90, f1: 50, tauA: 0.1, tr: { centre: 900, gain: 0.2 }, drive: 1.5 }), 0.8, 0.2, 0.35), { gain: -3 }),
  S('cinematic-pulse-soft', 'Soft Pulse', 'cinematic', 'subtle', ['pulse', 'tension', 'soft'], 'soft rounded low pulse; gentle tension',
    () => {
      const L = N(0.7);
      const tone = lp(sum(L, [osc(L, 65, { shape: 'saw', harmonics: 30 }), 0.5], [osc(L, 65.3, { shape: 'saw', harmonics: 30 }), 0.5], [osc(L, 130, { shape: 'saw', harmonics: 20 }), 0.35]), 700, 1.5);
      return room(mul(norm(tone), envSwell(L, 0.12, 0.16)), 0.8, 0.18, 0.3);
    }, { gain: -3 }),
  S('cinematic-pulse-deep', 'Deep Pulse', 'cinematic', 'cinematic', ['pulse', 'dark', 'bass'], 'lower, heavier dark pulse than Dark Pulse; a serious turn',
    () => {
      const L = N(1.2);
      const tone = lp(sum(L, [osc(L, 41, { shape: 'saw', harmonics: 40 }), 0.5], [osc(L, 41.3, { shape: 'saw', harmonics: 40 }), 0.5], [osc(L, 82, { shape: 'saw', harmonics: 30 }), 0.5]), glide(1100, 250, 0.3), 2.6);
      return room(sat(mul(norm(tone), envSwell(L, 0.05, 0.3)), 1.5), 0.82, 0.16, 0.4);
    }),
  S('cinematic-shimmer', 'Cinematic Shimmer', 'cinematic', 'subtle', ['shimmer', 'dark', 'premium'], 'dark shimmer over a low bed; a polished cinematic moment, not a sparkle',
    (r) => {
      const L = N(1.1);
      const bed = lp(sum(L, [osc(L, 110, { shape: 'saw', harmonics: 20 }), 0.5], [osc(L, 110.4, { shape: 'saw', harmonics: 20 }), 0.5]), 500);
      const sh = new Float32Array(L);
      [1760, 2217, 2637, 3322].forEach((f, k) => {
        const s = mul(osc(L, f), new Float32Array(L).map((_, i) => 0.5 + 0.5 * Math.sin((2 * Math.PI * (3 + k) * i) / SR)));
        for (let i = 0; i < L; i++) sh[i] += s[i];
      });
      return room(mul(sum(L, [norm(bed), 0.7], [norm(sh), 0.6]), envSwell(L, 0.3, 0.3)), 0.86, 0.34, 0.5);
    }),

  // ---- Sting: short chord stabs ------------------------------------------------------------
  S('sting-short', 'Short Sting', 'sting', 'medium', ['sting', 'editorial', 'punctuation'], 'short minor chord stab; editorial punctuation',
    (r) => room(stab(r, [hz('A3'), hz('C4'), hz('E4')], { tau: 0.12 }), 0.8, 0.22, 0.4)),
  S('sting-soft', 'Soft Sting', 'sting', 'subtle', ['sting', 'soft', 'warm'], 'soft, filtered chord swell; a gentle musical full stop',
    (r) => room(stab(r, [hz('F3'), hz('A3'), hz('C4'), hz('E4')], { tau: 0.2, attack: 0.03, cutoff: 1400 }), 0.82, 0.26, 0.5), { gain: -2 }),
  S('sting-dark', 'Dark Sting', 'sting', 'strong', ['sting', 'dark', 'tension'], 'low minor stab with a hit; bad news, a dark turn',
    (r) => room(layer([[stab(r, [hz('D2'), hz('F2'), hz('A2'), hz('D3')], { tau: 0.25, cutoff: 1800 }), 0, 1], [hit(r, { tauA: 0.12 }), 0, 0.6]]), 0.84, 0.26, 0.6)),
  S('sting-bright', 'Bright Sting', 'sting', 'medium', ['sting', 'positive', 'energy'], 'bright major stab; an upbeat editorial accent',
    (r) => room(stab(r, [hz('C4'), hz('E4'), hz('G4'), hz('C5')], { tau: 0.13, cutoff: 5000 }), 0.8, 0.2, 0.4)),
  S('sting-reveal', 'Reveal Sting', 'sting', 'strong', ['sting', 'reveal', 'success'], 'hit with a major bell chord; a triumphant reveal',
    (r) => room(layer([[hit(r, { tauA: 0.1 }), 0, 0.8], [tones(r, [[hz('C5'), 0], [hz('E5'), 0], [hz('G5'), 0]], { timbre: 'bell', tau: 0.35 }), 0, 0.5]]), 0.84, 0.28, 0.6))
];
