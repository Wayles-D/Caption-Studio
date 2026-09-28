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
 * Grouping comes from shared/soundRegistry.js's listSoundsByCategory rather
 * than from anything here, so adding an asset to the registry adds it to this
 * panel — in the right group — with no change to this file.
 */
import { useEffect, useRef } from 'react';
import { listSoundsByCategory } from '../../shared/soundRegistry.js';
import { previewSound } from '../js/components/audioEngine.js';
import * as audioTimeline from '../js/components/audioTimeline.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)]';
const GROUP_LABEL = 'text-[10px] font-bold uppercase tracking-[0.06em] text-[var(--text-muted)] px-1 pt-3 pb-1';
const ROW = `w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-transparent
  text-left cursor-pointer transition-colors duration-150
  hover:border-[var(--accent-color)] hover:bg-[rgba(0,246,172,0.06)]`;

export function SoundLibraryPanel({ onClose }) {
  const rootRef = useRef(null);
  const groups = listSoundsByCategory();

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
          Sound Effects
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
      <div id="sound-library-list" className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        <p className="text-[11px] text-[var(--text-muted)] m-0 pt-3">
          Plays at the playhead. ▶ auditions it without adding anything.
        </p>

        {groups.map((group) => (
          <div key={group.id} data-sound-group={group.id}>
            <div className={GROUP_LABEL}>{group.label}</div>
            <div className={`${CARD} p-1 flex flex-col gap-0.5`}>
              {group.sounds.map((sound) => (
                <div key={sound.id} className={ROW} data-sound-id={sound.id}>
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
                      audioTimeline.addSoundEvent(sound.id);
                      onClose();
                    }}
                  >
                    {sound.label}
                  </button>
                </div>
              ))}
            </div>
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
