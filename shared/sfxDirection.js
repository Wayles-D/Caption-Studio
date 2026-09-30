/**
 * THE DIRECTOR — which proposed moments actually get a sound, and how loud
 * and how long it is.
 *
 * The analysis (backend/services/keywordAnalysisService.js) reports moments it
 * thinks are worth emphasising and how strongly it believes each one. It does
 * not decide how many end up in the edit, and it must not: a model asked to
 * "be selective" is being asked to hold a budget in its head across a whole
 * transcript, which it cannot check and nobody can test. The budget lives
 * here instead, as arithmetic over the returned list — deterministic, the same
 * answer every time, and assertable without a model call.
 *
 * That split is the whole point of this file:
 *
 *   AI     -> "this moment matters, and I'm 0.8 sure"
 *   here   -> "...and it is one of the four that fit in a 45-second edit"
 *   editor -> "...so play `pop` at 62%, capped to a beat" (audioTimeline.js)
 *
 * WHY A BUDGET AT ALL. A sound on every strong sentence is the failure mode
 * that makes an edit unwatchable — five sentences, five stings. Short-form
 * edits carry a handful of accents across a whole video, and the difference
 * between "intentional" and "noisy" is almost entirely COUNT, not choice of
 * sound. So the count is enforced rather than hoped for.
 *
 * STRUCTURAL MOMENTS ARE EXEMPT. List beats ("here are five things" -> one
 * per item) are the feature that already existed and are the one case where a
 * repeated, evenly-spaced sound is the point rather than a mistake. They are
 * placed unconditionally, exactly as before, and they are seeded into the
 * spacing check FIRST so an expressive moment can never land on top of one.
 *
 * Pure functions, no DOM and no state, so the browser and the test suite run
 * identical code — same reason shared/audioTimeline.js is shaped this way.
 */

/**
 * The moments that are STRUCTURE rather than expression: the speech announcing
 * and walking through a list.
 *
 * These bypass the budget. They were the original feature, their repetition is
 * intentional, and a creator who says "here are five things" expects five
 * beats, not the two the director would otherwise judge to be the strongest.
 */
import { momentWords } from './soundProfiles.js';

export const STRUCTURAL_MOMENT_TYPES = ['list_start', 'list_item'];

export function isStructuralMomentType(type) {
  return STRUCTURAL_MOMENT_TYPES.includes(type);
}

/**
 * How the budget is set. Every number here is a judgement about short-form
 * pacing, so each says what it is protecting against.
 */
export const DIRECTION_DEFAULTS = {
  // Below this, a moment is not placed at all. The model is asked for a
  // calibrated 0-1 and is far more willing to call something "worth marking"
  // than a human editor is, so this sits above the middle on purpose.
  minIntensity: 0.55,

  // The pacing ceiling. Five a minute is already busier than most good edits;
  // it is a ceiling, not a target, and the threshold above is what usually
  // binds first.
  momentsPerMinute: 5,

  // Floors and caps, because per-minute alone behaves badly at the extremes:
  // a 10-second clip would be allowed nothing, and a 10-minute one fifty.
  minMoments: 2,
  maxMoments: 12,

  // No two accents closer than this. Two sounds inside a second read as one
  // mistake rather than two decisions, whatever their intensity.
  minGapSeconds: 1.5
};

/** An accent is a beat, not a bed — see resolveDirectedPlacement. */
export const MICRO_MAX_DURATION = 1.2;
const MICRO_FADE_OUT = 0.14;

/**
 * Sensitivity (0-1, the editor's one exposed knob) -> intensity threshold.
 *
 * Inverted and deliberately narrow: even at maximum the threshold stays well
 * clear of zero, because "more" must not become "everything". At 0 it is
 * strict enough that only a standout moment survives.
 */
export function thresholdForSensitivity(sensitivity) {
  const s = Number.isFinite(sensitivity) ? Math.min(1, Math.max(0, sensitivity)) : 0.5;
  return 0.75 - 0.3 * s; // 0.75 (strict) .. 0.45 (generous)
}

/** Whether the analysis actually rated this moment, as opposed to not saying. */
function isRated(event) {
  return Number.isFinite(Number(event?.intensity));
}

function intensityOf(event) {
  const n = Number(event?.intensity);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/**
 * Splits the analysis into what gets placed and what does not.
 *
 * Returns `{ structural, directed, rejected }` — `rejected` carries a `reason`
 * per moment ('below-threshold' | 'over-budget' | 'too-close') so the UI and
 * the tests can say WHY a moment was passed over, rather than it simply not
 * appearing.
 *
 * `duration` is the video's length; when it is unknown the budget falls back
 * to the span the moments themselves cover, so an unmeasured video gets a
 * sane cap instead of an unlimited one.
 */
export function selectDirectedMoments(events, { duration, sensitivity, policy = {} } = {}) {
  const cfg = { ...DIRECTION_DEFAULTS, ...policy };
  const threshold = Number.isFinite(sensitivity)
    ? thresholdForSensitivity(sensitivity)
    : cfg.minIntensity;

  const all = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(e.timestamp));
  const structural = all
    .filter((e) => isStructuralMomentType(e.type))
    .sort((a, b) => a.timestamp - b.timestamp);
  const expressive = all.filter((e) => !isStructuralMomentType(e.type));

  const span = Number.isFinite(duration) && duration > 0
    ? duration
    : Math.max(0, ...all.map((e) => e.timestamp)) || 0;
  // Rounded UP, which matters more than it looks: short-form video is 15-60s,
  // and rounding to nearest gives a 30-second edit two accents — enough for a
  // hook and one more, so a punchline and a payoff the analysis correctly
  // found are both thrown away. Ceiling puts 30s at three and leaves 60s at
  // five, widening the short end without making a long video busier.
  const budget = Math.max(
    cfg.minMoments,
    Math.min(cfg.maxMoments, Math.ceil((span / 60) * cfg.momentsPerMinute))
  );

  const rejected = [];
  // Strongest first, and earlier wins a tie — so a run of equally-rated
  // moments keeps the one that sets up the video rather than an arbitrary one.
  const candidates = expressive.slice().sort((a, b) => {
    const d = intensityOf(b) - intensityOf(a);
    return d !== 0 ? d : a.timestamp - b.timestamp;
  });

  // Structural moments are already on the timeline as far as spacing is
  // concerned: this is what stops an accent landing on a list beat.
  //
  // Spacing is measured between RUNS, edge to edge — never between the words
  // inside one. "five / home / office / hacks" puts four sounds inside ~0.7s
  // on purpose; judged word by word against a 1.5s gap, three of them would be
  // thrown away as too close to the first, and the rhythm this system exists
  // to produce would be deleted by the rule meant to protect the edit.
  const taken = structural.map(spanOf);
  const directed = [];

  for (const event of candidates) {
    // An UNRATED moment is never thresholded out. The threshold judges a
    // confidence the model stated; an analysis stored before intensity existed
    // did not decline to rate its moments, it was never asked — so scoring it
    // as middling and then dropping it would silently empty the timeline of
    // somebody's existing suggestions. It still competes for the budget and
    // still has to keep its distance, which is where the sparseness comes from
    // either way.
    if (isRated(event) && intensityOf(event) < threshold) {
      rejected.push({ event, reason: 'below-threshold' });
      continue;
    }
    if (directed.length >= budget) {
      rejected.push({ event, reason: 'over-budget' });
      continue;
    }
    // A run that brushes against something already placed loses ONLY the
    // words that collide, not the run. This was all-or-nothing, and on the
    // real test video it deleted the single most important moment: the model
    // correctly marked "5 home office hacks" and then ran on into
    // "productive … great", and because "great" landed 0.74s before the first
    // list beat, the whole intro was rejected over one word at its tail.
    // A one-word accent still behaves exactly as before — its only word either
    // survives or it is rejected.
    const words = momentWords(event);
    const clear = words.filter((w) => taken.every((t) => distanceTo(t, w.timestamp) >= cfg.minGapSeconds));
    if (!clear.length) {
      rejected.push({ event, reason: 'too-close' });
      continue;
    }
    const placed = clear.length === words.length
      ? event
      : {
        ...event,
        words: clear,
        timestamp: clear[0].timestamp,
        endTimestamp: clear.length > 1 ? clear[clear.length - 1].timestamp : undefined,
        // Kept so the UI and the tests can say which words were given up and
        // why, instead of a run silently arriving shorter than it was proposed.
        trimmedWords: words.filter((w) => !clear.includes(w))
      };
    taken.push(spanOf(placed));
    directed.push(placed);
  }

  directed.sort((a, b) => a.timestamp - b.timestamp);
  return { structural, directed, rejected, budget, threshold };
}

/** A run's extent in time: its first word's start to its last word's start. */
function spanOf(event) {
  const times = momentWords(event).map((w) => w.timestamp).filter(Number.isFinite);
  if (!times.length) return { start: event.timestamp, end: event.timestamp };
  return { start: Math.min(...times), end: Math.max(...times) };
}

/** Seconds from a single word's time to a placed run; 0 when it falls inside it. */
function distanceTo(span, t) {
  if (t >= span.start && t <= span.end) return 0;
  return Math.min(Math.abs(t - span.start), Math.abs(t - span.end));
}

/**
 * How long each sound in a run may last, so the sounds of a rhythmic run
 * follow each other instead of piling up.
 *
 * A click is shorter than the gap between spoken words, so for the usual case
 * this changes nothing audible. It exists for the other case: the analysis may
 * choose a longer sound for a run, and four copies of a two-second sting
 * starting a quarter-second apart are not four accents, they are one noise.
 * Each sound is cut where the next word's sound begins; the last keeps the
 * normal accent length.
 *
 * Returns null for a one-word moment — its length is left as whatever the
 * caller would otherwise give it, which is what keeps single list beats
 * sounding exactly as they did before runs existed.
 */
export function resolveRunDurations(words) {
  const times = (Array.isArray(words) ? words : []).map((w) => w.timestamp);
  if (times.length < 2) return null;
  return times.map((t, i) => {
    const duration = i < times.length - 1
      ? Math.max(MIN_RUN_SOUND_SECONDS, Math.min(MICRO_MAX_DURATION, times[i + 1] - t))
      : MICRO_MAX_DURATION;
    return { duration, fadeOut: Math.min(MICRO_FADE_OUT, duration / 3) };
  });
}

// A floor, because transcripts sometimes give two words the same start (or
// even a later word an EARLIER one — the test video has one), and a zero-
// length sound is silence the creator would never be able to explain.
const MIN_RUN_SOUND_SECONDS = 0.08;

/**
 * The sound's level and length for one directed moment.
 *
 * `base` is the sound's own registry default, which already encodes that a
 * whoosh sits lower than a tick; intensity scales around it rather than
 * replacing it, so a quiet asset stays relatively quiet at full intensity.
 *
 * The duration cap is what keeps a micro-SFX micro. The library holds beds and
 * stings several seconds long (tension, netflix-intro) and the analysis is
 * allowed to name one; dropped on an emphasis beat at full length it stops
 * being an accent and starts being a scene. Capping here rather than excluding
 * those sounds means the creator can still stretch one back out by hand — the
 * cap is a starting point, not a rule the timeline enforces.
 *
 * Trimming a sound mid-waveform clicks, so the cap comes with a short fade.
 */
export function resolveDirectedPlacement(baseVolume, intensity, { maxVolume = 2 } = {}) {
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5;
  const base = Number.isFinite(baseVolume) ? baseVolume : 0.6;
  return {
    volume: Math.min(maxVolume, Math.max(0, base * (0.65 + 0.45 * i))),
    duration: MICRO_MAX_DURATION,
    fadeOut: MICRO_FADE_OUT
  };
}
