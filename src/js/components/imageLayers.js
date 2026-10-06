/**
 * IMAGE LAYERS in the editor — adding (importing a picture), editing,
 * stacking, duplicating, removing and selecting them, plus the preview's
 * decoded-picture cache. The model and drawing live in shared/imageLayer.js.
 *
 * Every write goes through writeImageLayers → updateState, so an edit is
 * undoable like any other (imageLayers is a document key — see
 * src/store/imageLayerStore.js), and saved with the project. Gestures write
 * with recordHistory:false while live and commit once at the end, the same
 * split every other drag in the editor uses.
 *
 * The list's ORDER is the stacking order within a placement (later = on top),
 * so unlike text elements it is never re-sorted by time.
 */
import { appState, updateState } from '../state.js';
import { getComposition } from './compositionView.js';
import { createImageLayer, normalizeImageLayer, IMAGE_ACCEPT } from '../../../shared/imageLayer.js';
import { rememberImageFile, getSavedImageFile } from '../projectPersistence.js';
import { getPlayheadTime } from './textElements.js';
import { placeAboveInLayerOrder } from './layerStack.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const MIN_DURATION = 0.1;

function videoDuration() {
  const d = document.getElementById('preview-video')?.duration;
  return Number.isFinite(d) && d > 0 ? d : (appState.videoDuration || 0);
}

function clampToTimeline(time) {
  const d = videoDuration();
  return Math.max(0, d > 0 ? Math.min(d, time) : time);
}

function writeImageLayers(next, recordHistory = true) {
  updateState({ imageLayers: next }, { recordHistory });
}

export function getImageLayers() {
  return appState.imageLayers || [];
}

export function getImageLayer(id) {
  return getImageLayers().find((img) => img.id === id) || null;
}

// --- The preview's pictures ------------------------------------------------------
//
// One decoded <img> per asset, shared by every layer that uses it, made from
// the file in hand (an import) or the saved copy (after a reload). Never
// re-decoded per frame. `onReady` is called once a picture finishes decoding
// so the (possibly paused) preview can redraw.

const pictures = new Map(); // assetId → { img, ready }
let onPictureReady = null;

export function setImagePictureListener(fn) {
  onPictureReady = fn;
}

function loadPicture(assetId, blob) {
  const entry = { img: new Image(), ready: false };
  pictures.set(assetId, entry);
  entry.img.onload = () => {
    entry.ready = true;
    if (onPictureReady) onPictureReady();
  };
  entry.img.src = URL.createObjectURL(blob);
  return entry;
}

/** The decoded picture for an asset, or null while it loads (or if it can't be found). */
export function getImagePicture(assetId) {
  const entry = pictures.get(assetId);
  if (entry) return entry.ready ? entry.img : null;
  // Not in memory: the saved copy (a reopened project). Marked pending so it
  // is only looked up once.
  pictures.set(assetId, { img: null, ready: false });
  getSavedImageFile(assetId).then((blob) => { if (blob) loadPicture(assetId, blob); });
  return null;
}

/** A blob URL for an asset's picture, for thumbnails (null until it has loaded). */
export function getImagePictureUrl(assetId) {
  const entry = pictures.get(assetId);
  return entry?.ready ? entry.img.src : null;
}

function readNaturalSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { reject(new Error('That file could not be read as an image.')); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

// --- Creating ----------------------------------------------------------------------

/**
 * Imports a picture and places it at the playhead: uploads it (the exporter
 * draws from the server's copy), keeps a copy in the browser (for reloads,
 * and to re-send if the server purges it), and adds a layer sized to sit
 * comfortably inside the frame without being stretched. Selects it.
 */
export async function importImageFile(file, { start = getPlayheadTime() } = {}) {
  if (!file) throw new Error('No file selected.');
  const { width, height } = await readNaturalSize(file);

  const form = new FormData();
  form.append('image', file);
  const res = await fetch(`${API_BASE_URL}/api/upload/image`, { method: 'POST', body: form });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload?.assetId) throw new Error(payload?.message || `Image upload failed (HTTP ${res.status}).`);

  rememberImageFile(payload.assetId, file);
  loadPicture(payload.assetId, file);

  // The CANVAS's shape (shared/composition.js), which is no longer always the video's.
  const comp = getComposition();
  const frameAspect = comp.width / comp.height;
  const duration = videoDuration();
  const at = clampToTimeline(start);
  const layer = createImageLayer({
    assetId: payload.assetId,
    name: file.name,
    naturalWidth: width,
    naturalHeight: height,
    start: at,
    duration: duration > 0 ? Math.max(MIN_DURATION, Math.min(3, duration - at)) : 3,
    frameAspect
  });
  writeImageLayers([...getImageLayers(), layer]);
  selectImageLayer(layer.id);
  return layer;
}

// --- Editing -----------------------------------------------------------------------

/** Replaces top-level fields (start, end, enabled, layer, name...). */
export function updateImageLayer(id, patch, { recordHistory = true } = {}) {
  const layers = getImageLayers();
  const idx = layers.findIndex((img) => img.id === id);
  if (idx === -1) return null;
  const next = layers.slice();
  next[idx] = normalizeImageLayer({ ...layers[idx], ...patch });
  writeImageLayers(next, recordHistory);
  return next[idx];
}

/**
 * Merges into one nested group — 'transform', 'crop', or 'appearance' (and
 * its 'border' / 'shadow') — leaving every other field as it is.
 */
export function patchImageLayer(id, group, fields, options) {
  const layer = getImageLayer(id);
  if (!layer) return null;
  if (group === 'border' || group === 'shadow') {
    return updateImageLayer(id, { appearance: { ...layer.appearance, [group]: { ...layer.appearance[group], ...fields } } }, options);
  }
  return updateImageLayer(id, { [group]: { ...layer[group], ...fields } }, options);
}

/** Its entrance: a preset id (or 'none'), duration and easing — the motion list's entrance slot (shared/motion). */
export function setImageLayerEntrance(id, fields, options) {
  const layer = getImageLayer(id);
  if (!layer) return null;
  const current = (layer.motions || []).find((m) => m.kind === 'entrance') || {};
  const others = (layer.motions || []).filter((m) => m.kind !== 'entrance');
  const entrance = { ...current, ...fields };
  const motions = entrance.preset && entrance.preset !== 'none' ? [...others, entrance] : others;
  return updateImageLayer(id, { motions }, options);
}

/** Moves the whole clip, keeping its length. */
export function moveImageLayer(id, start, options) {
  const layer = getImageLayer(id);
  if (!layer) return null;
  const length = layer.end - layer.start;
  const d = videoDuration();
  const maxStart = d > 0 ? Math.max(0, d - length) : Number.MAX_SAFE_INTEGER;
  const nextStart = Math.max(0, Math.min(maxStart, start));
  return updateImageLayer(id, { start: nextStart, end: nextStart + length }, options);
}

/** Trims one edge, in timeline time. */
export function trimImageLayer(id, edge, time, options) {
  const layer = getImageLayer(id);
  if (!layer) return null;
  const t = clampToTimeline(time);
  if (edge === 'start') return updateImageLayer(id, { start: Math.min(t, layer.end - MIN_DURATION) }, options);
  return updateImageLayer(id, { end: Math.max(t, layer.start + MIN_DURATION) }, options);
}

// Its place among everything else is the one layer stack's
// (shared/visualLayers.js, ./layerStack.js). The `layer` field V1.3 wrote
// ('under-captions' / 'under-text' / 'over-text') is still READ — it places
// the picture in the derived default order of a project nobody has
// restacked — but nothing writes it any more.

/** A copy with its own identity, placed directly above the original and selected. */
export function duplicateImageLayer(id) {
  const layers = getImageLayers();
  const idx = layers.findIndex((img) => img.id === id);
  if (idx === -1) return null;
  // A deep copy (via JSON — the layer is plain data), so editing the copy can
  // never reach into the original's nested transform/crop/appearance.
  const copy = normalizeImageLayer({ ...JSON.parse(JSON.stringify(layers[idx])), id: undefined });
  const next = layers.slice();
  next.splice(idx + 1, 0, copy);
  updateState({ imageLayers: next, ...placeAboveInLayerOrder(copy.id, id) }, { recordHistory: true });
  selectImageLayer(copy.id);
  return copy;
}

export function removeImageLayer(id) {
  const layers = getImageLayers();
  if (!layers.some((img) => img.id === id)) return;
  updateState({
    imageLayers: layers.filter((img) => img.id !== id),
    ...(appState.selectedImageLayerId === id ? { selectedImageLayerId: null } : {})
  }, { recordHistory: true });
}

export function removeSelectedImageLayer() {
  const id = appState.selectedImageLayerId;
  if (!id) return false;
  removeImageLayer(id);
  return true;
}

// --- Selecting ---------------------------------------------------------------------

/**
 * Makes an image THE selection. Text, caption and audio selections are
 * released in the same write — one thing is selected at a time, so Delete and
 * the on-video handles always mean this.
 */
export function selectImageLayer(id) {
  if (!id) {
    if (appState.selectedImageLayerId) updateState({ selectedImageLayerId: null }, { recordHistory: false });
    return;
  }
  updateState({
    selectedImageLayerId: id,
    selectedShapeLayerId: null,
    selectedTextElementId: null,
    selectedCaptionEventId: null,
    selectedAudioClipId: null
  }, { recordHistory: false });
}

export function getSelectedImageLayer() {
  return getImageLayer(appState.selectedImageLayerId);
}

/**
 * Opens the file picker and imports the chosen picture at the playhead. A
 * failure is reported as an app toast ('bhynd:toast', shown by App.jsx), not
 * only to the console — an upload that silently does nothing looks broken.
 */
/** Opens the file picker and adds the chosen picture — at the playhead, or at `start` when given (e.g. the next beat). */
export function promptForImageFile({ start } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;
  input.style.display = 'none';
  input.id = 'image-file-input-transient';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      await importImageFile(file, start != null ? { start } : undefined);
    } catch (err) {
      console.error('[ImageImport]', err);
      window.dispatchEvent(new CustomEvent('bhynd:toast', { detail: `Image not added — ${err.message}` }));
    }
  });
  input.click();
}
