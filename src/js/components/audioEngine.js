/**
 * Live audio preview — the playback half of the audio timeline.
 *
 * Built on the Web Audio API rather than a pool of <audio> elements, for one
 * reason that matters: <audio>.play() is best-effort and arrives "soon",
 * which is fine for a notification sound and useless for an editor, where a
 * tick landing 40ms late against the word it punctuates is exactly the thing
 * the user is trying to judge. Web Audio schedules on the audio clock with
 * sample accuracy, so what the user hears in the preview is what the FFmpeg
 * mix will place in the exported file (see backend/utils/audioMixFilter.js —
 * both resolve timing from the SAME shared/audioTimeline.js data).
 *
 * TIMING MODEL. Nothing here keeps its own clock. `#preview-video` is the
 * source of time, exactly as it is for captions, keyframes and the timeline
 * ruler. On every event that can break the correspondence between video time
 * and audio-context time — play, pause, seek, rate change, or an edit to the
 * audio timeline itself — every scheduled source is torn down and the whole
 * timeline is re-scheduled from the video's current position. That is
 * deliberately blunt: re-deriving from scratch can't drift, whereas
 * incrementally patching a schedule against a media element that can stall,
 * loop or seek under you absolutely can.
 *
 * COST. Each distinct asset is fetched and decoded exactly ONCE per session
 * and cached as an AudioBuffer (`bufferCache`); an AudioBufferSourceNode is a
 * cheap, throwaway handle onto that shared buffer. Scrubbing creates no audio
 * objects at all — scheduling only happens while the video is actually
 * playing, so dragging the playhead stays as cheap as it was before this
 * feature existed.
 */
import { appState, subscribe } from '../state.js';
import { resolveSoundUrl } from '../../../shared/soundRegistry.js';
import { getAudioTrackDuration } from '../../../shared/audioTimeline.js';

// Where sound assets are fetched from. Local (`/sounds`) by default; point
// VITE_SOUNDS_BASE_URL at object storage/a CDN to serve them from elsewhere
// with no other change anywhere in the editor.
const SOUNDS_BASE_URL = import.meta.env.VITE_SOUNDS_BASE_URL || '/sounds';

let ctx = null;
/** url -> Promise<AudioBuffer>. Promises (not buffers) so concurrent requests for the same asset share one fetch+decode. */
const bufferCache = new Map();
/** Every currently-scheduled source, so a reschedule can tear all of them down. */
let activeSources = [];
let started = false;
let rescheduleQueued = false;

function getVideo() {
  return document.getElementById('preview-video');
}

/**
 * The AudioContext, created lazily. Browsers refuse to start one outside a
 * user gesture, and every path that reaches here (pressing play, previewing a
 * sound, adding a clip) is one — but a context created before a gesture would
 * be born `suspended`, so resume() is attempted on every use rather than only
 * at construction.
 */
function getContext() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function loadBuffer(url) {
  if (!url) return Promise.resolve(null);
  if (bufferCache.has(url)) return bufferCache.get(url);

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((data) => {
      const context = getContext();
      if (!context) return null;
      return context.decodeAudioData(data);
    })
    .catch((err) => {
      // A missing/undecodable asset must never break playback of everything
      // else — the clip is simply silent, and says so once in the console.
      console.warn(`[AudioEngine] Could not load "${url}": ${err.message}`);
      // Cached as a resolved null so a broken asset isn't re-fetched on every
      // single reschedule (a play/pause/seek loop would otherwise hammer it).
      return null;
    });

  bufferCache.set(url, promise);
  return promise;
}

/** Pre-warms the decode cache so the first play doesn't have to wait on a fetch. */
export function preloadSound(soundId) {
  return loadBuffer(resolveSoundUrl(soundId, SOUNDS_BASE_URL));
}

/**
 * The decoded AudioBuffer for a URL, or null if it can't be decoded.
 *
 * Exposed so the timeline's waveform drawing (see audioWaveform.js) reads the
 * SAME decoded buffer playback uses, rather than fetching and decoding the
 * file a second time — a full-length song decodes to hundreds of megabytes of
 * float samples, so doing that twice is not a small waste.
 */
export function getDecodedAudio(url) {
  return loadBuffer(url);
}

function stopAll() {
  activeSources.forEach(({ source }) => {
    try {
      source.onended = null;
      source.stop();
      source.disconnect();
    } catch {
      // Already stopped/ended — nothing to do.
    }
  });
  activeSources = [];
}

/**
 * Schedules one buffer.
 *
 * @param {AudioBuffer} buffer
 * @param {number} when - AudioContext time to begin. May be in the past, meaning "already playing" — then `offset` covers the part already elapsed.
 * @param {number} offset - Seconds into the buffer to begin at.
 * @param {number} playDuration - How long to play for, in CONTEXT seconds (already rate-adjusted), or null for "to the end".
 * @param {object} opts - { volume, fadeIn, fadeOut, playbackRate, loop, loopStart, loopEnd }
 */
function scheduleBuffer(buffer, when, offset, playDuration, opts) {
  const context = getContext();
  if (!context || !buffer) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = opts.playbackRate || 1;
  if (opts.loop) {
    source.loop = true;
    source.loopStart = opts.loopStart || 0;
    if (opts.loopEnd) source.loopEnd = opts.loopEnd;
  }

  const gain = context.createGain();
  const volume = opts.volume ?? 1;
  const startAt = Math.max(when, context.currentTime);

  // Fades are expressed against the CLIP's own head/tail, so a clip that is
  // already partway through when playback resumes (a seek into the middle of
  // a music bed) must not restart its fade-in from zero — the elapsed part of
  // the ramp is skipped and the gain picks up where it should already be.
  const elapsed = Math.max(0, startAt - when);
  const fadeIn = opts.fadeIn || 0;
  if (fadeIn > elapsed) {
    gain.gain.setValueAtTime(volume * (elapsed / fadeIn), startAt);
    gain.gain.linearRampToValueAtTime(volume, startAt + (fadeIn - elapsed));
  } else {
    gain.gain.setValueAtTime(volume, startAt);
  }

  const fadeOut = opts.fadeOut || 0;
  if (fadeOut > 0 && playDuration != null) {
    const endAt = when + playDuration;
    const fadeStart = Math.max(startAt, endAt - fadeOut);
    gain.gain.setValueAtTime(gain.gain.value, fadeStart);
    gain.gain.linearRampToValueAtTime(0.0001, endAt);
  }

  source.connect(gain);
  gain.connect(context.destination);

  const remaining = playDuration == null ? null : playDuration - elapsed;
  if (remaining != null && remaining <= 0) return;

  const entry = { source, gain };
  source.onended = () => {
    try { gain.disconnect(); } catch { /* already torn down */ }
    activeSources = activeSources.filter((s) => s !== entry);
  };

  if (remaining == null) source.start(startAt, offset);
  else source.start(startAt, offset, remaining * (opts.playbackRate || 1));

  activeSources.push(entry);
}

/**
 * Tears down every scheduled source and re-schedules the whole audio timeline
 * from the video's current position. The one and only scheduling path.
 *
 * Silent no-op while paused — which is what keeps scrubbing free: dragging
 * the playhead fires `seeked` repeatedly, and each of those just clears the
 * (empty) schedule rather than building anything.
 */
function reschedule() {
  stopAll();

  const video = getVideo();
  if (!video || video.paused || video.ended) return;

  const context = getContext();
  if (!context) return;

  const rate = video.playbackRate || 1;
  const videoTime = video.currentTime;
  const contextNow = context.currentTime;
  // Small lead so sources scheduled for "right now" land on a future audio
  // clock instant rather than racing it (which the spec resolves as "start
  // immediately", losing sub-block accuracy for that one clip).
  const anchor = contextNow + 0.02;

  /** Video-timeline seconds -> AudioContext seconds. The whole synchronization contract, in one line. */
  const toContextTime = (t) => anchor + (t - videoTime) / rate;

  (appState.soundEvents || []).forEach((event) => {
    if (!event.enabled) return;
    const url = resolveSoundUrl(event.soundId, SOUNDS_BASE_URL);
    loadBuffer(url).then((buffer) => {
      if (!buffer) return;
      // The schedule this buffer was requested for may have been torn down
      // while the fetch/decode was in flight (a seek, a pause). Re-checking
      // the video's state here is what stops a late decode from playing a
      // sound for a position the user has already left.
      const v = getVideo();
      if (!v || v.paused || Math.abs(v.currentTime - videoTime) > 0.5) return;

      const naturalDuration = buffer.duration / (event.playbackRate || 1);
      const clipDuration = event.duration != null
        ? Math.min(event.duration, naturalDuration)
        : naturalDuration;
      const when = toContextTime(event.startTime);
      // Context-seconds: a video played at 2x compresses the effect's
      // footprint on the timeline the same way it compresses everything else.
      const playDuration = clipDuration / rate;
      if (when + playDuration <= context.currentTime) return; // already over
      scheduleBuffer(buffer, when, 0, playDuration, {
        volume: event.volume,
        fadeIn: event.fadeIn,
        fadeOut: event.fadeOut,
        playbackRate: (event.playbackRate || 1) * rate
      });
    });
  });

  (appState.audioTracks || []).forEach((track) => {
    if (!track.enabled || !track.url) return;
    loadBuffer(track.url).then((buffer) => {
      if (!buffer) return;
      const v = getVideo();
      if (!v || v.paused || Math.abs(v.currentTime - videoTime) > 0.5) return;

      // sourceDuration may not have been known when the clip was created
      // (metadata still loading); the decoded buffer is authoritative, so an
      // untrimmed clip resolves its length from the real media here.
      const trimEnd = track.trimEnd != null ? Math.min(track.trimEnd, buffer.duration) : buffer.duration;
      const windowLength = Math.max(0, trimEnd - track.trimStart);
      if (windowLength <= 0) return;

      const declared = getAudioTrackDuration(track);
      const clipDuration = declared != null ? Math.min(declared, windowLength) : windowLength;
      const when = toContextTime(track.startTime);
      const playDuration = clipDuration / rate;
      if (when + playDuration <= context.currentTime) return;

      // Seeking into the middle of a bed must resume from the matching point
      // in the media, not restart it.
      const elapsed = Math.max(0, context.currentTime - when) * rate;
      scheduleBuffer(buffer, when, track.trimStart + elapsed, playDuration, {
        volume: track.volume,
        fadeIn: track.fadeIn,
        fadeOut: track.fadeOut,
        playbackRate: rate,
        loop: track.loop,
        loopStart: track.trimStart,
        loopEnd: trimEnd
      });
    });
  });
}

// --- The video's own audio level -------------------------------------------
//
// Two paths, and which one is used matters for reliability:
//
//   0-100%: written straight to `<video>.volume`. Native, synchronous, and
//   completely independent of the AudioContext — so the overwhelming majority
//   of sessions (including every session that never touches this control)
//   carry no added risk whatsoever.
//
//   Above 100%: a media element cannot amplify (its `volume` is capped at 1),
//   so the element is routed through a Web Audio gain node instead. That
//   routing is PERMANENT for the element once made and makes the element's
//   audio depend on the AudioContext being running, which is why it is created
//   lazily — only if and when the user actually asks for a boost, never
//   speculatively.
let videoGainNode = null;
let videoSourceNode = null;
let videoSourceFailed = false;

function ensureVideoGain(video) {
  if (videoGainNode) return videoGainNode;
  if (videoSourceFailed) return null;
  const context = getContext();
  if (!context) return null;
  try {
    videoSourceNode = context.createMediaElementSource(video);
    videoGainNode = context.createGain();
    videoSourceNode.connect(videoGainNode);
    videoGainNode.connect(context.destination);
    return videoGainNode;
  } catch (err) {
    // Most likely a cross-origin video the context isn't allowed to read, or
    // an element already routed elsewhere. Boost is simply unavailable then —
    // the native path below still gives full 0-100% control.
    console.warn(`[AudioEngine] Cannot route the video through Web Audio (boost above 100% unavailable): ${err.message}`);
    videoSourceFailed = true;
    return null;
  }
}

/**
 * Applies the current video-audio settings to the `<video>` element. Called
 * whenever they change and whenever the element is (re)attached, so a newly
 * uploaded video immediately inherits the level the user already set.
 */
export function applyVideoAudio() {
  const video = getVideo();
  if (!video) return;

  const muted = appState.videoMuted === true;
  const volume = Math.min(2, Math.max(0, appState.videoVolume ?? 1));

  video.muted = muted;

  if (volume > 1) {
    const gain = ensureVideoGain(video);
    if (gain) {
      // The element runs at unity and the gain node carries the whole level,
      // so the two never multiply together into something unexpected.
      video.volume = 1;
      gain.gain.value = muted ? 0 : volume;
      return;
    }
    // No Web Audio route available — clamp rather than pretend to boost.
    video.volume = 1;
    return;
  }

  video.volume = volume;
  // If a gain node was created earlier by a boost the user has since dialled
  // back, it is still in the signal path and must be returned to unity or it
  // would keep applying the old boost on top of the element's own volume.
  if (videoGainNode) videoGainNode.gain.value = muted ? 0 : 1;
}

/**
 * Coalesces bursts of reschedule requests into one per frame. An edit like
 * dragging a clip fires a state notification per pointermove; without this,
 * each one would tear down and rebuild the entire schedule mid-drag.
 */
function queueReschedule() {
  if (rescheduleQueued) return;
  rescheduleQueued = true;
  requestAnimationFrame(() => {
    rescheduleQueued = false;
    reschedule();
  });
}

/**
 * Plays one sound immediately, outside the timeline — the "preview this
 * effect" button in the sound picker. Goes through the same buffer cache, so
 * auditioning a sound also warms it for playback.
 */
export function previewSound(soundId, volume) {
  const context = getContext();
  if (!context) return;
  loadBuffer(resolveSoundUrl(soundId, SOUNDS_BASE_URL)).then((buffer) => {
    if (!buffer) return;
    scheduleBuffer(buffer, context.currentTime + 0.01, 0, null, { volume: volume ?? 0.8, playbackRate: 1 });
  });
}

/** Auditions an imported audio track from its own trim-in point. */
export function previewAudioTrack(track) {
  const context = getContext();
  if (!context || !track?.url) return;
  loadBuffer(track.url).then((buffer) => {
    if (!buffer) return;
    const trimEnd = track.trimEnd != null ? Math.min(track.trimEnd, buffer.duration) : buffer.duration;
    scheduleBuffer(buffer, context.currentTime + 0.01, track.trimStart, Math.max(0, trimEnd - track.trimStart), {
      volume: track.volume,
      fadeIn: track.fadeIn,
      fadeOut: track.fadeOut,
      playbackRate: 1
    });
  });
}

/** Stops anything this engine is currently playing (timeline or audition). */
export function stopPreview() {
  stopAll();
}

/**
 * Reads an audio file's duration in the browser, so a newly imported track
 * knows its own length immediately (for the timeline clip's width and its
 * trim bounds) without waiting for a server round-trip.
 */
export function readAudioDuration(url) {
  return loadBuffer(url).then((buffer) => (buffer ? buffer.duration : null));
}

/**
 * Wires the engine to the video element and the audio timeline's state.
 * Called once from PreviewStage.jsx's mount effect, alongside the existing
 * initPreviewWorkspace()/initCanvasTransform() calls.
 *
 * Guarded against double-initialization for the same reason preview.js and
 * sidebarInspector.js are: Vite Fast Refresh can re-run a mount effect with
 * no cleanup, which would otherwise leave two engines scheduling the same
 * sounds (audibly doubled).
 */
export function initAudioEngine() {
  if (started) return;
  started = true;

  const attach = (video) => {
    if (!video || video.dataset.audioEngineBound === 'true') {
      // Re-applied even for an already-bound element: React swaps the `src`
      // in place on a new upload, and a fresh source resets `volume`/`muted`
      // to their defaults, which would silently discard the user's level.
      if (video) applyVideoAudio();
      return;
    }
    video.dataset.audioEngineBound = 'true';
    applyVideoAudio();
    // Every event that can invalidate the video-time <-> audio-time mapping.
    ['play', 'playing', 'seeked', 'ratechange'].forEach((name) => {
      video.addEventListener(name, queueReschedule);
    });
    ['pause', 'ended', 'emptied', 'waiting'].forEach((name) => {
      video.addEventListener(name, stopAll);
    });
  };

  attach(getVideo());
  // The <video> is mounted by React and may not exist yet on the first call
  // (and is replaced when a new upload swaps the source), so re-attach on a
  // short poll rather than assuming a single stable element. Cheap, and it
  // keeps this module free of any coupling to React's mount ordering.
  const pollId = setInterval(() => attach(getVideo()), 500);

  // Edits to the audio timeline while playing take effect immediately —
  // adding a sound mid-playback should be audible on this pass, not the next.
  const unsubscribers = [
    ...['soundEvents', 'audioTracks'].map((key) => subscribe(key, queueReschedule)),
    // The video's own level is applied to the element directly rather than
    // scheduled, so it takes effect instantly — including mid-playback.
    ...['videoVolume', 'videoMuted'].map((key) => subscribe(key, applyVideoAudio))
  ];

  return () => {
    clearInterval(pollId);
    unsubscribers.forEach((fn) => fn());
    stopAll();
    started = false;
  };
}
