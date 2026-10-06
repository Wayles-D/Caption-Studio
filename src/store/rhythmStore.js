/**
 * RHYTHM (shared/rhythm/) in the editor:
 *
 *   rhythmSource   which audio the rhythm is read from — 'auto' (the first
 *                  imported audio track, else the video's own sound), 'video',
 *                  or a track id. A user choice: undoable, saved.
 *   beatMaps       analysis results, keyed by source key (beatMap.js's
 *                  rhythmSourceKey). Saved with the project so reopening it
 *                  doesn't re-analyse — but NOT undoable: it is a cache of a
 *                  fact about the audio, not an edit.
 *   rhythmStatus   what the analyser is doing now (session only).
 *   snapToBeats    whether dragging clips snaps them to beats (an editor
 *                  preference, off until turned on).
 */
import { create } from 'zustand';

export const RHYTHM_DEFAULTS = {
  rhythmSource: 'auto',
  beatMaps: {},
  rhythmStatus: { state: 'idle', sourceKey: null, message: null },
  snapToBeats: false
};

export const RHYTHM_DOCUMENT_KEYS = ['rhythmSource'];
export const RHYTHM_PROJECT_KEYS = ['beatMaps'];

export const useRhythmStore = create(() => ({ ...RHYTHM_DEFAULTS }));
