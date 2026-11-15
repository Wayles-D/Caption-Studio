/**
 * EDITING PROXY, the browser side — waits for the server's browser-safe copy
 * of an upload (backend/utils/proxyVideo.js), downloads it ONCE, and keeps it
 * for every reload after.
 *
 * Why the editor plays a proxy at all: phones record HEVC, often 4K. Firefox
 * on Windows cannot decode HEVC without a paid codec, so a user imported a
 * video and got no picture and no video sound — only the separately-played
 * sound effects — and a reload brought the same undecodable file back. The
 * proxy is H.264, which every browser plays, and 1080p, which scrubs smoothly.
 * The original stays the export master.
 *
 * The proxy is DOWNLOADED and served from a blob URL rather than streamed
 * from the server, on purpose:
 *   - a blob URL is same-origin, so the canvases that read the video's pixels
 *     (object detection, segmentation, occlusion) are never tainted;
 *   - the server purges its copy after 30 minutes, which would break a
 *     streamed preview on the next reload; the saved blob does not expire.
 */
import { rememberProxyFile } from './projectPersistence.js';

const POLL_MS = 3000;
/** A proxy takes ~1 minute for a 3.5-minute 4K clip on a GPU, ~4 on a CPU; a 10-minute clip ~3x that. */
const GIVE_UP_AFTER_MS = 45 * 60 * 1000;

let current = null; // { baseName, cancelled }

/** Stops waiting for the proxy of the previous project (a new upload, a reset). */
export function cancelProxyWait() {
  if (current) current.cancelled = true;
  current = null;
}

/**
 * Follows the proxy for `baseName` until it is ready, then downloads and
 * saves it. Never throws — a missing proxy is not an error the editor must
 * stop for: the original keeps playing wherever the browser can.
 *
 * @param {string} apiBase
 * @param {string} baseName
 * @param {object} handlers
 * @param {(state:{status:string, detail?:string})=>void} [handlers.onStatus]
 *   'waiting' | 'downloading' | 'ready' | 'not-needed' | 'unavailable' | 'failed'
 * @returns {Promise<string|null>} a blob URL to play, or null when there is no proxy.
 */
export async function followProxy(apiBase, baseName, { onStatus } = {}) {
  cancelProxyWait();
  const me = { baseName, cancelled: false };
  current = me;
  const report = (status, detail) => { if (!me.cancelled) onStatus?.({ status, detail }); };
  const t0 = Date.now();

  try {
    report('waiting');
    let state = null;
    while (!me.cancelled) {
      try {
        const res = await fetch(`${apiBase}/api/upload/proxy/${encodeURIComponent(baseName)}`);
        state = res.ok ? await res.json() : null;
      } catch {
        state = null; // a blip in the connection: keep waiting
      }
      const status = state?.status;
      if (status === 'ready' && state.url) break;
      if (status === 'not-needed' || status === 'unavailable' || status === 'failed') {
        report(status, state?.error);
        return null;
      }
      if (Date.now() - t0 > GIVE_UP_AFTER_MS) {
        report('failed', 'timed out');
        return null;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (me.cancelled) return null;

    report('downloading');
    const res = await fetch(`${apiBase}${state.url}`);
    if (!res.ok) {
      report('failed', `download ${res.status}`);
      return null;
    }
    const blob = await res.blob();
    if (me.cancelled) return null;
    // Saved before it is played, so a reload a moment later already has it.
    await rememberProxyFile(baseName, blob);
    report('ready');
    return URL.createObjectURL(blob);
  } finally {
    if (current === me) current = null;
  }
}

/**
 * Swaps the editor's <video> onto a new source WITHOUT losing the user's
 * place: the playhead and the paused/playing state carry across, so the proxy
 * arriving mid-edit is invisible apart from the picture getting smoother.
 */
export function swapVideoSourceKeepingPlace(video, setSrc, nextUrl) {
  if (!video) { setSrc(nextUrl); return; }
  const at = video.currentTime || 0;
  const wasPlaying = !video.paused;
  const restore = () => {
    video.removeEventListener('loadedmetadata', restore);
    try { video.currentTime = Math.min(at, video.duration || at); } catch { /* not seekable yet */ }
    if (wasPlaying) video.play().catch(() => {});
  };
  video.addEventListener('loadedmetadata', restore);
  setSrc(nextUrl);
}
