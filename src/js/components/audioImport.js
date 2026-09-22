/**
 * Importing a user's own audio file as a timeline track.
 *
 * An audio track differs from a sound effect in one operationally important
 * way: the effect's asset is already bundled and present on BOTH sides
 * (browser and export server — see shared/soundRegistry.js), whereas an
 * imported file exists only in the user's browser until it is uploaded. The
 * exporter runs server-side and cannot read a blob URL, so a track that was
 * never uploaded would preview perfectly and then be silently missing from
 * the exported video — the exact "it plays in the browser so it must be in
 * the MP4" trap this feature has to avoid.
 *
 * So importing is deliberately two-sided and both sides must succeed:
 *   - a local object URL, which the Web Audio preview decodes immediately, and
 *   - an `assetId` from the backend, which the FFmpeg mix resolves to a real
 *     file on disk.
 * Both are stored on the same clip. If the upload fails, no clip is created
 * and the caller reports it, rather than leaving a clip that can only ever be
 * heard in the preview.
 */
import { addAudioTrack } from './audioTimeline.js';
import { readAudioDuration } from './audioEngine.js';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

/** What the file picker accepts. Kept in sync with the backend's own filter (see backend/utils/multerConfig.js's uploadAudio). */
export const AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/x-m4a,audio/aac,audio/ogg,audio/webm,.mp3,.wav,.m4a,.aac,.ogg';

/**
 * Uploads `file`, then creates the timeline clip for it.
 *
 * The duration is read from the DECODED buffer in the browser rather than
 * from the server's probe: it is the same number the preview will actually
 * play, it is available without a second round-trip, and the timeline needs
 * it to draw the clip's width at all.
 *
 * @param {File} file
 * @param {object} [options] - `{ startTime }` to place the clip somewhere other than the playhead.
 * @returns {Promise<object>} The created track clip.
 * @throws {Error} With a user-presentable message when the upload is rejected or fails.
 */
export async function importAudioFile(file, options = {}) {
  if (!file) throw new Error('No file selected.');

  const formData = new FormData();
  formData.append('audio', file);

  const response = await fetch(`${API_BASE_URL}/api/upload/audio`, {
    method: 'POST',
    body: formData
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.assetId) {
    throw new Error(payload?.message || `Audio upload failed (HTTP ${response.status}).`);
  }

  const url = URL.createObjectURL(file);
  // Best-effort: a file the browser cannot decode still uploads and still
  // exports (FFmpeg's format support is far broader than the Web Audio API's),
  // it just can't report its own length locally — the clip then falls back to
  // the server's probed duration.
  const decodedDuration = await readAudioDuration(url).catch(() => null);

  return addAudioTrack({
    name: file.name,
    assetId: payload.assetId,
    url,
    duration: decodedDuration ?? payload.duration ?? null
  }, options);
}

/**
 * Opens the OS file picker and imports whatever is chosen. Creates the input
 * on demand rather than requiring markup, so any surface (the timeline's
 * "+ Audio" button, the audio panel) can trigger an import with one call.
 */
export function promptForAudioFile(onDone, onError) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = AUDIO_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    document.body.removeChild(input);
    if (!file) return;
    try {
      const track = await importAudioFile(file);
      onDone?.(track);
    } catch (err) {
      console.error('[AudioImport]', err);
      onError?.(err);
    }
  });
  input.click();
}
