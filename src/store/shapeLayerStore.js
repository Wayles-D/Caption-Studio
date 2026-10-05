/**
 * Shape layers (shared/shapeLayer.js), the one selected, and THE LAYER
 * STACK's stored order (shared/visualLayers.js — `layerOrder`, the ids of
 * every visual object bottom to top; null until the user restacks anything).
 *
 * Its own store, not editorStore, for the same reason as the image and text
 * element stores: "Reset Style" resets editorStore's style defaults and must
 * never delete shapes or undo a restack. `shapeLayers` and `layerOrder` are
 * part of the undoable document and the saved project; the selection is not.
 */
import { create } from 'zustand';

export const SHAPE_LAYER_DEFAULTS = {
  shapeLayers: [],
  selectedShapeLayerId: null,
  layerOrder: null
};

export const SHAPE_LAYER_DOCUMENT_KEYS = ['shapeLayers', 'layerOrder'];

export const useShapeLayerStore = create(() => ({ ...SHAPE_LAYER_DEFAULTS }));
