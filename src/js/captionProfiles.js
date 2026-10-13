/**
 * Caption profiles: a named font pairing — the caption's own font and weight
 * plus the keyword font and weight — saved on this device and applied in one
 * click. A profile only writes the style settings the renderer already reads
 * (fontFamily, fontWeight, keywordFont, keywordWeight), so a profile looks the
 * same in the preview and in the export.
 *
 * Stored in localStorage as a small JSON list. Every read/write is wrapped:
 * storage can be blocked or full, and the app must work without it.
 */
const KEY = 'bhynd.captionProfiles.v1';
const listeners = new Set();

/** The state keys a profile carries. A null weight/keyword font means "preset default". */
export const PROFILE_FIELDS = ['fontFamily', 'fontWeight', 'keywordFont', 'keywordWeight'];

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && p.id && p.name) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: keep in memory only */ }
  cache = list;
  listeners.forEach((fn) => fn());
}

let cache = null;

export function listProfiles() {
  if (!cache) cache = read();
  return cache;
}

export function subscribeProfiles(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The profile's style as a state patch (every field present, null = default). */
export function profilePatch(profile) {
  return Object.fromEntries(PROFILE_FIELDS.map((k) => [k, profile[k] ?? null]));
}

/** Saves a profile; a name already in use replaces that profile. Returns it. */
export function saveProfile({ name, ...fields }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const list = listProfiles().slice();
  const existing = list.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
  const profile = {
    id: existing >= 0 ? list[existing].id : `prof_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    ...Object.fromEntries(PROFILE_FIELDS.map((k) => [k, fields[k] || null]))
  };
  if (existing >= 0) list[existing] = profile; else list.push(profile);
  write(list);
  return profile;
}

export function deleteProfile(id) {
  write(listProfiles().filter((p) => p.id !== id));
}
