/**
 * UI & DIGITAL — an interface vocabulary. Modern product UI, not mobile-game
 * UI: short, soft, mostly sine-based, with meaning carried by DIRECTION (up
 * for on/open/confirm, down for off/close/cancel) rather than by loudness or
 * novelty. Pairs are deliberately mirror images, so a select and a deselect
 * sound like the same control.
 */
import { N, pink, white, osc, glide, envAD, envSwell, mul, norm, sum, lp, hp, bp, withRoom, crush, sampleHold } from '../dsp.js';
import { transient } from '../instruments.js';
import { click, tones, hz, layer, crackle } from '../engines.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, ...extra });

const soft = (r, notes, opts = {}) => tones(r, notes, { timbre: 'soft', tau: 0.02, attack: 0.002, ...opts });
const bellLine = (r, notes, opts = {}) => tones(r, notes, { timbre: 'bell', tau: 0.14, attack: 0.002, ...opts });
const gliding = (f0, f1, dur, hold = 0.01) => { const L = N(dur); return mul(osc(L, glide(f0, f1, dur * 0.25)), envAD(L, 0.002, dur * 0.2, hold)); };
const room = (mono, wet = 0.16, roomSize = 0.74) => withRoom(norm(mono), { room: roomSize, damp: 0.45, wet, tail: 0.3 });

export const SOUNDS = [
  // ---- Interface --------------------------------------------------------------------
  S('ui-hover', 'Hover', 'ui', 'micro', ['ui', 'hover', 'subtle'], 'barely-there tick; a cursor passing over something',
    (r) => [soft(r, [[hz('G6'), 0, 0.004]], { tau: 0.008, timbre: 'sine' })], { gain: -4 }),
  S('ui-click', 'UI Click', 'ui', 'micro', ['ui', 'click', 'button'], 'clean modern UI click; pressing a button on screen',
    (r) => [click(r, { centre: 3000, Q: 2.2, tau: 0.0025, tone: 2000, toneTau: 0.003, toneMix: 0.25 })]),
  S('ui-select', 'Select', 'ui', 'micro', ['ui', 'select', 'choose'], 'two soft rising notes; choosing an option',
    (r) => [soft(r, [[hz('C6'), 0, 0.015], [hz('E6'), 0.04, 0.02]])]),
  S('ui-deselect', 'Deselect', 'ui', 'micro', ['ui', 'deselect', 'cancel'], 'the same two notes falling; undoing a choice',
    (r) => [soft(r, [[hz('E6'), 0, 0.015], [hz('C6'), 0.04, 0.02]])]),
  S('ui-toggle-on', 'Toggle On', 'ui', 'micro', ['ui', 'toggle', 'on'], 'click with a rising blip; switching a setting on',
    (r) => [layer([[click(r, { centre: 2600, Q: 1.8, tau: 0.002 }), 0, 0.7], [gliding(700, 1300, 0.06), 0.004, 0.6]])]),
  S('ui-toggle-off', 'Toggle Off', 'ui', 'micro', ['ui', 'toggle', 'off'], 'click with a falling blip; switching a setting off',
    (r) => [layer([[click(r, { centre: 2200, Q: 1.8, tau: 0.002 }), 0, 0.7], [gliding(1300, 700, 0.06), 0.004, 0.6]])]),
  S('ui-checkbox', 'Checkbox', 'ui', 'micro', ['ui', 'check', 'tick'], 'tiny click and a soft high dot; ticking a box',
    (r) => [layer([[click(r, { centre: 4200, Q: 2, tau: 0.0015 }), 0, 0.7], [soft(r, [[hz('G6'), 0, 0.01]], { tau: 0.015 }), 0.006, 0.5]])]),
  S('ui-dropdown', 'Dropdown', 'ui', 'micro', ['ui', 'menu', 'open'], 'soft falling slide landing on a tiny click; a menu dropping open',
    (r) => [layer([[gliding(1400, 900, 0.07), 0, 0.5], [click(r, { centre: 3500, Q: 2, tau: 0.0015 }), 0.055, 0.5]])]),
  S('ui-open', 'Open', 'ui', 'subtle', ['ui', 'open', 'panel'], 'rising pair with a breath of air; a panel or window opening',
    (r) => {
      const L = N(0.12);
      const air = mul(norm(bp(pink(L, r), 3500, 0.7)), envSwell(L, 0.5, 0.03));
      return [layer([[soft(r, [[hz('G5'), 0, 0.02], [hz('D6'), 0.05, 0.03]]), 0, 1], [air, 0, 0.18]])];
    }),
  S('ui-close', 'Close', 'ui', 'subtle', ['ui', 'close', 'panel'], 'falling pair; a panel or window closing',
    (r) => [soft(r, [[hz('D6'), 0, 0.02], [hz('G5'), 0.05, 0.03]])]),
  S('ui-confirm', 'Confirm', 'ui', 'micro', ['ui', 'confirm', 'ok'], 'a clean rising fifth; confirming an action',
    (r) => [bellLine(r, [[hz('C6'), 0], [hz('G6'), 0.06]], { tau: 0.09 })]),
  S('ui-success', 'UI Success', 'ui', 'subtle', ['ui', 'success', 'done'], 'quick soft major arpeggio; an action succeeded',
    (r) => [bellLine(r, [[hz('C6'), 0], [hz('E6'), 0.05], [hz('G6'), 0.1]], { tau: 0.1 })]),
  S('ui-warning', 'Warning', 'ui', 'subtle', ['ui', 'warning', 'caution'], 'two level mid tones with a slight beat; caution, not alarm',
    (r) => [tones(r, [[hz('A5'), 0, 0.05], [hz('A5'), 0.13, 0.05]], { timbre: 'soft', tau: 0.04, chorus: 0.012 })]),
  S('ui-error', 'Error', 'ui', 'subtle', ['ui', 'error', 'fail'], 'low soft buzz falling a third; something went wrong',
    (r) => [tones(r, [[hz('E4'), 0, 0.06], [hz('C4'), 0.1, 0.08]], { timbre: 'pulse', tau: 0.05, lowpass: 1800 })]),
  S('ui-notification', 'Notification', 'ui', 'subtle', ['ui', 'notification', 'alert'], 'two bell notes with a soft echo; a notification arriving',
    (r) => room(bellLine(r, [[hz('E6'), 0], [hz('B6'), 0.09]], { tau: 0.12, echo: 0.3, echoDelay: 0.13 }))),
  S('ui-message', 'Message Received', 'ui', 'subtle', ['ui', 'message', 'chat'], 'a rounded pop into a soft note; a new message',
    (r) => {
      const L = N(0.06);
      const pop = mul(osc(L, glide(420, 900, 0.012)), envAD(L, 0.001, 0.012));
      return [layer([[pop, 0, 0.8], [soft(r, [[hz('A6'), 0, 0.02]], { tau: 0.04 }), 0.03, 0.6]])];
    }),
  S('ui-upload', 'Upload', 'ui', 'subtle', ['ui', 'upload', 'send'], 'four quiet blips climbing; something going up',
    (r) => [soft(r, [[hz('C6'), 0, 0.008], [hz('E6'), 0.04, 0.008], [hz('G6'), 0.08, 0.008], [hz('C7'), 0.12, 0.015]], { tau: 0.012, timbre: 'sine' })]),
  S('ui-download', 'Download', 'ui', 'subtle', ['ui', 'download', 'receive'], 'the same four blips descending; something coming down',
    (r) => [soft(r, [[hz('C7'), 0, 0.008], [hz('G6'), 0.04, 0.008], [hz('E6'), 0.08, 0.008], [hz('C6'), 0.12, 0.015]], { tau: 0.012, timbre: 'sine' })]),
  S('ui-loading', 'Loading', 'ui', 'subtle', ['ui', 'loading', 'wait'], 'ticks speeding up into a soft blip; loading, then ready',
    (r) => {
      const parts = [];
      let t = 0, gap = 0.09;
      for (let k = 0; k < 6; k++) { parts.push([click(r, { centre: 3800, Q: 2.5, tau: 0.0012 }), t, 0.6]); t += gap; gap *= 0.72; }
      parts.push([soft(r, [[hz('E6'), 0, 0.02]], { tau: 0.04 }), t + 0.02, 0.7]);
      return [layer(parts)];
    }),
  S('ui-processing', 'Processing', 'ui', 'subtle', ['ui', 'processing', 'working'], 'gentle alternating two-note pulse; something working',
    (r) => [soft(r, [0, 1, 2, 3, 4].map((k) => [k % 2 ? hz('D6') : hz('C6'), k * 0.075, 0.012, 1 - k * 0.1]), { tau: 0.02, timbre: 'sine' })]),
  S('ui-save', 'Save', 'ui', 'micro', ['ui', 'save', 'store'], 'soft low thunk with a tick; saving',
    (r) => [layer([[click(r, { centre: 900, Q: 1, tau: 0.004, bodyF: 280, bodyTau: 0.02, bodyMix: 1, lowpass: 3000 }), 0, 1], [click(r, { centre: 3600, Q: 2, tau: 0.0015 }), 0.02, 0.4]])]),
  S('ui-delete', 'Delete', 'ui', 'subtle', ['ui', 'delete', 'trash'], 'a short falling swish and a soft crunch; deleting',
    (r) => {
      const L = N(0.1);
      const swish = mul(norm(bp(pink(L, r), glide(3000, 900, 0.03), 1)), envSwell(L, 0.4, 0.02));
      const crunch = crackle(r, { dur: 0.05, density: 900, centre: 2500, Q: 0.8, grainTau: 0.0006 });
      return [layer([[swish, 0, 0.7], [norm(crunch), 0.07, 0.5]])];
    }),
  S('ui-lock', 'Lock', 'ui', 'micro', ['ui', 'lock', 'secure'], 'a mechanical double click over a low note; locking',
    (r) => [layer([[click(r, { centre: 2400, Q: 1.8, tau: 0.002, bodyF: 500, bodyTau: 0.006, bodyMix: 0.5, then: { at: 0.018, centre: 3000, Q: 2, tau: 0.0018, level: 0.8 } }), 0, 1], [soft(r, [[hz('G4'), 0.02, 0.02]], { tau: 0.05 }), 0, 0.4]])]),
  S('ui-unlock', 'Unlock', 'ui', 'micro', ['ui', 'unlock', 'open'], 'a click and a bright rising note; unlocking',
    (r) => [layer([[click(r, { centre: 2800, Q: 1.8, tau: 0.002 }), 0, 0.9], [gliding(800, 1600, 0.09, 0.02), 0.01, 0.6]])]),

  // ---- Digital ------------------------------------------------------------------------
  S('digital-click', 'Digital Click', 'digital', 'micro', ['tech', 'click', 'synthetic'], 'a single-cycle synthetic click; no acoustic character at all',
    () => { const L = N(0.012); return [lp(mul(osc(L, 1800, { shape: 'square', harmonics: 9 }), envAD(L, 0.0002, 0.0018)), 12000)]; }),
  S('digital-tick', 'Digital Tick', 'digital', 'micro', ['tech', 'tick', 'futuristic'], 'glassy FM tick; futuristic interfaces and data',
    (r) => [tones(r, [[hz('E7'), 0, 0]], { timbre: 'fm', tau: 0.008, attack: 0.0005 })]),
  S('digital-chirp', 'Digital Chirp', 'digital', 'micro', ['tech', 'chirp', 'fast'], 'very fast upward chirp; something digital activating',
    () => { const L = N(0.04); return [mul(osc(L, glide(2000, 8000, 0.01)), envAD(L, 0.0005, 0.008, 0.01))]; }),

  // ---- Success & Reward ---------------------------------------------------------------------
  S('success-chime', 'Success Chime', 'success', 'medium', ['success', 'positive', 'done'], 'clean bell triad in a small room; a clear success',
    (r) => room(bellLine(r, [[hz('C6'), 0], [hz('G6'), 0.07], [hz('C7'), 0.14]], { tau: 0.18 }))),
  S('success-bright', 'Bright Confirmation', 'success', 'medium', ['success', 'bright', 'energy'], 'fast bright four-note run; an energetic yes',
    (r) => room(tones(r, [hz('E6'), hz('G#6'), hz('B6'), hz('E7')].map((f, k) => [f, k * 0.035, 0, 1 - k * 0.1]), { timbre: 'fm', tau: 0.1 }), 0.14)),
  S('success-achieve', 'Achievement', 'success', 'strong', ['success', 'achievement', 'milestone'], 'rising major arpeggio with a shimmer in a larger room; a real milestone',
    (r) => {
      const arp = bellLine(r, [hz('C5'), hz('E5'), hz('G5'), hz('C6'), hz('E6')].map((f, k) => [f, k * 0.07]), { tau: 0.3 });
      const sparkle = tones(r, [[hz('E7'), 0.3], [hz('B7'), 0.34], [hz('G#7'), 0.39]].map(([f, at]) => [f, at, 0, 0.5]), { timbre: 'sine', tau: 0.08 });
      return withRoom(norm(layer([[arp, 0, 1], [sparkle, 0, 0.3]])), { room: 0.82, damp: 0.35, wet: 0.24, tail: 0.5 });
    }),
  S('success-complete', 'Completion', 'success', 'medium', ['success', 'complete', 'resolve'], 'a chord that resolves home; finished, done, closed',
    (r) => room(layer([[bellLine(r, [[hz('G5'), 0], [hz('B5'), 0], [hz('D6'), 0]], { tau: 0.08 }), 0, 0.7], [bellLine(r, [[hz('C6'), 0], [hz('E6'), 0], [hz('G6'), 0]], { tau: 0.25 }), 0.11, 1]]), 0.2)),
  S('success-unlock', 'Unlock Reward', 'success', 'medium', ['success', 'unlock', 'reveal'], 'a click opening into a glassy rising sweep; something unlocked',
    (r) => {
      const L = N(0.35);
      let pc = 0, pm = 0;
      const glass = new Float32Array(L);
      for (let i = 0; i < L; i++) { const t = i / 48000; const f = 900 * Math.pow(2.4, Math.min(1, t / 0.2)); glass[i] = Math.sin(pc + 1.2 * Math.sin(pm)) * Math.min(1, t / 0.01) * Math.exp(-t / 0.12); pc += (6.283185307179586 * f) / 48000; pm += (6.283185307179586 * f * 2.76) / 48000; }
      return room(layer([[click(r, { centre: 2600, Q: 1.6, tau: 0.002, then: { at: 0.015, centre: 3200, tau: 0.0015, level: 0.7 } }), 0, 0.8], [glass, 0.02, 0.8]]), 0.22);
    }),
  S('success-reward', 'Reward', 'success', 'medium', ['success', 'reward', 'warm'], 'a warm bell cluster with a sparkle on top; earned, pleasing',
    (r) => room(layer([[bellLine(r, [[hz('F5'), 0], [hz('A5'), 0.02], [hz('C6'), 0.04], [hz('E6'), 0.06]], { tau: 0.22 }), 0, 1], [tones(r, [[hz('C8'), 0.08, 0, 0.4], [hz('G7'), 0.12, 0, 0.3]], { timbre: 'sine', tau: 0.06 }), 0, 0.4]]), 0.22, 0.8)),
  S('success-elegant', 'Elegant Success', 'success', 'subtle', ['success', 'premium', 'elegant'], 'a single glass note with a long soft shimmer; understated, premium',
    (r) => withRoom(norm(tones(r, [[hz('E6'), 0, 0]], { timbre: 'fm', tau: 0.35 })), { room: 0.84, damp: 0.3, wet: 0.3, tail: 0.5 })),
  S('success-satisfying', 'Satisfying Complete', 'success', 'medium', ['success', 'satisfying', 'tactile'], 'a soft tactile thunk joined by a pure bell; the satisfying finish',
    (r) => room(layer([[click(r, { centre: 1100, Q: 1, tau: 0.004, bodyF: 320, bodyTau: 0.025, bodyMix: 1, lowpass: 3500 }), 0, 1], [bellLine(r, [[hz('C6'), 0.012]], { tau: 0.2 }), 0, 0.6]]), 0.16))
];
