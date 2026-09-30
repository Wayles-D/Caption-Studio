/**
 * TEXT & CAPTIONS — the sounds that sit under words. Every one here is built
 * to repeat on consecutive words ("five / home / office / hacks") without
 * smearing: dry, short, no bass buildup. Caption Accents are the designed
 * exception — small composites for text appearing, landing, emphasising and
 * leaving.
 */
import { N, pink, osc, glide, envAD, envSwell, mul, norm, sum, lp, hp, bp, pluck, withRoom, reverse, fadeEdges, TAU } from '../dsp.js';
import { popBody, transient, harmonicBody } from '../instruments.js';
import { click, tones, hz, layer } from '../engines.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });

// A pop: the pitched sine sweep plus the faint contact that starts it.
function pop(r, { f0, f1, glideTau, tau, attack = 0.0008, tr = 2000, trMix = 0.12, lowpass = 7000, highpass = 0 }) {
  const L = N(attack + tau * 5.76);
  let o = sum(L, [norm(popBody(L, glide(f0, f1, glideTau), attack, tau)), 1], [transient(L, r, tr, 0.0015), trMix]);
  if (highpass) o = hp(o, highpass);
  return [lp(o, lowpass)];
}

export const SOUNDS = [
  // ---- Micro: more contacts, each a different material or weight ----------------
  S('micro-click-tiny', 'Tiny Click', 'micro', 'micro', ['word', 'caption', 'ui'], 'the smallest possible click; dense runs of words',
    // Rounder and lower than Sharp Tick — "tiny" means small, not needle-thin.
    (r) => [click(r, { centre: 4200, Q: 1.5, tau: 0.0015, bodyF: 900, bodyTau: 0.003, bodyMix: 0.35, highpass: 1200 })], { gain: -1 }),
  S('micro-click-soft', 'Soft Click', 'micro', 'micro', ['word', 'caption'], 'rounded soft click with a little body; calm word runs',
    (r) => [click(r, { centre: 2200, Q: 1.4, tau: 0.004, bodyF: 520, bodyTau: 0.008, bodyMix: 0.5, lowpass: 6000 })]),
  S('micro-click-hard', 'Hard Click', 'micro', 'micro', ['word', 'keyword', 'ui'], 'firm click with a bottom-out; a word that should register',
    (r) => [click(r, { centre: 3400, Q: 1.8, tau: 0.003, bodyF: 780, bodyTau: 0.01, bodyMix: 0.6, drive: 2, then: { at: 0.006, centre: 5200, Q: 2, tau: 0.002, level: 0.5 } })], { gain: 1.5 }),
  S('micro-click-muted', 'Muted Click', 'micro', 'micro', ['word', 'subtle', 'under-speech'], 'dull, felt-like click that disappears under speech',
    (r) => [click(r, { centre: 1500, Q: 1, tau: 0.005, bodyF: 300, bodyTau: 0.012, bodyMix: 0.6, lowpass: 2800 })], { gain: -2 }),
  S('micro-tick-sharp', 'Sharp Tick', 'micro', 'micro', ['word', 'caption', 'precise'], 'needle-sharp high tick; precise, fast captions',
    (r) => [click(r, { centre: 7200, Q: 5, tau: 0.0012, tone: 6000, toneTau: 0.0015, toneMix: 0.25, highpass: 3000 })], { gain: -0.5 }),
  S('micro-tap-tiny', 'Tiny Tap', 'micro', 'micro', ['word', 'caption', 'warm'], 'tiny fingertip tap; soft, warm word runs',
    (r) => [click(r, { centre: 1800, Q: 1.2, tau: 0.0025, bodyF: 440, bodyTau: 0.007, bodyMix: 0.8, lowpass: 5000 })], { gain: -1 }),
  S('micro-snap', 'Snap', 'micro', 'micro', ['word', 'keyword', 'punch'], 'crisp finger-snap; a word snapping onto the screen',
    (r) => [click(r, { centre: 2800, Q: 0.7, tau: 0.006, drive: 1.8, highpass: 600, then: { at: 0.0012, centre: 5000, Q: 1, tau: 0.004, level: 0.7 } })], { gain: 1 }),

  // ---- Pop -------------------------------------------------------------------------
  S('pop-tiny', 'Tiny Pop', 'pop', 'micro', ['word', 'caption', 'text-appear'], 'very small quick pop; many words in a row',
    (r) => pop(r, { f0: 1400, f1: 500, glideTau: 0.006, tau: 0.012, tr: 3000, trMix: 0.1 }), { gain: -1.5 }),
  S('pop-muted', 'Muted Pop', 'pop', 'micro', ['word', 'subtle', 'under-speech'], 'dull pop that sits under dialogue',
    // Lower, slower and much darker than Soft Pop: a pop heard through a wall.
    (r) => pop(r, { f0: 520, f1: 150, glideTau: 0.018, tau: 0.04, lowpass: 1400, trMix: 0.03 }), { gain: -2 }),
  S('pop-round', 'Round Pop', 'pop', 'micro', ['word', 'playful', 'bubble'], 'low rising "blup"; softer, rounder and more playful than Bright Pop',
    (r) => pop(r, { f0: 300, f1: 650, glideTau: 0.02, tau: 0.04, attack: 0.002, lowpass: 5000, trMix: 0.06 })),

  // ---- Pluck: pitched, so a run of words carries a little tune -----------------------
  S('pluck-tonal-a', 'Tonal Pluck A', 'pluck', 'micro', ['word', 'musical', 'caption'], 'clear string pluck on A; word runs with a musical lift',
    (r) => [lp(mul(pluck(N(0.35), hz('A5'), r, { brightness: 0.5, decay: 0.996 }), envAD(N(0.35), 0.0005, 0.06)), 6000)]),
  S('pluck-tonal-e', 'Tonal Pluck E', 'pluck', 'micro', ['word', 'musical', 'caption'], 'the same pluck on E, a fifth up; pairs with Pluck A',
    (r) => [lp(mul(pluck(N(0.3), hz('E6'), r, { brightness: 0.5, decay: 0.996 }), envAD(N(0.3), 0.0005, 0.05)), 7000)]),
  S('pluck-soft', 'Soft Pluck', 'pluck', 'micro', ['word', 'warm', 'calm'], 'low warm pluck; calm, cosy videos',
    (r) => [lp(mul(pluck(N(0.5), hz('E4'), r, { brightness: 0.3, decay: 0.997 }), envAD(N(0.5), 0.0008, 0.08)), 3000)]),
  S('pluck-digital', 'Digital Pluck', 'pluck', 'micro', ['word', 'tech', 'synthetic'], 'synthetic filter pluck; tech and app words',
    () => {
      const L = N(0.3);
      const tone = lp(osc(L, hz('E5'), { shape: 'square', harmonics: 15 }), glide(6000, 500, 0.02), 1.2);
      return [mul(norm(tone), envAD(L, 0.001, 0.05))];
    }),
  S('pluck-glass', 'Glass Pluck', 'pluck', 'micro', ['word', 'bright', 'premium'], 'bright glassy pluck; premium, light word runs',
    (r) => [hp(mul(pluck(N(0.22), hz('A6'), r, { brightness: 0.85, decay: 0.994 }), envAD(N(0.22), 0.0004, 0.035)), 600)], { gain: -1 }),

  // ---- Blip: pure synthetic dots --------------------------------------------------------
  S('blip-tiny', 'Tiny Blip', 'blip', 'micro', ['word', 'tech', 'caption'], 'tiny pure blip; minimal tech captions',
    (r) => [tones(r, [[hz('E7'), 0, 0.008]], { timbre: 'sine', tau: 0.004, attack: 0.0008 })]),
  S('blip-soft', 'Soft Blip', 'blip', 'micro', ['word', 'ui', 'gentle'], 'gentle rounded blip',
    (r) => [tones(r, [[hz('A5'), 0, 0.02]], { timbre: 'soft', tau: 0.012, attack: 0.002 })]),
  S('blip-double', 'Double Blip', 'blip', 'micro', ['word', 'ui', 'confirm'], 'two quick identical blips; a small confirmation',
    (r) => [tones(r, [[hz('E6'), 0, 0.012], [hz('E6'), 0.045, 0.012]], { timbre: 'soft', tau: 0.008, attack: 0.001 })]),
  S('blip-up', 'Rising Blip', 'blip', 'micro', ['word', 'positive', 'appear'], 'blip that slides up; something appearing or turning on',
    () => { const L = N(0.07); return [mul(osc(L, glide(900, 1800, 0.012)), envAD(L, 0.001, 0.014, 0.012))]; }),
  S('blip-down', 'Falling Blip', 'blip', 'micro', ['word', 'disappear', 'off'], 'blip that slides down; something leaving or turning off',
    () => { const L = N(0.07); return [mul(osc(L, glide(1800, 900, 0.012)), envAD(L, 0.001, 0.014, 0.012))]; }),

  // ---- Caption Accents: text appearing, landing, emphasising, leaving -----------------
  S('caption-appear', 'Caption Appear', 'caption', 'micro', ['caption', 'appear', 'word'], 'tiny click with a breath of air; a caption appearing',
    (r) => {
      const c = click(r, { centre: 4200, Q: 2, tau: 0.002, highpass: 1500 });
      const L = N(0.07);
      const air = mul(norm(bp(pink(L, r), 5000, 0.8)), envSwell(L, 0.3, 0.012));
      return [layer([[c, 0, 1], [air, 0, 0.25]])];
    }),
  S('caption-appear-tonal', 'Tonal Appear', 'caption', 'micro', ['caption', 'appear', 'musical'], 'tick with a short pitched ring; a caption appearing with a note',
    (r) => [layer([[click(r, { centre: 2600, Q: 1.5, tau: 0.003 }), 0, 1], [tones(r, [[hz('C6'), 0, 0]], { timbre: 'bell', tau: 0.05 }), 0.001, 0.6]])]),
  S('caption-settle', 'Caption Settle', 'caption', 'micro', ['caption', 'land', 'settle'], 'soft small thump; text landing and settling into place',
    (r) => {
      const L = N(0.2);
      // Pitched up into the band a phone plays, with a small knock on top —
      // at 190 Hz it lost 9 dB on a phone speaker.
      const thump = norm(harmonicBody(L, glide(300, 200, 0.02), 0.0015, 0.03, [0.8, 0.6, 0.35]));
      const knock = norm(bp(mul(pink(L, r), envAD(L, 0.0005, 0.012)), 520, 1.3));
      return [lp(layer([[thump, 0, 1], [knock, 0, 0.4], [click(r, { centre: 2400, Q: 1.2, tau: 0.002 }), 0, 0.35]]), 4500)];
    }),
  S('caption-emphasis', 'Caption Emphasis', 'caption', 'micro', ['caption', 'emphasis', 'keyword'], 'micro pop with a tiny tonal tail; the emphasised word in a caption',
    (r) => [layer([[pop(r, { f0: 1000, f1: 280, glideTau: 0.01, tau: 0.024 })[0], 0, 1], [tones(r, [[hz('E6'), 0, 0]], { timbre: 'bell', tau: 0.07 }), 0.012, 0.3]])]),
  S('caption-reveal', 'Caption Reveal', 'caption', 'subtle', ['caption', 'reveal', 'polish'], 'tiny click and a faint tonal shimmer; a caption revealing',
    (r) => {
      const c = click(r, { centre: 4000, Q: 2, tau: 0.002, highpass: 1500 });
      const sparkle = tones(r, [[hz('E7'), 0.004], [hz('G#7'), 0.018], [hz('B7'), 0.03]].map(([f, at]) => [f, at, 0, 0.6]), { timbre: 'sine', tau: 0.05 });
      return withRoom(norm(layer([[c, 0, 1], [sparkle, 0, 0.35]])), { room: 0.72, damp: 0.4, wet: 0.18, tail: 0.25 });
    }, { usage: 'word' }),
  S('caption-disappear', 'Caption Disappear', 'caption', 'micro', ['caption', 'disappear', 'out'], 'reverse breath into a falling blip; a caption leaving',
    (r) => {
      const L = N(0.08);
      const air = reverse(mul(norm(bp(pink(L, r), 4200, 0.9)), envSwell(L, 0.15, 0.02)));
      const fall = mul(osc(N(0.04), glide(1600, 700, 0.01)), envAD(N(0.04), 0.001, 0.008));
      return [fadeEdges(layer([[air, 0, 0.5], [fall, 0.06, 0.6]]), 0.5, 2)];
    }),
  S('caption-accent', 'Subtitle Accent', 'caption', 'subtle', ['caption', 'cinematic', 'subtle'], 'very soft low tonal hit; a cinematic touch under a subtitle without drama',
    (r) => {
      const L = N(0.5);
      const body = norm(harmonicBody(L, glide(98, 82, 0.03), 0.004, 0.09, [0.4, 0.6, 0.6, 0.55, 0.45, 0.35, 0.25]));
      const knock = norm(bp(mul(pink(L, r), envAD(L, 0.001, 0.02)), 380, 1.2));
      return withRoom(norm(lp(layer([[body, 0, 1], [knock, 0, 0.55]]), 3000)), { room: 0.78, damp: 0.5, wet: 0.2, tail: 0.3 });
    }, { gain: -2 })
];
