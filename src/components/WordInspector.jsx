/**
 * Word Inspector — the panel behind the bottom toolbar's "Word" tool.
 *
 * Every other style surface in this app edits a WHOLE caption (SidebarInspector)
 * or a whole tier (the keyword controls). This one edits exactly one word
 * occurrence: the word currently selected on the canvas. That's the gap it
 * exists to close — a caption editor has to let you restyle a single word
 * without touching the hundred others around it.
 *
 * It deliberately does NOT retarget the existing global controls. Those keep
 * meaning "all captions", so moving a slider in the Style panel can never
 * silently apply to just one word because something happened to be selected.
 * What a word carries here is an OVERRIDE: each field is either set (this word
 * wins) or absent (inherit the preset / keyword tier / global style), which is
 * the same `null = inherit` convention the global style fields already use.
 *
 * Reads/writes go through src/js/components/canvasTransform.js's
 * applyWordStyleFields/resetWordStyle, which store onto the SAME
 * captionTransforms['w<index>'] entry the word's position/scale/rotation
 * already live on — one override per word, covering both where it is and what
 * it looks like. Rendering is shared/captionGraphics.js's applyWordStyleOverride,
 * so preview and export stay in lockstep with no export-side work.
 */
import { useEffect, useRef, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import {
  getSelectedWordStyleTarget,
  applyWordStyleFields,
  resetWordStyle,
  onSelectionChange
} from '../js/components/canvasTransform.js';
import { listFontOptions } from '../../shared/fontRegistry.js';
import { ColorPickerField } from './ColorPickerField.jsx';
import { ToggleSwitch } from './ToggleSwitch.jsx';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const GROUP_LABEL = 'text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]';
const SELECT = `h-8 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--border-color-hover)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:cursor-pointer`;
const VALUE_BADGE = 'text-[10px] font-semibold text-[var(--text-secondary)] w-10 text-right shrink-0';
const SECONDARY_BTN = `h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]`;
const TOGGLE_BTN_BASE = `flex-1 h-9 rounded-[var(--radius-sm)] border text-[13px] font-bold cursor-pointer
  transition-colors duration-150 bg-[var(--bg-input)]`;
const TOGGLE_BTN_ON = 'border-[var(--accent-color)] text-[var(--accent-color)]';
const TOGGLE_BTN_OFF = 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent-color)]';

// Same ranges as the caption-level controls these mirror (see
// SidebarInspector's Outline Width / Shadow Intensity / Offset sliders), so a
// value means the same thing whether it was authored for one word or all.
const OUTLINE_MAX = 50;
const SHADOW_MAX = 100;
const SHADOW_OFFSET_RANGE = 100;
const WEIGHT_OPTIONS = [
  { value: '400', label: 'Regular' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '900', label: 'Black' }
];

/**
 * A colour swatch for ONE per-word style field.
 *
 * Wraps ColorPickerField to fix a mismatch with how that component defines a
 * session: it reverts to its open-time snapshot on ANY close that isn't the
 * Apply button (outside click, Escape, X — see ColorPickerField's own effect).
 * That's right for a global field, whose snapshot is a real committed colour.
 * It is WRONG here: a word with no colour of its own has no committed value,
 * so the snapshot is just the fallback shown in the swatch, and picking a
 * colour then clicking away silently wrote that fallback back — the change
 * appeared to do nothing at all.
 *
 * So for a word, closing the picker COMMITS whatever was picked. The explicit
 * "inherit" control next to each swatch is the way back to unset, which is
 * clearer than a revert that depends on how the popover happened to be
 * dismissed.
 */
function WordColorField({ wordIndex, field, label, fallback, value, openField, setOpenField }) {
  const pickedRef = useRef(null);

  return (
    <ColorPickerField
      triggerId={`word-${field}-${wordIndex}`}
      label={label}
      value={value || fallback}
      opacity={null}
      open={openField === field}
      onOpenChange={(isOpen) => {
        if (isOpen) {
          pickedRef.current = null;
        } else if (pickedRef.current) {
          // Read the picked colour NOW, before ColorPickerField's own restore
          // fires onChange with its snapshot, then re-assert it once that has
          // landed.
          const picked = pickedRef.current;
          setTimeout(() => applyWordStyleFields(wordIndex, { [field]: picked }), 0);
        }
        setOpenField(isOpen ? field : null);
      }}
      onChange={(hex6) => {
        pickedRef.current = hex6;
        applyWordStyleFields(wordIndex, { [field]: hex6 }, { recordHistory: false });
      }}
    />
  );
}

/** One labelled slider row that can also be "inherit" (no per-word value set). */
function OverrideSlider({ label, value, fallbackLabel, min, max, unit, onChange, onClear }) {
  const isSet = value != null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={GROUP_LABEL}>{label}</span>
        {isSet && (
          <button
            type="button"
            className="text-[10px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
            onClick={onClear}
            title="Go back to inheriting this from the caption"
          >
            inherit
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range" min={min} max={max} step="1" className={SLIDER}
          value={isSet ? value : min}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className={VALUE_BADGE}>{isSet ? `${value}${unit}` : fallbackLabel}</span>
      </div>
    </div>
  );
}

export function WordInspector() {
  // The canvas selection lives in module state inside canvasTransform.js, not
  // in a store — onSelectionChange (fired once per overlay sync) is the bridge.
  // The subscribe('*') is for the value side: undo/redo and any other write to
  // captionTransforms has to be reflected back into these controls.
  const [, forceRender] = useState(0);
  useEffect(() => {
    const rerender = () => forceRender((n) => n + 1);
    const offSelection = onSelectionChange(rerender);
    const offState = subscribe('*', rerender);
    return () => {
      offSelection();
      if (typeof offState === 'function') offState();
    };
  }, []);

  const [openColorField, setOpenColorField] = useState(null);
  const target = getSelectedWordStyleTarget();

  if (!target) {
    return (
      <div className={CARD}>
        <span className={SECTION_TITLE}>No word selected</span>
        <p className={HINT}>
          Click a caption in the preview to select it, then click again on a single word to
          drill into it. Whatever you change here applies to that word alone — every other
          word keeps the caption’s own style.
        </p>
      </div>
    );
  }

  const { wordIndex, text, isKeyword, style } = target;
  const set = (fields) => applyWordStyleFields(wordIndex, fields);
  const hasAnyOverride = Object.values(style).some((v) => v != null);

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_TITLE}>Word</span>
          {isKeyword && (
            <span className="text-[10px] font-bold uppercase tracking-[0.04em] text-[var(--accent-color)]">Keyword</span>
          )}
        </div>
        <span className="text-[15px] font-bold text-[var(--text-primary)] truncate" title={text}>“{text}”</span>
        <p className={HINT}>
          {hasAnyOverride
            ? 'This word has its own style. Anything left untouched still follows the caption.'
            : 'Currently following the caption’s style. Change anything below to override it for this word only.'}
        </p>
      </div>

      {/* --- Typeface --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Typeface</span>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="word-font-select" className={GROUP_LABEL}>Font</label>
          <select
            id="word-font-select"
            className={SELECT}
            value={style.fontFamily || ''}
            onChange={(e) => set({ fontFamily: e.target.value || null })}
          >
            <option value="">Same as caption</option>
            {listFontOptions().map((f) => (
              <option key={f.key} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="word-weight-select" className={GROUP_LABEL}>Weight</label>
          <select
            id="word-weight-select"
            className={SELECT}
            value={style.fontWeight || ''}
            onChange={(e) => set({ fontWeight: e.target.value || null })}
          >
            <option value="">Same as caption</option>
            {WEIGHT_OPTIONS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </div>

        {/* Italic/underline are plain on/off for this word — there is no
            "inherit" state to represent, since neither exists at caption level. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${TOGGLE_BTN_BASE} ${style.italic ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} italic`}
            onClick={() => set({ italic: style.italic ? null : true })}
            title="Italic"
          >I</button>
          <button
            type="button"
            className={`${TOGGLE_BTN_BASE} ${style.underline ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} underline`}
            onClick={() => set({ underline: style.underline ? null : true })}
            title="Underline"
          >U</button>
        </div>
      </div>

      {/* --- Colour --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Colour</span>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[var(--text-primary)]">Text</span>
          <div className="flex items-center gap-2">
            {style.color && (
              <button
                type="button"
                className="text-[10px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
                onClick={() => set({ color: null })}
                title="Go back to inheriting this from the caption"
              >inherit</button>
            )}
            <WordColorField
              wordIndex={wordIndex} field="color" label="Word colour"
              value={style.color} fallback="#FFFFFF"
              openField={openColorField} setOpenField={setOpenColorField}
            />
          </div>
        </div>
      </div>

      {/* --- Outline --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Outline</span>
        <OverrideSlider
          label="Width"
          value={style.outlineSize}
          fallbackLabel="auto"
          min={0} max={OUTLINE_MAX} unit="px"
          onChange={(v) => set({ outlineSize: v })}
          onClear={() => set({ outlineSize: null })}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-[var(--text-primary)]">Colour</span>
          <div className="flex items-center gap-2">
            {style.outlineColor && (
              <button
                type="button"
                className="text-[10px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
                onClick={() => set({ outlineColor: null })}
              >inherit</button>
            )}
            <WordColorField
              wordIndex={wordIndex} field="outlineColor" label="Outline colour"
              value={style.outlineColor} fallback="#000000"
              openField={openColorField} setOpenField={setOpenColorField}
            />
          </div>
        </div>
      </div>

      {/* --- Shadow --- */}
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Shadow</span>
          <ToggleSwitch
            id={`word-shadow-${wordIndex}`}
            defaultChecked={!!style.shadowEnabled}
            title="Give this word its own shadow"
            onChange={(e) => set({ shadowEnabled: e.target.checked ? true : null })}
          />
        </div>
        {style.shadowEnabled && (
          <>
            <OverrideSlider
              label="Intensity" value={style.shadowSize} fallbackLabel="auto"
              min={0} max={SHADOW_MAX} unit="px"
              onChange={(v) => set({ shadowSize: v })}
              onClear={() => set({ shadowSize: null })}
            />
            <OverrideSlider
              label="Offset X" value={style.shadowOffsetX} fallbackLabel="auto"
              min={-SHADOW_OFFSET_RANGE} max={SHADOW_OFFSET_RANGE} unit="px"
              onChange={(v) => set({ shadowOffsetX: v })}
              onClear={() => set({ shadowOffsetX: null })}
            />
            <OverrideSlider
              label="Offset Y" value={style.shadowOffsetY} fallbackLabel="auto"
              min={-SHADOW_OFFSET_RANGE} max={SHADOW_OFFSET_RANGE} unit="px"
              onChange={(v) => set({ shadowOffsetY: v })}
              onClear={() => set({ shadowOffsetY: null })}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-[var(--text-primary)]">Colour</span>
              <WordColorField
                wordIndex={wordIndex} field="shadowColor" label="Shadow colour"
                value={style.shadowColor} fallback="#000000"
                openField={openColorField} setOpenField={setOpenColorField}
              />
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        className={SECONDARY_BTN}
        disabled={!hasAnyOverride}
        onClick={() => resetWordStyle(wordIndex)}
      >
        Reset to caption style
      </button>
    </div>
  );
}
