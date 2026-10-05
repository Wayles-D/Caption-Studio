/**
 * SHAPE LAYERS in the editor — adding, editing, duplicating, removing and
 * selecting them. The model and drawing live in shared/shapeLayer.js; their
 * place in the layer stack is shared/visualLayers.js (see layerStack.js).
 *
 * Every write goes through updateState, so each edit is undoable and saved
 * with the project (shapeLayers is a document key — src/store/shapeLayerStore.js).
 * Gestures write with recordHistory:false while live and commit once.
 */
import { appState, updateState } from '../state.js';
import { createShapeLayer, normalizeShapeLayer, SHAPE_KINDS } from '../../../shared/shapeLayer.js';
import { getPlayheadTime } from './textElements.js';
import { placeAboveInLayerOrder } from './layerStack.js';

const MIN_DURATION = 0.1;

function videoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

function clampToTimeline(time) {
  const d = videoDuration();
  return Math.max(0, d > 0 ? Math.min(d, time) : time);
}

export function getShapeLayers() {
  return appState.shapeLayers || [];
}

export function getShapeLayer(id) {
  return getShapeLayers().find((s) => s.id === id) || null;
}

/** A new shape of a kind at the playhead, on top of the stack, selected. */
export function addShapeLayer(kind = 'rectangle', { start = getPlayheadTime() } = {}) {
  if (!SHAPE_KINDS.includes(kind)) return null;
  const at = clampToTimeline(start);
  const d = videoDuration();
  const shape = createShapeLayer({ kind, start: at, duration: d > 0 ? Math.max(MIN_DURATION, Math.min(3, d - at)) : 3 });
  updateState({ shapeLayers: [...getShapeLayers(), shape] }, { recordHistory: true });
  selectShapeLayer(shape.id);
  return shape;
}

/** Replaces top-level fields (start, end, enabled, kind...). */
export function updateShapeLayer(id, patch, { recordHistory = true } = {}) {
  const shapes = getShapeLayers();
  const idx = shapes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const next = shapes.slice();
  next[idx] = normalizeShapeLayer({ ...shapes[idx], ...patch });
  updateState({ shapeLayers: next }, { recordHistory });
  return next[idx];
}

/** Merges into one group: 'transform', 'appearance', or the appearance's 'fill' / 'border' / 'shadow'. */
export function patchShapeLayer(id, group, fields, options) {
  const shape = getShapeLayer(id);
  if (!shape) return null;
  if (group === 'fill' || group === 'border' || group === 'shadow') {
    return updateShapeLayer(id, { appearance: { ...shape.appearance, [group]: { ...shape.appearance[group], ...fields } } }, options);
  }
  return updateShapeLayer(id, { [group]: { ...shape[group], ...fields } }, options);
}

/** Its entrance — the motion list's entrance slot (shared/motion), exactly as an image's. */
export function setShapeLayerEntrance(id, fields, options) {
  const shape = getShapeLayer(id);
  if (!shape) return null;
  const current = (shape.motions || []).find((m) => m.kind === 'entrance') || {};
  const others = (shape.motions || []).filter((m) => m.kind !== 'entrance');
  const entrance = { ...current, ...fields };
  return updateShapeLayer(id, { motions: entrance.preset && entrance.preset !== 'none' ? [...others, entrance] : others }, options);
}

export function moveShapeLayer(id, start, options) {
  const shape = getShapeLayer(id);
  if (!shape) return null;
  const length = shape.end - shape.start;
  const d = videoDuration();
  const maxStart = d > 0 ? Math.max(0, d - length) : Number.MAX_SAFE_INTEGER;
  const nextStart = Math.max(0, Math.min(maxStart, start));
  return updateShapeLayer(id, { start: nextStart, end: nextStart + length }, options);
}

export function trimShapeLayer(id, edge, time, options) {
  const shape = getShapeLayer(id);
  if (!shape) return null;
  const t = clampToTimeline(time);
  if (edge === 'start') return updateShapeLayer(id, { start: Math.min(t, shape.end - MIN_DURATION) }, options);
  return updateShapeLayer(id, { end: Math.max(t, shape.start + MIN_DURATION) }, options);
}

/** A copy with its own identity — deep, so nothing nested is shared — directly above the original, selected. */
export function duplicateShapeLayer(id) {
  const shapes = getShapeLayers();
  const idx = shapes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const copy = normalizeShapeLayer({ ...JSON.parse(JSON.stringify(shapes[idx])), id: undefined });
  const next = shapes.slice();
  next.splice(idx + 1, 0, copy);
  updateState({ shapeLayers: next, ...placeAboveInLayerOrder(copy.id, id) }, { recordHistory: true });
  selectShapeLayer(copy.id);
  return copy;
}

export function removeShapeLayer(id) {
  const shapes = getShapeLayers();
  if (!shapes.some((s) => s.id === id)) return;
  updateState({
    shapeLayers: shapes.filter((s) => s.id !== id),
    ...(appState.selectedShapeLayerId === id ? { selectedShapeLayerId: null } : {})
  }, { recordHistory: true });
}

export function removeSelectedShapeLayer() {
  const id = appState.selectedShapeLayerId;
  if (!id) return false;
  removeShapeLayer(id);
  return true;
}

/** Makes a shape THE selection — every other selection is released in the same write. */
export function selectShapeLayer(id) {
  if (!id) {
    if (appState.selectedShapeLayerId) updateState({ selectedShapeLayerId: null }, { recordHistory: false });
    return;
  }
  updateState({
    selectedShapeLayerId: id,
    selectedImageLayerId: null,
    selectedTextElementId: null,
    selectedCaptionEventId: null,
    selectedAudioClipId: null
  }, { recordHistory: false });
}

export function getSelectedShapeLayer() {
  return getShapeLayer(appState.selectedShapeLayerId);
}
