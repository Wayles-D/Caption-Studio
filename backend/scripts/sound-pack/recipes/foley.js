/**
 * FOLEY — the literal sounds of things: writing and drawing, paper, keyboards
 * and phones, objects on a desk, cameras, and stops/interruptions.
 *
 * Every sound here is marked `literal: true`: it depicts a specific physical
 * event, so it belongs where that event is on screen or named (a pencil
 * drawing, "type it in", a camera flash), not as a general accent. The AI
 * director gets these by name for exactly that reason.
 *
 * All synthesised, so the honest ceiling is "convincing at editing distance,
 * under speech": the writing and paper sounds are modelled on the physics
 * (texture × tool speed; Poisson crackle) rather than recorded, and they are
 * the least certain sounds in the pack.
 *
 * The STOP family applies tape, record and buffer effects to the engine's
 * synthetic music bed (engines.js musicBed): the effect is the sound, so
 * what it acts on only has to read as "music".
 */
import {
  SR, TAU, N, white, pink, osc, glide, sweep, span, envAD, envSwell, mul, scale, norm, sum,
  lp, hp, bp, sat, withRoom, panned, sampleHold, crush, fadeEdges
} from '../dsp.js';
import { transient } from '../instruments.js';
import { click, modal, crackle, friction, tones, servo, varispeed, musicBed, layer, layerStereo, hz } from '../engines.js';
import { hit } from './cinematic.js';

const S = (id, label, family, tier, tags, use, render, extra = {}) => ({ id, label, family, tier, tags, use, render, literal: true, ...extra });
const room = (mono, wet = 0.15, size = 0.6, tail = 0.3) => withRoom(norm(mono), { room: size, damp: 0.5, wet, tail });
const W = (tool, gesture, dur) => (r) => [friction(r, { tool, gesture, dur })];

/** A mechanical key: press (contact + housing) and a quieter release. */
function key(r, { centre = 2600, body = 380, release = 0.05, relLevel = 0.45, soft = false } = {}) {
  return click(r, {
    centre, Q: soft ? 1 : 1.5, tau: soft ? 0.004 : 0.003, bodyF: body, bodyMix: soft ? 0.8 : 0.6, bodyTau: 0.012,
    lowpass: soft ? 5000 : 0,
    then: { at: release, centre: centre * 1.4, Q: 2, tau: 0.002, level: relLevel, lowpass: soft ? 5000 : 0 }
  });
}
/** A run of keystrokes at random intervals — typing. */
function typing(r, count, gap, spread) {
  const parts = [];
  let t = 0;
  for (let k = 0; k < count; k++) {
    parts.push([key(r, { centre: 2200 + r() * 1100, body: 300 + r() * 150, release: 0.035 + r() * 0.035, relLevel: 0.3 + r() * 0.3 }), t, 0.6 + 0.4 * r()]);
    t += gap + r() * spread;
  }
  return layer(parts);
}
/** A slice of the music bed, faded at both ends so a slice never clicks. */
const slice = (src, t0, d, ms = 2) => fadeEdges(src.slice(N(t0), N(t0) + N(d)), ms, ms);

export const SOUNDS = [
  // ---- WRITING ----------------------------------------------------------------
  S('writing-pencil-write', 'Pencil Writing', 'writing', 'subtle', ['pencil', 'writing', 'handwriting', 'notes'], 'a pencil writing a few words; handwritten text, notes being taken', W('pencil', 'write', 1.2)),
  S('writing-pencil-scribble', 'Pencil Scribble', 'writing', 'subtle', ['pencil', 'scribble', 'sketch', 'doodle'], 'a pencil scribbling back and forth; a quick sketch or crossing-out', W('pencil', 'scribble', 0.8)),
  S('writing-pencil-stroke', 'Pencil Stroke', 'writing', 'micro', ['pencil', 'stroke', 'line', 'word'], 'a single short pencil stroke; one line drawn, safe on consecutive words', W('pencil', 'stroke', 0.3)),
  S('writing-pencil-underline', 'Pencil Underline', 'writing', 'subtle', ['pencil', 'underline', 'emphasis', 'key-word'], 'a quick decisive pencil underline; emphasising a key word', W('pencil', 'underline', 0.45)),
  S('writing-pencil-circle', 'Pencil Circle', 'writing', 'subtle', ['pencil', 'circle', 'highlight', 'annotate'], 'a pencil drawing a loop round something; circling the important part', W('pencil', 'circle', 0.7)),
  S('writing-pencil-check', 'Pencil Tick', 'writing', 'subtle', ['pencil', 'check', 'tick', 'done'], 'a pencil tick mark, short then long; ticking a box, done', W('pencil', 'check', 0.4)),
  S('writing-pencil-cross', 'Pencil Cross', 'writing', 'subtle', ['pencil', 'cross', 'x', 'wrong'], 'two crossing pencil strokes; an X, crossing something out', W('pencil', 'cross', 0.5)),
  S('writing-pencil-scratch', 'Pencil Scratch', 'writing', 'subtle', ['pencil', 'scratch', 'hatch', 'shade'], 'quick scratchy hatching strokes; shading, scratching out', W('pencil', 'scratch', 0.5)),
  S('writing-graphite-shade', 'Graphite Shading', 'writing', 'subtle', ['graphite', 'shade', 'sketch', 'art'], 'soft graphite shading with fast strokes; an artist sketching', W('graphite', 'scribble-fast', 1.0)),
  S('writing-pen-write', 'Pen Writing', 'writing', 'subtle', ['pen', 'writing', 'signature', 'notes'], 'a ballpoint pen writing; a signature, a note, smoother than pencil', W('pen', 'write', 1.0)),
  S('writing-pen-stroke', 'Pen Stroke', 'writing', 'micro', ['pen', 'stroke', 'line', 'word'], 'a single smooth pen stroke; one line, safe on consecutive words', W('pen', 'stroke', 0.3)),
  S('writing-pen-underline', 'Pen Underline', 'writing', 'subtle', ['pen', 'underline', 'emphasis', 'key-word'], 'a clean pen underline; emphasis in ink', W('pen', 'underline', 0.45)),
  S('writing-pen-check', 'Pen Tick', 'writing', 'subtle', ['pen', 'check', 'tick', 'approved'], 'a pen tick mark; approved, correct', W('pen', 'check', 0.4)),
  S('writing-marker-stroke', 'Marker Stroke', 'writing', 'subtle', ['marker', 'stroke', 'whiteboard', 'line'], 'a felt marker stroke with a faint squeak; a whiteboard line', W('marker', 'stroke', 0.4)),
  S('writing-marker-scribble', 'Marker Scribble', 'writing', 'subtle', ['marker', 'scribble', 'whiteboard', 'fill'], 'a marker scribbling to fill a shape; colouring in, a whiteboard doodle', W('marker', 'scribble-slow', 0.8)),
  S('writing-marker-underline', 'Marker Underline', 'writing', 'subtle', ['marker', 'underline', 'highlight', 'emphasis'], 'a bold felt-tip underline; highlighter emphasis', W('marker', 'underline', 0.5)),
  S('writing-marker-circle', 'Marker Circle', 'writing', 'subtle', ['marker', 'circle', 'highlight', 'annotate'], 'a marker drawing a loop; circling something on a whiteboard', W('marker', 'circle', 0.7)),
  S('writing-marker-check', 'Marker Tick', 'writing', 'subtle', ['marker', 'check', 'tick', 'done'], 'a marker tick; checking off a list on a board', W('marker', 'check', 0.45)),
  S('writing-marker-cross', 'Marker Cross', 'writing', 'subtle', ['marker', 'cross', 'x', 'wrong'], 'a marker X; crossing out a wrong answer', W('marker', 'cross', 0.55)),
  S('writing-chalk-write', 'Chalk Writing', 'writing', 'subtle', ['chalk', 'writing', 'blackboard', 'school'], 'chalk writing on a blackboard with knocks on each stroke; a lesson, a formula', W('chalk', 'write', 1.2)),
  S('writing-chalk-stroke', 'Chalk Stroke', 'writing', 'subtle', ['chalk', 'stroke', 'blackboard', 'line'], 'a single gritty chalk line with a knock; a line on the board', W('chalk', 'stroke', 0.45)),
  S('writing-brush-stroke', 'Brush Stroke', 'writing', 'subtle', ['brush', 'stroke', 'dry-brush', 'art'], 'a soft dry-brush sweep of bristles; a painterly swipe', W('brush', 'stroke', 0.6)),
  S('writing-paint-stroke', 'Paint Stroke', 'writing', 'subtle', ['paint', 'stroke', 'wet', 'art'], 'a wet paint stroke; loaded brush on canvas', W('paint', 'stroke', 0.7)),

  // ---- PAPER ------------------------------------------------------------------
  S('paper-rustle', 'Paper Rustle', 'paper', 'subtle', ['paper', 'rustle', 'handle', 'documents'], 'a sheet of paper handled and rustled; documents, notes',
    (r) => {
      const L = N(0.7);
      const cr = crackle(r, { dur: 0.66, density: (x) => 400 + 1800 * Math.pow(Math.sin(Math.PI * x), 2) * (0.6 + 0.4 * Math.sin(TAU * 3 * x)), centre: 3000, Q: 0.6, grainTau: 0.001, amp: (x) => Math.sin(Math.PI * x) }).slice(0, L);
      const swish = mul(norm(bp(pink(L, r), 2200, 0.7)), envSwell(L, 0.45, 0.1));
      return [sum(L, [norm(cr), 1], [swish, 0.35])];
    }),
  S('paper-crumple', 'Paper Crumple', 'paper', 'medium', ['paper', 'crumple', 'discard', 'frustration'], 'a sheet crushed into a ball in bursts; discarding an idea, frustration',
    (r) => {
      const dur = 0.9, L = N(dur);
      // Crushing comes in squeezes: density follows a few overlapping pulses.
      const bursts = [0.08, 0.3, 0.5, 0.7].map((c) => [c, 0.08 + r() * 0.06]);
      const dens = (x) => 300 + 6000 * bursts.reduce((a, [c, w]) => a + Math.exp(-(((x * dur - c) / w) ** 2)), 0);
      const cr = crackle(r, { dur: dur - 0.04, density: dens, centre: 2400, Q: 0.5, grainTau: 0.0012, spread: 2 }).slice(0, L);
      const crinkle = crackle(r, { dur: dur - 0.04, density: (x) => dens(x) * 0.5, centre: 6000, Q: 0.8, grainTau: 0.0003 }).slice(0, L);
      return [sum(L, [norm(cr), 1], [norm(crinkle), 0.4])];
    }),
  S('paper-tear', 'Paper Tear', 'paper', 'medium', ['paper', 'tear', 'rip', 'reveal'], 'a sheet of paper torn slowly across; a rip reveal, tearing up a plan',
    (r) => {
      const dur = 0.5, L = N(dur + 0.02);
      const fib = crackle(r, { dur, density: (x) => 3000 + 9000 * x, centre: 2600, Q: 0.5, grainTau: 0.0005, amp: (x) => 0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, x * 1.1)) }).slice(0, L);
      const jitter = lp(white(L, r), 40).map((v) => 0.6 + 5 * v);
      const body = mul(norm(bp(pink(L, r), 1600, 0.6)), envSwell(L, 0.7, 0.03, 1.2));
      return [mul(sum(L, [norm(fib), 1], [body, 0.5]), jitter.map((v) => Math.max(0.1, v)))].map((c) => fadeEdges(c, 3, 10));
    }),
  S('paper-tear-fast', 'Quick Rip', 'paper', 'medium', ['paper', 'rip', 'fast', 'reveal'], 'a quick hard rip; tearing a page out in one pull',
    (r) => {
      const dur = 0.18, L = N(dur + 0.02);
      const fib = crackle(r, { dur, density: 12000, centre: 2400, Q: 0.5, grainTau: 0.0005, amp: (x) => Math.sin(Math.PI * x) }).slice(0, L);
      const body = mul(norm(bp(pink(L, r), 1500, 0.6)), envSwell(L, 0.5, 0.02));
      return [sum(L, [norm(fib), 1], [body, 0.6])].map((c) => fadeEdges(c, 2, 8));
    }),
  S('paper-page-turn', 'Page Turn', 'paper', 'subtle', ['page', 'turn', 'book', 'next'], 'a book page turning over and settling; the next chapter, the next point',
    (r) => {
      const L = N(0.5);
      const sw = mul(norm(bp(pink(L, r), sweep(900, 2600, 0.35), 0.8)), envSwell(L, 0.55, 0.07));
      const flutter = crackle(r, { dur: 0.3, density: 1500, centre: 3200, Q: 0.7, grainTau: 0.0008, amp: (x) => Math.sin(Math.PI * x) });
      const slap = mul(norm(bp(white(N(0.06), r), 1100, 0.8)), envAD(N(0.06), 0.001, 0.01));
      return [layer([[sw, 0, 1], [flutter, 0.12, 0.5], [slap, 0.36, 0.5]])];
    }),
  S('paper-flick', 'Paper Flick', 'paper', 'micro', ['paper', 'flick', 'snap', 'word'], 'a sheet of paper flicked with a finger; a crisp tiny snap, repeatable',
    (r) => {
      const L = N(span(0.0005, 0.012));
      return [layer([[mul(norm(bp(white(L, r), 1300, 1)), envAD(L, 0.0005, 0.012)), 0, 1], [crackle(r, { dur: 0.025, density: 3000, centre: 4000, Q: 0.8, grainTau: 0.0005 }), 0.001, 0.4]])];
    }),
  S('paper-slide', 'Paper Slide', 'paper', 'subtle', ['paper', 'slide', 'hand-over', 'desk'], 'a sheet slid across a desk; handing something over',
    (r) => { const L = N(0.4); return [mul(norm(bp(pink(L, r), 2200, 0.8)), envSwell(L, 0.4, 0.06, 1.5))]; }),
  S('paper-fold', 'Paper Fold', 'paper', 'subtle', ['paper', 'fold', 'crease', 'letter'], 'a sheet folded and its crease pressed flat; folding a letter',
    (r) => {
      const crease = crackle(r, { dur: 0.07, density: 5000, centre: 2800, Q: 0.6, grainTau: 0.0008, amp: (x) => Math.exp(-x * 2) });
      const L = N(0.2);
      const press = mul(norm(bp(pink(L, r), 1800, 0.9)), envSwell(L, 0.5, 0.03));
      return [layer([[crease, 0, 1], [press, 0.12, 0.5], [crackle(r, { dur: 0.05, density: 3000, centre: 3200, Q: 0.7, grainTau: 0.0006 }), 0.2, 0.4]])];
    }),
  S('paper-crinkle', 'Tiny Crinkle', 'paper', 'micro', ['paper', 'crinkle', 'tiny', 'word'], 'a tiny crinkle of paper; a light textured touch on a word',
    (r) => [crackle(r, { dur: 0.12, density: (x) => 5000 * Math.sin(Math.PI * x) + 200, centre: 3800, Q: 0.7, grainTau: 0.0006, amp: (x) => Math.sin(Math.PI * x) })]),
  S('paper-stamp', 'Rubber Stamp', 'paper', 'medium', ['stamp', 'approved', 'official', 'done'], 'a rubber stamp thumped down on paper; approved, official, done',
    (r) => {
      const thud = lp(hit(r, { f0: 170, f1: 90, tauA: 0.05, len: 0.25, tr: { centre: 1500, gain: 0.3 }, knock: { freq: 420, tau: 0.02, gain: 1 }, nz: { cutoff: 900, tau: 0.02 }, drive: 1.6 }), 3500);
      const slap = mul(norm(bp(white(N(0.05), r), 1800, 0.7)), envAD(N(0.05), 0.0005, 0.008));
      return [layer([[thud, 0, 1], [slap, 0, 0.5]])];
    }),
  S('paper-sticky-note', 'Sticky Note', 'paper', 'subtle', ['sticky-note', 'peel', 'reminder', 'note'], 'a sticky note peeled off the pad and pressed on; a reminder, a note added',
    (r) => {
      const peel = crackle(r, { dur: 0.14, density: (x) => 1500 + 6000 * x, centre: 3000, Q: 0.6, grainTau: 0.0005, amp: (x) => Math.sin(Math.PI * x) });
      const pat = click(r, { centre: 900, Q: 0.8, tau: 0.006, lowpass: 3000 });
      return [layer([[peel, 0, 1], [pat, 0.28, 0.6]])];
    }),

  // ---- DEVICE -----------------------------------------------------------------
  S('device-key-press', 'Key Press', 'device', 'micro', ['keyboard', 'key', 'mechanical', 'word'], 'a single mechanical keyboard key, press and release; one word typed, repeatable',
    (r) => [key(r)]),
  S('device-key-soft', 'Laptop Key', 'device', 'micro', ['keyboard', 'laptop', 'soft', 'word'], 'a soft laptop key press; quiet typing on a word',
    (r) => [key(r, { centre: 1800, body: 300, soft: true, relLevel: 0.25 })], { gain: -1 }),
  S('device-typing', 'Typing', 'device', 'subtle', ['typing', 'keyboard', 'working', 'search'], 'a short burst of typing on a mechanical keyboard; searching, writing, working',
    (r) => [typing(r, 12, 0.07, 0.07)]),
  S('device-typing-fast', 'Fast Typing', 'device', 'subtle', ['typing', 'fast', 'hacker', 'busy'], 'rapid typing; busy, focused, a hacker montage',
    (r) => [typing(r, 22, 0.035, 0.04)]),
  S('device-enter', 'Enter Key', 'device', 'medium', ['keyboard', 'enter', 'submit', 'go'], 'a big stabilised Enter key hit with conviction; submit, send, go',
    (r) => [click(r, { centre: 2000, Q: 1.3, tau: 0.004, bodyF: 260, bodyMix: 0.9, bodyTau: 0.016, then: { at: 0.008, centre: 3500, Q: 2, tau: 0.002, level: 0.35, then: { at: 0.085, centre: 2800, Q: 1.8, tau: 0.002, bodyF: 320, bodyMix: 0.4, level: 0.6 } } })]),
  S('device-backspace', 'Backspace', 'device', 'subtle', ['keyboard', 'delete', 'backspace', 'undo'], 'three quick taps of the same key; deleting, backing up, second thoughts',
    (r) => [layer([0, 0.085, 0.17].map((t, k) => [key(r, { centre: 2500, body: 350, release: 0.035, relLevel: 0.3 }), t, 1 - k * 0.1]))]),
  S('device-space', 'Space Bar', 'device', 'micro', ['keyboard', 'space', 'thock', 'word'], 'a deep space-bar thock with a little rattle; a heavier key on a word',
    (r) => [click(r, { centre: 1500, Q: 1.2, tau: 0.004, bodyF: 190, bodyMix: 1, bodyTau: 0.02, then: { at: 0.006, centre: 4200, Q: 3, tau: 0.0015, level: 0.25 } })]),
  S('device-mouse-click', 'Mouse Click', 'device', 'micro', ['mouse', 'click', 'select', 'word'], 'a crisp mouse button click and release; clicking a link, selecting, repeatable',
    (r) => [click(r, { centre: 4500, Q: 3, tau: 0.0015, bodyF: 1200, bodyMix: 0.3, bodyTau: 0.005, then: { at: 0.07, centre: 5200, Q: 3, tau: 0.001, level: 0.5 } })]),
  S('device-mouse-double', 'Double Click', 'device', 'subtle', ['mouse', 'double-click', 'open', 'launch'], 'a mouse double-click; opening a file, launching an app',
    (r) => { const c = () => click(r, { centre: 4500, Q: 3, tau: 0.0015, bodyF: 1200, bodyMix: 0.3, bodyTau: 0.005, then: { at: 0.045, centre: 5200, Q: 3, tau: 0.001, level: 0.45 } }); return [layer([[c(), 0, 1], [c(), 0.11, 0.9]])]; }),
  S('device-mouse-scroll', 'Scroll Wheel', 'device', 'subtle', ['mouse', 'scroll', 'wheel', 'browse'], 'a mouse wheel rolled a few notches; scrolling, browsing a feed',
    (r) => [layer(Array.from({ length: 8 }, (_, k) => [click(r, { centre: 3800 + 300 * r(), Q: 4, tau: 0.0009, bodyF: 1500, bodyMix: 0.2, bodyTau: 0.003 }), k * (0.028 + 0.006 * r()), 0.6 + 0.4 * Math.sin((Math.PI * (k + 0.5)) / 8)]))]),
  S('device-trackpad-tap', 'Trackpad Tap', 'device', 'micro', ['trackpad', 'tap', 'soft', 'word'], 'a soft trackpad tap; a quiet click on a word',
    (r) => [click(r, { centre: 1200, Q: 1, tau: 0.004, bodyF: 500, bodyMix: 0.6, bodyTau: 0.008, lowpass: 3000 })], { gain: -1 }),
  S('device-phone-tap', 'Screen Tap', 'device', 'micro', ['phone', 'tap', 'touch', 'word'], 'a fingertip tapping a phone screen; touch, tap, repeatable on words',
    (r) => [click(r, { centre: 2500, Q: 1, tau: 0.0015, tone: 1800, toneMix: 0.15, toneTau: 0.004, bodyF: 700, bodyMix: 0.4, bodyTau: 0.005 })], { gain: -1 }),
  S('device-phone-vibrate', 'Phone Vibrate', 'device', 'medium', ['phone', 'vibrate', 'buzz', 'notification'], 'a phone buzzing twice on a table; a message, a call coming in',
    (r) => {
      const burst = () => {
        const d = 0.32, L = N(span(0.01, 0.015, d));
        const motor = osc(L, (t) => 170 * (1 + 0.02 * Math.sin(TAU * 9 * t)), { shape: 'square', harmonics: 12 });
        const rattle = crackle(r, { dur: d, density: 900, centre: 1800, Q: 0.8, grainTau: 0.0006 }).slice(0, L);
        return mul(sum(L, [hp(lp(motor, 1600), 140), 1], [norm(rattle), 0.3]), envAD(L, 0.01, 0.015, d));
      };
      return [layer([[burst(), 0, 1], [burst(), 0.5, 1]])];
    }),
  S('device-plug-in', 'Plug In', 'device', 'subtle', ['plug', 'usb', 'connect', 'cable'], 'a connector sliding home with a two-stage click; plugging in, connected',
    (r) => {
      const L = N(0.08);
      const slide = mul(norm(bp(pink(L, r), 3000, 1.2)), envSwell(L, 0.7, 0.01));
      return [layer([[slide, 0, 0.4], [click(r, { centre: 2800, Q: 2, tau: 0.002, bodyF: 900, bodyMix: 0.5, then: { at: 0.018, centre: 2200, Q: 2, tau: 0.003, bodyF: 600, bodyMix: 0.6, level: 0.9 } }), 0.06, 1]])];
    }),

  // ---- OBJECT -----------------------------------------------------------------
  S('object-desk-tap', 'Desk Tap', 'object', 'micro', ['desk', 'tap', 'wood', 'word'], 'a fingertip tapping a wooden desk; a point made, repeatable on words',
    (r) => [modal(r, { material: 'wood', f: 260, decay: 1, strike: 0.5, strikeCentre: 2500 })]),
  S('object-table-knock', 'Knock Knock', 'object', 'subtle', ['knock', 'table', 'attention', 'wood'], 'two knuckle knocks on a table; attention, listen up',
    (r) => [layer([[modal(r, { material: 'hollowWood', f: 190, decay: 1, strike: 0.6, strikeCentre: 2200 }), 0, 1], [modal(r, { material: 'hollowWood', f: 196, decay: 1, strike: 0.6, strikeCentre: 2200 }), 0.17, 0.85]])]),
  S('object-door-knock', 'Door Knock', 'object', 'medium', ['door', 'knock', 'visitor', 'arrive'], 'three knocks on a wooden door in a hallway; someone arriving, opportunity',
    (r) => room(layer([0, 0.2, 0.4].map((t, k) => [lp(modal(r, { material: 'hollowWood', f: 140 + 4 * k, decay: 1.4, strike: 0.6, strikeCentre: 1500, bright: 1.6 }), 2500), t, 1 - 0.08 * k])), 0.3, 0.75, 0.5)),
  S('object-place', 'Set Down', 'object', 'subtle', ['place', 'set-down', 'object', 'desk'], 'an object set down on a desk; placing a product, a phone, a cup',
    (r) => [layer([[lp(hit(r, { f0: 200, f1: 120, tauA: 0.035, len: 0.2, tr: { centre: 1500, gain: 0.25 }, knock: { freq: 500, tau: 0.012, gain: 1 }, nz: { cutoff: 1200, tau: 0.015, gain: 0.3 }, drive: 1.3 }), 4000), 0, 1], [modal(r, { material: 'plastic', f: 1300, decay: 1, strike: 0.2 }), 0.012, 0.25]])]),
  S('object-drop', 'Object Drop', 'object', 'medium', ['drop', 'fall', 'object', 'clatter'], 'a small object dropped on a table, bouncing and settling; a clumsy drop',
    (r) => [layer([[lp(hit(r, { f0: 220, f1: 110, tauA: 0.04, len: 0.2, tr: { centre: 2000, gain: 0.4 }, knock: { freq: 550, tau: 0.012, gain: 1 }, drive: 1.5 }), 5000), 0, 1],
      ...[0.11, 0.18, 0.225, 0.255].map((t, k) => [modal(r, { material: 'plastic', f: 900 + 150 * r(), decay: 1.5, strike: 0.5, strikeCentre: 3000 }), t, 0.5 * Math.pow(0.65, k)])])]),
  S('object-plastic-click', 'Plastic Snap', 'object', 'micro', ['plastic', 'snap', 'clip', 'word'], 'a plastic snap-fit clicking shut; a case closing, a clip, repeatable',
    (r) => [layer([[click(r, { centre: 2200, Q: 2, tau: 0.002 }), 0, 1], [modal(r, { material: 'plastic', f: 950, decay: 1, strike: 0 }), 0, 0.5]])]),
  S('object-metal-click', 'Metal Latch', 'object', 'subtle', ['metal', 'latch', 'lock', 'click'], 'a small metal latch clicking with a short ring; a lock, a clasp, a mechanism',
    (r) => [layer([[click(r, { centre: 3500, Q: 2, tau: 0.002, bodyF: 800, bodyMix: 0.4 }), 0, 1], [modal(r, { material: 'metal', f: 2200, decay: 0.35, strike: 0 }), 0, 0.35]])]),
  S('object-glass-tap', 'Glass Tap', 'object', 'subtle', ['glass', 'tap', 'ring', 'clean'], 'a fingernail tapping a glass; a clear little ring that hangs in the air',
    (r) => [modal(r, { material: 'glass', f: 1800, decay: 0.8, strike: 0.2, strikeCentre: 6000 })], { gain: -1 }),
  S('object-glass-clink', 'Glasses Clink', 'object', 'medium', ['glass', 'clink', 'cheers', 'celebrate'], 'two glasses clinked together; cheers, a celebration, a toast',
    (r) => [layer([[modal(r, { material: 'glass', f: 2600, decay: 1.3, strike: 0.3, strikeCentre: 7000 }), 0, 1], [modal(r, { material: 'glass', f: 3150, decay: 1.2, strike: 0.2, strikeCentre: 7000 }), 0.004, 0.8]])]),
  S('object-button', 'Push Button', 'object', 'micro', ['button', 'press', 'tactile', 'word'], 'a chunky tactile push button pressed and released; press start, repeatable',
    (r) => [click(r, { centre: 1500, Q: 1.3, tau: 0.004, bodyF: 400, bodyMix: 0.8, bodyTau: 0.012, then: { at: 0.09, centre: 1900, Q: 1.5, tau: 0.003, bodyF: 450, bodyMix: 0.5, level: 0.5 } })]),
  S('object-zipper', 'Zipper', 'object', 'medium', ['zipper', 'zip', 'bag', 'close'], 'a zipper pulled closed in one go; packing up, zipping a bag',
    (r) => {
      const dur = 0.6, L = N(dur + 0.02);
      const teeth = [];
      let t = 0.01;
      while (t < dur - 0.02) { const rate = 170 + 260 * Math.sin((Math.PI * t) / dur); // The pull slows at the end, so the last teeth are quiet, not a loud final one.
        teeth.push([transient(N(0.004), r, 3400, 0.0006, 1), t, Math.pow(Math.sin((Math.PI * t) / dur), 0.7)]); t += (1 / rate) * (0.85 + 0.3 * r()); }
      const slide = mul(norm(bp(pink(L, r), 2000, 0.8)), envSwell(L, 0.5, 0.05, 1));
      return [sum(L, [norm(layer(teeth)).slice(0, L), 1], [slide, 0.35])];
    }),
  S('object-ratchet', 'Ratchet', 'object', 'subtle', ['ratchet', 'mechanism', 'wind-up', 'gear'], 'a ratchet wound a few clicks; a mechanism, a wind-up, tightening',
    (r) => [layer(Array.from({ length: 10 }, (_, k) => [layer([[click(r, { centre: 3000, Q: 3, tau: 0.0015 }), 0, 1], [modal(r, { material: 'metal', f: 2600 + 60 * r(), decay: 0.12, strike: 0 }), 0, 0.3]]), k * 0.038, 0.7 + 0.3 * r()]))]),
  S('object-coin', 'Coin Drop', 'object', 'medium', ['coin', 'money', 'drop', 'price'], 'a coin dropped on a table, bouncing and ringing; money, a price, a tip',
    (r) => {
      const coin = (lvl) => modal(r, { modes: [[1, 1, 0.25], [1.52, 0.6, 0.2], [2.31, 0.4, 0.15], [3.1, 0.2, 0.1]], f: 3100, strike: 0.4, strikeCentre: 7000, decay: lvl });
      return [layer([0, 0.14, 0.235, 0.29, 0.32].map((t, k) => [coin(1 - 0.12 * k), t, Math.pow(0.6, k)]))];
    }),
  S('object-keys', 'Keys Jingle', 'object', 'subtle', ['keys', 'jingle', 'leave', 'home'], 'a bunch of keys jingling; leaving, arriving home, the car',
    (r) => [0, 1].map(() => layer(Array.from({ length: 22 }, () => [modal(r, { material: 'metal', f: 2400 + r() * 3400, decay: 0.3, strike: 0.2, strikeCentre: 8000 }), 0.5 * Math.pow(r(), 1.3), 0.3 + 0.7 * r()]))), { gain: -1 }),
  S('object-can-open', 'Can Open', 'object', 'medium', ['can', 'open', 'fizz', 'refresh'], 'a drinks can cracked open with a hiss and fizz; refreshing, a break',
    (r) => {
      const hiss = (() => { const L = N(span(0.002, 0.18)); return mul(norm(hp(white(L, r), 3000)), envAD(L, 0.002, 0.18)); })();
      const fizz = crackle(r, { dur: 0.7, density: (x) => 1800 * Math.exp(-x * 2.5) + 100, centre: 6000, Q: 0.8, grainTau: 0.0004, amp: (x) => Math.exp(-x * 1.5) });
      return [layer([[click(r, { centre: 1600, Q: 1.2, tau: 0.004, bodyF: 700, bodyMix: 0.5 }), 0, 1], [hiss, 0.006, 0.7], [fizz, 0.02, 0.3]])];
    }),
  S('object-pen-click', 'Pen Click', 'object', 'micro', ['pen', 'click', 'ready', 'word'], 'a ballpoint pen clicked; ready to write, a decision made',
    (r) => [click(r, { centre: 3500, Q: 2, tau: 0.002, tone: 2600, toneMix: 0.3, toneTau: 0.005, bodyF: 900, bodyMix: 0.3 })]),

  // ---- CAMERA -----------------------------------------------------------------
  S('camera-shutter', 'Camera Shutter', 'camera', 'medium', ['camera', 'shutter', 'photo', 'snapshot'], 'a DSLR shutter and mirror, open and close; a photo taken, a freeze frame',
    (r) => [layer([[click(r, { centre: 2400, Q: 1.2, tau: 0.004, bodyF: 260, bodyMix: 0.8, bodyTau: 0.02, then: { at: 0.055, centre: 3200, Q: 1.5, tau: 0.003, bodyF: 320, bodyMix: 0.6, level: 0.8 } }), 0, 1], [modal(r, { material: 'metal', f: 3800, decay: 0.15, strike: 0 }), 0.002, 0.12]])]),
  S('camera-shutter-phone', 'Phone Shutter', 'camera', 'subtle', ['camera', 'phone', 'shutter', 'screenshot'], 'a crisp phone-camera shutter; a screenshot, a quick snap',
    (r) => [click(r, { centre: 5000, Q: 0.8, tau: 0.0025, highpass: 1500, bodyF: 1400, bodyMix: 0.3, then: { at: 0.03, centre: 4200, Q: 0.8, tau: 0.003, highpass: 1500, level: 0.8 } })]),
  S('camera-focus-beep', 'Focus Beep', 'camera', 'subtle', ['camera', 'focus', 'beep', 'locked'], 'the two-beep of a camera locking focus; focused, locked on',
    (r) => [tones(r, [[2950, 0, 0.035], [2950, 0.08, 0.035]], { timbre: 'sine', tau: 0.008 })], { gain: -1 }),
  S('camera-autofocus', 'Autofocus', 'camera', 'subtle', ['camera', 'autofocus', 'motor', 'lens'], 'a lens autofocus motor seeking briefly; finding focus',
    (r) => [servo(r, { dur: 0.16, pitch: 3200, pitchEnd: 3800, ticks: 0.3 })]),
  S('camera-lens-zoom', 'Lens Zoom', 'camera', 'subtle', ['camera', 'zoom', 'motor', 'lens'], 'a zoom lens motor driving in; zooming on a detail',
    (r) => [servo(r, { dur: 0.7, pitch: 1400, pitchEnd: 2000, ticks: 0.4 })]),
  S('camera-film-advance', 'Film Advance', 'camera', 'medium', ['film', 'advance', 'analog', 'retro'], 'a film camera advance lever wound; analog, retro, next frame',
    (r) => [layer([...Array.from({ length: 9 }, (_, k) => [click(r, { centre: 3200, Q: 3, tau: 0.0012, bodyF: 1300, bodyMix: 0.2 }), k * 0.022, 0.5]), [click(r, { centre: 1800, Q: 1.3, tau: 0.004, bodyF: 380, bodyMix: 0.8 }), 0.22, 1]])]),
  S('camera-projector', 'Film Projector', 'camera', 'medium', ['projector', 'film', 'retro', 'memory'], 'a film projector rattling at 24 frames a second; old footage, a memory',
    (r) => {
      const dur = 1.8, L = N(dur);
      const frames = [];
      for (let t = 0.02; t < dur - 0.05; t += 1 / 24) frames.push([click(r, { centre: 2000 + 200 * r(), Q: 1, tau: 0.003, bodyF: 180, bodyMix: 0.5 }), t + 0.002 * r(), 0.7 + 0.3 * r()]);
      const hum = hp(lp(osc(L, 120, { shape: 'square', harmonics: 12 }), 700), 140);
      return [mul(sum(L, [norm(layer(frames)).slice(0, L), 1], [norm(hum), 0.25]), envSwell(L, 0.1, 0.2, 1))];
    }),
  S('camera-vhs', 'VHS Insert', 'camera', 'medium', ['vhs', 'tape', 'retro', 'nineties'], 'a VHS tape pushed in, the deck clunking and whirring; retro, nostalgic',
    (r) => [layer([[lp(hit(r, { f0: 160, f1: 90, tauA: 0.05, len: 0.25, tr: { centre: 1200, gain: 0.3 }, knock: { freq: 350, tau: 0.02, gain: 1 }, drive: 1.4 }), 3000), 0, 1], [servo(r, { dur: 0.8, pitch: 700, pitchEnd: 900, ticks: 0.2 }), 0.15, 0.5], [click(r, { centre: 2200, Q: 1.5, tau: 0.003, bodyF: 450, bodyMix: 0.6 }), 0.95, 0.7]])]),
  S('camera-rec-start', 'Record Start', 'camera', 'subtle', ['record', 'start', 'camera', 'rolling'], 'the single beep of a camcorder starting to record; rolling, we are live',
    (r) => [tones(r, [[1320, 0, 0.12]], { timbre: 'sine', tau: 0.01 })], { gain: -1 }),
  S('camera-rec-stop', 'Record Stop', 'camera', 'subtle', ['record', 'stop', 'camera', 'cut'], 'the double beep of a camcorder stopping; cut, that is a wrap',
    (r) => [tones(r, [[1320, 0, 0.05], [990, 0.09, 0.07]], { timbre: 'sine', tau: 0.01 })], { gain: -1 }),
  S('camera-flash', 'Camera Flash', 'camera', 'medium', ['flash', 'photo', 'paparazzi', 'spotlight'], 'a flash charging with a rising whine, then firing; a photo moment, the spotlight',
    (r) => {
      const d = 0.5, L = N(d + 0.01);
      const whine = mul(osc(L, sweep(1500, 9000, d)), new Float32Array(L).map((_, i) => 0.1 + 0.9 * (i / L)));
      const pop = click(r, { centre: 3000, Q: 0.8, tau: 0.004, bodyF: 220, bodyMix: 0.6, bodyTau: 0.02 });
      return [layer([[fadeEdges(whine, 5, 5), 0, 0.12], [pop, d, 1]])];
    }),
  S('camera-polaroid', 'Instant Camera', 'camera', 'medium', ['polaroid', 'instant', 'photo', 'print'], 'an instant camera shutter then its motor ejecting the print; a snapshot memory',
    (r) => [layer([[click(r, { centre: 2600, Q: 1.3, tau: 0.004, bodyF: 300, bodyMix: 0.7, bodyTau: 0.015 }), 0, 1], [servo(r, { dur: 0.9, pitch: 900, pitchEnd: 820, ticks: 0.5 }), 0.12, 0.6]])]),

  // ---- STOP -------------------------------------------------------------------
  S('stop-tape', 'Tape Stop', 'stop', 'strong', ['tape-stop', 'stop', 'halt', 'record'], 'music winding down to a halt like a tape machine losing power; "wait, stop"',
    (r) => {
      const bed = musicBed(r, 2), dur = 0.9;
      const rate = (t) => (t < 0.2 ? 1 : Math.max(0, Math.pow(1 - (t - 0.2) / 0.68, 1.6)));
      const L = N(dur);
      const played = varispeed(bed, rate, dur, { start: 0.3 });
      // Level follows speed, so the final frozen sample is at zero, not a DC step.
      const lvl = new Float32Array(L).map((_, i) => Math.sqrt(rate(i / SR)));
      return [fadeEdges(mul(lp(played, (t) => 400 + 6000 * rate(t)), lvl), 15, 5)];
    }),
  S('stop-tape-start', 'Tape Start', 'stop', 'strong', ['tape-start', 'start', 'spin-up', 'resume'], 'music spinning up from nothing to speed; starting again, back on',
    (r) => {
      const bed = musicBed(r, 2), dur = 0.85;
      const rate = (t) => Math.min(1, Math.pow(t / 0.5, 1.5));
      const L = N(dur);
      const lvl = new Float32Array(L).map((_, i) => Math.sqrt(rate(i / SR)));
      return [fadeEdges(mul(lp(varispeed(bed, rate, dur, { start: 0.2 }), (t) => 400 + 6000 * rate(t)), lvl), 5, 80)];
    }),
  S('stop-record-scratch', 'Record Scratch', 'stop', 'strong', ['record-scratch', 'wait', 'rewind', 'surprise'], 'music interrupted by a DJ scratch; "wait, what?" — a freeze-frame record scratch',
    (r) => {
      const bed = musicBed(r, 2), dur = 0.75;
      const rate = (t) => (t < 0.18 ? 1 : t < 0.55 ? 2.6 * Math.sin(TAU * 5.5 * (t - 0.18)) : Math.max(0, 1 - (t - 0.55) / 0.15) * 0.4);
      const L = N(dur);
      const played = varispeed(bed, rate, dur, { start: 0.4 });
      const scratchNoise = mul(norm(bp(white(L, r), 1800, 0.9)), new Float32Array(L).map((_, i) => Math.min(1, Math.abs(rate(i / SR)) / 2)));
      return [fadeEdges(sum(L, [norm(played), 1], [scratchNoise, 0.25]), 15, 30)];
    }),
  S('stop-rewind', 'Rewind', 'stop', 'medium', ['rewind', 'back', 'flashback', 'replay'], 'music rewinding fast in a chirping squeal; going back, a flashback, a replay',
    (r) => {
      const bed = musicBed(r, 2), dur = 0.7;
      const rate = (t) => -(4 + 6 * Math.sin((Math.PI * t) / dur));
      return [fadeEdges(hp(varispeed(bed, rate, dur, { start: 1.8 }), 300), 40, 60)];
    }),
  S('stop-freeze', 'Freeze Frame', 'stop', 'medium', ['freeze', 'pause', 'hold', 'moment'], 'music caught and held on one instant, then fading; freeze frame, time stops',
    (r) => {
      const bed = musicBed(r, 2), g = N(0.06), hop = N(0.03), dur = 1.1, L = N(dur);
      const grain = bed.slice(N(0.5), N(0.5) + g).map((v, i) => v * (0.5 - 0.5 * Math.cos((TAU * i) / g)));
      const out = new Float32Array(L + g);
      for (let s = 0; s < L; s += hop) for (let i = 0; i < g; i++) out[s + i] += grain[i] * Math.exp(-s / SR / 0.35);
      return [fadeEdges(lp(out.slice(0, L), (t) => 6000 * Math.exp(-t / 0.5) + 500), 10, 20)];
    }),
  S('stop-digital', 'Digital Shutdown', 'stop', 'medium', ['shutdown', 'digital', 'degrade', 'power-off'], 'music degrading to digital grit and dying; a system crashing, going offline',
    (r) => {
      const bed = musicBed(r, 2), dur = 0.8, L = N(dur);
      const src = bed.slice(N(0.3), N(0.3) + L);
      const out = new Float32Array(L);
      // Crushed progressively harder, then enveloped (crush-first, see tech.js).
      for (let i = 0; i < L; i++) {
        const x = i / L, hold = 1 + Math.floor(40 * x * x), bits = 12 - 9 * x, q = Math.pow(2, bits - 1);
        out[i] = Math.round(src[i - (i % hold)] * q) / q;
      }
      // Dead (-45 dB) before the fade: a crushed tail still loud at the end was a cut.
      return [fadeEdges(mul(out, envSwell(L, 0.02, 0.15, 1)), 10, 20)];
    }),
  S('stop-glitch', 'Glitch Stop', 'stop', 'medium', ['glitch', 'stop', 'stutter', 'broken'], 'music stuttering on a shrinking, crushed fragment until it breaks off; a glitch-out',
    (r) => {
      const bed = musicBed(r, 2), parts = [];
      let t = 0, d = 0.05;
      parts.push([slice(bed, 0.2, 0.2, 5), 0, 1]); t = 0.2;
      while (d > 0.008) { parts.push([crush(slice(bed, 0.4, d, 1.5), 6), t, 1]); t += d; d *= 0.86; }
      return [layer(parts)];
    }),
  S('stop-stutter', 'Beat Stutter', 'stop', 'medium', ['stutter', 'repeat', 'beat', 'emphasis'], 'a beat repeating faster and faster, DJ-style; emphasis, a build-up edit',
    (r) => {
      const bed = musicBed(r, 2), parts = [];
      let t = 0;
      for (const [d, n] of [[0.125, 4], [0.0625, 4], [0.03125, 8]]) for (let k = 0; k < n; k++) { parts.push([slice(bed, 0.5, d, 2), t, 1]); t += d; }
      return [layer(parts)];
    }),
  S('stop-abrupt', 'Hard Stop', 'stop', 'strong', ['stop', 'cut', 'abrupt', 'silence'], 'music slammed off with a hit and a ringing room; a hard stop into silence',
    (r) => {
      const bed = musicBed(r, 2);
      const music = slice(bed, 0.1, 0.45, 3);
      return room(layer([[music, 0, 0.8], [hit(r, { f0: 160, f1: 55, tr: { centre: 2600, gain: 0.8 }, drive: 2.5 }), 0.447, 1]]), 0.3, 0.8, 0.6);
    })
];
