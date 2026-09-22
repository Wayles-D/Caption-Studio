/**
 * Real timeline keyframes — storage + interpolation ONLY, no rendering, no
 * DOM. Extends the existing per-target override object
 * (appState.captionTransforms[key] — see shared/captionTransform.js) with an
 * optional `keyframes` list:
 *
 *   override.keyframes = [
 *     { t: 0,   easing: 'ease-out', values: { positionX: 500, positionY: 500, scale: 1,   rotation: 0,  opacity: 100 } },
 *     { t: 3,   easing: 'ease-out', values: { scale: 1.3 } },
 *     ...
 *   ]
 *
 * This mirrors how a real video editor (CapCut/Filmora-style) models a
 * keyframe: ONE marker at a point in time, holding whichever properties were
 * captured/changed at that instant — not five independent per-property
 * tracks the user has to manage separately. A single click on the editor's
 * "add keyframe" control (src/js/components/canvasTransform.js's
 * addOrUpdateKeyframeAtPlayhead) captures every animatable property at once,
 * producing one entry/one visible timeline marker; a later edit to just ONE
 * property (e.g. dragging position while scale/rotation/opacity are
 * untouched) only touches that property within whichever entry already
 * exists at that instant (or starts a new, partial one) — so two different
 * properties are still free to have keyframes at different timestamps (see
 * getPropertyTrack), it's just that the common "snapshot everything now"
 * action produces one coherent entry instead of five.
 *
 * Every function here is pure (array/object in, array/object out) so the
 * render path (shared/captionGraphics.js, via shared/captionTransform.js's
 * resolvePhraseParams/resolveWordOverrideAtTime) and the write path
 * (src/js/components/canvasTransform.js) both go through the SAME
 * evaluation logic — the "one canonical keyframe evaluation mechanism" both
 * live preview and server export call into (see resolveAnimatableField).
 */
import { applyEasing, EASING_TYPES } from './captionAnimation.js';

export const KEYFRAME_PROPERTIES = ['positionX', 'positionY', 'scale', 'rotation', 'opacity'];

export const DEFAULT_KEYFRAME_EASING = 'ease-out';

// Two keyframes closer together than this are treated as "the same instant"
// — matches the export pipeline's own sub-frame sampling step (see
// backend/utils/graphicsFrameGenerator.js's ANIMATION_SAMPLE_STEP_SECONDS),
// so a click that lands a frame or two off an existing keyframe still
// updates it in place instead of creating a visually-indistinguishable
// duplicate entry.
const TIME_EPSILON_SECONDS = 0.03;

/**
 * Canonical property name <-> per-target-kind field name, used by the write
 * path (src/js/components/canvasTransform.js) to know which raw override
 * field a keyframe entry "belongs to" when auto-keying an in-progress edit.
 * Mirrors the read-side mapping used by shared/captionTransform.js's
 * resolvePhraseParams/resolveWordOverrideAtTime — keep both in sync if a
 * property is ever added.
 */
export const PHRASE_FIELD_TO_PROPERTY = {
  customPosX: 'positionX',
  customPosY: 'positionY',
  rotation: 'rotation',
  captionScaleMultiplier: 'scale',
  opacity: 'opacity'
};

export const WORD_FIELD_TO_PROPERTY = {
  offsetXPx: 'positionX',
  offsetYPx: 'positionY',
  rotationDeg: 'rotation',
  fontScale: 'scale',
  opacity: 'opacity'
};

/** Video-target counterpart (see shared/videoTransform.js / src/js/components/videoTransform.js) — the video has exactly one instance, so its field names are plain, un-prefixed. */
export const VIDEO_FIELD_TO_PROPERTY = {
  offsetXPct: 'positionX',
  offsetYPct: 'positionY',
  rotation: 'rotation',
  scale: 'scale',
  opacity: 'opacity'
};

function isValidList(list) {
  return Array.isArray(list) && list.length > 0;
}

/**
 * Given an incoming field write (e.g. { offsetXPx: 12 }) and the target's
 * EXISTING override object, ACTION-DRIVEN auto-keying: once a target IS
 * animated (it has at least one keyframe entry), any field whose mapped
 * property is one of KEYFRAME_PROPERTIES routes into the unified keyframe
 * entry at `time`, creating that entry if none exists there yet. A target
 * with no keyframes is static, and the write falls through untouched.
 *
 * HISTORY — this gate has been flipped twice, so the reasoning matters. An
 * earlier version required a property to already be keyframed before an
 * ordinary edit would auto-key it; that was then removed to make auto-keying
 * unconditional, on the stated grounds that "real editors don't make you
 * pre-declare this is now animated". That premise is simply not true: After
 * Effects, Premiere, Final Cut and Resolve all gate animation behind an
 * explicit opt-in (the stopwatch / "Toggle animation" — here the ◆ button,
 * which snapshots current values into a first keyframe via
 * upsertKeyframeEntry), and a property with no keyframes is static.
 *
 * Making it unconditional removed the static mode entirely, which is what
 * produced the reported bug: setting an opacity of 0 on a never-animated
 * video created ONE keyframe, and a single-point track is constant across
 * the whole timeline (see evaluatePropertyAtTime), so the video went black
 * from 0:00 — a change that appeared to reach backwards in time, with a
 * diamond on the timeline nobody asked for and animation switched on
 * permanently. The evaluator was never at fault and is unchanged;
 * hold-before-first and single-keyframe-is-constant are standard everywhere.
 *
 * The resulting entry is always a FULL snapshot of every KEYFRAME_PROPERTY,
 * not just the field(s) this particular call happens to touch:
 * `readCurrentValue(property)` supplies whatever an untouched property
 * currently resolves to (its own keyframe-interpolated value if it has a
 * track, else its plain static value) so it's carried forward into this
 * entry unchanged. This matters because a keyframe entry containing ONLY
 * `{ rotation: 45 }` would make evaluatePropertyAtTime treat 45 as
 * rotation's value for the ENTIRE timeline (a single-point track is
 * constant everywhere) the instant this becomes that property's first
 * keyframe — silently "moving" every earlier moment in the video too,
 * rather than leaving everything before this instant exactly as it was and
 * only introducing motion from here onward. Full-snapshotting is what lets
 * a later, unrelated edit elsewhere in time correctly interpolate this
 * property between two real points instead of discovering it only has one.
 *
 * Reused identically by an on-canvas drag (captions/words, see
 * src/js/components/canvasTransform.js) and a property-inspector control
 * (the video target, see src/js/components/videoTransform.js) — one shared
 * implementation, one behavior.
 *
 * @param {object} existing - The target's current override object (may be undefined).
 * @param {object} fields - Raw field writes, e.g. `{ offsetXPx: 12, rotationDeg: 5 }`.
 * @param {object} fieldToProperty - PHRASE_FIELD_TO_PROPERTY / WORD_FIELD_TO_PROPERTY / VIDEO_FIELD_TO_PROPERTY.
 * @param {number} time - The playhead time to key at, if any field routes through.
 * @param {(property: string) => number} readCurrentValue - Resolves a KEYFRAME_PROPERTY's current value (keyframed-or-static) for whatever this call doesn't itself touch.
 * @returns {{ remainingFields: object, nextKeyframes: object[]|null }}
 */
export function routeFieldsThroughKeyframes(existing, fields, fieldToProperty, time, readCurrentValue) {
  // A target that has never been keyframed is NOT animated, so an ordinary
  // value edit writes the plain static value for the whole clip — it does not
  // silently switch animation on.
  //
  // This is the two-mode model every production editor uses (After Effects,
  // Premiere, Final Cut, Resolve): a property is static until you explicitly
  // enable animation (the stopwatch — here the ◆ button, which snapshots the
  // current values into a first keyframe via upsertKeyframeEntry), and only
  // after that does changing a value create or update a keyframe at the
  // playhead.
  //
  // Without this gate EVERY edit auto-created a keyframe, so there was no
  // static mode at all: setting "opacity 50" with no keyframes produced a
  // lone keyframe, and a single-point track is constant across the entire
  // timeline (see evaluatePropertyAtTime). The value therefore applied to the
  // whole video anyway, but with a diamond on the timeline and animation
  // switched on permanently — which is what made keyframes feel like they
  // "reached backwards in time". The evaluator itself was always correct and
  // is deliberately unchanged here; hold-before-first and single-keyframe-is-
  // constant are standard across all of those tools.
  //
  // Deleting the last keyframe returns the target to static mode, which is
  // also how those tools behave when you switch the stopwatch back off.
  if (!isValidList(existing?.keyframes)) {
    return { remainingFields: { ...fields }, nextKeyframes: null };
  }

  const remainingFields = {};
  const touchedValues = {}; // property -> the NEW value this call is writing

  Object.entries(fields).forEach(([field, value]) => {
    const property = fieldToProperty[field];
    if (property) {
      touchedValues[property] = value;
    } else {
      remainingFields[field] = value;
    }
  });

  if (Object.keys(touchedValues).length === 0) {
    return { remainingFields, nextKeyframes: null };
  }

  const valuesPatch = {};
  KEYFRAME_PROPERTIES.forEach((property) => {
    valuesPatch[property] = property in touchedValues ? touchedValues[property] : readCurrentValue(property);
  });

  const nextKeyframes = upsertKeyframeEntry(existing?.keyframes, time, valuesPatch);
  return { remainingFields, nextKeyframes };
}

/**
 * Derives ONE property's sorted {t, v, e}[] track from the unified keyframe
 * list — only entries that actually define `property` contribute a point,
 * so two properties keyed at different instants (see this module's own doc
 * comment) each get their own independent sequence even though they may
 * live inside the same or different entries.
 */
export function getPropertyTrack(keyframeList, property) {
  if (!isValidList(keyframeList)) return [];
  return keyframeList
    .filter((k) => k.values && k.values[property] != null)
    .map((k) => ({ t: k.t, v: k.values[property], e: k.easing }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Shortest signed angular delta from `fromDeg` to `toDeg`, in (-180, 180] —
 * so a 350°->10° pair rotates forward 20° (350->360/0->10) instead of naive
 * linear interpolation's -340° (350 down through 180 to 10, spinning the
 * long way around). Stored rotation values are already constrained to
 * [-180, 180] by the timeline's own numeric field range (see
 * timelinePanel.js's RANGE_BY_FAMILY), but this normalizes regardless of
 * that so it's correct even if that ever changes.
 */
function shortestAngleDelta(fromDeg, toDeg) {
  let delta = (toDeg - fromDeg) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

/**
 * Resolves a property track's value at `time`:
 *   - before the first keyframe -> hold the first value
 *   - after the last keyframe -> hold the last value
 *   - between two keyframes -> eased interpolation, using the LATER
 *     keyframe's own easing (the curve describes the transition INTO that
 *     keyframe, matching how the entrance-animation's own single easing
 *     field is interpreted). `rotation` interpolates by the SHORTEST
 *     angular path (see shortestAngleDelta) rather than a naive numeric
 *     lerp; every other property is a plain linear interpolation.
 * Returns undefined when the property has no keyframed points at all.
 */
export function evaluatePropertyAtTime(keyframeList, property, time) {
  const track = getPropertyTrack(keyframeList, property);
  if (!track.length) return undefined;
  if (track.length === 1 || time <= track[0].t) return track[0].v;
  const last = track[track.length - 1];
  if (time >= last.t) return last.v;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (time >= a.t && time <= b.t) {
      const span = b.t - a.t;
      const progress = span > 0 ? (time - a.t) / span : 1;
      const eased = applyEasing(progress, b.e || DEFAULT_KEYFRAME_EASING);
      if (property === 'rotation') return a.v + shortestAngleDelta(a.v, b.v) * eased;
      return a.v + (b.v - a.v) * eased;
    }
  }
  return last.v;
}

/**
 * The single "getKeyframedValue" call the whole render path uses: returns
 * the keyframe-interpolated value for `property` at `time` if it has any
 * keyframed points on `override`, otherwise returns `staticValue`
 * completely unchanged — so a target with no keyframes ever created
 * renders byte-for-byte as it did before this feature existed.
 */
export function resolveAnimatableField(override, property, time, staticValue) {
  if (isValidList(override?.keyframes) && time != null) {
    const value = evaluatePropertyAtTime(override.keyframes, property, time);
    if (value !== undefined) return value;
  }
  return staticValue;
}

/** Whether ANY keyframe entry exists on `override` (any property, any time) — the toolbar diamond's "this target is being keyframed at all" state. */
export function hasAnyKeyframes(override) {
  return isValidList(override?.keyframes);
}

/** Whether `property` specifically has been keyframed at least once on `override` — used by the write path to decide whether an ordinary edit should auto-key instead of overwriting the static field. */
export function hasKeyframedProperty(override, property) {
  return getPropertyTrack(override?.keyframes, property).length > 0;
}

/** Whether a keyframe ENTRY (any properties) already exists at ~`time` — drives the toolbar diamond's filled/hollow state and the "update, don't duplicate" behavior. */
export function findKeyframeEntryNear(keyframeList, time) {
  if (!isValidList(keyframeList)) return null;
  return keyframeList.find((k) => Math.abs(k.t - time) <= TIME_EPSILON_SECONDS) || null;
}

/**
 * Creates or updates ONE keyframe entry at `time`, merging `valuesPatch`
 * into whatever values (if any) already exist there — this is what makes
 * "press the keyframe button twice at the same instant" or "edit two
 * different properties one after another at the same playhead time" update
 * a single coherent entry instead of producing duplicates. Never mutates
 * `keyframeList` — returns a new, time-sorted array (undo/redo correctness).
 */
export function upsertKeyframeEntry(keyframeList, time, valuesPatch, easing = DEFAULT_KEYFRAME_EASING) {
  const list = Array.isArray(keyframeList) ? keyframeList : [];
  const idx = list.findIndex((k) => Math.abs(k.t - time) <= TIME_EPSILON_SECONDS);
  if (idx !== -1) {
    const next = [...list];
    next[idx] = { ...next[idx], easing: easing || next[idx].easing, values: { ...next[idx].values, ...valuesPatch } };
    return next;
  }
  return [...list, { t: time, easing, values: { ...valuesPatch } }].sort((a, b) => a.t - b.t);
}

/** Removes the whole keyframe entry (every property it holds) at ~`time` — "delete this keyframe" on the timeline marker. */
export function removeKeyframeEntry(keyframeList, time) {
  if (!isValidList(keyframeList)) return keyframeList;
  return keyframeList.filter((k) => Math.abs(k.t - time) > TIME_EPSILON_SECONDS);
}

/** Moves the whole keyframe entry nearest `oldTime` to `newTime` (timeline drag-to-retime), re-sorting. */
export function moveKeyframeEntry(keyframeList, oldTime, newTime) {
  if (!isValidList(keyframeList)) return keyframeList;
  const idx = keyframeList.findIndex((k) => Math.abs(k.t - oldTime) <= TIME_EPSILON_SECONDS);
  if (idx === -1) return keyframeList;
  const next = [...keyframeList];
  next[idx] = { ...next[idx], t: newTime };
  return next.sort((a, b) => a.t - b.t);
}

/**
 * Union time range [min,max] across every keyframe entry on `override`, or
 * null if it has none — used by the export pipeline to decide which stretch
 * of a phrase/word's slices need dense sub-frame sampling (see
 * backend/utils/graphicsFrameGenerator.js's subdivideSlicesForAnimation,
 * reused as-is for keyframes).
 */
export function getKeyframeTimeRange(override) {
  const list = override?.keyframes;
  if (!isValidList(list)) return null;
  const times = list.map((k) => k.t);
  return { min: Math.min(...times), max: Math.max(...times) };
}

export { EASING_TYPES };
