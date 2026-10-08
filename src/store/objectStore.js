/**
 * OBJECTS (shared/objects/) in the editor:
 *
 *   objectDetections   detection sets, keyed by detection cache key (video +
 *                      model + settings — see shared/objects/detections.js).
 *                      Saved with the project so a reopened project needn't
 *                      re-scan; NOT undoable — it is a fact about the video.
 *   selectedObject     the detection the user picked as their target: an
 *                      editing intent, so undoable and saved.
 *   objectStatus       what the detector is doing now (session only).
 *   objectsMode        whether the Objects overlay is up (session only).
 *   objectMinConfidence  what the overlay shows (session only).
 *   objectTracks       object tracks (shared/objects/tracking.js), keyed by
 *                      track cache key. Saved, not undoable — like the
 *                      detections they are built from, an analysis result.
 *   trackingStatus     what the tracker is doing now (session only).
 *   objectEffects      object-aware effects (shared/objects/effects.js): each
 *                      FOLLOWS a track by its key. Editing work, so undoable
 *                      and saved — like shapes.
 *   selectedObjectEffectId  the effect being edited (session only).
 *   objectSegmentations  segmentation RECORDS (shared/objects/segmentation.js),
 *                      keyed by segmentation cache key — keyframe times and
 *                      confidences, no pixels (those are an analysis file:
 *                      projectPersistence.js's putAnalysisFile). Saved, not
 *                      undoable — an analysis result, like tracks.
 *   segmentationStatus what the segmenter is doing now (session only).
 *   maskView           how the editor shows a mask: 'off' | 'overlay' |
 *                      'silhouette' | 'boundary' (session only, editor-only).
 */
import { create } from 'zustand';

export const OBJECT_DEFAULTS = {
  objectDetections: {},
  selectedObject: null,
  objectStatus: { state: 'idle', done: 0, total: 0, message: null },
  objectsMode: false,
  objectMinConfidence: 0.45,
  objectTracks: {},
  trackingStatus: { state: 'idle', done: 0, total: 0, message: null },
  objectEffects: [],
  selectedObjectEffectId: null,
  objectSegmentations: {},
  segmentationStatus: { state: 'idle', done: 0, total: 0, message: null, backend: null },
  maskView: 'overlay'
};

export const OBJECT_DOCUMENT_KEYS = ['selectedObject', 'objectEffects'];
export const OBJECT_PROJECT_KEYS = ['objectDetections', 'objectTracks', 'objectSegmentations'];

export const useObjectStore = create(() => ({ ...OBJECT_DEFAULTS }));
