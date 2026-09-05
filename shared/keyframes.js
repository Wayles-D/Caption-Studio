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
 * EXISTING override object, re-routes any field whose mapped property has
 * already been keyframed at least once into the SAME unified keyframe entry
 * at `time` (creating that entry if none exists yet there) instead of
 * overwriting the plain static field — this is what makes "edit a property
 * normally while its keyframe track is already active" auto-key the right
 * instant, whether the edit came from an on-canvas drag (captions/words,
 * see src/js/components/canvasTransform.js) or a property-inspector control
 * (the video target, see src/js/components/videoTransform.js — same
 * function, same behavior, one shared implementation). A field whose
 * property has never been keyframed is returned completely untouched, so a
 * target nobody has keyframed writes exactly like it did before this
 * feature existed.
 *
 * @param {object} existing - The target's current override object (may be undefined).
 * @param {object} fields - Raw field writes, e.g. `{ offsetXPx: 12, rotationDeg: 5 }`.
 * @param {object} fieldToProperty - PHRASE_FIELD_TO_PROPERTY / WORD_FIELD_TO_PROPERTY / VIDEO_FIELD_TO_PROPERTY.
 * @param {number} time - The playhead time to key at, if any field routes through.
 * @returns {{ remainingFields: object, nextKeyframes: object[]|null }}
 */
export function routeFieldsThroughKeyframes(existing, fields, fieldToProperty, time) {
  const remainingFields = {};
  const valuesPatch = {};
  let anyKeyed = false;

  Object.entries(fields).forEach(([field, value]) => {
    const property = fieldToProperty[field];
    if (property && getPropertyTrack(existing?.keyframes, property).length > 0) {
      valuesPatch[property] = value;
      anyKeyed = true;
    } else {
      remainingFields[field] = value;
    }
  });

  const nextKeyframes = anyKeyed ? upsertKeyframeEntry(existing?.keyframes, time, valuesPatch) : null;
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
 * Resolves a property track's value at `time`:
 *   - before the first keyframe -> hold the first value
 *   - after the last keyframe -> hold the last value
 *   - between two keyframes -> eased linear interpolation, using the LATER
 *     keyframe's own easing (the curve describes the transition INTO that
 *     keyframe, matching how the entrance-animation's own single easing
 *     field is interpreted).
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
