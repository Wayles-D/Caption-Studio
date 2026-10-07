/**
 * OBJECT TRACKING — where a SELECTED detection (shared/objects/detections.js)
 * is over time. Pure: the frames and the detector are supplied by the caller
 * (the editor's frame grabber and worker, or ffmpeg + onnxruntime in tests),
 * so what is tested is exactly what runs.
 *
 *   ObjectTrack
 *   ├── analysisType      'objectTracking'
 *   ├── analysisVersion   this file's data format
 *   ├── tracker           { id, version } — which method made it
 *   ├── config            the step and limits it was made with
 *   ├── source            { videoKey, detectionCacheKey }
 *   ├── sourceObjectId    the detection it started from (V1.7 id)
 *   ├── class, label
 *   ├── startTime, endTime
 *   ├── samples[]         { time, box (0-1 of the displayed video frame),
 *   │                       confidence 0-1, state 'tracked'|'uncertain',
 *   │                       detectionId? } — time-sorted, AUTHORITATIVE
 *   ├── gaps[]            { start, end, reason } — stretches where the object
 *   │                     could not be followed (hidden too long, out of the
 *   │                     frame) and was then FOUND AGAIN; nothing is claimed
 *   │                     inside a gap
 *   ├── ends              { forward, backward }: { reason, time }
 *   │                     reason: 'video-start'|'video-end'|'exited'|'lost'|'cut'|'limit'|'cancelled'
 *   ├── confidence        0-1 over the whole track
 *   └── status            'completed'|'low-confidence'|'lost'|'partial'|'failed'
 *                         (partial: stopped by the user before either end)
 *
 * THE METHOD — tracking by detection, with an appearance check:
 *   at each step (every `config.step` seconds — up to `config.maxStep` while
 *   the object moves smoothly with nobody near it — with an extra frame
 *   wherever it moved far between two), the detector LOOKS where the object
 *   should be: a zoomed crop around the prediction (frames.js), so a small
 *   or distant object is seen at a size the detector can find. The frame's
 *   detections of the SAME class are scored against where the object should
 *   be:
 *     - motion: its last position plus its own velocity plus how the CAMERA
 *       moved since (a pan moves everything; frames.js measures it) → a
 *       predicted box; a candidate is only considered inside a gate around it;
 *     - overlap with the predicted box (IoU) and closeness of centres;
 *     - appearance: a colour fingerprint (appearance.js) compared with the
 *       object's own, which only updates on clean, unambiguous matches.
 *   The best candidate is accepted only if it is good enough AND clearly
 *   better than any rival — two same-class candidates scoring alike is
 *   AMBIGUOUS, and an ambiguous step is never resolved by guessing: the
 *   track holds its prediction for that step, marked 'uncertain'.
 *   No match: the track coasts on its prediction ('uncertain') for up to
 *   `maxCoastSeconds` — `maxHiddenSeconds` while another object of its class
 *   stands where it should be (it is most likely behind them). If the
 *   object was leaving the frame it has EXITED; if the coast runs out it is
 *   LOST; if the picture itself changed it is a CUT. Either way the
 *   uncertain tail is dropped — nothing claims the object was somewhere it
 *   can't be shown to have been.
 *
 * FOUND AGAIN: after it is lost or exits, the tracker keeps looking for up
 * to `reacquireSeconds` — for a same-class object that looks like it
 * (fingerprint ≥ REID_SIMILARITY, and clearly more like it than anyone
 * else), the right shape and size, seen in TWO consecutive frames. Then it
 * follows it on, and the time in between is a gap. Never across a cut, and
 * never for long: this is "came back from behind the wall", not recognising
 * someone in another scene.
 */
import { appearanceSimilarity, blendAppearance } from './appearance.js';
import { regionFor, cameraShift } from './frames.js';

export const TRACK_ANALYSIS_TYPE = 'objectTracking';
export const TRACK_ANALYSIS_VERSION = 2;
export const TRACKER = { id: 'bhynd-tbd', version: '2.0.0' };

export const DEFAULT_TRACK_CONFIG = {
  /** Seconds between analysed frames (5 a second). */
  step: 0.2,
  /** The longest step, for an object moving smoothly with nothing near it. */
  maxStep: 0.4,
  /** The smallest step a fast move is refined to. */
  minStep: 0.05,
  /** How long the track may hold its prediction with no match before it is lost. */
  maxCoastSeconds: 1.0,
  /** ...while another object of its class stands where it should be (it is behind them). */
  maxHiddenSeconds: 2.0,
  /** After it is lost or exits, how long to keep looking for it to come back. */
  reacquireSeconds: 3.0,
  /** How far from the selected frame it tracks, each way. */
  maxSeconds: 60
};

export const TRACK_STATUSES = ['completed', 'low-confidence', 'lost', 'partial', 'failed'];
export const TRACK_END_REASONS = ['video-start', 'video-end', 'exited', 'lost', 'cut', 'limit', 'cancelled'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** The part of a box inside the frame, as a fraction of the box. */
function visibleFraction(b) {
  const w = Math.max(0, Math.min(1, b.x + b.width) - Math.max(0, b.x));
  const h = Math.max(0, Math.min(1, b.y + b.height) - Math.max(0, b.y));
  return b.width > 0 && b.height > 0 ? (w * h) / (b.width * b.height) : 0;
}

function clipBox(b) {
  const x = clamp01(b.x);
  const y = clamp01(b.y);
  return { x, y, width: Math.max(0, Math.min(1, b.x + b.width) - x), height: Math.max(0, Math.min(1, b.y + b.height) - y) };
}

function contains(b, p) {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

/** Which cache a track belongs in: the video's detections, the start detection, the method and its settings. */
export function trackCacheKey(detectionCacheKey, sourceObjectId, config = DEFAULT_TRACK_CONFIG) {
  if (!detectionCacheKey || !sourceObjectId) return null;
  const c = { ...DEFAULT_TRACK_CONFIG, ...config };
  return `${detectionCacheKey}|track:${sourceObjectId}|${TRACKER.id}@${TRACKER.version}|v${TRACK_ANALYSIS_VERSION}`
    + `|s${c.step}-${c.maxStep}c${c.maxCoastSeconds}h${c.maxHiddenSeconds}r${c.reacquireSeconds}m${c.maxSeconds}`;
}

// --- One step ------------------------------------------------------------------

/** The tracker's running state for ONE direction. */
export function startTracker(detection, appearance, thumb = null) {
  return {
    cls: detection.class,
    box: { ...detection.box },
    time: detection.time,
    velocity: { x: 0, y: 0 },
    // The object's established SHAPE (width/height), learned only from clean
    // matches. Walking towards the camera changes a box's size but not its
    // shape; being half hidden changes its shape — that is how a partial
    // view is told from a real change of size.
    aspect: detection.box.width / detection.box.height,
    template: appearance || null,
    coastSince: null,
    matches: 0,
    lastMatched: { box: { ...detection.box }, time: detection.time },
    // The camera: how far the picture has moved since the last match, and
    // how fast it was moving at the last analysed frame (`thumb`, `thumbTime`).
    cam: { x: 0, y: 0 },
    camVelocity: { x: 0, y: 0 },
    thumb,
    thumbTime: detection.time,
    // Whether another object of its class was close to it at the last step.
    nearby: false,
    seen: []
  };
}

/** Where the object should be at `time`: its last reliable box, moved by its own velocity and the camera's. */
export function predictBox(state, time) {
  const dt = time - state.lastMatched.time;
  const ahead = time - state.thumbTime;
  const c = centre(state.lastMatched.box);
  const w = state.lastMatched.box.width;
  const h = state.lastMatched.box.height;
  const cx = c.x + state.velocity.x * dt + state.cam.x + state.camVelocity.x * ahead;
  const cy = c.y + state.velocity.y * dt + state.cam.y + state.camVelocity.y * ahead;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/**
 * How far from the prediction a candidate may be (in object sizes): wider
 * the longer it is unseen — for a second. Past that, a wider net mostly
 * catches someone else.
 */
const gateFor = (coastSeconds) => 1.2 + Math.min(1, coastSeconds) * 1.5;

/**
 * Where the detector should look at `time`: a zoomed square around the
 * prediction, wide enough for the gate — or null for the whole frame.
 * @param {{width:number, height:number}} frameSize the video's pixels
 */
export function lookRegion(state, time, frameSize) {
  if (!frameSize) return null;
  const coast = state.coastSince == null ? 0 : Math.abs(time - state.coastSince);
  return regionFor(predictBox(state, time), gateFor(coast) + 1, frameSize.width, frameSize.height);
}

/**
 * Scores every same-class candidate against the prediction.
 * @returns {{candidate:object, score:number, similarity:number}[]} best first, gated.
 */
export function scoreCandidates(state, predicted, candidates, coastSeconds = 0) {
  const pc = centre(predicted);
  const scale = Math.max(predicted.width, predicted.height, 0.02);
  // The gate widens while coasting: the longer unseen, the less sure where.
  const gate = gateFor(coastSeconds);
  const area = predicted.width * predicted.height;
  return candidates
    .filter((c) => c.class === state.cls)
    .map((c) => {
      const cc = centre(c.box);
      const d = Math.hypot(cc.x - pc.x, cc.y - pc.y) / scale;
      const ratio = (c.box.width * c.box.height) / (area || 1e-6);
      if (d > gate || ratio < 0.2 || ratio > 4) return null;
      // A box whose SHAPE differs from the object's is most likely a PARTIAL
      // view (half behind something) — evidence it is there, not a
      // measurement of where or how big (see stepTracker). A change of size
      // with the shape kept is just the object coming closer or going away.
      const aspectRatio = (c.box.width / c.box.height) / (state.aspect || 1);
      const consistent = aspectRatio >= 0.7 && aspectRatio <= 1.43;
      const similarity = c.appearance && state.template ? appearanceSimilarity(state.template, c.appearance) : 0.5;
      const score = (0.4 * similarity + 0.35 * iou(predicted, c.box) + 0.25 * (1 - Math.min(1, d / gate))) * (consistent ? 1 : 0.85);
      return { candidate: c, score, similarity, consistent };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

const MIN_SCORE = 0.35;
// Measured on real footage: the same person scores 0.94-1.0, a different
// person ~0.45 — so a match must clear 0.6, well above "someone else".
const MIN_SIMILARITY = 0.6;
const AMBIGUOUS_MARGIN = 0.06;
const APPEARANCE_DECIDES = 0.1;
// Finding it again, with no motion to go on, takes a much closer likeness —
// and a clear lead over anyone else.
export const REID_SIMILARITY = 0.8;
const REID_LEAD = 0.1;

/**
 * The likeness a match needs: the longer the object has gone unseen, the
 * less its predicted position is worth and the more its look must carry —
 * past its normal coast (hidden behind someone), as much as finding it
 * again from scratch. (Measured on real footage: a passer-by the track had
 * coasted behind for 1.8s scored 0.60 against it — enough at a glance, and
 * a swap.)
 */
function neededSimilarity(unseen, config) {
  if (unseen > config.maxCoastSeconds) return REID_SIMILARITY;
  if (unseen > 0.5) return 0.7;
  return MIN_SIMILARITY;
}

/** Whether another same-class object is right beside `box`. */
function hasNeighbour(state, box, candidates, except) {
  const c = centre(box);
  const reach = 1.5 * Math.max(box.width, box.height);
  return candidates.some((o) => o !== except && o.class === state.cls && Math.hypot(centre(o.box).x - c.x, centre(o.box).y - c.y) < reach);
}

/**
 * Takes in a new frame's picture: measures how the camera moved since the
 * last one (ignoring the objects in it, which move their own ways).
 * @returns {boolean} true if it is a different shot (a cut).
 */
function observeCamera(state, obs) {
  if (!obs.thumb) return false;
  let cut = false;
  if (state.thumb) {
    const shift = cameraShift(state.thumb, obs.thumb, state.seen);
    const dt = obs.time - state.thumbTime;
    if (shift.cut) cut = true;
    else {
      state.cam = { x: state.cam.x + shift.dx, y: state.cam.y + shift.dy };
      if (Math.abs(dt) > 1e-6) state.camVelocity = { x: shift.dx / dt, y: shift.dy / dt };
    }
  }
  state.thumb = obs.thumb;
  state.thumbTime = obs.time;
  state.seen = (obs.candidates || []).map((c) => c.box);
  return cut;
}

/**
 * One analysed frame. Mutates and returns `state`.
 * @param {{time:number, thumb?:object, candidates:{id:string, class:string, box:object, confidence:number, appearance?:Float32Array}[]}} obs
 * @returns {{sample:object|null, ended:{reason:string, time:number}|null}}
 */
export function stepTracker(state, obs, config = DEFAULT_TRACK_CONFIG) {
  // The camera is measured on the background: not on the object, nor on anything else detected.
  state.seen = [state.box, ...state.seen];
  if (observeCamera(state, obs)) return { sample: null, ended: { reason: 'cut', time: state.lastMatched.time } };
  const candidates = obs.candidates || [];
  const coastSeconds = state.coastSince == null ? 0 : Math.abs(obs.time - state.coastSince);
  const predicted = predictBox(state, obs.time);
  const scored = scoreCandidates(state, predicted, candidates, coastSeconds);
  const best = scored[0];
  const rival = scored[1];
  const clear = best && best.score >= MIN_SCORE && best.similarity >= neededSimilarity(coastSeconds, config)
    && (!rival || best.score - rival.score >= AMBIGUOUS_MARGIN || best.similarity - rival.similarity >= APPEARANCE_DECIDES);

  // Two objects of its class were side by side, and now there is ONE box —
  // wider than the object, no taller: the detector has merged them. It says
  // the object is there, not where exactly.
  const merged = clear && state.nearby && !hasNeighbour(state, best.candidate.box, candidates, best.candidate)
    && best.candidate.box.width > 1.15 * predicted.width && best.candidate.box.height < 1.08 * predicted.height;

  if (clear && (!best.consistent || merged)) {
    // A partial (or merged) sighting: the object is still there (so it is
    // not lost), but the box is not its own — the step holds the prediction,
    // uncertain, and learns nothing from it.
    state.coastSince = obs.time;
    state.time = obs.time;
    state.box = clipBox(predicted);
    return { sample: { time: obs.time, box: clipBox(predicted), confidence: clamp01(0.5 * best.score / 0.75), state: 'uncertain' }, ended: null };
  }

  if (clear) {
    const c = best.candidate;
    const dt = obs.time - state.lastMatched.time;
    if (Math.abs(dt) > 1e-6) {
      const a = centre(state.lastMatched.box);
      const b = centre(c.box);
      // Its OWN motion: what the camera did is taken out.
      const v = { x: (b.x - a.x - state.cam.x) / dt, y: (b.y - a.y - state.cam.y) / dt };
      // A blend, so one noisy box doesn't fling the prediction.
      state.velocity = { x: 0.6 * v.x + 0.4 * state.velocity.x, y: 0.6 * v.y + 0.4 * state.velocity.y };
    }
    state.aspect = 0.8 * state.aspect + 0.2 * (c.box.width / c.box.height);
    // The fingerprint learns only from clean matches: not when another
    // same-class box overlaps this one (its colours would bleed in).
    const crowded = candidates.some((o) => o !== c && o.class === state.cls && iou(o.box, c.box) > 0.2);
    if (best.similarity > 0.6 && !crowded) state.template = blendAppearance(state.template, c.appearance);
    state.lastMatched = { box: { ...c.box }, time: obs.time };
    state.cam = { x: 0, y: 0 };
    state.matches += 1;
    state.box = { ...c.box };
    state.time = obs.time;
    state.coastSince = null;
    state.nearby = hasNeighbour(state, c.box, candidates, c);
    return { sample: { time: obs.time, box: { ...c.box }, confidence: clamp01(0.5 * c.confidence + 0.5 * Math.min(1, best.score / 0.75)), state: 'tracked', detectionId: c.id }, ended: null };
  }

  // No clear match: coast on the prediction — or end.
  if (state.coastSince == null) state.coastSince = state.lastMatched.time;
  const unseen = Math.abs(obs.time - state.coastSince);
  // Leaving: the prediction is mostly out of the frame — or the object's
  // last box was already at an edge, heading out (a fast or growing object,
  // like a car passing the camera, outruns a size-steady prediction).
  const lb = state.lastMatched.box;
  // How it moves IN THE PICTURE: its own motion plus the camera's.
  const v = { x: state.velocity.x + state.camVelocity.x, y: state.velocity.y + state.camVelocity.y };
  // With no movement measured yet in this direction (it vanished on the very
  // next frame), an object at an edge can only have gone out through it.
  const unknown = !state.matches;
  const atEdgeGoingOut = (lb.x <= 0.02 && (v.x < 0 || unknown)) || (lb.x + lb.width >= 0.98 && (v.x > 0 || unknown))
    || (lb.y <= 0.02 && (v.y < 0 || unknown)) || (lb.y + lb.height >= 0.98 && (v.y > 0 || unknown));
  const leaving = visibleFraction(predicted) < 0.5 || atEdgeGoingOut;
  if (leaving) return { sample: null, ended: { reason: 'exited', time: state.lastMatched.time } };
  // Another object of its class where it should be: it is most likely behind
  // them, and will come out — worth holding on a little longer.
  const pc = centre(predicted);
  const hidden = candidates.some((o) => o.class === state.cls && (iou(o.box, predicted) > 0.2 || contains(o.box, pc)));
  const patience = hidden ? Math.max(config.maxHiddenSeconds ?? 0, config.maxCoastSeconds) : config.maxCoastSeconds;
  if (unseen > patience) return { sample: null, ended: { reason: 'lost', time: state.lastMatched.time } };
  state.time = obs.time;
  state.box = clipBox(predicted);
  state.nearby = state.nearby || hidden;
  return { sample: { time: obs.time, box: clipBox(predicted), confidence: clamp01(0.5 * (1 - unseen / patience)), state: 'uncertain' }, ended: null };
}

/**
 * After a loss: the one same-class candidate that looks like the object
 * (closely, and clearly more than anyone else), of its shape and a
 * plausible size — or null.
 */
export function reacquireCandidate(state, candidates) {
  if (!state.template) return null;
  const pool = candidates
    .filter((c) => c.class === state.cls && c.appearance)
    .map((c) => ({ candidate: c, similarity: appearanceSimilarity(state.template, c.appearance) }))
    .sort((a, b) => b.similarity - a.similarity);
  const best = pool[0];
  if (!best || best.similarity < REID_SIMILARITY) return null;
  if (pool[1] && best.similarity - pool[1].similarity < REID_LEAD) return null;
  const b = best.candidate.box;
  const shape = (b.width / b.height) / (state.aspect || 1);
  const size = b.height / (state.lastMatched.box.height || 1);
  if (shape < 0.7 || shape > 1.43 || size < 0.5 || size > 2) return null;
  return best;
}

// --- A whole track ----------------------------------------------------------------

/** A copy of a tracker state, to rewind a step to. */
function cloneState(state) {
  return {
    ...state,
    box: { ...state.box },
    velocity: { ...state.velocity },
    cam: { ...state.cam },
    camVelocity: { ...state.camVelocity },
    seen: [...state.seen],
    lastMatched: { box: { ...state.lastMatched.box }, time: state.lastMatched.time }
  };
}

/** Drops trailing uncertain samples — nothing is claimed past the last real sighting. */
function dropUncertainTail(run) {
  while (run.length && run[run.length - 1].state === 'uncertain') run.pop();
}

/**
 * The next step's length: longer while the object moves smoothly, alone,
 * and was matched cleanly three times running; back to `step` otherwise.
 */
function nextStep(state, run, current, config) {
  const recent = run.slice(-3);
  if (state.nearby || state.coastSince != null || recent.length < 3 || recent.some((s) => s.state !== 'tracked')) return config.step;
  const [, a, b] = recent;
  const per = Math.abs(b.time - a.time) / config.step;
  const jump = Math.hypot(centre(b.box).x - centre(a.box).x, centre(b.box).y - centre(a.box).y) / Math.max(b.box.width, b.box.height) / (per || 1);
  return jump < 0.25 ? Math.min(config.maxStep ?? config.step, current * 2) : config.step;
}

/** One direction, followed to its end — finding the object again after a loss where it can. */
async function follow(dir, ctx) {
  const { detection, config, frameSize } = ctx;
  const observe = (time, region) => ctx.observe(time, { region, direction: dir });
  let state = startTracker(detection, ctx.appearance, ctx.startThumb);
  const limit = dir > 0 ? Math.min(ctx.duration, detection.time + config.maxSeconds) : Math.max(0, detection.time - config.maxSeconds);
  const reachedVideoEdge = dir > 0 ? limit >= ctx.duration - 1e-6 : limit <= 1e-6;
  const pastLimit = (time) => (dir > 0 ? time > limit - 1e-6 : time < limit + 1e-6);
  let t = detection.time;
  let step = config.step;
  let ended = null;
  const run = [];
  const gaps = [];
  while (!ended) {
    if (ctx.isCancelled()) { ended = { reason: 'cancelled', time: state.lastMatched.time }; break; }
    let next = t + dir * step;
    // The video's own ends: a final step onto the last/first frame.
    if (pastLimit(next)) next = limit;
    if (Math.abs(next - t) < 1e-6) { ended = { reason: reachedVideoEdge ? (dir > 0 ? 'video-end' : 'video-start') : 'limit', time: state.lastMatched.time }; break; }
    const snapshot = cloneState(state);
    const obs = await observe(next, lookRegion(state, next, frameSize));
    ctx.tick();
    let r = stepTracker(state, obs, config);
    // Moved far since the last analysed frame: look at the frame in between
    // too, so a fast object isn't handed to a neighbour.
    if (r.sample?.state === 'tracked' && Math.abs(next - t) > config.minStep * 1.5) {
      const prev = run.length ? run[run.length - 1] : ctx.first;
      const jump = Math.hypot(centre(r.sample.box).x - centre(prev.box).x, centre(r.sample.box).y - centre(prev.box).y);
      if (jump > 0.5 * Math.max(prev.box.width, prev.box.height)) {
        // Re-run this step from where it started, with the middle frame first.
        const mid = t + (next - t) / 2;
        Object.assign(state, cloneState(snapshot));
        const midObs = await observe(mid, lookRegion(state, mid, frameSize));
        ctx.tick();
        const mr = stepTracker(state, midObs, config);
        if (mr.sample) run.push(mr.sample);
        r = mr.ended ? mr : stepTracker(state, obs, config);
      }
    }
    if (r.sample) run.push(r.sample);
    if (r.ended) {
      // Nothing is claimed past the last real sighting.
      dropUncertainTail(run);
      if (['lost', 'exited'].includes(r.ended.reason) && config.reacquireSeconds > 0) {
        const found = await reacquire(state, next, dir, limit, ctx);
        if (found) {
          const before = run.length ? run[run.length - 1].time : detection.time;
          const after = found.samples[0].time;
          gaps.push({ start: Math.min(before, after), end: Math.max(before, after), reason: r.ended.reason });
          run.push(...found.samples);
          state = found.state;
          t = found.time;
          step = config.step;
          continue;
        }
      }
      ended = r.ended;
      break;
    }
    t = next;
    step = nextStep(state, run, step, config);
  }
  if (['cancelled', 'cut'].includes(ended.reason)) dropUncertainTail(run);
  return { run, gaps, ended };
}

/**
 * Looks for the object again after it was lost or left, from `from` on, for
 * up to `reacquireSeconds` (the whole frame, every `maxStep`). A candidate
 * must pass reacquireCandidate and then be tracked on the very next step.
 * @returns {{state:object, time:number, samples:object[]}|null}
 */
async function reacquire(lostState, from, dir, limit, ctx) {
  const { config, frameSize } = ctx;
  const until = dir > 0 ? Math.min(limit, from + config.reacquireSeconds) : Math.max(limit, from - config.reacquireSeconds);
  const beyond = (time) => (dir > 0 ? time > until + 1e-6 : time < until - 1e-6);
  let prevThumb = lostState.thumb;
  let t = from;
  for (;;) {
    if (ctx.isCancelled()) return null;
    t += dir * (config.maxStep ?? config.step);
    if (beyond(t)) return null;
    const obs = await ctx.observe(t, { region: null, direction: dir });
    ctx.tick();
    // A different shot: whatever is there now is not where it went.
    if (prevThumb && obs.thumb && cameraShift(prevThumb, obs.thumb).cut) return null;
    prevThumb = obs.thumb || prevThumb;
    const m = reacquireCandidate(lostState, obs.candidates || []);
    if (!m) continue;
    // Seen once. It must be followed on the next frame too, or it was a likeness, not it.
    const fresh = startTracker({ ...m.candidate, time: t }, lostState.template, obs.thumb);
    fresh.aspect = lostState.aspect;
    fresh.seen = (obs.candidates || []).map((c) => c.box);
    const t2 = t + dir * config.step;
    if (dir > 0 ? t2 > limit + 1e-6 : t2 < limit - 1e-6) return null;
    const obs2 = await ctx.observe(t2, { region: lookRegion(fresh, t2, frameSize), direction: dir });
    ctx.tick();
    const r2 = stepTracker(fresh, obs2, config);
    if (r2.sample?.state !== 'tracked') { t = t2; prevThumb = obs2.thumb || prevThumb; continue; }
    const first = { time: t, box: { ...m.candidate.box }, confidence: clamp01(0.5 * m.candidate.confidence + 0.5 * m.similarity), state: 'tracked', detectionId: m.candidate.id };
    return { state: fresh, time: t2, samples: [first, r2.sample] };
  }
}

/**
 * Tracks one selected detection through the video, forward and backward —
 * the two directions side by side.
 * @param {object} opts
 * @param {object} opts.detection        the selected V1.7 detection (with .time)
 * @param {Float32Array} [opts.appearance] its fingerprint in its own frame
 * @param {object} [opts.startThumb]     its frame's thumbnail (frames.js) — fetched if not given
 * @param {{width:number, height:number}} [opts.frameSize]  the video's pixels — enables zoomed looks
 * @param {number} opts.duration          the video's length
 * @param {(time:number, look:{region:object|null, direction:number}) => Promise<{candidates:object[], thumb?:object}>} opts.observe
 *        a frame's same-time detections, with appearance (in `region` only, zoomed, when given)
 * @param {object} [opts.config]
 * @param {(done:number, estimate:number) => void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]
 */
export async function trackObject(opts) {
  const config = { ...DEFAULT_TRACK_CONFIG, ...(opts.config || {}) };
  const { detection, duration } = opts;
  const first = { time: detection.time, box: { ...detection.box }, confidence: clamp01(detection.confidence), state: 'tracked', detectionId: detection.id };
  const startThumb = opts.startThumb ?? (await opts.observe(detection.time, { region: null, direction: 0 })).thumb ?? null;
  const estimate = Math.ceil(Math.min(duration - detection.time, config.maxSeconds) / config.step) + Math.ceil(Math.min(detection.time, config.maxSeconds) / config.step);
  let done = 0;
  const ctx = {
    ...opts,
    config,
    first,
    startThumb,
    isCancelled: () => !!opts.isCancelled?.(),
    tick: () => { done++; opts.onProgress?.(done, Math.max(estimate, done)); }
  };
  const [fwd, bwd] = await Promise.all([follow(1, ctx), follow(-1, ctx)]);
  const samples = [...bwd.run.reverse(), first, ...fwd.run];
  return buildTrack({ ...opts, config, samples, gaps: [...bwd.gaps, ...fwd.gaps], ends: { forward: fwd.ended, backward: bwd.ended } });
}

/** Assembles the track record and judges it. */
export function buildTrack({ detection, config, samples, ends, gaps = [], source = null }) {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const tracked = sorted.filter((s) => s.state === 'tracked');
  const confidence = sorted.length ? sorted.reduce((a, s) => a + s.confidence, 0) / sorted.length : 0;
  const uncertainShare = sorted.length ? 1 - tracked.length / sorted.length : 1;
  let status = 'completed';
  if (tracked.length < 2) status = 'failed';
  else if (Object.values(ends).some((e) => e?.reason === 'lost')) status = 'lost';
  else if (Object.values(ends).some((e) => e?.reason === 'cancelled')) status = 'partial';
  else if (confidence < 0.5 || uncertainShare > 0.3) status = 'low-confidence';
  return {
    analysisType: TRACK_ANALYSIS_TYPE,
    analysisVersion: TRACK_ANALYSIS_VERSION,
    tracker: { ...TRACKER },
    config: { ...DEFAULT_TRACK_CONFIG, ...config },
    source,
    sourceObjectId: detection.id,
    class: detection.class,
    label: detection.label,
    startTime: sorted[0]?.time ?? detection.time,
    endTime: sorted[sorted.length - 1]?.time ?? detection.time,
    samples: sorted,
    gaps: [...gaps].sort((a, b) => a.start - b.start),
    ends,
    confidence: +confidence.toFixed(3),
    status
  };
}

// --- Reading a track --------------------------------------------------------------

const smoothCache = new WeakMap();
/** How far either side smoothing reaches (seconds), and its weight's fall-off. */
const SMOOTH_REACH = 0.45;

function acrossGap(gaps, t1, t2) {
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  return gaps.some((g) => lo <= g.start + 1e-9 && hi >= g.end - 1e-9);
}

/**
 * Zero-lag smoothing: each TRACKED sample's centre and size averaged with
 * its tracked neighbours within ±SMOOTH_REACH seconds (triangular weights),
 * centred so nothing trails behind — never across a gap. Uncertain samples
 * are left alone. Off-line, so it can look ahead — which is what lets it
 * steady jitter without lag.
 */
export function smoothSamples(samples, gaps = []) {
  const usable = (s, n) => n.state === 'tracked' && !acrossGap(gaps, s.time, n.time);
  return samples.map((s, i) => {
    if (s.state !== 'tracked') return s;
    // BALANCED: as far each way as BOTH ways reach. At the track's ends (and a
    // gap's edges) the window would otherwise be one-sided, and averaging only
    // the samples behind a moving object pulls its box back — measured: ~20px
    // behind a walking person at his last sighting.
    const extent = (k) => {
      let far = 0;
      for (let j = i + k; j >= 0 && j < samples.length; j += k) {
        const dt = Math.abs(samples[j].time - s.time);
        if (dt > SMOOTH_REACH) break;
        if (usable(s, samples[j])) far = dt;
      }
      return far;
    };
    const reach = Math.min(extent(-1), extent(1)) + 1e-9;
    let cx = 0; let cy = 0; let w = 0; let h = 0; let wsum = 0;
    for (const k of [-1, 1]) {
      for (let j = k < 0 ? i : i + 1; j >= 0 && j < samples.length; j += k) {
        const n = samples[j];
        const dt = Math.abs(n.time - s.time);
        if (dt > reach) break;
        if (!usable(s, n)) continue;
        const weight = 1 - dt / (SMOOTH_REACH + 0.05);
        const c = centre(n.box);
        cx += c.x * weight; cy += c.y * weight; w += n.box.width * weight; h += n.box.height * weight; wsum += weight;
      }
    }
    cx /= wsum; cy /= wsum; w /= wsum; h /= wsum;
    return { ...s, box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h } };
  });
}

/**
 * The object at `time`: linear between the two samples around it (never
 * overshooting), null outside the track and inside its gaps. Confidence is
 * the lower of the two; uncertain if either is.
 * @returns {{time:number, box:object, confidence:number, state:'tracked'|'uncertain'}|null}
 */
export function getTrackAtTime(track, time, { smoothed = true } = {}) {
  if (!track?.samples?.length || time < track.startTime - 1e-6 || time > track.endTime + 1e-6) return null;
  const gaps = track.gaps || [];
  if (gaps.some((g) => time > g.start + 1e-6 && time < g.end - 1e-6)) return null;
  let samples = track.samples;
  if (smoothed) {
    if (!smoothCache.has(track)) smoothCache.set(track, smoothSamples(track.samples, gaps));
    samples = smoothCache.get(track);
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].time <= time) lo = mid; else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (a === b || Math.abs(b.time - a.time) < 1e-9) return { time, box: { ...a.box }, confidence: a.confidence, state: a.state };
  const f = clamp01((time - a.time) / (b.time - a.time));
  const lerp = (p, q) => p + (q - p) * f;
  return {
    time,
    box: { x: lerp(a.box.x, b.box.x), y: lerp(a.box.y, b.box.y), width: lerp(a.box.width, b.box.width), height: lerp(a.box.height, b.box.height) },
    confidence: Math.min(a.confidence, b.confidence),
    state: a.state === 'uncertain' || b.state === 'uncertain' ? 'uncertain' : 'tracked'
  };
}

/** The track's followed stretches, split at its gaps: [[sample, ...], ...]. */
export function trackSegments(track) {
  if (!track?.samples?.length) return [];
  const out = [[]];
  const gaps = track.gaps || [];
  track.samples.forEach((s, i) => {
    const prev = track.samples[i - 1];
    if (prev && acrossGap(gaps, prev.time, s.time)) out.push([]);
    out[out.length - 1].push(s);
  });
  return out;
}

/** A stored track, normalized; null for anything else or one made by another version. */
export function normalizeTrack(raw) {
  if (!raw || raw.analysisType !== TRACK_ANALYSIS_TYPE || raw.analysisVersion !== TRACK_ANALYSIS_VERSION) return null;
  if (raw.tracker?.id !== TRACKER.id || raw.tracker?.version !== TRACKER.version) return null;
  const samples = (raw.samples || [])
    .filter((s) => Number.isFinite(s?.time) && s.box && ['tracked', 'uncertain'].includes(s.state))
    .map((s) => ({ time: s.time, box: { x: +s.box.x, y: +s.box.y, width: +s.box.width, height: +s.box.height }, confidence: clamp01(+s.confidence || 0), state: s.state, ...(s.detectionId ? { detectionId: s.detectionId } : {}) }))
    .sort((a, b) => a.time - b.time);
  if (!samples.length || !TRACK_STATUSES.includes(raw.status)) return null;
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : [])
    .filter((g) => Number.isFinite(g?.start) && Number.isFinite(g?.end) && g.end > g.start)
    .map((g) => ({ start: g.start, end: g.end, reason: g.reason === 'exited' ? 'exited' : 'lost' }))
    .sort((a, b) => a.start - b.start);
  return { ...raw, samples, gaps, startTime: samples[0].time, endTime: samples[samples.length - 1].time };
}

/** Whether a stored track is authoritative for this cache key. */
export function isTrackValidFor(track, key) {
  return !!track && !!key && trackCacheKey(track.source?.detectionCacheKey, track.sourceObjectId, track.config) === key;
}
