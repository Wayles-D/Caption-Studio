/**
 * THE RHYTHM GRID — every question a consumer asks of a beat map, in one
 * place, so no UI component ever searches beats itself:
 *
 *   nearestBeat(beats, 4.82)        the beat closest to 4.82s
 *   nextBeat(beats, 6.3)            the first beat after 6.3s
 *   previousBeat(beats, 6.3)        the last beat before 6.3s
 *   beatsBetween(beats, 2, 7)       every beat in [2, 7]
 *   nearestDownbeat(beats, t)       the closest bar start
 *   snapTimeToBeat(t, beats, opts)  t moved onto a beat — if one is close enough
 *   beatContext(beats, t)           previous / nearest / next, at once
 *
 * `beats` is any time-sorted list of events with a `time` (and `type`,
 * `strength`) — a beat map's beats, or the TIMELINE beats projectBeatMap
 * returns. Every search is a binary search, so these are cheap enough for a
 * drag handler, but none of them belongs in a per-frame render loop.
 *
 * Filters (`opts.types`, `opts.minStrength`) choose WHICH events count —
 * "downbeats only", "strong beats only" — which is where future editorial
 * rules ("every 2 beats", "strong beats only") plug in, without the
 * searches knowing.
 */

/** Index of the first event with time >= t (events.length if none). */
function lowerBound(events, t) {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function filtered(events, opts = {}) {
  const types = opts.types ? new Set(opts.types) : null;
  const min = opts.minStrength ?? 0;
  if (!types && !(min > 0)) return events || [];
  return (events || []).filter((e) => (!types || types.has(e.type)) && (e.strength ?? 1) >= min);
}

export function nearestBeat(beats, t, opts) {
  const list = filtered(beats, opts);
  if (!list.length) return null;
  const i = lowerBound(list, t);
  const after = list[i];
  const before = list[i - 1];
  if (!after) return before;
  if (!before) return after;
  return t - before.time <= after.time - t ? before : after;
}

/** The first beat strictly AFTER t (a beat exactly at t is "now", not next). */
export function nextBeat(beats, t, opts) {
  const list = filtered(beats, opts);
  const EPS = 1e-6;
  const i = lowerBound(list, t + EPS);
  return list[i] || null;
}

/** The last beat strictly BEFORE t. */
export function previousBeat(beats, t, opts) {
  const list = filtered(beats, opts);
  const EPS = 1e-6;
  const i = lowerBound(list, t - EPS);
  return list[i - 1] || null;
}

/** Every beat with start <= time <= end. */
export function beatsBetween(beats, start, end, opts) {
  const list = filtered(beats, opts);
  if (!(end >= start)) return [];
  const out = [];
  for (let i = lowerBound(list, start); i < list.length && list[i].time <= end; i++) out.push(list[i]);
  return out;
}

export function nearestDownbeat(beats, t) {
  return nearestBeat(beats, t, { types: ['downbeat'] });
}

/** Previous, nearest and next beat around t — what the playhead reports. */
export function beatContext(beats, t, opts) {
  return { previous: previousBeat(beats, t, opts), nearest: nearestBeat(beats, t, opts), next: nextBeat(beats, t, opts) };
}

/**
 * `time` moved onto the nearest qualifying beat — but only if that beat is
 * within `threshold` seconds; otherwise `time` unchanged. The threshold is
 * the caller's (a drag converts "8 pixels" to seconds at the current zoom):
 * nothing here decides how close is close enough, and nothing snaps unless
 * a caller asks.
 * @returns {{time:number, snapped:boolean, beat:object|null}}
 */
export function snapTimeToBeat(time, beats, opts = {}) {
  const beat = nearestBeat(beats, time, opts);
  const threshold = opts.threshold ?? Infinity;
  if (!beat || Math.abs(beat.time - time) > threshold) return { time, snapped: false, beat: null };
  return { time: beat.time, snapped: true, beat };
}

/**
 * A beat map's beats on the TIMELINE, for where its audio plays.
 *   - the video's own sound: the timeline IS the source's time
 *   - an imported track: shifted by its start, cut to its trim window, and
 *     repeated when it loops — exactly how the audio engine plays it
 * @param {object} map - A beat map (shared/rhythm/beatMap.js).
 * @param {{kind:'video'}|{kind:'track', startTime:number, trimStart:number, trimEnd:number|null, loop:boolean, duration:number|null}} placement
 * @param {number} timelineDuration - The video's length; nothing past it is returned.
 */
export function projectBeatMap(map, placement, timelineDuration) {
  if (!map || !map.beats?.length) return [];
  const end = timelineDuration > 0 ? timelineDuration : Infinity;
  if (!placement || placement.kind === 'video') return map.beats.filter((b) => b.time <= end);
  const trimStart = placement.trimStart || 0;
  const trimEnd = placement.trimEnd ?? map.duration;
  const windowLen = Math.max(0, trimEnd - trimStart);
  if (!(windowLen > 0)) return [];
  const playLen = placement.duration ?? (placement.loop ? end - placement.startTime : windowLen);
  const playEnd = Math.min(end, placement.startTime + playLen);
  const inWindow = map.beats.filter((b) => b.time >= trimStart && b.time < trimEnd);
  const out = [];
  for (let pass = 0; ; pass++) {
    const offset = placement.startTime + pass * windowLen - trimStart;
    if (placement.startTime + pass * windowLen >= playEnd) break;
    for (const b of inWindow) {
      const t = b.time + offset;
      if (t >= playEnd) break;
      out.push({ ...b, time: +t.toFixed(4), sourceTime: b.time });
    }
    if (!placement.loop) break;
  }
  return out.map((b, i) => ({ ...b, index: i }));
}
