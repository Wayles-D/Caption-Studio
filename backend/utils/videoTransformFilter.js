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
 *  3. Skip `geq` (the most expensive single stage — real per-pixel
 *     expression evaluation) entirely when opacity is never animated away
 *     from 100 — the common case (most edits are position/scale/rotation,
 *     not a fade).
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
 * seconds" — most filters (scale/pad/rotate/overlay) use lowercase `t`, but
 * geq (the only filter here with real expression support for alpha)
 * confusingly uses uppercase `T` instead — verified empirically, not just
 * assumed, since ffmpeg's own docs are inconsistent about this per-filter.
 */
function buildPiecewiseExpr(samples, timeVar = 't') {
  if (samples.length === 1) return formatNum(samples[0].value);
  let expr = formatNum(samples[samples.length - 1].value); // after-last: hold
  for (let i = samples.length - 2; i >= 0; i--) {
    const a = samples[i];
    const b = samples[i + 1];
    const span = b.t - a.t;
    const lerp = span > 0.0001
      ? `(${formatNum(a.value)}+(${formatNum(b.value)}-${formatNum(a.value)})*(${timeVar}-${formatNum(a.t)})/${formatNum(span)})`
      : formatNum(b.value);
    expr = `if(between(${timeVar},${formatNum(a.t)},${formatNum(b.t)}),${lerp},${expr})`;
  }
  return `if(lt(${timeVar},${formatNum(samples[0].t)}),${formatNum(samples[0].value)},${expr})`;
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

  const scaleExpr = buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.scale })));
  const rotationExpr = everRotates ? buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.rotation }))) : null;
  const xExpr = buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.offsetXPct })));
  const yExpr = buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.offsetYPct })));
  // geq (below) is the one filter here whose expression language uses
  // uppercase `T` instead of `t` — see buildPiecewiseExpr's doc comment.
  const opacityExpr = everFades ? buildPiecewiseExpr(samples.map((s) => ({ t: s.t, value: s.opacity })), 'T') : null;

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

  // The animated window, trimmed from the source with its ORIGINAL absolute
  // timestamps preserved (no setpts reset) — the piecewise expressions above
  // were built against the real timeline's `t`/`T`, exactly like
  // resolveVideoTransformAtTime expects, so the trimmed segment must keep
  // seeing the same absolute time or every sample would land in the wrong
  // place. ffmpeg's `concat` FILTER (unlike the concat protocol/demuxer)
  // re-stamps output timestamps sequentially from the frames it's handed,
  // so it doesn't care that this segment's own input PTS aren't zero-based.
  const activeStages = [`[0:v]trim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)}[vt_active_src]`];
  activeStages.push(`[vt_active_src]format=rgba[vt_fmt]`);
  activeStages.push(`[vt_fmt]scale=w='iw*(${scaleExpr})':h='ih*(${scaleExpr})':eval=frame[vt_scaled]`);

  let afterGeometry = 'vt_scaled';
  if (everRotates) {
    activeStages.push(`[vt_scaled]pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame[vt_padded]`);
    activeStages.push(`[vt_padded]rotate=angle='(${rotationExpr})*PI/180':fillcolor=black@0:out_w=${padW}:out_h=${padH}[vt_rotated]`);
    afterGeometry = 'vt_rotated';
  }

  let afterAlpha = afterGeometry;
  if (everFades) {
    // colorchannelmixer's aa option is a plain static float — it does NOT
    // evaluate per-frame expressions (confirmed empirically: ffmpeg rejects
    // an expression string there outright). geq is the filter that actually
    // supports a real per-frame expression for alpha; `alpha(X,Y)` reads the
    // existing per-pixel alpha (0 in the transparent pad area, opaque over
    // the video) so multiplying by it preserves the pad's transparency
    // while scaling only the visible video's own alpha. This is the single
    // most expensive stage here (real per-pixel expression evaluation), so
    // it's only ever included when opacity is actually animated.
    activeStages.push(`[${afterGeometry}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opacityExpr})/100'[vt_faded]`);
    afterAlpha = 'vt_faded';
  }

  activeStages.push(`color=black:size=${canvasWidth}x${canvasHeight}:duration=${(trimEnd - trimStart).toFixed(3)}[vt_bg]`);
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
