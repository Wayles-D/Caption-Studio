/**
 * Audio timeline state — Zustand store, deliberately separate from
 * editorStore.js and transformStore.js for the same organizational reason
 * those two are split from each other: sound effects and audio tracks are
 * their own concern, not a caption style.
 *
 * Like the other two stores this one is intentionally "dumb" — no actions, no
 * computed values. src/js/components/audioTimeline.js owns every mutation
 * (add/move/trim/delete/toggle), routed through src/js/state.js's updateState
 * so audio edits participate in the SAME undo/redo history and the same
 * subscribe('*') notification every other editor edit already does.
 *
 * Undo/redo: these keys are snapshotted (see src/js/state.js's
 * UNDO_TRACKED_KEYS) but are deliberately NOT part of `initialStyleState`, so
 * the toolbar's "Reset" — which resets caption STYLING — never silently
 * deletes the user's placed sound effects and imported music.
 */
import { create } from 'zustand';
import { DEFAULT_SOUND_PROFILE_ID } from '../../shared/soundProfiles.js';

export const AUDIO_DEFAULTS = {
  // Short punctuating effects — see shared/audioTimeline.js's createSoundEvent.
  soundEvents: [],
  // Long-form imported media (music/ambience/voiceover) — createAudioTrack.
  audioTracks: [],

  // The SOURCE VIDEO's own soundtrack. It is the third voice in the mix and
  // the level everything else is judged against, so it is mixable like any
  // other clip rather than a fixed constant at unity. 1 = untouched; above 1
  // boosts (see audioEngine.js, which routes the element through a gain node
  // only when a boost is actually asked for).
  videoVolume: 1,
  videoMuted: false,

  // Which sound profile maps semantic events to sounds, plus the user's own
  // per-event-type overrides on top of it (see shared/soundProfiles.js's
  // resolveSoundMapping). Kept as state rather than a constant so sound
  // presets can be switched without re-running the transcript analysis.
  soundProfileId: DEFAULT_SOUND_PROFILE_ID,
  soundEventMapping: {},

  // The global "Auto Sound Effects" switch. When off, transcript analysis
  // still runs and its semantic events are still stored below (so the
  // suggestions remain browsable and the user can place them by hand) — only
  // the AUTOMATIC placement of effects is suppressed.
  autoSoundEffects: true,

  // What the content analysis reported about the speech, verbatim: semantic
  // moments with timestamps already resolved from the transcript's own word
  // timings (see backend/services/keywordAnalysisService.js). This is the
  // durable record the sound mapping is re-derived from, so changing profile
  // or re-enabling auto effects never needs another model call.
  semanticEvents: [],
  // Keys of AI-suggested moments the creator deleted. Tombstones, so a
  // re-analysis cannot resurrect a sound they deliberately removed.
  dismissedEventKeys: [],

  // Moments the analysis thinks would carry a visual, for the user to fill
  // themselves. Deliberately NOT auto-populated with anything — see the
  // feature's own "the creator must remain in control" rule.
  visualSuggestions: [],

  // Editor-only selection (which clip the timeline has highlighted). Not
  // undo-tracked and never exported — a selection is not a document edit.
  selectedAudioClipId: null
};

/** The subset that is part of the project document (and therefore undo-tracked + exported). */
export const AUDIO_DOCUMENT_KEYS = [
  'soundEvents',
  'audioTracks',
  'videoVolume',
  'videoMuted',
  'soundProfileId',
  'soundEventMapping',
  'autoSoundEffects',
  'semanticEvents',
  'dismissedEventKeys',
  'visualSuggestions'
];

export const useAudioStore = create(() => ({ ...AUDIO_DEFAULTS }));
