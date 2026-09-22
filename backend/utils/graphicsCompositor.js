/**
 * Composites the shared graphics renderer's caption PNGs (see
 * graphicsFrameGenerator.js) onto a source video with FFmpeg, replacing the
 * `ass=` libass filter for whichever presets/modes the graphics renderer
 * currently supports. FFmpeg's job stays strictly compositing here — every
 * visual decision (font, color, position, shadow, outline, word timing) was
 * already baked into the PNGs; this file only places them in time and space.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpegPath from 'ffmpeg-static';
import { buildVideoTransformFilterChain } from './videoTransformFilter.js';
import { buildAudioMixGraph } from './audioMixFilter.js';

/**
 * Reads a video's DISPLAY-orientation pixel dimensions and duration from
 * FFmpeg's own stderr stream banner (no decoding, no separate ffprobe
 * binary/dependency — `-i` alone is enough for FFmpeg to print the input's
 * stream info before it errors out on "At least one output file must be
 * specified"). Frames are rendered at this exact resolution so they
 * composite 1:1 with no runtime scaling filter, and the duration is what the
 * caption track's trailing blank filler segment is padded out to (see
 * buildFullTimelineSegments).
 *
 * "Display-orientation" matters: phone-recorded portrait video is very
 * commonly ENCODED at landscape pixel dimensions with a `displaymatrix`
 * rotation tag telling players to rotate it for display (e.g. coded
 * 1920x1080 + "rotation of 90 degrees" for a video that's actually portrait
 * 1080x1920). FFmpeg's own demuxer auto-applies that rotation when DECODING
 * (on by default), so the frames compositeGraphicsCaptionTrack's filter
 * graph actually overlays onto are already rotated to display orientation —
 * only the raw stderr banner still reports the pre-rotation coded size. A
 * 90°/270° rotation tag therefore means width/height must be swapped here,
 * or every caption is sized and positioned for the wrong aspect entirely
 * (this is why the ASS/libass pipeline never had this problem: it never
 * independently probes dimensions, it just fits whatever shape actually
 * flows through the SAME filter graph, post-rotation).
 */
export function getVideoInfo(inputVideoPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));

    const proc = spawn(ffmpegPath, ['-i', inputVideoPath]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const videoLineMatch = stderr.match(/Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!videoLineMatch) {
        return reject(new Error(`Could not determine video dimensions from FFmpeg output for: ${inputVideoPath}`));
      }
      let width = parseInt(videoLineMatch[1], 10);
      let height = parseInt(videoLineMatch[2], 10);

      // Rotation metadata is reported a line or two AFTER the Video: line,
      // scoped to just this stream's own block (up to the next Stream #
      // line) so a rotation tag on a DIFFERENT stream can never be misread
      // as this video stream's own orientation.
      const afterVideoLine = stderr.slice(stderr.indexOf(videoLineMatch[0]) + videoLineMatch[0].length);
      const nextStreamIdx = afterVideoLine.search(/Stream #\d+:\d+/);
      const streamBlock = nextStreamIdx === -1 ? afterVideoLine : afterVideoLine.slice(0, nextStreamIdx);
      // Modern ffmpeg reports "displaymatrix: rotation of -90.00 degrees";
      // older/legacy tagging shows as a plain "rotate : 90" metadata field —
      // handle both since either can appear depending on how the source
      // video was originally muxed.
      const rotationMatch = streamBlock.match(/rotation of (-?\d+(?:\.\d+)?) degrees/i)
        || streamBlock.match(/rotate\s*:\s*(-?\d+)/i);
      if (rotationMatch) {
        const normalized = ((parseFloat(rotationMatch[1]) % 360) + 360) % 360;
        const isQuarterTurn = Math.abs(normalized - 90) < 1 || Math.abs(normalized - 270) < 1;
        if (isQuarterTurn) {
          [width, height] = [height, width];
        }
      }

      const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!durationMatch) {
        return reject(new Error(`Could not determine video duration from FFmpeg output for: ${inputVideoPath}`));
      }
      const [, hh, mm, ss, cs] = durationMatch;
      const duration = (parseInt(hh, 10) * 3600) + (parseInt(mm, 10) * 60) + parseInt(ss, 10) + (parseInt(cs, 10) / 100);

      // Whether the source has an audio stream at all. The audio mix (see
      // backend/utils/audioMixFilter.js) has to know: referencing `[0:a]` in a
      // filter graph for a silent input is a hard ffmpeg error, not a no-op,
      // so this cannot be left to `0:a?`-style optional mapping the way a
      // plain stream copy can.
      const hasAudio = /Stream #\d+:\d+.*?: Audio:/.test(stderr);

      resolve({ width, height, duration, hasAudio });
    });
  });
}

/**
 * Duration (and whether an audio stream exists) for ANY media file, read from
 * the same FFmpeg stderr banner getVideoInfo parses. Separate from
 * getVideoInfo because that one rejects when it finds no video stream, which
 * is the normal case for an imported music file — exactly the input this is
 * for (see uploadController.js's uploadAudioAsset).
 */
export function getAudioInfo(inputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));

    const proc = spawn(ffmpegPath, ['-i', inputPath]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!durationMatch) {
        return reject(new Error(`Could not determine duration from FFmpeg output for: ${inputPath}`));
      }
      const [, hh, mm, ss, cs] = durationMatch;
      const duration = (parseInt(hh, 10) * 3600) + (parseInt(mm, 10) * 60) + parseInt(ss, 10) + (parseInt(cs, 10) / 100);
      resolve({ duration, hasAudio: /Stream #\d+:\d+.*?: Audio:/.test(stderr) });
    });
  });
}

/**
 * Builds the final filter_complex stage(s) that composite `[captrack]` (the
 * concatenated, alpha-carrying caption-track stream) onto `baseVideoLabel`.
 *
 * 'normal'/falsy textBlendMode: a single plain `overlay` — exactly what this
 * function replaced, byte-identical output for every export that doesn't use
 * this feature.
 *
 * Any other blend mode: ffmpeg's `blend` filter ignores alpha entirely and
 * blends every pixel of the frame it's given, not just the glyph pixels —
 * so naively `blend`-ing `[captrack]` straight onto the video would visibly
 * corrupt every frame outside the caption's own bounding box too. The alpha
 * `[captrack]` already carries (each segment is normalized to `format=rgba`
 * before concat, and the plain `overlay` path above already relies on that
 * same alpha) is used instead to mask the blended result back down to just
 * the glyph-covered pixels:
 *   1. `split` the caption track into two copies — one to feed `blend`, one
 *      to extract the real alpha mask from.
 *   2. Convert the first copy AND the base video to `rgb24` before `blend`.
 *      This is not incidental: `blend`'s `all_mode` applies the SAME
 *      per-plane formula independently to whichever planes the two input
 *      frames carry (its own `c0_mode`/`c1_mode`/`c2_mode` options — `all_mode`
 *      just sets all three at once). The base video decodes straight off
 *      H.264 as `yuv420p`; blending two YUV frames with an intensity-domain
 *      formula like screen/lighten/multiply runs that SAME formula on the
 *      chroma (U/V) planes too — signals centered at 128 representing a
 *      color DIFFERENCE, not an intensity — which shifts the color balance
 *      and is exactly what produced the green/tinted export previously
 *      reported (the CSS mix-blend-mode/Canvas2D preview, for comparison,
 *      always blends in RGB, per spec). Forcing both inputs to `rgb24`
 *      first makes `blend` operate on true R/G/B planes, matching the
 *      preview's own color math exactly.
 *   3. `alphaextract` the second copy into a real grayscale alpha channel
 *      (rather than relying on its RGBA alpha surviving unrelated format
 *      conversions elsewhere in the graph) — this is the value `alphamerge`
 *      actually reads as the new alpha, per its own filter contract.
 *   4. `blend` the RGB base video against the RGB opaque copy with the
 *      requested mode — this "corrupts" the whole frame, which is expected;
 *      only the glyph-shaped region of it will actually be kept.
 *   5. `alphamerge` copies the extracted alpha back onto the blended RGB
 *      result, punching it down to just the glyph shape.
 *   6. A final `overlay` composites that alpha-punched, blended layer over
 *      the untouched base video — everywhere outside the glyph shape, the
 *      original video shows through completely unaffected, exactly matching
 *      CSS mix-blend-mode's own "blend confined to the element's own
 *      coverage" semantics. `overlay` is mathematically a linear alpha
 *      composite (`fg*alpha + bg*(1-alpha)`), which SHOULD produce the same
 *      result regardless of RGB vs YUV — but empirically (verified with a
 *      solid-color synthetic test: a known base color alpha-blended with a
 *      known caption color, sampled back with ffprobe/raw pixel dumps)
 *      `overlay`'s own `format=yuv420` option — a SEPARATE pixel-format
 *      choice from the `blend` step above, selecting what colorspace
 *      `overlay`'s own internal compositing math runs in — reintroduces the
 *      same class of shift once RGB values from a `blend` step feed into
 *      it, even though the earlier `blend` step alone was already
 *      confirmed correct at that point. `format=rgb` (not `format=yuv420`)
 *      keeps this step's own compositing in RGB too, matching the already
 *      blend-corrected upstream stages; a plain `format=yuv420p` afterward
 *      converts the finished, correctly-composited frame to what the
 *      encoder needs, with no compositing math left to run in that space.
 * `baseVideoLabel` is consumed twice in the blend branch (once for `blend`,
 * once for the final `overlay`) — the same "single input auto-split feeding
 * independent linear chains" shape the Unified Shadow feature already
 * validated as safe in backend/utils/ffmpeg.js (see that file's comment on
 * why a `scale2ref`-style reconverging diamond is the actual risk, not
 * repeated consumption of one input).
 *
 * @param {string} baseVideoLabel - The ffmpeg filter label for the base video stream (e.g. '[0:v]' or a video-transform chain's own output label).
 * @param {string} [textBlendMode] - One of shared/captionConfig.js's TEXT_BLEND_MODES, or falsy/'normal' for the plain overlay.
 * @returns {string[]} One or more filter_complex stage strings (no leading/trailing semicolons) to append after the `[captrack]` concat stage.
 */
function buildCaptionCompositeStages(baseVideoLabel, textBlendMode) {
  if (!textBlendMode || textBlendMode === 'normal') {
    return [`${baseVideoLabel}[captrack]overlay=x=0:y=0:format=yuv420[outv]`];
  }

  // The blend branch needs the base video TWICE — once to derive the blended
  // RGB layer, once again as the base the masked result is overlaid onto.
  // Referencing a raw demuxed input label like [0:v] twice is fine (ffmpeg
  // fans out real input streams automatically), which is why this worked
  // with no video transform active. But when a video transform IS active,
  // `baseVideoLabel` is a FILTER-GRAPH-DEFINED pad instead (e.g. [vt_out],
  // the video transform chain's own output — see buildVideoTransformFilterChain)
  // and a filter's output pad can only feed ONE downstream input unless
  // explicitly duplicated — reusing it a second time produced ffmpeg's
  // "Invalid stream specifier" / "matches no streams" errors and silently
  // fell back to the ASS pipeline (losing the blend mode AND, since [0:v]
  // was the fallback path, the video transform too). `split` here is always
  // valid (works for both a raw input and a filter-graph label), so it's
  // applied unconditionally rather than only when a video transform happens
  // to be active — one code path, no special-casing to keep in sync.
  return [
    `[captrack]split=2[ct_blend_src][ct_alpha_src]`,
    `[ct_blend_src]format=rgb24[ct_opaque]`,
    `[ct_alpha_src]alphaextract[ct_alpha]`,
    `${baseVideoLabel}split=2[ct_base_src][ct_overlay_base]`,
    `[ct_base_src]format=rgb24[ct_base_rgb]`,
    `[ct_base_rgb][ct_opaque]blend=all_mode=${textBlendMode}:all_opacity=1[ct_blended_rgb]`,
    `[ct_blended_rgb][ct_alpha]alphamerge[ct_blended_masked]`,
    `[ct_overlay_base][ct_blended_masked]overlay=x=0:y=0:format=rgb[ct_composited_rgb]`,
    `[ct_composited_rgb]format=yuv420p[outv]`
  ];
}

/**
 * Composites a CONTIGUOUS, gap-filled sequence of timed PNG segments (see
 * graphicsFrameGenerator.js's buildFullTimelineSegments — every phrase's own
 * caption slices plus blank filler segments between them) onto a source
 * video with a single overlay pass.
 *
 * All segments are read through ONE ffmpeg `concat` DEMUXER input (a text
 * manifest listing each PNG + its duration — see buildConcatListFile) rather
 * than each segment being its own `-loop 1 -t <duration> -i <file>` argument
 * on the actual OS command line. This isn't a style choice: a caption with
 * any animation/keyframe window subdivides into many tens-of-ms segments (see
 * graphicsFrameGenerator.js's ANIMATION_SAMPLE_STEP_SECONDS), and a real
 * animated caption routinely produces 300+ of them — at one `-i` argument
 * each, that reliably exceeds the OS command-line length limit
 * (`spawn ENAMETOOLONG`, confirmed in practice with exactly this segment
 * count). A STATIC caption's word-boundary-only slicing stays far below that
 * limit, which is why this bug was invisible for non-animated captions and
 * only surfaced once any animation/keyframe was applied — the two cases were
 * always rendered by the exact same renderer (shared/captionGraphics.js) up
 * to this point; the divergence was purely in how many ffmpeg CLI arguments
 * the animated case happened to need. When this limit was hit,
 * tryRenderCaptionsWithGraphics (graphicsExport.js) caught the throw and
 * silently fell back to the legacy ASS/libass pipeline — which has no
 * blend-mode support at all and its own, visibly different font rendering,
 * exactly matching the "opaque white, slightly blurry" symptom reported for
 * animated captions specifically. Moving the segment list into a manifest
 * FILE (the same "move it out of the argv" fix already applied to the filter
 * graph itself below, for the same underlying OS limit) removes the
 * per-segment argument entirely: this function now spawns ffmpeg with
 * exactly ONE `-i` for the source video and ONE `-i` for the whole caption
 * track, regardless of how many hundreds of segments it contains.
 *
 * The concat demuxer's own per-entry `duration` directive is timestamp-based,
 * not frame-count-based, and its LAST entry's duration is a documented no-op
 * (ffmpeg only applies `duration` to the transition INTO the next entry) —
 * both are irrelevant to correctness here because `fps=` + `trim=duration=`
 * below re-derive the exact same fixed-frame-rate, exact-total-length stream
 * the previous per-segment `-loop/-r/-t` approach produced, from the
 * manifest's timestamps rather than from frame-count arithmetic.
 *
 * @param {string} inputVideoPath - Absolute path to the source video.
 * @param {{start:number, end:number, file:string}[]} segments - Contiguous, time-ordered segments from buildFullTimelineSegments, covering the video's full duration.
 * @param {string} outputPath - Absolute path for the rendered output video.
 * @param {object} [videoTransformOpts] - `{ videoTransform, duration, canvasWidth, canvasHeight, textBlendMode }` — the VIDEO's own keyframed transform (see shared/videoTransform.js / backend/utils/videoTransformFilter.js), plus the resolved caption text blend mode (see shared/captionConfig.js's resolveTextBlendMode). Omitted, an identity transform, and/or textBlendMode 'normal'/unset: `[0:v]` and the plain `overlay` compositing both flow through completely unchanged, byte-identical to before either feature existed.
 * @returns {Promise<string>} Resolves with outputPath.
 */
export function compositeGraphicsCaptionTrack(inputVideoPath, segments, outputPath, videoTransformOpts = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));
    if (!segments.length) return reject(new Error('compositeGraphicsCaptionTrack: no segments to composite.'));

    // Each segment's duration is still quantized to an exact multiple of the
    // fixed compositor frame rate — same rationale as before this manifest
    // approach existed: an ordinary boundary-scale segment's own rounding
    // error is invisible, but an animation window's many tens-of-ms segments
    // would otherwise accumulate drift across the window (confirmed by
    // direct pixel comparison during this feature's own verification). The
    // manifest's timestamps are built purely by SUMMING these already-exact
    // quantized durations, so that guarantee carries over unchanged.
    const COMPOSITOR_FPS = 50;
    const FRAME_QUANTUM = 1 / COMPOSITOR_FPS;

    // Quantize each segment's BOUNDARY onto the frame grid, then take each
    // duration as the difference between consecutive boundaries — rather than
    // quantizing each duration independently.
    //
    // Independent per-duration quantization had an asymmetric floor
    // (`Math.max(FRAME_QUANTUM, ...)`) that stretched any segment shorter than
    // one frame up to a full frame. Because segments are CONTIGUOUS and tile
    // the video exactly, stretching one pushes every later segment later, so
    // the error accumulated as caption timing drift against the audio — not
    // merely a longer file. Measured on a real 4.02s export: segments summed
    // to exactly 4.020s raw, but 4.100s quantized, with the entire +0.080s
    // coming from 8 sub-frame segments hitting that floor (symmetric rounding
    // contributed -0.000s). By 35s the track ran ~0.46s long, and every
    // caption after the first sub-frame segment was late by the accumulated
    // amount.
    //
    // Boundary quantization is drift-free by construction: each segment starts
    // at its own true time snapped to the grid, errors never compound, and the
    // total is exactly the video duration snapped to the grid.
    const quantizeTime = (t) => Math.round(t / FRAME_QUANTUM) * FRAME_QUANTUM;

    // A segment whose quantized span is zero is SHORTER THAN ONE FRAME at the
    // compositor's rate, so it cannot be displayed at all — there is no frame
    // boundary inside it. It is dropped, and the following entry's duration
    // absorbs its span (that neighbour's image covers those sub-frame
    // milliseconds instead). Dropping it is what keeps every other segment on
    // time; the old floor kept it at the cost of delaying everything after it.
    const timeline = [];
    let cursor = quantizeTime(segments[0].start);
    const trackStart = cursor;
    segments.forEach((segment) => {
      const end = quantizeTime(segment.end);
      if (end - cursor < FRAME_QUANTUM / 2) return; // sub-frame — not displayable
      timeline.push({ file: segment.file, duration: end - cursor });
      cursor = end;
    });
    if (!timeline.length) return reject(new Error('compositeGraphicsCaptionTrack: every segment quantized away to sub-frame length.'));

    const orderedSegments = timeline;
    const quantizedDurations = timeline.map((entry) => entry.duration);
    const totalCaptionDuration = cursor - trackStart;

    // ffmpeg's concat-demuxer manifest format: one `file '<path>'` line per
    // segment, each preceded by the `duration` (in seconds) that segment
    // should occupy. Per the demuxer's own documented behavior the FINAL
    // entry's duration is a no-op, so its file line is repeated once more
    // with no trailing duration (the standard, documented workaround) — the
    // `trim=duration=` stage below is what actually pins the exact total
    // length regardless, so this repeat only needs to keep the demuxer from
    // running out of input before that trim point, not be precise itself.
    // Paths are forward-slash-normalized and single-quote-escaped, matching
    // the concat demuxer's own quoting rules (mirrors the relative-path
    // slash normalization backend/utils/ffmpeg.js already does for the same
    // reason: Windows drive-letter colons and backslashes otherwise breaking
    // ffmpeg's own filter/manifest path parsing).
    const escapeConcatPath = (p) => p.replace(/\\/g, '/').replace(/'/g, `'\\''`);
    const listLines = [];
    orderedSegments.forEach((entry, idx) => {
      listLines.push(`file '${escapeConcatPath(entry.file)}'`);
      listLines.push(`duration ${quantizedDurations[idx].toFixed(3)}`);
    });
    listLines.push(`file '${escapeConcatPath(orderedSegments[orderedSegments.length - 1].file)}'`);

    const concatListPath = path.join(os.tmpdir(), `caption-studio-concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(concatListPath, listLines.join('\n'), 'utf8');

    const inputArgs = ['-y', '-i', inputVideoPath, '-f', 'concat', '-safe', '0', '-i', concatListPath];

    // `fps=` resamples the demuxer's variable, duration-driven timestamps
    // into the same fixed-rate stream `-loop 1 -r 50 -t X` used to produce
    // per segment; `format=rgba` guarantees the fps filter's own output
    // stays alpha-carrying (same normalization the old per-segment
    // `format=rgba[sN]` stages provided); `trim=duration=`+`setpts=`
    // hard-pins the stream to the exact known total length and resets its
    // timestamps to start at 0, eliminating the concat demuxer's "final
    // entry's duration is a no-op" ambiguity entirely rather than relying on
    // the repeated last-file line above to get it exactly right on its own.
    const captionTrackStage = `[1:v]fps=${COMPOSITOR_FPS},format=rgba,trim=duration=${totalCaptionDuration.toFixed(3)},setpts=PTS-STARTPTS[captrack]`;

    // The VIDEO's own keyframed transform (see videoTransformFilter.js) —
    // when present, produces a `[vt_out]` stage that REPLACES `[0:v]` as
    // what the caption track overlays onto, so captions still composite on
    // top exactly as before, now onto the transformed video. Absent (no
    // videoTransform, or the plain identity), `[0:v]` is used directly —
    // zero change to every existing export.
    const { videoTransform, duration, canvasWidth, canvasHeight, textBlendMode } = videoTransformOpts;
    const videoTransformChain = (duration && canvasWidth && canvasHeight)
      ? buildVideoTransformFilterChain(videoTransform, duration, canvasWidth, canvasHeight)
      : null;
    const baseVideoLabel = videoTransformChain ? videoTransformChain.outputLabel : '[0:v]';

    // Text Blend Mode: 'normal'/unset (the default, and every export before
    // this feature existed) keeps the single plain `overlay` line below,
    // completely unchanged. Any other value composites the caption track
    // with an ffmpeg `blend` filter instead of a plain alpha-over, so the
    // text visually merges with the video colors underneath it (like a CSS
    // mix-blend-mode/CapCut "blend mode text" effect) — see
    // buildCaptionCompositeStages' own doc comment for why `blend` (which
    // ignores alpha and blends the WHOLE frame) needs the extra split/
    // alphamerge masking step to only affect glyph-covered pixels.
    const compositeStages = buildCaptionCompositeStages(baseVideoLabel, textBlendMode);

    // The audio timeline (sound effects + imported tracks — see
    // backend/utils/audioMixFilter.js). Its `-i` arguments are appended AFTER
    // the two above, so it starts numbering at input index 2. When there is
    // nothing to mix this is null and the output args below keep the original
    // `-map 0:a? -c:a copy` passthrough exactly as it always was — an export
    // with no audio edits is byte-identical to one from before this feature
    // existed, including still being a stream copy rather than a re-encode.
    const { audio, hasSourceAudio } = videoTransformOpts;
    const audioMix = (audio && duration)
      ? buildAudioMixGraph(audio, { duration, hasSourceAudio: hasSourceAudio !== false, firstInputIndex: 2 })
      : null;
    if (audioMix) inputArgs.push(...audioMix.inputArgs);

    const filterComplex = [
      ...(videoTransformChain ? [videoTransformChain.filterComplex] : []),
      captionTrackStage,
      ...compositeStages,
      ...(audioMix ? audioMix.filterStages : [])
    ].join(';');

    // The filter graph is written to a FILE and passed via
    // `-filter_complex_script` instead of `-filter_complex <string>` on the
    // command line. This is not cosmetic: a video-transform keyframe chain
    // (see videoTransformFilter.js) samples the whole export duration and
    // can easily produce a filter graph tens of thousands of characters
    // long, and a caption track with many segments adds more on top of
    // that — both comfortably exceed the OS's command-line length limit
    // (confirmed in practice: `spawn` throwing `ENAMETOOLONG` on a filter
    // graph of ~33k characters). That failure was previously silent from
    // the CALLER's point of view: tryRenderCaptionsWithGraphics(in
    // graphicsExport.js) catches any error here and falls back to the
    // legacy ASS pipeline, which does not support Rolling Stack, keyframes,
    // per-word/keyword animation, or video transforms the same way — so a
    // filter graph too long to pass as an argument silently downgraded the
    // ENTIRE export to the old renderer, discarding every one of those
    // features at once, exactly matching this bug's reported symptoms. A
    // script file has no such length limit regardless of graph complexity
    // or export duration.
    const filterScriptPath = path.join(os.tmpdir(), `caption-studio-filter-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filterScriptPath, filterComplex, 'utf8');

    const args = [
      ...inputArgs,
      '-filter_complex_script', filterScriptPath,
      '-map', '[outv]',
      // With an audio mix, the mixed stream replaces the source's own audio
      // map and must be encoded (it is raw filter output, so there is nothing
      // to copy). AAC 192k stereo is the safe, universally-playable choice for
      // an MP4 and is well above transparent for speech plus effects.
      ...(audioMix
        ? ['-map', audioMix.outputLabel, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
        : ['-map', '0:a?', '-c:a', 'copy']),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      outputPath
    ];

    console.log(`Executing FFmpeg Graphics Composite command (${orderedSegments.length} of ${segments.length} segments displayable, via 1 concat-manifest input): ${ffmpegPath} ${args.slice(0, 4).join(' ')} ... [concat list: ${concatListPath}] ... [filter_complex_script: ${filterScriptPath}, ${filterComplex.length} chars] ... ${args.slice(-8).join(' ')}`);

    const cleanupScript = () => {
      try { fs.unlinkSync(filterScriptPath); } catch (cleanupErr) { /* best-effort; a leftover temp file is harmless */ }
      try { fs.unlinkSync(concatListPath); } catch (cleanupErr) { /* best-effort; a leftover temp file is harmless */ }
    };

    const ffmpegProc = spawn(ffmpegPath, args);
    const stderrLines = [];

    ffmpegProc.stderr.on('data', (data) => {
      const newLines = data.toString().split('\n');
      stderrLines.push(...newLines);
      if (stderrLines.length > 50) stderrLines.splice(0, stderrLines.length - 50);
    });

    ffmpegProc.on('error', (err) => { cleanupScript(); reject(err); });
    ffmpegProc.on('close', (code) => {
      cleanupScript();
      if (code === 0) {
        resolve(outputPath);
      } else {
        const errorSummary = stderrLines.join('\n');
        console.error(`FFmpeg graphics composite failed. Details:\n${errorSummary}`);
        reject(new Error(`FFmpeg graphics composite failed with exit code ${code}. Details: ${errorSummary.slice(-500)}`));
      }
    });
  });
}
