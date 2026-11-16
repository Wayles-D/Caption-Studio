/**
 * Editing an object's 3D settings (V2.4.0, shared/transform3d.js) — the one
 * write path the Text, Image, Shape and Canvas panels share.
 *
 * A target is anything with a `transform3d` and, optionally, `keyframes`
 * (a text element, the video). The two tilts can be keyframed; once a tilt
 * HAS keyframes, changing it edits the keyframe at the playhead — the same
 * rule every other animated property follows (shared/keyframes.js's
 * routeFieldsThroughKeyframes) — and never the resting value underneath,
 * where the edit would seem to do nothing.
 */
import { evaluatePropertyAtTime, getPropertyTrack, upsertKeyframeEntry } from '../../../shared/keyframes.js';
import { normalizeTransform3d, TRANSFORM_3D_KEYFRAME_PROPERTIES } from '../../../shared/transform3d.js';

/** A tilt as it is at `time`: its keyframed value, else the stored one. */
export function current3dValue(target, property, time) {
  const keyed = TRANSFORM_3D_KEYFRAME_PROPERTIES.includes(property)
    ? evaluatePropertyAtTime(target?.keyframes, property, time)
    : undefined;
  return keyed !== undefined ? keyed : normalizeTransform3d(target?.transform3d)[property];
}

/** The 3D settings as shown at `time` (keyframed tilts resolved). */
export function current3d(target, time) {
  const t = normalizeTransform3d(target?.transform3d);
  TRANSFORM_3D_KEYFRAME_PROPERTIES.forEach((p) => { t[p] = current3dValue(target, p, time); });
  return t;
}

/**
 * The patch for `fields` written at `time`: `{ transform3d }`, plus
 * `{ keyframes }` when a keyframed tilt was changed.
 */
export function transform3dPatch(target, fields, time) {
  const stored = normalizeTransform3d(target?.transform3d);
  const keyed = {};
  const plain = {};
  Object.entries(fields).forEach(([k, v]) => {
    if (TRANSFORM_3D_KEYFRAME_PROPERTIES.includes(k) && getPropertyTrack(target?.keyframes, k).length) keyed[k] = v;
    else plain[k] = v;
  });
  const patch = { transform3d: normalizeTransform3d({ ...stored, ...plain }) };
  if (Object.keys(keyed).length) patch.keyframes = upsertKeyframeEntry(target.keyframes, time, keyed);
  return patch;
}

/** What a "+ keyframe" snapshot adds for the 3D tilts: both, when 3D is on. */
export function keyframeSnapshot3d(target, time) {
  if (!normalizeTransform3d(target?.transform3d).enabled) return {};
  const out = {};
  TRANSFORM_3D_KEYFRAME_PROPERTIES.forEach((p) => { out[p] = current3dValue(target, p, time); });
  return out;
}
