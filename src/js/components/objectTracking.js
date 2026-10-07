/**
 * OBJECT TRACKING in the editor — follows the SELECTED object
 * (objectDetection.js's getSelectedObject) through the video and keeps the
 * result. Consumers ask:
 *
 *   getSelectedTrack()          the selected object's track, if it has one
 *   getTrackedStateAt(t)        where it is at t (shared/objects/tracking.js's
 *                               getTrackAtTime) — null where the track has no
 *                               claim (before it starts, after it is lost)
 *
 * Detection ends where this begins: the tracker (shared/objects/tracking.js)
 * gets each frame's detections from objectDetection.js's observeFrame — the
 * same detector (zoomed in where the object is small; the two directions on
 * two lanes, side by side) — and decides which of them is the selected
 * object. What it looks at is kept for the session only, never saved. Nothing here detects, and nothing here draws (objectOverlay.js).
 *
 * Runs only when asked ("Track object") — never per frame, never in export.
 * The result is stored under a key made of the video, the detections, the
 * starting detection, the tracker's version and its settings: change any of
 * them and the old track no longer applies.
 */
import { appState, updateState } from '../state.js';
import { trackObject, trackCacheKey, isTrackValidFor, normalizeTrack, getTrackAtTime, DEFAULT_TRACK_CONFIG } from '../../../shared/objects/tracking.js';
import { getSelectedObject, getDetectionSet, getDetectionSource, getCacheKey, observeFrame } from './objectDetection.js';

/** The selected object's track key (whether or not a track exists yet). */
export function getSelectedTrackKey() {
  const sel = getSelectedObject();
  return sel ? trackCacheKey(getCacheKey(), sel.detectionId, DEFAULT_TRACK_CONFIG) : null;
}

/** The selected object's track, or null (none yet, or stale). */
export function getSelectedTrack() {
  const key = getSelectedTrackKey();
  const track = key ? appState.objectTracks?.[key] : null;
  return isTrackValidFor(track, key) ? track : null;
}

/** The selected object at `time`, from its track. */
export function getTrackedStateAt(time) {
  const track = getSelectedTrack();
  return track ? getTrackAtTime(track, time) : null;
}

function setStatus(patch) {
  updateState({ trackingStatus: { ...(appState.trackingStatus || {}), ...patch } }, { recordHistory: false });
}

let job = null;
let cancelled = false;

export function isTracking() {
  return !!job;
}

/** Stops a running track; what was followed so far is kept, marked as cut short. */
export function cancelTracking() {
  if (job) cancelled = true;
}

/**
 * Tracks the selected object, forward and backward from the frame it was
 * picked in. A track that already exists for it is reused, not redone.
 */
export async function trackSelectedObject({ force = false } = {}) {
  if (job) return job;
  const sel = getSelectedObject();
  const source = getDetectionSource();
  if (!sel || !source) return null;
  if (!force && getSelectedTrack()) return getSelectedTrack();
  const key = getSelectedTrackKey();
  const detectionCacheKey = getCacheKey();
  cancelled = false;
  job = (async () => {
    setStatus({ state: 'tracking', done: 0, total: 0, message: null, key });
    try {
      // The starting detection, and its fingerprint in its own frame.
      const start = await observeFrame(sel.timestamp);
      const detection = start.candidates.find((c) => c.id === sel.detectionId)
        || getDetectionSet()?.frames.flatMap((f) => f.detections).find((d) => d.id === sel.detectionId);
      if (!detection) throw new Error('the selected object is no longer among the detections');
      const raw = await trackObject({
        detection,
        appearance: detection.appearance,
        startThumb: start.thumb,
        // The video's own pixels: the tracker zooms in on small objects.
        frameSize: { width: source.width, height: source.height },
        duration: source.duration,
        config: DEFAULT_TRACK_CONFIG,
        observe: (t, look) => observeFrame(t, look),
        onProgress: (done, total) => setStatus({ done, total }),
        isCancelled: () => cancelled || getCacheKey() !== detectionCacheKey
      });
      if (getCacheKey() !== detectionCacheKey) return null; // the video changed meanwhile
      const track = normalizeTrack({ ...raw, source: { videoKey: source.key, detectionCacheKey } });
      if (!track) throw new Error('the tracker returned nothing usable');
      // Only the current video's tracks are kept: a replaced video takes its
      // tracks with it.
      const kept = Object.fromEntries(Object.entries(appState.objectTracks || {}).filter(([k, t]) => k !== key && t?.source?.detectionCacheKey === detectionCacheKey));
      updateState({ objectTracks: { ...kept, [key]: track } }, { recordHistory: false });
      setStatus({ state: 'done', message: null });
      return track;
    } catch (err) {
      console.warn('[Objects] Tracking failed — editing is unaffected:', err);
      setStatus({ state: 'failed', message: err?.message || String(err) });
      return null;
    }
  })();
  job.finally(() => { job = null; });
  return job;
}

const END_WORDS = {
  'video-start': 'the start of the video',
  'video-end': 'the end of the video',
  exited: 'it left the frame',
  lost: 'it couldn’t be followed further',
  cut: 'the shot changed',
  limit: 'the tracking limit',
  cancelled: 'you stopped it'
};

/** The track in plain words, for the panel. */
export function describeTrack(track) {
  if (!track) return null;
  const titles = { completed: 'Tracked', 'low-confidence': 'Tracked — low confidence', lost: 'Track lost', partial: 'Tracked — stopped early', failed: 'Tracking failed' };
  const parts = [];
  if (track.ends?.backward) parts.push(`back to ${track.startTime.toFixed(1)}s (${END_WORDS[track.ends.backward.reason] || track.ends.backward.reason})`);
  if (track.ends?.forward) parts.push(`on to ${track.endTime.toFixed(1)}s (${END_WORDS[track.ends.forward.reason] || track.ends.forward.reason})`);
  const uncertain = track.samples.filter((s) => s.state === 'uncertain').length;
  const gaps = (track.gaps || []).map((g) => `${g.reason === 'exited' ? 'out of the frame' : 'out of sight'} ${g.start.toFixed(1)}–${g.end.toFixed(1)}s, then found again`);
  const notes = [
    gaps.length ? `${gaps.join('; ')}.` : null,
    uncertain ? `${uncertain} of ${track.samples.length} frames uncertain (hidden, crossing or partly visible).` : null
  ].filter(Boolean);
  return {
    title: titles[track.status] || track.status,
    detail: `Followed ${parts.join(', ')}.`,
    note: notes.length ? notes.join(' ') : null,
    confidence: track.confidence
  };
}
