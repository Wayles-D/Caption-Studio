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

      resolve({ width, height, duration });
    });
  });
}

/**
 * Composites a CONTIGUOUS, gap-filled sequence of timed PNG segments (see
 * graphicsFrameGenerator.js's buildFullTimelineSegments — every phrase's own
 * caption slices plus blank filler segments between them) onto a source
 * video with a single overlay pass.
 *
 * Each segment becomes its own `-loop 1 -t <duration>` input, but rather than
 * chaining one `overlay:enable=between(...)` filter per segment — expensive
 * and, worse, SEQUENTIAL for a full-length video with dozens/hundreds of
 * segments, since ffmpeg evaluates the `enable` expression on every frame of
 * every stage even for stages nowhere near their active window — every
 * segment input is instead joined into ONE continuous caption-track stream
 * with the `concat` filter (segments already play back-to-back purely via
 * their own declared durations, no per-frame time comparison needed), which
 * is THEN overlaid onto the source video exactly once. This mirrors how
 * burnSubtitles' Unified Shadow layer is built as one pre-composited track
 * rather than per-glyph (see backend/utils/ffmpeg.js).
 *
 * @param {string} inputVideoPath - Absolute path to the source video.
 * @param {{start:number, end:number, file:string}[]} segments - Contiguous, time-ordered segments from buildFullTimelineSegments, covering the video's full duration.
 * @param {string} outputPath - Absolute path for the rendered output video.
 * @param {object} [videoTransformOpts] - `{ videoTransform, duration, canvasWidth, canvasHeight }` — the VIDEO's own keyframed transform (see shared/videoTransform.js / backend/utils/videoTransformFilter.js). Omitted or an identity transform: `[0:v]` flows through completely unchanged, byte-identical to before this feature existed.
 * @returns {Promise<string>} Resolves with outputPath.
 */
export function compositeGraphicsCaptionTrack(inputVideoPath, segments, outputPath, videoTransformOpts = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));
    if (!segments.length) return reject(new Error('compositeGraphicsCaptionTrack: no segments to composite.'));

    // Each `-loop 1` still-image input generates frames at its OWN default
    // rate (independent of the source video's), and `-t <duration>` then
    // truncates that stream to the nearest frame boundary AT THAT RATE. For
    // an ordinary word-boundary-scale segment (hundreds of ms or more) the
    // resulting sub-frame rounding error is a single-digit-ms rounding error,
    // invisible against the segment's own length. But the short segments an
    // entrance animation introduces (see graphicsFrameGenerator.js's
    // ANIMATION_SAMPLE_STEP_SECONDS) are only tens of ms long, so that same
    // per-segment rounding error is a much larger fraction of the segment —
    // and concat sums segment durations one after another, so those errors
    // ACCUMULATE across a whole animation window's worth of short segments,
    // visibly shifting the whole caption track out of sync with the source
    // video by the time the window ends (confirmed by direct pixel
    // comparison during this feature's own verification). Forcing every
    // image input to the SAME explicit, fixed frame rate and rounding every
    // declared duration to an exact multiple of that rate's frame period
    // eliminates the rounding step entirely — durations sum to exact frame
    // counts, so no drift can ever accumulate, regardless of how many
    // segments a video has.
    const COMPOSITOR_FPS = 50;
    const FRAME_QUANTUM = 1 / COMPOSITOR_FPS;
    const quantizeDuration = (raw) => Math.max(FRAME_QUANTUM, Math.round(raw / FRAME_QUANTUM) * FRAME_QUANTUM);

    const inputArgs = ['-y', '-i', inputVideoPath];
    segments.forEach((segment) => {
      const duration = quantizeDuration(Math.max(0.001, segment.end - segment.start));
      inputArgs.push('-loop', '1', '-r', String(COMPOSITOR_FPS), '-t', duration.toFixed(3), '-i', segment.file);
    });

    // Normalize every segment input to the same pixel format before concat
    // (cheap — these are already-identical-resolution stills, this just
    // guarantees ffmpeg never has to reconcile mismatched decoded formats
    // mid-stream), then concat into one track, then a single overlay burns
    // it onto the source video.
    const normalizeStages = segments.map((_, idx) => `[${idx + 1}:v]format=rgba[s${idx}]`);
    const concatInputs = segments.map((_, idx) => `[s${idx}]`).join('');

    // The VIDEO's own keyframed transform (see videoTransformFilter.js) —
    // when present, produces a `[vt_out]` stage that REPLACES `[0:v]` as
    // what the caption track overlays onto, so captions still composite on
    // top exactly as before, now onto the transformed video. Absent (no
    // videoTransform, or the plain identity), `[0:v]` is used directly —
    // zero change to every existing export.
    const { videoTransform, duration, canvasWidth, canvasHeight } = videoTransformOpts;
    const videoTransformChain = (duration && canvasWidth && canvasHeight)
      ? buildVideoTransformFilterChain(videoTransform, duration, canvasWidth, canvasHeight)
      : null;
    const baseVideoLabel = videoTransformChain ? videoTransformChain.outputLabel : '[0:v]';

    const filterComplex = [
      ...(videoTransformChain ? [videoTransformChain.filterComplex] : []),
      ...normalizeStages,
      `${concatInputs}concat=n=${segments.length}:v=1:a=0[captrack]`,
      `${baseVideoLabel}[captrack]overlay=x=0:y=0:format=yuv420[outv]`
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
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'copy',
      outputPath
    ];

    console.log(`Executing FFmpeg Graphics Composite command (${segments.length} segments): ${ffmpegPath} ${args.slice(0, 6).join(' ')} ... [filter_complex_script: ${filterScriptPath}, ${filterComplex.length} chars] ... ${args.slice(-8).join(' ')}`);

    const cleanupScript = () => {
      try { fs.unlinkSync(filterScriptPath); } catch (cleanupErr) { /* best-effort; a leftover temp file is harmless */ }
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
