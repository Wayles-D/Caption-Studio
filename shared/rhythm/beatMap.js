/**
 * THE BEAT MAP — what the rhythm analyser (shared/rhythm/analyzer.js) found
 * in one piece of audio, in a form any future consumer can read without
 * knowing how it was found:
 *
 *   BeatMap
 *   ├── source        what was analysed: { kind: 'track'|'video', key, duration }
 *   ├── duration      seconds of audio analysed
 *   ├── status        'ok' | 'no-rhythm' | 'silent' | 'too-short'
 *   ├── bpm           estimated tempo, or null when there is no usable pulse
 *   ├── confidence    0-1, how much to trust the beats (see CONFIDENCE_LEVELS)
 *   ├── beats[]       every beat, in time order — downbeats included
 *   ├── downbeats[]   the bar starts, a subset of beats[] — EMPTY unless the
 *   │                 audio itself gave clear evidence of where bars begin
 *   ├── meter         { beatsPerBar, confidence } when downbeats were found
 *   └── analyzerVersion
 *
 *   Beat (a rhythmic EVENT — the shape every future event type shares)
 *   ├── time          seconds, AUTHORITATIVE — never a frame or a pixel
 *   ├── strength      0-1: how strongly the beat is sounded, relative to this
 *   │                 audio's own strong beats (1 = as strong as its strongest
 *   │                 typical beat; 0 = an inferred beat with nothing sounding)
 *   ├── index         position in beats[]
 *   └── type          'beat' | 'downbeat' — future: 'onset', 'bar', 'phrase',
 *                     'drop', 'peak', 'silence', 'tempo-change'
 *
 * TIME IS SOURCE TIME: seconds into the analysed audio FILE, not the
 * timeline. Where that audio sits on the timeline (a track's start, trim,
 * loop) is applied when the beats are read (shared/rhythm/rhythmGrid.js's
 * projectBeatMap), so moving or trimming a track never makes a map stale —
 * and replacing the audio changes the source key, so an old map can never
 * be mistaken for the new audio's.
 */

/** Bump when the analysis changes: maps from an older analyser are re-made, never trusted. */
export const ANALYZER_VERSION = 2;

export const BEAT_TYPES = ['beat', 'downbeat'];

export const RHYTHM_STATUSES = ['ok', 'no-rhythm', 'silent', 'too-short'];

/** How the overall confidence reads to a person. */
export const CONFIDENCE_LEVELS = [
  { min: 0.6, label: 'High' },
  { min: 0.35, label: 'Medium' },
  { min: 0, label: 'Low' }
];

export function confidenceLabel(confidence) {
  if (!(confidence >= 0)) return 'None';
  return CONFIDENCE_LEVELS.find((l) => confidence >= l.min).label;
}

const finite = (v, fallback = null) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * The identity of an audio source, as analysed. Two sources with the same key
 * ARE the same audio; anything that changes the audio changes the key.
 *   - an imported track: its uploaded asset and its full length
 *   - the video's own sound: the video file and its length
 * Trimming and moving are NOT part of it — they change where the audio plays,
 * not what it is (see projectBeatMap).
 */
export function rhythmSourceKey(source) {
  if (!source) return null;
  const d = finite(source.duration);
  const len = d == null ? '?' : d.toFixed(2);
  if (source.kind === 'track') return source.assetId ? `track:${source.assetId}:${len}` : null;
  if (source.kind === 'video') return source.videoId ? `video:${source.videoId}:${len}` : null;
  return null;
}

function normalizeBeat(raw, index) {
  const time = finite(raw?.time);
  if (time == null || time < 0) return null;
  return {
    time,
    strength: clamp01(finite(raw.strength, 0)),
    index,
    type: BEAT_TYPES.includes(raw.type) ? raw.type : 'beat'
  };
}

/** A beat map, normalized; null for anything that isn't one (or is from an older analyser). */
export function normalizeBeatMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.analyzerVersion !== ANALYZER_VERSION) return null;
  const beats = (Array.isArray(raw.beats) ? raw.beats : [])
    .map((b) => normalizeBeat(b, 0))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
    .map((b, i) => ({ ...b, index: i }));
  const downbeats = beats.filter((b) => b.type === 'downbeat');
  return {
    source: raw.source && typeof raw.source === 'object' ? { ...raw.source } : null,
    duration: Math.max(0, finite(raw.duration, 0)),
    status: RHYTHM_STATUSES.includes(raw.status) ? raw.status : 'no-rhythm',
    bpm: finite(raw.bpm) != null && raw.bpm > 0 ? finite(raw.bpm) : null,
    confidence: clamp01(finite(raw.confidence, 0)),
    beats,
    downbeats,
    meter: raw.meter && downbeats.length ? { beatsPerBar: finite(raw.meter.beatsPerBar, 4), confidence: clamp01(finite(raw.meter.confidence, 0)) } : null,
    analyzerVersion: ANALYZER_VERSION
  };
}

/**
 * Whether a stored map is authoritative for `sourceKey`: the same audio, the
 * current analyser. Anything else is stale and must not drive anything.
 */
export function isBeatMapValidFor(map, sourceKey) {
  return !!map && !!sourceKey && map.analyzerVersion === ANALYZER_VERSION && map.source?.key === sourceKey;
}
