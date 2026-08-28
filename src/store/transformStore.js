/**
 * Caption-transform state — Zustand store, deliberately separate from
 * editorStore.js (see the migration plan). Backs the on-canvas move/resize/
 * rotate feature (src/js/components/canvasTransform.js):
 *
 * - `rotation` — the GLOBAL degrees value (applies to every caption unless a
 *   phrase has its own override below — mirrors how editorStore's
 *   customPosX/customPosY already work as the global manual-position value).
 * - `captionTransforms` — PER-PHRASE overrides, keyed by
 *   shared/captionTransform.js's getPhraseTransformKey — only ever populated
 *   for a phrase explicitly edited with "This Caption" selected; every other
 *   phrase keeps resolving from the global fields.
 * - `transformApplyScope` — the editor's current This/All choice, read at
 *   edit-time to decide which of the two gets written; not itself consumed
 *   by the renderer.
 *
 * Still undo-tracked alongside editorStore's fields — see
 * src/js/state.js's STYLE_KEYS, which spans both stores — so this being a
 * separate store is purely an organizational split, not a behavior change.
 */
import { create } from 'zustand';

export const TRANSFORM_DEFAULTS = {
  rotation: 0,
  captionTransforms: {},
  transformApplyScope: "all"
};

export const useTransformStore = create(() => ({ ...TRANSFORM_DEFAULTS }));
