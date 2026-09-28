/**
 * Manually-authored timed text — the store behind manual caption events and
 * text overlays (see shared/textElement.js for the record shape).
 *
 * Its own store rather than a corner of editorStore, for the same reason
 * audioStore is separate: anything living in STYLE_DEFAULTS/TRANSFORM_DEFAULTS
 * is part of `initialStyleState` and is therefore wiped by the toolbar's
 * "Reset Style". Text the user wrote and placed is CONTENT, not styling —
 * resetting the caption look must not delete it. SESSION_DEFAULTS would be
 * wrong for the opposite reason: it isn't undo-tracked.
 *
 * Like the other stores this is intentionally "dumb" — no actions, no
 * computed values. src/js/components/textElements.js is the one module that
 * mutates it, and src/js/state.js decides what a change means.
 */
import { create } from 'zustand';

export const TEXT_ELEMENT_DEFAULTS = {
  // Both kinds live in ONE list, discriminated by `kind` — they differ in
  // what they represent and how they're timed, not in what they can look
  // like, so they share one CRUD/render/export path.
  textElements: [],

  // Editor-only selection (which clip the timeline has highlighted). Not
  // undo-tracked and never exported — a selection is not a document edit,
  // and undoing onto a stale selection would be surprising.
  selectedTextElementId: null,

  // THE TRANSCRIPT'S OWN CAPTIONS, once they stop being derived (see
  // shared/captionEvent.js). The grouper still produces the first version,
  // but from then on this list is authoritative and the user owns it —
  // retiming, splitting and merging a caption are edits to THIS, not
  // attempts to coax a different result out of the grouper.
  //
  // Lives beside the manual text for the same two reasons: it is content
  // rather than styling (so "Reset Style" must not wipe it) and it has to be
  // undo-tracked (so SESSION_DEFAULTS would be wrong).
  captionEvents: [],

  // Which caption clip the timeline has highlighted. Editor-only, like
  // selectedTextElementId above.
  selectedCaptionEventId: null
};

/** The subset that is part of the project document (undo-tracked + exported). */
export const TEXT_ELEMENT_DOCUMENT_KEYS = ['textElements', 'captionEvents'];

export const useTextElementStore = create(() => ({ ...TEXT_ELEMENT_DEFAULTS }));
