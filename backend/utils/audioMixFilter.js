/**
 * Builds the FFmpeg audio half of an export: the video's own audio plus every
 * enabled sound effect and audio track, mixed down to one stream.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. Both render paths need it — the graphics
 * compositor (backend/utils/graphicsCompositor.js) and the legacy ASS/libass
 * burn (backend/utils/ffmpeg.js), which any export silently falls back to
 * whenever the graphics renderer is out of scope or throws. If only the first
 * one mixed audio, a fallback would produce a video whose captions still
 * looked right but whose sound effects had vanished, with nothing anywhere
 * saying so. One builder, used by both, removes that whole class of bug.
 *
 * TIMING. Every clip's placement comes from the SAME shared/audioTimeline.js
 * data the Web Audio preview schedules from, and is expressed to FFmpeg as an
 * `adelay` in whole milliseconds against the video's own timeline. There is no
 * re-derivation, no rounding to a frame grid (audio is not frame-quantized —
 * quantizing it is exactly how a sound ends up a frame off the word it
 * punctuates), and no second clock.
 *
 * MIXING. `amix` with `normalize=0` is deliberate: `amix` normalizes by input
 * count by default, so adding a second sound effect would quietly halve the
 * volume of the speech, and a third would drop it to a third — a mix that
 * changes every time the user adds a tick is not a mix anyone can work with.
 * With normalization off, each input's level is exactly the gain the user set,
 * and the final `alimiter` catches the only real downside (a genuine clip when
 * several loud things land on the same instant) instead of pre-emptively
 * ducking everything.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getActiveAudio, normalizeAudioTimeline, isDefaultVideoAudio } from '../../shared/audioTimeline.js';
import { resolveSoundFileName, SOUNDS_DIR_NAME } from '../../shared/soundRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Where bundled sound-effect assets live on disk. Defaults to the same
 * `public/sounds/` directory the browser serves them from, so preview and
 * export mix the identical file rather than two copies that can drift apart.
 * `SOUNDS_DIR` overrides it — that one env var is the whole migration to
 * object storage-backed local cache or a different layout.
 */
export const SOUNDS_DIR = process.env.SOUNDS_DIR
  || path.join(__dirname, '../..', 'public', SOUNDS_DIR_NAME);

/** Where user-imported audio files are stored (see the /api/upload/audio endpoint). */
export const AUDIO_UPLOADS_DIR = process.env.AUDIO_UPLOADS_DIR
  || path.join(__dirname, '..', 'audio');

/**
 * The export's internal audio format. Fixed for every input regardless of
 * what each source actually is, because `amix` and `concat` require matching
 * sample rate, sample format and channel layout, and a mismatch is not an
 * error — FFmpeg inserts its own conversions and the result can be subtly
 * wrong (a mono effect landing in only the left channel is the classic one).
 * Stating it explicitly on every branch means there is nothing to infer.
 */
const SAMPLE_RATE = 48000;
const CHANNEL_LAYOUT = 'stereo';
const AFORMAT = `aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=${CHANNEL_LAYOUT}`;

/** FFmpeg's `adelay` takes whole milliseconds — one per output channel. */
function delayStage(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  if (ms === 0) return null;
  return `adelay=${ms}|${ms}:all=1`;
}

/** Absolute path to a bundled effect, or null when the asset is missing from disk. */
export function resolveSoundAssetPath(soundId) {
  const filePath = path.join(SOUNDS_DIR, resolveSoundFileName(soundId));
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Absolute path to an imported audio file.
 *
 * `assetId` is validated as a bare filename before being joined: it arrives
 * from the client, and a value like `../../server.js` would otherwise let a
 * request name any file on the box as an "audio track" and have its bytes
 * muxed into a downloadable video.
 */
export function resolveAudioAssetPath(assetId) {
  if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}$/.test(assetId)) return null;
  const filePath = path.join(AUDIO_UPLOADS_DIR, assetId);
  // Defence in depth: even a name that passes the pattern above must still
  // resolve inside the uploads directory.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(AUDIO_UPLOADS_DIR)) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Builds the audio input arguments and filter stages for one export.
 *
 * @param {object|string} audioTimeline - `{ soundEvents, audioTracks }` (or its JSON string form — see normalizeAudioTimeline).
 * @param {object} options
 * @param {number} options.duration - The video's duration in seconds. The mix is pinned to exactly this length.
 * @param {boolean} options.hasSourceAudio - Whether input 0 actually has an audio stream.
 * @param {number} options.firstInputIndex - The ffmpeg input index the first audio file will occupy (i.e. how many `-i` arguments the caller has already used).
 * @returns {{inputArgs:string[], filterStages:string[], outputLabel:string, clipCount:number}|null}
 *   null when there is nothing to mix — the caller then keeps its existing
 *   `-map 0:a? -c:a copy` path completely untouched, so every export that
 *   doesn't use this feature is byte-identical to before it existed.
 */
export function buildAudioMixGraph(audioTimeline, { duration, hasSourceAudio, firstInputIndex }) {
  const normalized = normalizeAudioTimeline(audioTimeline);
  const { soundEvents, audioTracks, video } = getActiveAudio(normalized);

  // A changed video level with no clips still needs the mix: it is the only
  // place that level can be applied, so returning null here would export the
  // original soundtrack at full volume while the preview played it quiet (or
  // muted). `hasAnyAudio` uses the same rule.
  const videoAudioIsDefault = isDefaultVideoAudio(video);
  if (soundEvents.length === 0 && audioTracks.length === 0 && videoAudioIsDefault) return null;

  const inputArgs = [];
  const filterStages = [];
  const mixLabels = [];
  let inputIndex = firstInputIndex;

  // A silent bed of exactly the video's length is always the first mix input.
  //
  // It costs nothing and it solves two problems at once: a video with NO audio
  // track still produces a valid, correctly-sized output stream (rather than
  // needing a separate no-source-audio code path), and `amix`'s output can
  // never end early just because every real clip happens to finish before the
  // video does — which would otherwise truncate the file's audio with no error.
  filterStages.push(`anullsrc=channel_layout=${CHANNEL_LAYOUT}:sample_rate=${SAMPLE_RATE},atrim=duration=${duration.toFixed(3)},${AFORMAT}[abed]`);
  mixLabels.push('[abed]');

  // The source video's own soundtrack, at whatever level the user set. Muting
  // it drops the input from the graph entirely rather than mixing in a stream
  // scaled to zero — same result, one less stream for ffmpeg to decode.
  const includeSourceAudio = hasSourceAudio && !video.muted;
  if (includeSourceAudio) {
    const sourceChain = [];
    if (Math.abs(video.volume - 1) > 1e-3) sourceChain.push(`volume=${video.volume.toFixed(4)}`);
    sourceChain.push(AFORMAT);
    filterStages.push(`[0:a]${sourceChain.join(',')}[asrc]`);
    mixLabels.push('[asrc]');
  }

  soundEvents.forEach((event, i) => {
    const assetPath = resolveSoundAssetPath(event.soundId);
    if (!assetPath) {
      console.warn(`[AudioMix] Sound asset for "${event.soundId}" not found in ${SOUNDS_DIR} — skipping this effect. Run: node backend/scripts/generate-sounds.js`);
      return;
    }

    const label = `sfx${i}`;
    inputArgs.push('-i', assetPath);

    const chain = [];
    // `atempo` is what playbackRate means for a file (a real time-stretch,
    // pitch preserved) rather than resampling it, matching Web Audio's own
    // playbackRate closely enough that preview and export agree.
    if (event.playbackRate && Math.abs(event.playbackRate - 1) > 1e-3) {
      chain.push(`atempo=${event.playbackRate.toFixed(4)}`);
    }
    // Truncating to an explicit duration happens BEFORE the delay, so the
    // length is measured from the clip's own head, not from zero.
    if (event.duration != null) chain.push(`atrim=duration=${event.duration.toFixed(3)}`);
    if (event.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${event.fadeIn.toFixed(3)}`);
    if (event.fadeOut > 0 && event.duration != null) {
      chain.push(`afade=t=out:st=${Math.max(0, event.duration - event.fadeOut).toFixed(3)}:d=${event.fadeOut.toFixed(3)}`);
    }
    if (Math.abs(event.volume - 1) > 1e-3) chain.push(`volume=${event.volume.toFixed(4)}`);
    chain.push(AFORMAT);
    const delay = delayStage(event.startTime);
    if (delay) chain.push(delay);

    filterStages.push(`[${inputIndex}:a]${chain.join(',')}[${label}]`);
    mixLabels.push(`[${label}]`);
    inputIndex += 1;
  });

  audioTracks.forEach((track, i) => {
    const assetPath = resolveAudioAssetPath(track.assetId);
    if (!assetPath) {
      console.warn(`[AudioMix] Imported audio asset "${track.assetId}" not found in ${AUDIO_UPLOADS_DIR} — skipping track "${track.name}".`);
      return;
    }

    const label = `aud${i}`;
    inputArgs.push('-i', assetPath);

    const chain = [];
    // Trim window first, in SOURCE coordinates, then reset timestamps to zero
    // so the subsequent `adelay` positions the trimmed region's head at the
    // clip's timeline start. Without the `asetpts`, `atrim` keeps the original
    // timestamps and the delay stacks on top of the trim offset — a clip
    // trimmed 10s in would land 10s later than the user placed it.
    if (track.trimStart > 0 || track.trimEnd != null) {
      const trimArgs = [`start=${track.trimStart.toFixed(3)}`];
      if (track.trimEnd != null) trimArgs.push(`end=${track.trimEnd.toFixed(3)}`);
      chain.push(`atrim=${trimArgs.join(':')}`);
    }
    chain.push('asetpts=PTS-STARTPTS');

    const clipDuration = track.trimEnd != null
      ? Math.max(0, track.trimEnd - track.trimStart)
      : (track.sourceDuration != null ? Math.max(0, track.sourceDuration - track.trimStart) : null);

    if (track.loop) {
      // `aloop` counts SAMPLES, not seconds. Looping to cover the rest of the
      // timeline and then trimming is simpler and more predictable than
      // computing a loop count from a duration that may not be known.
      chain.push(`aloop=loop=-1:size=${Math.round(SAMPLE_RATE * 60)}`);
      chain.push(`atrim=duration=${Math.max(0, duration - track.startTime).toFixed(3)}`);
      chain.push('asetpts=PTS-STARTPTS');
    }

    if (track.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${track.fadeIn.toFixed(3)}`);
    if (track.fadeOut > 0 && clipDuration != null) {
      chain.push(`afade=t=out:st=${Math.max(0, clipDuration - track.fadeOut).toFixed(3)}:d=${track.fadeOut.toFixed(3)}`);
    }
    if (Math.abs(track.volume - 1) > 1e-3) chain.push(`volume=${track.volume.toFixed(4)}`);
    chain.push(AFORMAT);
    const delay = delayStage(track.startTime);
    if (delay) chain.push(delay);

    filterStages.push(`[${inputIndex}:a]${chain.join(',')}[${label}]`);
    mixLabels.push(`[${label}]`);
    inputIndex += 1;
  });

  // Every real clip was skipped (missing assets). Still worth mixing if the
  // video's own level changed — that IS the edit in that case. Otherwise fall
  // back to leaving the audio path alone rather than emitting a silence-only
  // remux that would needlessly re-encode.
  const baseLabelCount = includeSourceAudio ? 2 : 1;
  if (mixLabels.length <= baseLabelCount && videoAudioIsDefault) return null;

  filterStages.push(
    // `duration=first` pins the mix to the silent bed, which is exactly the
    // video's length — so the exported file's audio is never longer than its
    // video because a music bed overran, and never shorter because everything
    // finished early. `dropout_transition=0` disables amix's default 2-second
    // volume ramp when an input ends, which would otherwise audibly duck the
    // speech every single time a tick finished.
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[amixed]`,
    // Catches genuine clipping from several loud things coinciding, instead of
    // pre-emptively attenuating everything the way amix's own normalization
    // would. Transparent when nothing is near full scale.
    `[amixed]alimiter=limit=0.97:level=disabled,${AFORMAT}[outa]`
  );

  return {
    inputArgs,
    filterStages,
    outputLabel: '[outa]',
    clipCount: mixLabels.length - baseLabelCount
  };
}
