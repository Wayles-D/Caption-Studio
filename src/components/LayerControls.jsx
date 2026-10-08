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

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
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
        <span className="text-[11px] text-[var(--text-muted)]" id={`${idPrefix}-position`}>{pos.position} of {pos.count}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" id={`${idPrefix}-to-front`} className={SECONDARY_BTN} disabled={atTop} onClick={() => layerStack.moveLayer(id, 'front')}>Bring to Front</button>
        <button type="button" id={`${idPrefix}-forward`} className={SECONDARY_BTN} disabled={atTop} onClick={() => layerStack.moveLayer(id, 'forward')}>Bring Forward</button>
        <button type="button" id={`${idPrefix}-backward`} className={SECONDARY_BTN} disabled={atBottom} onClick={() => layerStack.moveLayer(id, 'backward')}>Send Backward</button>
        <button type="button" id={`${idPrefix}-to-back`} className={SECONDARY_BTN} disabled={atBottom} onClick={() => layerStack.moveLayer(id, 'back')}>Send to Back</button>
      </div>
      <p className={HINT}>One stack for captions, text, images and shapes. The video is always at the bottom.</p>
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
                  <span className="text-[10px] font-bold text-[var(--text-muted)] w-8 shrink-0">{badge}</span>
                  <span className="text-[12px] text-[var(--text-primary)] truncate">{label}</span>
                </button>
                <button type="button" className={ICON_BTN} data-layer-up={entry.id} disabled={index === top} title="Bring forward" onClick={() => layerStack.moveLayer(entry.id, 'forward')}>↑</button>
                <button type="button" className={ICON_BTN} data-layer-down={entry.id} disabled={index === 0} title="Send backward" onClick={() => layerStack.moveLayer(entry.id, 'backward')}>↓</button>
                <button type="button" className={ICON_BTN} data-layer-delete={entry.id} disabled={entry.type === 'captions'} title={entry.type === 'captions' ? 'The transcript’s captions cannot be deleted here' : 'Delete'} onClick={() => layerStack.removeLayerEntry(entry)}>✕</button>
              </li>
            );
          })}
          <li className="flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-color)]" data-layer-type="video">
            <span className="text-[10px] font-bold text-[var(--text-muted)] w-8 shrink-0">VID</span>
            <span className="text-[12px] text-[var(--text-secondary)]">Video (base)</span>
          </li>
        </ol>
        {appState.layerOrder && <p className={HINT}>Order saved with the project.</p>}
      </div>
    </div>
  );
}
