/**
 * State Store & Reactive Event System for Caption Studio
 *
 * This module is now a thin compatibility shim over two Zustand stores
 * (src/store/editorStore.js, src/store/transformStore.js — see the
 * migration plan's Stage 1). Every export below keeps its EXACT prior
 * external behavior — appState reads/writes, updateState's batching +
 * pub/sub notify + undo-snapshot semantics, subscribe('*'|key, fn), undo/
 * redo, resetStyles, getStyleParams's output shape — so none of the six
 * existing consumers (preview.js, canvasTransform.js, sidebarInspector.js,
 * toolbar.js, rightInspector.js, main.js) needed to change for this stage.
 * Once those consumers migrate to React (Stage 2+), they can adopt
 * useEditorStore/useTransformStore directly instead of this shim.
 */
import { useEditorStore, STYLE_DEFAULTS, SESSION_DEFAULTS } from '../store/editorStore.js';
import { useTransformStore, TRANSFORM_DEFAULTS } from '../store/transformStore.js';

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

// Same combined shape/keys appState's style slice always had (used for
// undo/redo scoping and resetStyles) — spans both stores; which store a key
// actually lives in is an implementation detail entirely internal to this
// file (see storeFor below).
export const initialStyleState = { ...STYLE_DEFAULTS, ...TRANSFORM_DEFAULTS };
const STYLE_KEYS = Object.keys(initialStyleState);

const TRANSFORM_KEYS = new Set(Object.keys(TRANSFORM_DEFAULTS));

function storeFor(key) {
  return TRANSFORM_KEYS.has(key) ? useTransformStore : useEditorStore;
}

/**
 * appState — same object-like external surface as before (`appState.foo`
 * reads, `appState.foo = x` writes), now backed by whichever Zustand store
 * actually owns that key. A real Proxy (not a plain merged snapshot object)
 * is required here: preview.js does one direct-mutation write
 * (`appState.videoDuration = ...`, bypassing updateState) that must keep
 * landing in real store state, not a stale local copy.
 */
export const appState = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    return storeFor(prop).getState()[prop];
  },
  set(_target, prop, value) {
    storeFor(prop).setState({ [prop]: value });
    return true;
  },
  has(_target, prop) {
    return prop in useEditorStore.getState() || prop in useTransformStore.getState();
  }
});

// Undo / Redo History Stacks
const historyStack = [];
const redoStack = [];
const MAX_HISTORY = 30;

// Pub/Sub Listeners — unchanged hand-rolled mechanism (deliberately NOT
// replaced by Zustand's own subscribe: this preserves the exact notify
// call order/timing every existing consumer already depends on, with
// Zustand used purely as the storage layer underneath).
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
  STYLE_KEYS.forEach(k => {
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
      storeFor(key).setState({ [key]: value });
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
  STYLE_KEYS.forEach(k => {
    currentSnapshot[k] = appState[k];
  });
  redoStack.push(currentSnapshot);

  const previousSnapshot = historyStack.pop();
  Object.entries(previousSnapshot).forEach(([k, v]) => {
    storeFor(k).setState({ [k]: v });
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
  STYLE_KEYS.forEach(k => {
    currentSnapshot[k] = appState[k];
  });
  historyStack.push(currentSnapshot);

  const nextSnapshot = redoStack.pop();
  Object.entries(nextSnapshot).forEach(([k, v]) => {
    storeFor(k).setState({ [k]: v });
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
