/**
 * SPLIT AT THE PLAYHEAD — cutting a clip in two where the playhead stands,
 * so either half can be moved, restyled or deleted on its own.
 *
 *   ──────────[   one clip   ]──────────
 *                   ▲ playhead
 *   ──────────[ A ][    B    ]──────────
 *
 * The rule is the same for every kind: the LEFT half keeps the original's
 * identity (its id, and anything pointing at it — an occlusion relationship,
 * a linked sound), and the RIGHT half is a new copy that starts at the cut.
 * Nothing else about either half changes, so a split never silently restyles
 * or re-times what was there.
 *
 * One history entry per split: Undo puts the clip back whole.
 *
 * KEYFRAMES AND MOTION are kept on BOTH halves as they were — their times
 * are absolute, and each half simply shows the part of the animation that
 * falls inside it. That is what the renderers already do for a trimmed clip.
 */
import { appState, updateState } from '../state.js';
import { normalizeTextElement } from '../../../shared/textElement.js';
import { normalizeImageLayer } from '../../../shared/imageLayer.js';
import { normalizeShapeLayer } from '../../../shared/shapeLayer.js';
import { normalizeObjectEffect } from '../../../shared/objects/effects.js';
import { placeAboveInLayerOrder } from './layerStack.js';
import { normalizeSoundEvent, soundEventDuration, normalizeAudioTrack, getAudioTrackDuration } from '../../../shared/audioTimeline.js';

/** A clip must keep at least this much on each side of the cut to be worth splitting. */
export const MIN_SPLIT_PIECE = 0.08;

const KINDS = {
  text: { key: 'textElements', normalize: normalizeTextElement, prefix: 'txt' },
  image: { key: 'imageLayers', normalize: normalizeImageLayer, prefix: 'img' },
  shape: { key: 'shapeLayers', normalize: normalizeShapeLayer, prefix: 'shp' },
  effect: { key: 'objectEffects', normalize: normalizeObjectEffect, prefix: 'ofx' }
};

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A SOUND EFFECT is cut differently from a visual clip: both halves play the
 * same asset, so the second half must start further INTO it by exactly as
 * much as the first half lasts. Then the two together sound like the one
 * that was there — and either can be deleted, moved or retimed alone.
 */
function splitSound(id, time) {
  const list = appState.soundEvents || [];
  const index = list.findIndex((x) => x.id === id);
  if (index === -1) return null;
  const event = list[index];
  const played = soundEventDuration(event);
  if (!(played > 0)) return null;
  const end = event.startTime + played;
  if (!(time > event.startTime + MIN_SPLIT_PIECE && time < end - MIN_SPLIT_PIECE)) return null;
  const rate = event.playbackRate || 1;
  const firstLength = time - event.startTime;
  const left = normalizeSoundEvent({ ...event, duration: firstLength });
  const right = normalizeSoundEvent({
    ...event,
    id: newId('sfx'),
    startTime: time,
    trimStart: (event.trimStart || 0) + firstLength * rate,
    duration: end - time
  });
  if (!left || !right) return null;
  const next = list.slice();
  next.splice(index, 1, left, right);
  updateState({ soundEvents: next }, { recordHistory: true });
  return { left, right };
}

/**
 * A MUSIC/VOICE TRACK is cut like a sound effect: both halves play the same
 * file, so the cut becomes the first half's trimEnd and the second half's
 * trimStart — the same offsets trimming already uses.
 */
function splitAudioTrack(id, time) {
  const list = appState.audioTracks || [];
  const index = list.findIndex((x) => x.id === id);
  if (index === -1) return null;
  const track = list[index];
  const played = getAudioTrackDuration(track);
  if (!(played > 0)) return null;
  const end = track.startTime + played;
  if (!(time > track.startTime + MIN_SPLIT_PIECE && time < end - MIN_SPLIT_PIECE)) return null;
  const cut = track.trimStart + (time - track.startTime);
  const left = normalizeAudioTrack({ ...track, trimEnd: cut });
  const right = normalizeAudioTrack({ ...track, id: newId('aud'), startTime: time, trimStart: cut });
  if (!left || !right) return null;
  const next = list.slice();
  next.splice(index, 1, left, right);
  updateState({ audioTracks: next }, { recordHistory: true });
  return { left, right };
}

/** Which list a clip of this kind lives in, and the clip itself. */
function find(kind, id) {
  const spec = KINDS[kind];
  if (!spec) return null;
  const list = appState[spec.key] || [];
  const index = list.findIndex((x) => x.id === id);
  return index === -1 ? null : { spec, list, index, item: list[index] };
}

/** Whether this clip can be cut here at all — both halves must be worth keeping. */
export function canSplit(kind, id, time) {
  if (kind === 'sound' || kind === 'audio') {
    const list = kind === 'sound' ? appState.soundEvents : appState.audioTracks;
    const e = (list || []).find((x) => x.id === id);
    if (!e) return false;
    const played = kind === 'sound' ? soundEventDuration(e) : getAudioTrackDuration(e);
    return !!played && time > e.startTime + MIN_SPLIT_PIECE && time < e.startTime + played - MIN_SPLIT_PIECE;
  }
  const found = find(kind, id);
  if (!found) return false;
  const { item } = found;
  return time > item.start + MIN_SPLIT_PIECE && time < item.end - MIN_SPLIT_PIECE;
}

/**
 * Cuts the clip in two at `time`.
 * @returns {{left:object, right:object}|null} null when it cannot be cut there
 */
export function splitClip(kind, id, time) {
  if (kind === 'sound') return splitSound(id, time);
  if (kind === 'audio') return splitAudioTrack(id, time);
  const found = find(kind, id);
  if (!found || !canSplit(kind, id, time)) return null;
  const { spec, list, index, item } = found;
  const left = spec.normalize({ ...JSON.parse(JSON.stringify(item)), end: time });
  const right = spec.normalize({ ...JSON.parse(JSON.stringify(item)), id: newId(spec.prefix), start: time });
  if (!left || !right) return null;
  const next = list.slice();
  next.splice(index, 1, left, right);
  // The new half sits directly above the original in the layer stack, so the
  // two halves stay neighbours rather than the copy jumping to the top.
  const stackPatch = KINDS[kind].key === 'objectEffects' ? {} : placeAboveInLayerOrder(right.id, left.id);
  updateState({ [spec.key]: next, ...stackPatch }, { recordHistory: true });
  return { left, right };
}

/** The clip of this kind the user means right now — the selected one. */
export function selectedClip() {
  if (appState.selectedTextElementId) return { kind: 'text', id: appState.selectedTextElementId };
  if (appState.selectedImageLayerId) return { kind: 'image', id: appState.selectedImageLayerId };
  if (appState.selectedShapeLayerId) return { kind: 'shape', id: appState.selectedShapeLayerId };
  if (appState.selectedObjectEffectId) return { kind: 'effect', id: appState.selectedObjectEffectId };
  // The audio lane holds sound effects and music tracks under ONE selection
  // id, so which kind it is has to be looked up, not assumed.
  const audioId = appState.selectedAudioClipId;
  if (audioId) {
    if ((appState.soundEvents || []).some((e) => e.id === audioId)) return { kind: 'sound', id: audioId };
    if ((appState.audioTracks || []).some((t) => t.id === audioId)) return { kind: 'audio', id: audioId };
  }
  return null;
}

/**
 * Splits whatever is selected at the playhead — what the toolbar button and
 * the keyboard shortcut both call.
 * @returns {object|null} the two halves, or null when nothing can be cut there
 */
export function splitSelectedAtPlayhead(time) {
  const sel = selectedClip();
  if (!sel) return null;
  return splitClip(sel.kind, sel.id, time);
}

/** Whether the selected clip could be cut at `time` — for enabling the button. */
export function canSplitSelected(time) {
  const sel = selectedClip();
  return !!sel && canSplit(sel.kind, sel.id, time);
}
