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
 *   by the renderer. CAPTION-level only — see `keywordApplyScope` below.
 * - `keywordApplyScope` — the keyword-editing counterpart to
 *   `transformApplyScope`, kept as its OWN field (not a repurposing of
 *   transformApplyScope) so nothing about caption-level scope can be
 *   disturbed by the keyword-scope feature. 'this' (default) | 'all' |
 *   'select'. Only meaningful when the current on-canvas selection is a
 *   KEYWORD word (see src/js/components/canvasTransform.js's
 *   selectedIsKeyword) — a selected caption or plain normal word ignores it
 *   entirely, exactly like transformApplyScope is ignored for word edits.
 * - `animationApplyScope` — a THIRD independent scope axis, this time for
 *   the on-canvas entrance-animation control specifically. Kept separate
 *   from both fields above (not a repurposing of either) because animation
 *   scope cross-cuts word/keyword/caption in a way position scope doesn't:
 *   'this' (this word/this keyword), 'same-type' (all keywords, or all
 *   normal words — which one depends on whether the current selection is a
 *   keyword), 'all-words' (every word regardless of type), 'this-caption',
 *   'all-captions'. See canvasTransform.js's applyAnimationFields/
 *   getWordIndexesForAnimationScope for the exact fan-out each value means.
 *
 * Still undo-tracked alongside editorStore's fields — see
 * src/js/state.js's STYLE_KEYS, which spans both stores — so this being a
 * separate store is purely an organizational split, not a behavior change.
 */
import { create } from 'zustand';

export const TRANSFORM_DEFAULTS = {
  rotation: 0,
  captionTransforms: {},
  transformApplyScope: "all",
  keywordApplyScope: "this",
  animationApplyScope: "this"
};

export const useTransformStore = create(() => ({ ...TRANSFORM_DEFAULTS }));
