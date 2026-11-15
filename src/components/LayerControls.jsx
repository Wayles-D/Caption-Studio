/**
 * THE LAYER STACK in the UI (shared/visualLayers.js, src/js/components/layerStack.js):
 *
 *   LayerOrderControls — Bring to Front / Forward / Backward / Send to Back
 *                        for one object, the same four for every kind;
 *   LayersPanel        — the whole stack, top first: select an entry, move
 *                        it up or down, delete it.
 */
import { useEffect, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as layerStack from '../js/components/layerStack.js';
import * as occlusion from '../js/components/occlusion.js';
import * as tamSeg from '../js/components/tamSegmentation.js';
import { SELECT, TimeField, PRIMARY_BTN, Slider } from './LayerInspectorControls.jsx';
import { MAX_OCCLUSION_GROW, MAX_OCCLUSION_FEATHER } from '../../shared/objects/occlusion.js';

// The Slider's undo contract (one step per drag) over a relationship's edge.
const EDGE_API = {
  get: (id) => {
    const r = occlusion.getOcclusions().find((x) => x.id === id);
    return r ? { grow: r.grow, feather: r.feather } : null;
  },
  update: (id, patch, opts) => occlusion.updateOcclusion(id, patch, opts)
};
import { useFollowStore } from '../store/followStore.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]';
const HINT = 'text-[12px] text-[var(--text-muted)] m-0';
const SECONDARY_BTN = `h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;
const ICON_BTN = `h-7 w-7 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] text-xs rounded-[var(--radius-sm)]
  cursor-pointer hover:border-[var(--accent-color)] hover:text-[var(--accent-color)] disabled:opacity-30 disabled:cursor-default`;

function useStackRerender() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);
}

/** The four restack actions for one object, whatever its kind. */
export function LayerOrderControls({ id, idPrefix = 'layer' }) {
  useStackRerender();
  const pos = layerStack.getLayerPosition(id);
  if (!pos) return null;
  const atTop = pos.position === pos.count;
  const atBottom = pos.position === 1;
  return (
    <div className={CARD} id={`${idPrefix}-order`}>
      <div className="flex items-center justify-between">
        <span className={SECTION_TITLE}>Layer</span>
        <span className="text-[12px] text-[var(--text-muted)]" id={`${idPrefix}-position`}>{pos.position} of {pos.count}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" id={`${idPrefix}-to-front`} className={SECONDARY_BTN} disabled={atTop} onClick={() => layerStack.moveLayer(id, 'front')}>Bring to Front</button>
        <button type="button" id={`${idPrefix}-forward`} className={SECONDARY_BTN} disabled={atTop} onClick={() => layerStack.moveLayer(id, 'forward')}>Bring Forward</button>
        <button type="button" id={`${idPrefix}-backward`} className={SECONDARY_BTN} disabled={atBottom} onClick={() => layerStack.moveLayer(id, 'backward')}>Send Backward</button>
        <button type="button" id={`${idPrefix}-to-back`} className={SECONDARY_BTN} disabled={atBottom} onClick={() => layerStack.moveLayer(id, 'back')}>Send to Back</button>
      </div>
      <p className={HINT}>One stack for captions, text, images and shapes. The video is always at the bottom.</p>
      <BehindSubjectControl id={id} idPrefix={idPrefix} />
    </div>
  );
}

/**
 * DYNAMIC OCCLUSION (shared/objects/occlusion.js) for one layer: send it
 * BEHIND a person, so they pass in front of it — no keyframes, no mask
 * painting, and no trip to the Objects panel.
 *
 * WHERE, NOT EVERYWHERE: the effect lives exactly as long as this layer is
 * on screen. "Put behind someone…" turns the video into a picker; click the
 * person (or drag a box round them) and they are followed over THIS layer's
 * time only — never the whole video. Stretch or move the layer later and the
 * effect follows it, processing only the new seconds (tamSegmentation.js).
 * Unticking "Follows this clip" gives the effect its own From/To instead.
 *
 * Progress lives in useFollowStore, so it shows wherever this panel is open,
 * including for an extension the timeline started.
 */
function BehindSubjectControl({ id, idPrefix }) {
  const picking = useFollowStore((s) => s.picking);
  const job = useFollowStore((s) => s.job);
  const problem = useFollowStore((s) => s.problem);
  const subjects = occlusion.availableSubjects();
  const relation = occlusion.occlusionForLayer(id);
  const selection = tamSeg.followableSelection();
  const current = relation && relation.mode === 'behind' ? relation.trackKey : '';
  const span = layerStack.getLayerStack().find((e) => e.id === id)?.item;
  const spanText = span && Number.isFinite(span.start) && Number.isFinite(span.end)
    ? `${span.start.toFixed(1)}s – ${span.end.toFixed(1)}s`
    : '';
  const myJob = job?.layerId === id ? job : null;
  const myProblem = problem?.layerId === id ? problem.message : null;
  const wrap = `flex flex-col gap-2.5 ${idPrefix === 'layers' ? '' : 'border-t border-[var(--border-color)] pt-3'}`;
  const title = idPrefix !== 'layers' && <span className={SECTION_TITLE}>Behind a subject</span>;

  if (myJob) {
    const counts = myJob.total ? `${myJob.done} of ${myJob.total}` : 'starting';
    const left = myJob.secondsLeft != null ? ` — about ${myJob.secondsLeft}s left` : '';
    return (
      <div className={wrap} id={`${idPrefix}-behind-busy`}>
        {title}
        <p className={HINT} id={`${idPrefix}-behind-progress`} role="status">
          {myJob.kind === 'extend'
            ? `Covering the new part of the clip behind ${myJob.label}… ${counts}${left}`
            : `Following ${myJob.label}… ${counts}${left}`}
        </p>
        <button type="button" id={`${idPrefix}-behind-cancel`} className={SECONDARY_BTN} onClick={() => tamSeg.cancelTamSegmentation()}>
          Cancel
        </button>
      </div>
    );
  }

  if (picking?.layerId === id) {
    return (
      <div className={wrap} id={`${idPrefix}-behind-picking`}>
        {title}
        <p className="text-[12.5px] leading-snug text-[var(--text-primary)] m-0">
          Click the person on the video — or drag a box around them.
        </p>
        <p className={HINT}>
          This goes behind them for its whole time on screen{spanText ? ` (${spanText})` : ''}. Only that part of the video is processed.
        </p>
        <button type="button" id={`${idPrefix}-behind-pick-cancel`} className={SECONDARY_BTN} onClick={() => tamSeg.cancelPicking()}>
          Cancel
        </button>
      </div>
    );
  }

  const behind = relation && relation.mode === 'behind';
  return (
    <div className={wrap} id={`${idPrefix}-behind`}>
      {title}
      {behind ? (
        <>
          <p className="text-[12.5px] leading-snug text-[var(--text-primary)] m-0" id={`${idPrefix}-behind-note`}>
            Behind <b className="font-semibold">{relation.label}</b> from {relation.start.toFixed(1)}s to {relation.end.toFixed(1)}s.
          </p>
          <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              id={`${idPrefix}-behind-follows`}
              checked={relation.followsLayer !== false}
              onChange={(e) => occlusion.updateOcclusion(relation.id, { followsLayer: e.target.checked })}
            />
            Follows this clip — stretch or move it and the effect comes along
          </label>
          {relation.followsLayer === false && (
            <div className="flex gap-2">
              <TimeField id={`${idPrefix}-behind-start`} label="From" value={relation.start} onCommit={(v) => occlusion.updateOcclusion(relation.id, { start: Math.min(v, relation.end - 0.1), followsLayer: false })} />
              <TimeField id={`${idPrefix}-behind-end`} label="To" value={relation.end} onCommit={(v) => occlusion.updateOcclusion(relation.id, { end: Math.max(v, relation.start + 0.1), followsLayer: false })} />
            </div>
          )}
          {/* The edge where they meet what is behind them. Tight by default;
              grow it if strands of hair or a shoulder edge let the layer
              show through, shrink it if a light outline appears. */}
          <Slider
            id={`${idPrefix}-behind-grow`} label="Edge — grow around them" layerId={relation.id} api={EDGE_API}
            value={relation.grow} min={0} max={Math.min(12, MAX_OCCLUSION_GROW)} step={1} unit="px"
            onLive={(v, o) => occlusion.updateOcclusion(relation.id, { grow: v }, o)}
          />
          <Slider
            id={`${idPrefix}-behind-feather`} label="Edge — soften" layerId={relation.id} api={EDGE_API}
            value={relation.feather} min={0} max={Math.min(8, MAX_OCCLUSION_FEATHER)} step={1} unit="px"
            onLive={(v, o) => occlusion.updateOcclusion(relation.id, { feather: v }, o)}
          />
          <p className={HINT}>A light outline round them? Keep “grow” at 0. Bits of hair letting it show through? Turn it up a little.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" id={`${idPrefix}-behind-repick`} className={SECONDARY_BTN} onClick={() => tamSeg.startPickingBehind(id)}>Change who</button>
            <button type="button" id={`${idPrefix}-behind-clear`} className={SECONDARY_BTN} onClick={() => occlusion.setLayerBehind(id, null)}>Bring to front</button>
          </div>
        </>
      ) : (
        <>
          <button type="button" id={`${idPrefix}-behind-pick`} className={PRIMARY_BTN} onClick={() => tamSeg.startPickingBehind(id)}>
            Put behind someone…
          </button>
          <p className={HINT} id={`${idPrefix}-behind-none`}>
            Then click the person on the video. Only this clip’s time{spanText ? ` (${spanText})` : ''} is processed — never the whole video.
          </p>
        </>
      )}
      {/* Someone already followed (or picked in the Objects panel): choose them directly. */}
      {(subjects.length > 0 || selection) && (
        <select
          id={`${idPrefix}-behind-select`}
          className={SELECT}
          value={current}
          aria-label="Choose who this goes behind"
          onChange={(e) => {
            useFollowStore.getState().setProblem(null);
            if (e.target.value === '__follow__') return tamSeg.followSelectionBehindLayer(id);
            occlusion.setLayerBehind(id, e.target.value || null);
          }}
        >
          <option value="">In front of everything (normal)</option>
          {subjects.map((s) => <option key={s.trackKey} value={s.trackKey}>Behind {s.label}</option>)}
          {selection && (
            <option value="__follow__">
              Behind {selection.label} — follow them now ({selection.time.toFixed(1)}s)
            </option>
          )}
        </select>
      )}
      {myProblem && <p className={HINT} id={`${idPrefix}-behind-problem`} role="alert">{myProblem}</p>}
    </div>
  );
}

/** Every layer, top first, with the video fixed at the bottom. */
export function LayersPanel() {
  useStackRerender();
  const stack = layerStack.getLayerStack();
  const selectedId = layerStack.getSelectedLayerId();
  const top = stack.length - 1;
  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <span className={SECTION_TITLE}>Layers</span>
        <p className={HINT}>Top of the list is drawn on top. Select a layer to edit it; the arrows restack it.</p>
        <ol className="flex flex-col gap-1.5 m-0 p-0 list-none" id="layers-list">
          {stack.slice().reverse().map((entry, i) => {
            const { badge, label } = layerStack.describeLayerEntry(entry);
            const index = top - i;
            const isSelected = entry.id === selectedId;
            return (
              <li
                key={entry.id}
                data-layer-id={entry.id}
                data-layer-type={entry.type}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border bg-[var(--bg-input)] ${isSelected ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}`}
              >
                <button
                  type="button"
                  className="flex-1 flex items-center gap-2 bg-transparent border-0 p-0 text-left cursor-pointer min-w-0"
                  onClick={() => layerStack.selectLayerEntry(entry)}
                  title={entry.type === 'captions' ? 'The transcript’s captions — edited from the Captions lane' : 'Select'}
                >
                  <span className="text-[11px] font-bold text-[var(--text-muted)] w-8 shrink-0">{badge}</span>
                  <span className="text-[12px] text-[var(--text-primary)] truncate">{label}</span>
                </button>
                <button type="button" className={ICON_BTN} data-layer-up={entry.id} disabled={index === top} title="Bring forward" onClick={() => layerStack.moveLayer(entry.id, 'forward')}>↑</button>
                <button type="button" className={ICON_BTN} data-layer-down={entry.id} disabled={index === 0} title="Send backward" onClick={() => layerStack.moveLayer(entry.id, 'backward')}>↓</button>
                <button type="button" className={ICON_BTN} data-layer-delete={entry.id} disabled={entry.type === 'captions'} title={entry.type === 'captions' ? 'The transcript’s captions cannot be deleted here' : 'Delete'} onClick={() => layerStack.removeLayerEntry(entry)}>✕</button>
              </li>
            );
          })}
          <li className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-color)]" data-layer-type="video">
            <span className="text-[11px] font-bold text-[var(--text-muted)] w-8 shrink-0">VID</span>
            <span className="text-[12px] text-[var(--text-secondary)]">Video (base)</span>
          </li>
        </ol>
        {appState.layerOrder && <p className={HINT}>Order saved with the project.</p>}
      </div>
      {/* Sending the SELECTED layer behind a subject, in the one place that
          lists every layer — so a word, a picture and a shape all go behind a
          person the same way, without hunting through each kind's own panel. */}
      {selectedId && (
        <div className={CARD} id="layers-behind-card">
          <span className={SECTION_TITLE}>Behind a subject</span>
          <BehindSubjectControl id={selectedId} idPrefix="layers" />
        </div>
      )}
    </div>
  );
}
