/**
 * State Store & Reactive Event System for BHYND
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
import { useAudioStore, AUDIO_DEFAULTS, AUDIO_DOCUMENT_KEYS } from '../store/audioStore.js';
import { useTextElementStore, TEXT_ELEMENT_DEFAULTS, TEXT_ELEMENT_DOCUMENT_KEYS } from '../store/textElementStore.js';
import { useImageLayerStore, IMAGE_LAYER_DEFAULTS, IMAGE_LAYER_DOCUMENT_KEYS } from '../store/imageLayerStore.js';
import { useShapeLayerStore, SHAPE_LAYER_DEFAULTS, SHAPE_LAYER_DOCUMENT_KEYS } from '../store/shapeLayerStore.js';
import { useCompositionStore, COMPOSITION_STORE_DEFAULTS, COMPOSITION_DOCUMENT_KEYS } from '../store/compositionStore.js';
import { useRhythmStore, RHYTHM_DEFAULTS, RHYTHM_DOCUMENT_KEYS, RHYTHM_PROJECT_KEYS } from '../store/rhythmStore.js';
import { useObjectStore, OBJECT_DEFAULTS, OBJECT_DOCUMENT_KEYS, OBJECT_PROJECT_KEYS } from '../store/objectStore.js';

export const MOCK_SUBTITLES = [
  { start: 0.0, end: 2.2, text: "WELCOME TO BHYND." },
  { start: 2.4, end: 5.2, text: "WE EXTRACT AUDIO AND GENERATE SPEECH-TO-TEXT AUTOMATICALLY." },
  { start: 5.5, end: 8.2, text: "THEN WE BURN STYLISH SUBTITLES RIGHT INTO YOUR SHORT-FORM VIDEOS." },
  { start: 8.5, end: 11.5, text: "CHANNELS THAT USE CAPTIONS SEE A 40% INCREASE IN WATCH TIME!" },
  { start: 11.8, end: 14.8, text: "TAILOR THE STYLES, COLORS, AND FONTS DIRECTLY FROM THE SIDE DRAWER." },
  { start: 15.1, end: 18.2, text: "READY TO EXPORT FOR TIKTOK, INSTAGRAM REELS, AND YOUTUBE SHORTS." },
  { start: 18.5, end: 21.5, text: "PREMIUM. UNDERSTATED. PROFESSIONAL CREATOR TOOLS." }
];

// Served from public/ (bundled with the app, not a third-party CDN) — the
// previous mixkit.co URL started returning 403 Forbidden (asset removed
// upstream), silently breaking the "Try Demo Video" button in production.
export const DEFAULT_DEMO_VIDEO_URL = "/demo-video.mp4";

// Same combined shape/keys appState's style slice always had (used for
// undo/redo scoping and resetStyles) — spans both stores; which store a key
// actually lives in is an implementation detail entirely internal to this
// file (see storeFor below).
export const initialStyleState = { ...STYLE_DEFAULTS, ...TRANSFORM_DEFAULTS };

const TRANSFORM_KEYS = new Set(Object.keys(TRANSFORM_DEFAULTS));
const AUDIO_KEYS = new Set(Object.keys(AUDIO_DEFAULTS));
const TEXT_ELEMENT_KEYS = new Set(Object.keys(TEXT_ELEMENT_DEFAULTS));
const IMAGE_LAYER_KEYS = new Set(Object.keys(IMAGE_LAYER_DEFAULTS));
const SHAPE_LAYER_KEYS = new Set(Object.keys(SHAPE_LAYER_DEFAULTS));
const COMPOSITION_KEYS = new Set(Object.keys(COMPOSITION_STORE_DEFAULTS));
const RHYTHM_KEYS = new Set(Object.keys(RHYTHM_DEFAULTS));
const OBJECT_KEYS = new Set(Object.keys(OBJECT_DEFAULTS));

/**
 * What undo/redo snapshots: every caption/transform style field, PLUS the
 * audio timeline's own document fields (see src/store/audioStore.js) — so
 * placing, moving, retiming or deleting a sound effect or an audio track is
 * undoable exactly like any other editor edit, through the same single
 * history stack rather than a parallel one.
 *
 * Deliberately a SUPERSET of `initialStyleState`'s keys rather than the same
 * list: resetStyles() below still resets only `initialStyleState`, so the
 * toolbar's "Reset" restores caption STYLING without also deleting the user's
 * placed sound effects and imported music — those are content, not styling.
 * audioStore's `selectedAudioClipId` is excluded on both counts (a selection
 * is editor UI, not a document edit, and undoing onto a stale selection would
 * be surprising).
 */
const UNDO_TRACKED_KEYS = [
  ...Object.keys(initialStyleState),
  ...AUDIO_DOCUMENT_KEYS,
  // Manually placed captions and text overlays are content on exactly the
  // same footing as a placed sound effect: undoable, but NOT reset by the
  // toolbar's "Reset Style" (see the superset note above), and their
  // selection id is excluded for the same reason selectedAudioClipId is.
  ...TEXT_ELEMENT_DOCUMENT_KEYS,
  // Image layers: content, like text elements — undoable, saved with the
  // project, never touched by "Reset Style".
  ...IMAGE_LAYER_DOCUMENT_KEYS,
  // Shapes and the layer stack's stored order — content too.
  ...SHAPE_LAYER_DOCUMENT_KEYS,
  // The canvas (shape, background) and the video's styling inside it.
  ...COMPOSITION_DOCUMENT_KEYS,
  // Which audio the rhythm is read from (the analysis itself is not undoable — see below).
  ...RHYTHM_DOCUMENT_KEYS,
  // The object the user picked as their target (the detections themselves are not undoable).
  ...OBJECT_DOCUMENT_KEYS
];

/**
 * What a saved PROJECT is (see projectPersistence.js): the whole undoable
 * document above, plus the session facts needed to open it again — the
 * transcript, which server job it belongs to, and the video's length. Not
 * the selection, not processing flags, not history: those are the editor's
 * momentary state, not the project.
 */
// Saved with the project but not undoable: beat maps are analysis results
// (src/store/rhythmStore.js), kept so reopening a project needn't re-analyse.
const PROJECT_SESSION_KEYS = ['words', 'phrases', 'baseName', 'renderedVideoPath', 'videoDuration', ...RHYTHM_PROJECT_KEYS, ...OBJECT_PROJECT_KEYS];

/** The current project as a plain, cloneable object. */
export function getProjectSnapshot() {
  const snapshot = {};
  [...UNDO_TRACKED_KEYS, ...PROJECT_SESSION_KEYS].forEach((k) => { snapshot[k] = appState[k]; });
  const file = appState.uploadedFile;
  // The File object itself is stored separately (as a Blob); only what the UI
  // shows about it travels in the document.
  snapshot.uploadedFile = file ? { name: file.name, type: file.type || null, size: file.size || null, demo: !!file.demo } : null;
  return snapshot;
}

/**
 * Opens a saved project: writes every saved key back and starts a fresh undo
 * history — undoing past the moment a project was opened would step into
 * whatever was on screen before it.
 */
export function restoreProjectSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const allowed = new Set([...UNDO_TRACKED_KEYS, ...PROJECT_SESSION_KEYS, 'uploadedFile']);
  const updates = {};
  Object.entries(snapshot).forEach(([k, v]) => { if (allowed.has(k) && v !== undefined) updates[k] = v; });
  updateState({ ...updates, isLoaded: true, isProcessing: false }, { recordHistory: false });
  historyStack.length = 0;
  redoStack.length = 0;
  notify('history', { canUndo: false, canRedo: false });
}

function storeFor(key) {
  if (TRANSFORM_KEYS.has(key)) return useTransformStore;
  if (AUDIO_KEYS.has(key)) return useAudioStore;
  if (TEXT_ELEMENT_KEYS.has(key)) return useTextElementStore;
  if (IMAGE_LAYER_KEYS.has(key)) return useImageLayerStore;
  if (SHAPE_LAYER_KEYS.has(key)) return useShapeLayerStore;
  if (COMPOSITION_KEYS.has(key)) return useCompositionStore;
  if (RHYTHM_KEYS.has(key)) return useRhythmStore;
  if (OBJECT_KEYS.has(key)) return useObjectStore;
  return useEditorStore;
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
    return prop in useEditorStore.getState()
      || prop in useTransformStore.getState()
      || prop in useAudioStore.getState()
      || prop in useTextElementStore.getState()
      || prop in useImageLayerStore.getState()
      || prop in useShapeLayerStore.getState()
      || prop in useCompositionStore.getState()
      || prop in useRhythmStore.getState()
      || prop in useObjectStore.getState();
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
  UNDO_TRACKED_KEYS.forEach(k => {
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
  UNDO_TRACKED_KEYS.forEach(k => {
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
  UNDO_TRACKED_KEYS.forEach(k => {
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
 * Current undo/redo availability as a plain, callable-anytime snapshot —
 * added for React's useSyncExternalStore (Toolbar.jsx), which needs a
 * getSnapshot function it can call on demand, not just the 'history'
 * pub/sub payload notify() already pushes on each change.
 */
export function getHistoryState() {
  return { canUndo: historyStack.length > 0, canRedo: redoStack.length > 0 };
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
    // The video's OWN transform/keyframes (see shared/videoTransform.js,
    // src/js/components/videoTransform.js) — must reach the backend export
    // pipeline (backend/utils/videoTransformFilter.js) for the exported
    // file to reproduce a keyframed video zoom/pan/rotate/fade, exactly
    // like captionTransforms above already does for captions.
    videoTransform: appState.videoTransform,
    animationMode: appState.animationMode,
    captionAnimationType: appState.captionAnimationType,
    captionAnimationDuration: appState.captionAnimationDuration,
    captionAnimationEasing: appState.captionAnimationEasing,
    captionAnimationIntensity: appState.captionAnimationIntensity,
    enableKeywordHighlighting: appState.enableKeywordHighlighting,
    keywordColor: appState.keywordColor,
    keywordFont: appState.keywordFont,
    keywordScale: appState.keywordScale,
    keywordWeight: appState.keywordWeight,
    keywordAnimation: appState.keywordAnimation,
    keywordShadowEnabled: appState.keywordShadowEnabled,
    keywordOutlineEnabled: appState.keywordOutlineEnabled,
    keywordOpacity: appState.keywordOpacity,
    enableActiveHighlight: appState.enableActiveHighlight,
    textBlendMode: appState.textBlendMode,
    // The audio timeline (sound effects + imported audio tracks — see
    // shared/audioTimeline.js). Carried in the SAME canonical snapshot the
    // live preview renders from and the export pipeline is driven by, exactly
    // like captionTransforms/videoTransform above, so an exported file's audio
    // can never be resolved from different data than the preview's.
    audio: {
      soundEvents: appState.soundEvents,
      audioTracks: appState.audioTracks,
      // The source video's own soundtrack level — the third voice in the mix
      // (see shared/audioTimeline.js's VIDEO_AUDIO_DEFAULTS). Carried here so
      // the exporter applies the SAME level the preview is playing at.
      video: { volume: appState.videoVolume, muted: appState.videoMuted }
    },
    // Manually placed captions and text overlays (see shared/textElement.js).
    // Rides in the same canonical snapshot for the same reason the audio
    // timeline does: the exporter must resolve what text is on screen from
    // exactly the data the preview drew it from, never a second source.
    textElements: appState.textElements,
    // Image layers (shared/imageLayer.js) — drawn by the exporter from the
    // same records the preview draws them from.
    imageLayers: appState.imageLayers,
    // Shape layers (shared/shapeLayer.js), and the one layer stack's stored
    // order (shared/visualLayers.js) — the exporter composites in it.
    shapeLayers: appState.shapeLayers,
    layerOrder: appState.layerOrder,
    // The composition (shared/composition.js): the canvas the exporter renders
    // into, and the video's styling inside it.
    composition: appState.composition,
    videoStyle: appState.videoStyle,
    // The transcript's OWN captions, now that they are edited rather than
    // re-derived (see shared/captionEvent.js). The exporter renders these
    // instead of regrouping the word list, which is what makes a retimed,
    // split or merged caption survive an export at all.
    captionEvents: appState.captionEvents
  };
}
