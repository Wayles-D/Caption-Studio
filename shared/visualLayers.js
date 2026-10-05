/**
 * THE VISUAL LAYER STACK — one order for everything composited over the
 * video, bottom to top, shared by the preview, the exporter and the editor.
 *
 *   video                  the base surface, always at the bottom (not an entry)
 *   ...entries             every text element, image layer and shape layer by
 *                          its id, and the transcript's captions as ONE entry
 *                          ('captions')
 *
 * This module answers only "what is there, and in what order?". How each
 * object draws itself stays with the object (shared/textElement.js +
 * captionGraphics.js, shared/imageLayer.js, shared/shapeLayer.js); how it
 * moves stays with the motion engine (shared/motion).
 *
 * STORAGE. The order is the project's `layerOrder` — a list of ids — and it
 * is only written once the user reorders something. Until then (every V1.3
 * project, and every project nobody has restacked) the order is DERIVED by
 * defaultLayerOrder, which reproduces exactly how V1.3 stacked things, so an
 * existing project looks the same. Once written, ids it does not know yet
 * (anything added later) go on top, and ids of objects that no longer exist
 * are ignored.
 *
 * WHY THE CAPTIONS ARE ONE ENTRY. The transcript's captions are one object
 * on screen (one caption at a time, in one caption mode — sentence, word or
 * Rolling Stack — with one blend mode against what is beneath them), drawn by
 * their own pipeline. Moving "the captions" above or below a picture is the
 * meaningful choice; ordering individual transcript captions is not.
 */
export const CAPTIONS_LAYER_ID = 'captions';

const textEntry = (item) => ({ type: 'text', id: item.id, item });
const imageEntry = (item) => ({ type: 'image', id: item.id, item });
const shapeEntry = (item) => ({ type: 'shape', id: item.id, item });
const CAPTIONS_ENTRY = Object.freeze({ type: 'captions', id: CAPTIONS_LAYER_ID, item: null });

/**
 * The V1.3 order, bottom to top:
 *   images placed 'under-captions'   (list order)
 *   the transcript's captions
 *   manual captions                  (list order)
 *   images placed 'under-text'       (list order)
 *   cinematic cards                  (by start, then id — the latest-starting
 *                                     on top, the card V1.3 showed)
 *   overlays                         (list order)
 *   images placed 'over-text'        (list order)
 *   shapes                           (list order — new in V1.4, on top)
 */
export function defaultLayerOrder({ textElements = [], imageLayers = [], shapeLayers = [] } = {}) {
  const imagesAt = (placement) => imageLayers.filter((img) => (img.layer || 'under-captions') === placement).map(imageEntry);
  const cards = textElements.filter((el) => el.kind === 'interlude')
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    ...imagesAt('under-captions'),
    CAPTIONS_ENTRY,
    ...textElements.filter((el) => el.kind === 'caption').map(textEntry),
    ...imagesAt('under-text'),
    ...cards.map(textEntry),
    ...textElements.filter((el) => el.kind !== 'caption' && el.kind !== 'interlude').map(textEntry),
    ...imagesAt('over-text'),
    ...shapeLayers.map(shapeEntry)
  ];
}

/**
 * The project's stack, bottom to top, as entries { type, id, item } — the
 * stored `layerOrder` reconciled with what exists (see the module comment),
 * or the derived default order when there is none.
 */
export function resolveLayerStack({ layerOrder, textElements = [], imageLayers = [], shapeLayers = [] } = {}) {
  const defaults = defaultLayerOrder({ textElements, imageLayers, shapeLayers });
  if (!Array.isArray(layerOrder) || !layerOrder.length) return defaults;
  const byId = new Map(defaults.map((entry) => [entry.id, entry]));
  const seen = new Set();
  const ordered = [];
  layerOrder.forEach((id) => {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) { ordered.push(entry); seen.add(id); }
  });
  // Anything the stored order does not know yet goes on top, in default order.
  defaults.forEach((entry) => { if (!seen.has(entry.id)) ordered.push(entry); });
  return ordered;
}

/** The stored form of a stack: its ids, bottom to top. */
export function layerOrderOf(stack) {
  return stack.map((entry) => entry.id);
}

/**
 * Restacks one entry: 'forward' / 'backward' one place, or to the 'front' /
 * 'back'. Returns the new id list (bottom to top), or null if nothing moved.
 * Works the same for every kind of entry — a picture can go above the
 * captions, a shape beneath a card.
 */
export function moveInLayerOrder(stack, id, direction) {
  const ids = layerOrderOf(stack);
  const from = ids.indexOf(id);
  if (from === -1) return null;
  const to = direction === 'front' ? ids.length - 1
    : direction === 'back' ? 0
      : direction === 'forward' ? Math.min(ids.length - 1, from + 1)
        : Math.max(0, from - 1);
  if (to === from) return null;
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/**
 * How an entry composites onto what is beneath it. A manual caption is meant
 * to look exactly like the transcript's captions, so it takes their blend
 * mode; everything else is a plain alpha-over. The transcript's captions are
 * their own class — they have their own render pipeline.
 */
function compositeClass(entry) {
  if (entry.type === 'captions') return 'captions';
  if (entry.type === 'text' && entry.item?.kind === 'caption') return 'caption-blend';
  return 'plain';
}

/**
 * The stack cut into COMPOSITING RUNS, bottom to top: neighbouring entries
 * that composite the same way are drawn together onto one surface (one
 * preview canvas, one export layer); a run boundary is wherever the way of
 * compositing changes. The preview and the exporter both draw exactly these
 * runs, in this order.
 *
 * @returns {{ index:number, kind:'captions'|'caption-blend'|'plain', entries:object[], beneathCaptions:boolean }[]}
 */
export function layerRuns(stack) {
  const runs = [];
  let passedCaptions = false;
  stack.forEach((entry) => {
    const kind = compositeClass(entry);
    const last = runs[runs.length - 1];
    if (kind !== 'captions' && last && last.kind === kind) {
      last.entries.push(entry);
    } else {
      runs.push({ index: runs.length, kind, entries: [entry], beneathCaptions: !passedCaptions && kind !== 'captions' });
    }
    if (kind === 'captions') passedCaptions = true;
  });
  return runs;
}

/** Which entry types a run's entries are, for callers that draw per type. */
export function entriesOfType(run, type) {
  return run.entries.filter((entry) => entry.type === type).map((entry) => entry.item);
}
