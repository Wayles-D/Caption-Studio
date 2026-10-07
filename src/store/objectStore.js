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
 */
import { create } from 'zustand';

export const OBJECT_DEFAULTS = {
  objectDetections: {},
  selectedObject: null,
  objectStatus: { state: 'idle', done: 0, total: 0, message: null },
  objectsMode: false,
  objectMinConfidence: 0.45,
  objectTracks: {},
  trackingStatus: { state: 'idle', done: 0, total: 0, message: null }
};

export const OBJECT_DOCUMENT_KEYS = ['selectedObject'];
export const OBJECT_PROJECT_KEYS = ['objectDetections', 'objectTracks'];

export const useObjectStore = create(() => ({ ...OBJECT_DEFAULTS }));
