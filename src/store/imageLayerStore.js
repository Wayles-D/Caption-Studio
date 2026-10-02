/**
 * Image layers (see shared/imageLayer.js) — the pictures placed on the
 * Images lane, and which one is selected.
 *
 * Its own store, like the text elements' (textElementStore.js), and NOT part
 * of editorStore: anything in STYLE_DEFAULTS is reset by the toolbar's
 * "Reset Style", which must never delete the user's pictures.
 *
 * `imageLayers` is part of the undoable document (and so of the saved
 * project — see src/js/state.js's getProjectSnapshot). The selection is
 * editor UI, not a document edit, so it is not.
 */
import { create } from 'zustand';

export const IMAGE_LAYER_DEFAULTS = {
  imageLayers: [],
  selectedImageLayerId: null
};

export const IMAGE_LAYER_DOCUMENT_KEYS = ['imageLayers'];

export const useImageLayerStore = create(() => ({ ...IMAGE_LAYER_DEFAULTS }));
