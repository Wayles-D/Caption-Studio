/**
 * BHYND's motion system — one engine for every visual object.
 *
 *   OBJECT LAYOUT        the object's own renderer places it at rest
 *        ↓               (text wraps, words get their final positions)
 *   BASE TRANSFORM       its stored position / scale / rotation / opacity,
 *        ↓               with KEYFRAMES interpolated over it (../keyframes.js)
 *   MOTION               a named motion's delta at this instant (./motion.js
 *        ↓               decides when and how far, ./presets.js what it does)
 *   RENDER TRANSFORM     base + delta, applied at draw time — the stored
 *                        base is never modified
 *
 * The same calls run in the live preview and the exporter, so the two cannot
 * disagree about where anything is at a given time.
 *
 * Target selection — WHICH caption, word, keyword or element a motion is put
 * on — is the editor's job (src/js/components/canvasTransform.js), not this
 * module's: here a motion and a window are all there is.
 */
export * from './easing.js';
export * from './presets.js';
export * from './motion.js';
export { evaluatePropertyAtTime, resolveAnimatableField, getKeyframeTimeRange, KEYFRAME_PROPERTIES } from '../keyframes.js';
