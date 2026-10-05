/**
 * The controls the layer panels share (ImageInspector.jsx, ShapeInspector.jsx):
 * the same cards, sliders, toggles, colour rows and time fields, in the
 * Text & Cinematic panel's classes. Object-agnostic: a Slider commits ONE
 * undo step per drag through the object's own `api` ({ get, update }).
 */
import { useRef, useState } from 'react';
import { ColorPickerField } from './ColorPickerField.jsx';

export const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
export const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
export const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
export const GROUP_LABEL = 'text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]';
export const INPUT = `h-9 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)]
  text-[var(--text-primary)] text-[13px] px-2.5 outline-none transition-colors duration-200
  hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
export const SELECT = `h-8 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
export const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--border-color-hover)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:cursor-pointer`;
export const VALUE_BADGE = 'text-[10px] font-semibold text-[var(--text-secondary)] w-12 text-right shrink-0';
export const PRIMARY_BTN = `h-9 bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:bg-[var(--accent-hover)]`;
export const SECONDARY_BTN = `h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;
export const ROW_BASE = `w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border cursor-pointer transition-colors duration-150
  bg-[var(--bg-input)] flex items-center gap-2`;
export const TOGGLE_BTN_BASE = `flex-1 h-9 rounded-[var(--radius-sm)] border text-[13px] font-bold cursor-pointer
  transition-colors duration-150 bg-[var(--bg-input)]`;
export const TOGGLE_BTN_ON = 'border-[var(--accent-color)] text-[var(--accent-color)]';
export const TOGGLE_BTN_OFF = 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent-color)]';

export const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const round = (v, step) => Math.round(v / step) * step;

/**
 * A slider over one numeric field. Dragging previews with history off and
 * commits the whole drag as ONE undo step on release (the rewind-then-commit
 * the canvas gestures use); a keyboard nudge, with no drag in progress,
 * commits straight away.
 */
export function Slider({ id, label, value, min, max, step = 1, unit = '', format, onLive, layerId, api }) {
  const startRef = useRef(null);
  const shown = format ? format(value) : `${Number(value.toFixed(step < 1 ? 2 : 0))}${unit}`;
  const commit = () => {
    if (!startRef.current) return;
    const start = startRef.current;
    startRef.current = null;
    const final = api.get(layerId);
    if (!final) return;
    api.update(layerId, start, { recordHistory: false });
    api.update(layerId, final, { recordHistory: true });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className={GROUP_LABEL}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          id={id} type="range" min={min} max={max} step={step} className={SLIDER}
          value={value}
          onPointerDown={() => { startRef.current = JSON.parse(JSON.stringify(api.get(layerId))); }}
          onPointerUp={commit}
          onPointerCancel={commit}
          onChange={(e) => onLive(Number(e.target.value), { recordHistory: !startRef.current })}
        />
        <span className={VALUE_BADGE}>{shown}</span>
      </div>
    </div>
  );
}

/** On / off for a border or a shadow. */
export function Toggle({ id, label, on, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={GROUP_LABEL}>{label}</span>
      <div className="flex gap-2 w-28">
        <button type="button" id={`${id}-on`} className={`${TOGGLE_BTN_BASE} ${on ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF}`} onClick={() => onChange(true)}>On</button>
        <button type="button" id={`${id}-off`} className={`${TOGGLE_BTN_BASE} ${!on ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF}`} onClick={() => onChange(false)}>Off</button>
      </div>
    </div>
  );
}

/** A colour that commits when its picker closes (see TextInspector's TextElementColorField for why). */
export function ColorRow({ id, label, value, openField, setOpenField, apply }) {
  const pickedRef = useRef(null);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={GROUP_LABEL}>{label}</span>
      <ColorPickerField
        triggerId={id}
        label={label}
        value={value}
        opacity={null}
        open={openField === id}
        onOpenChange={(isOpen) => {
          if (isOpen) pickedRef.current = null;
          else if (pickedRef.current) {
            const picked = pickedRef.current;
            setTimeout(() => apply(picked, { recordHistory: true }), 0);
          }
          setOpenField(isOpen ? id : null);
        }}
        onChange={(hex6) => {
          pickedRef.current = hex6;
          apply(hex6, { recordHistory: false });
        }}
      />
    </div>
  );
}

/** A time in seconds, committed on Enter or when the field is left. */
export function TimeField({ id, label, value, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft == null) return;
    const v = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(v)) onCommit(v);
  };
  return (
    <label className="flex flex-col gap-1.5 flex-1">
      <span className={GROUP_LABEL}>{label}</span>
      <input
        id={id} type="number" step="0.1" min="0" className={INPUT}
        value={draft ?? value.toFixed(2)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      />
    </label>
  );
}
