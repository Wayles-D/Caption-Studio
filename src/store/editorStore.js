/**
 * Editor/style state — Zustand store.
 *
 * Holds every appState field EXCEPT the caption-transform fields (rotation /
 * captionTransforms / transformApplyScope — see transformStore.js), which
 * the migration plan calls out as their own concern. This includes both the
 * undo-tracked "style" fields (typography, colors, shadow, position, caption
 * mode, rolling-stack settings — see STYLE_DEFAULTS) and the non-undo-tracked
 * session fields (upload/processing status, transcript words/phrases —
 * SESSION_DEFAULTS), matching exactly which fields src/js/state.js's
 * pushHistorySnapshot did and didn't snapshot before this store existed.
 *
 * This store is intentionally "dumb" (no actions, no computed values) —
 * src/js/state.js's updateState/undo/redo/getStyleParams functions are the
 * ONE place that decides what a state change means, exactly as before this
 * store existed. Once UI components migrate to React (see the migration
 * plan's Stage 2+), they can start reading this store directly via
 * useEditorStore(selector) instead of going through the compatibility shim.
 */
import { create } from 'zustand';

export const STYLE_DEFAULTS = {
  currentPreset: "bold-yellow",
  fontFamily: "Montserrat",
  fontWeight: "700",
  fontSize: 14,
  wordSpacing: 4,
  lineHeight: 1.2,
  popScale: 118,
  activeWordColor: null,
  inactiveWordColor: null,
  outlineColor: null,
  backgroundColor: null,
  outlineSize: null,
  shadowColor: null,
  shadowSize: null,
  shadowOffsetX: null,
  shadowOffsetY: null,
  // 'individual' (legacy default, matches every existing project/preset),
  // 'unified', or 'none' — see resolveShadowMode in shared/captionConfig.js.
  shadowMode: 'individual',
  unifiedShadowColor: null,
  unifiedShadowOpacity: null,
  unifiedShadowBlur: null,
  unifiedShadowOffsetX: null,
  unifiedShadowOffsetY: null,
  textOpacity: 100,
  backgroundOpacity: null,
  // 'sentence' (existing default — full phrase, per-word highlighting),
  // 'word' (exactly one transcript word visible at a time), or
  // 'rolling-stack' — see resolveCaptionMode in shared/captionConfig.js.
  captionMode: "sentence",
  // Rolling Stack only: max simultaneous layers in the composition (2 or 3
  // — user-controlled, never auto-decided) and how each line is aligned
  // within the shared invisible container. See shared/rollingStack.js.
  rollingStackLayerCount: 2,
  rollingStackAlignment: "center",
  animationMode: "karaoke",
  // Entrance animation for the caption BLOCK as a whole — a separate concept
  // from animationMode above (which only governs per-word highlight timing,
  // e.g. karaoke/pop/instant/typewriter). See shared/captionAnimation.js.
  captionAnimationType: "none",
  captionAnimationDuration: 0.25,
  captionAnimationEasing: "ease-out",
  captionAnimationIntensity: 1,
  textCase: "uppercase",
  position: "bottom",
  marginV: 300,
  customPosX: 50,
  customPosY: 85,
  enableKeywordHighlighting: true,
  keywordColor: "#EF4444",
  keywordFont: null,
  keywordScale: null,
  keywordWeight: null,
  keywordAnimation: null,
  keywordShadowEnabled: null,
  keywordOutlineEnabled: null,
  keywordOpacity: 100,
  enableActiveHighlight: null,
  theme: "dark"
};

export const SESSION_DEFAULTS = {
  isProcessing: false,
  isLoaded: false,
  currentStep: 0,
  uploadedFile: null,
  videoDuration: 0,
  baseName: null,
  words: [],
  phrases: [],
  renderedVideoPath: null
};

export const useEditorStore = create(() => ({
  ...STYLE_DEFAULTS,
  ...SESSION_DEFAULTS
}));
