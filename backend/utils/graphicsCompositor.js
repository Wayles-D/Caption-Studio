/**
 * Composites the shared graphics renderer's caption PNGs (see
 * graphicsFrameGenerator.js) onto a source video with FFmpeg, replacing the
 * `ass=` libass filter for whichever presets/modes the graphics renderer
 * currently supports. FFmpeg's job stays strictly compositing here — every
 * visual decision (font, color, position, shadow, outline, word timing) was
 * already baked into the PNGs; this file only places them in time and space.
 */
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * Reads a video's pixel dimensions and duration straight from FFmpeg's own
 * stderr stream banner (no decoding, no separate ffprobe binary/dependency —
 * `-i` alone is enough for FFmpeg to print the input's stream info before it
 * errors out on "At least one output file must be specified"). Frames are
 * rendered at this exact resolution so they composite 1:1 with no runtime
 * scaling filter, and the duration is what the caption track's trailing
 * blank filler segment is padded out to (see buildFullTimelineSegments).
 */
export function getVideoInfo(inputVideoPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));

    const proc = spawn(ffmpegPath, ['-i', inputVideoPath]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const dimensionMatch = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (!dimensionMatch) {
        return reject(new Error(`Could not determine video dimensions from FFmpeg output for: ${inputVideoPath}`));
      }
      const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!durationMatch) {
        return reject(new Error(`Could not determine video duration from FFmpeg output for: ${inputVideoPath}`));
      }
      const [, hh, mm, ss, cs] = durationMatch;
      const duration = (parseInt(hh, 10) * 3600) + (parseInt(mm, 10) * 60) + parseInt(ss, 10) + (parseInt(cs, 10) / 100);

      resolve({ width: parseInt(dimensionMatch[1], 10), height: parseInt(dimensionMatch[2], 10), duration });
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
 * @returns {Promise<string>} Resolves with outputPath.
 */
export function compositeGraphicsCaptionTrack(inputVideoPath, segments, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg static binary path could not be resolved.'));
    if (!segments.length) return reject(new Error('compositeGraphicsCaptionTrack: no segments to composite.'));

    const inputArgs = ['-y', '-i', inputVideoPath];
    segments.forEach((segment) => {
      const duration = Math.max(0.001, segment.end - segment.start);
      inputArgs.push('-loop', '1', '-t', duration.toFixed(3), '-i', segment.file);
    });

    // Normalize every segment input to the same pixel format before concat
    // (cheap — these are already-identical-resolution stills, this just
    // guarantees ffmpeg never has to reconcile mismatched decoded formats
    // mid-stream), then concat into one track, then a single overlay burns
    // it onto the source video.
    const normalizeStages = segments.map((_, idx) => `[${idx + 1}:v]format=rgba[s${idx}]`);
    const concatInputs = segments.map((_, idx) => `[s${idx}]`).join('');
    const filterComplex = [
      ...normalizeStages,
      `${concatInputs}concat=n=${segments.length}:v=1:a=0[captrack]`,
      `[0:v][captrack]overlay=x=0:y=0:format=yuv420[outv]`
    ].join(';');

    const args = [
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'copy',
      outputPath
    ];

    console.log(`Executing FFmpeg Graphics Composite command (${segments.length} segments): ${ffmpegPath} ${args.slice(0, 6).join(' ')} ... [filter_complex omitted, ${filterComplex.length} chars] ... ${args.slice(-8).join(' ')}`);

    const ffmpegProc = spawn(ffmpegPath, args);
    const stderrLines = [];

    ffmpegProc.stderr.on('data', (data) => {
      const newLines = data.toString().split('\n');
      stderrLines.push(...newLines);
      if (stderrLines.length > 50) stderrLines.splice(0, stderrLines.length - 50);
    });

    ffmpegProc.on('error', reject);
    ffmpegProc.on('close', (code) => {
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
