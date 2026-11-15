/**
 * The "put this behind someone" job, as the UI sees it — so its progress
 * shows wherever the layer's panel is open, even when the job was started by
 * something other than a click there (a clip stretched on the timeline
 * extends the follow on its own; see tamSegmentation.js).
 *
 *   picking — { layerId } while waiting for the person to be clicked (or a box
 *             drawn) on the video;
 *   job     — { layerId, kind: 'follow'|'extend', label, done, total,
 *             secondsLeft } while frames are being processed;
 *   problem — { layerId, message } — plain words when it went wrong.
 *
 * Session state only: none of it is part of the project.
 */
import { create } from 'zustand';

export const useFollowStore = create((set) => ({
  picking: null,
  job: null,
  problem: null,
  setPicking: (picking) => set({ picking }),
  setJob: (job) => set({ job }),
  setProblem: (problem) => set({ problem })
}));
