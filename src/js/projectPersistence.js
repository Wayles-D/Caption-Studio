/**
 * Keeps the project across a reload.
 *
 * Before this, closing or reloading the tab lost everything — captions,
 * edits, sound effects, overlays, cinematic text — because the project only
 * ever lived in memory, and the preview played the video from an in-memory
 * blob URL that dies with the page.
 *
 * What is saved, in this browser's IndexedDB:
 *   - the project document (state.js's getProjectSnapshot), re-saved a
 *     moment after every change;
 *   - the ORIGINAL video file and every imported audio file, as Blobs — the
 *     preview plays from these, and they can be sent back to the server if it
 *     has since deleted its copy (it purges uploads after 30 minutes; see
 *     ensureServerHasProjectFiles).
 *
 * One project is kept: the one being edited. Uploading a new video starts a
 * new one. IndexedDB rather than localStorage because a video is far too big
 * for localStorage, and because it stores Blobs natively.
 *
 * Every call degrades to a no-op if IndexedDB is unavailable (a private
 * window, a blocked origin) — the editor works exactly as it did before, it
 * just doesn't remember.
 */
import { appState, subscribe, getProjectSnapshot, restoreProjectSnapshot } from './state.js';

const DB_NAME = 'bhynd';
const DB_VERSION = 1;
const DOC_STORE = 'project';
const FILE_STORE = 'files';
const DOC_KEY = 'current';
const SAVE_DELAY_MS = 600;

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    let result = null;
    try {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

const videoKey = (baseName) => `video:${baseName}`;
const audioKey = (assetId) => `audio:${assetId}`;
const imageKey = (assetId) => `image:${assetId}`;

/** Saves a file Blob (the video, an imported audio file) under its key. */
function putFile(key, blob) {
  return run(FILE_STORE, 'readwrite', (store) => store.put(blob, key));
}
function getFile(key) {
  return run(FILE_STORE, 'readonly', (store) => store.get(key));
}

/**
 * A NEW project has begun (a fresh upload): drop the previous one's files and
 * keep this video. Awaited by nobody on purpose — saving a large video takes
 * a moment and the editor must not wait on it.
 */
export async function startProjectWithVideo(baseName, file) {
  await run(FILE_STORE, 'readwrite', (store) => store.clear());
  if (baseName && file) await putFile(videoKey(baseName), file);
}

/** Remembers an imported audio file, for the preview after a reload and for re-sending it to the server. */
export function rememberAudioFile(assetId, file) {
  if (!assetId || !file) return Promise.resolve(null);
  return putFile(audioKey(assetId), file);
}

/** Remembers an imported picture (shared/imageLayer.js), for the preview after a reload and for re-sending it to the server. */
export function rememberImageFile(assetId, file) {
  if (!assetId || !file) return Promise.resolve(null);
  return putFile(imageKey(assetId), file);
}

/** A remembered picture, or null. */
export function getSavedImageFile(assetId) {
  return assetId ? getFile(imageKey(assetId)) : Promise.resolve(null);
}

let saveTimer = null;
// Set by discardSavedProject: the project is being thrown away, and nothing
// (a pending save, the page-hide flush) may write it back.
let discarded = false;
function saveNow() {
  saveTimer = null;
  if (discarded || !appState.isLoaded || !appState.baseName) return Promise.resolve(null);
  let doc;
  try {
    // Structured-clone-safe: a JSON round trip drops anything that isn't
    // plain data (a File, a function) instead of failing the whole save.
    doc = JSON.parse(JSON.stringify(getProjectSnapshot()));
  } catch {
    return Promise.resolve(null);
  }
  doc.savedAt = Date.now();
  return run(DOC_STORE, 'readwrite', (store) => store.put(doc, DOC_KEY));
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}
/**
 * NEW PROJECT: forgets the saved project — its document and every file
 * (video, audio, images) — so the next load starts empty. Saving stops for
 * the rest of this page's life; the caller reloads the page.
 */
export async function discardSavedProject() {
  discarded = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await run(DOC_STORE, 'readwrite', (store) => store.delete(DOC_KEY));
  await run(FILE_STORE, 'readwrite', (store) => store.clear());
}

/** Writes any pending save immediately (tests, and the page going away). */
export function flushProjectSave() {
  if (saveTimer) clearTimeout(saveTimer);
  return saveNow();
}

let autosaveStarted = false;
/** Re-saves the project a moment after any change. Idempotent. */
export function startProjectAutosave() {
  if (autosaveStarted) return;
  autosaveStarted = true;
  subscribe('*', (key) => {
    // Pure UI churn doesn't need a save; everything else might be an edit.
    if (key === 'history' || key === 'stateChanged' || key === 'isProcessing') return;
    scheduleSave();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { flushProjectSave(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushProjectSave(); });
  }
}

/**
 * Opens the saved project, if there is one: restores the document and
 * returns the URL to play the video from (a fresh blob URL for an uploaded
 * video, the demo's own URL for the demo), or null when there is nothing to
 * restore or the video can no longer be found.
 *
 * Imported audio tracks get fresh blob URLs too — the ones they were saved
 * with died with the page.
 */
export async function restoreSavedProject({ demoVideoUrl }) {
  const doc = await run(DOC_STORE, 'readonly', (store) => store.get(DOC_KEY));
  if (!doc || !doc.baseName) return null;

  let videoUrl = null;
  if (doc.uploadedFile?.demo) {
    videoUrl = demoVideoUrl;
  } else {
    const blob = await getFile(videoKey(doc.baseName));
    if (!blob) return null;
    videoUrl = URL.createObjectURL(blob);
  }

  const tracks = await Promise.all((doc.audioTracks || []).map(async (track) => {
    if (!track?.assetId) return track;
    const blob = await getFile(audioKey(track.assetId));
    return blob ? { ...track, url: URL.createObjectURL(blob) } : track;
  }));

  restoreProjectSnapshot({ ...doc, audioTracks: tracks });
  return { videoUrl, name: doc.uploadedFile?.name || null, savedAt: doc.savedAt || null };
}

/**
 * Before a render: the server keeps an upload for 30 minutes and an imported
 * audio file for 24 hours, then purges it. A project reopened later — or
 * simply edited for longer than that — would fail to render ("original video
 * not found") or render with its music silently missing. This asks the server
 * which of this project's files it no longer has and sends those back from
 * the saved copies, under the same names, so nothing in the project changes.
 */
export async function ensureServerHasProjectFiles(apiBase) {
  // Pictures are checked for every project, the demo included (a picture
  // placed on the demo video is the user's own file, and is purged like any
  // other); the video and audio only for a real upload, as before.
  const isRealUpload = !!appState.baseName && !appState.uploadedFile?.demo;
  const baseName = isRealUpload ? appState.baseName : null;
  const assetIds = isRealUpload ? (appState.audioTracks || []).map((t) => t?.assetId).filter(Boolean) : [];
  const imageAssetIds = [...new Set((appState.imageLayers || []).map((img) => img?.assetId).filter(Boolean))];
  if (!baseName && !imageAssetIds.length) return;
  let status;
  try {
    const res = await fetch(`${apiBase}/api/upload/session-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseName, assetIds, imageAssetIds })
    });
    if (!res.ok) return;
    status = await res.json();
  } catch {
    return;
  }

  if (baseName && status && status.videoPresent === false) {
    const blob = await getFile(videoKey(baseName));
    if (blob) {
      const form = new FormData();
      form.append('baseName', baseName);
      form.append('video', blob, appState.uploadedFile?.name || `${baseName}.mp4`);
      await fetch(`${apiBase}/api/upload/restore-video`, { method: 'POST', body: form }).catch(() => null);
    }
  }
  for (const assetId of (status?.missingAssets || [])) {
    const blob = await getFile(audioKey(assetId));
    if (!blob) continue;
    const form = new FormData();
    form.append('assetId', assetId);
    form.append('audio', blob, assetId);
    await fetch(`${apiBase}/api/upload/restore-audio`, { method: 'POST', body: form }).catch(() => null);
  }
  for (const assetId of (status?.missingImages || [])) {
    const blob = await getFile(imageKey(assetId));
    if (!blob) continue;
    const form = new FormData();
    form.append('assetId', assetId);
    form.append('image', blob, assetId);
    await fetch(`${apiBase}/api/upload/restore-image`, { method: 'POST', body: form }).catch(() => null);
  }
}
