/**
 * Export-side counterpart to src/js/components/videoTransform.js's live CSS
 * transform — makes the VIDEO's own keyframed position/scale/rotation/
 * opacity actually show up in the exported file, not just the preview.
 *
 * The exported expression is built by literally SAMPLING
 * shared/videoTransform.js's resolveVideoTransformAtTime (the exact same
 * function the live preview calls every render tick) at a fixed step across
 * the KEYFRAMED time range, then encoding those samples as a piecewise-
 * linear ffmpeg filter expression (`if(between(t,t0,t1), lerp, ...)` chains)
 * — so the export doesn't re-implement the interpolation math independently,
 * it re-samples the canonical evaluator and lets ffmpeg linearly connect the
 * dots, exactly the same technique backend/utils/graphicsFrameGenerator.js
 * already uses (dense sub-frame sampling) to keep caption entrance
 * animations frame-accurate in export.
 *
 * PERFORMANCE — this is the second pass at this file. The first pass ran
 * the full scale->pad->rotate->geq->overlay chain across the ENTIRE video,
 * for the ENTIRE export duration, regardless of how brief the actual
 * keyframed motion was. Confirmed against a real 1920x1080, 35-second video:
 * a caption-only export (no video transform) took ~38s; the SAME video with
 * one short video-transform keyframe pair took dramatically longer — per-
 * pixel `geq` alpha evaluation and a padded canvas roughly 2x the pixel
 * count (needed only for ROTATION headroom) were both running on every
 * single frame of the whole clip, whether or not that frame was anywhere
 * near the actual animated window. Three fixes, all cheap-by-default:
 *
 *  1. Time-scope: only the [firstKeyframe, lastKeyframe] window goes through
 *     the transform chain at all. Before/after that window, the source
 *     video is trimmed straight through with no per-pixel filtering, then
 *     concatenated back together — a long, mostly-static video with one
 *     brief effect now pays for that effect's own duration, not the whole
 *     video's.
 *  2. Skip `pad`+`rotate` entirely when rotation is never actually animated
 *     away from 0 — no need for rotation headroom (a larger-than-source
 *     canvas) or the rotate filter itself for a plain move/zoom.
 *  3. Skip the opacity stage entirely when opacity is never animated away
 *     from 100 — the common case (most edits are position/scale/rotation,
 *     not a fade).
 *
 * A third pass then removed the single worst cost that remained: opacity was
 * applied with `geq`, a PER-PIXEL filter, to compute a value that is uniform
 * across each frame. See the `sendcmd`/colorchannelmixer stage below for the
 * measurements — that one stage was ~87% of filter cost and pushed a real 35s
 * export to 31.3 minutes, past the client's own abort timeout.
 */
import { resolveVideoTransformAtTime, isIdentityVideoTransform } from '../../shared/videoTransform.js';

// Per real keyframe-to-keyframe segment, not per second of export duration —
// a fixed step across the WHOLE animated window produced a filter expression
// that grew with the window's own length regardless of how sparse the
// actual keyframes were, and blew past two separate real ffmpeg limits in
// testing: the OS process argument length (spawn ENAMETOOLONG on ~33k
// chars) and, even after moving the filter graph to a script file, ffmpeg's
// OWN expression parser choking on ~180 nested if(between(...)) clauses
// ("Missing ')' or too many args") for an 18-second animated range.
const MAX_SAMPLES_PER_SEGMENT = 15;
const MIN_SAMPLE_STEP_SECONDS = 0.05;
// Hard ceiling regardless of how many keyframes exist — protects against
// the same class of parser failure if a user creates an unusually large
// number of video keyframes; thins the extra samples out evenly rather than
// failing outright (a slightly coarser interpolation is still correct, just
// less smooth, which is preferable to silently losing the whole export).
const MAX_TOTAL_SAMPLES = 120;

// Video opacity is a per-FRAME scalar — the same number for every pixel in a
// frame — so it is driven by timed `sendcmd` commands into a native
// colorchannelmixer gain rather than evaluated per pixel. These control how
// finely that ramp is quantized in time. 0.04s (25 steps/sec) is finer than
// any source frame rate this app targets, so the ramp is frame-accurate in
// practice; the cap keeps the emitted command list bounded on long fades
// (a 35s full-clip fade emits ~875 commands, ~40KB, which the filter SCRIPT
// file carries fine — see graphicsCompositor.js on why the graph is never
// passed as a command-line argument).
const OPACITY_COMMAND_STEP_SECONDS = 0.04;
const MAX_OPACITY_COMMANDS = 2000;

function getSortedKeyframeTimes(videoTransform) {
  return Array.from(new Set((videoTransform?.keyframes || []).map((k) => k.t))).sort((a, b) => a - b);
}

function buildSampleTimes(rawTimes, windowStart, windowEnd) {
  const times = new Set([windowStart, windowEnd]);
  rawTimes.forEach((t) => { if (t >= windowStart && t <= windowEnd) times.add(t); });

  for (let i = 0; i < rawTimes.length - 1; i++) {
    const a = Math.max(rawTimes[i], windowStart);
    const b = Math.min(rawTimes[i + 1], windowEnd);
    const span = b - a;
    if (span <= 0) continue;
    const step = Math.max(MIN_SAMPLE_STEP_SECONDS, span / MAX_SAMPLES_PER_SEGMENT);
    for (let t = a; t < b; t += step) times.add(t);
  }

  let sorted = Array.from(times).sort((a, b) => a - b);
  if (sorted.length > MAX_TOTAL_SAMPLES) {
    // Keep every real keyframe timestamp (never thin those away — they're
    // the points that must land exactly on the curve) and evenly thin the
    // interpolation-only samples in between down to the budget.
    const mustKeep = new Set([windowStart, windowEnd, ...rawTimes.filter((t) => t >= windowStart && t <= windowEnd)]);
    const thinnable = sorted.filter((t) => !mustKeep.has(t));
    const budget = Math.max(0, MAX_TOTAL_SAMPLES - mustKeep.size);
    const keepEvery = Math.max(1, Math.ceil(thinnable.length / Math.max(1, budget)));
    const thinned = thinnable.filter((_, idx) => idx % keepEvery === 0);
    sorted = Array.from(new Set([...mustKeep, ...thinned])).sort((a, b) => a - b);
  }
  return sorted;
}

/**
 * Builds a piecewise-linear ffmpeg filter expression from ascending
 * `{t, value}` samples — hold-before-first / hold-after-last, linear
 * between, matching shared/keyframes.js's own evaluateTrack semantics (the
 * samples themselves already carry whatever easing the real evaluator
 * applied). `timeVar` is the filter-specific name for "current time in
 * seconds"; every filter this now feeds (scale/pad/rotate/overlay) uses
 * lowercase `t`. It stays a parameter because that has NOT been uniform
 * historically — geq, which this used to drive for opacity, used uppercase
 * `T` instead, so the name is kept explicit per call site rather than
 * assumed, since ffmpeg's own docs are inconsistent about it per-filter.
 */
function buildPiecewiseExpr(samples, timeVar = 't') {
  if (samples.length === 1) return formatNum(samples[0].value);

  // FLAT SUM OF GATED TERMS, not a nested if/else chain.
  //
  // This used to build `if(between(t,a,b),lerp,if(between(...),...))`, one
  // nesting level per sample. ffmpeg's expression parser (libavutil/eval.c)
  // allows a nesting depth of 100 — and MAX_TOTAL_SAMPLES is 120, so a
  // transform with enough keyframes produced an expression ffmpeg simply
  // could not parse:
  //
  //   [Parsed_scale_12] Cannot parse expression for width: 'iw*(if(...'
  //   [AVFilterGraph] Error initializing filters
  //   Failed to set value '<script>' for option 'filter_complex_script'
  //
  // ffmpeg exits non-zero, graphicsExport.js's catch swallows it, and the
  // whole job silently degrades to the ASS renderer — losing caption
  // keyframes, text blend mode and text overlays at once. Reproduced
  // directly: an expression 82 levels deep parses, 110 levels does not.
  //
  // Crucially this depended on the TOTAL number of samples across every
  // property, which is why it looked arbitrary from the outside: adding a
  // few more keyframes anywhere could tip a working project over the edge,
  // and adding a rotation could change the sample thinning enough to bring
  // it back under. Nothing about which properties were used mattered.
  //
  // A sum of mutually-exclusive gated terms is depth-CONSTANT (about 4)
  // however many samples there are, so the limit can no longer be reached.
  // The gates are half-open — `gte(t,a)*lt(t,b)` — so exactly one term is
  // ever non-zero and the boundaries can't double-count the way `between`
  // (inclusive at both ends) would. Length still grows linearly with sample
  // count, which is fine: the 82-deep expression above was already ~70KB
  // and parsed without complaint.
  const first = samples[0];
  const last = samples[samples.length - 1];
  const terms = [
    // Before the first sample: hold its value.
    `lt(${timeVar},${formatNum(first.t)})*${formatNum(first.value)}`
  ];

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const span = b.t - a.t;
    // A zero-span segment covers no time at all, so it contributes nothing
    // and is skipped — which also keeps the division below safe. The next
    // segment's own `gte` gate still covers that instant.
    if (span <= 0.0001) continue;
    const lerp = `(${formatNum(a.value)}+(${formatNum(b.value)}-${formatNum(a.value)})*(${timeVar}-${formatNum(a.t)})/${formatNum(span)})`;
    terms.push(`gte(${timeVar},${formatNum(a.t)})*lt(${timeVar},${formatNum(b.t)})*${lerp}`);
  }

  // At and after the last sample: hold its value.
  terms.push(`gte(${timeVar},${formatNum(last.t)})*${formatNum(last.value)}`);

  return `(${terms.join('+')})`;
}

/**
 * Builds the `sendcmd` command list that ramps the video layer's alpha gain
 * over the active segment.
 *
 * Emitted times are SEGMENT-LOCAL (the active segment's own timeline is
 * zero-based — see activeStages), while the opacity VALUES are sampled from
 * the canonical resolver at ABSOLUTE timeline time. That is the same
 * absolute-vs-segment pairing the `shifted()` helper handles for the
 * expression-driven filters, and it is equally load-bearing here: getting it
 * wrong shifts the whole fade by `trimStart`.
 *
 * Because each command carries a value sampled directly from
 * resolveVideoTransformAtTime, this is strictly MORE faithful to the preview
 * than the old piecewise-linear expression was — it follows the real eased
 * curve at 25 steps/sec instead of linearly interpolating between 15 samples.
 *
 * `;` is escaped as `\;` so the list survives the filtergraph parser, which
 * would otherwise read it as a chain separator. Only `;` needs escaping —
 * one target per command means no commas appear.
 */
function buildOpacityCommandList(videoTransform, trimStart, trimEnd) {
  const span = Math.max(0, trimEnd - trimStart);
  const step = Math.max(OPACITY_COMMAND_STEP_SECONDS, span / MAX_OPACITY_COMMANDS);
  const gainAt = (absT) => {
    const pct = resolveVideoTransformAtTime(videoTransform, absT).opacity;
    return Math.min(1, Math.max(0, (pct == null ? 100 : pct) / 100));
  };
  const commands = [];
  for (let t = trimStart; t < trimEnd - EPS; t += step) {
    commands.push(`${(t - trimStart).toFixed(3)} colorchannelmixer aa ${gainAt(t).toFixed(6)}`);
  }
  // Pin the exact end value so a fade always lands precisely on its last
  // keyframe rather than on whatever the final step happened to sample.
  commands.push(`${span.toFixed(3)} colorchannelmixer aa ${gainAt(trimEnd).toFixed(6)}`);
  return commands.join('\\;');
}

function formatNum(n) {
  // Fixed precision keeps the generated expression stable/readable and
  // avoids scientific notation (which ffmpeg's expression parser rejects).
  return Number(n).toFixed(6);
}

const EPS = 0.001;

// A boundary sample is "identity" only if EVERY property is at its default —
// only then is a plain, unfiltered passthrough of the raw source visually
// identical to "holding" that boundary's value. Bug found via real frame-by-
// frame inspection of an exported file: the pre/post passthrough segments
// were being used unconditionally, so whenever the FIRST keyframe wasn't at
// t=0 with identity values (nothing keyed yet -> should hold the first
// keyframe's actual pose) or the LAST keyframe had non-identity values
// (animation ends zoomed/rotated/shifted -> should hold THAT pose, per
// shared/keyframes.js's own documented hold-after-last-value semantics), the
// passthrough segment showed the untouched original video instead — a hard,
// visible snap back to normal framing at the exact moment the transform
// should have stayed put. Confirmed on a real export: frame just before the
// window end showed the correct zoomed/rotated pose; the very next frame (in
// the old unconditional-passthrough "post" segment) snapped instantly back to
// unrotated/unscaled/centered.
function isIdentitySample(s) {
  return Math.abs(s.scale - 1) <= EPS
    && Math.abs(s.rotation) <= EPS
    && Math.abs(s.offsetXPct) <= EPS
    && Math.abs(s.offsetYPct) <= EPS
    && Math.abs(s.opacity - 100) <= EPS;
}

/**
 * @param {object} videoTransform - appState.videoTransform (raw, may be undefined).
 * @param {number} duration - Export duration in seconds.
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{filterComplex: string, outputLabel: string}|null} null when the transform is the plain identity (no filter needed — `[0:v]` should be used as-is).
 */
export function buildVideoTransformFilterChain(videoTransform, duration, canvasWidth, canvasHeight) {
  if (isIdentityVideoTransform(videoTransform)) return null;
  if (!(duration > 0)) return null;

  const rawTimes = getSortedKeyframeTimes(videoTransform);
  // The animated window — before it and after it, the resolved transform is
  // constant (evaluateTrack's own hold-before-first/after-last semantics),
  // so only THIS window needs per-pixel filtering. A static-only override
  // (no keyframes at all, just a fixed non-identity scale/position/etc.)
  // has no such window — the same constant transform applies for the whole
  // clip, so there's nothing to time-scope.
  const windowStart = rawTimes.length ? Math.max(0, rawTimes[0]) : 0;
  const windowEnd = rawTimes.length ? Math.min(duration, rawTimes[rawTimes.length - 1]) : duration;

  const times = buildSampleTimes(rawTimes, windowStart, windowEnd);
  const samples = times.map((t) => ({ t, ...resolveVideoTransformAtTime(videoTransform, t) }));

  // The passthrough optimization (trim the raw source, no per-pixel filter)
  // is only valid where the held boundary value actually IS the identity
  // transform — otherwise "passthrough" and "hold the boundary value" are
  // two different videos. When a boundary isn't identity, fold that whole
  // side into the active/transformed segment instead (buildPiecewiseExpr's
  // existing hold-before-first/after-last branches already produce the
  // correct constant value out there — it's a cheap constant per-pixel op,
  // not a growing expression, so this costs nothing extra to compute, only
  // to render, and only when actually needed).
  const preIsIdentity = !rawTimes.length || isIdentitySample(samples[0]);
  const postIsIdentity = !rawTimes.length || isIdentitySample(samples[samples.length - 1]);
  const trimStart = preIsIdentity ? windowStart : 0;
  const trimEnd = postIsIdentity ? windowEnd : duration;

  const everRotates = samples.some((s) => Math.abs(s.rotation) > EPS);
  const everFades = samples.some((s) => Math.abs(s.opacity - 100) > EPS);
  // `eval=frame` makes scale/pad re-parse their size expressions and rebuild
  // the swscale context on EVERY frame. That is only needed when the frame size
  // actually changes over time — i.e. when scale is ANIMATED. A static
  // non-identity scale, or a rotation-only animation (where scale stays 1),
  // resolves to the same size on every frame, so the size can be computed once.
  //
  // The two halves of this are load-bearing together: dropping `eval=frame`
  // ALONE is not enough, because the emitted size is still a `t`-dependent
  // expression and `t` does not exist at filter-init time — ffmpeg rejects the
  // whole graph with "Error initializing filters". So when scale is constant
  // the expression is replaced by a plain literal as well, which is also what
  // makes the two provably equivalent: a constant cannot evaluate differently
  // on a later frame. Measured on a 1080x1920 clip, the scale stage cost 4.04s
  // with eval=frame vs 2.80s without.
  const scaleAnimates = samples.some((s) => Math.abs(s.scale - samples[0].scale) > EPS);
  const sizeEval = scaleAnimates ? ':eval=frame' : '';

  // The active segment's own timeline is ZERO-BASED (its trim resets PTS —
  // see activeStages below), but every sample above is keyed to ABSOLUTE
  // timeline time. So each filter reads `t + trimStart` rather than bare `t`.
  //
  // This pairing is load-bearing and must stay in sync. The active segment
  // used to skip the PTS reset precisely so these expressions could read
  // absolute `t` directly, on the assumption that ffmpeg's `concat` filter
  // re-stamps whatever it's handed and therefore doesn't care that the
  // segment's PTS weren't zero-based. That assumption is WRONG: `concat`
  // offsets each segment by the ACCUMULATED DURATION of the ones before it
  // and does not subtract the segment's own start PTS, so a segment starting
  // at 0.5s landed 0.5s late in the output. Measured on a 5s clip with
  // rotation keyframed 0deg->40deg from t=0.5: the exported file ran 5.52s
  // (0.5s long) and every sampled frame showed the angle the preview had
  // ~0.5s earlier (17.5deg vs 6.37deg at t=1.25, 30deg vs 21.62deg at t=2.0).
  // The same mismatch also left the first trimStart seconds of the segment
  // showing bare `[vt_bg]` background, because that generator starts at 0
  // while the video frames started at trimStart.
  //
  // Only applied when there IS a pre segment (trimStart > 0); otherwise `t`
  // is already absolute and the emitted expression stays byte-identical to
  // before, so the no-keyframe/static-transform path is provably unchanged.
  const shifted = (v) => (trimStart > EPS ? `(${v}+${formatNum(trimStart)})` : v);
  const tVar = shifted('t');

  // A constant literal when scale never animates — see `sizeEval` above for why
  // the literal and the missing `eval=frame` have to go together.
  const scaleExpr = scaleAnimates
    ? buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.scale })), tVar)
    : formatNum(samples[0].scale);
  const rotationExpr = everRotates ? buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.rotation })), tVar) : null;
  const xExpr = buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.offsetXPct })), tVar);
  const yExpr = buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.offsetYPct })), tVar);

  // Canvas the (possibly rotated) scaled frame is composited within — only
  // needs rotation headroom (a canvas bigger than the source) when rotation
  // is actually used; otherwise the plain source size is enough since a
  // pure scale+position never needs extra room (the overlay stage below
  // already places/crops it against the real output frame). Sized to the
  // ACTUAL rotation angles this animation uses (the standard rotated-
  // rectangle bounding-box formula: w*|cos|+h*|sin| by w*|sin|+h*|cos|), not
  // a fixed worst-case full-diagonal square for ANY possible angle — `rotate`
  // is real per-pixel bilinear resampling, so its cost scales directly with
  // this canvas's pixel count; a modest 10-20° nudge shouldn't pay for
  // headroom sized for a 45°/90° spin it never does. Confirmed empirically:
  // this is the dominant remaining cost once geq/full-duration processing
  // were already fixed above.
  const maxScale = Math.max(1, ...samples.map((s) => s.scale));
  let padW = null;
  let padH = null;
  if (everRotates) {
    // The bounding box as a function of angle isn't monotonic in general (it
    // can peak at an intermediate angle depending on aspect ratio), so this
    // takes the union of the bounding box AT EVERY SAMPLED angle — not just
    // the single largest-magnitude one — rather than assume the extreme
    // angle alone is always the worst case.
    const scaledW = canvasWidth * maxScale;
    const scaledH = canvasHeight * maxScale;
    let neededW = 0;
    let neededH = 0;
    samples.forEach((s) => {
      const rad = s.rotation * (Math.PI / 180);
      const w = scaledW * Math.abs(Math.cos(rad)) + scaledH * Math.abs(Math.sin(rad));
      const h = scaledW * Math.abs(Math.sin(rad)) + scaledH * Math.abs(Math.cos(rad));
      neededW = Math.max(neededW, w);
      neededH = Math.max(neededH, h);
    });
    padW = Math.ceil(neededW);
    padH = Math.ceil(neededH);
  }

  // The animated window, trimmed from the source and reset to a ZERO-BASED
  // timeline (`setpts=PTS-STARTPTS`) exactly like the pre/post segments
  // below. Two things depend on this being zero-based:
  //   1. `concat` (see segmentLabels below) offsets each segment by the
  //      accumulated duration of the previous ones WITHOUT subtracting that
  //      segment's own start PTS — a segment still carrying absolute PTS
  //      therefore lands `trimStart` seconds late, stretching the output by
  //      the same amount.
  //   2. `[vt_bg]` (the overlay's background, generated below) always starts
  //      at 0, so a non-zero-based video layer simply isn't there for the
  //      overlay to composite during its first `trimStart` seconds.
  // The piecewise expressions compensate by reading `t + trimStart` instead
  // of bare `t` — see the `shifted()` helper above, which is the other half
  // of this pairing.
  // `split` so the overlay's BACKGROUND is derived from the very same trimmed
  // frames as the transformed layer, rather than from a synthetic `color`
  // generator. This is not cosmetic: the background is the overlay's MAIN
  // input, so IT dictates the output frame rate, and `color` has no `rate`
  // option set here — it defaults to 25fps. That silently resampled every
  // transformed export to 25fps (confirmed on a real 29.58fps source: a
  // caption-only export stayed 29.58fps, the same clip WITH a video transform
  // came out 25fps). Deriving the background from the source instead means it
  // inherits the source's exact frame rate, PTS and frame count, so no
  // resampling happens at all and there is no generator/video timing mismatch
  // to drift. It also removes the need to guess the generator's `duration`.
  const activeStages = [`[0:v]trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},setpts=PTS-STARTPTS,split=2[vt_active_src][vt_bg_src]`];
  // drawbox with t=fill paints the whole frame black in place — the cheap way
  // to get "a black frame carrying this exact source frame's timing". The
  // explicit scale keeps the documented guarantee that the composite canvas is
  // exactly canvasWidth x canvasHeight even if that ever differs from the
  // source's own dimensions (a same-size scale is a verified no-op).
  activeStages.push(`[vt_bg_src]drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,scale=${canvasWidth}:${canvasHeight},format=yuv420p,setsar=1[vt_bg]`);
  activeStages.push(`[vt_active_src]format=rgba[vt_fmt]`);
  activeStages.push(`[vt_fmt]scale=w='iw*(${scaleExpr})':h='ih*(${scaleExpr})'${sizeEval}[vt_scaled]`);

  let afterGeometry = 'vt_scaled';
  if (everRotates) {
    // `max(...,iw)` / `max(...,ih)` is a HARD SAFETY FLOOR, not an optimization.
    //
    // padW/padH above are computed in JavaScript from the dimensions
    // getVideoInfo probed out of ffmpeg's stderr banner. That makes the probe a
    // SECOND source of truth about frame size, and `pad` fails outright the
    // moment it disagrees with the frames ffmpeg actually decodes:
    //
    //   [Parsed_pad] Padded dimensions cannot be smaller than input dimensions.
    //   [Parsed_pad] Failed to configure input pad on Parsed_pad
    //   [fc#0] Error reinitializing filters!
    //
    // That non-zero exit propagates as a rejection out of
    // compositeGraphicsCaptionTrack, is swallowed by graphicsExport.js's catch,
    // and silently degrades the whole job to the ASS renderer — which supports
    // neither video transforms nor caption transform keyframes, and reports
    // `renderedWithEffects: false` ("the advanced renderer couldn't run this
    // time"). Crucially `pad` exists ONLY when rotation is used, so a probe
    // disagreement is invisible until rotation is switched on and then breaks
    // the export every time — reproduced directly: with dims deliberately
    // disagreeing, rotation OFF renders fine and rotation ON fails with the
    // error above.
    //
    // Deferring to `iw`/`ih` means the padded size is taken from the stream
    // ffmpeg is really carrying, so it is arithmetically incapable of being
    // smaller than its own input regardless of what the probe said. When the
    // probe agrees (the normal case) padW/padH already exceed the scaled input,
    // so max() selects them and the emitted geometry is unchanged.
    const padWExpr = `max(${padW}\\,iw)`;
    const padHExpr = `max(${padH}\\,ih)`;
    activeStages.push(`[vt_scaled]pad='${padWExpr}':'${padHExpr}':(ow-iw)/2:(oh-ih)/2:color=black@0${sizeEval}[vt_padded]`);
    // rotate's output must match the padded canvas exactly, so it resolves the
    // same floor from its own input rather than re-deriving it from the probe.
    activeStages.push(`[vt_padded]rotate=angle='(${rotationExpr})*PI/180':fillcolor=black@0:out_w='max(${padW}\\,iw)':out_h='max(${padH}\\,ih)'[vt_rotated]`);
    afterGeometry = 'vt_rotated';
  } else if (scaleAnimates) {
    // CONSTANT-SIZE NORMALIZATION — the fix for "a keyframed zoom silently
    // does nothing in the exported file, unless a rotation happens to be
    // keyframed alongside it".
    //
    // `scale` with eval=frame emits a DIFFERENT frame size every frame. Most
    // filters cope; the opacity stage below does not. With scale+opacity and
    // no rotation, the exported video showed no zoom at all — measured on a
    // black frame with a known white square, scaling 1x->2x over the clip:
    //
    //   scale only      white area ratio 3.50  (a real zoom)
    //   scale+opacity   white area ratio 0.97  (nothing happened)
    //   scale+rotation  white area ratio 3.52  (a real zoom)
    //
    // The rotation column is the tell, and it is why this looked so
    // arbitrary from the outside: the rotation branch above pads and rotates
    // to a FIXED size, so everything downstream of it sees a constant frame
    // size and works — adding a rotation "fixed" the zoom purely as a side
    // effect of that normalization.
    //
    // So the same normalization is applied when there's no rotation: pad the
    // varying scaled frame out to the largest size the animation will ever
    // need, centred, with transparent filler. The layer downstream is then
    // constant-size in every case, and the overlay stage's own centring
    // (`(W-w)/2`) already accounts for a layer larger than the canvas —
    // that is exactly how the rotation path has always behaved.
    //
    // Only when scale actually ANIMATES: a constant scale already produces a
    // constant size, so a static transform emits a byte-identical graph to
    // before this branch existed.
    const boxW = Math.ceil(canvasWidth * maxScale);
    const boxH = Math.ceil(canvasHeight * maxScale);
    // Same `max(...,iw)` safety floor as the rotation branch — see its doc
    // comment: padW/padH come from a probe of the source dimensions, and
    // `pad` fails outright if it ever resolves smaller than its real input.
    activeStages.push(`[vt_scaled]pad='max(${boxW}\\,iw)':'max(${boxH}\\,ih)':(ow-iw)/2:(oh-ih)/2:color=black@0${sizeEval}[vt_sized]`);
    afterGeometry = 'vt_sized';
  }

  let afterAlpha = afterGeometry;
  if (everFades) {
    // Opacity is applied by RAMPING colorchannelmixer's alpha gain with timed
    // `sendcmd` commands. `aa` multiplies the existing per-pixel alpha, which
    // is exactly what this stage did before — the transparent pad area stays
    // transparent (0 * gain = 0) and only the visible video's own alpha is
    // scaled — so this is a drop-in at the same point in the chain.
    //
    // It replaces a `geq` doing `a='alpha(X,Y)*(<expr>)/100'`. That was by far
    // the most expensive stage in the whole pipeline, for a stupid reason:
    // opacity is a per-FRAME scalar (identical for every pixel), but geq is a
    // per-PIXEL filter, so it re-derived that one number for every pixel on
    // every plane. Measured on a real 35s 1920x1080 export with rotation +
    // opacity: the rotation pad inflates the canvas to 2524x1747 (2.13x the
    // source), giving 17.6 MILLION expression evaluations per frame and 18.3
    // BILLION across the clip — to produce 1038 distinct values. Each of those
    // walked an interpreted 1768-char, 16-branch if(between(...)) tree. That
    // one stage was ~87% of filter cost and took the export to 31.3 minutes,
    // past the client's own abort timeout, which is what made "every feature
    // at once" look like a broken render rather than a slow one.
    //
    // colorchannelmixer has no `eval` option in ffmpeg 6.1 (checked), but all
    // of its gains are runtime-settable, so sendcmd drives it: the value is
    // computed once per command and the actual pixel work is a native SIMD
    // multiply.
    const opacityCommands = buildOpacityCommandList(videoTransform, trimStart, trimEnd);
    activeStages.push(`[${afterGeometry}]sendcmd=c='${opacityCommands}',colorchannelmixer=aa=1[vt_faded]`);
    afterAlpha = 'vt_faded';
  }

  // `setsar=1` made explicit (not just relying on `scale` above defaulting
  // to it) so this segment's SAR is guaranteed to match the pre/post
  // segments' own explicit `setsar=1` below regardless of ffmpeg version —
  // `concat` fails outright the moment any segment disagrees.
  activeStages.push(`[vt_bg][${afterAlpha}]overlay=x='(W-w)/2+(${xExpr})/100*W':y='(H-h)/2+(${yExpr})/100*H',format=yuv420p,setsar=1[vt_active_out]`);

  // Segments outside the animated window: a plain trim, no per-pixel
  // filtering of any kind — just format-normalized so `concat` can stitch
  // them to the transformed middle segment. `setsar=1` matters here even
  // though nothing else about these segments changes: the active segment
  // above goes through `scale` (line 246), which normalizes SAR to 1:1
  // regardless of the source's own pixel aspect ratio, but a plain
  // trim+format never touches SAR at all — it stays whatever the SOURCE
  // video's own metadata says. Any source with non-square-pixel SAR
  // (common for real phone-recorded video, confirmed via a real ffmpeg
  // repro at 1080x1920 with a non-1:1 SAR source) then has a pre/post
  // segment whose SAR doesn't match the active segment's, and ffmpeg's
  // `concat` filter refuses to join segments with mismatched frame
  // parameters at all ("Failed to configure output pad on Parsed_concat"),
  // failing the ENTIRE export — this only manifests when keyframes don't
  // span the whole clip (leaving a real pre and/or post segment to concat),
  // which is exactly "a couple of rotation keyframes" rather than one
  // continuous animation, and losing keyframes/blend-mode/every other
  // graphics-only effect at once when it silently falls back to ASS.
  const preStages = trimStart > EPS
    ? [`[0:v]trim=start=0:end=${trimStart.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[vt_pre]`]
    : [];
  const postStages = trimEnd < duration - EPS
    ? [`[0:v]trim=start=${trimEnd.toFixed(3)}:end=${duration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[vt_post]`]
    : [];

  const segmentLabels = [...(preStages.length ? ['[vt_pre]'] : []), '[vt_active_out]', ...(postStages.length ? ['[vt_post]'] : [])];

  const filterComplex = [
    ...preStages,
    ...activeStages,
    ...postStages,
    ...(segmentLabels.length > 1 ? [`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=1:a=0[vt_out]`] : [])
  ].join(';');

  // With no pre/post segment at all (the animated window spans the whole
  // clip), there's nothing to concat — vt_active_out IS the final output,
  // just needs relabeling so the caller always gets a stable `[vt_out]`.
  if (segmentLabels.length === 1) {
    return { filterComplex: filterComplex.replace('[vt_active_out]', '[vt_out]'), outputLabel: '[vt_out]' };
  }

  return { filterComplex, outputLabel: '[vt_out]' };
}
