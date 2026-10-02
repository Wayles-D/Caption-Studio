/**
 * The motion system (shared/motion) — one engine for every visual object.
 *
 * Checks the model, the evaluator, the adapters from stored fields and the
 * registries, with the V1.1.0 entrance behaviour as the reference values.
 * (That the renderer and exporter produce byte-identical frames and sample
 * times to V1.1.0 on top of this engine was verified with a golden-frame
 * comparison across 96 scenarios when the engine was introduced; the
 * frame-level preview/export parity is test_animation_v11.js.)
 */
import assert from 'assert';
import {
  normalizeMotion, entranceFromParams, entranceFromWordOverride, resolveMotionWindow, motionActiveSpan,
  motionProgress, evaluateMotion, combineMotionDeltas, applyMotionToState, isIdentityDelta,
  IDENTITY_DELTA, HIDDEN_DELTA, SLIDE_DISTANCE, registerMotionPreset, getMotionPreset, listMotionPresets,
  registerEasing, applyEasing, EASING_TYPES, evaluatePropertyAtTime,
  isMotionKindTimed, normalizeMotionList, motionsFromParams, motionsFromWordOverride, evaluateMotions, motionActiveSpans
} from '../shared/motion/index.js';
import { ANIMATION_TYPES, getAnimationTransform } from '../shared/captionAnimation.js';

console.log('--- Motion Engine ---');
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);

// ---------------------------------------------------------------------------
console.log('\n[Test 1] A motion is plain, serializable data with safe defaults');
{
  const m = normalizeMotion({ preset: 'slide-up', duration: '0.5', easing: 'linear', intensity: 2 });
  assert.deepStrictEqual(m, { kind: 'entrance', preset: 'slide-up', duration: 0.5, easing: 'linear', intensity: 2, anchor: 'self' });
  assert.deepStrictEqual(normalizeMotion(JSON.parse(JSON.stringify(m))), m, 'survives a JSON round trip unchanged');
  assert.deepStrictEqual(normalizeMotion({ preset: 'pop' }), { kind: 'entrance', preset: 'pop', duration: 0.25, easing: 'ease-out', intensity: 1, anchor: 'self' }, 'defaults');
  assert.deepStrictEqual(normalizeMotion({ preset: 'pop', duration: -1, easing: 'nope', intensity: 0 }), normalizeMotion({ preset: 'pop' }), 'invalid fields fall back');
  assert.strictEqual(normalizeMotion({ preset: 'none' }), null, "'none' is no motion");
  assert.strictEqual(normalizeMotion({ preset: 'warp-drive' }), null, 'an unknown preset is no motion');
  assert.strictEqual(normalizeMotion(null), null);
}
console.log('✓ Normalized, defaulted, JSON-safe; none/unknown is null');

// ---------------------------------------------------------------------------
console.log('\n[Test 2] Stored fields read into motions — no new project format');
{
  assert.deepStrictEqual(
    entranceFromParams({ captionAnimationType: 'slide-left', captionAnimationDuration: 0.4, captionAnimationEasing: 'ease-in', captionAnimationIntensity: 1.5 }),
    { kind: 'entrance', preset: 'slide-left', duration: 0.4, easing: 'ease-in', intensity: 1.5, anchor: 'self' }
  );
  assert.strictEqual(entranceFromParams({ captionAnimationType: 'none' }), null);
  assert.strictEqual(entranceFromParams({}), null);
  const word = entranceFromWordOverride({ animationType: 'pop', animationDuration: 1, animationTiming: 'together' });
  assert.strictEqual(word.anchor, 'container', "a word's 'together' is a motion anchored to its container");
  assert.strictEqual(entranceFromWordOverride({ animationType: 'pop' }).anchor, 'self');
  assert.strictEqual(entranceFromWordOverride({ offsetXPx: 4 }), null, 'a word override with no animation has no motion');
}
console.log('✓ Caption params, element styles and word overrides all read into the one shape');

// ---------------------------------------------------------------------------
console.log('\n[Test 3] Timing: windows, progress, the hidden-before-start rule');
{
  const pop = normalizeMotion({ preset: 'pop', duration: 0.25, easing: 'linear' });
  const win = { start: 1, end: 3 };
  assert.strictEqual(evaluateMotion(pop, 0.999, win), HIDDEN_DELTA, 'an entrance that has not begun is not drawn');
  assert.strictEqual(evaluateMotion(pop, 1.25, win), IDENTITY_DELTA, 'finished: the object at rest');
  assert.strictEqual(evaluateMotion(null, 2, win), IDENTITY_DELTA, 'no motion: at rest');
  assert.strictEqual(motionProgress(pop, 1, win), 0);
  close(motionProgress(pop, 1.125, win), 0.5, 'linear progress halfway');
  // The duration never outlasts the window.
  const short = { start: 1, end: 1.1 };
  assert.strictEqual(evaluateMotion(pop, 1.1, short), IDENTITY_DELTA, 'a 0.25s entrance in a 0.1s window finishes when the window does');
  assert.deepStrictEqual(motionActiveSpan(pop, short), { start: 1, end: 1.1 });
  assert.deepStrictEqual(motionActiveSpan(pop, win), { start: 1, end: 1.25 });
  // Windows: own start, or the container's; run to the container's end.
  const own = { start: 1.5, end: 1.9 };
  const caption = { start: 1, end: 3 };
  assert.deepStrictEqual(resolveMotionWindow(pop, own, caption), { start: 1.5, end: 3 });
  assert.deepStrictEqual(resolveMotionWindow({ ...pop, anchor: 'container' }, own, caption), { start: 1, end: 3 });
  assert.deepStrictEqual(resolveMotionWindow(pop, caption), caption, "a whole caption's window is its own span");
}
console.log('✓ Hidden before, at rest after, clamped to its window, anchored self or container');

// ---------------------------------------------------------------------------
console.log('\n[Test 4] The V1.1.0 presets, value for value');
{
  // ease-out, 0.25s, 0.05s in: eased progress 1 - 0.8² = 0.36.
  const at = (preset, intensity = 1) => evaluateMotion(normalizeMotion({ preset, intensity }), 1.05, { start: 1, end: 3 });
  const p = 0.36;
  close(at('fade').opacity, p, 'fade');
  close(at('pop').scale, 0.6 + 0.4 * p, 'pop starts at 60%');
  close(at('scale').scale, 1.35 - 0.35 * p, 'scale starts at 135%');
  close(at('slide-up').offsetY, SLIDE_DISTANCE * (1 - p), 'slide up: below, rising');
  close(at('slide-down').offsetY, -SLIDE_DISTANCE * (1 - p), 'slide down: above, falling');
  close(at('slide-left').offsetX, SLIDE_DISTANCE * (1 - p), 'slide left: right of it, travelling left');
  close(at('slide-right').offsetX, -SLIDE_DISTANCE * (1 - p), 'slide right: left of it, travelling right');
  ['slide-up', 'slide-down', 'slide-left', 'slide-right'].forEach((id) => {
    close(at(id).opacity, p / 0.4, `${id} fades in over the first 40%`);
    assert.strictEqual(evaluateMotion(normalizeMotion({ preset: id }), 1, { start: 1, end: 3 }).opacity, 0, `${id} starts invisible`);
  });
  close(at('slide-up', 2).offsetY, 2 * SLIDE_DISTANCE * (1 - p), 'intensity scales the distance');
  close(at('pop', 3).scale, 0.05 + 0.95 * p, 'pop never starts below 5%');
  // The old facade reports exactly the same numbers.
  const legacy = getAnimationTransform({ captionAnimationType: 'slide-up' }, 1.05, 1, 3);
  const d = at('slide-up');
  assert.deepStrictEqual(legacy, { alpha: d.opacity, scale: d.scale, offsetXEm: d.offsetX, offsetYEm: d.offsetY });
  assert.deepStrictEqual(ANIMATION_TYPES, ['none', 'fade', 'pop', 'scale', 'slide-up', 'slide-down', 'slide-left', 'slide-right']);
  assert.deepStrictEqual(EASING_TYPES.slice(0, 4), ['linear', 'ease-in', 'ease-out', 'ease-in-out']);
}
console.log('✓ Fade, Pop, Scale and the four slides compute what V1.1.0 drew');

// ---------------------------------------------------------------------------
console.log('\n[Test 5] Base + motion = render; the base is never touched');
{
  const base = Object.freeze({ x: 100, y: 200, scale: 1.5, rotation: 10, opacity: 0.8 });
  const d = { opacity: 0.5, scale: 0.6, offsetX: 1, offsetY: -2, rotation: 5 };
  const out = applyMotionToState(base, d, 20);
  assert.deepStrictEqual(out, { x: 120, y: 160, scale: 1.5 * 0.6, rotation: 15, opacity: 0.4 });
  assert.strictEqual(applyMotionToState(base, IDENTITY_DELTA), base, 'no motion: the base itself');
  const both = combineMotionDeltas({ ...IDENTITY_DELTA, scale: 0.5, offsetX: 1 }, { ...IDENTITY_DELTA, scale: 2, opacity: 0.5, offsetX: 2 });
  assert.deepStrictEqual(both, { opacity: 0.5, scale: 1, offsetX: 3, offsetY: 0, rotation: 0 }, 'two motions compose');
  assert.strictEqual(combineMotionDeltas(IDENTITY_DELTA, d), d);
  assert.ok(isIdentityDelta({ opacity: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 0 }));
}
console.log('✓ Derived at render time; deltas compose');

// ---------------------------------------------------------------------------
console.log('\n[Test 6] Object-agnostic and extensible without touching the engine');
{
  // The same motion, at the same point in two very different objects' lives,
  // is the same change — the engine never asks what it is moving.
  const slide = normalizeMotion({ preset: 'slide-right', duration: 0.5 });
  const word = evaluateMotion(slide, 2.125, { start: 2, end: 2.5 });
  const image = evaluateMotion(slide, 10.125, { start: 10, end: 14 });
  assert.deepStrictEqual(word, image);

  // A new easing and a new preset — of a new kind — plug in by registration.
  registerEasing('test-step', (t) => (t < 0.5 ? 0 : 1));
  registerMotionPreset({ id: 'test-spin', kind: 'emphasis', evaluate: (q) => ({ rotation: 360 * (1 - q) }) });
  assert.ok(EASING_TYPES.includes('test-step'));
  close(applyEasing(0.4, 'test-step'), 0, 'registered easing');
  assert.deepStrictEqual(listMotionPresets('emphasis'), ['test-spin']);
  const spin = normalizeMotion({ preset: 'test-spin', duration: 1, easing: 'test-step' });
  assert.strictEqual(spin.kind, 'emphasis');
  assert.ok(getMotionPreset('test-spin'));
  assert.ok(!ANIMATION_TYPES.includes('test-spin'), 'the editor menu lists entrances only');
  // An emphasis has no TIMING yet, so it is inert — not run as an entrance.
  assert.ok(!isMotionKindTimed('emphasis') && isMotionKindTimed('entrance'));
  assert.strictEqual(evaluateMotion(spin, 0.3, { start: 0, end: 2 }), IDENTITY_DELTA, 'a kind without timing changes nothing');
  assert.strictEqual(motionActiveSpan(spin, { start: 0, end: 2 }), null, 'and is never sampled');
  // A preset may return only what it changes; the rest is filled in.
  registerMotionPreset({ id: 'test-tilt', kind: 'entrance', evaluate: (q) => ({ rotation: 30 * (1 - q) }) });
  assert.deepStrictEqual(evaluateMotion(normalizeMotion({ preset: 'test-tilt', duration: 1, easing: 'linear' }), 0.5, { start: 0, end: 2 }),
    { opacity: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 15 }, 'a partial preset result is completed');
}
console.log('✓ Same motion, same change, whatever the object; new curves and presets register in; untimed kinds are inert');

// ---------------------------------------------------------------------------
console.log('\n[Test 7] An object\'s motions are a list — one per kind — and today\'s projects read into it unchanged');
{
  // Existing single-entrance storage → a one-motion list; nothing → none.
  const stored = { captionAnimationType: 'slide-up', captionAnimationDuration: 0.4, captionAnimationEasing: 'ease-in' };
  assert.deepStrictEqual(motionsFromParams(stored), [entranceFromParams(stored)]);
  assert.deepStrictEqual(motionsFromParams({ captionAnimationType: 'none' }), []);
  assert.deepStrictEqual(motionsFromWordOverride({ animationType: 'pop', animationTiming: 'together' }), [entranceFromWordOverride({ animationType: 'pop', animationTiming: 'together' })]);
  assert.deepStrictEqual(motionsFromWordOverride({ offsetXPx: 3 }), []);

  // Evaluating the list is evaluating its one entrance — same result, same windows.
  const [entrance] = motionsFromParams(stored);
  const own = { start: 1.5, end: 1.9 };
  const caption = { start: 1, end: 3 };
  for (const t of [1.4, 1.5, 1.6, 1.8, 2.5]) {
    assert.deepStrictEqual(evaluateMotions([entrance], t, own, caption), evaluateMotion(entrance, t, resolveMotionWindow(entrance, own, caption)), `t=${t}`);
  }
  assert.strictEqual(evaluateMotions([], 2, own), IDENTITY_DELTA);
  assert.deepStrictEqual(motionActiveSpans([entrance], own, caption), [motionActiveSpan(entrance, resolveMotionWindow(entrance, own, caption))]);

  // Several kinds coexist, one slot each, in a fixed order; a second motion of
  // a kind replaces the first, and never displaces another kind.
  const list = normalizeMotionList([
    { preset: 'test-spin', duration: 2 },
    { preset: 'slide-up', duration: 0.3 },
    { preset: 'pop', duration: 0.5 },
    { preset: 'warp-drive' }
  ]);
  assert.deepStrictEqual(list.map((x) => [x.kind, x.preset]), [['entrance', 'pop'], ['emphasis', 'test-spin']]);
  assert.deepStrictEqual(normalizeMotionList(JSON.parse(JSON.stringify(list))), list, 'a list survives a JSON round trip');
  assert.deepStrictEqual(normalizeMotionList(null), []);

  // With an (inert, untimed) emphasis beside it, the entrance evaluates — and
  // is sampled — exactly as it does alone.
  for (const t of [0.9, 1.0, 1.1, 1.3, 2]) {
    assert.deepStrictEqual(evaluateMotions(list, t, caption), evaluateMotions([list[0]], t, caption), `t=${t}`);
  }
  assert.deepStrictEqual(motionActiveSpans(list, caption), motionActiveSpans([list[0]], caption));
}
console.log('✓ Lists of motions: legacy storage reads in unchanged; kinds coexist without displacing each other');

// ---------------------------------------------------------------------------
console.log('\n[Test 8] Keyframes share the engine\'s easing');
{
  const kfs = [{ t: 0, values: { positionX: 100 } }, { t: 1, easing: 'ease-in', values: { positionX: 500 } }, { t: 2, easing: 'linear', values: { positionX: 200 } }];
  close(evaluatePropertyAtTime(kfs, 'positionX', 0.5), 100 + 400 * applyEasing(0.5, 'ease-in'), 'eased between the first two');
  close(evaluatePropertyAtTime(kfs, 'positionX', 1.5), 350, 'linear between the last two');
  assert.strictEqual(evaluatePropertyAtTime(kfs, 'positionX', 5), 200, 'holds after the last');
}
console.log('✓ property → keyframes → interpolation → easing, through the one curve table');

console.log('\n--- All motion engine checks passed ---');
