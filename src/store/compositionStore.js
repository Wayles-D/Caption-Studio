/**
 * THE COMPOSITION (shared/composition.js) — the canvas's shape and
 * background — and the video's own styling inside it (rounded corners,
 * border, shadow). The video's position/scale/rotation stay where they have
 * always lived, in videoTransform (src/store/transformStore.js), because they
 * keyframe; these don't.
 *
 * Both are null until the user changes them, which is every project made
 * before V1.5: null resolves to the defaults — the source video's own frame,
 * black, no decoration — i.e. exactly what those projects always rendered.
 *
 * Its own store, not editorStore, for the same reason as the layer stores:
 * "Reset Style" resets caption styling and must not reshape the canvas. Both
 * keys are part of the undoable document and the saved project.
 */
import { create } from 'zustand';

export const COMPOSITION_STORE_DEFAULTS = {
  composition: null,
  videoStyle: null
};

export const COMPOSITION_DOCUMENT_KEYS = ['composition', 'videoStyle'];

export const useCompositionStore = create(() => ({ ...COMPOSITION_STORE_DEFAULTS }));
