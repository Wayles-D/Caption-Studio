/**
 * Caption profiles panel: save the current font pairing (caption font + weight,
 * keyword font + weight) under a name, then apply it in one click. Hovering a
 * profile previews it on the video; clicking applies it as one undo step.
 * See src/js/captionProfiles.js.
 */
import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore.js';
import { updateState } from '../js/state.js';
import { previewState, endPreview } from '../js/hoverPreview.js';
import { listProfiles, subscribeProfiles, saveProfile, deleteProfile, profilePatch } from '../js/captionProfiles.js';

const describe = (font, weight) => `${font || 'Preset font'}${weight ? ` ${weight}` : ''}`;

export function CaptionProfiles() {
  const [profiles, setProfiles] = useState(listProfiles);
  const [name, setName] = useState('');
  const fontFamily = useEditorStore((s) => s.fontFamily);
  const fontWeight = useEditorStore((s) => s.fontWeight);
  const keywordFont = useEditorStore((s) => s.keywordFont);
  const keywordWeight = useEditorStore((s) => s.keywordWeight);

  useEffect(() => subscribeProfiles(() => setProfiles(listProfiles().slice())), []);

  const save = () => {
    if (!saveProfile({ name, fontFamily, fontWeight, keywordFont, keywordWeight })) return;
    setName('');
  };

  return (
    <div className="flex flex-col gap-2" id="caption-profiles">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--text-secondary)]">Profiles</span>
      {profiles.length === 0 && (
        <p className="m-0 text-[11px] text-[var(--text-muted)]">
          Set a caption font and a keyword font, then save the pair as a profile to reuse it.
        </p>
      )}
      {profiles.map((p) => (
        <div
          key={p.id}
          className="caption-profile-row flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-input)]"
          data-profile={p.name}
          onPointerEnter={() => previewState(profilePatch(p))}
          onPointerLeave={() => endPreview()}
        >
          <button
            type="button"
            className="flex-1 min-w-0 text-left px-2.5 py-1.5 bg-transparent border-0 cursor-pointer text-[var(--text-primary)]"
            onClick={() => { endPreview(); updateState(profilePatch(p)); }}
          >
            <div className="text-[12px] font-bold truncate">{p.name}</div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">
              {describe(p.fontFamily, p.fontWeight)} · {describe(p.keywordFont, p.keywordWeight)}
            </div>
          </button>
          <button
            type="button"
            aria-label={`Delete profile ${p.name}`}
            className="px-2 py-1 bg-transparent border-0 cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => { endPreview(); deleteProfile(p.id); }}
          >×</button>
        </div>
      ))}
      <div className="flex gap-1.5">
        <input
          id="caption-profile-name"
          value={name}
          maxLength={40}
          placeholder="Profile name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          className="flex-1 min-w-0 h-9 px-2.5 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[13px] text-[var(--text-primary)]"
        />
        <button
          type="button"
          id="caption-profile-save"
          disabled={!name.trim()}
          onClick={save}
          className="px-3 h-9 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-[var(--bg-card)] text-[12px] font-bold text-[var(--text-primary)] cursor-pointer disabled:opacity-40 disabled:cursor-default"
        >Save</button>
      </div>
    </div>
  );
}
