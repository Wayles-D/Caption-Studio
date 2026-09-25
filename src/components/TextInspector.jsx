/**
 * Text Inspector — the panel behind the bottom toolbar's "Text" overlay tool.
 *
 * Edits the manually placed caption / text overlay currently selected (on the
 * timeline, on the canvas, or in the list below — all three are the same
 * selection; see shared/textElement.js).
 *
 * Every styling control here writes ONE key of the element's sparse `style`
 * bag, named exactly as getStyleParams() names it. That is the whole design:
 * the renderer resolves an element as `{ ...getStyleParams(), ...element.style }`,
 * with no translation layer and no second styling model, so a text overlay
 * can do everything a caption can do visually — and anything captions gain
 * later reaches these for free. An absent key means "inherit the caption's
 * current look", which is what makes a new overlay match the video you're
 * already building; every "inherit" button is just `delete this key`.
 *
 * Preview and export run the same merge (src/js/components/preview.js's
 * syncTextElementsCanvas and backend/utils/graphicsFrameGenerator.js's
 * composite pass), so the two cannot disagree.
 */
import { useEffect, useRef, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as textElements from '../js/components/textElements.js';
import { listFontOptions } from '../../shared/fontRegistry.js';
import { ANIMATION_TYPES } from '../../shared/captionAnimation.js';
import { ColorPickerField } from './ColorPickerField.jsx';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const GROUP_LABEL = 'text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]';
const INPUT = `h-9 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)]
  text-[var(--text-primary)] text-[13px] px-2.5 outline-none transition-colors duration-200
  hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const TEXTAREA = `${INPUT} h-auto min-h-[76px] py-2 resize-y leading-snug`;
const SELECT = `h-8 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--border-color-hover)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:cursor-pointer`;
const VALUE_BADGE = 'text-[10px] font-semibold text-[var(--text-secondary)] w-12 text-right shrink-0';
const PRIMARY_BTN = `h-9 bg-[var(--accent-gradient)] border-0 text-[var(--text-on-accent)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:bg-[var(--accent-hover)]`;
const SECONDARY_BTN = `h-9 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;
const ROW_BASE = `w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border cursor-pointer transition-colors duration-150
  bg-[var(--bg-input)] flex items-center gap-2`;
const TOGGLE_BTN_BASE = `flex-1 h-9 rounded-[var(--radius-sm)] border text-[13px] font-bold cursor-pointer
  transition-colors duration-150 bg-[var(--bg-input)]`;
const TOGGLE_BTN_ON = 'border-[var(--accent-color)] text-[var(--accent-color)]';
const TOGGLE_BTN_OFF = 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--accent-color)]';

// Ranges deliberately identical to the caption-level controls these mirror
// (SidebarInspector's Outline Width / Shadow Intensity / Offset sliders), so
// a number means the same thing whether it was authored for a caption or for
// one overlay.
const WEIGHT_OPTIONS = [
  { value: '400', label: 'Regular' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extrabold' },
  { value: '900', label: 'Black' }
];
const CASE_OPTIONS = [
  { value: 'none', label: 'As typed' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' }
];
const POSITION_OPTIONS = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'manual', label: 'Manual (drag it)' }
];
const SHADOW_MODE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'individual', label: 'Per word' },
  { value: 'unified', label: 'Unified' }
];
const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function formatTime(t) {
  if (!Number.isFinite(t)) return '0:00.00';
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

/** "Clear this override" — shown only once the key is actually set. */
function InheritButton({ show, onClick }) {
  if (!show) return null;
  return (
    <button
      type="button"
      className="text-[10px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
      title="Go back to inheriting this from the caption style"
      onClick={onClick}
    >inherit</button>
  );
}

/** Labelled slider that also has an unset ("inherit") state. */
function StyleSlider({ id, label, value, min, max, step = 1, unit = '', onChange, onClear }) {
  const isSet = value != null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className={GROUP_LABEL}>{label}</span>
        <InheritButton show={isSet} onClick={onClear} />
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id} type="range" min={min} max={max} step={step} className={SLIDER}
          value={isSet ? value : min}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className={VALUE_BADGE}>{isSet ? `${value}${unit}` : 'auto'}</span>
      </div>
    </div>
  );
}

/** Dropdown whose empty option means "inherit". */
function StyleSelect({ id, label, value, options, onChange }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={GROUP_LABEL}>{label}</label>
      <select
        id={id} className={SELECT}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Same as caption</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

/**
 * A colour swatch for one style key.
 *
 * Wrapped for the same reason WordInspector's WordColorField is: ColorPickerField
 * reverts to its open-time snapshot on any close that isn't the Apply button,
 * and for an INHERITED colour that snapshot is merely the swatch's display
 * fallback — so picking a colour and clicking away silently wrote the fallback
 * back and the change appeared to do nothing at all. Here, closing COMMITS
 * what was picked; the explicit "inherit" button is the way back to unset.
 */
function TextElementColorField({ field, label, fallback, value, openField, setOpenField, apply }) {
  const pickedRef = useRef(null);
  return (
    <ColorPickerField
      triggerId={`textel-${field}`}
      label={label}
      value={value || fallback}
      opacity={null}
      open={openField === field}
      onOpenChange={(isOpen) => {
        if (isOpen) {
          pickedRef.current = null;
        } else if (pickedRef.current) {
          // Read the pick NOW, then re-assert it once ColorPickerField's own
          // restore has fired its onChange with the snapshot.
          const picked = pickedRef.current;
          setTimeout(() => apply({ [field]: picked }), 0);
        }
        setOpenField(isOpen ? field : null);
      }}
      onChange={(hex6) => {
        pickedRef.current = hex6;
        apply({ [field]: hex6 }, { recordHistory: false });
      }}
    />
  );
}

/** One colour row: label, optional "inherit", swatch. */
function ColorRow({ label, field, value, fallback, openField, setOpenField, apply }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-[var(--text-primary)]">{label}</span>
      <div className="flex items-center gap-2">
        <InheritButton show={value != null} onClick={() => apply({ [field]: null })} />
        <TextElementColorField
          field={field} label={label} value={value} fallback={fallback}
          openField={openField} setOpenField={setOpenField} apply={apply}
        />
      </div>
    </div>
  );
}

/**
 * "I styled this one; make the others match."
 *
 * Modelled on the sound-effect volume controls' Apply to All, and carrying
 * over that feature's hard-won rule: an "apply to all" that reaches things
 * the user didn't mean is worse than no button at all. So the blast radius is
 * text elements only — never captions, never audio — and "Choose…" is offered
 * beside "All text" so a project with a dozen overlays doesn't force an
 * all-or-nothing choice.
 *
 * Copies the LOOK, not the placement or the timing: see
 * textElements.js's applyTextElementStyleTo for exactly what travels and why.
 */
function ApplyStyleTo({ element }) {
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState(() => new Set());

  const others = (appState.textElements || []).filter((el) => el.id !== element.id);
  if (!others.length) return null;

  const toggle = (id) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const applyTo = (ids) => {
    textElements.applyTextElementStyleTo(element.id, ids);
    setPicking(false);
    setChecked(new Set());
  };

  return (
    <div className={CARD}>
      <span className={SECTION_TITLE}>Apply this style to</span>
      <p className={HINT}>
        Copies the look — font, colour, outline, shadow, rotation, animation.
        Each one keeps its own position, timing and words.
      </p>

      {!picking ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button" id="textel-apply-all" className={PRIMARY_BTN}
            onClick={() => applyTo(others.map((el) => el.id))}
          >
            All text ({others.length})
          </button>
          <button
            type="button" id="textel-apply-choose" className={SECONDARY_BTN}
            onClick={() => setPicking(true)}
          >
            Choose…
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {others.map((el) => (
              <label
                key={el.id}
                className={`${ROW_BASE} ${checked.has(el.id) ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}`}
              >
                <input
                  type="checkbox"
                  data-textel-apply-target={el.id}
                  checked={checked.has(el.id)}
                  onChange={() => toggle(el.id)}
                  className="accent-[var(--accent-color)] shrink-0"
                />
                <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-primary)]">
                  {el.text || '(empty)'}
                </span>
                <span className="text-[10px] text-[var(--text-muted)] shrink-0">{formatTime(el.start)}</span>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button" id="textel-apply-confirm" className={PRIMARY_BTN}
              disabled={!checked.size}
              onClick={() => applyTo([...checked])}
            >
              Apply to {checked.size || 'none'}
            </button>
            <button
              type="button" className={SECONDARY_BTN}
              onClick={() => { setPicking(false); setChecked(new Set()); }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The whole styling stack for one element. Split out of TextInspector purely
 * for readability — its only state is which colour popover is open.
 */
function TextElementStyle({ element }) {
  const [openColorField, setOpenColorField] = useState(null);
  const style = element.style || {};
  const apply = (fields, opts) => textElements.updateTextElementStyle(element.id, fields, opts);
  const hasAnyStyle = Object.keys(style).length > 0;

  /**
   * "Text colour" for an overlay writes BOTH caption colour fields.
   *
   * A caption has two — the karaoke highlight and the un-highlighted rest —
   * but an overlay has no karaoke at all: textElementToPhrase gives every
   * word the element's FULL span, so every word reads as active for its
   * whole life and the renderer colours it with activeWordColor. Exposing
   * only one of the two would mean the swatch showed a colour the pixels
   * never used (confirmed on screen: setting inactiveWordColor alone left
   * the overlay white). One control, both keys, including the clear.
   */
  const applyTextColor = (fields, opts) => {
    const value = fields.inactiveWordColor;
    return apply({ inactiveWordColor: value, activeWordColor: value }, opts);
  };

  return (
    <>
      {/* --- Typeface --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Typeface</span>

        <StyleSelect
          id="textel-font" label="Font" value={style.fontFamily}
          options={listFontOptions().map((f) => ({ value: f.value, label: f.label }))}
          onChange={(v) => apply({ fontFamily: v })}
        />
        <StyleSelect
          id="textel-weight" label="Weight" value={style.fontWeight}
          options={WEIGHT_OPTIONS}
          onChange={(v) => apply({ fontWeight: v })}
        />
        <StyleSlider
          id="textel-size" label="Size" value={style.fontSize}
          min={6} max={150} unit="px"
          onChange={(v) => apply({ fontSize: v })}
          onClear={() => apply({ fontSize: null })}
        />
        <StyleSlider
          id="textel-spacing" label="Word spacing" value={style.wordSpacing}
          min={0} max={40} unit="px"
          onChange={(v) => apply({ wordSpacing: v })}
          onClear={() => apply({ wordSpacing: null })}
        />

        {/* Italic/underline are plain on/off: neither has a caption-level
            value to inherit, so "off" and "inherit" are the same state. */}
        <div className="flex items-center gap-2">
          <button
            type="button" id="textel-italic" title="Italic"
            className={`${TOGGLE_BTN_BASE} ${style.italic ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} italic`}
            onClick={() => apply({ italic: style.italic ? null : true })}
          >I</button>
          <button
            type="button" id="textel-underline" title="Underline"
            className={`${TOGGLE_BTN_BASE} ${style.underline ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} underline`}
            onClick={() => apply({ underline: style.underline ? null : true })}
          >U</button>
        </div>

        <StyleSelect
          id="textel-case" label="Letter case" value={style.textCase}
          options={CASE_OPTIONS}
          onChange={(v) => apply({ textCase: v })}
        />
      </div>

      {/* --- Colour --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Colour</span>
        {/* See applyTextColor for why this one row writes two keys. */}
        <ColorRow
          label="Text" field="inactiveWordColor" fallback="#FFFFFF"
          value={style.inactiveWordColor}
          openField={openColorField} setOpenField={setOpenColorField} apply={applyTextColor}
        />
        <ColorRow
          label="Background" field="backgroundColor" fallback="#000000"
          value={style.backgroundColor}
          openField={openColorField} setOpenField={setOpenColorField} apply={apply}
        />
        <StyleSlider
          id="textel-text-opacity" label="Text opacity" value={style.textOpacity}
          min={0} max={100} unit="%"
          onChange={(v) => apply({ textOpacity: v })}
          onClear={() => apply({ textOpacity: null })}
        />
        <StyleSlider
          id="textel-bg-opacity" label="Background opacity" value={style.backgroundOpacity}
          min={0} max={100} unit="%"
          onChange={(v) => apply({ backgroundOpacity: v })}
          onClear={() => apply({ backgroundOpacity: null })}
        />
        {/* No "Blend with video" control here, deliberately. Blending needs
            the video underneath, so it happens at COMPOSITE time, per layer
            — and all text elements share one layer (one canvas in the
            preview, one stream in the export). A per-element control could
            not be honoured when two overlays are on screen at once, and a
            control that silently does nothing is the exact bug class this
            panel keeps running into. Overlays composite with a plain
            alpha-over; the caption's own blend never reaches them. */}
      </div>

      {/* --- Outline --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Outline</span>
        <StyleSlider
          id="textel-outline-size" label="Width" value={style.outlineSize}
          min={0} max={50} unit="px"
          onChange={(v) => apply({ outlineSize: v })}
          onClear={() => apply({ outlineSize: null })}
        />
        <ColorRow
          label="Colour" field="outlineColor" fallback="#000000"
          value={style.outlineColor}
          openField={openColorField} setOpenField={setOpenColorField} apply={apply}
        />
      </div>

      {/* --- Shadow --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Shadow</span>
        <StyleSelect
          id="textel-shadow-mode" label="Mode" value={style.shadowMode}
          options={SHADOW_MODE_OPTIONS}
          onChange={(v) => apply({ shadowMode: v })}
        />
        {style.shadowMode === 'unified' ? (
          <>
            <StyleSlider
              id="textel-ushadow-blur" label="Blur" value={style.unifiedShadowBlur}
              min={0} max={100} unit="px"
              onChange={(v) => apply({ unifiedShadowBlur: v })}
              onClear={() => apply({ unifiedShadowBlur: null })}
            />
            <StyleSlider
              id="textel-ushadow-opacity" label="Opacity" value={style.unifiedShadowOpacity}
              min={0} max={100} unit="%"
              onChange={(v) => apply({ unifiedShadowOpacity: v })}
              onClear={() => apply({ unifiedShadowOpacity: null })}
            />
            <StyleSlider
              id="textel-ushadow-x" label="Offset X" value={style.unifiedShadowOffsetX}
              min={-100} max={100} unit="px"
              onChange={(v) => apply({ unifiedShadowOffsetX: v })}
              onClear={() => apply({ unifiedShadowOffsetX: null })}
            />
            <StyleSlider
              id="textel-ushadow-y" label="Offset Y" value={style.unifiedShadowOffsetY}
              min={-100} max={100} unit="px"
              onChange={(v) => apply({ unifiedShadowOffsetY: v })}
              onClear={() => apply({ unifiedShadowOffsetY: null })}
            />
            <ColorRow
              label="Colour" field="unifiedShadowColor" fallback="#000000"
              value={style.unifiedShadowColor}
              openField={openColorField} setOpenField={setOpenColorField} apply={apply}
            />
          </>
        ) : (
          <>
            <StyleSlider
              id="textel-shadow-size" label="Intensity" value={style.shadowSize}
              min={0} max={100} unit="px"
              onChange={(v) => apply({ shadowSize: v })}
              onClear={() => apply({ shadowSize: null })}
            />
            <StyleSlider
              id="textel-shadow-x" label="Offset X" value={style.shadowOffsetX}
              min={-100} max={100} unit="px"
              onChange={(v) => apply({ shadowOffsetX: v })}
              onClear={() => apply({ shadowOffsetX: null })}
            />
            <StyleSlider
              id="textel-shadow-y" label="Offset Y" value={style.shadowOffsetY}
              min={-100} max={100} unit="px"
              onChange={(v) => apply({ shadowOffsetY: v })}
              onClear={() => apply({ shadowOffsetY: null })}
            />
            <ColorRow
              label="Colour" field="shadowColor" fallback="#000000"
              value={style.shadowColor}
              openField={openColorField} setOpenField={setOpenColorField} apply={apply}
            />
          </>
        )}
      </div>

      {/* --- Placement --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Placement</span>
        <p className={HINT}>
          You can also just drag it on the video — that writes the same two numbers.
        </p>
        <StyleSelect
          id="textel-position" label="Anchor" value={style.position}
          options={POSITION_OPTIONS}
          onChange={(v) => apply({ position: v })}
        />
        {style.position === 'manual' && (
          <>
            <StyleSlider
              id="textel-pos-x" label="Horizontal" value={style.customPosX}
              min={0} max={100} step={0.5} unit="%"
              onChange={(v) => apply({ customPosX: v })}
              onClear={() => apply({ customPosX: null })}
            />
            <StyleSlider
              id="textel-pos-y" label="Vertical" value={style.customPosY}
              min={0} max={100} step={0.5} unit="%"
              onChange={(v) => apply({ customPosY: v })}
              onClear={() => apply({ customPosY: null })}
            />
          </>
        )}
        <StyleSlider
          id="textel-rotation" label="Rotation" value={style.rotation}
          min={-180} max={180} unit="°"
          onChange={(v) => apply({ rotation: v })}
          onClear={() => apply({ rotation: null })}
        />
      </div>

      {/* --- Animation --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Animation</span>
        <p className={HINT}>
          Runs over this element’s own start time, not the caption’s.
        </p>
        <StyleSelect
          id="textel-anim-type" label="Entrance" value={style.captionAnimationType}
          options={ANIMATION_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
          onChange={(v) => apply({ captionAnimationType: v })}
        />
        <StyleSlider
          id="textel-anim-duration" label="Duration" value={style.captionAnimationDuration}
          min={0.05} max={2} step={0.05} unit="s"
          onChange={(v) => apply({ captionAnimationDuration: v })}
          onClear={() => apply({ captionAnimationDuration: null })}
        />
        <StyleSlider
          id="textel-anim-intensity" label="Intensity" value={style.captionAnimationIntensity}
          min={0} max={200} unit="%"
          onChange={(v) => apply({ captionAnimationIntensity: v })}
          onClear={() => apply({ captionAnimationIntensity: null })}
        />
      </div>

      <ApplyStyleTo element={element} />

      <button
        type="button" id="textel-reset-style" className={SECONDARY_BTN}
        disabled={!hasAnyStyle}
        // Clears the whole bag in one write, so the element goes back to
        // following the caption entirely. Only this element's STYLE — its
        // text and timing are content and are never touched here.
        onClick={() => textElements.updateTextElement(element.id, { style: {} })}
      >
        Reset to caption style
      </button>
    </>
  );
}

export function TextInspector() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);

  const elements = appState.textElements || [];
  const selectedId = appState.selectedTextElementId;
  const selected = elements.find((el) => el.id === selectedId) || null;

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Text</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{elements.length}</span>
        </div>
        <p className={HINT}>
          Independent text placed over the video — not part of the transcript or the
          subtitles. Each one keeps its own content, timing and styling.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button" className={PRIMARY_BTN}
            onClick={() => textElements.addTextElement({ kind: 'overlay', text: 'New text' })}
          >
            + Text at playhead
          </button>
          <button
            type="button" className={SECONDARY_BTN}
            onClick={() => textElements.addTextElement({ kind: 'caption', text: 'New caption' })}
          >
            + Caption
          </button>
        </div>
      </div>

      {elements.length > 0 && (
        <div className={CARD}>
          <span className={SECTION_TITLE}>On the timeline</span>
          <div className="flex flex-col gap-1.5">
            {elements.map((el) => (
              <button
                key={el.id}
                type="button"
                className={`${ROW_BASE} ${el.id === selectedId
                  ? 'border-[var(--accent-color)]'
                  : 'border-[var(--border-color)] hover:border-[var(--accent-color)]'}`}
                onClick={() => textElements.selectTextElement(el.id)}
              >
                <span className="text-[9px] font-bold uppercase tracking-[0.04em] text-[var(--text-muted)] shrink-0">
                  {el.kind === 'caption' ? 'CAP' : 'TXT'}
                </span>
                <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--text-primary)]">
                  {el.text || '(empty)'}
                </span>
                <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                  {formatTime(el.start)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!selected ? (
        <div className={CARD}>
          <span className={SECTION_TITLE}>Nothing selected</span>
          <p className={HINT}>
            Pick one above, click it on the video, or click its clip on the timeline’s
            Text lane, to edit its words, timing and style.
          </p>
        </div>
      ) : (
        <>
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <span className={SECTION_TITLE}>{selected.kind === 'caption' ? 'Manual caption' : 'Text overlay'}</span>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className={GROUP_LABEL}>Content</span>
              <textarea
                id="textel-content"
                className={TEXTAREA}
                value={selected.text}
                placeholder="Type what this should say…"
                onChange={(e) => textElements.updateTextElement(selected.id, { text: e.target.value }, { recordHistory: false })}
                // One history entry per editing session rather than per
                // keystroke — same drag/commit split the timeline gestures use.
                onBlur={(e) => textElements.updateTextElement(selected.id, { text: e.target.value })}
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Start', value: selected.start, apply: (v) => textElements.moveTextElement(selected.id, v) },
                { label: 'End', value: selected.end, apply: (v) => textElements.trimTextElement(selected.id, 'end', v) }
              ].map((field) => (
                <label key={field.label} className="flex flex-col gap-1.5">
                  <span className={GROUP_LABEL}>{field.label}</span>
                  <input
                    type="number" step="0.05" min="0" className={INPUT}
                    value={Number(field.value).toFixed(2)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v)) field.apply(v);
                    }}
                  />
                </label>
              ))}
            </div>

            <span className="text-[10px] text-[var(--text-muted)]">
              {formatTime(selected.start)} → {formatTime(selected.end)}
              {'  ·  '}{(selected.end - selected.start).toFixed(2)}s
            </span>

            <button
              type="button" className={SECONDARY_BTN}
              onClick={() => textElements.removeTextElement(selected.id)}
            >
              Delete
            </button>
          </div>

          <TextElementStyle element={selected} />
        </>
      )}
    </div>
  );
}
