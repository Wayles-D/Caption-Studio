/**
 * Shared fetch helpers for calling the backend API, with error classification
 * that distinguishes a network-level failure (which covers both an actual CORS
 * rejection and a dropped connection — browsers deliberately give JS no way to
 * tell those apart) from a normal HTTP error response from the server, instead
 * of collapsing both into a single generic "Upload error" message.
 *
 * NO REQUEST TIMEOUT. There used to be a 10-minute abort on every call, which
 * was actively harmful for the two things this module is used for: /api/upload
 * and /api/upload/regenerate both run transcription and/or a full FFmpeg
 * render synchronously inside one request/response cycle, and the Download
 * button always re-renders the current edits before serving the file (see
 * App.jsx's handleDownloadVideo). A long video, a slow machine, or a
 * keyframe-heavy filter graph can legitimately take longer than any fixed
 * limit, and aborting was pure loss: the browser gave up while the server kept
 * rendering to completion, so the user saw "the server took too long" for a
 * render that actually succeeded, with the finished file sitting on disk and
 * no way to reach it.
 *
 * A hung connection is now surfaced by the transport itself (the socket
 * closing yields the TypeError branch below) or by the user cancelling, rather
 * than by this module guessing at how long a render is allowed to take.
 * `fetchJson` still accepts an explicit `timeoutMs` for any future caller that
 * genuinely needs a bounded wait — it is simply no longer imposed by default.
 */

/**
 * fetch(), optionally bounded by an abort timer.
 *
 * With no `timeoutMs` (the default) this is a plain fetch that waits as long
 * as the server needs. Pass a positive number to opt into an abort; on timeout
 * it rejects with a DOMException named 'AbortError' so callers can distinguish
 * it from other failures (see describeFetchError).
 */
export async function fetchRequest(url, options = {}, timeoutMs = null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Turns a caught fetch error (or a non-ok Response) into a user-facing
 * message that identifies WHAT KIND of failure occurred, without hiding the
 * underlying error — the raw error/status is always appended so the actual
 * cause is still visible, not just a generic label.
 *
 * @param {Error} err - The error thrown by fetch()/await response.json(), or
 *   a synthetic Error carrying `.status` for a non-ok HTTP response.
 */
export function describeFetchError(err) {
  if (err && err.name === 'AbortError') {
    // Only reachable when a caller opted into an explicit timeout, or the
    // request was cancelled (e.g. the page navigating away mid-render).
    return `The request was cancelled before the server responded. (aborted)`;
  }

  if (err && err.status != null) {
    // A real HTTP response came back — the server told us exactly what went
    // wrong (already the most specific message available), just labeled with
    // its status so a crash-triggered 500 reads differently from a plain 400.
    return `${err.message} (HTTP ${err.status})`;
  }

  if (err instanceof TypeError) {
    // fetch() throws this exact same generic TypeError for a CORS rejection,
    // a dropped/reset connection (e.g. the backend process restarting
    // mid-request), a DNS failure, or being offline — the browser does not
    // expose which one, by design, for security reasons. Naming all of the
    // real possibilities here (rather than just saying "CORS error" or
    // "network error") is the most honest thing the UI can show.
    return `Could not reach the server. This can happen if the server crashed or restarted, the network connection was interrupted, or the server isn't configured to allow requests from this site (CORS). (${err.message})`;
  }

  return err?.message || 'An unexpected error occurred.';
}

/**
 * Fetches and throws a classified Error for any non-ok response (attaching
 * `.status` so describeFetchError can label it) so every caller gets the same
 * failure-mode handling. Waits as long as the server needs unless an explicit
 * `timeoutMs` is passed.
 */
export async function fetchJson(url, options = {}, timeoutMs = null) {
  const response = await fetchRequest(url, options, timeoutMs);

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const err = new Error(errData.message || `Request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}
