/**
 * The sound-effect library — the panel behind the SFX lane's "+".
 *
 * It replaced a small popover anchored to that button. The popover was fine
 * for eleven sounds and stopped being fine at thirty-eight: it had nowhere to
 * put categories, no room to scroll, and it had to be `position: fixed` on
 * <body> to escape the timeline's own scroll container (see the note that
 * used to live on positionSoundPicker). A panel has room for all of that and
 * sits in a part of the window that was otherwise empty.
 *
 * Grouping comes from shared/soundRegistry.js's listSoundSections rather
 * than from anything here, so adding an asset to the registry adds it to this
 * panel — in the right section and group — with no change to this file.
 *
 * At four hundred sounds a scroll is no longer a way to find one, so there is
 * a search: it matches a sound's name, id, tags and description, which is
 * what lets "underline" find the pencil, pen and marker underlines at once.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listSoundSections } from '../../shared/soundRegistry.js';
import { previewSound } from '../js/components/audioEngine.js';
import * as audioTimeline from '../js/components/audioTimeline.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)]';
const SECTION_LABEL = 'text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-secondary)] px-1 pt-5 pb-0.5 border-b border-[var(--border-color)]';
const GROUP_LABEL = 'text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)] px-1 pt-3 pb-1';
const WORD_BADGE = 'shrink-0 text-[9px] uppercase tracking-[0.06em] text-[var(--text-muted)] border border-[var(--border-color)] rounded px-1';

/** Every search word must appear somewhere in the sound's name, id, tags or description. */
function matches(sound, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [sound.label, sound.id, sound.use, ...(sound.tags || [])].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
const ROW = `w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-transparent
  text-left cursor-pointer transition-colors duration-150
  hover:border-[var(--accent-color)] hover:bg-[rgba(0,246,172,0.06)]`;

export function SoundLibraryPanel({ onClose, replaceTargetId = null }) {
  const rootRef = useRef(null);
  const [query, setQuery] = useState('');
  const sections = useMemo(() => listSoundSections(), []);
  const visible = useMemo(() => sections
    .map((section) => ({
      ...section,
      groups: section.groups
        .map((group) => ({ ...group, sounds: group.sounds.filter((sound) => matches(sound, query)) }))
        .filter((group) => group.sounds.length > 0)
    }))
    .filter((section) => section.groups.length > 0), [sections, query]);
  // REPLACE MODE. Deliberately this same panel rather than a second surface:
  // "which sound do I want" is one question, and the answer already lives
  // here, grouped and scrollable and auditionable. A separate replace picker
  // would be the same list with a different verb, and would then have to be
  // kept in step with this one every time the library changed.
  const replacing = typeof replaceTargetId === 'string' && replaceTargetId;

  useEffect(() => {
    // Closing on an outside press is registered on POINTERDOWN, matching how
    // the popover this replaced behaved and how the rest of the app dismisses
    // transient surfaces. The SFX "+" is excluded by the panel's own opener,
    // which toggles — without that, pressing it while open would close the
    // panel here and immediately reopen it.
    const onPointerDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (e.target.closest?.('#timeline-add-sfx-btn')) return;
      onClose();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] shrink-0">
        <span className="text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
          {replacing ? 'Replace Sound' : 'Sound Effects'}
        </span>
        <button
          type="button"
          id="sound-library-close"
          onClick={onClose}
          aria-label="Close sound effects"
          className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4.5 h-4.5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* min-h-0 on both this and the flex parent is what actually makes the
          list scroll rather than stretch the panel past the viewport. */}
      <div className="px-3 pt-3 shrink-0">
        <input
          id="sound-library-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sounds — pop, whoosh, pencil, glitch…"
          aria-label="Search sounds"
          autoComplete="off"
          className="w-full h-8 px-2.5 text-[12px] bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-sm)]
            text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-color)]"
        />
      </div>
      <div id="sound-library-list" className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        <p className="text-[11px] text-[var(--text-muted)] m-0 pt-3">
          {replacing
            ? 'Swaps the sound on the selected effect. Its timing, volume and fades stay as they are.'
            : 'Plays at the playhead. ▶ auditions it without adding anything.'}
        </p>

        {visible.length === 0 && (
          <p id="sound-library-empty" className="text-[12px] text-[var(--text-muted)] m-0 pt-4">No sound matches “{query}”.</p>
        )}

        {visible.map((section) => (
          <div key={section.id} data-sound-section={section.id}>
            <div className={SECTION_LABEL}>{section.label}</div>
            {section.groups.map((group) => (
              <div key={group.id} data-sound-group={group.id}>
                <div className={GROUP_LABEL}>{group.label}</div>
                <div className={`${CARD} p-1 flex flex-col gap-0.5`}>
                  {group.sounds.map((sound) => (
                    <div key={sound.id} className={ROW} data-sound-id={sound.id} title={sound.use || sound.label}>
                      <button
                        type="button"
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full border border-[var(--border-color)]
                          text-[var(--text-secondary)] bg-transparent cursor-pointer
                          hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]"
                        aria-label={`Preview ${sound.label}`}
                        data-sound-preview={sound.id}
                        onClick={(e) => {
                          // The row itself adds the sound, so an audition must not
                          // also place one.
                          e.stopPropagation();
                          previewSound(sound.id, sound.defaultVolume);
                        }}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
                      </button>
                      <button
                        type="button"
                        data-sound-add={sound.id}
                        className="flex-1 min-w-0 text-left bg-transparent border-0 cursor-pointer p-0
                          text-[12px] text-[var(--text-primary)] truncate"
                        onClick={() => {
                          // Replace swaps the sound ON the existing clip rather
                          // than deleting and re-adding, which is what preserves
                          // its time, level, fades and provenance — and what keeps
                          // "I picked the wrong sound" from costing the placement.
                          if (replacing) audioTimeline.setSoundEventSound(replaceTargetId, sound.id);
                          else audioTimeline.addSoundEvent(sound.id);
                          onClose();
                        }}
                      >
                        {sound.label}
                      </button>
                      {/* Dry and tail-free: safe on consecutive words (see shared/soundPack.js). */}
                      {sound.usage === 'word' && (
                        <span className={WORD_BADGE} title="Short and dry — works repeated on consecutive words">word</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="px-4 py-3 border-t border-[var(--border-color)] shrink-0">
        <button
          type="button"
          id="sound-library-cancel"
          onClick={onClose}
          className="w-full h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)]
            font-bold text-xs rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150
            hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
