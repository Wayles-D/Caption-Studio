/**
 * Live preview while hovering an option.
 *
 * Hover a font, a casing, a weight, a style preset and the video shows it as it
 * would look — before you commit to it. Move away and it goes back; click and
 * it is applied for real (and is one undo step, as ever).
 *
 * HOW. A preview is the real edit, written through the same state the renderer
 * already draws from, but with history OFF and with the original remembered.
 * That means nothing new has to be taught about drawing: the caption canvas,
 * text elements, per-word styles and the legacy CSS path all react to a hover
 * exactly as they react to a click, because to them it IS a state change.
 *
 * THE ONE RULE THAT KEEPS THAT SAFE: a preview must be undone BEFORE the real
 * edit is made. The real edit records an undo snapshot of whatever state it
 * finds; if the hovered value were still sitting in the state, that snapshot
 * would already contain the new value and Undo would do nothing. So every
 * commit path calls endPreview() first (see the pointerdown handler in
 * initHoverPreview, and HoverSelect's own choose()).
 *
 * Three kinds of target, one active preview at a time:
 *   previewState         — the caption's own style (appState keys)
 *   previewTextElement   — one text element's style bag
 *   previewWordStyle     — one word's own style (font / weight / case ...)
 */
import { appState, updateState } from './state.js';
import { CREATOR_PROFILES } from '../../shared/captionConfig.js';
import { updateTextElementStyle, getTextElement } from './components/textElements.js';
import { applyWordStyleFields, getSelectedWordStyleTarget } from './components/canvasTransform.js';

/** The undo for whatever is currently being previewed, or null. */
let active = null;

/** True while a preview is applied — autosave and exports must not capture it. */
export function isPreviewing() {
  return active != null;
}

/** Undoes the current preview, if any. Safe to call any number of times. */
export function endPreview() {
  if (!active) return;
  const undo = active.undo;
  active = null;
  undo();
}

/** Ends a preview of a DIFFERENT kind/target than `next`, keeping one of the same. */
function switchTo(kind, key) {
  if (active && (active.kind !== kind || active.key !== key)) endPreview();
}

// --- The caption's own style -------------------------------------------------

/**
 * Previews `patch` (appState keys) on the caption style.
 * Moving between the items of ONE control (font A, then font B) re-applies over
 * the same remembered original rather than stacking.
 */
export function previewState(patch) {
  switchTo('state', 'state');
  if (!active) active = { kind: 'state', key: 'state', before: {}, undo() {} };
  const preview = active;

  const next = {};
  Object.entries(patch).forEach(([key, value]) => {
    // Only the FIRST value seen for a key is the original.
    if (!(key in preview.before)) preview.before[key] = appState[key];
    next[key] = value;
  });
  // A key an earlier item of this control set but this one does not: put it back.
  Object.keys(preview.before).forEach((key) => {
    if (!(key in patch)) { next[key] = preview.before[key]; delete preview.before[key]; }
  });

  preview.undo = () => updateState({ ...preview.before }, { recordHistory: false });
  updateState(next, { recordHistory: false });
}

/**
 * The same updates choosing a style preset makes — the preset itself plus the
 * font/animation/position it opts into (see CREATOR_PROFILES' auto*OnSelect) —
 * so hovering a preset shows what clicking it would do, not half of it.
 * Mirrors SidebarInspector's applyPresetSelection.
 */
export function presetPreviewPatch(presetKey) {
  const patch = { currentPreset: presetKey };
  const profile = CREATOR_PROFILES[presetKey];
  if (profile?.autoFontFamilyOnSelect) patch.fontFamily = profile.autoFontFamilyOnSelect;
  if (profile?.autoAnimationModeOnSelect) patch.animationMode = profile.autoAnimationModeOnSelect;
  if (profile?.autoPositionOnSelect) patch.position = profile.autoPositionOnSelect;
  return patch;
}

// --- One text element's style ------------------------------------------------

export function previewTextElement(id, fields) {
  switchTo('text', id);
  const element = getTextElement(id);
  if (!element) return;
  if (!active) {
    const before = { ...(element.style || {}) };
    active = {
      kind: 'text',
      key: id,
      before,
      // The whole original style bag goes back, whatever the hover added.
      undo: () => {
        const current = getTextElement(id);
        if (!current) return;
        const restore = {};
        Object.keys(current.style || {}).forEach((k) => { restore[k] = null; });
        Object.entries(before).forEach(([k, v]) => { restore[k] = v; });
        updateTextElementStyle(id, restore, { recordHistory: false });
      }
    };
  }
  updateTextElementStyle(id, fields, { recordHistory: false });
}

// --- One word's own style ----------------------------------------------------

export function previewWordStyle(wordIndex, fields) {
  switchTo('word', wordIndex);
  if (wordIndex == null) return;
  if (!active) {
    const original = { ...(getSelectedWordStyleTarget()?.style || {}) };
    active = {
      kind: 'word',
      key: wordIndex,
      undo: () => {
        const now = getSelectedWordStyleTarget()?.style || {};
        const restore = {};
        Object.keys(now).forEach((k) => { restore[k] = null; });
        Object.entries(original).forEach(([k, v]) => { restore[k] = v; });
        applyWordStyleFields(wordIndex, restore, { recordHistory: false });
      }
    };
  }
  applyWordStyleFields(wordIndex, fields, { recordHistory: false });
}

// --- Delegated hover for plain radio buttons and preset buttons ---------------
//
// Radios and buttons already deliver hover events, so they need no custom
// control — only a table of which state key each one writes. (A native
// <select> does NOT: the browser draws its open list itself and tells the page
// nothing about which item is under the pointer, which is what HoverSelect in
// src/components/HoverSelect.jsx is for.)

const RADIO_KEYS = {
  'text-case': { key: 'textCase' },
  'anim-mode': { key: 'animationMode' },
  'shadow-mode': { key: 'shadowMode' },
  'caption-mode': { key: 'captionMode' },
  'rolling-stack-alignment': { key: 'rollingStackAlignment' },
  'rolling-stack-layer-count': { key: 'rollingStackLayerCount', coerce: (v) => parseInt(v, 10) },
  'scale-overflow': { key: 'scaleOverflow' },
  'blend-scope': { key: 'blendScope' }
  // 'sub-pos' is left out on purpose: "Manual" has no position of its own to
  // show, and previewing Top/Center/Bottom would move a caption the user may
  // have placed by hand.
};

function previewFor(target) {
  const preset = target.closest?.('button[data-preset]');
  if (preset) return presetPreviewPatch(preset.dataset.preset);

  const radio = target.closest?.('label')?.querySelector?.('input[type="radio"]');
  const spec = radio && RADIO_KEYS[radio.name];
  if (spec) return { [spec.key]: spec.coerce ? spec.coerce(radio.value) : radio.value };
  return null;
}

let delegated = false;

/** Wires hover-preview for radio and preset buttons. Idempotent. */
export function initHoverPreview() {
  if (delegated) return;
  delegated = true;

  document.addEventListener('mouseover', (e) => {
    const patch = previewFor(e.target);
    if (patch) previewState(patch);
  });
  document.addEventListener('mouseout', (e) => {
    // Moving between two options of the same group goes mouseout -> mouseover;
    // only end the preview when the pointer is leaving options altogether.
    if (previewFor(e.target) && !previewFor(e.relatedTarget || document.body)) endPreview();
  });
  // BEFORE the click's own handler runs, so the real edit finds the original
  // state to snapshot for Undo (see the note at the top of this file).
  document.addEventListener('pointerdown', () => endPreview(), true);

  // A page closing mid-hover must not save the hovered look as the project's.
  window.addEventListener('pagehide', () => endPreview(), true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endPreview();
  }, true);
}
