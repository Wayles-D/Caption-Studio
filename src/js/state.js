/**
 * State Store & Reactive Event System for Caption Studio
 */

export const MOCK_SUBTITLES = [
  { start: 0.0, end: 2.2, text: "WELCOME TO THE CAPTION STUDIO." },
  { start: 2.4, end: 5.2, text: "WE EXTRACT AUDIO AND GENERATE SPEECH-TO-TEXT AUTOMATICALLY." },
  { start: 5.5, end: 8.2, text: "THEN WE BURN STYLISH SUBTITLES RIGHT INTO YOUR SHORT-FORM VIDEOS." },
  { start: 8.5, end: 11.5, text: "CHANNELS THAT USE CAPTIONS SEE A 40% INCREASE IN WATCH TIME!" },
  { start: 11.8, end: 14.8, text: "TAILOR THE STYLES, COLORS, AND FONTS DIRECTLY FROM THE SIDE DRAWER." },
  { start: 15.1, end: 18.2, text: "READY TO EXPORT FOR TIKTOK, INSTAGRAM REELS, AND YOUTUBE SHORTS." },
  { start: 18.5, end: 21.5, text: "PREMIUM. UNDERSTATED. PROFESSIONAL CREATOR TOOLS." }
];

export const DEFAULT_DEMO_VIDEO_URL = "https://assets.mixkit.co/videos/preview/mixkit-vertical-shot-of-a-beautiful-waterfall-in-a-forest-48990-large.mp4";

export const initialStyleState = {
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
  // 'sentence' (existing default — full phrase, per-word highlighting) or
  // 'word' (exactly one transcript word visible at a time) — see
  // resolveCaptionMode in shared/captionConfig.js.
  captionMode: "sentence",
  // Rolling Stack only: max simultaneous layers in the composition (2 or 3
  // — user-controlled, never auto-decided) and how each line is aligned
  // within the shared invisible container. See shared/rollingStack.js.
  rollingStackLayerCount: 2,
  rollingStackAlignment: "center",
  animationMode: "karaoke",
  textCase: "uppercase",
  position: "bottom",
  marginV: 300,
  customPosX: 50,
  customPosY: 85,
  // On-canvas transform controls (see src/js/components/canvasTransform.js).
  // `rotation` is the GLOBAL degrees value (applies to every caption unless
  // a phrase has its own override below — mirrors how customPosX/Y already
  // work as the global manual-position value). `captionTransforms` holds
  // PER-PHRASE overrides, keyed by shared/captionTransform.js's
  // getPhraseTransformKey — only ever populated for a phrase the user
  // explicitly edited with "Apply to THIS CAPTION" selected; every other
  // phrase is untouched and keeps resolving from the global fields exactly
  // as before this feature existed. `transformApplyScope` is the editor's
  // current This/All choice, read at edit-time to decide which of the two
  // gets written — it is not itself consumed by the renderer.
  rotation: 0,
  captionTransforms: {},
  transformApplyScope: "all",
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

export let appState = {
  ...initialStyleState,
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

// Undo / Redo History Stacks
const historyStack = [];
const redoStack = [];
const MAX_HISTORY = 30;

// Pub/Sub Listeners
const listeners = new Map();

/**
 * Subscribe to state key changes or wildcard '*'
 */
export function subscribe(key, fn) {
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key).add(fn);

  return () => {
    listeners.get(key)?.delete(fn);
  };
}

/**
 * Notify subscribers of state changes
 */
export function notify(key, value) {
  if (listeners.has(key)) {
    listeners.get(key).forEach(fn => fn(value, appState));
  }
  if (listeners.has('*')) {
    listeners.get('*').forEach(fn => fn(key, value, appState));
  }
}

/**
 * Save current style state snapshot before mutating
 */
function pushHistorySnapshot() {
  const snapshot = {};
  Object.keys(initialStyleState).forEach(k => {
    snapshot[k] = appState[k];
  });

  historyStack.push(snapshot);
  if (historyStack.length > MAX_HISTORY) {
    historyStack.shift();
  }
  redoStack.length = 0; // Clear redo on new action
  notify('history', { canUndo: historyStack.length > 0, canRedo: false });
}

/**
 * Batch update state properties with automatic pub/sub notification and undo snapshot
 */
export function updateState(updates, options = { recordHistory: true }) {
  if (options.recordHistory) {
    pushHistorySnapshot();
  }

  let changed = false;
  Object.entries(updates).forEach(([key, value]) => {
    if (appState[key] !== value) {
      appState[key] = value;
      changed = true;
      notify(key, value);
    }
  });

  if (changed) {
    notify('stateChanged', appState);
  }
}

/**
 * Undo style state change
 */
export function undo() {
  if (historyStack.length === 0) return;

  const currentSnapshot = {};
  Object.keys(initialStyleState).forEach(k => {
    currentSnapshot[k] = appState[k];
  });
  redoStack.push(currentSnapshot);

  const previousSnapshot = historyStack.pop();
  Object.entries(previousSnapshot).forEach(([k, v]) => {
    appState[k] = v;
    notify(k, v);
  });

  notify('history', { canUndo: historyStack.length > 0, canRedo: redoStack.length > 0 });
  notify('stateChanged', appState);
}

/**
 * Redo style state change
 */
export function redo() {
  if (redoStack.length === 0) return;

  const currentSnapshot = {};
  Object.keys(initialStyleState).forEach(k => {
    currentSnapshot[k] = appState[k];
  });
  historyStack.push(currentSnapshot);

  const nextSnapshot = redoStack.pop();
  Object.entries(nextSnapshot).forEach(([k, v]) => {
    appState[k] = v;
    notify(k, v);
  });

  notify('history', { canUndo: historyStack.length > 0, canRedo: redoStack.length > 0 });
  notify('stateChanged', appState);
}

/**
 * Reset styles back to preset defaults
 */
export function resetStyles() {
  updateState({ ...initialStyleState }, { recordHistory: true });
}

/**
 * Single source of truth for resolved caption style parameters.
 * Every consumer (preview CSS, sidebar UI sync, upload/regenerate payloads)
 * must derive its params object from this function so preview and export
 * always resolve styling from identical input.
 */
export function getStyleParams() {
  return {
    preset: appState.currentPreset,
    fontFamily: appState.fontFamily,
    fontSize: appState.fontSize,
    wordSpacing: appState.wordSpacing,
    popScale: appState.popScale,
    activeWordColor: appState.activeWordColor,
    inactiveWordColor: appState.inactiveWordColor,
    outlineColor: appState.outlineColor,
    backgroundColor: appState.backgroundColor,
    outlineSize: appState.outlineSize,
    shadowColor: appState.shadowColor,
    shadowSize: appState.shadowSize,
    shadowOffsetX: appState.shadowOffsetX,
    shadowOffsetY: appState.shadowOffsetY,
    shadowMode: appState.shadowMode,
    unifiedShadowColor: appState.unifiedShadowColor,
    unifiedShadowOpacity: appState.unifiedShadowOpacity,
    unifiedShadowBlur: appState.unifiedShadowBlur,
    unifiedShadowOffsetX: appState.unifiedShadowOffsetX,
    unifiedShadowOffsetY: appState.unifiedShadowOffsetY,
    textOpacity: appState.textOpacity,
    backgroundOpacity: appState.backgroundOpacity,
    captionMode: appState.captionMode,
    rollingStackLayerCount: appState.rollingStackLayerCount,
    rollingStackAlignment: appState.rollingStackAlignment,
    textCase: appState.textCase,
    position: appState.position,
    customPosX: appState.customPosX,
    customPosY: appState.customPosY,
    rotation: appState.rotation,
    captionTransforms: appState.captionTransforms,
    animationMode: appState.animationMode,
    enableKeywordHighlighting: appState.enableKeywordHighlighting,
    keywordColor: appState.keywordColor,
    keywordFont: appState.keywordFont,
    keywordScale: appState.keywordScale,
    keywordWeight: appState.keywordWeight,
    keywordAnimation: appState.keywordAnimation,
    keywordShadowEnabled: appState.keywordShadowEnabled,
    keywordOutlineEnabled: appState.keywordOutlineEnabled,
    keywordOpacity: appState.keywordOpacity,
    enableActiveHighlight: appState.enableActiveHighlight
  };
}
