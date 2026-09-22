/**
 * Audio Inspector — the panel behind the bottom toolbar's "Audio" tool.
 *
 * The timeline lanes are for DIRECT MANIPULATION (place, drag, trim, delete);
 * this panel is for everything that needs a value rather than a gesture —
 * volume, fades, which sound, which sounds a kind of moment maps to, and the
 * Auto Sound Effects switch. Selecting a clip on the timeline highlights it
 * here and vice versa, because both surfaces read the same
 * `selectedAudioClipId`; they are two views of one state, not two features.
 *
 * Written as an ordinary React component reading useAudioStore directly
 * (unlike SidebarInspector.jsx, which wraps pre-existing imperative DOM
 * wiring): there is no legacy implementation here to preserve, and every
 * control is a plain value edit with no drag loop or canvas measurement
 * involved — exactly the case where controlled React state is the simpler
 * choice rather than the riskier one.
 */
import { useState } from 'react';
import { useAudioStore } from '../store/audioStore.js';
import { useEditorStore } from '../store/editorStore.js';
import * as audio from '../js/components/audioTimeline.js';
import { previewSound, previewAudioTrack } from '../js/components/audioEngine.js';
import { promptForAudioFile } from '../js/components/audioImport.js';
import { listSounds, getSoundDefinition } from '../../shared/soundRegistry.js';
import {
  listSoundProfiles,
  SEMANTIC_EVENT_TYPES,
  SEMANTIC_EVENT_LABELS,
  resolveSoundMapping
} from '../../shared/soundProfiles.js';
import { getAudioTrackDuration } from '../../shared/audioTimeline.js';
import { ToggleSwitch } from './ToggleSwitch.jsx';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const SELECT = `h-8 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
// --bg-input is the same colour as the card these sit on, which renders the
// track invisible — only the thumb would show. --border-color-hover keeps it
// subtle while still reading as a track.
const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--border-color-hover)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:cursor-pointer`;
const ICON_BTN = `flex items-center justify-center w-6 h-6 shrink-0 rounded-md border border-[var(--border-color)]
  bg-transparent text-[var(--text-secondary)] cursor-pointer hover:text-[var(--accent-color)] hover:border-[var(--accent-color)]`;
const PRIMARY_BTN = `h-9 bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-default`;
const SECONDARY_BTN = `h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]`;

function formatSeconds(t) {
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

const PlayIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
);
const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
  </svg>
);

/** One row of the Sound Effects list. */
function SoundEventRow({ event, isSelected }) {
  const definition = getSoundDefinition(event.soundId);
  return (
    <div
      className={`flex flex-col gap-2 p-2.5 rounded-[var(--radius-sm)] border bg-[var(--bg-input)] cursor-pointer
        ${isSelected ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}
        ${event.enabled ? '' : 'opacity-50'}`}
      onClick={() => audio.selectClip(event.id)}
    >
      <div className="flex items-center gap-2">
        <button
          type="button" className={ICON_BTN} title={`Preview ${definition.label}`}
          onClick={(e) => { e.stopPropagation(); previewSound(event.soundId, event.volume); }}
        ><PlayIcon /></button>

        {/* Changing which sound an effect plays — one of the user-control
            requirements an automatically-placed effect must not remove. */}
        <select
          className={`${SELECT} flex-1 min-w-0`}
          value={event.soundId}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => audio.setSoundEventSound(event.id, e.target.value)}
        >
          {listSounds().map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>

        <input
          type="number" step="0.01" min="0"
          className={`${SELECT} w-[72px] text-right`}
          value={event.startTime.toFixed(2)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const value = parseFloat(e.target.value);
            if (Number.isFinite(value)) audio.moveSoundEvent(event.id, value);
          }}
          title="Start time (seconds)"
        />

        <ToggleSwitch
          id={`sfx-enabled-${event.id}`}
          defaultChecked={event.enabled}
          title={event.enabled ? 'Disable this effect' : 'Enable this effect'}
          onChange={(e) => audio.setSoundEventEnabled(event.id, e.target.checked)}
        />

        <button
          type="button" className={ICON_BTN} title="Delete this effect"
          onClick={(e) => { e.stopPropagation(); audio.removeSoundEvent(event.id); }}
        ><TrashIcon /></button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] w-12 shrink-0">Volume</span>
        <input
          type="range" min="0" max="200" step="1" className={SLIDER}
          value={Math.round(event.volume * 100)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => audio.updateSoundEvent(event.id, { volume: Number(e.target.value) / 100 }, { recordHistory: false })}
          onPointerUp={(e) => audio.updateSoundEvent(event.id, { volume: Number(e.target.value) / 100 })}
        />
        <span className="text-[10px] font-semibold text-[var(--text-secondary)] w-9 text-right shrink-0">
          {Math.round(event.volume * 100)}%
        </span>
      </div>

      {/* Provenance, shown only when there is something to say: which spoken
          moment this effect came from. An automatically-placed effect the user
          has edited still shows it — it is information about where the effect
          came from, not a claim about who owns it now. */}
      {event.source === 'ai' && event.eventType && (
        <span className="text-[10px] text-[var(--text-muted)]">
          Auto · {SEMANTIC_EVENT_LABELS[event.eventType] || event.eventType}
        </span>
      )}
    </div>
  );
}

/** One row of the Audio Tracks list. */
function AudioTrackRow({ track, isSelected }) {
  const duration = getAudioTrackDuration(track);
  return (
    <div
      className={`flex flex-col gap-2 p-2.5 rounded-[var(--radius-sm)] border bg-[var(--bg-input)] cursor-pointer
        ${isSelected ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}
        ${track.enabled ? '' : 'opacity-50'}`}
      onClick={() => audio.selectClip(track.id)}
    >
      <div className="flex items-center gap-2">
        <button
          type="button" className={ICON_BTN} title="Preview this track"
          onClick={(e) => { e.stopPropagation(); previewAudioTrack(track); }}
        ><PlayIcon /></button>
        <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-[var(--text-primary)]" title={track.name}>
          {track.name}
        </span>
        <ToggleSwitch
          id={`track-enabled-${track.id}`}
          defaultChecked={track.enabled}
          title={track.enabled ? 'Mute this track' : 'Unmute this track'}
          onChange={(e) => audio.setAudioTrackEnabled(track.id, e.target.checked)}
        />
        <button
          type="button" className={ICON_BTN} title="Remove this track"
          onClick={(e) => { e.stopPropagation(); audio.removeAudioTrack(track.id); }}
        ><TrashIcon /></button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold text-[var(--text-muted)] w-12 shrink-0">Volume</span>
        <input
          type="range" min="0" max="200" step="1" className={SLIDER}
          value={Math.round(track.volume * 100)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => audio.updateAudioTrack(track.id, { volume: Number(e.target.value) / 100 }, { recordHistory: false })}
          onPointerUp={(e) => audio.updateAudioTrack(track.id, { volume: Number(e.target.value) / 100 })}
        />
        <span className="text-[10px] font-semibold text-[var(--text-secondary)] w-9 text-right shrink-0">
          {Math.round(track.volume * 100)}%
        </span>
      </div>

      {/* Numeric trim, alongside the timeline's own drag handles. Typing an
          exact in/out point is the thing a drag genuinely cannot do. */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Start', value: track.startTime, apply: (v) => audio.moveAudioTrack(track.id, v), title: 'Where the clip begins on the timeline' },
          { label: 'Trim in', value: track.trimStart, apply: (v) => audio.updateAudioTrack(track.id, { trimStart: v }), title: 'How far into the file playback begins' },
          {
            label: 'Trim out',
            value: track.trimEnd ?? track.sourceDuration ?? 0,
            apply: (v) => audio.updateAudioTrack(track.id, { trimEnd: v }),
            title: 'Where in the file playback stops'
          }
        ].map((field) => (
          <label key={field.label} className="flex flex-col gap-1" title={field.title}>
            <span className="text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--text-muted)]">{field.label}</span>
            <input
              type="number" step="0.01" min="0" className={`${SELECT} w-full`}
              value={Number(field.value ?? 0).toFixed(2)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                if (Number.isFinite(value)) field.apply(value);
              }}
            />
          </label>
        ))}
      </div>

      <span className="text-[10px] text-[var(--text-muted)]">
        {formatSeconds(track.startTime)} → {duration != null ? formatSeconds(track.startTime + duration) : '—'}
      </span>
    </div>
  );
}

export function AudioInspector({ onNotify }) {
  const soundEvents = useAudioStore((s) => s.soundEvents);
  const audioTracks = useAudioStore((s) => s.audioTracks);
  const autoSoundEffects = useAudioStore((s) => s.autoSoundEffects);
  const soundProfileId = useAudioStore((s) => s.soundProfileId);
  const soundEventMapping = useAudioStore((s) => s.soundEventMapping);
  const semanticEvents = useAudioStore((s) => s.semanticEvents);
  const visualSuggestions = useAudioStore((s) => s.visualSuggestions);
  const selectedId = useAudioStore((s) => s.selectedAudioClipId);
  const videoVolume = useAudioStore((s) => s.videoVolume);
  const videoMuted = useAudioStore((s) => s.videoMuted);
  const words = useEditorStore((s) => s.words);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const mapping = resolveSoundMapping(soundProfileId, soundEventMapping);

  /**
   * Re-runs the transcript analysis on demand — the same single pass the
   * upload pipeline runs, so a project whose analysis never ran (or failed)
   * can get automatic effects without re-uploading the video.
   */
  const analyzeTranscript = async () => {
    if (!words?.length) {
      onNotify?.('Upload a video first — the analysis reads the transcript.');
      return;
    }
    setIsAnalyzing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/upload/analyze-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);

      const placed = audio.applySemanticEvents(data.contentEvents || []);
      onNotify?.(data.contentEvents?.length
        ? `Found ${data.contentEvents.length} moment${data.contentEvents.length === 1 ? '' : 's'} — placed ${placed.length} sound effect${placed.length === 1 ? '' : 's'}.`
        : 'No clear structural moments found in this transcript.');
    } catch (err) {
      console.error('[AudioInspector] Content analysis failed:', err);
      onNotify?.(`Transcript analysis failed: ${err.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* --- The video's own soundtrack ---
          First, because it is the level every other clip is balanced against.
          Same 0-200% control as a sound effect or an imported track, so
          "volume" means one thing everywhere in the editor. */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Video Volume</span>
          <ToggleSwitch
            id="video-audio-muted"
            defaultChecked={!videoMuted}
            title={videoMuted ? 'Unmute the video' : 'Mute the video'}
            onChange={(e) => audio.setVideoMuted(!e.target.checked)}
          />
        </div>
        <p className={HINT}>The original audio from your video. Applies to both the preview and the exported file.</p>
        <div className="flex items-center gap-2">
          <input
            type="range" min="0" max="200" step="1" className={SLIDER}
            disabled={videoMuted}
            value={Math.round(videoVolume * 100)}
            onChange={(e) => audio.setVideoVolume(Number(e.target.value) / 100, { recordHistory: false })}
            onPointerUp={(e) => audio.setVideoVolume(Number(e.target.value) / 100)}
          />
          <span className="text-[10px] font-semibold text-[var(--text-secondary)] w-9 text-right shrink-0">
            {videoMuted ? 'Muted' : `${Math.round(videoVolume * 100)}%`}
          </span>
        </div>
      </div>

      {/* --- Automatic sound effects --- */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Auto Sound Effects</span>
          <ToggleSwitch
            id="auto-sound-effects"
            defaultChecked={autoSoundEffects}
            title="Place sound effects automatically from the transcript"
            onChange={(e) => audio.setAutoSoundEffects(e.target.checked)}
          />
        </div>
        <p className={HINT}>
          Reads the transcript — never the video — for moments like list items and reveals,
          then places an effect at each one. Turning this off keeps the analysis; it only
          stops effects being placed for you.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]">Sound profile</span>
          <select className={SELECT} value={soundProfileId} onChange={(e) => audio.setSoundProfile(e.target.value)}>
            {listSoundProfiles().map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={PRIMARY_BTN} disabled={isAnalyzing} onClick={analyzeTranscript}>
            {isAnalyzing ? 'Analyzing…' : 'Analyze transcript'}
          </button>
          <button
            type="button" className={SECONDARY_BTN}
            disabled={!semanticEvents.length}
            onClick={() => {
              const placed = audio.regenerateAutoSoundEffects();
              onNotify?.(`Re-placed ${placed.length} automatic effect${placed.length === 1 ? '' : 's'}.`);
            }}
          >
            Re-apply
          </button>
        </div>

        {semanticEvents.length > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            {semanticEvents.length} moment{semanticEvents.length === 1 ? '' : 's'} identified in the transcript.
          </span>
        )}
      </div>

      {/* --- Which sound each kind of moment means --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Sound for each moment</span>
        <p className={HINT}>
          The analysis says what is happening; you decide what it sounds like. Changing one
          of these re-places the automatic effects immediately.
        </p>
        <div className="flex flex-col gap-1.5">
          {SEMANTIC_EVENT_TYPES.map((type) => (
            <div key={type} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-primary)]">
                {SEMANTIC_EVENT_LABELS[type]}
              </span>
              <select
                className={`${SELECT} w-[120px]`}
                value={mapping[type] ?? ''}
                onChange={(e) => audio.setEventTypeSound(type, e.target.value || null)}
              >
                <option value="">No sound</option>
                {listSounds().map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* --- Sound effects --- */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Sound Effects</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{soundEvents.length}</span>
        </div>
        {soundEvents.length === 0
          ? <p className={HINT}>None yet. Use the <strong>+</strong> on the timeline’s SFX strip to place one at the playhead.</p>
          : (
            <div className="flex flex-col gap-2">
              {soundEvents.map((event) => (
                <SoundEventRow key={event.id} event={event} isSelected={event.id === selectedId} />
              ))}
            </div>
          )}
      </div>

      {/* --- Audio tracks --- */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Audio Tracks</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{audioTracks.length}</span>
        </div>
        {audioTracks.length === 0 && (
          <p className={HINT}>Background music, ambience or a voiceover. Import a file to lay one under the video.</p>
        )}
        {audioTracks.length > 0 && (
          <div className="flex flex-col gap-2">
            {audioTracks.map((track) => (
              <AudioTrackRow key={track.id} track={track} isSelected={track.id === selectedId} />
            ))}
          </div>
        )}
        <button
          type="button" className={SECONDARY_BTN}
          onClick={() => promptForAudioFile(
            (track) => onNotify?.(`Added "${track.name}" to the timeline.`),
            (err) => onNotify?.(`Audio import failed: ${err.message}`)
          )}
        >
          Import audio file
        </button>
      </div>

      {/* --- Visual slots --- */}
      {visualSuggestions.length > 0 && (
        <div className={CARD}>
          <span className={SECTION_TITLE}>Suggested visual moments</span>
          <p className={HINT}>
            Points in the speech where an image would land well. Nothing is placed for you —
            these are slots for you to fill.
          </p>
          <div className="flex flex-col gap-1.5">
            {visualSuggestions.map((suggestion, i) => (
              <div key={`${suggestion.type}-${suggestion.timestamp}-${i}`} className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  className="text-[var(--accent-color)] font-semibold bg-transparent border-0 cursor-pointer p-0"
                  title="Jump to this moment"
                  onClick={() => {
                    const video = document.getElementById('preview-video');
                    if (video) video.currentTime = suggestion.timestamp;
                  }}
                >
                  {formatSeconds(suggestion.timestamp)}
                </button>
                <span className="flex-1 min-w-0 truncate text-[var(--text-secondary)]">
                  {SEMANTIC_EVENT_LABELS[suggestion.type] || suggestion.type}
                  {suggestion.index ? ` ${suggestion.index}` : ''}
                  {suggestion.word ? ` — “${suggestion.word}”` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
