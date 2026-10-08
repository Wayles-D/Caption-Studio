/**
 * RHYTHM, as the user sees it (src/js/components/rhythm.js): which audio the
 * rhythm is read from, what was found — tempo, beat count, how sure — and the
 * one beat-aware action V1.6 has: add something at the NEXT beat. Nothing
 * here edits automatically; it reports, and creates only when asked.
 */
import { useEffect, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as rhythm from '../js/components/rhythm.js';
import * as textElements from '../js/components/textElements.js';
import * as shapeLayers from '../js/components/shapeLayers.js';
import { promptForImageFile } from '../js/components/imageLayers.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const SELECT = `h-8 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const SMALL_BTN = `h-8 flex-1 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-[11px]
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;

function Stat({ label, value, id }) {
  return (
    <div className="flex flex-col items-center flex-1 bg-[var(--bg-input)] rounded-[var(--radius-sm)] py-2">
      <span id={id} className="text-[15px] font-bold text-[var(--text-primary)]">{value}</span>
      <span className="text-[10px] uppercase tracking-[0.05em] text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

export function RhythmCard() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);

  const info = rhythm.describeRhythm();
  const tracks = (appState.audioTracks || []).filter((t) => t.assetId);
  const choice = appState.rhythmSource || 'auto';
  const ready = info.state === 'ready';

  // "Add at next beat": the next beat after the playhead, never an edit of
  // anything already there.
  const nextBeatTime = () => {
    const t = document.getElementById('preview-video')?.currentTime ?? 0;
    return rhythm.nextBeatAfter(t)?.time ?? null;
  };
  const addAt = (make) => {
    const at = nextBeatTime();
    if (at == null) return;
    const video = document.getElementById('preview-video');
    if (video) video.currentTime = at;
    make(at);
  };

  return (
    <div className={CARD} id="rhythm-card">
      <span className={SECTION_TITLE}>Rhythm</span>
      <select
        id="rhythm-source"
        className={SELECT}
        value={choice}
        onChange={(e) => rhythm.setRhythmSource(e.target.value)}
        title="The audio the beats are read from"
      >
        <option value="auto">Auto — {tracks.length ? 'first audio track' : 'the video’s sound'}</option>
        <option value="video">The video’s own sound</option>
        {tracks.map((t) => <option key={t.id} value={t.id}>{t.name || 'Audio track'}</option>)}
      </select>

      <div id="rhythm-status" data-state={info.state} className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">{info.title}</span>
        {info.detail && <span className={HINT}>{info.detail}</span>}
      </div>

      {ready && (
        <>
          <div className="flex gap-2">
            <Stat id="rhythm-bpm" label="BPM" value={Math.round(info.bpm)} />
            <Stat id="rhythm-beats" label="Beats" value={info.beats} />
            <Stat id="rhythm-confidence" label="Confidence" value={info.confidence} />
          </div>
          <p className={HINT}>
            {info.downbeats
              ? `${info.downbeats} bar starts found — shown brighter on the timeline.`
              : 'Bar starts weren’t clear enough to mark — beats only.'}
          </p>
          <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]">Add at next beat</span>
          <div className="flex gap-1.5">
            <button type="button" id="rhythm-add-text" className={SMALL_BTN} onClick={() => addAt((at) => textElements.addTextElement({ kind: 'overlay', start: at, text: 'New text' }))}>Text</button>
            <button type="button" id="rhythm-add-shape" className={SMALL_BTN} onClick={() => addAt((at) => shapeLayers.addShapeLayer('rounded', { start: at }))}>Shape</button>
            <button type="button" id="rhythm-add-image" className={SMALL_BTN} onClick={() => addAt((at) => promptForImageFile({ start: at }))}>Image</button>
            <button type="button" id="rhythm-add-cinematic" className={SMALL_BTN} onClick={() => addAt((at) => textElements.addInterlude({ start: at }))}>Cinematic</button>
          </div>
        </>
      )}

      {(info.state === 'failed' || info.state === 'pending') && (
        <button type="button" id="rhythm-analyze" className={SMALL_BTN} onClick={() => rhythm.ensureRhythmAnalysis({ force: true })}>
          {info.state === 'failed' ? 'Try again' : 'Find the rhythm'}
        </button>
      )}
    </div>
  );
}
