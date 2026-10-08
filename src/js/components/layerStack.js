/**
 * The editor's side of THE LAYER STACK (shared/visualLayers.js): reading
 * the project's stack, restacking any entry — a caption, a picture, a shape,
 * a card — with Bring to Front / Bring Forward / Send Backward / Send to
 * Back, and selecting or deleting an entry through its own module.
 *
 * The stored order (`layerOrder`, a document key — undoable, saved with the
 * project) is only written by a restack. Until then the stack is derived
 * from what exists, exactly as V1.3 stacked it.
 */
import { appState, updateState } from '../state.js';
import { resolveLayerStack, moveInLayerOrder, layerOrderOf, CAPTIONS_LAYER_ID } from '../../../shared/visualLayers.js';
import { SHAPE_LABELS } from '../../../shared/shapeLayer.js';
import * as imageLayers from './imageLayers.js';
import * as shapeLayers from './shapeLayers.js';
import * as textElements from './textElements.js';

/** The project's stack, bottom to top: entries { type, id, item }. */
export function getLayerStack() {
  return resolveLayerStack({
    layerOrder: appState.layerOrder,
    textElements: appState.textElements || [],
    imageLayers: appState.imageLayers || [],
    shapeLayers: appState.shapeLayers || []
  });
}

/** Where an entry sits: { position (1 = bottom), count }, or null. */
export function getLayerPosition(id) {
  const stack = getLayerStack();
  const i = stack.findIndex((e) => e.id === id);
  return i === -1 ? null : { position: i + 1, count: stack.length };
}

/** Restacks one entry: 'front' | 'forward' | 'backward' | 'back'. One undo step. */
export function moveLayer(id, direction) {
  const next = moveInLayerOrder(getLayerStack(), id, direction);
  if (!next) return false;
  updateState({ layerOrder: next }, { recordHistory: true });
  return true;
}

/**
 * For a duplicate: once the stack has a stored order, the copy goes
 * directly above its original instead of on top of everything. Returns the
 * state patch to write alongside the new object (empty while the order is
 * still derived — the derived order already puts a copy beside its original).
 */
export function placeAboveInLayerOrder(newId, refId) {
  if (!Array.isArray(appState.layerOrder) || !appState.layerOrder.length) return {};
  const ids = layerOrderOf(getLayerStack()).filter((id) => id !== newId);
  const at = ids.indexOf(refId);
  ids.splice(at === -1 ? ids.length : at + 1, 0, newId);
  return { layerOrder: ids };
}

/** The entry currently selected, if any (one selection at a time). */
export function getSelectedLayerId() {
  return appState.selectedShapeLayerId || appState.selectedImageLayerId || appState.selectedTextElementId || null;
}

/** Selects an entry through its own module (the captions entry selects nothing). */
export function selectLayerEntry(entry) {
  if (!entry) return;
  if (entry.type === 'image') imageLayers.selectImageLayer(entry.id);
  else if (entry.type === 'shape') shapeLayers.selectShapeLayer(entry.id);
  else if (entry.type === 'text') textElements.selectTextElement(entry.id);
}

/** Deletes an entry through its own module. The transcript's captions are not deleted from here. */
export function removeLayerEntry(entry) {
  if (!entry) return;
  if (entry.type === 'image') imageLayers.removeImageLayer(entry.id);
  else if (entry.type === 'shape') shapeLayers.removeShapeLayer(entry.id);
  else if (entry.type === 'text') textElements.removeTextElement(entry.id);
}

const TEXT_KIND_LABEL = { caption: 'Caption', overlay: 'Text', interlude: 'Cinematic' };

/** How a stack entry reads in a list: a short badge and a label. */
export function describeLayerEntry(entry) {
  if (entry.id === CAPTIONS_LAYER_ID) return { badge: 'CAP', label: 'Captions (transcript)' };
  if (entry.type === 'image') return { badge: 'IMG', label: entry.item.name || 'Image' };
  if (entry.type === 'shape') return { badge: 'SHP', label: SHAPE_LABELS[entry.item.kind] || 'Shape' };
  const text = String(entry.item.text || '').replace(/\s+/g, ' ').trim();
  return { badge: entry.item.kind === 'interlude' ? 'CIN' : entry.item.kind === 'caption' ? 'MAN' : 'TXT', label: text || TEXT_KIND_LABEL[entry.item.kind] || 'Text' };
}
