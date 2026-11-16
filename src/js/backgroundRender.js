/**
 * BACKGROUND RENDERING, the editor's half (the server's is
 * backend/utils/renderCache.js): when the edits settle, the project as it
 * stands is sent to the server, which renders the export from it in chunks,
 * below normal priority — so pressing Export mostly joins what is done.
 *
 * The payload is built by exportPayload, the SAME function the export itself
 * uses: the server reuses its chunks only for a project that is byte for byte
 * the one it rendered, so the two must never be assembled two ways.
 */
import { appState, subscribe, getStyleParams } from './state.js';
import { collectEditedWords } from './components/transcriptEditorState.js';
import { prepareObjectEffectsForExport } from './components/objectEffects.js';
import { prepareOcclusionsForExport } from './components/occlusion.js';
import { ensureServerHasProjectFiles } from './projectPersistence.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';

/** How long the edits must be still before the project is sent. */
const SETTLE_MS = 3000;

/** What /api/upload/regenerate (and /prerender) is sent: the project, exactly as the preview has it. */
export async function exportPayload(exportSize) {
  // Subject isolation and occlusion send the objects' MASKS with the style
  // params — they live in IndexedDB and may not be in memory yet.
  await prepareObjectEffectsForExport();
  await prepareOcclusionsForExport();
  return {
    baseName: appState.baseName,
    words: collectEditedWords(appState),
    styles: getStyleParams(),
    // 'hd' = a 1080p file (fast), 'original' = the source's own size.
    exportSize
  };
}

let started = false;
let timer = null;
let lastSent = null;
let sending = false;

function eligible() {
  return !!appState.baseName && !appState.uploadedFile?.demo && !appState.isProcessing;
}

async function send(apiBase) {
  if (sending) { schedule(apiBase); return; }
  if (!eligible()) return;
  sending = true;
  try {
    const body = JSON.stringify(await exportPayload(useWorkspaceStore.getState().exportSize));
    if (body === lastSent || !eligible()) return;
    const post = () => fetch(`${apiBase}/api/upload/prerender`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    let res = await post();
    // The server let the video go (a long pause, a restart): put it back, once.
    if (res.status === 404) {
      await ensureServerHasProjectFiles(apiBase);
      res = await post();
    }
    if (res.ok) lastSent = body;
  } catch {
    // Offline or the server is down: the export renders everything itself.
  } finally {
    sending = false;
  }
}

function schedule(apiBase) {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; send(apiBase); }, SETTLE_MS);
}

/** True when the server has the project as it is now — no edit still waiting to be sent. */
export function backgroundRenderSettled() {
  return !timer && !sending && lastSent !== null;
}

/** Starts watching the project; safe to call more than once. */
export function startBackgroundRender(apiBase) {
  if (started) return;
  started = true;
  subscribe('*', (key) => {
    // Pure UI churn is not an edit (the payload check below catches the rest).
    if (key === 'history' || key === 'stateChanged' || key === 'isProcessing') return;
    schedule(apiBase);
  });
  // A different remembered export size is a different file to prepare.
  useWorkspaceStore.subscribe((state, prev) => { if (state.exportSize !== prev.exportSize) schedule(apiBase); });
}
