/**
 * RHYTHM in the editor — the one place that knows WHICH audio the rhythm is
 * read from, gets it analysed (once), and hands every consumer the beats on
 * the timeline. Consumers (the timeline's beat ticks, snapping, "add at next
 * beat") call getTimelineBeats() and the shared/rhythm/rhythmGrid.js
 * queries; none of them knows how a beat was found.
 *
 *   audio source ─► source key ─► saved map for that key? ─► use it
 *                                       └─ no ─► decode once, analyse in a
 *                                                Web Worker, save it
 *
 * Runs only when the AUDIO changes (a track added, replaced or removed, a
 * new video, a different rhythm source) — never per frame, never in export.
 * A map belongs to its source key, so after any audio change the old map
 * simply no longer matches and is never used; trimming or moving a track
 * keeps the key (same audio) and only changes where its beats land.
 *
 * Failure of any kind — no audio, undecodable audio, a worker error — leaves
 * a status message and no beats. Editing carries on exactly as without.
 */
import { appState, subscribe, updateState } from '../state.js';
import { rhythmSourceKey, isBeatMapValidFor, normalizeBeatMap, confidenceLabel } from '../../../shared/rhythm/beatMap.js';
import { projectBeatMap, nextBeat, previousBeat, nearestBeat, beatContext, snapTimeToBeat } from '../../../shared/rhythm/rhythmGrid.js';
import { getAudioTrackDuration } from '../../../shared/audioTimeline.js';

const ANALYSIS_RATE = 22050;
const DEBOUNCE_MS = 400;

function getVideo() {
  return document.getElementById('preview-video');
}

/** The audio the rhythm is read from, resolved from the rhythmSource setting. */
export function resolveRhythmSource() {
  const choice = appState.rhythmSource || 'auto';
  const tracks = (appState.audioTracks || []).filter((t) => t.enabled !== false && t.url && t.assetId);
  const video = getVideo();
  const videoSource = () => {
    const src = video?.currentSrc || video?.src;
    if (!src || !(video.duration > 0)) return null;
    const videoId = appState.baseName || (appState.uploadedFile?.demo ? 'demo' : appState.uploadedFile?.name) || 'video';
    const source = { kind: 'video', videoId, duration: video.duration, url: src, label: 'Video sound' };
    return { ...source, key: rhythmSourceKey(source) };
  };
  const trackSource = (track) => {
    const source = { kind: 'track', assetId: track.assetId, trackId: track.id, duration: track.sourceDuration, url: track.url, label: track.name || 'Audio' };
    return { ...source, key: rhythmSourceKey(source), track };
  };
  if (choice === 'video') return videoSource();
  if (choice !== 'auto') {
    const track = tracks.find((t) => t.id === choice);
    return track ? trackSource(track) : null;
  }
  return tracks.length ? trackSource(tracks[0]) : videoSource();
}

/** The valid map for the current source, or null (none yet, or stale). */
export function getActiveBeatMap() {
  const source = resolveRhythmSource();
  if (!source?.key) return null;
  const map = appState.beatMaps?.[source.key];
  return isBeatMapValidFor(map, source.key) ? map : null;
}

let projectionCache = { sig: null, beats: [] };

/**
 * The beats ON THE TIMELINE (shared/rhythm/rhythmGrid.js's projectBeatMap),
 * for the current source and its current placement — empty when there is no
 * usable rhythm (no map, or one that found no clear pulse). Cached until the
 * map or the placement changes.
 */
export function getTimelineBeats() {
  const map = getActiveBeatMap();
  if (!map || map.status !== 'ok') return [];
  const source = resolveRhythmSource();
  const duration = getVideo()?.duration || appState.videoDuration || 0;
  const t = source.track;
  const placement = t
    ? { kind: 'track', startTime: t.startTime, trimStart: t.trimStart, trimEnd: t.trimEnd, loop: !!t.loop, duration: getAudioTrackDuration(t) }
    : { kind: 'video' };
  const sig = `${source.key}|${JSON.stringify(placement)}|${duration}`;
  if (projectionCache.sig !== sig) projectionCache = { sig, beats: projectBeatMap(map, placement, duration) };
  return projectionCache.beats;
}

// Timeline-time queries, for consumers that don't want to handle the beat list.
export const nextBeatAfter = (t, opts) => nextBeat(getTimelineBeats(), t, opts);
export const previousBeatBefore = (t, opts) => previousBeat(getTimelineBeats(), t, opts);
export const nearestBeatTo = (t, opts) => nearestBeat(getTimelineBeats(), t, opts);
export const beatsAround = (t, opts) => beatContext(getTimelineBeats(), t, opts);

/** `time` snapped onto a beat when snapping is on and one is within `threshold` seconds; otherwise unchanged. */
export function maybeSnapToBeat(time, threshold) {
  if (!appState.snapToBeats) return time;
  return snapTimeToBeat(time, getTimelineBeats(), { threshold }).time;
}

export function setSnapToBeats(on) {
  updateState({ snapToBeats: !!on }, { recordHistory: false });
  try { window.localStorage.setItem('bhynd.snapToBeats', on ? '1' : '0'); } catch { /* preference only */ }
}

export function setRhythmSource(choice) {
  if ((appState.rhythmSource || 'auto') === choice) return;
  updateState({ rhythmSource: choice }, { recordHistory: true });
}

/** What the panel shows: a short summary of what was found (or why not). */
export function describeRhythm() {
  const status = appState.rhythmStatus || {};
  const source = resolveRhythmSource();
  if (!source) return { state: 'none', title: 'No audio', detail: 'Add a video or an audio track to find its rhythm.' };
  if (status.state === 'analyzing' && status.sourceKey === source.key) return { state: 'analyzing', title: 'Analyzing rhythm…', detail: source.label };
  const map = getActiveBeatMap();
  if (!map) {
    if (status.state === 'failed' && status.sourceKey === source.key) return { state: 'failed', title: 'Couldn’t read the rhythm', detail: status.message || 'Editing works as normal.' };
    return { state: 'pending', title: 'Rhythm not analyzed yet', detail: source.label };
  }
  if (map.status === 'silent') return { state: 'none', title: 'No rhythm — the audio is silent', detail: source.label, map };
  if (map.status === 'too-short') return { state: 'none', title: 'Audio too short for a rhythm', detail: source.label, map };
  if (map.status === 'no-rhythm') return { state: 'none', title: 'No clear beat found', detail: `${source.label} · confidence ${confidenceLabel(map.confidence)}`, map };
  return {
    state: 'ready',
    title: 'Rhythm detected',
    detail: source.label,
    bpm: map.bpm,
    beats: map.beats.length,
    downbeats: map.downbeats.length,
    confidence: confidenceLabel(map.confidence),
    map
  };
}

// --- Analysis lifecycle -----------------------------------------------------

let worker = null;
let requestSeq = 0;
const inFlight = new Map(); // source key -> Promise

function getWorker() {
  if (!worker) worker = new Worker(new URL('../rhythm/rhythmWorker.js', import.meta.url), { type: 'module' });
  return worker;
}

/** Mono PCM at the analysis rate, decoded by the browser (OfflineAudioContext needs no user gesture). */
async function decodeMono(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load the audio (HTTP ${res.status})`);
  const data = await res.arrayBuffer();
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('this browser cannot decode audio');
  const ctx = new Ctor(1, 2, ANALYSIS_RATE);
  const buffer = await ctx.decodeAudioData(data);
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  return { samples: mono, sampleRate: buffer.sampleRate, duration: buffer.duration };
}

function analyzeInWorker(samples, sampleRate, source) {
  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMessage);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.map);
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ id, samples, sampleRate, source }, [samples.buffer]);
  });
}

function setStatus(state, sourceKey, message = null) {
  updateState({ rhythmStatus: { state, sourceKey, message } }, { recordHistory: false });
}

/**
 * Makes sure the current source has a valid map: reuses a saved one, or
 * analyses. Safe to call any number of times — one analysis per source key
 * runs at a time, and a result arriving after the source changed is still
 * stored under ITS key (it is correct for that audio) but drives nothing.
 */
export async function ensureRhythmAnalysis({ force = false } = {}) {
  const source = resolveRhythmSource();
  if (!source?.key) return null;
  if (!force && getActiveBeatMap()) return getActiveBeatMap();
  if (inFlight.has(source.key)) return inFlight.get(source.key);
  const job = (async () => {
    setStatus('analyzing', source.key);
    try {
      const { samples, sampleRate } = await decodeMono(source.url);
      // Stored under the key it is LOOKED UP by — the same audio, as the
      // project knows it — so it is found again next time.
      const key = source.key;
      const map = normalizeBeatMap(await analyzeInWorker(samples, sampleRate, { kind: source.kind, key, label: source.label }));
      if (!map) throw new Error('the analysis returned nothing usable');
      updateState({ beatMaps: { ...pruneMaps(appState.beatMaps), [key]: map } }, { recordHistory: false });
      setStatus('ready', key);
      return map;
    } catch (err) {
      console.warn('[Rhythm] Analysis failed — editing is unaffected:', err);
      setStatus('failed', source.key, err?.message || String(err));
      return null;
    } finally {
      inFlight.delete(source.key);
    }
  })();
  inFlight.set(source.key, job);
  return job;
}

/**
 * Keeps only maps for audio this project still has — every imported track,
 * and the current video's own sound. A replaced track or video takes its map
 * with it, so the saved project never accumulates maps for audio it lost.
 */
function pruneMaps(maps) {
  const live = new Set();
  (appState.audioTracks || []).forEach((t) => {
    live.add(rhythmSourceKey({ kind: 'track', assetId: t.assetId, duration: t.sourceDuration }));
  });
  const video = getVideo();
  if (video?.duration > 0) {
    const videoId = appState.baseName || (appState.uploadedFile?.demo ? 'demo' : appState.uploadedFile?.name) || 'video';
    live.add(rhythmSourceKey({ kind: 'video', videoId, duration: video.duration }));
  }
  return Object.fromEntries(Object.entries(maps || {}).filter(([k]) => live.has(k)));
}

let started = false;
let timer = null;
let lastKey = null;

export function initRhythm() {
  if (started) return;
  started = true;
  try {
    if (window.localStorage.getItem('bhynd.snapToBeats') === '1') updateState({ snapToBeats: true }, { recordHistory: false });
  } catch { /* preference only */ }
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const key = resolveRhythmSource()?.key ?? null;
      if (key === lastKey && getActiveBeatMap()) return;
      lastKey = key;
      projectionCache = { sig: null, beats: [] };
      ensureRhythmAnalysis();
    }, DEBOUNCE_MS);
  };
  ['audioTracks', 'rhythmSource', 'baseName', 'uploadedFile'].forEach((k) => subscribe(k, check));
  document.addEventListener('loadedmetadata', (e) => { if (e.target?.id === 'preview-video') check(); }, true);
  check();
}
