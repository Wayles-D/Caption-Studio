/**
 * Real waveforms for audio clips on the timeline.
 *
 * Replaces a decorative repeating-gradient texture that looked identical for
 * every clip and therefore told the user nothing. A waveform is not decoration:
 * it is how you find the downbeat to cut on, see where the speech starts, spot
 * a silent lead-in, and trim to a phrase — the reason every editor draws one.
 *
 * TWO-STAGE RESOLUTION. Peaks are computed ONCE per file at a fixed, generous
 * bucket count and cached; drawing then resamples that summary to whatever
 * pixel width the clip currently occupies. This matters because the alternative
 * — deriving peaks at the clip's exact pixel width — would re-scan every sample
 * of a multi-minute song on every trim, move, and window resize. The summary is
 * a few tens of KB and is scanned once.
 *
 * MIN/MAX PER BUCKET, not average magnitude: averaging visually flattens
 * transients, which are exactly the features you are looking at a waveform to
 * find. Keeping both extremes gives the familiar symmetric envelope.
 */
import { getDecodedAudio } from './audioEngine.js';

/**
 * Buckets summarised per file. Chosen so that even a clip stretched across a
 * wide desktop timeline still has several buckets per pixel (so the drawn
 * envelope is a real peak summary rather than a sparse, aliased sample), while
 * staying small enough to keep and scan cheaply.
 */
const SUMMARY_BUCKETS = 4000;

/**
 * How far the trace may be scaled up to fit the lane.
 *
 * A timeline strip is ~30px tall, so drawing raw amplitude makes anything
 * recorded below about -12dBFS a flat line — which is most real music beds and
 * nearly all voiceover. Every DAW fits the drawn trace to the clip's own peak
 * for exactly this reason: at this size the waveform's job is "where is the
 * loud part, where does the speech start, where is the silence", not absolute
 * level comparison between clips (which is not readable at 30px anyway).
 *
 * The cap is what keeps that honest: a clip whose peak is genuine near-silence
 * is NOT amplified into a full-height wall of noise, so "quiet" and "empty"
 * still look different from "loud".
 */
const DISPLAY_GAIN_LIMIT = 8;

/** url -> Promise<{ min: Float32Array, max: Float32Array } | null> */
const peakCache = new Map();

/**
 * Scans the decoded buffer once, recording the minimum and maximum sample in
 * each bucket across all channels (channels are merged: a stereo clip on a
 * 24px-tall timeline lane has no room for two independent traces, and the
 * combined envelope is what conveys "how loud is it here").
 */
function computePeaks(buffer) {
  const bucketCount = Math.min(SUMMARY_BUCKETS, Math.max(1, buffer.length));
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  min.fill(0);
  max.fill(0);

  const samplesPerBucket = buffer.length / bucketCount;

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const start = Math.floor(bucket * samplesPerBucket);
      const end = Math.min(buffer.length, Math.floor((bucket + 1) * samplesPerBucket));
      let lo = 0;
      let hi = 0;
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      if (lo < min[bucket]) min[bucket] = lo;
      if (hi > max[bucket]) max[bucket] = hi;
    }
  }

  // The loudest point in the whole file, kept so drawing can fit the trace to
  // the clip's own dynamic range — see DISPLAY_GAIN_LIMIT below.
  let peak = 0;
  for (let i = 0; i < bucketCount; i++) {
    const m = Math.max(Math.abs(min[i]), Math.abs(max[i]));
    if (m > peak) peak = m;
  }

  return { min, max, peak };
}

/**
 * The cached peak summary for a URL. Resolves to null when the file can't be
 * decoded — the clip then simply renders without a waveform rather than
 * breaking, exactly like a filmstrip tile that couldn't be extracted.
 */
export function getWaveformPeaks(url) {
  if (!url) return Promise.resolve(null);
  if (peakCache.has(url)) return peakCache.get(url);

  const promise = getDecodedAudio(url)
    .then((buffer) => (buffer ? computePeaks(buffer) : null))
    .catch(() => null);

  peakCache.set(url, promise);
  return promise;
}

/**
 * Draws the portion of the waveform between two fractions of the SOURCE file
 * onto `canvas`.
 *
 * Fractions (not seconds) because that is what makes trimming correct for
 * free: a clip trimmed to 10s-18s of a 30s file draws buckets 0.333-0.600 of
 * the summary, so the visible waveform always matches the audio that will
 * actually play — drag the trim handle and the drawn shape slides with it.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{min: Float32Array, max: Float32Array}} peaks
 * @param {object} options - `{ startFraction, endFraction, color }`
 */
export function drawWaveform(canvas, peaks, { startFraction = 0, endFraction = 1, color = '#ffffff' } = {}) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  // Backing store in device pixels so the trace stays crisp on a HiDPI
  // display instead of being upscaled — same approach as the caption canvas
  // and the filmstrip tiles.
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!peaks) return false;

  const total = peaks.min.length;
  const from = Math.max(0, Math.min(total - 1, Math.floor(startFraction * total)));
  const to = Math.max(from + 1, Math.min(total, Math.ceil(endFraction * total)));
  const span = to - from;

  const mid = height / 2;
  // Leave a hairline of breathing room so a full-scale peak doesn't render
  // flush against the clip's own border and read as clipping.
  const amplitude = mid * 0.88 * (peaks.peak > 0 ? Math.min(DISPLAY_GAIN_LIMIT, 1 / peaks.peak) : 1);

  ctx.fillStyle = color;

  for (let x = 0; x < width; x++) {
    // Each output pixel column covers a RANGE of summary buckets; taking the
    // extremes across that range (rather than one sampled bucket) is what
    // keeps a zoomed-out clip from visually dropping its transients.
    const bucketStart = from + Math.floor((x / width) * span);
    const bucketEnd = Math.max(bucketStart + 1, from + Math.floor(((x + 1) / width) * span));

    let lo = 0;
    let hi = 0;
    for (let b = bucketStart; b < bucketEnd && b < total; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
    }

    // Clamped to the canvas: the display gain above can push a transient past
    // full height, and an unclamped rect would just be cropped asymmetrically.
    const yTop = Math.max(0, mid - hi * amplitude);
    const yBottom = Math.min(height, mid - lo * amplitude);
    // Minimum 1px so silence still draws a centre line rather than vanishing —
    // "there is audio here and it is quiet" and "there is nothing here" are
    // different things and must look different.
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }

  return true;
}

/** Frees a file's cached summary — called when its clip is removed so a long song's peaks don't linger. */
export function releaseWaveform(url) {
  peakCache.delete(url);
}
