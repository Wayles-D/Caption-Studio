/**
 * Upload limits — ONE number, read by both sides.
 *
 * The browser checks a file against this before a single byte is sent (a
 * backend rejection for something the front end could have caught is a
 * front-end bug — and with video it is an expensive one: the old flow
 * uploaded all 500MB before learning the limit existed). The backend
 * enforces the same number in multer and words its 413 from it, so the two
 * can never drift apart the way a hardcoded "500MB" message and a separate
 * `500 * 1024 * 1024` already had.
 *
 * 4GB: a 10-minute 4K iPhone video is ~1.65GB (HEVC at ~22Mbps), and the
 * product has to handle at least that, with headroom for higher-bitrate
 * phones and longer takes. 1.5GB stopped a 10-minute 4K clip outright.
 */
export const MAX_VIDEO_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_VIDEO_UPLOAD_LABEL = '4GB';

/**
 * Why this file cannot be uploaded, in words meant for the person who chose
 * it — or null when it is fine. Checked in the browser BEFORE any request.
 */
export function videoUploadProblem(file) {
  if (!file) return 'No file was chosen.';
  if (!String(file.type || '').startsWith('video/')) {
    return 'Please select a valid video file.';
  }
  if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
    const gb = (file.size / (1024 * 1024 * 1024)).toFixed(1);
    return `This video is ${gb}GB — the most that can be uploaded is ${MAX_VIDEO_UPLOAD_LABEL}. `
      + 'Trimming it, or exporting it at a lighter quality, will bring it under.';
  }
  return null;
}
