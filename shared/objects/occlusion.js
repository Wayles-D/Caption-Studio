/**
 * DYNAMIC OCCLUSION — letting a text, image or shape layer pass BEHIND a
 * tracked subject, without anyone animating a mask by hand.
 *
 *   track (V1.8) ─► segmentation (V2.0) ─► mask ─► THE SUBJECT IS A LAYER (V2.2)
 *
 * THE WHOLE IDEA IN ONE LINE: the subject takes its own place in the layer
 * stack. Everything beneath it is behind it; everything above it is in front.
 *
 * BHYND already cuts the stack into COMPOSITING RUNS (shared/visualLayers.js)
 * — neighbouring layers that composite the same way, drawn together onto one
 * surface, the same runs in the same order in the preview and the export. An
 * occlusion relationship adds ONE synthetic entry to that stack:
 *
 *   images                 ← drawn first
 *   WAHALA (text)          ← behind the subject
 *   ▓ the subject ▓        ← the video's own pixels, through its mask
 *   captions               ← in front
 *
 * so "put the word behind the person" is not a new renderer, a second mask
 * system or a compositing graph. It is a position in the one stack that
 * already exists, and both renderers already know how to walk it.
 *
 * WHAT THIS IS NOT: depth. A segmentation mask says which pixels are the
 * subject, not how far away anything is. Everything here is subject
 * membership — honest foreground/background compositing against one tracked
 * object. Nothing infers a 3D scene, and nothing here should claim to.
 *
 *   OcclusionRelation
 *   ├── id          'occ…'
 *   ├── trackKey    the subject it goes behind — a KEY into the project's
 *   │               tracks, never a copy (the same rule V1.9 effects follow)
 *   ├── layerIds    the visual layers it applies to (textElement / imageLayer /
 *   │               shapeLayer ids, or 'captions' — the ids the layer stack uses)
 *   ├── mode        'behind' | 'front'
 *   ├── start, end  its own span on the timeline
 *   ├── enabled
 *   └── feather     softening of the subject's edge, in reference pixels
 *
 * 'front' is what layers already do (every layer draws over the video), so it
 * is the explicit way to say "leave this one alone" when another relationship
 * would otherwise put it behind — and it is what a user reaches for to undo
 * the effect on one layer without deleting the relationship.
 *
 * NO MASK, NO CLAIM (the V2.1 rule, kept): wherever the segmentation has no
 * mask at a moment — before it starts, in a gap, while the subject is hidden
 * behind someone else — the subject pass draws NOTHING, so the affected layer
 * is simply visible, as it would be without the relationship at all. A stale
 * or unrelated mask is never composited, and a missing one never blanks a
 * layer.
 */

export const OCCLUSION_MODES = ['behind', 'front'];
export const OCCLUSION_MODE_LABELS = { behind: 'Behind the subject', front: 'In front of the subject' };
export const MIN_OCCLUSION_DURATION = 0.1;
/** The synthetic stack entry's type, and the id it carries per subject. */
export const SUBJECT_ENTRY_TYPE = 'subject';
export const subjectEntryId = (relationId) => `subject:${relationId}`;
/** Edge softening, in reference pixels (the canvas's shorter side = 1080). */
export const MAX_OCCLUSION_FEATHER = 20;
/**
 * How far the subject is GROWN before it hides a layer, in reference pixels.
 *
 * A mask is never perfect, and it errs small: fingers, hair and a thin arm
 * are the first things it misses. When the subject is slightly too small the
 * layer behind shows THROUGH them — the subject appears sliced, which is far
 * worse than the layer being hidden a hair too generously. So the subject is
 * grown a little by default: near-misses are covered by the person, not cut
 * out of them.
 */
export const MAX_OCCLUSION_GROW = 24;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);

let seq = 0;
function newId() {
  seq = (seq + 1) % 1e6;
  return `occ${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A stored or new relationship, made whole and in range — or null if it is not one. */
export function normalizeOcclusion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.trackKey !== 'string' || !raw.trackKey) return null;
  const layerIds = Array.isArray(raw.layerIds)
    ? [...new Set(raw.layerIds.filter((id) => typeof id === 'string' && id))]
    : [];
  if (!layerIds.length) return null;
  const start = Math.max(0, finite(raw.start, 0));
  const end = Math.max(start + MIN_OCCLUSION_DURATION, finite(raw.end, start + 3));
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    trackKey: raw.trackKey,
    layerIds,
    mode: OCCLUSION_MODES.includes(raw.mode) ? raw.mode : 'behind',
    label: typeof raw.label === 'string' ? raw.label.slice(0, 60) : '',
    start,
    end,
    enabled: raw.enabled !== false,
    feather: clamp(finite(raw.feather, 2), 0, MAX_OCCLUSION_FEATHER),
    grow: clamp(finite(raw.grow, 4), 0, MAX_OCCLUSION_GROW)
  };
}

/** A list — an array or its JSON string (the export's transport) — normalized; junk dropped. */
export function normalizeOcclusionList(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(list) ? list.map(normalizeOcclusion).filter(Boolean) : [];
}

export function createOcclusion({ trackKey, layerIds, mode = 'behind', label = '', start, end, feather, grow }) {
  return normalizeOcclusion({ trackKey, layerIds, mode, label, start, end, feather, grow });
}

/** Half-open, like every other timed thing: [start, end). */
export function isOcclusionActive(relation, time) {
  return !!relation && relation.enabled !== false && time >= relation.start && time < relation.end;
}

/**
 * The relationships in play at `time` — and, with `time` null, all of them
 * (what the EXPORT asks for: it cuts its compositing runs once for the whole
 * timeline, and each subject pass simply draws nothing outside its own span).
 *
 * A layer explicitly put IN FRONT of a subject is never behind it, whatever
 * another relationship says: saying "not this one" is more specific than
 * saying "these".
 *
 * @param {object[]} relations  normalized relationships
 * @param {number|null} time  the instant, or null for every relationship
 * @param {(trackKey:string) => boolean} hasSubject  whether that track is usable here
 *        (it exists, applies to this video, and has a segmentation)
 * @returns {{relation:object, layerIds:Set<string>}[]}
 */
export function occludedLayersAt(relations, time, hasSubject = () => true) {
  const all = (relations || []).filter((r) => r.enabled !== false && hasSubject(r.trackKey)
    && (time == null || isOcclusionActive(r, time)));
  // Everything a subject is explicitly told to stay behind.
  const frontOf = new Map();
  all.forEach((r) => {
    if (r.mode !== 'front') return;
    const set = frontOf.get(r.trackKey) || new Set();
    r.layerIds.forEach((id) => set.add(id));
    frontOf.set(r.trackKey, set);
  });
  const out = [];
  all.forEach((relation) => {
    if (relation.mode === 'front') return;
    const excluded = frontOf.get(relation.trackKey);
    const layerIds = new Set(relation.layerIds.filter((id) => !excluded?.has(id)));
    if (layerIds.size) out.push({ relation, layerIds });
  });
  return out;
}

/**
 * The layer stack with the SUBJECTS put in their places: ONE pass per
 * relationship, sitting directly above the topmost layer that relationship
 * puts behind it. Walking the stack then composites "layer, layer, subject,
 * layer" with no renderer needing to know what occlusion is.
 *
 * One pass PER RELATIONSHIP, not per subject, because relationships are
 * timed: with one layer behind a subject early on and a layer above it behind
 * the same subject later, a single shared pass would have to sit above both
 * and would hide the second one from the start. Each relationship's pass sits
 * where only its own layers are beneath it, and draws only during its own
 * span — so the preview (which inserts the active ones) and the export (which
 * inserts them all and leaves the rest blank) composite the same picture.
 *
 * @param {object[]} stack  resolveLayerStack's entries, bottom to top
 * @param {{relation:object, layerIds:Set<string>}[]} behind  occludedLayersAt's
 * @returns {object[]} the same entries, with { type:'subject', id, trackKey, relationId } inserted
 */
export function stackWithSubjects(stack, behind) {
  if (!behind?.length) return stack;
  const after = new Map();
  behind.forEach(({ relation, layerIds }) => {
    let last = -1;
    stack.forEach((entry, i) => { if (layerIds.has(entry.id)) last = i; });
    if (last < 0) return;
    const list = after.get(last) || [];
    list.push(relation);
    after.set(last, list);
  });
  if (!after.size) return stack;
  const out = [];
  stack.forEach((entry, i) => {
    out.push(entry);
    (after.get(i) || []).forEach((relation) => {
      out.push({ type: SUBJECT_ENTRY_TYPE, id: subjectEntryId(relation.id), trackKey: relation.trackKey, relationId: relation.id, item: null });
    });
  });
  return out;
}

/** Every instant a relationship switches on or off — the renderers' cut points. */
export function occlusionBoundaryTimes(relations) {
  const times = new Set();
  (relations || []).forEach((r) => { times.add(r.start); times.add(r.end); });
  return [...times].sort((a, b) => a - b);
}

/** The tracks any enabled relationship needs a mask for. */
export function occlusionTrackKeys(relations) {
  return [...new Set((relations || []).filter((r) => r.enabled !== false && r.mode !== 'front').map((r) => r.trackKey))];
}

/** Relationships that still point at something — the rest are kept but inert (see the editor's unlinked state). */
export function prunedOcclusions(relations, layerExists) {
  return (relations || []).map((r) => ({ ...r, layerIds: r.layerIds.filter((id) => layerExists(id)) })).filter((r) => r.layerIds.length);
}
