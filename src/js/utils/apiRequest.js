/**
 * Shared fetch helpers for calling the backend API, with error classification
 * that distinguishes a slow/hung connection, a network-level failure (which
 * covers both an actual CORS rejection and a dropped connection — browsers
 * deliberately give JS no way to tell those apart), and a normal HTTP error
 * response from the server, instead of collapsing all of them into a single
 * generic "Upload error" message.
 */

// The upload endpoint runs transcription + FFmpeg rendering synchronously
// within a single request/response cycle, so a real render can legitimately
// take minutes. This timeout exists only to catch a genuinely hung
// connection (e.g. the backend process died without ever closing the
// socket) — not to preempt normal long-running processing.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * fetch() with an abort-based timeout. Behaves exactly like fetch() on
 * success; on timeout, rejects with a DOMException named 'AbortError' so
 * callers can distinguish it from other failures (see describeFetchError).
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
    return `The server took too long to respond (it may be restarting or overloaded). Please try again in a moment. (timed out)`;
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
 * Fetches, applies the timeout above, and throws a classified Error for any
 * non-ok response (attaching `.status` so describeFetchError can label it)
 * so every caller gets the same failure-mode handling.
 */
export async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs);

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const err = new Error(errData.message || `Request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}
